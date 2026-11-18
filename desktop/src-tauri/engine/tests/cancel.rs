use serde_json::json;

#[test]
fn a_cancel_stops_a_plan_before_its_next_op() {
    let dir = std::env::temp_dir().join(format!("floe_cancel_{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let csv = dir.join("c.csv");
    std::fs::write(&csv, "a,b\n1,x\n2,y\n").unwrap();
    let plan = json!({
        "v": 1,
        "locale": "en-US",
        "source": { "kind": "csv", "path": csv.to_string_lossy().replace('\\', "/"), "delimiter": ",", "header": true, "skipRows": 0 },
        "ops": [{ "op": "sort", "by": [{ "col": "a", "desc": true }] }, { "op": "sort", "by": [{ "col": "b", "desc": false }] }]
    });
    let current = floe_engine::generation();
    let mut live = floe_engine::Ctx { preview: None, truncated: false, gen: current };
    assert!(floe_engine::build(&plan, &mut live).is_ok());
    floe_engine::cancel();
    let mut stale = floe_engine::Ctx { preview: None, truncated: false, gen: current };
    assert_eq!(floe_engine::build(&plan, &mut stale).err().as_deref(), Some("Cancelled"));
}

