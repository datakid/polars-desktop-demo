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
    static READY: std::sync::OnceLock<Option<(Value, String)>> = std::sync::OnceLock::new();
    READY.get_or_init(write_inputs).clone()
}

fn write_inputs() -> Option<(Value, String)> {
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
    floe_engine::call("evaluate", &json!({ "plan": plan, "mode": case["mode"].as_str().unwrap_or("full"), "previewRows": case["previewRows"].as_u64().unwrap_or(1000) }))
}

fn profile_diff(got: &Value, exp: &Value) -> Option<String> {
    let text = exp["type"] == "text";
    for k in ["col", "type", "count", "errors", "empty", "distinct", "unique", "min", "max", "mean", "stdev", "minLen", "maxLen", "hist"] {
        if text && (k == "min" || k == "max") {
            continue;
        }
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
        AnyValue::Int64(i) => json!(i),
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

#[test]
fn status_reports_the_pinned_polars_version() {
    let manifest = include_str!("../Cargo.toml");
    let pinned = manifest
        .lines()
        .find(|l| l.trim_start().starts_with("polars = "))
        .and_then(|l| l.split("version = \"=").nth(1))
        .and_then(|rest| rest.split('"').next())
        .expect("polars pin in Cargo.toml");
    let status = floe_engine::status();
    assert_eq!(status["info"]["polars"].as_str(), Some(pinned));
}

#[test]
fn failed_export_leaves_no_temp_file() {
    let Some((fx, dir)) = setup() else {
        eprintln!("tests/fixtures/parity.json missing — run `node scripts/gen-fixtures.mjs` from the repo root");
        return;
    };
    let case = fx["fixtures"].as_array().unwrap().iter().find(|c| c["name"] == "types and per-cell errors").unwrap();
    let mut plan = case["plan"].clone();
    rewrite_paths(&mut plan, &dir);
    let work = format!("{dir}/export-failures");
    std::fs::create_dir_all(&work).unwrap();
    let blocked = format!("{work}/blocked.csv");
    std::fs::create_dir_all(&blocked).unwrap();
    for format in ["csv", "parquet", "arrow", "xlsx"] {
        let r = floe_engine::call("export", &json!({ "plan": plan, "path": blocked, "format": format, "sheet": "Data" }));
        assert!(r.is_err(), "{format}: exporting onto a directory must fail");
    }
    let unknown = floe_engine::call("export", &json!({ "plan": plan, "path": format!("{work}/unknown.out"), "format": "nope", "sheet": "Data" }));
    assert!(unknown.is_err(), "unknown format must fail");
    let left: Vec<String> = std::fs::read_dir(&work).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n.ends_with(".floe-tmp")).collect();
    assert!(left.is_empty(), "temp files left behind: {left:?}");
}

#[test]
fn rows_and_profile_share_one_date_wire_format() {
    let Some((fx, dir)) = setup() else {
        eprintln!("tests/fixtures/parity.json missing — run `node scripts/gen-fixtures.mjs` from the repo root");
        return;
    };
    let case = fx["fixtures"].as_array().unwrap().iter().find(|c| c["name"] == "types and per-cell errors").unwrap();
    let mut plan = case["plan"].clone();
    rewrite_paths(&mut plan, &dir);
    let r = floe_engine::call("evaluate", &json!({ "plan": plan, "mode": "full", "previewRows": 1000 })).unwrap();
    let id = r["resultId"].as_str().unwrap();
    let schema = r["schema"].as_array().unwrap();
    let ix = schema.iter().position(|c| c["type"] == "date").expect("a date column");
    let name = schema[ix]["name"].as_str().unwrap();
    let rows = floe_engine::rows(id, 50).unwrap();
    let cell = rows.iter().map(|row| &row[ix]).find(|v| v.is_object()).expect("a date cell");
    assert!(cell.get("__date").is_some(), "rows date cell: {cell}");
    let profile = floe_engine::call("profile", &json!({ "resultId": id, "col": name })).unwrap();
    assert!(profile["profile"]["min"].get("__date").is_some(), "profile min: {}", profile["profile"]["min"]);
}

#[test]
fn page_keeps_int64_values_exact() {
    let dir = std::env::temp_dir().join(format!("floe_big_int_{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("big.parquet");
    let mut df = df!("id" => [9007199254740993i64, -9007199254740993, 7], "label" => ["a", "b", "c"]).unwrap();
    ParquetWriter::new(std::fs::File::create(&file).unwrap()).finish(&mut df).unwrap();
    let plan = json!({
        "v": 1,
        "locale": "en-US",
        "source": { "kind": "parquet", "path": file.to_string_lossy().replace('\\', "/") },
        "ops": []
    });
    let r = floe_engine::call("evaluate", &json!({ "plan": plan, "mode": "full", "previewRows": 1000 })).unwrap();
    let bytes = floe_engine::page(r["resultId"].as_str().unwrap(), 0, 10).unwrap();
    let page = IpcStreamReader::new(std::io::Cursor::new(bytes)).finish().unwrap();
    let col = page.column("id").unwrap();
    assert_eq!(col.dtype(), &DataType::Int64);
    let values: Vec<Option<i64>> = col.i64().unwrap().iter().collect();
    assert_eq!(values, vec![Some(9007199254740993), Some(-9007199254740993), Some(7)]);
}

#[test]
fn a_panic_in_the_engine_becomes_an_error() {
    let failed = floe_engine::guarded::<()>(|| panic!("boom")).unwrap_err();
    assert!(failed.contains("crashed") && failed.contains("boom"), "{failed}");
    assert_eq!(floe_engine::guarded(|| Ok(7)), Ok(7));
}

#[test]
fn release_profile_unwinds_so_engine_panics_can_be_caught() {
    let manifest = include_str!("../../Cargo.toml");
    let section = manifest.split("[profile.release]").nth(1).expect("release profile");
    let section = section.split("\n[").next().unwrap();
    assert!(!section.contains("panic = \"abort\""), "release profile aborts on panic");
    assert!(section.contains("panic = \"unwind\""), "release profile must unwind");
}

#[test]
fn page_keeps_the_utc_instant_of_a_zoned_datetime() {
    let dir = std::env::temp_dir().join(format!("floe_zoned_{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("zoned.parquet");
    let zone = TimeZone::opt_try_new(Some("America/New_York")).unwrap();
    let instants = [1735689600000i64, 1751328000000];
    let t = Series::new("t".into(), &instants).cast(&DataType::Datetime(TimeUnit::Milliseconds, zone)).unwrap();
    let mut df = DataFrame::new_infer_height(vec![t.into()]).unwrap();
    ParquetWriter::new(std::fs::File::create(&file).unwrap()).finish(&mut df).unwrap();
    let plan = json!({
        "v": 1,
        "locale": "en-US",
        "source": { "kind": "parquet", "path": file.to_string_lossy().replace('\\', "/") },
        "ops": []
    });
    let r = floe_engine::call("evaluate", &json!({ "plan": plan, "mode": "full", "previewRows": 1000 })).unwrap();
    assert_eq!(r["schema"][0]["type"], "datetime");
    let id = r["resultId"].as_str().unwrap();
    let bytes = floe_engine::page(id, 0, 10).unwrap();
    let page = IpcStreamReader::new(std::io::Cursor::new(bytes)).finish().unwrap();
    let col = page.column("t").unwrap();
    assert_eq!(col.dtype(), &DataType::Datetime(TimeUnit::Milliseconds, None));
    let got: Vec<Option<i64>> = col.datetime().unwrap().phys.iter().collect();
    assert_eq!(got, instants.iter().map(|v| Some(*v)).collect::<Vec<_>>());
    let profile = floe_engine::call("profile", &json!({ "resultId": id, "col": "t" })).unwrap();
    assert_eq!(profile["profile"]["min"]["__date"], json!(instants[0]));
    assert_eq!(profile["profile"]["max"]["__date"], json!(instants[1]));
}

#[test]
fn scans_receive_filters_and_projections() {
    let dir = std::env::temp_dir().join(format!("floe_pushdown_{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let parquet = dir.join("wide.parquet");
    let mut df = df!("id" => [1i64, 2, 3, 4], "qty" => [1i64, 5, 7, 2], "name" => ["a", "b", "c", "d"], "price" => [1.5f64, 2.5, 3.5, 4.5]).unwrap();
    ParquetWriter::new(std::fs::File::create(&parquet).unwrap()).finish(&mut df).unwrap();
    let csv = dir.join("wide.csv");
    std::fs::write(&csv, "id,qty,name,price\n1,1,a,1.5\n2,5,b,2.5\n3,7,c,3.5\n").unwrap();
    let filter = json!({ "op": "filter", "expr": { "k": "bin", "op": ">=", "a": { "k": "col", "name": "qty" }, "b": { "k": "lit", "v": 3 } } });
    let select = json!({ "op": "select", "cols": ["id", "qty"] });
    let sources = [
        json!({ "kind": "parquet", "path": parquet.to_string_lossy().replace('\\', "/") }),
        json!({ "kind": "csv", "path": csv.to_string_lossy().replace('\\', "/"), "delimiter": ",", "header": true, "skipRows": 0 }),
    ];
    for source in sources {
        let plan = json!({ "v": 1, "locale": "en-US", "source": source, "ops": [filter.clone(), select.clone()] });
        let mut cx = floe_engine::Ctx { preview: None, truncated: false, gen: floe_engine::generation() };
        let lf = floe_engine::build(&plan, &mut cx).unwrap();
        let text = lf.describe_optimized_plan().unwrap();
        println!("{}\n{text}", source["kind"]);
        assert!(text.contains("SELECTION"), "{} scan has no selection:\n{text}", source["kind"]);
        assert!(text.contains("PROJECT 2/4 COLUMNS") || text.contains("PROJECT 2/"), "{} scan has no projection:\n{text}", source["kind"]);
    }
}

#[test]
fn explain_returns_the_optimized_plan() {
    let dir = std::env::temp_dir().join(format!("floe_explain_{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let csv = dir.join("e.csv");
    std::fs::write(&csv, "a,b\n1,x\n5,y\n").unwrap();
    let plan = json!({
        "v": 1,
        "locale": "en-US",
        "source": { "kind": "csv", "path": csv.to_string_lossy().replace('\\', "/"), "delimiter": ",", "header": true, "skipRows": 0 },
        "ops": [{ "op": "select", "cols": ["a"] }]
    });
    let r = floe_engine::call("explain", &json!({ "plan": plan })).unwrap();
    let text = r["text"].as_str().unwrap();
    assert!(text.contains("SCAN") && text.contains("PROJECT 1/2 COLUMNS"), "{text}");
}

#[test]
fn streamed_csv_counts_rows_with_quoted_newlines() {
    let dir = std::env::temp_dir().join(format!("floe_csv_rows_{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let src = dir.join("in.csv");
    let text = "id,t\n1,\"a\nb\"\n2,\"say \"\"hi\"\"\"\n3,plain\n";
    std::fs::write(&src, text).unwrap();
    let plan = json!({
        "v": 1,
        "locale": "en-US",
        "source": { "kind": "csv", "path": src.to_string_lossy().replace('\\', "/"), "delimiter": ",", "header": true, "skipRows": 0 },
        "ops": []
    });
    let out = dir.join("out.csv");
    let r = floe_engine::call("export", &json!({ "plan": plan, "format": "csv", "path": out.to_string_lossy().replace('\\', "/"), "sheet": "Data" })).unwrap();
    assert_eq!(r["rows"], 3);
    assert_eq!(std::fs::read_to_string(&out).unwrap(), text);
}

#[test]
fn streamed_csv_matches_the_buffered_writer() {
    let Some((fx, dir)) = setup() else {
        eprintln!("tests/fixtures/parity.json missing — run `node scripts/gen-fixtures.mjs` from the repo root");
        return;
    };
    let case = fx["fixtures"].as_array().unwrap().iter().find(|c| c["name"] == "types and per-cell errors").unwrap();
    let mut plan = case["plan"].clone();
    rewrite_paths(&mut plan, &dir);
    let mut cx = floe_engine::Ctx { preview: None, truncated: false, gen: floe_engine::generation() };
    let mut df = floe_engine::build(&plan, &mut cx).unwrap().collect().unwrap();
    let keep: Vec<PlSmallStr> = df.get_column_names().into_iter().filter(|n| !n.starts_with(floe_engine::ERR_PREFIX)).cloned().collect();
    df = df.select(keep).unwrap();
    let mut buffered = Vec::new();
    CsvWriter::new(&mut buffered).include_header(true).with_date_format(Some("%Y-%m-%d".into())).with_datetime_format(Some("%Y-%m-%d %H:%M:%S".into())).finish(&mut df).unwrap();
    let work = format!("{dir}/streamed-csv");
    std::fs::create_dir_all(&work).unwrap();
    let out = format!("{work}/orders.csv");
    let r = floe_engine::call("export", &json!({ "plan": plan, "format": "csv", "path": out, "sheet": "Data" })).unwrap();
    assert_eq!(r["rows"], df.height());
    assert_eq!(std::fs::read(&out).unwrap(), buffered);
}

#[test]
fn a_panic_inside_a_full_run_is_contained() {
    let lf = df!("a" => [1i64, 2, 3]).unwrap().lazy().map(|_| panic!("boom"), AllowedOptimizations::default(), None, Some("boom"));
    let failed = floe_engine::guarded(|| floe_engine::collect_full(lf)).unwrap_err();
    assert!(failed.contains("boom"), "{failed}");
}

#[test]
fn full_runs_do_not_depend_on_the_callers_stack() {
    let worker = std::thread::Builder::new()
        .stack_size(512 << 10)
        .spawn(|| {
            let mut lf = df!("a" => [1i64, 2, 3, 4]).unwrap().lazy();
            for i in 0..40 {
                lf = lf.with_column((col("a") + lit(i as i64)).alias("a")).filter(col("a").gt(lit(-1i64)));
            }
            floe_engine::collect_full(lf).unwrap().height()
        })
        .unwrap();
    assert_eq!(worker.join().unwrap(), 4);
}

