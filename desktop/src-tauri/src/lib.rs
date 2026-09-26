//! Floe — Polars desktop. Tauri 2 shell.
//!
//! The UI (repo root: index.html, css/, js/) is staged into ../dist and served from the app bundle.
//! Everything runs offline. The UI's in-app engine runs in a Web Worker (cancel = kill + restart);
//! the native Polars worker process (desktop/crates/pq-worker) plugs in behind the same message protocol.
//!
//! Security model: the webview gets NO generic filesystem permission. Every file read/write goes through
//! the commands below, which only accept paths the user explicitly granted — picked in a native dialog,
//! dropped on the window, or opened via file association / command line.

use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, DragDropEvent, Emitter, Manager, State, WindowEvent};
use tauri_plugin_dialog::DialogExt;

mod engine;
mod menu;

const DATA_EXT: &[&str] = &["csv", "tsv", "txt", "xlsx", "xlsm", "xlsb", "xls", "ods", "json", "ndjson", "jsonl"];
const PROJECT_EXT: &[&str] = &["floe", "json"];

/// Paths the user has granted this session.
#[derive(Default)]
pub struct Grants {
    paths: Mutex<HashSet<PathBuf>>,
    launch: Mutex<Option<PathBuf>>,
}

impl Grants {
    fn grant(&self, p: &Path) {
        let mut g = self.paths.lock().unwrap();
        g.insert(p.to_path_buf());
        if let Ok(c) = std::fs::canonicalize(p) { g.insert(c); }
    }
    pub fn check(&self, p: &Path) -> Result<PathBuf, String> {
        let g = self.paths.lock().unwrap();
        if g.contains(p) || std::fs::canonicalize(p).map(|c| g.contains(&c)).unwrap_or(false) {
            Ok(p.to_path_buf())
        } else {
            Err(format!("Floe has no permission for {} — pick it again from a dialog", p.display()))
        }
    }
}

#[derive(Serialize, Clone)]
struct FileMeta { name: String, path: String, size: u64, mtime: u64, folder: String }

#[derive(Serialize)]
struct FolderPick { folder: String, files: Vec<FileMeta> }

fn ext_in(p: &Path, list: &[&str]) -> bool {
    p.extension().and_then(|e| e.to_str()).map(|e| list.contains(&e.to_ascii_lowercase().as_str())).unwrap_or(false)
}

fn file_meta(p: &Path, folder: &str) -> Option<FileMeta> {
    let m = std::fs::metadata(p).ok()?;
    if !m.is_file() { return None; }
    Some(FileMeta {
        name: p.file_name()?.to_string_lossy().into_owned(),
        path: p.to_string_lossy().into_owned(),
        size: m.len(),
        mtime: m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0),
        folder: folder.to_string(),
    })
}

/// Data files directly inside a folder (sorted), granted as we go.
fn folder_files(grants: &Grants, dir: &Path) -> (String, Vec<FileMeta>) {
    let folder = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "folder".into());
    let mut entries: Vec<PathBuf> = std::fs::read_dir(dir).map(|rd| rd.filter_map(|e| e.ok().map(|e| e.path())).collect()).unwrap_or_default();
    entries.sort();
    let files = entries.into_iter().filter(|p| p.is_file() && ext_in(p, DATA_EXT)).filter_map(|p| { grants.grant(&p); file_meta(&p, &folder) }).collect();
    (folder, files)
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Some(v) = std::str::from_utf8(&b[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()) { out.push(v); i += 3; continue; }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/* ─────────────────────────────── commands ─────────────────────────────── */

#[tauri::command]
async fn pick_files(app: AppHandle, grants: State<'_, Grants>, kind: String, multiple: bool) -> Result<Vec<FileMeta>, String> {
    let dialog = if kind == "project" {
        app.dialog().file().set_title("Open Floe project").add_filter("Floe project", PROJECT_EXT)
    } else {
        app.dialog().file().set_title("Open data").add_filter("Excel, CSV, JSON", DATA_EXT)
    };
    let picked: Vec<PathBuf> = if multiple {
        dialog.blocking_pick_files().unwrap_or_default().into_iter().filter_map(|f| f.into_path().ok()).collect()
    } else {
        dialog.blocking_pick_file().and_then(|f| f.into_path().ok()).into_iter().collect()
    };
    Ok(picked.iter().filter_map(|p| { grants.grant(p); file_meta(p, "") }).collect())
}

#[tauri::command]
async fn pick_folder(app: AppHandle, grants: State<'_, Grants>) -> Result<Option<FolderPick>, String> {
    let Some(dir) = app.dialog().file().set_title("Combine files from folder").blocking_pick_folder().and_then(|f| f.into_path().ok()) else { return Ok(None) };
    let (folder, files) = folder_files(&grants, &dir);
    Ok(Some(FolderPick { folder, files }))
}

#[tauri::command]
async fn pick_save(app: AppHandle, grants: State<'_, Grants>, default_name: String) -> Result<Option<String>, String> {
    let ext = Path::new(&default_name).extension().and_then(|e| e.to_str()).unwrap_or("").to_string();
    let mut dialog = app.dialog().file().set_title("Save").set_file_name(&default_name);
    if !ext.is_empty() {
        let label = match ext.as_str() { "floe" => "Floe project", "xlsx" => "Excel workbook", "csv" => "CSV", "py" => "Python script", _ => "File" };
        dialog = dialog.add_filter(label, &[ext.as_str()]);
    }
    let Some(path) = dialog.blocking_save_file().and_then(|f| f.into_path().ok()) else { return Ok(None) };
    grants.grant(&path);
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Raw bytes back to JS (ArrayBuffer) — no JSON/base64 round trip.
#[tauri::command]
async fn read_file(grants: State<'_, Grants>, path: String) -> Result<Response, String> {
    let p = grants.check(Path::new(&path))?;
    let bytes = std::fs::read(&p).map_err(|e| format!("Could not read {}: {e}", p.display()))?;
    Ok(Response::new(bytes))
}

/// Raw request body = file bytes; target path in the `x-path` header (percent-encoded). Atomic write.
#[tauri::command]
fn write_file(grants: State<'_, Grants>, request: Request<'_>) -> Result<(), String> {
    let InvokeBody::Raw(bytes) = request.body() else { return Err("expected raw bytes".into()) };
    let path = request.headers().get("x-path").and_then(|v| v.to_str().ok()).map(percent_decode).ok_or("missing x-path header")?;
    let p = grants.check(Path::new(&path))?;
    let tmp = p.with_extension(format!("{}.floe-tmp", p.extension().and_then(|e| e.to_str()).unwrap_or("")));
    std::fs::write(&tmp, bytes).map_err(|e| format!("Could not write {}: {e}", p.display()))?;
    std::fs::rename(&tmp, &p).map_err(|e| { let _ = std::fs::remove_file(&tmp); format!("Could not save {}: {e}", p.display()) })?;
    Ok(())
}

#[tauri::command]
fn file_stat(grants: State<'_, Grants>, path: String) -> Result<Option<FileMeta>, String> {
    let p = grants.check(Path::new(&path))?;
    Ok(file_meta(&p, ""))
}

/// A project passed on the command line or via file association, consumed once by the UI at boot.
#[tauri::command]
fn take_launch_file(grants: State<'_, Grants>) -> Option<FileMeta> {
    grants.launch.lock().unwrap().take().and_then(|p| file_meta(&p, ""))
}

#[tauri::command]
fn app_info(app: AppHandle) -> serde_json::Value {
    serde_json::json!({
        "name": app.package_info().name,
        "version": app.package_info().version.to_string(),
        "tauri": tauri::VERSION,
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "nativeEngine": engine::installed(&app),
    })
}

fn open_project_path(app: &AppHandle, p: PathBuf) {
    let grants = app.state::<Grants>();
    grants.grant(&p);
    *grants.launch.lock().unwrap() = Some(p.clone());
    if let Some(m) = file_meta(&p, "") { let _ = app.emit("floe://open-project", m); }
}

/* ─────────────────────────────── app ─────────────────────────────── */

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .manage(Grants::default())
        .manage(engine::Engine::default())
        .invoke_handler(tauri::generate_handler![
            pick_files, pick_folder, pick_save, read_file, write_file, file_stat, take_launch_file, app_info,
            engine::engine_status, engine::engine_call, engine::engine_page, engine::engine_cancel
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            app.set_menu(menu::build(&handle)?)?;
            app.on_menu_event(|app, event| { let _ = app.emit("floe://menu", event.id().as_ref()); });
            // `floe path/to/project.floe` (also how Windows/Linux file associations launch us)
            if let Some(arg) = std::env::args().skip(1).find(|a| !a.starts_with('-')) {
                let p = PathBuf::from(arg);
                if p.is_file() && ext_in(&p, PROJECT_EXT) {
                    let grants = handle.state::<Grants>();
                    grants.grant(&p);
                    *grants.launch.lock().unwrap() = Some(p);
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // OS drag & drop: real paths → grant → hand metadata to the UI, which reads the bytes.
            if let WindowEvent::DragDrop(DragDropEvent::Drop { paths, .. }) = event {
                let grants = window.state::<Grants>();
                let mut files = vec![];
                for p in paths {
                    if p.is_dir() {
                        files.extend(folder_files(&grants, p).1);
                    } else if ext_in(p, PROJECT_EXT) && p.extension().and_then(|e| e.to_str()) == Some("floe") {
                        open_project_path(window.app_handle(), p.clone());
                    } else if ext_in(p, DATA_EXT) {
                        grants.grant(p);
                        files.extend(file_meta(p, ""));
                    }
                }
                if !files.is_empty() { let _ = window.emit("floe://files-dropped", files); }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Floe");

    app.run(|_handle, _event| {
        if let tauri::RunEvent::Exit = _event { _handle.state::<engine::Engine>().kill(); }
        // macOS delivers "open with" / double-clicked .floe files as an Opened event.
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = _event {
            for u in urls {
                if let Ok(p) = u.to_file_path() { open_project_path(_handle, p); }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn decodes_paths() {
        assert_eq!(percent_decode("C%3A%5CUsers%5Cana%5Cq3%20report.xlsx"), "C:\\Users\\ana\\q3 report.xlsx");
        assert_eq!(percent_decode("%2Fhome%2Fana%2Fr%C3%A9sum%C3%A9.csv"), "/home/ana/résumé.csv");
        assert_eq!(percent_decode("plain"), "plain");
    }
    #[test]
    fn grants_are_enforced() {
        let g = Grants::default();
        assert!(g.check(Path::new("/etc/passwd")).is_err());
        g.grant(Path::new("/tmp/floe-test.csv"));
        assert!(g.check(Path::new("/tmp/floe-test.csv")).is_ok());
    }
}
