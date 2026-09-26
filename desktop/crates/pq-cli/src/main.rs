//! pqx — run a PQX project headless. Same engine crates as the desktop app.
//!
//!   pqx run    <project> [--param K=V]... [--query NAME] [--output DIR] [--data DIR]
//!   pqx inspect <project>
//!
//! Schedule with cron / Task Scheduler / CI — something Power Query can't do without Excel.

use anyhow::{bail, Context, Result};
use pq_compiler::{compile, CompileCtx, Mode};
use pq_model::*;
use polars::prelude::*;
use std::path::{Path, PathBuf};

fn load(path: &Path) -> Result<Project> {
    let text = if path.is_dir() {
        // folder layout: project.json + queries/*.json
        let idx: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path.join("project.json"))?)?;
        let mut v = idx.clone();
        let qs: Vec<serde_json::Value> = idx["queries"].as_array().cloned().unwrap_or_default().iter()
            .map(|q| -> Result<serde_json::Value> { Ok(serde_json::from_str(&std::fs::read_to_string(path.join(q["file"].as_str().unwrap_or_default()))?)?) })
            .collect::<Result<_>>()?;
        v["queries"] = serde_json::Value::Array(qs);
        v.to_string()
    } else { std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))? };
    Ok(migrate(serde_json::from_str(&text)?)?)
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (cmd, rest) = args.split_first().context("usage: pqx run|inspect <project>")?;
    let proj_path = PathBuf::from(rest.first().context("missing project path")?);
    let mut project = load(&proj_path)?;
    let mut out_dir = PathBuf::from("out");
    let mut data_dir = proj_path.parent().unwrap_or(Path::new(".")).join("data");
    let mut only: Option<String> = None;
    let mut it = rest.iter().skip(1);
    while let Some(a) = it.next() {
        match a.as_str() {
            "--param" => { let kv = it.next().context("--param K=V")?; let (k, v) = kv.split_once('=').context("--param K=V")?; match project.params.iter_mut().find(|p| p.name == k) { Some(p) => p.value = v.into(), None => bail!("unknown parameter {k}") } }
            "--output" => out_dir = it.next().context("--output DIR")?.into(),
            "--data" => data_dir = it.next().context("--data DIR")?.into(),
            "--query" => only = Some(it.next().context("--query NAME")?.clone()),
            other => bail!("unknown option {other}"),
        }
    }
    let order = topo_order(&project)?;
    if cmd == "inspect" {
        for id in &order { let q = project.queries.iter().find(|q| &q.id == id).unwrap(); println!("{:<32} {:>3} steps  → {:?}", q.name, q.steps.len(), q.load.target); }
        return Ok(());
    }
    if cmd != "run" { bail!("unknown command {cmd}"); }
    std::fs::create_dir_all(&out_dir)?;
    let dd = data_dir.clone();
    let resolve = move |_id: &str, name: &str| { let p = dd.join(name); p.exists().then_some(p) };
    let ctx = CompileCtx::new(&project, Mode::Full, &resolve);
    for id in &order {
        let q = project.queries.iter().find(|q| &q.id == id).unwrap();
        if let Some(n) = &only { if &q.name != n { continue; } } else if q.load.target == OutputKind::None { continue; }
        let t0 = std::time::Instant::now();
        let lf = compile(q, q.steps.len() - 1, &ctx).map_err(|(i, e)| anyhow::anyhow!("{}: step {} ({}) failed: {e}", q.name, i + 1, q.steps[i].name))?;
        let file = out_dir.join(format!("{}.{}", snake(&q.name), match q.load.target { OutputKind::Parquet => "parquet", OutputKind::Xlsx => "xlsx", _ => "csv" }));
        match q.load.target {
            OutputKind::Parquet => lf.sink_parquet(&file, Default::default(), None)?,
            // xlsx output uses polars_excel_writer in the full build; CSV keeps this scaffold dependency-light.
            _ => { let mut df = lf.with_new_streaming(true).collect()?; CsvWriter::new(std::fs::File::create(&file)?).finish(&mut df)?; }
        }
        eprintln!("✓ {:<32} → {} ({} ms)", q.name, file.display(), t0.elapsed().as_millis());
    }
    Ok(())
}
