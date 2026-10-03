use crate::expr::{days_from_civil, parse_iso};
use crate::{fmt_days, fmt_ms, is_int, is_num, uniquify, Ctx, R, S};
use calamine::{open_workbook_auto, Data, Reader};
use polars::prelude::*;
use serde_json::Value;

const DAY: i64 = 86_400_000;

pub fn limit(lf: LazyFrame, cx: &mut Ctx) -> R<LazyFrame> {
    match cx.preview {
        None => Ok(lf),
        Some(p) => {
            let df = lf.limit((p + 1) as IdxSize).collect().s()?;
            if df.height() > p {
                cx.truncated = true;
            }
            Ok(df.head(Some(p)).lazy())
        }
    }
}

fn sniff(path: &str) -> u8 {
    use std::io::Read;
    let mut buf = vec![0u8; 65536];
    let n = std::fs::File::open(path).and_then(|mut f| f.read(&mut buf)).unwrap_or(0);
    let text = String::from_utf8_lossy(&buf[..n]);
    let line = text.lines().next().unwrap_or("");
    let mut best = (b',', 0usize);
    for d in [b',', b';', b'\t', b'|'] {
        let (mut inq, mut c) = (false, 0usize);
        for ch in line.bytes() {
            if ch == b'"' {
                inq = !inq
            } else if ch == d && !inq {
                c += 1
            }
        }
        if c > best.1 {
            best = (d, c)
        }
    }
    best.0
}

pub fn read(src: &Value, first: Option<&Value>, cx: &mut Ctx) -> R<(LazyFrame, bool)> {
    let path = src["path"].as_str().unwrap_or("");
    match src["kind"].as_str().unwrap_or("") {
        "csv" => {
            let d = src["delimiter"].as_str().and_then(|s| s.bytes().next()).unwrap_or_else(|| sniff(path));
            let header = src["header"].as_bool().unwrap_or(true);
            let mut r = LazyCsvReader::new(path)
                .with_separator(d)
                .with_has_header(header)
                .with_infer_schema_length(Some(0))
                .with_skip_rows(src["skipRows"].as_u64().unwrap_or(0) as usize)
                .with_missing_is_null(true)
                .with_truncate_ragged_lines(true);
            if let Some(p) = cx.preview {
                r = r.with_n_rows(Some(p + 1));
            }
            let mut lf = r.finish().map_err(|e| format!("{path}: {e}"))?;
            if !header {
                let s = lf.collect_schema().s()?;
                let ex: Vec<Expr> = s.iter_names().enumerate().map(|(i, n)| col(n.as_str()).alias(format!("Column{}", i + 1))).collect();
                lf = lf.select(ex);
            }
            Ok((limit(lf, cx)?, false))
        }
        "parquet" => Ok((limit(LazyFrame::scan_parquet(path, ScanArgsParquet::default()).map_err(|e| format!("{path}: {e}"))?, cx)?, false)),
        "ipc" => Ok((limit(LazyFrame::scan_ipc(path, ScanArgsIpc::default()).map_err(|e| format!("{path}: {e}"))?, cx)?, false)),
        "excel" => {
            let header = first.filter(|o| o["op"] == "promoteHeaders").map(|o| o["row"].as_u64().unwrap_or(0) as usize);
            Ok((excel(src, header, cx)?, header.is_some()))
        }
        "blank" => {
            let names: Vec<String> = src["columns"].as_array().cloned().unwrap_or_default().iter().map(|v| v.as_str().unwrap_or("").to_string()).collect();
            let rows = src["rows"].as_array().cloned().unwrap_or_default();
            let cols: Vec<Column> = names
                .iter()
                .enumerate()
                .map(|(i, n)| {
                    let v: Vec<Option<String>> = rows.iter().map(|r| r[i].as_str().map(String::from)).collect();
                    Series::new(n.as_str().into(), v).into_column()
                })
                .collect();
            Ok((DataFrame::new(cols).s()?.lazy(), false))
        }
        "query" => Ok((crate::build(&src["plan"], cx)?, false)),
        k => Err(format!("Unsupported source {k}")),
    }
}

#[derive(Clone)]
enum C {
    Null,
    N(f64),
    S(String),
    B(bool),
    D(i64),
}

fn serial_ms(s: f64) -> i64 {
    let base = if s < 60.0 { days_from_civil(1899, 12, 31) } else { days_from_civil(1899, 12, 30) };
    let whole = s.floor();
    (base + whole as i64) * DAY + ((s - whole) * 86400.0).round() as i64 * 1000
}

fn cell(d: Option<&Data>) -> C {
    match d {
        None | Some(Data::Empty) | Some(Data::Error(_)) => C::Null,
        Some(Data::Int(i)) => C::N(*i as f64),
        Some(Data::Float(f)) => C::N(*f),
        Some(Data::Bool(b)) => C::B(*b),
        Some(Data::String(s)) => {
            if s.trim().is_empty() {
                C::Null
            } else {
                C::S(s.clone())
            }
        }
        Some(Data::DateTime(x)) => C::D(serial_ms(x.as_f64())),
        Some(Data::DateTimeIso(s)) => match parse_iso(s) {
            Some((v, true)) => C::D(v),
            Some((v, false)) => C::D(v * DAY),
            None => C::S(s.clone()),
        },
        Some(Data::DurationIso(s)) => C::S(s.clone()),
    }
}

fn fmt_cell(c: &C) -> Option<String> {
    match c {
        C::Null => None,
        C::N(f) => Some(if f.fract() == 0.0 && f.abs() < 9.0e15 { format!("{}", *f as i64) } else { format!("{f}") }),
        C::S(s) => Some(s.clone()),
        C::B(b) => Some(if *b { "TRUE" } else { "FALSE" }.into()),
        C::D(ms) => Some(if ms % DAY == 0 { fmt_days(ms / DAY) } else { fmt_ms(*ms) }),
    }
}

fn to_column(name: &str, vals: &[C]) -> R<Column> {
    let (mut n, mut s, mut b, mut d, mut other) = (0, 0, 0, 0, false);
    let (mut all_int, mut midnight) = (true, true);
    for v in vals {
        match v {
            C::Null => {}
            C::N(f) => {
                n += 1;
                if f.fract() != 0.0 {
                    all_int = false
                }
            }
            C::S(_) => s += 1,
            C::B(_) => b += 1,
            C::D(ms) => {
                d += 1;
                if ms % DAY != 0 {
                    midnight = false
                }
            }
        }
    }
    let kinds = [n, s, b, d].iter().filter(|x| **x > 0).count();
    if kinds > 1 {
        other = true;
    }
    let pl = name.into();
    let series = if other || s > 0 || kinds == 0 {
        Series::new(pl, vals.iter().map(fmt_cell).collect::<Vec<_>>())
    } else if n > 0 {
        let v: Vec<Option<f64>> = vals.iter().map(|x| if let C::N(f) = x { Some(*f) } else { None }).collect();
        let sr = Series::new(pl, v);
        if all_int { sr.cast(&DataType::Int64).s()? } else { sr }
    } else if b > 0 {
        Series::new(pl, vals.iter().map(|x| if let C::B(v) = x { Some(*v) } else { None }).collect::<Vec<_>>())
    } else {
        let v: Vec<Option<i64>> = vals.iter().map(|x| if let C::D(ms) = x { Some(*ms) } else { None }).collect();
        let sr = Series::new(pl, v).cast(&DataType::Datetime(TimeUnit::Milliseconds, None)).s()?;
        if midnight { sr.cast(&DataType::Date).s()? } else { sr }
    };
    Ok(series.into_column())
}

fn col_idx(s: &str) -> u32 {
    s.bytes().fold(0u32, |n, c| n * 26 + (c.to_ascii_uppercase() - b'A' + 1) as u32) - 1
}

fn parse_a1(r: &str) -> Option<(u32, u32, u32, u32)> {
    let r = r.rsplit('!').next()?.replace('$', "");
    let part = |p: &str| -> Option<(Option<u32>, Option<u32>)> {
        let letters: String = p.chars().take_while(|c| c.is_ascii_alphabetic()).collect();
        let digits = &p[letters.len()..];
        if letters.is_empty() && digits.is_empty() {
            return None;
        }
        let c = if letters.is_empty() { None } else { Some(col_idx(&letters)) };
        let rr = if digits.is_empty() { None } else { Some(digits.parse::<u32>().ok()? - 1) };
        Some((c, rr))
    };
    let mut it = r.split(':');
    let a = part(it.next()?)?;
    let b = match it.next() {
        Some(x) => part(x)?,
        None => a,
    };
    Some((a.1.unwrap_or(0), a.0.unwrap_or(0), b.1.unwrap_or(u32::MAX), b.0.unwrap_or(u32::MAX)))
}

fn excel(src: &Value, header: Option<usize>, cx: &mut Ctx) -> R<LazyFrame> {
    let path = src["path"].as_str().unwrap_or("");
    let mut wb = open_workbook_auto(path).map_err(|e| format!("{path}: {e}"))?;
    let names = wb.sheet_names().to_vec();
    let sheet = match &src["sheet"] {
        Value::Number(n) => names.get(n.as_u64().unwrap_or(0) as usize).cloned(),
        Value::String(s) => Some(s.clone()),
        _ => names.first().cloned(),
    }
    .ok_or("Sheet not found in workbook")?;
    if !names.contains(&sheet) {
        return Err(format!("Sheet \"{sheet}\" not found in workbook"));
    }
    let range = wb.worksheet_range(&sheet).map_err(|e| e.to_string())?;
    let mut grid: Vec<Vec<C>> = Vec::new();
    if let (Some((sr, sc)), Some((er, ec))) = (range.start(), range.end()) {
        let (r1, c1, r2, c2) = src["range"].as_str().and_then(parse_a1).unwrap_or((sr, sc, er, ec));
        let (r1, c1) = (r1.max(sr), c1.max(sc));
        let (r2, c2) = (r2.min(er), c2.min(ec));
        let mut last = r2;
        if let Some(p) = cx.preview {
            last = last.min(r1.saturating_add(p as u32));
        }
        if r1 <= last && c1 <= c2 {
            for r in r1..=last {
                grid.push((c1..=c2).map(|c| cell(range.get_value((r, c)))).collect());
            }
        }
        if let Some(p) = cx.preview {
            if grid.len() > p {
                grid.truncate(p);
                cx.truncated = true;
            }
        }
    }
    while grid.last().map(|r| r.iter().all(|c| matches!(c, C::Null))).unwrap_or(false) {
        grid.pop();
    }
    let width = grid.iter().map(|r| r.iter().rposition(|c| !matches!(c, C::Null)).map(|i| i + 1).unwrap_or(0)).max().unwrap_or(0);
    let (names, body): (Vec<String>, &[Vec<C>]) = match header {
        Some(h) => {
            if h >= grid.len() {
                return Err(format!("Row {} does not exist (table has {} rows)", h + 1, grid.len()));
            }
            (uniquify((0..width).map(|c| grid[h].get(c).and_then(fmt_cell)).collect()), &grid[h + 1..])
        }
        None => ((1..=width).map(|i| format!("Column{i}")).collect(), &grid[..]),
    };
    let cols: R<Vec<Column>> = names
        .iter()
        .enumerate()
        .map(|(c, n)| {
            let vals: Vec<C> = body.iter().map(|r| r.get(c).cloned().unwrap_or(C::Null)).collect();
            to_column(n, &vals)
        })
        .collect();
    Ok(DataFrame::new(cols?).s()?.lazy())
}

pub fn write_xlsx(df: &DataFrame, path: &str, sheet: &str) -> R<()> {
    use rust_xlsxwriter::{Format, Workbook, XlsxError};
    let e = |x: XlsxError| x.to_string();
    if df.height() >= 1_048_576 {
        return Err(format!("{} rows exceed Excel's limit of 1,048,575. Export to CSV or Parquet instead.", df.height()));
    }
    let mut wb = Workbook::new();
    let ws = wb.add_worksheet();
    let name: String = sheet.chars().map(|c| if "[]:*?/\\".contains(c) { '_' } else { c }).take(31).collect();
    ws.set_name(if name.trim().is_empty() { "Data" } else { name.as_str() }).map_err(e)?;
    let bold = Format::new().set_bold();
    let fd = Format::new().set_num_format("yyyy-mm-dd");
    let fdt = Format::new().set_num_format("yyyy-mm-dd hh:mm:ss");
    let fnum = Format::new().set_num_format("#,##0.00");
    for (c, column) in df.get_columns().iter().enumerate() {
        let c16 = c as u16;
        ws.write_string_with_format(0, c16, column.name().as_str(), &bold).map_err(e)?;
        let s = column.as_materialized_series();
        let dt = s.dtype().clone();
        match dt {
            DataType::Boolean => {
                for (i, v) in s.bool().s()?.into_iter().enumerate() {
                    if let Some(b) = v {
                        ws.write_boolean(i as u32 + 1, c16, b).map_err(e)?;
                    }
                }
            }
            DataType::Date | DataType::Datetime(_, _) => {
                let ms = s.cast(&DataType::Datetime(TimeUnit::Milliseconds, None)).s()?.cast(&DataType::Int64).s()?;
                let f = if dt == DataType::Date { &fd } else { &fdt };
                for (i, v) in ms.i64().s()?.into_iter().enumerate() {
                    if let Some(x) = v {
                        ws.write_number_with_format(i as u32 + 1, c16, x as f64 / DAY as f64 + 25569.0, f).map_err(e)?;
                    }
                }
            }
            ref d if is_num(d) => {
                let int = is_int(d);
                let f = s.cast(&DataType::Float64).s()?;
                for (i, v) in f.f64().s()?.into_iter().enumerate() {
                    if let Some(x) = v {
                        if int {
                            ws.write_number(i as u32 + 1, c16, x).map_err(e)?;
                        } else {
                            ws.write_number_with_format(i as u32 + 1, c16, x, &fnum).map_err(e)?;
                        }
                    }
                }
            }
            _ => {
                let t = s.cast(&DataType::String).s()?;
                for (i, v) in t.str().s()?.into_iter().enumerate() {
                    if let Some(x) = v {
                        ws.write_string(i as u32 + 1, c16, x).map_err(e)?;
                    }
                }
            }
        }
    }
    if df.width() > 0 {
        ws.autofilter(0, 0, df.height() as u32, (df.width() - 1) as u16).map_err(e)?;
    }
    wb.save(path).map_err(e)?;
    Ok(())
}
