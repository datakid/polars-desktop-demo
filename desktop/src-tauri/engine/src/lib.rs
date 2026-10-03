mod expr;
mod ops;
mod source;

use polars::prelude::*;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::Instant;

pub type R<T> = Result<T, String>;

pub trait S<T> {
    fn s(self) -> R<T>;
}
impl<T> S<T> for PolarsResult<T> {
    fn s(self) -> R<T> {
        self.map_err(|e| e.to_string())
    }
}

pub const ERR_PREFIX: &str = "__err_";

pub fn is_num(d: &DataType) -> bool {
    matches!(
        d,
        DataType::Int8 | DataType::Int16 | DataType::Int32 | DataType::Int64 | DataType::UInt8 | DataType::UInt16 | DataType::UInt32 | DataType::UInt64 | DataType::Float32 | DataType::Float64
    )
}
pub fn is_int(d: &DataType) -> bool {
    is_num(d) && !matches!(d, DataType::Float32 | DataType::Float64)
}

pub fn floe_type(d: &DataType) -> &'static str {
    match d {
        DataType::Boolean => "bool",
        DataType::String => "text",
        DataType::Date => "date",
        DataType::Datetime(_, _) => "datetime",
        d if is_int(d) => "int",
        d if is_num(d) => "number",
        _ => "any",
    }
}

pub fn unique_name(name: &str, set: &std::collections::HashSet<String>) -> String {
    if !set.contains(name) {
        return name.to_string();
    }
    let mut i = 1;
    while set.contains(&format!("{name}_{i}")) {
        i += 1;
    }
    format!("{name}_{i}")
}

pub fn uniquify(names: Vec<Option<String>>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    names
        .into_iter()
        .enumerate()
        .map(|(i, n)| {
            let base = n.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).unwrap_or_else(|| format!("Column{}", i + 1));
            let u = unique_name(&base, &seen);
            seen.insert(u.clone());
            u
        })
        .collect()
}

fn civil(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + if m <= 2 { 1 } else { 0 }, m, d)
}

pub fn fmt_days(days: i64) -> String {
    let (y, m, d) = civil(days);
    format!("{y:04}-{m:02}-{d:02}")
}

pub fn fmt_ms(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let rem = ms.rem_euclid(86_400_000) / 1000;
    format!("{} {:02}:{:02}:{:02}", fmt_days(days), rem / 3600, rem / 60 % 60, rem % 60)
}

pub fn fmt_any(v: AnyValue) -> Option<String> {
    match v {
        AnyValue::Null => None,
        AnyValue::String(s) => Some(s.to_string()),
        AnyValue::StringOwned(s) => Some(s.to_string()),
        AnyValue::Boolean(b) => Some(if b { "TRUE" } else { "FALSE" }.into()),
        AnyValue::Date(d) => Some(fmt_days(d as i64)),
        AnyValue::Datetime(x, tu, _) => Some(fmt_ms(match tu {
            TimeUnit::Nanoseconds => x / 1_000_000,
            TimeUnit::Microseconds => x / 1_000,
            TimeUnit::Milliseconds => x,
        })),
        other => other.extract::<f64>().map(|f| if f.fract() == 0.0 && f.abs() < 9.0e15 { format!("{}", f as i64) } else { format!("{f}") }),
    }
}

pub struct Ctx {
    pub preview: Option<usize>,
    pub truncated: bool,
}

pub fn build(plan: &Value, cx: &mut Ctx) -> R<LazyFrame> {
    let ops = plan["ops"].as_array().cloned().unwrap_or_default();
    let (mut lf, consumed) = source::read(&plan["source"], ops.first(), cx)?;
    let locale = plan["locale"].as_str().unwrap_or("en-US").to_string();
    for op in ops.into_iter().skip(if consumed { 1 } else { 0 }) {
        lf = ops::apply(lf, &op, &locale, cx).map_err(|e| format!("{}: {e}", op["op"].as_str().unwrap_or("step")))?;
    }
    Ok(lf)
}

struct Store {
    seq: u64,
    gen: u64,
    order: VecDeque<String>,
    map: HashMap<String, DataFrame>,
}

static STORE: Mutex<Option<Store>> = Mutex::new(None);

fn with_store<T>(f: impl FnOnce(&mut Store) -> T) -> T {
    let mut g = STORE.lock().unwrap_or_else(|e| e.into_inner());
    let s = g.get_or_insert_with(|| Store { seq: 0, gen: 0, order: VecDeque::new(), map: HashMap::new() });
    f(s)
}

pub fn status() -> Value {
    json!({ "available": true, "info": { "polars": "0.46", "version": env!("CARGO_PKG_VERSION"), "engine": "floe-engine" } })
}

pub fn cancel() {
    with_store(|s| s.gen += 1);
}

fn visible(df: &DataFrame) -> Vec<String> {
    df.get_column_names().iter().map(|n| n.to_string()).filter(|n| !n.starts_with(ERR_PREFIX)).collect()
}

fn schema_json(df: &DataFrame) -> Vec<Value> {
    visible(df).iter().map(|n| json!({ "name": n, "type": floe_type(df.column(n).unwrap().dtype()) })).collect()
}

fn quality(df: &DataFrame) -> Vec<Value> {
    let n = df.height();
    visible(df)
        .iter()
        .map(|name| {
            let c = df.column(name).unwrap();
            let err = df.column(&format!("{ERR_PREFIX}{name}")).ok().and_then(|e| e.bool().ok().map(|b| b.sum().unwrap_or(0) as usize)).unwrap_or(0);
            let mut empty = c.null_count().saturating_sub(err);
            if let Ok(s) = c.str() {
                empty += s.into_iter().filter(|v| matches!(v, Some(""))).count();
            }
            json!({ "valid": n.saturating_sub(err + empty), "error": err, "empty": empty })
        })
        .collect()
}

pub fn evaluate(args: &Value) -> R<Value> {
    let t0 = Instant::now();
    let gen = with_store(|s| s.gen);
    let mode = args["mode"].as_str().unwrap_or("preview");
    let preview = if mode == "full" { None } else { Some(args["previewRows"].as_u64().unwrap_or(1000) as usize) };
    let mut cx = Ctx { preview, truncated: false };
    let lf = build(&args["plan"], &mut cx)?;
    let df = lf.collect().s()?;
    if with_store(|s| s.gen) != gen {
        return Err("Cancelled".into());
    }
    let out = json!({ "schema": schema_json(&df), "n": df.height(), "quality": quality(&df), "truncated": cx.truncated, "ms": t0.elapsed().as_secs_f64() * 1000.0 });
    let id = with_store(|s| {
        s.seq += 1;
        let id = format!("pl_{}", s.seq);
        s.map.insert(id.clone(), df);
        s.order.push_back(id.clone());
        while s.order.len() > 12 {
            if let Some(old) = s.order.pop_front() {
                s.map.remove(&old);
            }
        }
        id
    });
    let mut out = out;
    out["resultId"] = json!(id);
    Ok(out)
}

fn get(id: &str) -> R<DataFrame> {
    with_store(|s| s.map.get(id).cloned()).ok_or_else(|| "Result expired — re-run the query".to_string())
}

pub fn page(id: &str, offset: usize, count: usize) -> R<Vec<u8>> {
    let df = get(id)?;
    let mut part = df.slice(offset as i64, count);
    let cols: Vec<Column> = part
        .get_columns()
        .iter()
        .map(|c| match c.dtype() {
            DataType::Date => c.cast(&DataType::Datetime(TimeUnit::Milliseconds, None)).unwrap_or_else(|_| c.clone()),
            DataType::Datetime(_, _) => c.cast(&DataType::Datetime(TimeUnit::Milliseconds, None)).unwrap_or_else(|_| c.clone()),
            d if is_int(d) => c.cast(&DataType::Float64).unwrap_or_else(|_| c.clone()),
            DataType::Float32 => c.cast(&DataType::Float64).unwrap_or_else(|_| c.clone()),
            _ => c.clone(),
        })
        .collect();
    part = DataFrame::new(cols).s()?;
    let mut buf = Vec::new();
    IpcStreamWriter::new(&mut buf).with_compat_level(CompatLevel::oldest()).finish(&mut part).s()?;
    Ok(buf)
}

fn wire(v: AnyValue) -> Value {
    match v {
        AnyValue::Null => Value::Null,
        AnyValue::Boolean(b) => json!(b),
        AnyValue::String(s) => json!(s),
        AnyValue::StringOwned(s) => json!(s.as_str()),
        AnyValue::Date(d) => json!(d as i64 * 86_400_000),
        AnyValue::Datetime(x, tu, _) => json!(match tu {
            TimeUnit::Nanoseconds => x / 1_000_000,
            TimeUnit::Microseconds => x / 1_000,
            TimeUnit::Milliseconds => x,
        }),
        other => other.extract::<f64>().map(|f| json!(f)).unwrap_or_else(|| json!(other.to_string())),
    }
}

fn date_wrap(v: Value, ty: &str) -> Value {
    if (ty == "date" || ty == "datetime") && v.is_number() {
        json!({ "__date": v })
    } else {
        v
    }
}

pub fn rows(id: &str, limit: usize) -> R<Vec<Vec<Value>>> {
    let df = get(id)?;
    let names = visible(&df);
    let n = df.height().min(limit);
    let mut out = vec![Vec::with_capacity(names.len()); n];
    for name in &names {
        let c = df.column(name).s()?;
        let ty = floe_type(c.dtype());
        let err = df.column(&format!("{ERR_PREFIX}{name}")).ok().and_then(|e| e.bool().ok().cloned());
        for (r, row) in out.iter_mut().enumerate() {
            if err.as_ref().and_then(|e| e.get(r)).unwrap_or(false) {
                row.push(json!("#ERR"));
                continue;
            }
            let v = wire(c.get(r).unwrap_or(AnyValue::Null));
            row.push(if (ty == "date" || ty == "datetime") && v.is_number() { json!({ "d": v }) } else { v });
        }
    }
    Ok(out)
}

pub fn profile(id: &str, name: &str) -> R<Value> {
    let df = get(id)?;
    let c = df.column(name).s()?.as_materialized_series().clone();
    let ty = floe_type(c.dtype());
    let n = c.len();
    let errors = df.column(&format!("{ERR_PREFIX}{name}")).ok().and_then(|e| e.bool().ok().map(|b| b.sum().unwrap_or(0) as usize)).unwrap_or(0);
    let non_null = c.drop_nulls();
    let mut empty = c.null_count().saturating_sub(errors);
    let mut min_len = None;
    let mut max_len = None;
    if let Ok(s) = non_null.str() {
        empty += s.into_iter().filter(|v| matches!(v, Some(""))).count();
        let lens: Vec<usize> = s.into_iter().flatten().map(|x| x.chars().count()).collect();
        min_len = lens.iter().min().copied();
        max_len = lens.iter().max().copied();
    }
    let counts = non_null.value_counts(true, false, "count".into(), false).s()?;
    let distinct = counts.height();
    let cnt = counts.column("count").s()?.cast(&DataType::Int64).s()?;
    let cnt = cnt.i64().s()?;
    let unique = cnt.into_iter().filter(|x| *x == Some(1)).count();
    let vals = counts.column(name).s()?;
    let top: Vec<Value> = (0..distinct.min(12)).map(|i| json!({ "value": date_wrap(wire(vals.get(i).unwrap_or(AnyValue::Null)), ty), "count": cnt.get(i).unwrap_or(0) })).collect();
    let (mut mean, mut stdev, mut hist) = (Value::Null, Value::Null, Value::Null);
    let (mut min, mut max) = (Value::Null, Value::Null);
    if non_null.len() > 0 {
        let sorted = non_null.sort(SortOptions::default()).s()?;
        min = date_wrap(wire(sorted.get(0).unwrap_or(AnyValue::Null)), ty);
        max = date_wrap(wire(sorted.get(sorted.len() - 1).unwrap_or(AnyValue::Null)), ty);
    }
    if is_num(c.dtype()) {
        let f = non_null.cast(&DataType::Float64).s()?;
        let f = f.f64().s()?;
        let v: Vec<f64> = f.into_iter().flatten().collect();
        if !v.is_empty() {
            let m = v.iter().sum::<f64>() / v.len() as f64;
            mean = json!(m);
            if v.len() > 1 {
                stdev = json!((v.iter().map(|x| (x - m) * (x - m)).sum::<f64>() / (v.len() - 1) as f64).sqrt());
            }
            let lo = v.iter().cloned().fold(f64::INFINITY, f64::min);
            let hi = v.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
            if hi > lo {
                let mut bins = vec![0usize; 20];
                let w = (hi - lo) / 20.0;
                for x in &v {
                    bins[(((x - lo) / w) as usize).min(19)] += 1;
                }
                hist = json!({ "min": lo, "max": hi, "bins": bins });
            }
        }
    }
    Ok(json!({ "profile": { "col": name, "type": ty, "count": n, "errors": errors, "empty": empty, "distinct": distinct, "unique": unique, "min": min, "max": max, "mean": mean, "stdev": stdev, "minLen": min_len, "maxLen": max_len, "top": top, "hist": hist } }))
}

pub fn distinct(id: &str, name: &str) -> R<Value> {
    let df = get(id)?;
    let c = df.column(name).s()?.as_materialized_series().clone();
    let ty = floe_type(c.dtype());
    let counts = c.value_counts(false, false, "count".into(), false).s()?;
    let counts = counts.sort([name], SortMultipleOptions::default().with_nulls_last(true)).s()?;
    let vals = counts.column(name).s()?;
    let cnt = counts.column("count").s()?.cast(&DataType::Int64).s()?;
    let cnt = cnt.i64().s()?;
    let out: Vec<Value> = (0..counts.height().min(1000)).map(|i| json!({ "value": date_wrap(wire(vals.get(i).unwrap_or(AnyValue::Null)), ty), "count": cnt.get(i).unwrap_or(0) })).collect();
    Ok(json!({ "values": out }))
}

pub fn export(args: &Value) -> R<Value> {
    let mut cx = Ctx { preview: None, truncated: false };
    let lf = build(&args["plan"], &mut cx)?;
    let mut df = lf.collect().s()?;
    let keep = visible(&df);
    df = df.select(keep).s()?;
    let path = args["path"].as_str().ok_or("export: missing path")?;
    let rows = df.height();
    let tmp = format!("{path}.floe-tmp");
    {
        let mut f = std::fs::File::create(&tmp).map_err(|e| format!("{path}: {e}"))?;
        match args["format"].as_str().unwrap_or("csv") {
            "csv" => CsvWriter::new(&mut f).include_header(true).with_date_format(Some("%Y-%m-%d".into())).with_datetime_format(Some("%Y-%m-%d %H:%M:%S".into())).finish(&mut df).s()?,
            "parquet" => {
                ParquetWriter::new(&mut f).finish(&mut df).s()?;
            }
            "arrow" => IpcWriter::new(&mut f).finish(&mut df).s()?,
            "xlsx" => {
                drop(f);
                source::write_xlsx(&df, &tmp, args["sheet"].as_str().unwrap_or("Data"))?;
            }
            other => return Err(format!("Unknown export format {other}")),
        }
    }
    std::fs::rename(&tmp, path).or_else(|_| std::fs::copy(&tmp, path).map(|_| ()).and_then(|_| std::fs::remove_file(&tmp))).map_err(|e| format!("{path}: {e}"))?;
    Ok(json!({ "rows": rows, "path": path }))
}

pub fn call(op: &str, args: &Value) -> R<Value> {
    match op {
        "evaluate" => evaluate(args),
        "export" => export(args),
        "profile" => profile(args["resultId"].as_str().unwrap_or(""), args["col"].as_str().unwrap_or("")),
        "distinct" => distinct(args["resultId"].as_str().unwrap_or(""), args["col"].as_str().unwrap_or("")),
        other => Err(format!("Unknown engine op {other}")),
    }
}
