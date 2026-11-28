use serde_json::{json, Value};
use std::io::Write;

fn csv(name: &str, body: &str) -> String {
    let p = std::env::temp_dir().join(format!("floe_sql_{name}_{}.csv", std::process::id()));
    std::fs::File::create(&p).unwrap().write_all(body.as_bytes()).unwrap();
    p.to_string_lossy().into_owned()
}

fn source(path: &str) -> Value {
    json!({ "kind": "csv", "path": path, "delimiter": ",", "header": true, "skipRows": 0 })
}

fn cast(cols: &[(&str, &str)]) -> Value {
    json!({ "op": "cast", "onError": "error", "changes": cols.iter().map(|(c, t)| json!({ "col": c, "type": t, "locale": "en-US" })).collect::<Vec<_>>() })
}

fn plan(path: &str, ops: Vec<Value>) -> Value {
    json!({ "v": 1, "locale": "en-US", "source": source(path), "ops": ops })
}

fn evaluate(p: Value) -> Result<Value, String> {
    floe_engine::call("evaluate", &json!({ "plan": p, "mode": "full", "previewRows": 1000 }))
}

fn rows_of(r: &Value) -> Vec<Vec<Value>> {
    floe_engine::rows(r["resultId"].as_str().unwrap(), 1000).unwrap()
}

fn nums(rows: Vec<Vec<Value>>) -> Vec<Option<f64>> {
    rows.into_iter().map(|row| row[0].as_f64()).collect()
}

fn names_of(r: &Value) -> Vec<String> {
    r["schema"].as_array().unwrap().iter().map(|c| c["name"].as_str().unwrap().to_string()).collect()
}

fn sql(text: &str) -> Value {
    json!({ "op": "sql", "sql": text, "tables": [] })
}

#[test]
fn sql_that_polars_cannot_run_is_an_error_so_the_caller_falls_back() {
    let p = csv("errors", "region,qty\nEU,1\nUS,2\n");
    for (label, text) in [
        ("syntax error", "SELEC region FROM self"),
        ("duplicate output names", "SELECT region, region FROM self"),
        ("text compared with a number", "SELECT * FROM self WHERE region = 3"),
        ("unknown column", "SELECT nope FROM self"),
        ("unknown table", "SELECT * FROM missing"),
        ("empty text", "   "),
    ] {
        let r = evaluate(plan(&p, vec![cast(&[("qty", "int")]), sql(text)]));
        let e = r.expect_err(label);
        assert!(!e.trim().is_empty(), "{label}: the error says nothing");
    }
}

#[test]
fn sql_result_with_no_rows_keeps_its_columns() {
    let p = csv("empty", "region,qty\nEU,1\nUS,2\n");
    let r = evaluate(plan(&p, vec![cast(&[("qty", "int")]), sql("SELECT region, qty FROM self WHERE region = 'XX'")])).unwrap();
    assert_eq!(r["n"], 0);
    assert_eq!(names_of(&r), vec!["region", "qty"]);
    assert_eq!(r["schema"][1]["type"], "int");
}

#[test]
fn sql_sees_cast_errors_as_nulls_and_never_the_flag_columns() {
    let p = csv("flags", "v\n1\nx\n3\n");
    let r = evaluate(plan(&p, vec![cast(&[("v", "int")]), sql("SELECT * FROM self ORDER BY v NULLS FIRST")])).unwrap();
    assert_eq!(names_of(&r), vec!["v"]);
    assert_eq!(nums(rows_of(&r)), vec![None, Some(1.0), Some(3.0)]);
    let all: Vec<String> = r["schema"].as_array().unwrap().iter().map(|c| c["name"].as_str().unwrap().to_string()).collect();
    assert!(all.iter().all(|n| !n.starts_with("__err_")), "{all:?}");
}

#[test]
fn sql_reads_other_queries_by_name_and_keeps_input_order_for_ties() {
    let orders = csv("orders", "id,cust,amt\n1,a,10\n2,b,20\n3,a,30\n4,c,40\n5,b,50\n");
    let custs = csv("custs", "cust,name\na,Ann\nb,Ben\n");
    let other = plan(&custs, vec![]);
    let op = json!({ "op": "sql", "sql": "SELECT o.id, c.name FROM self AS o LEFT JOIN customers AS c ON o.cust = c.cust ORDER BY c.name NULLS FIRST", "tables": [{ "name": "customers", "plan": other }] });
    let r = evaluate(plan(&orders, vec![cast(&[("id", "int"), ("amt", "int")]), op])).unwrap();
    assert_eq!(names_of(&r), vec!["id", "name"]);
    assert_eq!(nums(rows_of(&r)), vec![Some(4.0), Some(1.0), Some(3.0), Some(2.0), Some(5.0)]);
}

#[test]
fn sql_plans_export_like_any_other_plan() {
    let p = csv("export", "region,qty\nEU,2\nUS,5\nEU,3\n");
    let path = std::env::temp_dir().join(format!("floe_sql_out_{}.csv", std::process::id())).to_string_lossy().into_owned();
    let pl = plan(&p, vec![cast(&[("qty", "int")]), sql("SELECT region, SUM(qty) AS total_qty FROM self GROUP BY region ORDER BY region NULLS FIRST")]);
    let r = floe_engine::call("export", &json!({ "plan": pl, "path": path, "format": "csv", "sheet": "Data" })).unwrap();
    assert_eq!(r["rows"], 2);
    let text = std::fs::read_to_string(&path).unwrap();
    assert_eq!(text.lines().collect::<Vec<_>>(), vec!["region,total_qty", "EU,5", "US,5"]);
}

#[test]
fn sql_in_a_preview_runs_on_the_sample_only() {
    let p = csv("preview", "n\n1\n2\n3\n4\n5\n6\n");
    let r = floe_engine::call("evaluate", &json!({ "plan": plan(&p, vec![cast(&[("n", "int")]), sql("SELECT COUNT(*) AS c FROM self")]), "mode": "preview", "previewRows": 4 })).unwrap();
    assert_eq!(nums(rows_of(&r)), vec![Some(4.0)]);
}

#[test]
fn sql_plans_keep_projection_pushdown_into_the_scan() {
    let p = csv("explain", "id,region,qty,note\n1,EU,5,x\n2,US,1,y\n3,EU,7,z\n");
    let r = floe_engine::call("explain", &json!({ "plan": plan(&p, vec![cast(&[("qty", "int")]), sql("SELECT region, SUM(qty) AS total_qty FROM self WHERE qty > 2 GROUP BY region ORDER BY region NULLS FIRST")]) })).unwrap();
    let text = r["text"].as_str().unwrap();
    assert!(text.contains("SCAN") && text.contains("PROJECT 2/4 COLUMNS"), "{text}");
}

fn ids_ascend_within_ties(rows: &[Vec<Value>]) -> usize {
    let mut breaks = 0;
    let mut prev: Option<(String, f64)> = None;
    for row in rows {
        let id = row[0].as_f64().unwrap();
        let key = row[1..].iter().map(|v| v.to_string()).collect::<Vec<_>>().join("|");
        if let Some((pk, pid)) = &prev {
            if *pk == key && id < *pid {
                breaks += 1;
            }
        }
        prev = Some((key, id));
    }
    breaks
}

#[test]
fn sql_order_by_keeps_input_order_among_ties_on_a_large_table() {
    let n = 500_000usize;
    let mut body = String::from("id,region,qty\n");
    for i in 0..n {
        body.push_str(&format!("{},{},{}\n", i, ["EU", "US", "APAC", "LATAM", "MEA"][i % 5], i % 7));
    }
    let big = csv("large", &body);
    let small = csv("large_regions", "region,zone\nEU,a\nUS,b\nAPAC,c\nLATAM,d\nMEA,e\n");
    let casts = cast(&[("id", "int"), ("qty", "int")]);
    let run = |text: &str, tables: Vec<Value>| {
        let op = json!({ "op": "sql", "sql": text, "tables": tables });
        let r = evaluate(plan(&big, vec![casts.clone(), op])).unwrap();
        floe_engine::rows(r["resultId"].as_str().unwrap(), n + 10).unwrap()
    };
    let one = run("SELECT id, region, qty FROM self ORDER BY region NULLS FIRST, qty DESC NULLS LAST, __floe_row NULLS FIRST", vec![]);
    assert_eq!(one.len(), n);
    assert_eq!(ids_ascend_within_ties(&one), 0);
    let joined = run(
        "SELECT s.id, s.region, s.qty, z.zone FROM self AS s LEFT JOIN zones AS z ON s.region = z.region ORDER BY s.qty NULLS FIRST, s.region NULLS FIRST, s.__floe_row NULLS FIRST, z.__floe_row NULLS FIRST",
        vec![json!({ "name": "zones", "plan": plan(&small, vec![]) })],
    );
    assert_eq!(joined.len(), n);
    assert_eq!(ids_ascend_within_ties(&joined), 0);
}
