//! PQX project model — the single source of truth for queries.
//!
//! A query is an ordered list of typed steps (Power Query's "Applied Steps"), never raw code.
//! The serialized form is identical to the web prototype's JSON (`js/steps.js`), so projects
//! move freely between the browser preview and the desktop app.
//!
//! Rule: this crate must not depend on Polars.

use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::BTreeMap;

pub const FORMAT_VERSION: u32 = 1;

pub type QueryId = String;
pub type StepId = String;

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
pub struct Project {
    #[serde(default = "default_version")]
    pub format_version: u32,
    pub name: String,
    #[serde(default)]
    pub settings: Settings,
    #[serde(default)]
    pub params: Vec<Param>,
    pub queries: Vec<Query>,
}
fn default_version() -> u32 { FORMAT_VERSION }

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default = "default_preview")]
    pub preview_rows: u32,
    #[serde(default = "default_locale")]
    pub locale: String,
}
fn default_preview() -> u32 { 1000 }
fn default_locale() -> String { "en-US".into() }
impl Default for Settings {
    fn default() -> Self { Self { preview_rows: default_preview(), locale: default_locale() } }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
pub struct Param {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: ParamKind,
    pub value: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ParamKind { Text, Number, Date, List }

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
pub struct Query {
    pub id: QueryId,
    pub name: String,
    pub steps: Vec<Step>,
    #[serde(default)]
    pub load: LoadTarget,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Default)]
pub struct LoadTarget {
    #[serde(default)]
    pub target: OutputKind,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum OutputKind { #[default] None, Xlsx, Csv, Parquet }

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
pub struct Step {
    pub id: StepId,
    pub name: String,
    pub kind: StepKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disabled: Option<bool>,
}

/// Every step kind. `#[serde(tag = "type")]` gives `{ "type": "Filter", ... }` — the same shape
/// the UI writes. TypeScript types are generated from this enum with specta / tauri-specta,
/// so the UI and the engine can never disagree about what a step looks like.
#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
#[serde(tag = "type")]
pub enum StepKind {
    Source { source: SourceSpec },
    SelectColumns { cols: Vec<String> },
    ReorderColumns { cols: Vec<String> },
    RemoveColumns { cols: Vec<String> },
    Rename { map: Vec<(String, String)> },
    ChangeType {
        changes: Vec<TypeChange>,
        #[serde(default, rename = "onError")]
        on_error: CastErrorMode,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        locale: Option<String>,
    },
    Filter(FilterSpec),
    Sort { by: Vec<SortKey> },
    Distinct { #[serde(default)] subset: Vec<String> },
    KeepDuplicates { #[serde(default)] subset: Vec<String> },
    KeepRows(KeepRowsSpec),
    PromoteHeaders { #[serde(default)] row: usize },
    DemoteHeaders,
    FillDown { cols: Vec<String> },
    FillUp { cols: Vec<String> },
    ReplaceValues {
        cols: Vec<String>,
        #[serde(default, deserialize_with = "lenient_str")]
        find: Option<String>,
        #[serde(default, deserialize_with = "lenient_str")]
        replace: Option<String>,
        #[serde(default = "yes", rename = "wholeCell")]
        whole_cell: bool,
    },
    ReplaceErrors { cols: Vec<String>, #[serde(default, deserialize_with = "lenient_str")] value: Option<String> },
    RemoveErrors { #[serde(default)] cols: Vec<String> },
    KeepErrors { #[serde(default)] cols: Vec<String> },
    TextTransform { op: TextOp, cols: Vec<String> },
    RoundNumbers { cols: Vec<String>, #[serde(default)] digits: u32 },
    SplitColumn(SplitSpec),
    MergeColumns { cols: Vec<String>, #[serde(default)] sep: String, #[serde(default = "merged")] name: String },
    AddColumn {
        name: String,
        formula: String,
        #[serde(default, rename = "castTo", skip_serializing_if = "Option::is_none")]
        cast_to: Option<DType>,
    },
    ConditionalColumn { name: String, rules: Vec<ConditionalRule>, #[serde(rename = "else")] otherwise: String },
    IndexColumn { #[serde(default = "idx")] name: String, #[serde(default)] start: i64, #[serde(default = "one")] step: i64, #[serde(default)] first: bool },
    DuplicateColumn { col: String, #[serde(default)] name: Option<String> },
    GroupBy { keys: Vec<String>, aggs: Vec<AggSpec> },
    Unpivot {
        ids: Vec<String>,
        #[serde(default)]
        values: Option<Vec<String>>,
        #[serde(default = "attr")]
        var: String,
        #[serde(default = "val")]
        val: String,
    },
    /// Forces materialization: output columns depend on the data.
    Pivot { on: String, #[serde(default)] values: Option<String>, #[serde(default)] agg: AggFn, #[serde(default)] index: Vec<String> },
    /// Forces materialization.
    Transpose { #[serde(default, rename = "headerCol")] header_col: Option<String> },
    Merge(MergeSpec),
    Append { others: Vec<QueryId>, #[serde(default)] mode: AppendMode },
    Window(WindowSpec),
    ExpandJson { col: String },
    /// `self` = previous step; other queries by snake_case name. Runs through polars `SQLContext`.
    CustomSql { sql: String },
    /// User-forced buffer (Table.Buffer): materialize, write Arrow IPC to cache, scan_ipc back.
    Checkpoint,
}
fn yes() -> bool { true }

/// Accepts string, number, bool or null (the UI stores user-typed literals loosely).
fn lenient_str<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    let v = serde_json::Value::deserialize(d)?;
    Ok(match v { serde_json::Value::Null => None, serde_json::Value::String(s) if s.is_empty() => None, serde_json::Value::String(s) => Some(s), other => Some(other.to_string()) })
}
fn attr() -> String { "Attribute".into() }
fn idx() -> String { "Index".into() }
fn one() -> i64 { 1 }
fn merged() -> String { "Merged".into() }
fn val() -> String { "Value".into() }

impl StepKind {
    /// Steps whose output schema depends on the data. The compiler inserts an automatic checkpoint.
    pub fn materializes(&self) -> bool {
        matches!(self, StepKind::Pivot { .. } | StepKind::Transpose { .. } | StepKind::Checkpoint | StepKind::PromoteHeaders { .. })
    }
    /// Queries this step reads from (for the dependency DAG).
    pub fn references(&self) -> Vec<&QueryId> {
        match self {
            StepKind::Source { source: SourceSpec::Query { query } } => vec![query],
            StepKind::Merge(m) => vec![&m.right],
            StepKind::Append { others, .. } => others.iter().collect(),
            _ => vec![],
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum SourceSpec {
    File {
        #[serde(rename = "fileId", default)]
        file_id: String,
        #[serde(rename = "fileName")]
        file_name: String,
        #[serde(default)]
        format: Option<FileFormat>,
        #[serde(default)]
        csv: Option<CsvOptions>,
        #[serde(default)]
        item: Option<ExcelItem>,
        #[serde(default, rename = "fillMerged")]
        fill_merged: Option<bool>,
    },
    Folder {
        folder: String,
        #[serde(default = "star")]
        pattern: String,
        #[serde(default)]
        format: Option<FileFormat>,
        #[serde(default)]
        csv: Option<CsvOptions>,
        #[serde(default = "source_name", rename = "fileColumn")]
        file_column: String,
    },
    Query { query: QueryId },
    Blank { columns: Vec<String>, rows: Vec<Vec<String>> },
    /// Desktop only: connectorx / arrow-odbc. The project stores a credential *reference*; the secret lives in the OS keychain.
    Database { connection: String, #[serde(rename = "credentialRef")] credential_ref: Option<String>, table: Option<String>, sql: Option<String> },
}
fn star() -> String { "*".into() }
fn source_name() -> String { "Source.Name".into() }

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FileFormat { Csv, Excel, Json, Parquet, Ipc }

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct CsvOptions {
    pub delimiter: Option<String>,
    pub header: Option<bool>,
    pub encoding: Option<String>,
    pub skip_rows: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ExcelItem {
    Table { name: String },
    Sheet { name: String },
    Range { sheet: String, range: String },
    Name { name: String },
    Sheets { pattern: String, #[serde(default = "sheet_col", rename = "sheetColumn")] sheet_column: String, #[serde(default, rename = "includeHidden")] include_hidden: bool },
}
fn sheet_col() -> String { "_sheet".into() }

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DType { Text, Number, Int, Bool, Date, Datetime, Any }

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
pub struct TypeChange {
    pub col: String,
    #[serde(rename = "type")]
    pub dtype: DType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locale: Option<String>,
}

/// Polars has no per-cell errors; PQX adds them (non-strict cast + error mask).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum CastErrorMode {
    /// Keep a per-cell error marker (hidden mask column `__err_<col>`).
    #[default]
    Error,
    Null,
    /// Null + original text in `<col>_error`.
    Keep,
    Fail,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
pub struct FilterSpec {
    #[serde(default)]
    pub mode: FilterMode,
    #[serde(default)]
    pub formula: Option<String>,
    #[serde(default)]
    pub builder: Option<FilterBuilder>,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum FilterMode { #[default] Builder, Advanced }
#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
pub struct FilterBuilder { #[serde(default = "and")] pub join: String, #[serde(default)] pub conds: Vec<FilterCond> }
fn and() -> String { "and".into() }
#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
pub struct FilterCond {
    pub col: String,
    pub op: String,
    #[serde(default)]
    pub value: Option<serde_json::Value>,
    #[serde(default)]
    pub values: Option<Vec<serde_json::Value>>,
    #[serde(default)]
    pub numeric: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SortKey { pub col: String, #[serde(default)] pub desc: bool, #[serde(default = "yes")] pub nulls_last: bool }

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
pub struct KeepRowsSpec {
    pub mode: KeepMode,
    #[serde(default)] pub n: usize,
    #[serde(default)] pub offset: usize,
    #[serde(default)] pub keep: usize,
    #[serde(default)] pub skip: usize,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum KeepMode { Top, Bottom, Range, RemoveTop, RemoveBottom, Alternate, RemoveBlank }

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TextOp { Upper, Lower, Trim, Clean, Proper }

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
pub struct SplitSpec {
    pub col: String,
    pub mode: SplitMode,
    #[serde(default)] pub delimiter: Option<String>,
    #[serde(default)] pub positions: Option<String>,
    #[serde(default)] pub count: Option<usize>,
    #[serde(default = "yes")] pub trim: bool,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SplitMode { Each, First, Last, Rows, Positions }

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
pub struct ConditionalRule { pub when: String, pub then: String }

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
pub struct AggSpec {
    /// JSON field is `fn` (a Rust keyword).
    #[serde(rename = "fn")]
    pub func: AggFn,
    #[serde(default)] pub col: Option<String>,
    #[serde(default)] pub name: Option<String>,
    #[serde(default)] pub sep: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum AggFn { CountRows, Count, CountDistinct, #[default] Sum, Mean, Median, Min, Max, First, Last, Concat }

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MergeSpec {
    pub right: QueryId,
    #[serde(default)] pub on: Vec<(String, String)>,
    #[serde(default)] pub how: JoinKind,
    #[serde(default)] pub expand: Option<Vec<String>>,
    #[serde(default)] pub prefix: Option<String>,
    #[serde(default)] pub cast_keys: Option<bool>,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum JoinKind { #[default] Left, Right, Inner, Full, Semi, Anti, Cross }

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum AppendMode { Strict, #[default] Diagonal }

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WindowSpec {
    pub op: WindowOp,
    #[serde(default)] pub col: Option<String>,
    pub name: String,
    #[serde(default)] pub partition: Vec<String>,
    #[serde(default)] pub order_by: Option<String>,
    #[serde(default)] pub desc: bool,
    #[serde(default)] pub n: Option<i64>,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WindowOp { Cumsum, RowNumber, Rank, Lag, Lead, PctOfTotal, MovingAvg }

/* ------------------------------------------------------------------ */
/* Project files: folder (or zip) = project.json + queries/<name>.json */
/* ------------------------------------------------------------------ */

#[derive(Debug, thiserror::Error)]
pub enum ModelError {
    #[error("not a PQX project: {0}")]
    Parse(#[from] serde_json::Error),
    #[error("project was saved by a newer PQX (format {0}, this build understands {FORMAT_VERSION})")]
    TooNew(u32),
    #[error("circular reference: {0}")]
    Cycle(String),
    #[error("query `{0}` not found")]
    MissingQuery(String),
}

/// Migrations run from day one: every format change adds an arm here.
pub fn migrate(mut raw: serde_json::Value) -> Result<Project, ModelError> {
    let v = raw.get("format_version").and_then(|v| v.as_u64()).unwrap_or(1) as u32;
    if v > FORMAT_VERSION { return Err(ModelError::TooNew(v)); }
    // v1 is current. Future: `if v < 2 { rename field ... }`
    raw["format_version"] = FORMAT_VERSION.into();
    Ok(serde_json::from_value(raw)?)
}

/// Pretty-printed, sorted keys → clean `git diff`. One file per query.
pub fn to_files(p: &Project) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let file_of = |q: &Query| format!("queries/{}.json", snake(&q.name));
    let index = serde_json::json!({
        "format_version": FORMAT_VERSION,
        "name": p.name,
        "settings": p.settings,
        "params": p.params,
        "queries": p.queries.iter().map(|q| serde_json::json!({"id": q.id, "file": file_of(q)})).collect::<Vec<_>>(),
    });
    out.insert("project.json".into(), stable_pretty(&index));
    for q in &p.queries { out.insert(file_of(q), stable_pretty(&serde_json::to_value(q).unwrap())); }
    out
}

pub fn stable_pretty(v: &serde_json::Value) -> String {
    fn sort(v: &serde_json::Value) -> serde_json::Value {
        match v {
            serde_json::Value::Object(m) => {
                let mut keys: Vec<_> = m.keys().collect();
                keys.sort();
                let mut o = serde_json::Map::new();
                for k in keys { o.insert(k.clone(), sort(&m[k])); }
                serde_json::Value::Object(o)
            }
            serde_json::Value::Array(a) => serde_json::Value::Array(a.iter().map(sort).collect()),
            x => x.clone(),
        }
    }
    serde_json::to_string_pretty(&sort(v)).unwrap() + "\n"
}

pub fn snake(s: &str) -> String {
    let mut r = String::new();
    for ch in s.chars() {
        if ch.is_ascii_alphanumeric() { r.push(ch.to_ascii_lowercase()); } else if !r.ends_with('_') { r.push('_'); }
    }
    let r = r.trim_matches('_').to_string();
    if r.is_empty() || r.chars().next().unwrap().is_ascii_digit() { format!("q_{r}") } else { r }
}

/// Topological order of queries (dependencies first). Cycles are reported as `A → B → A`.
pub fn topo_order(p: &Project) -> Result<Vec<QueryId>, ModelError> {
    use std::collections::HashMap;
    let by_id: HashMap<&str, &Query> = p.queries.iter().map(|q| (q.id.as_str(), q)).collect();
    let mut state: HashMap<&str, u8> = HashMap::new();
    let mut order = vec![];
    fn visit<'a>(id: &'a str, by_id: &HashMap<&'a str, &'a Query>, state: &mut HashMap<&'a str, u8>, path: &mut Vec<&'a str>, order: &mut Vec<QueryId>) -> Result<(), ModelError> {
        match state.get(id) {
            Some(2) => return Ok(()),
            Some(1) => {
                let start = path.iter().position(|x| *x == id).unwrap_or(0);
                let names: Vec<_> = path[start..].iter().chain(std::iter::once(&id)).map(|x| by_id[x].name.clone()).collect();
                return Err(ModelError::Cycle(names.join(" → ")));
            }
            _ => {}
        }
        let q = by_id.get(id).ok_or_else(|| ModelError::MissingQuery(id.to_string()))?;
        state.insert(id, 1);
        path.push(id);
        for s in &q.steps { for r in s.kind.references() { visit(r.as_str(), by_id, state, path, order)?; } }
        path.pop();
        state.insert(id, 2);
        order.push(id.to_string());
        Ok(())
    }
    for q in &p.queries { visit(q.id.as_str(), &by_id, &mut state, &mut vec![], &mut order)?; }
    Ok(order)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_prototype_json() {
        let json = r#"{"name":"Demo","settings":{"previewRows":1000,"locale":"en-US"},"params":[],"queries":[
          {"id":"q1","name":"Orders","load":{"target":"xlsx"},"steps":[
            {"id":"s1","name":"Source","kind":{"type":"Source","source":{"kind":"file","fileId":"f","fileName":"orders.csv","csv":{"delimiter":","}}}},
            {"id":"s2","name":"Changed Type","kind":{"type":"ChangeType","changes":[{"col":"qty","type":"int"}],"onError":"null"}},
            {"id":"s3","name":"Filtered","kind":{"type":"Filter","mode":"advanced","formula":"[qty] > 1"}}
          ]}]}"#;
        let p = migrate(serde_json::from_str(json).unwrap()).unwrap();
        assert_eq!(p.queries[0].steps.len(), 3);
        let again: Project = serde_json::from_str(&serde_json::to_string(&p).unwrap()).unwrap();
        assert_eq!(p, again);
    }

    #[test]
    fn detects_cycles_with_path() {
        let q = |id: &str, r: &str| Query { id: id.into(), name: id.to_uppercase(), load: Default::default(), steps: vec![Step { id: "s".into(), name: "Source".into(), note: None, disabled: None, kind: StepKind::Source { source: SourceSpec::Query { query: r.into() } } }] };
        let p = Project { format_version: 1, name: "x".into(), settings: Default::default(), params: vec![], queries: vec![q("a", "b"), q("b", "a")] };
        let e = topo_order(&p).unwrap_err().to_string();
        assert!(e.contains("A → B → A"), "{e}");
    }

    #[test]
    fn rejects_newer_format() {
        assert!(matches!(migrate(serde_json::json!({"format_version": 99, "name": "x", "queries": []})), Err(ModelError::TooNew(99))));
    }
}
