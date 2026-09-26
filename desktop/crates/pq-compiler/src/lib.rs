//! pq-compiler — turns a `Query` into a Polars `LazyFrame` for any step index.
//!
//! * `compile(q, upto, ctx)` builds the lazy plan; nothing executes.
//! * `schema_after(q, upto)` calls `collect_schema()` — column pickers, type icons and
//!   "column `Price` not found; it was renamed in step 4" without reading data.
//! * Every step has a fingerprint = hash(source fingerprint + serialized steps so far + params).
//!   It is the cache key: change step 7 and steps 1–6 stay cached.
//! * Pivot / Transpose / PromoteHeaders need data → automatic checkpoint (collect → Arrow IPC → scan_ipc).
//! * Per-cell errors: casts run non-strict and a hidden mask `__err_<col>` records
//!   `casted.is_null() & original.is_not_null()`.

use pq_model::*;
use polars::prelude::*;
use std::collections::HashMap;
use std::path::PathBuf;

pub mod fingerprint;
pub use fingerprint::Fingerprint;

pub const ERR_PREFIX: &str = "__err_";

#[derive(Debug, thiserror::Error)]
pub enum StepError {
    #[error("column `{col}` not found{because}")]
    MissingColumn { col: String, because: String, suggestion: Option<String> },
    #[error("{0}")]
    Formula(#[from] pq_expr::FormulaError),
    #[error("{0}")]
    Polars(#[from] PolarsError),
    #[error("{0}")]
    Source(String),
    #[error("{0}")]
    Model(#[from] ModelError),
    #[error("blocked by the error in step {0}")]
    Blocked(usize),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// `head(N)` at the source — instant; group-by / join reflect the sample (the UI says so).
    Preview(u32),
    /// Whole query with the streaming engine.
    Full,
}

pub struct CompileCtx<'a> {
    pub project: &'a Project,
    pub mode: Mode,
    pub cache_dir: PathBuf,
    /// Resolves a file id to a path on disk (the project stores ids + names, the app maps them).
    pub resolve_file: &'a dyn Fn(&str, &str) -> Option<PathBuf>,
    memo: std::cell::RefCell<HashMap<(QueryId, usize), LazyFrame>>,
}

impl<'a> CompileCtx<'a> {
    pub fn new(project: &'a Project, mode: Mode, resolve_file: &'a dyn Fn(&str, &str) -> Option<PathBuf>) -> Self {
        let cache_dir = dirs::cache_dir().unwrap_or_else(std::env::temp_dir).join("floe");
        let _ = std::fs::create_dir_all(&cache_dir);
        Self { project, mode, cache_dir, resolve_file, memo: Default::default() }
    }
    fn query(&self, id: &str) -> Result<&'a Query, StepError> {
        self.project.queries.iter().find(|q| q.id == id).ok_or_else(|| StepError::Model(ModelError::MissingQuery(id.into())))
    }
}

/// Build the lazy plan for query `q` up to and including step `upto`.
pub fn compile(q: &Query, upto: usize, ctx: &CompileCtx) -> Result<LazyFrame, (usize, StepError)> {
    if let Some(lf) = ctx.memo.borrow().get(&(q.id.clone(), upto)) { return Ok(lf.clone()); }
    let mut lf: Option<LazyFrame> = None;
    for (i, step) in q.steps.iter().enumerate().take(upto + 1) {
        if step.disabled == Some(true) && i > 0 { continue; }
        let prev = lf.take();
        let next = apply(prev, &step.kind, ctx).map_err(|e| (i, explain(q, i, e)))?;
        // Data-dependent schema → checkpoint so everything after stays lazy.
        let next = if step.kind.materializes() { checkpoint(next, q, i, ctx).map_err(|e| (i, e))? } else { next };
        lf = Some(next);
    }
    let lf = lf.ok_or((0, StepError::Source("query has no steps".into())))?;
    ctx.memo.borrow_mut().insert((q.id.clone(), upto), lf.clone());
    Ok(lf)
}

/// Schema after a step, without executing (except through checkpoints, which are cached).
pub fn schema_after(q: &Query, upto: usize, ctx: &CompileCtx) -> Result<SchemaRef, (usize, StepError)> {
    let mut lf = compile(q, upto, ctx)?;
    lf.collect_schema().map_err(|e| (upto, e.into()))
}

fn checkpoint(mut lf: LazyFrame, q: &Query, i: usize, ctx: &CompileCtx) -> Result<LazyFrame, StepError> {
    let fp = fingerprint::step_fingerprints(ctx.project, q, ctx.mode, ctx.resolve_file)?[i].clone();
    let path = ctx.cache_dir.join(format!("{}.arrow", fp.hex()));
    if !path.exists() {
        let mut df = lf.collect()?;
        let tmp = path.with_extension("tmp");
        let mut f = std::fs::File::create(&tmp).map_err(|e| StepError::Source(e.to_string()))?;
        IpcWriter::new(&mut f).finish(&mut df)?;
        std::fs::rename(&tmp, &path).map_err(|e| StepError::Source(e.to_string()))?;
    }
    lf = LazyFrame::scan_ipc(&path, Default::default())?;
    Ok(lf)
}

fn need(lf: &mut LazyFrame, cols: &[String]) -> Result<(), StepError> {
    let schema = lf.collect_schema()?;
    for c in cols {
        if schema.get(c.as_str()).is_none() {
            let names: Vec<String> = schema.iter_names().map(|n| n.to_string()).collect();
            return Err(StepError::MissingColumn { col: c.clone(), because: String::new(), suggestion: closest(c, &names) });
        }
    }
    Ok(())
}

fn closest(name: &str, candidates: &[String]) -> Option<String> {
    candidates.iter().map(|c| (strsim_lev(&name.to_lowercase(), &c.to_lowercase()), c)).filter(|(d, _)| *d <= 2.max(name.len() / 3)).min_by_key(|(d, _)| *d).map(|(_, c)| c.clone())
}
fn strsim_lev(a: &str, b: &str) -> usize {
    let b: Vec<char> = b.chars().collect();
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.chars().enumerate() {
        let mut cur = vec![i + 1];
        for (j, cb) in b.iter().enumerate() { cur.push((prev[j + 1] + 1).min(cur[j] + 1).min(prev[j] + usize::from(ca != *cb))); }
        prev = cur;
    }
    prev[b.len()]
}

/// Turn "column not found" into "…it was renamed to `X` in step 4 (Renamed Columns)".
fn explain(q: &Query, idx: usize, e: StepError) -> StepError {
    if let StepError::MissingColumn { col, suggestion, .. } = &e {
        for i in (0..idx).rev() {
            let s = &q.steps[i];
            let why = match &s.kind {
                StepKind::Rename { map } => map.iter().find(|(f, _)| f == col).map(|(_, t)| (format!(" — it was renamed to `{t}` in step {} ({})", i + 1, s.name), Some(t.clone()))),
                StepKind::RemoveColumns { cols } if cols.contains(col) => Some((format!(" — it was removed in step {} ({})", i + 1, s.name), None)),
                StepKind::SelectColumns { cols } if !cols.contains(col) => Some((format!(" — it was not kept in step {} ({})", i + 1, s.name), None)),
                _ => None,
            };
            if let Some((because, repl)) = why {
                return StepError::MissingColumn { col: col.clone(), because, suggestion: repl.or_else(|| suggestion.clone()) };
            }
        }
    }
    e
}

fn apply(prev: Option<LazyFrame>, kind: &StepKind, ctx: &CompileCtx) -> Result<LazyFrame, StepError> {
    use StepKind::*;
    if let Source { source } = kind { return scan_source(source, ctx); }
    let mut lf = prev.ok_or_else(|| StepError::Source("the first step must be a Source".into()))?;
    Ok(match kind {
        Source { .. } => unreachable!(),
        SelectColumns { cols } => { need(&mut lf, cols)?; lf.select(cols.iter().map(|c| col(c.as_str())).collect::<Vec<_>>()) }
        ReorderColumns { cols } => { need(&mut lf, cols)?; let first: Vec<Expr> = cols.iter().map(|c| col(c.as_str())).collect(); lf.select([first, vec![all().exclude(cols.iter().map(|c| c.as_str()))]].concat()) }
        RemoveColumns { cols } => { need(&mut lf, cols)?; lf.drop(cols.iter().map(|c| c.as_str())) }
        Rename { map } => { need(&mut lf, &map.iter().map(|p| p.0.clone()).collect::<Vec<_>>())?; lf.rename(map.iter().map(|p| p.0.as_str()), map.iter().map(|p| p.1.as_str()), true) }
        ChangeType { changes, on_error, locale } => cast_step(lf, changes, *on_error, locale.as_deref().unwrap_or(&ctx.project.settings.locale))?,
        Filter(f) => {
            let src = filter_formula(f);
            let schema = lf.collect_schema()?;
            let e = pq_expr::compile(&src, &schema, &ctx.project.params)?;
            lf.filter(e.fill_null(lit(false)))
        }
        Sort { by } => {
            need(&mut lf, &by.iter().map(|b| b.col.clone()).collect::<Vec<_>>())?;
            lf.sort(by.iter().map(|b| b.col.as_str()).collect::<Vec<_>>(), SortMultipleOptions::default()
                .with_order_descending_multi(by.iter().map(|b| b.desc)).with_nulls_last(true).with_maintain_order(true))
        }
        Distinct { subset } => lf.unique_stable(if subset.is_empty() { None } else { Some(subset.iter().map(|s| s.as_str().into()).collect()) }, UniqueKeepStrategy::First),
        KeepRows(k) => keep_rows(lf, k),
        FillDown { cols } => { need(&mut lf, cols)?; lf.with_columns(cols.iter().map(|c| col(c.as_str()).forward_fill(None)).collect::<Vec<_>>()) }
        FillUp { cols } => { need(&mut lf, cols)?; lf.with_columns(cols.iter().map(|c| col(c.as_str()).backward_fill(None)).collect::<Vec<_>>()) }
        TextTransform { op, cols } => {
            need(&mut lf, cols)?;
            lf.with_columns(cols.iter().map(|c| {
                let s = col(c.as_str()).cast(DataType::String).str();
                match op {
                    TextOp::Upper => s.to_uppercase(),
                    TextOp::Lower => s.to_lowercase(),
                    TextOp::Trim => s.strip_chars(lit(NULL)),
                    TextOp::Clean => s.replace_all(lit(r"\s+"), lit(" "), false).str().strip_chars(lit(NULL)),
                    TextOp::Proper => s.to_titlecase(),
                }
            }).collect::<Vec<_>>())
        }
        AddColumn { name, formula, cast_to } => {
            let schema = lf.collect_schema()?;
            let mut e = pq_expr::compile(formula, &schema, &ctx.project.params)?;
            if let Some(t) = cast_to { e = e.strict_cast(dtype(*t)); }
            lf.with_column(e.alias(name.as_str()))
        }
        IndexColumn { name, start, step, .. } => lf.with_column((int_range(lit(0i64), len().cast(DataType::Int64), 1, DataType::Int64) * lit(*step) + lit(*start)).alias(name.as_str())),
        GroupBy { keys, aggs } => {
            need(&mut lf, keys)?;
            let aggs: Vec<Expr> = aggs.iter().map(agg_expr).collect();
            if keys.is_empty() { lf.select(aggs) } else { lf.group_by_stable(keys.iter().map(|k| col(k.as_str())).collect::<Vec<_>>()).agg(aggs) }
        }
        Unpivot { ids, values, var, val } => {
            need(&mut lf, ids)?;
            let args = UnpivotArgsDSL {
                index: ids.iter().map(|s| s.as_str().into()).collect::<Vec<PlSmallStr>>().into(),
                on: values.clone().unwrap_or_default().iter().map(|s| s.as_str().into()).collect::<Vec<PlSmallStr>>().into(),
                variable_name: Some(var.as_str().into()),
                value_name: Some(val.as_str().into()),
            };
            lf.unpivot(args)
        }
        Merge(m) => {
            let rq = ctx.query(&m.right)?;
            let right = compile(rq, rq.steps.len().saturating_sub(1), ctx).map_err(|(_, e)| StepError::Source(format!("query `{}` has an error: {e}", rq.name)))?;
            let how = match m.how { JoinKind::Left => JoinType::Left, JoinKind::Right => JoinType::Right, JoinKind::Inner => JoinType::Inner, JoinKind::Full => JoinType::Full, JoinKind::Semi => JoinType::Semi, JoinKind::Anti => JoinType::Anti, JoinKind::Cross => JoinType::Cross };
            let lo: Vec<Expr> = m.on.iter().map(|p| if m.cast_keys == Some(true) { col(p.0.as_str()).cast(DataType::String) } else { col(p.0.as_str()) }).collect();
            let ro: Vec<Expr> = m.on.iter().map(|p| if m.cast_keys == Some(true) { col(p.1.as_str()).cast(DataType::String) } else { col(p.1.as_str()) }).collect();
            let right = match &m.expand { Some(cols) if !cols.is_empty() => { let mut keep: Vec<String> = m.on.iter().map(|p| p.1.clone()).collect(); keep.extend(cols.iter().cloned()); right.select(keep.iter().map(|c| col(c.as_str())).collect::<Vec<_>>()) } _ => right };
            let mut args = JoinArgs::new(how);
            if matches!(how, JoinType::Full) { args = args.with_coalesce(JoinCoalesce::CoalesceColumns); }
            if let Some(p) = &m.prefix { args = args.with_suffix(Some(format!(".{p}").into())); }
            lf.join(right, lo, ro, args)
        }
        Append { others, mode } => {
            let mut frames = vec![lf];
            for o in others { let q = ctx.query(o)?; frames.push(compile(q, q.steps.len().saturating_sub(1), ctx).map_err(|(_, e)| StepError::Source(e.to_string()))?); }
            match mode {
                AppendMode::Diagonal => concat_lf_diagonal(frames, UnionArgs::default())?,
                AppendMode::Strict => concat(frames, UnionArgs::default())?,
            }
        }
        CustomSql { sql } => {
            let mut sc = polars::sql::SQLContext::new();
            sc.register("self", lf);
            for q in &ctx.project.queries {
                let alias = snake(&q.name);
                if sql.to_lowercase().contains(&alias) {
                    if let Ok(other) = compile(q, q.steps.len().saturating_sub(1), ctx) { sc.register(&alias, other); }
                }
            }
            sc.execute(sql)?
        }
        Checkpoint => lf,
        KeepDuplicates { subset } => {
            let keys: Vec<Expr> = if subset.is_empty() { vec![all()] } else { need(&mut lf, subset)?; subset.iter().map(|c| col(c.as_str())).collect() };
            lf.filter(as_struct(keys).is_duplicated())
        }
        RoundNumbers { cols, digits } => { need(&mut lf, cols)?; lf.with_columns(cols.iter().map(|c| col(c.as_str()).round(*digits)).collect::<Vec<_>>()) }
        DuplicateColumn { col: c, name } => { need(&mut lf, std::slice::from_ref(c))?; lf.with_column(col(c.as_str()).alias(name.clone().unwrap_or_else(|| format!("{c} - Copy")).as_str())) }
        MergeColumns { cols, sep, name } => {
            need(&mut lf, cols)?;
            let parts: Vec<Expr> = cols.iter().map(|c| col(c.as_str()).cast(DataType::String).fill_null(lit(""))).collect();
            lf.with_column(concat_str(parts, sep, false).alias(name.as_str())).drop(cols.iter().map(|c| c.as_str()))
        }
        ReplaceValues { cols, find, replace, whole_cell } => {
            need(&mut lf, cols)?;
            let rep = || replace.clone().map(lit).unwrap_or(lit(NULL));
            lf.with_columns(cols.iter().map(|c| {
                let e = col(c.as_str());
                match find {
                    None => e.clone().fill_null(rep()).alias(c.as_str()),
                    Some(f) if *whole_cell => when(e.clone().cast(DataType::String).eq(lit(f.clone()))).then(rep().cast(DataType::String)).otherwise(e.clone().cast(DataType::String)).alias(c.as_str()),
                    Some(f) => e.clone().cast(DataType::String).str().replace_all(lit(f.clone()), lit(replace.clone().unwrap_or_default()), true).alias(c.as_str()),
                }
            }).collect::<Vec<_>>())
        }
        // Data-dependent: done eagerly, then checkpointed by `compile`.
        PromoteHeaders { row } => {
            let df = lf.collect()?;
            if *row >= df.height() { return Err(StepError::Source(format!("row {} does not exist", row + 1))); }
            let hdr = df.slice(*row as i64, 1);
            let mut seen = std::collections::HashSet::new();
            let names: Vec<String> = hdr.get_columns().iter().enumerate().map(|(i, c)| {
                let base = c.get(0).ok().filter(|v| !v.is_null()).map(|v| v.str_value().trim().to_string()).filter(|s| !s.is_empty()).unwrap_or_else(|| format!("Column{}", i + 1));
                let mut n = base.clone(); let mut k = 1;
                while !seen.insert(n.clone()) { n = format!("{base}_{k}"); k += 1; }
                n
            }).collect();
            let mut body = df.slice(*row as i64 + 1, df.height());
            body.set_column_names(names.iter().map(|s| s.as_str()))?;
            body.lazy()
        }
        other => return Err(StepError::Source(format!("{} runs on the built-in engine", step_type(other)))),
    })
}

/// Step kinds this engine executes. The UI's router sends a query here only if every step is supported.
pub const SUPPORTED: &[&str] = &[
    "Source", "SelectColumns", "ReorderColumns", "RemoveColumns", "Rename", "ChangeType", "Filter", "Sort", "Distinct",
    "KeepDuplicates", "KeepRows", "FillDown", "FillUp", "TextTransform", "AddColumn", "IndexColumn", "GroupBy", "Unpivot",
    "Merge", "Append", "CustomSql", "Checkpoint", "RoundNumbers", "DuplicateColumn", "MergeColumns", "ReplaceValues", "PromoteHeaders",
];

pub fn step_type(k: &StepKind) -> String {
    serde_json::to_value(k).ok().and_then(|v| v.get("type").and_then(|t| t.as_str()).map(String::from)).unwrap_or_default()
}

/// First unsupported step (index, type) in `q` or any query it references; None = fully native.
pub fn unsupported(project: &Project, q: &Query) -> Option<(usize, String)> {
    fn go(p: &Project, q: &Query, seen: &mut Vec<String>) -> Option<(usize, String)> {
        if seen.contains(&q.id) { return None; }
        seen.push(q.id.clone());
        for (i, s) in q.steps.iter().enumerate() {
            if s.disabled == Some(true) { continue; }
            let t = step_type(&s.kind);
            if !SUPPORTED.contains(&t.as_str()) { return Some((i, t)); }
            if let StepKind::Source { source: SourceSpec::Folder { .. } | SourceSpec::Database { .. } } = &s.kind { return Some((i, "Source".into())); }
            if let StepKind::Source { source: SourceSpec::File { format: Some(FileFormat::Excel), item: Some(ExcelItem::Sheets { .. } | ExcelItem::Name { .. }), .. } } = &s.kind { return Some((i, "Source".into())); }
            for r in s.kind.references() {
                if let Some(rq) = p.queries.iter().find(|x| &x.id == r) { if let Some(u) = go(p, rq, seen) { return Some(u); } }
            }
        }
        None
    }
    go(project, q, &mut vec![])
}

fn keep_rows(lf: LazyFrame, k: &KeepRowsSpec) -> LazyFrame {
    match k.mode {
        KeepMode::Top => lf.limit(k.n as IdxSize),
        KeepMode::Bottom => lf.tail(k.n as IdxSize),
        KeepMode::Range => lf.slice(k.offset as i64, k.n as IdxSize),
        KeepMode::RemoveTop => lf.slice(k.n as i64, IdxSize::MAX),
        KeepMode::RemoveBottom => lf.with_row_index("__i", None).filter(col("__i").lt(len() - lit(k.n as u32))).drop(["__i"]),
        KeepMode::Alternate => lf.with_row_index("__i", None).filter(((col("__i") - lit(k.offset as u32)) % lit((k.keep + k.skip) as u32)).lt(lit(k.keep as u32))).drop(["__i"]),
        KeepMode::RemoveBlank => lf.filter(any_horizontal([all().is_not_null()]).unwrap_or(lit(true))),
    }
}

/// Non-strict cast + hidden per-cell error mask.
fn cast_step(mut lf: LazyFrame, changes: &[TypeChange], mode: CastErrorMode, locale: &str) -> Result<LazyFrame, StepError> {
    need(&mut lf, &changes.iter().map(|c| c.col.clone()).collect::<Vec<_>>())?;
    let decimal_comma = matches!(locale, "de-DE" | "fr-FR");
    let mut exprs = vec![];
    for ch in changes {
        let c = col(ch.col.as_str());
        let text = c.clone().cast(DataType::String);
        let cleaned = if decimal_comma { text.clone().str().replace_all(lit(r"[.\s€$£]"), lit(""), false).str().replace(lit(","), lit("."), true) } else { text.clone().str().replace_all(lit(r"[,\s€$£]"), lit(""), false) };
        let casted = match ch.dtype {
            DType::Int | DType::Number => cleaned.cast(dtype(ch.dtype)),
            DType::Date => text.clone().str().to_date(StrptimeOptions { strict: false, ..Default::default() }),
            DType::Datetime => text.clone().str().to_datetime(None, None, StrptimeOptions { strict: false, ..Default::default() }, lit("raise")),
            DType::Bool => text.clone().str().to_lowercase().is_in(lit(Series::new("".into(), ["true", "yes", "y", "1"]))),
            DType::Text | DType::Any => text.clone(),
        };
        let failed = casted.clone().is_null().and(c.clone().is_not_null()).and(text.clone().str().len_chars().gt(lit(0)));
        match mode {
            CastErrorMode::Error => { exprs.push(failed.alias(format!("{ERR_PREFIX}{}", ch.col))); exprs.push(casted.alias(ch.col.as_str())); }
            CastErrorMode::Null => exprs.push(casted.alias(ch.col.as_str())),
            CastErrorMode::Keep => { exprs.push(when(failed).then(text).otherwise(lit(NULL)).alias(format!("{}_error", ch.col))); exprs.push(casted.alias(ch.col.as_str())); }
            CastErrorMode::Fail => exprs.push(c.strict_cast(dtype(ch.dtype)).alias(ch.col.as_str())),
        }
    }
    Ok(lf.with_columns(exprs))
}

pub fn dtype(t: DType) -> DataType {
    match t { DType::Text | DType::Any => DataType::String, DType::Number => DataType::Float64, DType::Int => DataType::Int64, DType::Bool => DataType::Boolean, DType::Date => DataType::Date, DType::Datetime => DataType::Datetime(TimeUnit::Microseconds, None) }
}

fn agg_expr(a: &AggSpec) -> Expr {
    let c = || col(a.col.as_deref().unwrap_or(""));
    let e = match a.func {
        AggFn::CountRows => len(), AggFn::Count => c().count(), AggFn::CountDistinct => c().n_unique(),
        AggFn::Sum => c().sum(), AggFn::Mean => c().mean(), AggFn::Median => c().median(), AggFn::Min => c().min(), AggFn::Max => c().max(),
        AggFn::First => c().first(), AggFn::Last => c().last(),
        AggFn::Concat => c().cast(DataType::String).str().join(a.sep.as_deref().unwrap_or(", "), true),
    };
    let name = a.name.clone().unwrap_or_else(|| format!("{:?}{}", a.func, a.col.as_ref().map(|c| format!(" of {c}")).unwrap_or_default()));
    e.alias(name.as_str())
}

/// Builder filters compile to formula text, so there is exactly one code path (and one codegen).
pub fn filter_formula(f: &FilterSpec) -> String {
    if f.mode == FilterMode::Advanced { return f.formula.clone().unwrap_or_else(|| "true".into()); }
    let Some(b) = &f.builder else { return "true".into() };
    let q = |c: &str| format!("[{}]", c.replace(']', "]]"));
    let lit = |v: &serde_json::Value| match v { serde_json::Value::Null => "null".to_string(), serde_json::Value::Number(n) => n.to_string(), serde_json::Value::Bool(b) => b.to_string(), serde_json::Value::String(s) => format!("\"{}\"", s.replace('"', "\"\"")), other => format!("\"{other}\"") };
    let parts: Vec<String> = b.conds.iter().map(|c| {
        let v = c.value.clone().unwrap_or(serde_json::Value::Null);
        let v = if c.numeric == Some(true) { v.as_str().and_then(|s| s.parse::<f64>().ok()).map(|n| serde_json::json!(n)).unwrap_or(v) } else { v };
        match c.op.as_str() {
            "eq" => format!("{} = {}", q(&c.col), lit(&v)), "ne" => format!("{} <> {}", q(&c.col), lit(&v)),
            "gt" => format!("{} > {}", q(&c.col), lit(&v)), "ge" => format!("{} >= {}", q(&c.col), lit(&v)),
            "lt" => format!("{} < {}", q(&c.col), lit(&v)), "le" => format!("{} <= {}", q(&c.col), lit(&v)),
            "contains" => format!("Text.Contains(Text.From({}), {})", q(&c.col), lit(&v)),
            "null" => format!("{} = null", q(&c.col)), "not_null" => format!("{} <> null", q(&c.col)),
            "in" | "not_in" => { let l = c.values.clone().unwrap_or_default().iter().map(lit).collect::<Vec<_>>().join(", "); let e = format!("{} in {{{l}}}", q(&c.col)); if c.op == "in" { e } else { format!("not ({e})") } }
            _ => "true".into(),
        }
    }).collect();
    parts.join(if b.join == "or" { " or " } else { " and " })
}

fn scan_source(src: &SourceSpec, ctx: &CompileCtx) -> Result<LazyFrame, StepError> {
    let limit = match ctx.mode { Mode::Preview(n) => Some(n as usize), Mode::Full => None };
    match src {
        SourceSpec::File { file_id, file_name, format, csv, item, fill_merged } => {
            let path = (ctx.resolve_file)(file_id, file_name).ok_or_else(|| StepError::Source(format!("file `{file_name}` is not available — relink it")))?;
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
            let fmt = format.unwrap_or(match ext.as_str() { "xlsx" | "xlsm" | "xlsb" | "xls" | "ods" => FileFormat::Excel, "parquet" => FileFormat::Parquet, "arrow" | "ipc" | "feather" => FileFormat::Ipc, "json" | "ndjson" | "jsonl" => FileFormat::Json, _ => FileFormat::Csv });
            match fmt {
                FileFormat::Csv => {
                    let o = csv.clone().unwrap_or_default();
                    let sep = o.delimiter.as_deref().and_then(|d| d.bytes().next()).unwrap_or(b',');
                    let mut r = LazyCsvReader::new(&path).with_separator(sep).with_has_header(o.header.unwrap_or(true)).with_skip_rows(o.skip_rows.unwrap_or(0)).with_infer_schema_length(Some(0));
                    if let Some(n) = limit { r = r.with_n_rows(Some(n)); }
                    Ok(r.finish()?)
                }
                FileFormat::Parquet => { let lf = LazyFrame::scan_parquet(&path, Default::default())?; Ok(if let Some(n) = limit { lf.limit(n as IdxSize) } else { lf }) }
                FileFormat::Ipc => { let lf = LazyFrame::scan_ipc(&path, Default::default())?; Ok(if let Some(n) = limit { lf.limit(n as IdxSize) } else { lf }) }
                FileFormat::Json => { let lf = LazyJsonLineReader::new(&path).finish()?; Ok(if let Some(n) = limit { lf.limit(n as IdxSize) } else { lf }) }
                // Excel can't be read lazily: parse once to Arrow IPC keyed by (file hash, item, options), then scan_ipc.
                FileFormat::Excel => {
                    let item = item.clone().unwrap_or(ExcelItem::Sheet { name: String::new() });
                    let ipc = pq_excel::cached_ipc(&path, &item, fill_merged.unwrap_or(false), &ctx.cache_dir).map_err(|e| StepError::Source(e.to_string()))?;
                    let lf = LazyFrame::scan_ipc(&ipc, Default::default())?;
                    Ok(if let Some(n) = limit { lf.limit(n as IdxSize) } else { lf })
                }
            }
        }
        SourceSpec::Folder { .. } => Err(StepError::Source("folder sources: glob scan + per-file sample transform (see pq-connectors, phase 3)".into())),
        SourceSpec::Query { query } => { let q = ctx.query(query)?; compile(q, q.steps.len().saturating_sub(1), ctx).map_err(|(_, e)| StepError::Source(format!("query `{}` has an error: {e}", q.name))) }
        SourceSpec::Blank { columns, rows } => {
            let cols: Vec<Column> = columns.iter().enumerate().map(|(i, name)| Column::new(name.as_str().into(), rows.iter().map(|r| r.get(i).cloned()).collect::<Vec<Option<String>>>())).collect();
            Ok(DataFrame::new(cols)?.lazy())
        }
        SourceSpec::Database { .. } => Err(StepError::Source("database sources arrive with pq-connectors (connectorx / arrow-odbc) + pq-folding".into())),
    }
}
