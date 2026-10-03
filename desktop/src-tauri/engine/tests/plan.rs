use serde_json::json;
use std::io::Write;

fn csv(name: &str, body: &str) -> String {
    let p = std::env::temp_dir().join(format!("floe_{name}_{}.csv", std::process::id()));
    std::fs::File::create(&p).unwrap().write_all(body.as_bytes()).unwrap();
    p.to_string_lossy().into_owned()
}

fn run(plan: serde_json::Value) -> serde_json::Value {
    floe_engine::call("evaluate", &json!({ "plan": plan, "mode": "full", "previewRows": 1000 })).unwrap_or_else(|e| panic!("{e}"))
}

#[test]
fn cast_filter_group() {
    let p = csv("orders", "region,qty,price\nEU,2,\"1,000.50\"\nUS,5,n/a\nEU,3,10\n");
    let r = run(json!({ "v": 1, "locale": "en-US", "source": { "kind": "csv", "path": p, "delimiter": ",", "header": true, "skipRows": 0 }, "ops": [
        { "op": "cast", "onError": "error", "changes": [{ "col": "qty", "type": "int", "locale": "en-US" }, { "col": "price", "type": "number", "locale": "en-US" }] },
        { "op": "filter", "expr": { "k": "bin", "op": ">", "a": { "k": "col", "name": "qty" }, "b": { "k": "lit", "v": 1 } } },
        { "op": "groupBy", "keys": ["region"], "aggs": [{ "fn": "sum", "col": "qty", "name": "Sum of qty", "sep": ", " }, { "fn": "count_rows", "col": null, "name": "Count rows", "sep": ", " }] }
    ]}));
    assert_eq!(r["n"], 2);
    assert_eq!(r["schema"][0]["name"], "region");
    assert_eq!(r["schema"][1]["type"], "int");
}

#[test]
fn cast_errors_are_flagged() {
    let p = csv("errs", "price\n1.5\nn/a\n\n");
    let r = run(json!({ "v": 1, "locale": "en-US", "source": { "kind": "csv", "path": p, "delimiter": ",", "header": true, "skipRows": 0 }, "ops": [
        { "op": "cast", "onError": "error", "changes": [{ "col": "price", "type": "number", "locale": "en-US" }] }
    ]}));
    assert_eq!(r["quality"][0]["error"], 1);
    assert_eq!(r["schema"].as_array().unwrap().len(), 1);
}

#[test]
fn formula_text_and_dates() {
    let p = csv("dates", "name,d\nana,2026-03-04\nben,2025-12-31\n");
    let r = run(json!({ "v": 1, "locale": "en-US", "source": { "kind": "csv", "path": p, "delimiter": ",", "header": true, "skipRows": 0 }, "ops": [
        { "op": "cast", "onError": "error", "changes": [{ "col": "d", "type": "date", "locale": "en-US" }] },
        { "op": "filter", "expr": { "k": "bin", "op": ">=", "a": { "k": "col", "name": "d" }, "b": { "k": "call", "fn": "#date", "args": [{ "k": "lit", "v": 2026 }, { "k": "lit", "v": 1 }, { "k": "lit", "v": 1 }] } } },
        { "op": "addColumn", "name": "label", "castTo": null, "locale": "en-US", "expr": { "k": "bin", "op": "&", "a": { "k": "call", "fn": "Text.Upper", "args": [{ "k": "col", "name": "name" }] }, "b": { "k": "call", "fn": "Text.From", "args": [{ "k": "call", "fn": "Date.Year", "args": [{ "k": "col", "name": "d" }] }] } } }
    ]}));
    assert_eq!(r["n"], 1);
    let id = r["resultId"].as_str().unwrap();
    let d = floe_engine::call("distinct", &json!({ "resultId": id, "col": "label" })).unwrap();
    assert_eq!(d["values"][0]["value"], "ANA2026");
}

#[test]
fn join_unpivot_pivot() {
    let a = csv("left", "id,v\n1,a\n2,b\n3,c\n");
    let b = csv("right", "id,w\n1,x\n3,z\n");
    let src = |p: &str| json!({ "kind": "csv", "path": p, "delimiter": ",", "header": true, "skipRows": 0 });
    let r = run(json!({ "v": 1, "locale": "en-US", "source": src(&a), "ops": [
        { "op": "join", "how": "left", "on": [["id", "id"]], "expand": null, "prefix": "", "castKeys": false, "right": { "v": 1, "locale": "en-US", "source": src(&b), "ops": [] } },
        { "op": "unpivot", "ids": ["id"], "values": null, "var": "Attribute", "val": "Value", "dropNulls": true },
        { "op": "pivot", "on": "Attribute", "index": ["id"], "values": "Value", "agg": "first" }
    ]}));
    assert_eq!(r["n"], 3);
    assert_eq!(r["schema"].as_array().unwrap().len(), 3);
}

#[test]
fn page_is_arrow_ipc() {
    let p = csv("page", "a\n1\n2\n");
    let r = run(json!({ "v": 1, "locale": "en-US", "source": { "kind": "csv", "path": p, "delimiter": ",", "header": true, "skipRows": 0 }, "ops": [] }));
    let bytes = floe_engine::page(r["resultId"].as_str().unwrap(), 0, 10).unwrap();
    assert!(bytes.len() > 8);
}
