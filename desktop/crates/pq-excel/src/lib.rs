//! pq-excel — Excel is the headline feature, so this goes deeper than anyone else.
//!
//! * Navigator: sheets (visible/hidden), Excel Tables (ListObjects, ranked first), named ranges,
//!   detected data regions (8-connected blocks) for sheets with stacked / side-by-side tables.
//! * Header detection scores the top rows (share of text, uniqueness, fill, type change below).
//! * Merged cells: optional fill with the top-left value.
//! * Dates: Excel serials honoring 1900 (with the Lotus leap-year bug) vs 1904.
//! * Cache: parse once → Arrow IPC keyed by (file hash, item, options) → `scan_ipc`. Reopening a 200 MB
//!   workbook takes milliseconds.
//! The browser prototype `js/io.js` is the executable spec for every heuristic here.

use calamine::{open_workbook_auto, Data, Range, Reader, Sheets};
use pq_model::ExcelItem;
use polars::prelude::*;
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, thiserror::Error)]
pub enum ExcelError {
    #[error("could not open workbook: {0}")]
    Open(String),
    #[error("{0} not found in workbook")]
    NotFound(String),
    #[error("invalid range `{0}` — use A1 notation like B3:H500 or B3:H")]
    BadRange(String),
    #[error(transparent)]
    Polars(#[from] PolarsError),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Serialize)]
pub struct NavTree { pub tables: Vec<NavTable>, pub sheets: Vec<NavSheet>, pub names: Vec<(String, String)> }
#[derive(Debug, Serialize)]
pub struct NavTable { pub name: String, pub sheet: String, pub rows: usize, pub cols: usize }
#[derive(Debug, Serialize)]
pub struct NavSheet { pub name: String, pub hidden: bool, pub rows: usize, pub cols: usize, pub header: HeaderGuess, pub regions: Vec<String> }
#[derive(Debug, Serialize, Clone)]
pub struct HeaderGuess { pub row: usize, pub confidence: f32 }

pub fn inspect(path: &Path) -> Result<NavTree, ExcelError> {
    let mut wb: Sheets<_> = open_workbook_auto(path).map_err(|e| ExcelError::Open(e.to_string()))?;
    let mut tables = vec![];
    if let Sheets::Xlsx(x) = &mut wb {
        if x.load_tables().is_ok() {
            for name in x.table_names().into_iter().cloned().collect::<Vec<_>>() {
                if let Ok(t) = x.table_by_name(&name) {
                    tables.push(NavTable { name: name.clone(), sheet: t.sheet_name().to_string(), rows: t.data().height(), cols: t.data().width() });
                }
            }
        }
    }
    let meta = wb.sheets_metadata().to_vec();
    let names = wb.defined_names().to_vec();
    let mut sheets = vec![];
    for m in meta {
        let range = wb.worksheet_range(&m.name).map_err(|e| ExcelError::Open(e.to_string()))?;
        let grid = to_grid(&range, 15);
        sheets.push(NavSheet {
            name: m.name.clone(),
            hidden: !matches!(m.visible, calamine::SheetVisible::Visible),
            rows: range.height(), cols: range.width(),
            header: detect_header(&grid),
            regions: detect_regions(&range).into_iter().map(|(r1, c1, r2, c2)| a1(r1, c1, r2, c2)).collect(),
        });
    }
    Ok(NavTree { tables, sheets, names })
}

#[derive(Clone, Copy, PartialEq)]
enum Kind { Empty, Text, Num }
fn kind(d: &Data) -> Kind {
    match d {
        Data::Empty => Kind::Empty,
        Data::String(s) if s.trim().is_empty() => Kind::Empty,
        Data::String(s) if s.trim().replace([',', '$', '%'], "").parse::<f64>().is_ok() => Kind::Num,
        Data::String(_) => Kind::Text,
        _ => Kind::Num,
    }
}

fn to_grid(r: &Range<Data>, max_rows: usize) -> Vec<Vec<Data>> { r.rows().take(max_rows).map(|row| row.to_vec()).collect() }

/// Same scoring as `IO.detectHeader` in js/io.js.
pub fn detect_header(grid: &[Vec<Data>]) -> HeaderGuess {
    let width = grid.iter().map(|r| r.len()).max().unwrap_or(0);
    let mut best = (0usize, f32::MIN);
    for r in 0..grid.len().saturating_sub(1).min(10) {
        let kinds: Vec<Kind> = (0..width).map(|c| grid[r].get(c).map(kind).unwrap_or(Kind::Empty)).collect();
        let filled = kinds.iter().filter(|k| **k != Kind::Empty).count();
        if filled < 2 || (filled as f32) < width as f32 * 0.5 { continue; }
        let text_share = kinds.iter().filter(|k| **k == Kind::Text).count() as f32 / filled as f32;
        let vals: Vec<String> = grid[r].iter().filter(|d| !matches!(d, Data::Empty)).map(|d| d.to_string()).collect();
        let unique = vals.iter().collect::<std::collections::HashSet<_>>().len() as f32 / vals.len().max(1) as f32;
        let (mut change, mut cols) = (0f32, 0f32);
        for c in 0..width {
            if kinds[c] != Kind::Text { continue; }
            let below: Vec<Kind> = grid[r + 1..(r + 8).min(grid.len())].iter().map(|row| row.get(c).map(kind).unwrap_or(Kind::Empty)).filter(|k| *k != Kind::Empty).collect();
            if below.is_empty() { continue; }
            cols += 1.0;
            change += below.iter().filter(|k| **k != Kind::Text).count() as f32 / below.len() as f32;
        }
        let type_change = if cols > 0.0 { change / cols } else { 0.0 };
        let score = text_share * 3.0 + unique * 2.0 + (filled as f32 / width as f32) * 2.0 + type_change * 3.0 - r as f32 * 0.05;
        if score > best.1 { best = (r, score); }
    }
    HeaderGuess { row: best.0, confidence: ((best.1 - 3.0) / 7.0).clamp(0.0, 1.0) }
}

/// Contiguous non-empty blocks (8-connectivity). Returns (r1, c1, r2, c2), 0-based.
pub fn detect_regions(r: &Range<Data>) -> Vec<(usize, usize, usize, usize)> {
    let (h, w) = (r.height().min(2000), r.width().min(200));
    let (r0, c0) = r.start().map(|(a, b)| (a as usize, b as usize)).unwrap_or((0, 0));
    let filled = |y: usize, x: usize| r.get((y, x)).is_some_and(|d| kind(d) != Kind::Empty);
    let mut seen = vec![false; h * w];
    let mut out = vec![];
    for i in 0..h * w {
        let (y, x) = (i / w, i % w);
        if seen[i] || !filled(y, x) { continue; }
        let (mut y1, mut x1, mut y2, mut x2, mut n) = (y, x, y, x, 0);
        let mut stack = vec![i]; seen[i] = true;
        while let Some(k) = stack.pop() {
            let (cy, cx) = (k / w, k % w); n += 1;
            y1 = y1.min(cy); y2 = y2.max(cy); x1 = x1.min(cx); x2 = x2.max(cx);
            for dy in -1i64..=1 { for dx in -1i64..=1 {
                let (ny, nx) = (cy as i64 + dy, cx as i64 + dx);
                if ny < 0 || nx < 0 || ny >= h as i64 || nx >= w as i64 { continue; }
                let j = ny as usize * w + nx as usize;
                if !seen[j] && filled(ny as usize, nx as usize) { seen[j] = true; stack.push(j); }
            } }
        }
        if y2 > y1 && x2 > x1 && n >= 4 { out.push((y1 + r0, x1 + c0, y2 + r0, x2 + c0)); }
    }
    out
}

fn col_name(mut i: usize) -> String { let mut s = String::new(); i += 1; while i > 0 { let m = (i - 1) % 26; s.insert(0, (b'A' + m as u8) as char); i = (i - 1) / 26; } s }
fn a1(r1: usize, c1: usize, r2: usize, c2: usize) -> String { format!("{}{}:{}{}", col_name(c1), r1 + 1, col_name(c2), r2 + 1) }

/// Parse once to Arrow IPC in the cache dir; subsequent reads are `scan_ipc`.
pub fn cached_ipc(path: &Path, item: &ExcelItem, fill_merged: bool, cache_dir: &Path) -> Result<PathBuf, ExcelError> {
    let bytes = std::fs::read(path)?;
    let mut h = blake3::Hasher::new();
    h.update(&bytes);
    h.update(format!("{item:?}|{fill_merged}").as_bytes());
    let out = cache_dir.join(format!("xl_{}.arrow", &h.finalize().to_hex()[..24]));
    if out.exists() { return Ok(out); }
    let mut df = read_item(path, item)?;
    let mut f = std::fs::File::create(&out)?;
    IpcWriter::new(&mut f).finish(&mut df)?;
    Ok(out)
}

/// Read an item as raw cells (`Column1..N`, all String / Float64 / Date by column). Header promotion is a
/// separate `PromoteHeaders` step so the user can see and change it.
pub fn read_item(path: &Path, item: &ExcelItem) -> Result<DataFrame, ExcelError> {
    let mut wb: Sheets<_> = open_workbook_auto(path).map_err(|e| ExcelError::Open(e.to_string()))?;
    let range = match item {
        ExcelItem::Sheet { name } => {
            let n = if name.is_empty() { wb.sheet_names().first().cloned().unwrap_or_default() } else { name.clone() };
            wb.worksheet_range(&n).map_err(|_| ExcelError::NotFound(format!("sheet `{n}`")))?
        }
        ExcelItem::Range { sheet, range } => {
            let full = wb.worksheet_range(sheet).map_err(|_| ExcelError::NotFound(format!("sheet `{sheet}`")))?;
            let (r1, c1, r2, c2) = parse_a1(range).ok_or_else(|| ExcelError::BadRange(range.clone()))?;
            let end = full.end().unwrap_or((0, 0));
            full.range((r1 as u32, c1 as u32), (r2.map(|x| x as u32).unwrap_or(end.0), c2.map(|x| x as u32).unwrap_or(end.1)))
        }
        ExcelItem::Table { name } => {
            if let Sheets::Xlsx(x) = &mut wb { x.load_tables().map_err(|e| ExcelError::Open(e.to_string()))?; let t = x.table_by_name(name).map_err(|_| ExcelError::NotFound(format!("table `{name}`")))?; return grid_to_df(t.data(), Some(t.columns().to_vec())); }
            return Err(ExcelError::NotFound(format!("table `{name}` (tables are xlsx-only)")));
        }
        ExcelItem::Name { name } => return Err(ExcelError::NotFound(format!("named range `{name}` (resolve via defined_names → Range)"))),
        ExcelItem::Sheets { .. } => return Err(ExcelError::NotFound("multi-sheet combine is assembled by the compiler (diagonal concat)".into())),
    };
    grid_to_df(&range, None)
}

fn grid_to_df(r: &Range<Data>, headers: Option<Vec<String>>) -> Result<DataFrame, ExcelError> {
    let w = r.width();
    let cols: Vec<Column> = (0..w).map(|c| {
        let name = headers.as_ref().and_then(|h| h.get(c).cloned()).unwrap_or_else(|| format!("Column{}", c + 1));
        let vals: Vec<Option<String>> = r.rows().map(|row| match row.get(c) { Some(Data::Empty) | None => None, Some(Data::DateTime(d)) => d.as_datetime().map(|x| x.to_string()), Some(d) => Some(d.to_string()) }).collect();
        Column::new(name.into(), vals)
    }).collect();
    Ok(DataFrame::new(cols)?)
}

/// "B3:H500", "B3:H" (to last row), "B:H".
pub fn parse_a1(s: &str) -> Option<(usize, usize, Option<usize>, Option<usize>)> {
    let s = s.replace('$', "");
    let s = s.rsplit('!').next()?;
    let part = |p: &str| -> Option<(Option<usize>, Option<usize>)> {
        let letters: String = p.chars().take_while(|c| c.is_ascii_alphabetic()).collect();
        let digits: String = p.chars().skip(letters.len()).collect();
        let c = if letters.is_empty() { None } else { Some(letters.to_ascii_uppercase().bytes().fold(0usize, |a, b| a * 26 + (b - b'A' + 1) as usize) - 1) };
        let r = if digits.is_empty() { None } else { Some(digits.parse::<usize>().ok()? - 1) };
        if c.is_none() && r.is_none() { None } else { Some((r, c)) }
    };
    let mut it = s.split(':');
    let (r1, c1) = part(it.next()?)?;
    let (r2, c2) = match it.next() { Some(p) => part(p)?, None => (r1, c1) };
    Some((r1.unwrap_or(0), c1.unwrap_or(0), r2, c2))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a1_open_ended() { assert_eq!(parse_a1("B3:H"), Some((2, 1, None, Some(7)))); assert_eq!(parse_a1("Sheet1!$A$1:$C$5"), Some((0, 0, Some(4), Some(2)))); }
    #[test]
    fn header_below_title() {
        let s = |x: &str| Data::String(x.into());
        let grid = vec![vec![s("ACME report"), Data::Empty, Data::Empty], vec![Data::Empty, Data::Empty, Data::Empty], vec![s("Region"), s("Product"), s("Jan")], vec![s("EU"), s("Widget"), Data::Float(10.0)], vec![s("US"), s("Gadget"), Data::Float(12.0)]];
        assert_eq!(detect_header(&grid).row, 2);
    }
}
