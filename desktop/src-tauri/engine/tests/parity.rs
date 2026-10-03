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

fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => {
            let (x, y) = (x.as_f64().unwrap(), y.as_f64().unwrap());
            (x - y).abs() <= 1e-9 * x.abs().max(y.abs()).max(1.0)
        }
        (Value::Object(x), Value::Object(y)) => x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).map(|w| same(v, w)).unwrap_or(false)),
        _ => a == b,
    }
}

#[test]
fn parity_with_builtin_engine() {
    let Some(fx) = fixtures() else {
        eprintln!("tests/fixtures/parity.json missing — run `node scripts/gen-fixtures.mjs` from the repo root");
        return;
    };
    let dir = std::env::temp_dir().join(format!("floe_parity_{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    for (name, text) in fx["inputs"].as_object().unwrap() {
        std::fs::write(dir.join(name), text.as_str().unwrap()).unwrap();
    }
    let dir = dir.to_string_lossy().replace('\\', "/");
    let mut failures = Vec::new();
    for case in fx["fixtures"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let mut plan = case["plan"].clone();
        rewrite_paths(&mut plan, &dir);
        let exp = &case["expected"];
        let r = match floe_engine::call("evaluate", &json!({ "plan": plan, "mode": "full", "previewRows": 1000 })) {
            Ok(r) => r,
            Err(e) => {
                failures.push(format!("{name}: engine error: {e}"));
                continue;
            }
        };
        if r["n"] != exp["n"] {
            failures.push(format!("{name}: rows {} ≠ expected {}", r["n"], exp["n"]));
            continue;
        }
        if r["schema"] != exp["schema"] {
            failures.push(format!("{name}: schema\n    got      {}\n    expected {}", r["schema"], exp["schema"]));
            continue;
        }
        let got = floe_engine::rows(r["resultId"].as_str().unwrap(), 200).unwrap();
        for (i, (g, e)) in got.iter().zip(exp["rows"].as_array().unwrap()).enumerate() {
            let e = e.as_array().unwrap();
            if g.len() != e.len() || !g.iter().zip(e).all(|(a, b)| same(a, b)) {
                failures.push(format!("{name}: row {}\n    got      {}\n    expected {}", i + 1, Value::from(g.clone()), Value::from(e.clone())));
                break;
            }
        }
    }
    let total = fx["fixtures"].as_array().unwrap().len();
    eprintln!("parity: {}/{} fixtures match the built-in engine", total - failures.len(), total);
    assert!(failures.is_empty(), "\n{}\n", failures.join("\n"));
}
