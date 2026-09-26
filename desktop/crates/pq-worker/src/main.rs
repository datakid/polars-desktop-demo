//! floe-engine — the native Polars engine process, spawned and supervised by the Tauri shell.
//!
//! Transport: stdin/stdout, one frame = u32 little-endian length + MessagePack body.
//!   → Request  { id, op, ...args }
//!   ← Reply    { id, ok, result | error }
//! `page` results carry Arrow IPC stream bytes (`bytes`), passed to the webview untouched.
//!
//! Isolation: cancel = the shell kills this process; a panic/OOM only takes this process down.
//! One request at a time (the shell serializes); results kept in an LRU keyed by result id.

use anyhow::{anyhow, Result};
use pq_compiler::{compile, unsupported, CompileCtx, Mode};
use pq_model::Project;
use polars::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::path::PathBuf;

#[derive(Deserialize)]
struct Envelope { id: u64, op: String, #[serde(default)] args: serde_json::Value }

#[derive(Serialize)]
struct Reply<'a> {
    id: u64,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none", with = "serde_bytes")]
    bytes: Option<&'a [u8]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Serialize)]
struct Col { name: String, #[serde(rename = "type")] ty: &'static str }

#[derive(Serialize)]
struct StepState { ok: bool, #[serde(skip_serializing_if = "Option::is_none")] error: Option<String>, rows: usize, cols: usize, ms: f64 }

struct Engine {
    project: Option<Project>,
    files: HashMap<String, PathBuf>,
    results: HashMap<String, DataFrame>,
    order: VecDeque<String>,
    seq: u64,
}

/// Floe UI type names (see js/util.js PQ.TYPES).
fn ui_type(dt: &DataType) -> &'static str {
    use DataType::*;
    match dt {
        Boolean => "bool",
        Int8 | Int16 | Int32 | Int64 | UInt8 | UInt16 | UInt32 | UInt64 => "int",
        Float32 | Float64 | Decimal(_, _) => "number",
        String => "text",
        Date => "date",
        Datetime(_, _) => "datetime",
        _ => "any",
    }
}

fn schema_of(df: &DataFrame) -> Vec<Col> {
    df.get_columns().iter().filter(|c| !c.name().starts_with(pq_compiler::ERR_PREFIX)).map(|c| Col { name: c.name().to_string(), ty: ui_type(c.dtype()) }).collect()
}

/// Per-column quality (valid / error / empty), using the hidden `__err_<col>` masks from ChangeType.
fn quality(df: &DataFrame) -> Vec<serde_json::Value> {
    let n = df.height();
    schema_of(df).iter().map(|c| {
        let s = df.column(&c.name).unwrap();
        let empty = s.null_count();
        let err = df.column(&format!("{}{}", pq_compiler::ERR_PREFIX, c.name)).ok().and_then(|m| m.bool().ok().map(|b| b.sum().unwrap_or(0) as usize)).unwrap_or(0);
        serde_json::json!({ "valid": n.saturating_sub(empty), "error": err, "empty": empty.saturating_sub(err) })
    }).collect()
}

impl Engine {
    fn keep(&mut self, df: DataFrame) -> String {
        self.seq += 1;
        let id = format!("n{}", self.seq);
        self.results.insert(id.clone(), df);
        self.order.push_back(id.clone());
        while self.order.len() > 12 { if let Some(old) = self.order.pop_front() { self.results.remove(&old); } }
        id
    }

    /// Owned resolver so callers can mutate `self` afterwards.
    fn resolver(&self) -> impl Fn(&str, &str) -> Option<PathBuf> {
        let files = self.files.clone();
        move |id: &str, _name: &str| files.get(id).cloned()
    }

    fn handle(&mut self, op: &str, a: serde_json::Value) -> Result<(serde_json::Value, Option<Vec<u8>>)> {
        match op {
            "hello" => Ok((serde_json::json!({ "engine": "floe-engine", "version": env!("CARGO_PKG_VERSION"), "polars": polars::VERSION, "supported": pq_compiler::SUPPORTED }), None)),
            "setProject" => {
                self.project = Some(serde_json::from_value(a["project"].clone()).map_err(|e| anyhow!("project: {e}"))?);
                self.files = serde_json::from_value(a["files"].clone()).unwrap_or_default();
                Ok((serde_json::json!({}), None))
            }
            // Can this query (and everything it references) run natively?
            "canRun" => {
                let p = self.project.as_ref().ok_or_else(|| anyhow!("no project"))?;
                let qid = a["qid"].as_str().unwrap_or_default();
                let q = p.queries.iter().find(|q| q.id == qid).ok_or_else(|| anyhow!("query not found"))?;
                Ok((match unsupported(p, q) { None => serde_json::json!({ "ok": true }), Some((i, t)) => serde_json::json!({ "ok": false, "step": i, "type": t }) }, None))
            }
            "evaluate" => {
                let p = self.project.clone().ok_or_else(|| anyhow!("no project"))?;
                let qid = a["qid"].as_str().unwrap_or_default().to_string();
                let full = a["mode"].as_str() == Some("full");
                let resolve = self.resolver();
                let mode = if full { Mode::Full } else { Mode::Preview(p.settings.preview_rows) };
                let ctx = CompileCtx::new(&p, mode, &resolve);
                let q = p.queries.iter().find(|q| q.id == qid).ok_or_else(|| anyhow!("query not found"))?;
                let upto = a["upto"].as_u64().map(|u| u as usize).unwrap_or(q.steps.len().saturating_sub(1)).min(q.steps.len().saturating_sub(1));
                let t0 = std::time::Instant::now();
                // Per-step states: schema via collect_schema (no data), row count only for the selected step.
                let mut states = vec![];
                let mut failed: Option<usize> = None;
                for i in 0..=upto {
                    let t = std::time::Instant::now();
                    match compile(q, i, &ctx) {
                        Ok(mut lf) => match lf.collect_schema() {
                            Ok(s) => states.push(StepState { ok: true, error: None, rows: 0, cols: s.len(), ms: t.elapsed().as_secs_f64() * 1e3 }),
                            Err(e) => { failed = Some(i); states.push(StepState { ok: false, error: Some(e.to_string()), rows: 0, cols: 0, ms: 0.0 }); break; }
                        },
                        Err((_, e)) => { failed = Some(i); states.push(StepState { ok: false, error: Some(e.to_string()), rows: 0, cols: 0, ms: 0.0 }); break; }
                    }
                }
                if let Some(f) = failed {
                    return Ok((serde_json::json!({ "states": states, "failedAt": f, "ms": t0.elapsed().as_secs_f64() * 1e3 }), None));
                }
                let lf = compile(q, upto, &ctx).map_err(|(_, e)| anyhow!(e.to_string()))?;
                let df = if full { lf.with_new_streaming(true).collect() } else { lf.collect() };
                let df = match df {
                    Ok(df) => df,
                    Err(e) => {
                        states[upto] = StepState { ok: false, error: Some(e.to_string()), rows: 0, cols: 0, ms: 0.0 };
                        return Ok((serde_json::json!({ "states": states, "failedAt": upto, "ms": t0.elapsed().as_secs_f64() * 1e3 }), None));
                    }
                };
                if let Some(s) = states.last_mut() { s.rows = df.height(); }
                let truncated = !full && df.height() >= p.settings.preview_rows as usize;
                let (n, schema, qual) = (df.height(), schema_of(&df), quality(&df));
                let id = self.keep(df);
                Ok((serde_json::json!({ "resultId": id, "n": n, "schema": schema, "quality": qual, "states": states, "failedAt": -1, "truncated": truncated, "ms": t0.elapsed().as_secs_f64() * 1e3, "engine": "polars" }), None))
            }
            // Zero-copy slice → Arrow IPC stream. Error masks become `__err_<col>` boolean columns the UI decodes.
            "page" => {
                let id = a["resultId"].as_str().unwrap_or_default();
                let df = self.results.get(id).ok_or_else(|| anyhow!("result expired"))?;
                let off = a["offset"].as_i64().unwrap_or(0);
                let cnt = a["count"].as_u64().unwrap_or(200) as usize;
                let mut page = df.slice(off, cnt);
                // Dates/times as epoch ms keeps the JS decoder trivial and exact.
                let casts: Vec<Expr> = page.get_columns().iter().filter_map(|c| match c.dtype() {
                    DataType::Date | DataType::Datetime(_, _) => Some(col(c.name().as_str()).cast(DataType::Datetime(TimeUnit::Milliseconds, None)).cast(DataType::Int64).alias(c.name().as_str())),
                    DataType::Decimal(_, _) => Some(col(c.name().as_str()).cast(DataType::Float64)),
                    DataType::List(_) | DataType::Struct(_) | DataType::Categorical(_, _) | DataType::Enum(_, _) => Some(col(c.name().as_str()).cast(DataType::String)),
                    _ => None,
                }).collect();
                if !casts.is_empty() { page = page.lazy().with_columns(casts).collect()?; }
                let mut buf = Vec::with_capacity(page.estimated_size() + 1024);
                IpcStreamWriter::new(&mut buf).with_compat_level(CompatLevel::oldest()).finish(&mut page)?;
                Ok((serde_json::json!({ "rows": page.height() }), Some(buf)))
            }
            "profile" => {
                let id = a["resultId"].as_str().unwrap_or_default();
                let name = a["col"].as_str().unwrap_or_default();
                let df = self.results.get(id).ok_or_else(|| anyhow!("result expired"))?;
                let s = df.column(name)?.as_materialized_series().clone();
                let n = s.len();
                let empty = s.null_count();
                let distinct = s.n_unique().unwrap_or(0);
                let vc = s.value_counts(true, false, "count".into(), false)?.head(Some(12));
                let top: Vec<serde_json::Value> = (0..vc.height()).map(|i| {
                    let v = vc.get_columns()[0].get(i).map(|x| x.str_value().to_string()).unwrap_or_default();
                    let c = vc.get_columns()[1].get(i).ok().and_then(|x| x.extract::<u64>()).unwrap_or(0);
                    serde_json::json!({ "value": v, "count": c })
                }).collect();
                let numeric = s.dtype().is_primitive_numeric();
                let (min, max, mean, std) = if numeric {
                    let f = s.cast(&DataType::Float64)?;
                    let ca = f.f64()?;
                    (ca.min(), ca.max(), ca.mean(), ca.std(1))
                } else { (None, None, None, None) };
                let hist = if let (Some(lo), Some(hi)) = (min, max) {
                    if hi > lo {
                        let mut bins = vec![0u64; 20];
                        for v in s.cast(&DataType::Float64)?.f64()?.into_no_null_iter() { let k = (((v - lo) / (hi - lo)) * 20.0).floor().clamp(0.0, 19.0) as usize; bins[k] += 1; }
                        Some(serde_json::json!({ "min": lo, "max": hi, "bins": bins }))
                    } else { None }
                } else { None };
                let str_min = if numeric { None } else { s.min_reduce().ok().map(|x| x.value().str_value().to_string()) };
                let str_max = if numeric { None } else { s.max_reduce().ok().map(|x| x.value().str_value().to_string()) };
                Ok((serde_json::json!({ "profile": {
                    "col": name, "type": ui_type(s.dtype()), "count": n, "errors": 0, "empty": empty, "distinct": distinct, "unique": serde_json::Value::Null,
                    "min": min.map(serde_json::Value::from).or(str_min.map(serde_json::Value::from)), "max": max.map(serde_json::Value::from).or(str_max.map(serde_json::Value::from)),
                    "mean": mean, "stdev": std, "minLen": null, "maxLen": null, "top": top, "hist": hist } }), None))
            }
            "distinct" => {
                let id = a["resultId"].as_str().unwrap_or_default();
                let name = a["col"].as_str().unwrap_or_default();
                let df = self.results.get(id).ok_or_else(|| anyhow!("result expired"))?;
                let vc = df.column(name)?.as_materialized_series().value_counts(false, false, "count".into(), false)?.head(Some(1000));
                let vals: Vec<serde_json::Value> = (0..vc.height()).map(|i| {
                    let v = vc.get_columns()[0].get(i).ok();
                    let val = match v { Some(AnyValue::Null) | None => serde_json::Value::Null, Some(x) => match x.extract::<f64>() { Some(f) if vc.get_columns()[0].dtype().is_primitive_numeric() => serde_json::json!(f), _ => serde_json::json!(x.str_value().to_string()) } };
                    serde_json::json!({ "value": val, "count": vc.get_columns()[1].get(i).ok().and_then(|x| x.extract::<u64>()).unwrap_or(0) })
                }).collect();
                Ok((serde_json::json!({ "values": vals }), None))
            }
            // Full-data export straight to disk (the shell has already granted the path).
            "export" => {
                let p = self.project.clone().ok_or_else(|| anyhow!("no project"))?;
                let qid = a["qid"].as_str().unwrap_or_default();
                let path = PathBuf::from(a["path"].as_str().ok_or_else(|| anyhow!("path"))?);
                let resolve = self.resolver();
                let ctx = CompileCtx::new(&p, Mode::Full, &resolve);
                let q = p.queries.iter().find(|q| q.id == qid).ok_or_else(|| anyhow!("query not found"))?;
                let lf = compile(q, q.steps.len() - 1, &ctx).map_err(|(_, e)| anyhow!(e.to_string()))?;
                let keep: Vec<Expr> = vec![all().exclude([format!("^{}.*$", pq_compiler::ERR_PREFIX)])];
                let mut df = lf.select(keep).with_new_streaming(true).collect()?;
                let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("csv").to_lowercase();
                let f = std::fs::File::create(&path)?;
                match ext.as_str() {
                    "parquet" => { ParquetWriter::new(f).finish(&mut df)?; }
                    "arrow" | "ipc" => { IpcWriter::new(f).finish(&mut df)?; }
                    _ => { CsvWriter::new(f).finish(&mut df)?; }
                }
                Ok((serde_json::json!({ "rows": df.height(), "path": path }), None))
            }
            "inspectExcel" => {
                let path = PathBuf::from(a["path"].as_str().unwrap_or_default());
                let nav = pq_excel::inspect(&path)?;
                Ok((serde_json::to_value(serde_json::json!({ "sheets": nav.sheets, "tables": nav.tables, "names": nav.names }))?, None))
            }
            "drop" => { if let Some(id) = a["resultId"].as_str() { self.results.remove(id); } Ok((serde_json::json!({}), None)) }
            other => Err(anyhow!("unknown op {other}")),
        }
    }
}

fn read_frame(r: &mut impl Read) -> std::io::Result<Option<Vec<u8>>> {
    let mut len = [0u8; 4];
    match r.read_exact(&mut len) { Ok(()) => {}, Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None), Err(e) => return Err(e) }
    let mut buf = vec![0u8; u32::from_le_bytes(len) as usize];
    r.read_exact(&mut buf)?;
    Ok(Some(buf))
}

fn write_frame(w: &mut impl Write, body: &[u8]) -> std::io::Result<()> {
    w.write_all(&(body.len() as u32).to_le_bytes())?;
    w.write_all(body)?;
    w.flush()
}

fn main() -> Result<()> {
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let (mut rx, mut tx) = (stdin.lock(), stdout.lock());
    let mut eng = Engine { project: None, files: HashMap::new(), results: HashMap::new(), order: VecDeque::new(), seq: 0 };
    while let Some(frame) = read_frame(&mut rx)? {
        let (id, res) = match rmp_serde::from_slice::<Envelope>(&frame) {
            Ok(env) => {
                // A panic inside Polars turns into an error reply instead of killing the engine.
                let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| eng.handle(&env.op, env.args)));
                (env.id, r.unwrap_or_else(|p| Err(anyhow!("engine panic: {}", p.downcast_ref::<String>().cloned().or_else(|| p.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default()))))
            }
            Err(e) => (0, Err(anyhow!("bad frame: {e}"))),
        };
        let body = match &res {
            Ok((v, bytes)) => rmp_serde::to_vec_named(&Reply { id, ok: true, result: Some(v.clone()), bytes: bytes.as_deref(), error: None })?,
            Err(e) => rmp_serde::to_vec_named(&Reply { id, ok: false, result: None, bytes: None, error: Some(e.to_string()) })?,
        };
        write_frame(&mut tx, &body)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn frames_round_trip() {
        let mut buf = vec![];
        write_frame(&mut buf, b"hello").unwrap();
        assert_eq!(read_frame(&mut &buf[..]).unwrap().unwrap(), b"hello");
        assert!(read_frame(&mut &b""[..]).unwrap().is_none());
    }
    #[test]
    fn evaluates_blank_source_and_pages_arrow() {
        let project: Project = serde_json::from_value(serde_json::json!({
            "name": "t", "queries": [{ "id": "q", "name": "Q", "steps": [
                { "id": "s", "name": "Source", "kind": { "type": "Source", "source": { "kind": "blank", "columns": ["a", "b"], "rows": [["1", "x"], ["2", "y"]] } } },
                { "id": "t", "name": "CT", "kind": { "type": "ChangeType", "changes": [{ "col": "a", "type": "int" }], "onError": "error" } }
            ] }]
        })).unwrap();
        let mut e = Engine { project: None, files: HashMap::new(), results: HashMap::new(), order: VecDeque::new(), seq: 0 };
        e.handle("setProject", serde_json::json!({ "project": project, "files": {} })).unwrap();
        let (r, _) = e.handle("evaluate", serde_json::json!({ "qid": "q", "mode": "preview" })).unwrap();
        assert_eq!(r["n"], 2);
        assert_eq!(r["schema"][0]["type"], "int");
        let (_, bytes) = e.handle("page", serde_json::json!({ "resultId": r["resultId"], "offset": 0, "count": 10 })).unwrap();
        assert!(bytes.unwrap().len() > 100);
    }
}
