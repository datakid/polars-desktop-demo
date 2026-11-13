use polars::prelude::*;
use serde_json::{json, Value};
use std::path::PathBuf;

fn fixtures() -> Option<Value> {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/parity.json");
    let text = std::fs::read_to_string(&p).ok()?;
    serde_json::from_str(&text).ok()
}

fn rewrite_paths(v: &mut Value, dir: &str) {
    match v {
        Value::String(s) if s.starts_with("@@/") => *s = format!("{dir}/{}", &s[3..]),
        Value::Array(a) => a.iter_mut().for_each(|x| rewrite_paths(x, dir)),
        Value::Object(o) => o.values_mut().for_each(|x| rewrite_paths(x, dir)),
        _ => {}
    }
}

fn norm(v: &Value) -> Value {
    match v {
        Value::Object(o) if o.len() == 1 && o.contains_key("__date") => json!({ "d": o["__date"] }),
        Value::Object(o) if o.contains_key("__err") => json!({ "__err": "*" }),
        Value::Object(o) => Value::Object(o.iter().map(|(k, x)| (k.clone(), norm(x))).collect()),
        Value::Array(a) => Value::Array(a.iter().map(norm).collect()),
        other => other.clone(),
    }
}

fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => {
            let (x, y) = (x.as_f64().unwrap(), y.as_f64().unwrap());
            (x - y).abs() <= 1e-9 * x.abs().max(y.abs()).max(1.0)
        }
        (Value::Object(x), Value::Object(y)) => x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).map(|w| same(v, w)).unwrap_or(false)),
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(p, q)| same(p, q)),
        _ => a == b,
    }
}

fn key(v: &Value) -> String {
    match v {
        Value::Number(n) => format!("{:.9}", n.as_f64().unwrap()),
        other => other.to_string(),
    }
}

fn setup() -> Option<(Value, String)> {
    let fx = fixtures()?;
    let dir = std::env::temp_dir().join(format!("floe_ops_{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    for (name, text) in fx["inputs"].as_object().unwrap() {
        std::fs::write(dir.join(name), text.as_str().unwrap()).unwrap();
    }
    Some((fx, dir.to_string_lossy().replace('\\', "/")))
}

fn evaluate(case: &Value, dir: &str) -> Result<Value, String> {
    let mut plan = case["plan"].clone();
    rewrite_paths(&mut plan, dir);
    floe_engine::call("evaluate", &json!({ "plan": plan, "mode": "full", "previewRows": 1000 }))
}

fn profile_diff(got: &Value, exp: &Value) -> Option<String> {
    for k in ["col", "type", "count", "errors", "empty", "distinct", "unique", "min", "max", "mean", "stdev", "minLen", "maxLen", "hist"] {
        if !same(&got[k], &exp[k]) {
            return Some(format!("{k}: got {} expected {}", got[k], exp[k]));
        }
    }
    let ranked = |v: &Value| -> Vec<(i64, String)> {
        let mut out: Vec<(i64, String)> = v["top"].as_array().unwrap().iter().map(|t| (t["count"].as_i64().unwrap(), key(&t["value"]))).collect();
        out.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
        out
    };
    if ranked(got) != ranked(exp) {
        return Some(format!("top: got {} expected {}", got["top"], exp["top"]));
    }
    let counts = |v: &Value| -> Vec<i64> { v["top"].as_array().unwrap().iter().map(|t| t["count"].as_i64().unwrap()).collect() };
    if counts(got).windows(2).any(|w| w[0] < w[1]) {
        return Some(format!("top is not ordered by count: {}", got["top"]));
    }
    None
}

#[test]
fn profile_and_distinct_match_builtin() {
    let Some((fx, dir)) = setup() else {
        eprintln!("tests/fixtures/parity.json missing — run `node scripts/gen-fixtures.mjs` from the repo root");
        return;
    };
    let mut failures = Vec::new();
    let mut checked = 0;
    for case in fx["fixtures"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let r = match evaluate(case, &dir) {
            Ok(r) => r,
            Err(e) => {
                failures.push(format!("{name}: engine error: {e}"));
                continue;
            }
        };
        let id = r["resultId"].as_str().unwrap().to_string();
        for (col, exp) in case["expected"]["profiles"].as_object().unwrap() {
            checked += 1;
            match floe_engine::call("profile", &json!({ "resultId": id, "col": col })) {
                Ok(v) => {
                    if let Some(msg) = profile_diff(&norm(&v["profile"]), exp) {
                        failures.push(format!("{name} / {col}: profile {msg}"));
                    }
                }
                Err(e) => failures.push(format!("{name} / {col}: profile error: {e}")),
            }
        }
        for (col, exp) in case["expected"]["distinct"].as_object().unwrap() {
            checked += 1;
            match floe_engine::call("distinct", &json!({ "resultId": id, "col": col })) {
                Ok(v) => {
                    let pairs = |v: &Value| -> Vec<(String, i64)> {
                        let mut out: Vec<(String, i64)> = v.as_array().unwrap().iter().map(|x| (key(&x["value"]), x["count"].as_i64().unwrap())).collect();
                        out.sort();
                        out
                    };
                    if pairs(&norm(&v["values"])) != pairs(&norm(exp)) {
                        failures.push(format!("{name} / {col}: distinct got {} expected {}", v["values"], exp));
                    }
                }
                Err(e) => failures.push(format!("{name} / {col}: distinct error: {e}")),
            }
        }
    }
    eprintln!("ops: {} profile/distinct checks, {} failures", checked, failures.len());
    assert!(failures.is_empty(), "\n{}\n", failures.join("\n"));
}

fn cell(v: AnyValue) -> Value {
    match v {
        AnyValue::Null => Value::Null,
        AnyValue::Boolean(b) => json!(b),
        AnyValue::String(s) => json!(s),
        AnyValue::StringOwned(s) => json!(s.as_str()),
        AnyValue::Float64(f) => json!(f),
        AnyValue::Datetime(x, tu, _) => json!({
            "d": match tu {
                TimeUnit::Nanoseconds => x / 1_000_000,
                TimeUnit::Microseconds => x / 1_000,
                TimeUnit::Milliseconds => x,
            }
        }),
        other => json!(other.to_string()),
    }
}

#[test]
fn page_stream_matches_builtin_rows() {
    let Some((fx, dir)) = setup() else {
        eprintln!("tests/fixtures/parity.json missing — run `node scripts/gen-fixtures.mjs` from the repo root");
        return;
    };
    let mut failures = Vec::new();
    for case in fx["fixtures"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let r = match evaluate(case, &dir) {
            Ok(r) => r,
            Err(e) => {
                failures.push(format!("{name}: engine error: {e}"));
                continue;
            }
        };
        let bytes = match floe_engine::page(r["resultId"].as_str().unwrap(), 0, 1000) {
            Ok(b) => b,
            Err(e) => {
                failures.push(format!("{name}: page error: {e}"));
                continue;
            }
        };
        let df = match IpcStreamReader::new(std::io::Cursor::new(bytes)).finish() {
            Ok(d) => d,
            Err(e) => {
                failures.push(format!("{name}: page stream is not readable: {e}"));
                continue;
            }
        };
        let rows = case["expected"]["rows"].as_array().unwrap();
        if df.height() < rows.len().min(200) {
            failures.push(format!("{name}: page has {} rows, expected at least {}", df.height(), rows.len().min(200)));
            continue;
        }
        'cols: for (ci, c) in case["expected"]["schema"].as_array().unwrap().iter().enumerate() {
            let col = c["name"].as_str().unwrap();
            let series = match df.column(col) {
                Ok(s) => s,
                Err(_) => {
                    failures.push(format!("{name}: page is missing column {col}"));
                    continue;
                }
            };
            for (ri, row) in rows.iter().enumerate() {
                let exp = &row[ci];
                let got = cell(series.get(ri).unwrap_or(AnyValue::Null));
                let ok = if exp == "#ERR" { got.is_null() } else { same(&got, exp) };
                if !ok {
                    failures.push(format!("{name}: {col} row {}: got {got} expected {exp}", ri + 1));
                    continue 'cols;
                }
            }
        }
    }
    assert!(failures.is_empty(), "\n{}\n", failures.join("\n"));
}

#[test]
fn exports_round_trip() {
    let Some((fx, dir)) = setup() else {
        eprintln!("tests/fixtures/parity.json missing — run `node scripts/gen-fixtures.mjs` from the repo root");
        return;
    };
    let case = fx["fixtures"].as_array().unwrap().iter().find(|c| c["name"] == "types and per-cell errors").unwrap();
    let mut plan = case["plan"].clone();
    rewrite_paths(&mut plan, &dir);
    let n = case["expected"]["n"].as_u64().unwrap() as usize;
    let names: Vec<String> = case["expected"]["schema"].as_array().unwrap().iter().map(|c| c["name"].as_str().unwrap().to_string()).collect();
    for (format, ext) in [("csv", "csv"), ("parquet", "parquet"), ("arrow", "arrow"), ("xlsx", "xlsx")] {
        let path = format!("{dir}/out.{ext}");
        let r = floe_engine::call("export", &json!({ "plan": plan, "path": path, "format": format, "sheet": "Data" })).unwrap_or_else(|e| panic!("{format}: {e}"));
        assert_eq!(r["rows"].as_u64().unwrap() as usize, n, "{format}: row count");
        match format {
            "csv" => {
                let text = std::fs::read_to_string(&path).unwrap();
                let mut lines = text.lines();
                assert_eq!(lines.next().unwrap(), names.join(","), "csv header");
                assert_eq!(lines.count(), n, "csv rows");
            }
            "parquet" => {
                let df = LazyFrame::scan_parquet(PlRefPath::new(path.as_str()), ScanArgsParquet::default()).unwrap().collect().unwrap();
                assert_eq!(df.height(), n, "parquet rows");
                assert_eq!(df.get_column_names().iter().map(|s| s.to_string()).collect::<Vec<_>>(), names, "parquet columns");
            }
            "arrow" => {
                let df = IpcReader::new(std::fs::File::open(&path).unwrap()).finish().unwrap();
                assert_eq!(df.height(), n, "arrow rows");
                assert_eq!(df.get_column_names().iter().map(|s| s.to_string()).collect::<Vec<_>>(), names, "arrow columns");
            }
            _ => {
                use calamine::{open_workbook_auto, Reader};
                let mut wb = open_workbook_auto(&path).unwrap();
                let sheet = wb.sheet_names()[0].clone();
                assert_eq!(sheet, "Data");
                let range = wb.worksheet_range(&sheet).unwrap();
                assert_eq!(range.height(), n + 1, "xlsx rows");
                assert_eq!(range.width(), names.len(), "xlsx columns");
            }
        }
    }
}
