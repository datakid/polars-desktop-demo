use crate::R;
use polars::prelude::*;
use serde_json::Value;
use std::collections::HashMap;

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum K {
    Num,
    Text,
    Bool,
    Date,
    Dt,
    Any,
    Null,
}

pub fn kind_of(dt: &DataType) -> K {
    match dt {
        DataType::Boolean => K::Bool,
        DataType::String => K::Text,
        DataType::Date => K::Date,
        DataType::Datetime(_, _) => K::Dt,
        DataType::Null => K::Null,
        d if crate::is_num(d) => K::Num,
        _ => K::Any,
    }
}

pub struct Cx<'a> {
    pub types: &'a HashMap<String, DataType>,
    pub locale: &'a str,
}

const DAY_MS: i64 = 86_400_000;

fn opts(fmt: &str) -> StrptimeOptions {
    StrptimeOptions { format: Some(fmt.into()), strict: false, exact: true, cache: true }
}

pub fn trim(e: Expr) -> Expr {
    e.str().replace_all(lit(r"^[\s\u00a0]+|[\s\u00a0]+$"), lit(""), false)
}

pub fn dmy(locale: &str) -> bool {
    matches!(locale, "en-GB" | "de-DE" | "fr-FR")
}

pub fn comma_decimal(locale: &str) -> bool {
    matches!(locale, "de-DE" | "fr-FR")
}

pub fn num_from_text(e: Expr, locale: &str) -> Expr {
    let s = trim(e);
    let neg = s.clone().str().contains(lit(r"^\(.*\)$"), false);
    let pct = s.clone().str().ends_with(lit("%"));
    let mut t = s.str().replace_all(lit(r"[()%$€£¥\s\u00a0]"), lit(""), false);
    if comma_decimal(locale) {
        t = t.str().replace_all(lit("."), lit(""), true).str().replace_all(lit(","), lit("."), true);
    } else {
        t = t.str().replace_all(lit(","), lit(""), true);
    }
    let t = when(t.clone().str().contains(lit(r"^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$"), false))
        .then(t)
        .otherwise(lit(NULL).cast(DataType::String));
    let x = t.cast(DataType::Float64);
    let x = when(neg).then(lit(0.0) - x.clone()).otherwise(x);
    when(pct).then(x.clone() / lit(100.0)).otherwise(x)
}

pub fn date_formats(locale: &str) -> Vec<&'static str> {
    let mut f = vec!["%Y-%m-%d", "%Y/%m/%d", "%Y.%m.%d"];
    if dmy(locale) {
        f.extend(["%d/%m/%Y", "%d.%m.%Y", "%d-%m-%Y", "%d/%m/%y", "%d.%m.%y"]);
    } else {
        f.extend(["%m/%d/%Y", "%m-%d-%Y", "%m.%d.%Y", "%m/%d/%y"]);
    }
    f.extend(["%d %b %Y", "%d-%b-%Y", "%b %d, %Y", "%B %d, %Y", "%d %B %Y"]);
    f
}

pub fn date_from_text(e: Expr, locale: &str) -> Expr {
    let s = trim(e);
    let s10 = s.clone().str().replace_all(lit(r"[ T]\d{1,2}:\d{2}(:\d{2})?.*$"), lit(""), false);
    let parts: Vec<Expr> = date_formats(locale).into_iter().map(|f| s10.clone().str().to_date(opts(f))).collect();
    coalesce(&parts)
}

pub fn dt_from_text(e: Expr, locale: &str) -> Expr {
    let s = trim(e);
    let ms = DataType::Datetime(TimeUnit::Milliseconds, None);
    let mut parts: Vec<Expr> = ["%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M"]
        .into_iter()
        .map(|f| s.clone().str().to_datetime(Some(TimeUnit::Milliseconds), None, opts(f), lit("raise")))
        .collect();
    parts.push(date_from_text(s, locale).cast(ms));
    coalesce(&parts)
}

pub fn bool_from_text(e: Expr) -> Expr {
    let s = trim(e).str().to_lowercase();
    let any = |words: &[&str]| words.iter().map(|w| s.clone().eq(lit(*w))).reduce(|a, b| a.or(b)).unwrap();
    when(any(&["true", "yes", "y", "1", "wahr", "vrai"]))
        .then(lit(true))
        .when(any(&["false", "no", "n", "0", "falsch", "faux"]))
        .then(lit(false))
        .otherwise(lit(NULL).cast(DataType::Boolean))
}

pub fn text_of(e: Expr, k: K) -> Expr {
    match k {
        K::Date => e.dt().strftime("%Y-%m-%d"),
        K::Dt => e.dt().strftime("%Y-%m-%d %H:%M:%S"),
        K::Text => e,
        _ => e.cast(DataType::String),
    }
}

fn num_of(e: Expr, k: K, locale: &str) -> Expr {
    match k {
        K::Text | K::Any => num_from_text(e.cast(DataType::String), locale),
        K::Bool => e.cast(DataType::Float64),
        _ => e,
    }
}

fn date_of(e: Expr, k: K, locale: &str) -> (Expr, K) {
    match k {
        K::Date | K::Dt => (e, k),
        _ => (date_from_text(e.cast(DataType::String), locale), K::Date),
    }
}

pub fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

pub fn parse_iso(s: &str) -> Option<(i64, bool)> {
    let s = s.trim();
    let b = s.as_bytes();
    if b.len() < 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let y: i64 = s[0..4].parse().ok()?;
    let m: i64 = s[5..7].parse().ok()?;
    let d: i64 = s[8..10].parse().ok()?;
    let days = days_from_civil(y, m, d);
    if b.len() >= 16 {
        let h: i64 = s[11..13].parse().ok()?;
        let mi: i64 = s[14..16].parse().ok()?;
        let sec: i64 = if b.len() >= 19 { s[17..19].parse().ok()? } else { 0 };
        return Some((days * DAY_MS + (h * 3600 + mi * 60 + sec) * 1000, true));
    }
    Some((days, false))
}

fn date_lit(days: i64) -> Expr {
    lit(days as i32).cast(DataType::Date)
}
fn dt_lit(ms: i64) -> Expr {
    lit(ms).cast(DataType::Datetime(TimeUnit::Milliseconds, None))
}

pub fn lit_of(v: &Value) -> (Expr, K) {
    match v {
        Value::Null => (lit(NULL), K::Null),
        Value::Bool(b) => (lit(*b), K::Bool),
        Value::Number(n) => {
            let f = n.as_f64().unwrap_or(0.0);
            if f.fract() == 0.0 && f.abs() < 9.0e15 {
                (lit(f as i64), K::Num)
            } else {
                (lit(f), K::Num)
            }
        }
        Value::String(s) => (lit(s.as_str()), K::Text),
        Value::Object(o) => {
            let ms = o.get("d").and_then(|x| x.as_f64()).unwrap_or(0.0) as i64;
            if ms % DAY_MS == 0 {
                (date_lit(ms / DAY_MS), K::Date)
            } else {
                (dt_lit(ms), K::Dt)
            }
        }
        _ => (lit(NULL), K::Null),
    }
}

fn s(n: &Value, k: &str) -> String {
    n[k].as_str().unwrap_or("").to_string()
}

fn int_arg(n: &Value, i: usize, what: &str) -> R<i64> {
    let a = &n["args"][i];
    if a["k"] == "lit" {
        if let Some(f) = a["v"].as_f64() {
            return Ok(f as i64);
        }
    }
    Err(format!("{what} needs a fixed number in Polars"))
}

type Arg = (Expr, K, Option<String>);

fn with_raw(n: &Value, cx: &Cx) -> R<Arg> {
    let (e, k) = compile(n, cx)?;
    let raw = if n["k"] == "lit" { n["v"].as_str().map(String::from) } else { None };
    Ok((e, k, raw))
}

fn list_items(n: &Value, cx: &Cx) -> R<Vec<Arg>> {
    if n["k"] != "list" {
        return Err("Expected a list like {\"A\", \"B\"}".into());
    }
    n["items"].as_array().cloned().unwrap_or_default().iter().map(|x| with_raw(x, cx)).collect()
}

fn in_list(x: Arg, items: Vec<Arg>, cx: &Cx) -> Expr {
    items
        .into_iter()
        .map(|it| compare("=", x.clone(), it, cx))
        .reduce(|a, b| a.or(b))
        .unwrap_or(lit(false))
}

fn compare(op: &str, a: Arg, b: Arg, cx: &Cx) -> Expr {
    let (mut ea, ka, ra) = a;
    let (mut eb, kb, rb) = b;
    if ka == K::Null || kb == K::Null {
        let other = if ka == K::Null { eb } else { ea };
        return match op {
            "=" => other.is_null(),
            "<>" => other.is_not_null(),
            _ => lit(NULL).cast(DataType::Boolean),
        };
    }
    let fix_date = |raw: &Option<String>, kd: K| -> Option<Expr> {
        let (v, is_dt) = parse_iso(raw.as_deref()?)?;
        Some(match (kd, is_dt) {
            (K::Date, false) => date_lit(v),
            (K::Date, true) => date_lit(v.div_euclid(DAY_MS)),
            (_, false) => dt_lit(v * DAY_MS),
            (_, true) => dt_lit(v),
        })
    };
    let (mut ka2, mut kb2) = (ka, kb);
    if matches!(ka, K::Date | K::Dt) && kb == K::Text {
        if let Some(x) = fix_date(&rb, ka) {
            eb = x;
            kb2 = ka;
        }
    } else if matches!(kb, K::Date | K::Dt) && ka == K::Text {
        if let Some(x) = fix_date(&ra, kb) {
            ea = x;
            ka2 = kb;
        }
    }
    if ka2 == K::Num && kb2 == K::Text {
        eb = num_from_text(eb, cx.locale);
        kb2 = K::Num;
    } else if kb2 == K::Num && ka2 == K::Text {
        ea = num_from_text(ea, cx.locale);
        ka2 = K::Num;
    }
    if ka2 == K::Date && kb2 == K::Dt {
        ea = ea.cast(DataType::Datetime(TimeUnit::Milliseconds, None));
    } else if ka2 == K::Dt && kb2 == K::Date {
        eb = eb.cast(DataType::Datetime(TimeUnit::Milliseconds, None));
    } else if ka2 != kb2 && ka2 != K::Any && kb2 != K::Any {
        ea = text_of(ea, ka2);
        eb = text_of(eb, kb2);
    }
    match op {
        "=" => ea.eq(eb),
        "<>" => ea.neq(eb),
        "<" => ea.lt(eb),
        ">" => ea.gt(eb),
        "<=" => ea.lt_eq(eb),
        _ => ea.gt_eq(eb),
    }
}

fn bin(n: &Value, cx: &Cx) -> R<(Expr, K)> {
    let op = s(n, "op");
    if op == "in" {
        let x = with_raw(&n["a"], cx)?;
        let items = list_items(&n["b"], cx)?;
        return Ok((in_list(x, items, cx), K::Bool));
    }
    if matches!(op.as_str(), "=" | "<>" | "<" | ">" | "<=" | ">=") {
        return Ok((compare(&op, with_raw(&n["a"], cx)?, with_raw(&n["b"], cx)?, cx), K::Bool));
    }
    let a = compile(&n["a"], cx)?;
    let b = compile(&n["b"], cx)?;
    Ok(match op.as_str() {
        "and" => (a.0.and(b.0), K::Bool),
        "or" => (a.0.or(b.0), K::Bool),
        "&" => {
            let both_null = a.0.clone().is_null().and(b.0.clone().is_null());
            let e = concat_str([text_of(a.0, a.1), text_of(b.0, b.1)], "", true);
            (when(both_null).then(lit(NULL).cast(DataType::String)).otherwise(e), K::Text)
        }
        "+" | "-" if matches!(a.1, K::Date | K::Dt) && b.1 != K::Date && b.1 != K::Dt => {
            let days = num_of(b.0, b.1, cx.locale);
            let sign = if op == "+" { 1.0 } else { -1.0 };
            let ms = a.0.cast(DataType::Datetime(TimeUnit::Milliseconds, None)).cast(DataType::Int64).cast(DataType::Float64)
                + days * lit(sign * DAY_MS as f64);
            let out = ms.cast(DataType::Int64).cast(DataType::Datetime(TimeUnit::Milliseconds, None));
            if a.1 == K::Date {
                (out.cast(DataType::Date), K::Date)
            } else {
                (out, K::Dt)
            }
        }
        "-" if matches!(a.1, K::Date | K::Dt) && matches!(b.1, K::Date | K::Dt) => {
            let to_ms = |e: Expr| e.cast(DataType::Datetime(TimeUnit::Milliseconds, None)).cast(DataType::Int64).cast(DataType::Float64);
            (((to_ms(a.0) - to_ms(b.0)) / lit(DAY_MS as f64)).round(0).cast(DataType::Int64), K::Num)
        }
        _ => {
            let x = num_of(a.0, a.1, cx.locale);
            let y = num_of(b.0, b.1, cx.locale);
            match op.as_str() {
                "+" => (x + y, K::Num),
                "-" => (x - y, K::Num),
                "*" => (x * y, K::Num),
                "/" => {
                    let yf = y.cast(DataType::Float64);
                    (when(yf.clone().eq(lit(0.0))).then(lit(NULL).cast(DataType::Float64)).otherwise(x.cast(DataType::Float64) / yf), K::Num)
                }
                o => return Err(format!("Operator {o} isn't supported by Polars")),
            }
        }
    })
}

fn unify(a: (Expr, K), b: (Expr, K)) -> (Expr, Expr, K) {
    if a.1 == b.1 || b.1 == K::Null {
        return (a.0, b.0, a.1);
    }
    if a.1 == K::Null {
        return (a.0, b.0, b.1);
    }
    if matches!(a.1, K::Num | K::Bool) && matches!(b.1, K::Num | K::Bool) {
        return (a.0.cast(DataType::Float64), b.0.cast(DataType::Float64), K::Num);
    }
    (text_of(a.0, a.1), text_of(b.0, b.1), K::Text)
}

pub fn compile(n: &Value, cx: &Cx) -> R<(Expr, K)> {
    match n["k"].as_str().unwrap_or("") {
        "lit" => Ok(lit_of(&n["v"])),
        "col" => {
            let name = s(n, "name");
            let dt = cx.types.get(&name).ok_or_else(|| format!("Column `{name}` not found"))?;
            Ok((col(name.as_str()), kind_of(dt)))
        }
        "list" => Err("A list can only be used with `in` or List.Contains".into()),
        "un" => {
            let (e, k) = compile(&n["a"], cx)?;
            if s(n, "op") == "not" {
                Ok((e.not(), K::Bool))
            } else {
                Ok((lit(0) - num_of(e, k, cx.locale), K::Num))
            }
        }
        "if" => {
            let (c, _) = compile(&n["c"], cx)?;
            let (a, b, k) = unify(compile(&n["a"], cx)?, compile(&n["b"], cx)?);
            Ok((when(c).then(a).otherwise(b), k))
        }
        "try" => {
            let (a, b, k) = unify(compile(&n["a"], cx)?, compile(&n["b"], cx)?);
            Ok((coalesce(&[a, b]), k))
        }
        "bin" => bin(n, cx),
        "call" => call(n, cx),
        k => Err(format!("Unsupported formula node {k}")),
    }
}

fn call(n: &Value, cx: &Cx) -> R<(Expr, K)> {
    let f = s(n, "fn");
    let raw = n["args"].as_array().cloned().unwrap_or_default();
    let arg = |i: usize| -> R<(Expr, K)> { raw.get(i).map(|x| compile(x, cx)).unwrap_or(Ok((lit(NULL), K::Null))) };
    let t = |i: usize| -> R<Expr> { arg(i).map(|(e, k)| text_of(e, k)) };
    let num = |i: usize| -> R<Expr> { arg(i).map(|(e, k)| num_of(e, k, cx.locale)) };
    let date = |i: usize| -> R<(Expr, K)> { arg(i).map(|(e, k)| date_of(e, k, cx.locale)) };
    let i64e = |e: Expr| e.cast(DataType::Int64);
    Ok(match f.as_str() {
        "Text.Upper" => (t(0)?.str().to_uppercase(), K::Text),
        "Text.Lower" => (t(0)?.str().to_lowercase(), K::Text),
        "Text.Trim" => (trim(t(0)?), K::Text),
        "Text.Length" => (i64e(t(0)?.str().len_chars()), K::Num),
        "Text.Start" => (t(0)?.str().slice(lit(0i64), num(1)?.cast(DataType::UInt64)), K::Text),
        "Text.End" => (t(0)?.str().tail(num(1)?.cast(DataType::Int64)), K::Text),
        "Text.Middle" => {
            let len = if raw.len() > 2 { num(2)?.cast(DataType::UInt64) } else { lit(NULL).cast(DataType::UInt64) };
            (t(0)?.str().slice(num(1)?.cast(DataType::Int64), len), K::Text)
        }
        "Text.Contains" => (t(0)?.str().contains_literal(t(1)?), K::Bool),
        "Text.StartsWith" => (t(0)?.str().starts_with(t(1)?), K::Bool),
        "Text.EndsWith" => (t(0)?.str().ends_with(t(1)?), K::Bool),
        "Text.Replace" => (t(0)?.str().replace_all(t(1)?, t(2)?, true), K::Text),
        "Text.From" => (t(0)?, K::Text),
        "Text.Combine" => {
            let parts: R<Vec<Expr>> = (0..raw.len()).map(t).collect();
            (concat_str(parts?, "", true), K::Text)
        }
        "Text.PadStart" | "Text.PadEnd" => {
            let width = int_arg(n, 1, &f)?.max(0) as usize;
            let fill = if raw.len() > 2 {
                raw[2]["v"].as_str().and_then(|x| x.chars().next()).ok_or_else(|| format!("{f} needs a fixed pad character in Polars"))?
            } else {
                ' '
            };
            let e = t(0)?;
            (if f == "Text.PadStart" { e.str().pad_start(width, fill) } else { e.str().pad_end(width, fill) }, K::Text)
        }
        "Text.RegexMatch" => (t(0)?.str().contains(t(1)?, false), K::Bool),
        "Text.RegexReplace" => (t(0)?.str().replace_all(t(1)?, t(2)?, false), K::Text),
        "Number.Round" => {
            let d = if raw.len() > 1 { int_arg(n, 1, &f)?.max(0) as u32 } else { 0 };
            (num(0)?.cast(DataType::Float64).round(d), K::Num)
        }
        "Number.RoundUp" => (i64e(num(0)?.cast(DataType::Float64).ceil()), K::Num),
        "Number.RoundDown" => (i64e(num(0)?.cast(DataType::Float64).floor()), K::Num),
        "Number.Abs" => (num(0)?.abs(), K::Num),
        "Number.Mod" => {
            let (x, y) = (num(0)?.cast(DataType::Float64), num(1)?.cast(DataType::Float64));
            let m = ((x % y.clone()) + y.clone()) % y.clone();
            (when(y.eq(lit(0.0))).then(lit(NULL).cast(DataType::Float64)).otherwise(m), K::Num)
        }
        "Number.Power" => (num(0)?.cast(DataType::Float64).pow(num(1)?.cast(DataType::Float64)), K::Num),
        "Number.Sqrt" => {
            let x = num(0)?.cast(DataType::Float64);
            (when(x.clone().lt(lit(0.0))).then(lit(NULL).cast(DataType::Float64)).otherwise(x.sqrt()), K::Num)
        }
        "Number.From" => {
            let (e, k) = arg(0)?;
            (if matches!(k, K::Date | K::Dt) { e.cast(DataType::Float64) } else { num_of(e, k, "en-US").cast(DataType::Float64) }, K::Num)
        }
        "Date.Year" => (i64e(date(0)?.0.dt().year()), K::Num),
        "Date.Month" => (i64e(date(0)?.0.dt().month()), K::Num),
        "Date.Day" => (i64e(date(0)?.0.dt().day()), K::Num),
        "Date.Quarter" => (i64e(date(0)?.0.dt().quarter()), K::Num),
        "Date.DayOfWeek" => (i64e(date(0)?.0.dt().weekday()), K::Num),
        "Date.AddDays" => {
            let (d, k) = date(0)?;
            let days = num(1)?;
            let ms = d.cast(DataType::Datetime(TimeUnit::Milliseconds, None)).cast(DataType::Int64).cast(DataType::Float64) + days * lit(DAY_MS as f64);
            let out = ms.cast(DataType::Int64).cast(DataType::Datetime(TimeUnit::Milliseconds, None));
            if k == K::Date { (out.cast(DataType::Date), K::Date) } else { (out, K::Dt) }
        }
        "#date" => {
            let (y, m, d) = (int_arg(n, 0, "#date")?, int_arg(n, 1, "#date")?, int_arg(n, 2, "#date")?);
            (date_lit(days_from_civil(y, m, d)), K::Date)
        }
        "Coalesce" => {
            let items: R<Vec<(Expr, K)>> = (0..raw.len()).map(arg).collect();
            let items = items?;
            let k = items.iter().map(|x| x.1).find(|k| *k != K::Null).unwrap_or(K::Null);
            let mixed = items.iter().any(|x| x.1 != k && x.1 != K::Null);
            let exprs: Vec<Expr> = items.into_iter().map(|(e, kk)| if mixed { text_of(e, kk) } else { e }).collect();
            (coalesce(&exprs), if mixed { K::Text } else { k })
        }
        "Value.IsNull" => (arg(0)?.0.is_null(), K::Bool),
        "List.Contains" => {
            let items = list_items(&raw[0], cx)?;
            (in_list(with_raw(&raw[1], cx)?, items, cx), K::Bool)
        }
        other => return Err(format!("Formula function {other} isn't supported by Polars yet")),
    })
}

pub fn schema_map(schema: &Schema) -> HashMap<String, DataType> {
    schema.iter().map(|(n, d)| (n.to_string(), d.clone())).collect()
}

pub fn eval(expr: &Value, schema: &Schema, locale: &str) -> R<(Expr, K)> {
    let types = schema_map(schema);
    let cx = Cx { types: &types, locale };
    compile(expr, &cx)
}
