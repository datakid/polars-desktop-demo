use crate::expr::{self, bool_from_text, date_from_text, dt_from_text, kind_of, num_from_text, parse_iso, text_of, trim, K};
use crate::{fmt_any, unique_name, uniquify, Ctx, ERR_PREFIX, R, S};
use polars::prelude::*;
use serde_json::Value;
use std::collections::HashSet;

const DAY: f64 = 86_400_000.0;
fn ms_dt() -> DataType {
    DataType::Datetime(TimeUnit::Milliseconds, None)
}
fn err_name(c: &str) -> String {
    format!("{ERR_PREFIX}{c}")
}
fn strs(v: &Value) -> Vec<String> {
    v.as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default()
}
fn st(v: &Value, k: &str) -> String {
    v[k].as_str().unwrap_or("").to_string()
}
fn schema(lf: &mut LazyFrame) -> R<SchemaRef> {
    lf.collect_schema().s()
}
fn visible(s: &Schema) -> Vec<String> {
    s.iter_names().map(|n| n.to_string()).filter(|n| !n.starts_with(ERR_PREFIX)).collect()
}
fn all_names(s: &Schema) -> Vec<String> {
    s.iter_names().map(|n| n.to_string()).collect()
}
fn dtype(s: &Schema, c: &str) -> R<DataType> {
    s.get(c).cloned().ok_or_else(|| format!("Column `{c}` not found"))
}
fn need(s: &Schema, cols: &[String]) -> R<()> {
    for c in cols {
        dtype(s, c)?;
    }
    Ok(())
}
fn null_of(dt: &DataType) -> Expr {
    lit(NULL).cast(dt.clone())
}
fn select_names(lf: LazyFrame, names: &[String]) -> LazyFrame {
    lf.select(names.iter().map(|n| col(n.as_str())).collect::<Vec<_>>())
}
fn with_errs(s: &Schema, keep: &[String]) -> Vec<String> {
    let mut out = keep.to_vec();
    for c in keep {
        let e = err_name(c);
        if s.get(&e).is_some() {
            out.push(e);
        }
    }
    out
}
fn drop_errs(lf: LazyFrame, s: &Schema) -> LazyFrame {
    select_names(lf, &visible(s))
}
fn place_after(names: &mut Vec<String>, new: &str, after: Option<usize>) {
    names.retain(|n| n != new);
    match after {
        Some(i) if i < names.len() => names.insert(i + 1, new.to_string()),
        _ => names.push(new.to_string()),
    }
}

pub fn cast_expr(e: Expr, from: &DataType, to: &str, locale: &str) -> Expr {
    let k = kind_of(from);
    let serial = |e: Expr| ((e.cast(DataType::Float64) - lit(25569.0)) * lit(DAY)).round(0).cast(DataType::Int64).cast(ms_dt());
    match to {
        "text" => text_of(e, k),
        "number" | "int" => {
            let x = match k {
                K::Num | K::Bool => e.cast(DataType::Float64),
                K::Date | K::Dt | K::Null => null_of(&DataType::Float64),
                _ => num_from_text(e.cast(DataType::String), locale),
            };
            if to == "int" { x.round(0).cast(DataType::Int64) } else { x.cast(DataType::Float64) }
        }
        "bool" => match k {
            K::Bool => e,
            K::Num => e.neq(lit(0)),
            K::Date | K::Dt | K::Null => null_of(&DataType::Boolean),
            _ => bool_from_text(e.cast(DataType::String)),
        },
        "date" => match k {
            K::Date => e,
            K::Dt => e.cast(DataType::Date),
            K::Num => serial(e).cast(DataType::Date),
            K::Bool | K::Null => null_of(&DataType::Date),
            _ => date_from_text(e.cast(DataType::String), locale),
        },
        "datetime" => match k {
            K::Dt => e.cast(ms_dt()),
            K::Date => e.cast(ms_dt()),
            K::Num => serial(e),
            K::Bool | K::Null => null_of(&ms_dt()),
            _ => dt_from_text(e.cast(DataType::String), locale),
        },
        _ => e,
    }
}

fn failed(orig: Expr, out: Expr, from: &DataType) -> Expr {
    let present = if kind_of(from) == K::Text { orig.clone().is_not_null().and(trim(orig).neq(lit(""))) } else { orig.is_not_null() };
    out.is_null().and(present)
}

fn conv(v: &Value, dt: &DataType, locale: &str) -> Option<Expr> {
    if v.is_null() {
        return Some(null_of(dt));
    }
    let text = match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        _ => return None,
    };
    match kind_of(dt) {
        K::Text | K::Any | K::Null => Some(lit(text)),
        K::Num => {
            let n = v.as_f64().or_else(|| {
                let t = text.trim().replace(['$', '€', '£', ' '], "");
                let t = if expr::comma_decimal(locale) { t.replace('.', "").replace(',', ".") } else { t.replace(',', "") };
                t.parse::<f64>().ok()
            })?;
            Some(lit(n).cast(dt.clone()))
        }
        K::Bool => match text.trim().to_lowercase().as_str() {
            "true" | "yes" | "y" | "1" => Some(lit(true)),
            "false" | "no" | "n" | "0" => Some(lit(false)),
            _ => None,
        },
        K::Date | K::Dt => {
            let (x, is_dt) = parse_iso(&text)?;
            let ms = if is_dt { x } else { x * 86_400_000 };
            Some(lit(ms).cast(ms_dt()).cast(dt.clone()))
        }
    }
}

fn regex_escape(s: &str) -> String {
    let mut o = String::new();
    for c in s.chars() {
        if "\\.+*?()|[]{}^$#&-~".contains(c) {
            o.push('\\');
        }
        o.push(c);
    }
    o
}

fn first_row_value(lf: LazyFrame, e: Expr) -> R<Option<i64>> {
    let df = lf.select([e.alias("__v")]).collect().s()?;
    Ok(df.column("__v").s()?.get(0).ok().and_then(|v| v.extract::<i64>()))
}

pub fn apply(mut lf: LazyFrame, op: &Value, locale: &str, cx: &mut Ctx) -> R<LazyFrame> {
    let s = schema(&mut lf)?;
    let names = visible(&s);
    match op["op"].as_str().unwrap_or("") {
        "select" => {
            let cols = strs(&op["cols"]);
            need(&s, &cols)?;
            Ok(select_names(lf, &with_errs(&s, &cols)))
        }
        "reorder" => {
            let cols = strs(&op["cols"]);
            need(&s, &cols)?;
            let mut order = cols.clone();
            order.extend(names.iter().filter(|n| !cols.contains(n)).cloned());
            Ok(select_names(lf, &with_errs(&s, &order)))
        }
        "drop" => {
            let cols = strs(&op["cols"]);
            need(&s, &cols)?;
            let keep: Vec<String> = names.iter().filter(|n| !cols.contains(n)).cloned().collect();
            Ok(select_names(lf, &with_errs(&s, &keep)))
        }
        "rename" => {
            let mut from = Vec::new();
            let mut to = Vec::new();
            for p in op["map"].as_array().cloned().unwrap_or_default() {
                let (a, b) = (p[0].as_str().unwrap_or("").to_string(), p[1].as_str().unwrap_or("").to_string());
                dtype(&s, &a)?;
                if s.get(&err_name(&a)).is_some() {
                    from.push(err_name(&a));
                    to.push(err_name(&b));
                }
                from.push(a);
                to.push(b);
            }
            let after: Vec<String> = names.iter().map(|n| from.iter().position(|f| f == n).map(|i| to[i].clone()).unwrap_or_else(|| n.clone())).collect();
            let mut seen = HashSet::new();
            if let Some(d) = after.iter().find(|n| !seen.insert((*n).clone())) {
                return Err(format!("Renaming would create two columns named `{d}`"));
            }
            Ok(lf.rename(from, to, true))
        }
        "cast" => {
            let mode = op["onError"].as_str().unwrap_or("error");
            let mut order = all_names(&s);
            for ch in op["changes"].as_array().cloned().unwrap_or_default() {
                let c = st(&ch, "col");
                let cur = schema(&mut lf)?;
                let from = dtype(&cur, &c)?;
                let loc = ch["locale"].as_str().unwrap_or(locale).to_string();
                let out = cast_expr(col(c.as_str()), &from, &st(&ch, "type"), &loc);
                let bad = failed(col(c.as_str()), out.clone(), &from);
                match mode {
                    "fail" => {
                        let n = first_row_value(lf.clone(), bad.clone().cast(DataType::Int64).sum())?.unwrap_or(0);
                        if n > 0 {
                            return Err(format!("{n} value(s) in column `{c}` can't be converted to {}", st(&ch, "type")));
                        }
                        lf = lf.with_column(out.alias(c.as_str()));
                    }
                    "null" => lf = lf.with_column(out.alias(c.as_str())),
                    "keep" => {
                        let en = unique_name(&format!("{c}_error"), &order.iter().cloned().collect());
                        lf = lf.with_columns([when(bad).then(text_of(col(c.as_str()), kind_of(&from))).otherwise(null_of(&DataType::String)).alias(en.as_str()), out.alias(c.as_str())]);
                        let at = order.iter().position(|n| *n == c);
                        place_after(&mut order, &en, at);
                        lf = select_names(lf, &order);
                    }
                    _ => {
                        let en = err_name(&c);
                        let prev = if cur.get(&en).is_some() { col(en.as_str()) } else { lit(false) };
                        lf = lf.with_columns([bad.or(prev).alias(en.as_str()), out.alias(c.as_str())]);
                        if !order.contains(&en) {
                            order.push(en);
                        }
                    }
                }
            }
            Ok(lf)
        }
        "filter" => {
            let (e, _) = expr::eval(&op["expr"], &s, locale)?;
            Ok(lf.filter(e.fill_null(lit(false))))
        }
        "sort" => {
            let by = op["by"].as_array().cloned().unwrap_or_default();
            if by.is_empty() {
                return Ok(lf);
            }
            let cols: Vec<String> = by.iter().map(|b| st(b, "col")).collect();
            need(&s, &cols)?;
            let desc: Vec<bool> = by.iter().map(|b| b["desc"].as_bool().unwrap_or(false)).collect();
            let nl: Vec<bool> = by.iter().map(|b| b["nullsLast"].as_bool().unwrap_or(true)).collect();
            let exprs: Vec<Expr> = cols.iter().map(|c| col(c.as_str())).collect();
            Ok(lf.sort_by_exprs(exprs, SortMultipleOptions::default().with_order_descending_multi(desc).with_nulls_last_multi(nl).with_maintain_order(true)))
        }
        "distinct" | "keepDuplicates" => {
            let subset = if op["subset"].is_null() { names.clone() } else { strs(&op["subset"]) };
            need(&s, &subset)?;
            if subset.is_empty() {
                return Ok(lf);
            }
            let key = if subset.len() == 1 { col(subset[0].as_str()) } else { as_struct(subset.iter().map(|c| col(c.as_str())).collect()) };
            Ok(lf.filter(if op["op"] == "distinct" { key.is_first_distinct() } else { key.is_duplicated() }))
        }
        "slice" => {
            let n = op["n"].as_u64().unwrap_or(0);
            let off = op["offset"].as_u64().unwrap_or(0);
            let idx = || col("__i").cast(DataType::Int64);
            let with_i = |lf: LazyFrame, f: Expr| lf.with_row_index("__i", None).filter(f).select([col("*").exclude(["__i"])]);
            Ok(match op["mode"].as_str().unwrap_or("top") {
                "top" => lf.limit(n as IdxSize),
                "bottom" => lf.tail(n as IdxSize),
                "range" => lf.slice(off as i64, n as IdxSize),
                "remove_top" => lf.slice(n as i64, IdxSize::MAX),
                "remove_bottom" => with_i(lf, idx().lt(len().cast(DataType::Int64) - lit(n as i64))),
                "alternate" => {
                    let (k, sk) = (op["keep"].as_i64().unwrap_or(1).max(1), op["skip"].as_i64().unwrap_or(1).max(0));
                    with_i(lf, idx().gt_eq(lit(off as i64)).and(((idx() - lit(off as i64)) % lit(k + sk)).lt(lit(k))))
                }
                "remove_blank" => {
                    let blank = names
                        .iter()
                        .map(|c| if kind_of(&s.get(c.as_str()).cloned().unwrap_or(DataType::Null)) == K::Text { col(c.as_str()).is_null().or(col(c.as_str()).eq(lit(""))) } else { col(c.as_str()).is_null() })
                        .reduce(|a, b| a.and(b))
                        .unwrap_or(lit(false));
                    lf.filter(blank.not())
                }
                m => return Err(format!("Unknown keep-rows mode {m}")),
            })
        }
        "promoteHeaders" => {
            let row = op["row"].as_u64().unwrap_or(0) as usize;
            let df = drop_errs(lf, &s).collect().s()?;
            if row >= df.height() {
                return Err(format!("Row {} does not exist (table has {} rows)", row + 1, df.height()));
            }
            let new = uniquify(df.get_columns().iter().map(|c| fmt_any(c.get(row).unwrap_or(AnyValue::Null))).collect());
            let mut body = df.slice(row as i64 + 1, usize::MAX);
            body.set_column_names(new.iter().map(|x| x.as_str())).s()?;
            Ok(body.lazy())
        }
        "fill" => {
            let cols = strs(&op["cols"]);
            need(&s, &cols)?;
            let down = op["dir"] == "down";
            Ok(lf.with_columns(cols.iter().map(|c| if down { col(c.as_str()).forward_fill(None) } else { col(c.as_str()).backward_fill(None) }).collect::<Vec<_>>()))
        }
        "replace" => {
            let cols = strs(&op["cols"]);
            need(&s, &cols)?;
            let mut ex = Vec::new();
            for c in &cols {
                let dt = dtype(&s, c)?;
                let e = col(c.as_str());
                let is_text = kind_of(&dt) == K::Text;
                if op["find"].is_null() {
                    let empty = if is_text { e.clone().is_null().or(e.clone().eq(lit(""))) } else { e.clone().is_null() };
                    match conv(&op["replace"], &dt, locale) {
                        Some(r) => ex.push(when(empty).then(r).otherwise(e).alias(c.as_str())),
                        None => ex.push(when(empty).then(conv(&op["replace"], &DataType::String, locale).unwrap()).otherwise(text_of(e, kind_of(&dt))).alias(c.as_str())),
                    }
                } else if op["wholeCell"].as_bool().unwrap_or(true) || !is_text {
                    let (f, r) = (conv(&op["find"], &dt, locale), conv(&op["replace"], &dt, locale));
                    match (f, r) {
                        (Some(f), Some(r)) => ex.push(when(e.clone().eq(f)).then(r).otherwise(e).alias(c.as_str())),
                        (None, _) => {}
                        (Some(f), None) => ex.push(when(e.clone().eq(f)).then(conv(&op["replace"], &DataType::String, locale).unwrap()).otherwise(text_of(e, kind_of(&dt))).alias(c.as_str())),
                    }
                } else {
                    let find = op["find"].as_str().map(String::from).unwrap_or_else(|| op["find"].to_string());
                    let rep = op["replace"].as_str().map(String::from).unwrap_or_else(|| if op["replace"].is_null() { String::new() } else { op["replace"].to_string() });
                    ex.push(e.str().replace_all(lit(find), lit(rep), true).alias(c.as_str()));
                }
            }
            Ok(if ex.is_empty() { lf } else { lf.with_columns(ex) })
        }
        "replaceErrors" => {
            let cols = strs(&op["cols"]);
            need(&s, &cols)?;
            let mut ex = Vec::new();
            let mut drop = Vec::new();
            for c in &cols {
                let en = err_name(c);
                if s.get(&en).is_none() {
                    continue;
                }
                let dt = dtype(&s, c)?;
                let v = conv(&op["value"], &dt, locale).unwrap_or_else(|| null_of(&dt));
                ex.push(when(col(en.as_str())).then(v).otherwise(col(c.as_str())).alias(c.as_str()));
                drop.push(en);
            }
            if ex.is_empty() {
                return Ok(lf);
            }
            let keep: Vec<String> = all_names(&s).into_iter().filter(|n| !drop.contains(n)).collect();
            Ok(select_names(lf.with_columns(ex), &keep))
        }
        "errors" => {
            let cols = { let c = strs(&op["cols"]); if c.is_empty() { names.clone() } else { c } };
            let keep = op["keep"].as_bool().unwrap_or(false);
            let any = cols.iter().filter(|c| s.get(&err_name(c)).is_some()).map(|c| col(err_name(c).as_str()).fill_null(lit(false))).reduce(|a, b| a.or(b));
            Ok(match (any, keep) {
                (Some(m), true) => lf.filter(m),
                (Some(m), false) => lf.filter(m.not()),
                (None, true) => lf.filter(lit(false)),
                (None, false) => lf,
            })
        }
        "text" => {
            let cols = strs(&op["cols"]);
            need(&s, &cols)?;
            let f = st(op, "fn");
            Ok(lf.with_columns(
                cols.iter()
                    .map(|c| {
                        let e = text_of(col(c.as_str()), kind_of(&s.get(c.as_str()).cloned().unwrap()));
                        match f.as_str() {
                            "upper" => e.str().to_uppercase(),
                            "lower" => e.str().to_lowercase(),
                            "trim" => trim(e),
                            _ => trim(e.str().replace_all(lit(r"[\x00-\x1f\x7f]"), lit(""), false).str().replace_all(lit(r"\s+"), lit(" "), false)),
                        }
                        .alias(c.as_str())
                    })
                    .collect::<Vec<_>>(),
            ))
        }
        "round" => {
            let cols = strs(&op["cols"]);
            need(&s, &cols)?;
            let d = op["digits"].as_u64().unwrap_or(0) as u32;
            Ok(lf.with_columns(
                cols.iter()
                    .filter(|c| crate::is_num(s.get(c.as_str()).unwrap()))
                    .map(|c| { let r = col(c.as_str()).cast(DataType::Float64).round(d); if d == 0 { r.cast(DataType::Int64) } else { r } }.alias(c.as_str()))
                    .collect::<Vec<_>>(),
            ))
        }
        "split" => split(lf, op, &s),
        "mergeColumns" => {
            let cols = strs(&op["cols"]);
            need(&s, &cols)?;
            if cols.len() < 2 {
                return Err("Pick at least two columns to merge".into());
            }
            let sep = st(op, "sep");
            let keep: Vec<String> = names.iter().filter(|n| !cols.contains(n)).cloned().collect();
            let name = unique_name(&st(op, "name"), &keep.iter().cloned().collect());
            let pos = cols.iter().filter_map(|c| names.iter().position(|n| n == c)).min().unwrap_or(0).min(keep.len());
            let e = concat_str(cols.iter().map(|c| text_of(col(c.as_str()), kind_of(s.get(c.as_str()).unwrap())).fill_null(lit(""))).collect::<Vec<_>>(), &sep, false);
            let mut order = keep.clone();
            order.insert(pos, name.clone());
            Ok(select_names(lf.with_column(e.alias(name.as_str())), &with_errs(&s, &order)))
        }
        "addColumn" => {
            let name = st(op, "name");
            let (mut e, k) = expr::eval(&op["expr"], &s, locale)?;
            if let Some(t) = op["castTo"].as_str() {
                let from = match k { K::Num => DataType::Float64, K::Bool => DataType::Boolean, K::Date => DataType::Date, K::Dt => ms_dt(), _ => DataType::String };
                e = cast_expr(e, &from, t, locale);
            } else if k == K::Null {
                e = e.cast(DataType::String);
            }
            Ok(lf.with_column(e.alias(name.as_str())))
        }
        "index" => {
            let name = unique_name(&st(op, "name"), &names.iter().cloned().collect());
            let (start, step) = (op["start"].as_f64().unwrap_or(0.0), op["step"].as_f64().unwrap_or(1.0));
            let e = if start.fract() == 0.0 && step.fract() == 0.0 {
                int_range(lit(0i64), len().cast(DataType::Int64), 1, DataType::Int64) * lit(step as i64) + lit(start as i64)
            } else {
                int_range(lit(0i64), len().cast(DataType::Int64), 1, DataType::Int64).cast(DataType::Float64) * lit(step) + lit(start)
            };
            let lf = lf.with_column(e.alias(name.as_str()));
            if op["first"].as_bool().unwrap_or(false) {
                let mut order = vec![name];
                order.extend(all_names(&s));
                return Ok(select_names(lf, &order));
            }
            Ok(lf)
        }
        "duplicate" => {
            let c = st(op, "col");
            dtype(&s, &c)?;
            let name = unique_name(&st(op, "name"), &names.iter().cloned().collect());
            let mut order = all_names(&s);
            let at = order.iter().position(|n| *n == c);
            place_after(&mut order, &name, at);
            Ok(select_names(lf.with_column(col(c.as_str()).alias(name.as_str())), &order))
        }
        "groupBy" => {
            let keys = strs(&op["keys"]);
            need(&s, &keys)?;
            let mut aggs = Vec::new();
            for a in op["aggs"].as_array().cloned().unwrap_or_default() {
                let name = st(&a, "name");
                let c = st(&a, "col");
                let f = st(&a, "fn");
                if f != "count_rows" {
                    dtype(&s, &c)?;
                }
                let e = col(c.as_str());
                let num = || e.clone().cast(DataType::Float64);
                let x = match f.as_str() {
                    "count_rows" => len().cast(DataType::Int64),
                    "count" => e.count().cast(DataType::Int64),
                    "count_distinct" => e.drop_nulls().n_unique().cast(DataType::Int64),
                    "sum" => if crate::is_int(s.get(c.as_str()).unwrap()) { e.sum() } else { num().sum() },
                    "mean" => num().mean(),
                    "median" => num().median(),
                    "min" => e.min(),
                    "max" => e.max(),
                    "first" => e.first(),
                    "last" => e.last(),
                    "concat" => text_of(e, kind_of(s.get(c.as_str()).unwrap())).drop_nulls().str().join(&st(&a, "sep"), true),
                    o => return Err(format!("Unknown aggregation {o}")),
                };
                aggs.push(x.alias(name.as_str()));
            }
            let lf = drop_errs(lf, &s);
            Ok(if keys.is_empty() { lf.select(aggs) } else { lf.group_by_stable(keys.iter().map(|k| col(k.as_str())).collect::<Vec<_>>()).agg(aggs) })
        }
        "unpivot" => {
            let ids = strs(&op["ids"]);
            let values = if op["values"].is_null() { names.iter().filter(|n| !ids.contains(n)).cloned().collect() } else { strs(&op["values"]) };
            let ids = if op["ids"].is_null() { names.iter().filter(|n| !values.contains(n)).cloned().collect() } else { ids };
            need(&s, &ids)?;
            need(&s, &values)?;
            let dts: HashSet<String> = values.iter().map(|v| format!("{:?}", s.get(v.as_str()).unwrap())).collect();
            let all_num = values.iter().all(|v| crate::is_num(s.get(v.as_str()).unwrap()));
            let same = dts.len() <= 1;
            let (var, val) = (st(op, "var"), st(op, "val"));
            let base = drop_errs(lf, &s).with_row_index("__r", None);
            let parts: Vec<LazyFrame> = values
                .iter()
                .enumerate()
                .map(|(j, v)| {
                    let ve = if same { col(v.as_str()) } else if all_num { col(v.as_str()).cast(DataType::Float64) } else { text_of(col(v.as_str()), kind_of(s.get(v.as_str()).unwrap())) };
                    let mut ex: Vec<Expr> = vec![col("__r"), lit(j as i64).alias("__j")];
                    ex.extend(ids.iter().map(|i| col(i.as_str())));
                    ex.push(lit(v.as_str()).alias(var.as_str()));
                    ex.push(ve.alias(val.as_str()));
                    base.clone().select(ex)
                })
                .collect();
            if parts.is_empty() {
                return Err("Choose columns to unpivot".into());
            }
            let mut out = concat(parts, UnionArgs::default()).s()?;
            if op["dropNulls"].as_bool().unwrap_or(true) {
                out = out.filter(col(val.as_str()).is_not_null());
            }
            Ok(out.sort(["__r", "__j"], SortMultipleOptions::default()).select([col("*").exclude(["__r", "__j"])]))
        }
        "pivot" => pivot(lf, op, &s),
        "join" => join(lf, op, &s, cx),
        "append" => {
            let mut lfs = vec![lf];
            for p in op["others"].as_array().cloned().unwrap_or_default() {
                lfs.push(crate::build(&p, cx)?);
            }
            if op["strict"].as_bool().unwrap_or(false) {
                let mut sets = Vec::new();
                for l in lfs.iter_mut() {
                    let mut n = visible(&schema(l)?);
                    n.sort();
                    sets.push(n);
                }
                if let Some(i) = sets.iter().position(|x| *x != sets[0]) {
                    return Err(format!("Strict append: columns differ in table {}", i + 1));
                }
            }
            concat_lf_diagonal(lfs, UnionArgs { to_supertypes: true, ..Default::default() }).s()
        }
        "window" => window(lf, op, &s),
        o => Err(format!("Unknown operation {o}")),
    }
}

fn split(mut lf: LazyFrame, op: &Value, s: &Schema) -> R<LazyFrame> {
    let c = st(op, "col");
    let dt = dtype(s, &c)?;
    let d = st(op, "delimiter");
    let tr = op["trim"].as_bool().unwrap_or(true);
    let src = text_of(col(c.as_str()), kind_of(&dt));
    let fin = |e: Expr| if tr { trim(e) } else { e };
    let mode = st(op, "mode");
    if mode == "rows" {
        return Ok(lf.with_column(src.str().split(lit(d.as_str())).alias(c.as_str())).explode([col(c.as_str())]).with_column(fin(col(c.as_str())).alias(c.as_str())));
    }
    let names = visible(s);
    let pieces: Vec<Expr> = if mode == "first" || mode == "last" {
        let esc = regex_escape(&d);
        let pat = if mode == "first" { format!("^(?s)(.*?){esc}(.*)$") } else { format!("^(?s)(.*){esc}(.*?)$") };
        vec![coalesce(&[src.clone().str().extract(lit(pat.as_str()), 1), src.clone()]), src.str().extract(lit(pat.as_str()), 2)]
    } else {
        let mut count = op["count"].as_u64().unwrap_or(0) as usize;
        if count == 0 {
            count = first_row_value(lf.clone(), src.clone().str().split(lit(d.as_str())).list().len().max().cast(DataType::Int64))?.unwrap_or(1).max(1) as usize;
        }
        let count = count.min(200);
        (0..count).map(|k| src.clone().str().split(lit(d.as_str())).list().get(lit(k as i64), true)).collect()
    };
    let mut existing: HashSet<String> = names.iter().filter(|n| **n != c).cloned().collect();
    let mut new = Vec::new();
    for k in 0..pieces.len() {
        let nm = unique_name(&format!("{c}.{}", k + 1), &existing);
        existing.insert(nm.clone());
        new.push(nm);
    }
    lf = lf.with_columns(pieces.into_iter().zip(new.iter()).map(|(e, n)| fin(e).alias(n.as_str())).collect::<Vec<_>>());
    let mut order = Vec::new();
    for n in &names {
        if *n == c {
            order.extend(new.iter().cloned());
        } else {
            order.push(n.clone());
        }
    }
    Ok(select_names(lf, &with_errs(s, &order)))
}

fn pivot(lf: LazyFrame, op: &Value, s: &Schema) -> R<LazyFrame> {
    let on = st(op, "on");
    let on_dt = dtype(s, &on)?;
    let values = op["values"].as_str().map(String::from);
    if let Some(v) = &values {
        dtype(s, v)?;
    }
    let names = visible(s);
    let index = if op["index"].is_null() { names.iter().filter(|n| **n != on && Some((*n).clone()) != values).cloned().collect() } else { strs(&op["index"]) };
    need(s, &index)?;
    let key = text_of(col(on.as_str()), kind_of(&on_dt));
    let df = lf.clone().select([key.clone().unique_stable().alias("__k")]).collect().s()?;
    let keys: Vec<Option<String>> = df.column("__k").s()?.str().s()?.into_iter().map(|x| x.map(String::from)).collect();
    if keys.len() > 500 {
        return Err(format!("Pivot would create {} columns (limit 500). Filter or group `{on}` first.", keys.len()));
    }
    let agg = st(op, "agg");
    let mut used: HashSet<String> = index.iter().cloned().collect();
    let mut aggs = Vec::new();
    for k in keys {
        let cond = match &k { Some(v) => key.clone().eq(lit(v.as_str())), None => key.clone().is_null() };
        let label = unique_name(k.as_deref().unwrap_or("null"), &used);
        used.insert(label.clone());
        let x = match &values {
            None => cond.clone().cast(DataType::Int64).sum(),
            Some(v) => {
                let e = col(v.as_str()).filter(cond.clone());
                match agg.as_str() {
                    "sum" => e.cast(DataType::Float64).sum(),
                    "mean" => e.cast(DataType::Float64).mean(),
                    "median" => e.cast(DataType::Float64).median(),
                    "count_rows" => cond.clone().cast(DataType::Int64).sum(),
                    "min" => e.min(),
                    "max" => e.max(),
                    "first" => e.first(),
                    _ => e.last(),
                }
            }
        };
        aggs.push(when(cond.any(true)).then(x).otherwise(lit(NULL)).alias(label.as_str()));
    }
    let base = drop_errs(lf, s);
    Ok(if index.is_empty() { base.select(aggs) } else { base.group_by_stable(index.iter().map(|k| col(k.as_str())).collect::<Vec<_>>()).agg(aggs) })
}

fn join(lf: LazyFrame, op: &Value, s: &Schema, cx: &mut Ctx) -> R<LazyFrame> {
    let mut right = crate::build(&op["right"], cx)?;
    let rs = schema(&mut right)?;
    let how = op["how"].as_str().unwrap_or("left").to_string();
    let on: Vec<(String, String)> = op["on"].as_array().cloned().unwrap_or_default().iter().map(|p| (p[0].as_str().unwrap_or("").to_string(), p[1].as_str().unwrap_or("").to_string())).collect();
    if how != "cross" && on.is_empty() {
        return Err("Choose at least one key column on each side".into());
    }
    let left_names = visible(s);
    for (l, r) in &on {
        dtype(s, l)?;
        dtype(&rs, r)?;
    }
    let rkeys: HashSet<String> = on.iter().map(|p| p.1.clone()).collect();
    let rvis = visible(&rs);
    let expand = if op["expand"].is_null() { rvis.iter().filter(|n| !rkeys.contains(*n)).cloned().collect() } else { strs(&op["expand"]) };
    need(&rs, &expand)?;
    let prefix = st(op, "prefix");
    let mut existing: HashSet<String> = left_names.iter().cloned().collect();
    let mut out_names = Vec::new();
    let mut rsel: Vec<Expr> = vec![col("__rr")];
    for (i, (_, r)) in on.iter().enumerate() {
        let e = if op["castKeys"].as_bool().unwrap_or(false) { text_of(col(r.as_str()), kind_of(rs.get(r.as_str()).unwrap())) } else { col(r.as_str()) };
        rsel.push(e.alias(format!("__rk{i}").as_str()));
    }
    for c in &expand {
        let nm = unique_name(&if prefix.is_empty() { c.clone() } else { format!("{prefix}.{c}") }, &existing);
        existing.insert(nm.clone());
        rsel.push(col(c.as_str()).alias(nm.as_str()));
        out_names.push(nm);
    }
    let right = right.with_row_index("__rr", None).select(rsel);
    let left = drop_errs(lf, s).with_row_index("__lr", None);
    let joined = if how == "cross" {
        left.cross_join(right, None)
    } else {
        let lk: Vec<Expr> = on.iter().map(|(l, _)| if op["castKeys"].as_bool().unwrap_or(false) { text_of(col(l.as_str()), kind_of(s.get(l.as_str()).unwrap())) } else { col(l.as_str()) }).collect();
        let rk: Vec<Expr> = (0..on.len()).map(|i| col(format!("__rk{i}").as_str())).collect();
        let jt = match how.as_str() {
            "inner" => JoinType::Inner,
            "right" => JoinType::Right,
            "full" => JoinType::Full,
            "semi" => JoinType::Semi,
            "anti" => JoinType::Anti,
            _ => JoinType::Left,
        };
        left.join(right, lk, rk, JoinArgs::new(jt).with_coalesce(JoinCoalesce::KeepColumns))
    };
    let mut sel: Vec<Expr> = Vec::new();
    for n in &left_names {
        let key = on.iter().position(|(l, _)| l == n);
        match (key, how.as_str()) {
            (Some(i), "right" | "full") => sel.push(coalesce(&[col(n.as_str()), col(format!("__rk{i}").as_str()).cast(s.get(n.as_str()).unwrap().clone())]).alias(n.as_str())),
            _ => sel.push(col(n.as_str())),
        }
    }
    if how != "semi" && how != "anti" {
        sel.extend(out_names.iter().map(|n| col(n.as_str())));
    }
    let order: Vec<&str> = if how == "semi" || how == "anti" { vec!["__lr"] } else { vec!["__lr", "__rr"] };
    Ok(joined.sort(order, SortMultipleOptions::default().with_nulls_last(true).with_maintain_order(true)).select(sel))
}

fn window(lf: LazyFrame, op: &Value, s: &Schema) -> R<LazyFrame> {
    let f = st(op, "fn");
    let c = st(op, "col");
    let part = strs(&op["partition"]);
    need(s, &part)?;
    if f != "row_number" {
        dtype(s, &c)?;
    }
    let n = op["n"].as_i64().unwrap_or(1).max(1);
    let x = || col(c.as_str());
    let num = || x().cast(DataType::Float64);
    let mut e = match f.as_str() {
        "cumsum" => num().fill_null(lit(0.0)).cum_sum(false),
        "row_number" => int_range(lit(1i64), len().cast(DataType::Int64) + lit(1i64), 1, DataType::Int64),
        "rank" => x().rank(RankOptions { method: RankMethod::Min, descending: true }, None).cast(DataType::Int64),
        "lag" => x().shift(lit(n)),
        "lead" => x().shift(lit(-n)),
        "pct_of_total" => { let t = num().sum(); when(t.clone().eq(lit(0.0))).then(lit(NULL).cast(DataType::Float64)).otherwise(num() / t) }
        "moving_avg" => {
            let n = n.min(500);
            let sum = (0..n).map(|k| num().shift(lit(k)).fill_null(lit(0.0))).reduce(|a, b| a + b).unwrap();
            let cnt = (0..n).map(|k| num().shift(lit(k)).is_not_null().cast(DataType::Float64)).reduce(|a, b| a + b).unwrap();
            when(cnt.clone().eq(lit(0.0))).then(lit(NULL).cast(DataType::Float64)).otherwise(sum / cnt)
        }
        o => return Err(format!("Unknown window operation {o}")),
    };
    if !part.is_empty() {
        e = e.over(part.iter().map(|p| col(p.as_str())).collect::<Vec<_>>());
    }
    let name = unique_name(&st(op, "name"), &visible(s).into_iter().collect());
    let mut lf = lf.with_row_index("__i", None);
    if let Some(ob) = op["orderBy"].as_str() {
        dtype(s, ob)?;
        lf = lf.sort([ob], SortMultipleOptions::default().with_order_descending(op["desc"].as_bool().unwrap_or(false)).with_nulls_last(true).with_maintain_order(true));
    }
    Ok(lf.with_column(e.alias(name.as_str())).sort(["__i"], SortMultipleOptions::default()).select([col("*").exclude(["__i"])]))
}
