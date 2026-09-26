//! PQX formula language → Polars `Expr`.
//!
//! ```text
//! if [Sales] > 1000 and [Region] = "EU" then "Key" else "Other"
//! Text.Upper([Name]) & " " & Text.From(Date.Year([OrderDate]))
//! [Region] in {"EU", "US"}        try Number.From([x]) otherwise 0        [Date] >= @StartDate
//! ```
//! A hand-written Pratt parser (same grammar and precedence as `js/expr.js`, which is the
//! executable spec) produces a spanned AST; `check` type-checks it against the input schema with
//! character positions so the editor can underline the exact spot; `lower` emits a Polars Expr.
//! Planned: port the grammar to `chumsky` for better error recovery.

use pq_model::{Param, ParamKind};
use polars::prelude::*;

#[derive(Debug, Clone, thiserror::Error)]
#[error("{message}")]
pub struct FormulaError { pub message: String, pub start: usize, pub end: usize, pub hint: Option<String> }
fn err<T>(message: impl Into<String>, start: usize, end: usize, hint: Option<String>) -> Result<T, FormulaError> { Err(FormulaError { message: message.into(), start, end, hint }) }

#[derive(Debug, Clone, PartialEq)]
enum Tok { Num(f64), Str(String), Col(String), Param(String), Ident(String), Kw(&'static str), Op(&'static str), Eof }

const KWS: [&str; 12] = ["if", "then", "else", "and", "or", "not", "true", "false", "null", "try", "otherwise", "in"];
const OPS: [&str; 16] = ["<>", "<=", ">=", "+", "-", "*", "/", "&", "=", "<", ">", "(", ")", ",", "{", "}"];

fn lex(src: &str) -> Result<Vec<(Tok, usize, usize)>, FormulaError> {
    let b: Vec<char> = src.chars().collect();
    let mut i = 0; let mut out = vec![];
    while i < b.len() {
        let c = b[i];
        if c.is_whitespace() { i += 1; continue; }
        let s = i;
        if c == '[' {
            let mut name = String::new(); i += 1;
            loop {
                if i >= b.len() { return err("Unclosed column reference — add \"]\"", s, b.len(), None); }
                if b[i] == ']' { if b.get(i + 1) == Some(&']') { name.push(']'); i += 2; continue; } break; }
                name.push(b[i]); i += 1;
            }
            i += 1; out.push((Tok::Col(name.trim().to_string()), s, i)); continue;
        }
        if c == '"' {
            let mut v = String::new(); i += 1;
            loop {
                if i >= b.len() { return err("Unclosed text — add a closing quote", s, b.len(), None); }
                if b[i] == '"' { if b.get(i + 1) == Some(&'"') { v.push('"'); i += 2; continue; } break; }
                v.push(b[i]); i += 1;
            }
            i += 1; out.push((Tok::Str(v), s, i)); continue;
        }
        if c.is_ascii_digit() || (c == '.' && b.get(i + 1).is_some_and(|d| d.is_ascii_digit())) {
            while i < b.len() && (b[i].is_ascii_digit() || b[i] == '.' || ((b[i] == 'e' || b[i] == 'E') && i > s)) { i += 1; }
            let t: String = b[s..i].iter().collect();
            out.push((Tok::Num(t.parse().map_err(|_| FormulaError { message: format!("Bad number {t}"), start: s, end: i, hint: None })?), s, i)); continue;
        }
        if c == '@' || c == '#' || c.is_alphabetic() || c == '_' {
            i += 1;
            while i < b.len() && (b[i].is_alphanumeric() || b[i] == '_' || b[i] == '.') { i += 1; }
            let w: String = b[s..i].iter().collect();
            if let Some(p) = w.strip_prefix('@') { out.push((Tok::Param(p.into()), s, i)); }
            else if let Some(k) = KWS.iter().find(|k| k.eq_ignore_ascii_case(&w)) { out.push((Tok::Kw(k), s, i)); }
            else { out.push((Tok::Ident(w), s, i)); }
            continue;
        }
        let rest: String = b[i..(i + 2).min(b.len())].iter().collect();
        if let Some(op) = OPS.iter().find(|o| rest.starts_with(**o)) { i += op.len(); out.push((Tok::Op(op), s, i)); continue; }
        return err(format!("Unexpected character \"{c}\""), s, s + 1, None);
    }
    out.push((Tok::Eof, b.len(), b.len()));
    Ok(out)
}

#[derive(Debug, Clone)]
pub enum Ast {
    Lit(LitV), Col(String), Param(String), List(Vec<Node>),
    Un(&'static str, Box<Node>), Bin(&'static str, Box<Node>, Box<Node>),
    If(Box<Node>, Box<Node>, Box<Node>), Try(Box<Node>, Box<Node>), Call(String, Vec<Node>),
}
#[derive(Debug, Clone)]
pub enum LitV { Num(f64), Str(String), Bool(bool), Null }
#[derive(Debug, Clone)]
pub struct Node { pub ast: Ast, pub start: usize, pub end: usize }

fn prec(t: &Tok) -> u8 {
    match t { Tok::Kw("or") => 1, Tok::Kw("and") => 2, Tok::Op("=" | "<>" | "<" | ">" | "<=" | ">=") | Tok::Kw("in") => 4, Tok::Op("+" | "-" | "&") => 5, Tok::Op("*" | "/") => 6, _ => 0 }
}

pub fn parse(src: &str) -> Result<Node, FormulaError> {
    let toks = lex(src)?;
    let mut p = 0usize;
    fn expect(toks: &[(Tok, usize, usize)], p: &mut usize, t: Tok, what: &str) -> Result<usize, FormulaError> {
        let (tk, s, e) = &toks[*p];
        if *tk == t { *p += 1; Ok(*e) } else { err(format!("Expected {what}"), *s, (*e).max(s + 1), None) }
    }
    fn primary(toks: &[(Tok, usize, usize)], p: &mut usize) -> Result<Node, FormulaError> {
        let (t, s, e) = toks[*p].clone(); *p += 1;
        let n = |ast, end| Ok(Node { ast, start: s, end });
        match t {
            Tok::Num(v) => n(Ast::Lit(LitV::Num(v)), e),
            Tok::Str(v) => n(Ast::Lit(LitV::Str(v)), e),
            Tok::Col(c) => n(Ast::Col(c), e),
            Tok::Param(c) => n(Ast::Param(c), e),
            Tok::Kw("true") => n(Ast::Lit(LitV::Bool(true)), e),
            Tok::Kw("false") => n(Ast::Lit(LitV::Bool(false)), e),
            Tok::Kw("null") => n(Ast::Lit(LitV::Null), e),
            Tok::Kw("not") => { let a = expr(toks, p, 3)?; let end = a.end; n(Ast::Un("not", Box::new(a)), end) }
            Tok::Op("-") => { let a = expr(toks, p, 7)?; let end = a.end; n(Ast::Un("-", Box::new(a)), end) }
            Tok::Op("(") => { let a = expr(toks, p, 0)?; expect(toks, p, Tok::Op(")"), "a closing \")\"")?; Ok(a) }
            Tok::Op("{") => { let mut items = vec![]; if toks[*p].0 != Tok::Op("}") { loop { items.push(expr(toks, p, 0)?); if toks[*p].0 == Tok::Op(",") { *p += 1 } else { break } } } let end = expect(toks, p, Tok::Op("}"), "a closing \"}\"")?; n(Ast::List(items), end) }
            Tok::Kw("if") => {
                let c = expr(toks, p, 0)?; expect(toks, p, Tok::Kw("then"), "\"then\"")?;
                let a = expr(toks, p, 0)?; expect(toks, p, Tok::Kw("else"), "\"else\" (every if needs an else)")?;
                let b = expr(toks, p, 0)?; let end = b.end;
                n(Ast::If(Box::new(c), Box::new(a), Box::new(b)), end)
            }
            Tok::Kw("try") => {
                let a = expr(toks, p, 0)?;
                let b = if toks[*p].0 == Tok::Kw("otherwise") { *p += 1; expr(toks, p, 0)? } else { Node { ast: Ast::Lit(LitV::Null), start: a.end, end: a.end } };
                let end = b.end; n(Ast::Try(Box::new(a), Box::new(b)), end)
            }
            Tok::Ident(f) => {
                if toks[*p].0 != Tok::Op("(") { return err(format!("Unknown name \"{f}\""), s, e, Some(format!("Column names go in square brackets: [{f}]"))); }
                *p += 1; let mut args = vec![];
                if toks[*p].0 != Tok::Op(")") { loop { args.push(expr(toks, p, 0)?); if toks[*p].0 == Tok::Op(",") { *p += 1 } else { break } } }
                let end = expect(toks, p, Tok::Op(")"), &format!("a closing \")\" for {f}"))?;
                n(Ast::Call(f, args), end)
            }
            Tok::Eof => err("The formula is incomplete", s, s + 1, None),
            other => err(format!("Unexpected {other:?}"), s, e, None),
        }
    }
    fn expr(toks: &[(Tok, usize, usize)], p: &mut usize, min: u8) -> Result<Node, FormulaError> {
        let mut left = primary(toks, p)?;
        loop {
            let t = toks[*p].0.clone();
            let pr = prec(&t);
            if pr == 0 || pr <= min { break; }
            *p += 1;
            let right = expr(toks, p, pr)?;
            let op = match t { Tok::Op(o) => o, Tok::Kw(k) => k, _ => unreachable!() };
            let (s, e) = (left.start, right.end);
            left = Node { ast: Ast::Bin(op, Box::new(left), Box::new(right)), start: s, end: e };
        }
        Ok(left)
    }
    let n = expr(&toks, &mut p, 0)?;
    if toks[p].0 != Tok::Eof { let (_, s, e) = &toks[p]; return err("Unexpected token — did you forget an operator such as \"and\" or \"&\"?", *s, *e, None); }
    Ok(n)
}

/// Parse + type-check + lower to a Polars expression.
pub fn compile(src: &str, schema: &Schema, params: &[Param]) -> Result<Expr, FormulaError> {
    let ast = parse(src)?;
    lower(&ast, schema, params)
}

fn lower(n: &Node, schema: &Schema, params: &[Param]) -> Result<Expr, FormulaError> {
    let go = |x: &Node| lower(x, schema, params);
    Ok(match &n.ast {
        Ast::Lit(LitV::Num(v)) => if v.fract() == 0.0 && v.abs() < 9e15 { lit(*v as i64) } else { lit(*v) },
        Ast::Lit(LitV::Str(s)) => lit(s.clone()),
        Ast::Lit(LitV::Bool(b)) => lit(*b),
        Ast::Lit(LitV::Null) => lit(NULL),
        Ast::Col(c) => {
            if schema.get(c.as_str()).is_none() {
                return err(format!("Column [{c}] not found"), n.start, n.end, Some(format!("Available: {}", schema.iter_names().take(8).map(|x| format!("[{x}]")).collect::<Vec<_>>().join(", "))));
            }
            col(c.as_str())
        }
        Ast::Param(p) => {
            let Some(pp) = params.iter().find(|x| &x.name == p) else { return err(format!("Parameter @{p} is not defined"), n.start, n.end, None) };
            match pp.kind { ParamKind::Number => lit(pp.value.parse::<f64>().unwrap_or(f64::NAN)), ParamKind::Date => lit(pp.value.clone()).str().to_date(Default::default()), ParamKind::List => lit(Series::new("".into(), pp.value.split(',').map(|s| s.trim().to_string()).collect::<Vec<_>>())), ParamKind::Text => lit(pp.value.clone()) }
        }
        Ast::List(items) => {
            let strs: Option<Vec<String>> = items.iter().map(|i| if let Ast::Lit(LitV::Str(s)) = &i.ast { Some(s.clone()) } else { None }).collect();
            if let Some(v) = strs { lit(Series::new("".into(), v)) } else {
                let nums: Option<Vec<f64>> = items.iter().map(|i| if let Ast::Lit(LitV::Num(x)) = &i.ast { Some(*x) } else { None }).collect();
                match nums { Some(v) => lit(Series::new("".into(), v)), None => return err("Lists may only contain literal values", n.start, n.end, None) }
            }
        }
        Ast::Un("not", a) => go(a)?.not(),
        Ast::Un(_, a) => -go(a)?,
        Ast::Bin(op, a, b) => {
            if *op == "in" { return Ok(go(a)?.is_in(go(b)?)); }
            let (x, y) = (go(a)?, go(b)?);
            match *op {
                "and" => x.and(y), "or" => x.or(y),
                "=" => x.eq(y), "<>" => x.neq(y), "<" => x.lt(y), ">" => x.gt(y), "<=" => x.lt_eq(y), ">=" => x.gt_eq(y),
                "+" => x + y, "-" => x - y, "*" => x * y,
                "/" => when(y.clone().eq(lit(0))).then(lit(NULL)).otherwise(x.cast(DataType::Float64) / y),
                "&" => concat_str([x.cast(DataType::String).fill_null(lit("")), y.cast(DataType::String).fill_null(lit(""))], "", false),
                _ => unreachable!(),
            }
        }
        Ast::If(c, a, b) => when(go(c)?).then(go(a)?).otherwise(go(b)?),
        Ast::Try(a, b) => coalesce(&[go(a)?, go(b)?]),
        Ast::Call(f, args) => {
            let a: Vec<Expr> = args.iter().map(go).collect::<Result<_, _>>()?;
            let arg = |i: usize| a.get(i).cloned().ok_or_else(|| FormulaError { message: format!("{f} needs more arguments"), start: n.start, end: n.end, hint: None });
            let int_lit = |i: usize| -> Result<i64, FormulaError> { match args.get(i).map(|x| &x.ast) { Some(Ast::Lit(LitV::Num(v))) => Ok(*v as i64), _ => err(format!("{f}: argument {} must be a number literal", i + 1), n.start, n.end, None) } };
            let s = |i: usize| -> Result<Expr, FormulaError> { Ok(arg(i)?.cast(DataType::String)) };
            match f.as_str() {
                "Text.Upper" => s(0)?.str().to_uppercase(),
                "Text.Lower" => s(0)?.str().to_lowercase(),
                "Text.Proper" => s(0)?.str().to_titlecase(),
                "Text.Trim" => s(0)?.str().strip_chars(lit(NULL)),
                "Text.Length" => s(0)?.str().len_chars(),
                "Text.Start" => s(0)?.str().head(lit(int_lit(1)?)),
                "Text.End" => s(0)?.str().tail(lit(int_lit(1)?)),
                "Text.Contains" => s(0)?.str().contains_literal(arg(1)?),
                "Text.StartsWith" => s(0)?.str().starts_with(arg(1)?),
                "Text.EndsWith" => s(0)?.str().ends_with(arg(1)?),
                "Text.Replace" => s(0)?.str().replace_all(arg(1)?, arg(2)?, true),
                "Text.From" => s(0)?,
                "Number.From" => arg(0)?.cast(DataType::Float64),
                "Number.Round" => arg(0)?.round(args.get(1).map(|_| int_lit(1)).transpose()?.unwrap_or(0) as u32),
                "Number.Abs" => arg(0)?.abs(),
                "Date.Year" => arg(0)?.dt().year(),
                "Date.Month" => arg(0)?.dt().month(),
                "Date.Day" => arg(0)?.dt().day(),
                "Date.Quarter" => arg(0)?.dt().quarter(),
                "Date.WeekOfYear" => arg(0)?.dt().week(),
                "Date.DayOfWeek" => arg(0)?.dt().weekday(),
                "Date.StartOfMonth" => arg(0)?.dt().month_start(),
                "Date.EndOfMonth" => arg(0)?.dt().month_end(),
                "Date.From" => s(0)?.str().to_date(StrptimeOptions { strict: false, ..Default::default() }),
                "Coalesce" => coalesce(&a),
                "Value.IsNull" => arg(0)?.is_null(),
                _ => return err(format!("Unknown function {f}"), n.start, n.end, Some("Press Ctrl+Space for the function list".into())),
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_power_query_style() {
        assert!(parse(r#"if [Sales] > 1000 and [Region] = "EU" then "Key" else "Other""#).is_ok());
        assert!(parse(r#"[Region] in {"EU", "US"}"#).is_ok());
        let e = parse("if [a] > 1 then 2").unwrap_err();
        assert!(e.message.contains("else"));
    }
    #[test]
    fn evaluates_against_polars() {
        let df = df!("Sales" => [500i64, 2000], "Region" => ["EU", "EU"]).unwrap();
        let e = compile(r#"if [Sales] > 1000 and [Region] = "EU" then "Key" else "Other""#, &df.schema(), &[]).unwrap();
        let out = df.lazy().select([e.alias("k")]).collect().unwrap();
        assert_eq!(out.column("k").unwrap().str().unwrap().get(1), Some("Key"));
    }
    #[test]
    fn missing_column_has_position() {
        let df = df!("Sales" => [1i64]).unwrap();
        let e = compile("[Slaes] * 2", &df.schema(), &[]).unwrap_err();
        assert_eq!((e.start, e.end), (0, 7));
    }
}
