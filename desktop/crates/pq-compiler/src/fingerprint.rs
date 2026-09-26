//! Step fingerprints = cache keys.
//! hash(mode + params + source fingerprint + serialized steps up to i + fingerprints of referenced queries)
//! Source fingerprint: path + mtime + size for files; connection + SQL for databases.

use crate::{Mode, StepError};
use pq_model::*;
use std::path::PathBuf;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Fingerprint(pub [u8; 32]);
impl Fingerprint {
    pub fn hex(&self) -> String { self.0.iter().map(|b| format!("{b:02x}")).collect::<String>()[..24].to_string() }
}

pub fn step_fingerprints(p: &Project, q: &Query, mode: Mode, resolve: &dyn Fn(&str, &str) -> Option<PathBuf>) -> Result<Vec<Fingerprint>, StepError> {
    step_fps(p, q, mode, resolve, &mut vec![])
}

fn step_fps(p: &Project, q: &Query, mode: Mode, resolve: &dyn Fn(&str, &str) -> Option<PathBuf>, stack: &mut Vec<String>) -> Result<Vec<Fingerprint>, StepError> {
    if stack.contains(&q.id) {
        let names: Vec<_> = stack.iter().chain(std::iter::once(&q.id)).filter_map(|id| p.queries.iter().find(|x| &x.id == id)).map(|x| x.name.clone()).collect();
        return Err(StepError::Model(ModelError::Cycle(names.join(" → "))));
    }
    stack.push(q.id.clone());
    let mut h = blake3::Hasher::new();
    h.update(format!("{mode:?}|{}|", p.settings.locale).as_bytes());
    h.update(serde_json::to_string(&p.params).unwrap().as_bytes());
    let mut prev = h.finalize();
    let mut out = vec![];
    for step in &q.steps {
        let mut h = blake3::Hasher::new();
        h.update(prev.as_bytes());
        h.update(serde_json::to_string(&step.kind).unwrap().as_bytes());
        if let StepKind::Source { source: SourceSpec::File { file_id, file_name, .. } } = &step.kind {
            if let Some(path) = resolve(file_id, file_name) {
                if let Ok(m) = std::fs::metadata(&path) {
                    h.update(path.to_string_lossy().as_bytes());
                    h.update(&m.len().to_le_bytes());
                    if let Ok(t) = m.modified() { h.update(format!("{t:?}").as_bytes()); }
                }
            }
        }
        for r in step.kind.references() {
            if let Some(rq) = p.queries.iter().find(|x| &x.id == r) {
                if let Some(last) = step_fps(p, rq, mode, resolve, stack)?.last() { h.update(&last.0); }
            }
        }
        prev = h.finalize();
        out.push(Fingerprint(*prev.as_bytes()));
    }
    stack.pop();
    Ok(out)
}
