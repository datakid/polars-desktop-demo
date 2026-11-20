use polars::prelude::*;
use serde_json::json;

fn dataset() -> String {
    let dir = std::env::var("BENCH_DIR").unwrap_or_else(|_| "/tmp/floe_bench".into());
    std::fs::create_dir_all(&dir).unwrap();
    let file = format!("{dir}/big.parquet");
    if !std::path::Path::new(&file).exists() {
        let n: usize = std::env::var("BENCH_ROWS").ok().and_then(|v| v.parse().ok()).unwrap_or(4_000_000);
        let regions = ["EU", "US", "APAC", "LATAM", "MEA"];
        let id: Vec<i64> = (0..n as i64).collect();
        let region: Vec<&str> = (0..n).map(|i| regions[i % 5]).collect();
        let qty: Vec<i64> = (0..n).map(|i| (i % 10) as i64).collect();
        let price: Vec<f64> = (0..n).map(|i| (i % 997) as f64 * 1.37).collect();
        let note: Vec<String> = (0..n).map(|i| format!("note-{i}-lorem ipsum dolor sit")).collect();
        let mut df = df!("id" => id, "region" => region, "qty" => qty, "price" => price, "note" => note).unwrap();
        ParquetWriter::new(std::fs::File::create(&file).unwrap()).finish(&mut df).unwrap();
    }
    file
}

fn plan(file: &str) -> serde_json::Value {
    json!({
        "v": 1,
        "locale": "en-US",
        "source": { "kind": "parquet", "path": file },
        "ops": [
            { "op": "filter", "expr": { "k": "bin", "op": ">=", "a": { "k": "col", "name": "qty" }, "b": { "k": "lit", "v": 3 } } },
            { "op": "round", "cols": ["price"], "digits": 1 }
        ]
    })
}

fn buffered_export(plan: &serde_json::Value, format: &str, out: &str) -> usize {
    let mut cx = floe_engine::Ctx { preview: None, truncated: false, gen: floe_engine::generation() };
    let mut df = floe_engine::build(plan, &mut cx).unwrap().collect().unwrap();
    let keep: Vec<PlSmallStr> = df.get_column_names().into_iter().filter(|n| !n.starts_with(floe_engine::ERR_PREFIX)).cloned().collect();
    df = df.select(keep).unwrap();
    let mut file = std::fs::File::create(out).unwrap();
    match format {
        "csv" => CsvWriter::new(&mut file).include_header(true).finish(&mut df).unwrap(),
        "parquet" => {
            ParquetWriter::new(&mut file).finish(&mut df).unwrap();
        }
        _ => IpcWriter::new(&mut file).finish(&mut df).unwrap(),
    }
    df.height()
}

#[test]
#[ignore]
fn bench_export() {
    let file = dataset();
    let format = std::env::var("BENCH_FORMAT").unwrap_or_else(|_| "csv".into());
    let mode = std::env::var("BENCH_MODE").unwrap_or_else(|_| "streamed".into());
    let out = format!("{}/out.{format}", std::path::Path::new(&file).parent().unwrap().display());
    let plan = plan(&file);
    let started = std::time::Instant::now();
    let rows = if mode == "buffered" {
        buffered_export(&plan, &format, &out)
    } else {
        floe_engine::call("export", &json!({ "plan": plan, "format": format, "path": out, "sheet": "Data" })).unwrap()["rows"].as_u64().unwrap() as usize
    };
    println!("BENCH export {format} {mode} rows={rows} ms={} bytes={}", started.elapsed().as_millis(), std::fs::metadata(&out).unwrap().len());
}

#[test]
#[ignore]
fn bench_evaluate() {
    let file = dataset();
    let mode = std::env::var("BENCH_MODE").unwrap_or_else(|_| "streamed".into());
    let plan = plan(&file);
    let started = std::time::Instant::now();
    let rows = if mode == "buffered" {
        let mut cx = floe_engine::Ctx { preview: None, truncated: false, gen: floe_engine::generation() };
        floe_engine::build(&plan, &mut cx).unwrap().collect().unwrap().height()
    } else {
        floe_engine::call("evaluate", &json!({ "plan": plan, "mode": "full", "previewRows": 1000 })).unwrap()["n"].as_u64().unwrap() as usize
    };
    println!("BENCH evaluate {mode} rows={rows} ms={}", started.elapsed().as_millis());
}
