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
pub const POLARS_VERSION: &str = "0.55.2";

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
    pub gen: u64,
}

pub fn build(plan: &Value, cx: &mut Ctx) -> R<LazyFrame> {
    let ops = plan["ops"].as_array().cloned().unwrap_or_default();
    let (mut lf, consumed) = source::read(&plan["source"], ops.first(), cx)?;
    let locale = plan["locale"].as_str().unwrap_or("en-US").to_string();
    for op in ops.into_iter().skip(if consumed { 1 } else { 0 }) {
        if generation() != cx.gen {
            return Err("Cancelled".into());
        }
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
    json!({ "available": true, "info": { "polars": POLARS_VERSION, "version": env!("CARGO_PKG_VERSION"), "engine": "floe-engine" } })
}

pub fn cancel() {
    with_store(|s| s.gen += 1);
}

pub fn generation() -> u64 {
    with_store(|s| s.gen)
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
                empty += s.iter().filter(|v| matches!(v, Some(""))).count();
            }
            json!({ "valid": n.saturating_sub(err + empty), "error": err, "empty": empty })
        })
        .collect()
}

pub fn evaluate(args: &Value) -> R<Value> {
    let t0 = Instant::now();
    let gen = generation();
    let mode = args["mode"].as_str().unwrap_or("preview");
    let preview = if mode == "full" { None } else { Some(args["previewRows"].as_u64().unwrap_or(1000) as usize) };
    let mut cx = Ctx { preview, truncated: false, gen };
    let lf = build(&args["plan"], &mut cx)?;
    let df = if preview.is_none() { collect_full(lf)? } else { lf.collect().s()? };
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
        .columns()
        .iter()
        .map(|c| match c.dtype() {
            DataType::Date => c.cast(&DataType::Datetime(TimeUnit::Milliseconds, None)).unwrap_or_else(|_| c.clone()),
            DataType::Datetime(_, _) => c.cast(&DataType::Datetime(TimeUnit::Milliseconds, None)).unwrap_or_else(|_| c.clone()),
            d if is_int(d) && !matches!(d, DataType::Int64 | DataType::UInt64) => c.cast(&DataType::Float64).unwrap_or_else(|_| c.clone()),
            DataType::Float32 => c.cast(&DataType::Float64).unwrap_or_else(|_| c.clone()),
            _ => c.clone(),
        })
        .collect();
    part = DataFrame::new_infer_height(cols).s()?;
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
            row.push(date_wrap(wire(c.get(r).unwrap_or(AnyValue::Null)), ty));
        }
    }
    Ok(out)
}

fn extreme(scalar: Scalar, ty: &str) -> Value {
    let one = scalar.into_series("v".into());
    date_wrap(wire(one.get(0).unwrap_or(AnyValue::Null)), ty)
}

pub fn profile(id: &str, name: &str) -> R<Value> {
    let df = get(id)?;
    let c = df.column(name).s()?.as_materialized_series().clone();
    let ty = floe_type(c.dtype());
    let n = c.len();
    let errors = df.column(&format!("{ERR_PREFIX}{name}")).ok().and_then(|e| e.bool().ok().map(|b| b.sum().unwrap_or(0) as usize)).unwrap_or(0);
    let mut non_null = c.drop_nulls();
    let mut empty = c.null_count().saturating_sub(errors);
    let keep: Option<BooleanChunked> = non_null.str().ok().map(|s| s.iter().map(|v| v.map(|x| !x.is_empty())).collect());
    if let Some(k) = keep {
        let kept = k.sum().unwrap_or(0) as usize;
        if kept < non_null.len() {
            empty += non_null.len() - kept;
            non_null = non_null.filter(&k).s()?;
        }
    }
    let mut min_len = None;
    let mut max_len = None;
    if let Ok(s) = non_null.str() {
        let lens = s.str_len_chars();
        min_len = lens.min().map(|v| v as usize);
        max_len = lens.max().map(|v| v as usize);
    }
    let counts = non_null.value_counts(true, false, "count".into(), false).s()?;
    let distinct = counts.height();
    let cnt = counts.column("count").s()?.cast(&DataType::Int64).s()?;
    let cnt = cnt.i64().s()?;
    let unique = cnt.iter().filter(|x| *x == Some(1)).count();
    let vals = counts.column(name).s()?;
    let top: Vec<Value> = (0..distinct.min(12)).map(|i| json!({ "value": date_wrap(wire(vals.get(i).unwrap_or(AnyValue::Null)), ty), "count": cnt.get(i).unwrap_or(0) })).collect();
    let (mut mean, mut stdev, mut hist) = (Value::Null, Value::Null, Value::Null);
    let (mut min, mut max) = (Value::Null, Value::Null);
    if non_null.len() > 0 {
        min = extreme(non_null.min_reduce().s()?, ty);
        max = extreme(non_null.max_reduce().s()?, ty);
    }
    if is_num(c.dtype()) {
        let f = non_null.cast(&DataType::Float64).s()?;
        let f = f.f64().s()?;
        if f.len() > f.null_count() {
            mean = f.mean().map(|m| json!(m)).unwrap_or(Value::Null);
            stdev = f.std(1).map(|d| json!(d)).unwrap_or(Value::Null);
            let lo = f.iter().flatten().fold(f64::INFINITY, f64::min);
            let hi = f.iter().flatten().fold(f64::NEG_INFINITY, f64::max);
            if hi > lo {
                let mut bins = vec![0usize; 20];
                let w = (hi - lo) / 20.0;
                for x in f.iter().flatten() {
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
    let flags = df.column(&format!("{ERR_PREFIX}{name}")).ok().and_then(|e| e.bool().ok().cloned());
    let (c, errors) = match &flags {
        Some(mask) => {
            let keep: BooleanChunked = mask.iter().map(|v| Some(v != Some(true))).collect();
            (c.filter(&keep).s()?, mask.sum().unwrap_or(0) as usize)
        }
        None => (c, 0),
    };
    let counts = c.value_counts(false, false, "count".into(), false).s()?;
    let counts = counts.sort([name], SortMultipleOptions::default().with_nulls_last(true)).s()?;
    let vals = counts.column(name).s()?;
    let cnt = counts.column("count").s()?.cast(&DataType::Int64).s()?;
    let cnt = cnt.i64().s()?;
    let mut out: Vec<Value> = (0..counts.height().min(1000)).map(|i| json!({ "value": date_wrap(wire(vals.get(i).unwrap_or(AnyValue::Null)), ty), "count": cnt.get(i).unwrap_or(0) })).collect();
    if errors > 0 {
        out.push(json!({ "value": { "__err": true }, "count": errors }));
    }
    Ok(json!({ "values": out, "capped": counts.height() > 1000 }))
}

fn tmp_path(path: &str) -> std::path::PathBuf {
    let target = std::path::Path::new(path);
    let name = target.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "file".into());
    match target.parent() {
        Some(dir) if !dir.as_os_str().is_empty() => dir.join(format!(".{name}.floe-tmp")),
        _ => std::path::PathBuf::from(format!(".{name}.floe-tmp")),
    }
}

fn write_export(df: &mut DataFrame, args: &Value, tmp: &std::path::Path, path: &str) -> R<()> {
    let format = args["format"].as_str().unwrap_or("csv");
    if !matches!(format, "csv" | "parquet" | "arrow" | "xlsx") {
        return Err(format!("Unknown export format {format}"));
    }
    if format == "xlsx" {
        let target = tmp.to_str().ok_or_else(|| format!("{path}: path is not valid UTF-8"))?;
        return source::write_xlsx(df, target, args["sheet"].as_str().unwrap_or("Data"));
    }
    let mut f = std::fs::File::create(tmp).map_err(|e| format!("{path}: {e}"))?;
    match format {
        "csv" => {
            CsvWriter::new(&mut f).include_header(true).with_date_format(Some("%Y-%m-%d".into())).with_datetime_format(Some("%Y-%m-%d %H:%M:%S".into())).finish(df).s()?;
        }
        "parquet" => {
            ParquetWriter::new(&mut f).finish(df).s()?;
        }
        _ => {
            IpcWriter::new(&mut f).finish(df).s()?;
        }
    }
    Ok(())
}

fn on_large_stack<T: Send + 'static>(work: impl FnOnce() -> R<T> + Send + 'static) -> R<T> {
    std::thread::Builder::new()
        .name("floe-streaming".into())
        .stack_size(128 << 20)
        .spawn(move || guarded(work))
        .map_err(|e| e.to_string())?
        .join()
        .unwrap_or_else(|_| Err("Polars engine crashed on this query".to_string()))
}

pub fn collect_full(lf: LazyFrame) -> R<DataFrame> {
    let streamed = lf.clone();
    match on_large_stack(move || streamed.collect_with_engine(Engine::Streaming).s().map(|r| r.unwrap_single())) {
        Ok(df) => Ok(df),
        Err(_) => lf.collect().s(),
    }
}

fn count_csv_rows(file: &std::path::Path) -> R<usize> {
    use std::io::Read;
    let mut f = std::fs::File::open(file).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; 1 << 20];
    let (mut quoted, mut records) = (false, 0usize);
    loop {
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        for &b in &buf[..n] {
            match b {
                b'"' => quoted = !quoted,
                b'\n' if !quoted => records += 1,
                _ => {}
            }
        }
    }
    Ok(records.saturating_sub(1))
}

fn count_rows(format: &str, file: &std::path::Path) -> R<usize> {
    let target = file.to_str().ok_or("path is not valid UTF-8")?;
    let lf = match format {
        "parquet" => LazyFrame::scan_parquet(PlRefPath::new(target), ScanArgsParquet::default()).s()?,
        "arrow" => LazyFrame::scan_ipc(PlRefPath::new(target), IpcScanOptions::default(), UnifiedScanArgs::default()).s()?,
        _ => return count_csv_rows(file),
    };
    let counted = lf.select([len().alias("n")]).collect().s()?;
    Ok(counted.column("n").s()?.get(0).s()?.try_extract::<u64>().s()? as usize)
}

fn sink_to(mut lf: LazyFrame, format: &str, tmp: &std::path::Path) -> R<usize> {
    let schema = lf.collect_schema().s()?;
    let keep: Vec<Expr> = schema.iter_names().filter(|n| !n.starts_with(ERR_PREFIX)).map(|n| col(n.clone())).collect();
    let target = tmp.to_str().ok_or("path is not valid UTF-8")?;
    let destination = SinkDestination::File { target: SinkTarget::Path(PlRefPath::new(target)) };
    let write_format = match format {
        "csv" => FileWriteFormat::Csv(CsvWriterOptions {
            serialize_options: Arc::new(SerializeOptions { date_format: Some("%Y-%m-%d".into()), datetime_format: Some("%Y-%m-%d %H:%M:%S".into()), ..Default::default() }),
            ..Default::default()
        }),
        "parquet" => FileWriteFormat::Parquet(Arc::new(ParquetWriteOptions::default())),
        _ => FileWriteFormat::Ipc(IpcWriterOptions::default()),
    };
    lf.select(keep).sink(destination, write_format, UnifiedSinkArgs::default()).s()?.collect_with_engine(Engine::Streaming).s()?;
    count_rows(format, tmp)
}

fn publish(tmp: &std::path::Path, path: &str) -> R<()> {
    std::fs::rename(tmp, path).or_else(|_| std::fs::copy(tmp, path).map(|_| ())).map_err(|e| format!("{path}: {e}"))
}

pub fn export(args: &Value) -> R<Value> {
    let mut cx = Ctx { preview: None, truncated: false, gen: generation() };
    let lf = build(&args["plan"], &mut cx)?;
    let path = args["path"].as_str().ok_or("export: missing path")?;
    let format = args["format"].as_str().unwrap_or("csv");
    let tmp = tmp_path(path);
    if matches!(format, "csv" | "parquet" | "arrow") {
        let streamed = {
            let (plan, target, kind) = (lf.clone(), tmp.clone(), format.to_string());
            on_large_stack(move || sink_to(plan, &kind, &target))
        };
        if let Ok(rows) = streamed {
            let done = if generation() != cx.gen { Err("Cancelled".to_string()) } else { publish(&tmp, path) };
            let _ = std::fs::remove_file(&tmp);
            done?;
            return Ok(json!({ "rows": rows, "path": path }));
        }
        let _ = std::fs::remove_file(&tmp);
    }
    let mut df = lf.collect().s()?;
    if generation() != cx.gen {
        return Err("Cancelled".into());
    }
    let keep = visible(&df);
    df = df.select(keep).s()?;
    let rows = df.height();
    let done = write_export(&mut df, args, &tmp, path).and_then(|_| publish(&tmp, path));
    let _ = std::fs::remove_file(&tmp);
    done?;
    Ok(json!({ "rows": rows, "path": path }))
}

pub fn guarded<T>(f: impl FnOnce() -> R<T>) -> R<T> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).unwrap_or_else(|payload| {
        let detail = payload.downcast_ref::<&str>().map(|s| s.to_string()).or_else(|| payload.downcast_ref::<String>().cloned()).unwrap_or_default();
        Err(if detail.is_empty() { "Polars engine crashed on this query".to_string() } else { format!("Polars engine crashed on this query: {detail}") })
    })
}

pub fn explain(args: &Value) -> R<Value> {
    let mut cx = Ctx { preview: None, truncated: false, gen: generation() };
    let lf = build(&args["plan"], &mut cx)?;
    Ok(json!({ "text": lf.describe_optimized_plan().s()? }))
}

pub fn call(op: &str, args: &Value) -> R<Value> {
    match op {
        "evaluate" => evaluate(args),
        "export" => export(args),
        "profile" => profile(args["resultId"].as_str().unwrap_or(""), args["col"].as_str().unwrap_or("")),
        "distinct" => distinct(args["resultId"].as_str().unwrap_or(""), args["col"].as_str().unwrap_or("")),
        "explain" => explain(args),
        other => Err(format!("Unknown engine op {other}")),
    }
}
