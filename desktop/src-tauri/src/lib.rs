use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::{DialogExt, FilePath};
use tokio::sync::oneshot;

const DATA_EXT: &[&str] = &[
    "csv", "tsv", "txt", "xlsx", "xlsm", "xlsb", "xls", "ods", "json", "ndjson", "jsonl", "parquet", "pq",
    "arrow", "feather", "ipc",
];
const PROJECT_EXT: &[&str] = &["floe", "pqproj"];
const MAX_FILES: usize = 5000;
const MAX_DEPTH: usize = 4;
const MAX_GRANTS: usize = 20000;

#[derive(Serialize, Clone)]
struct FileMeta {
    name: String,
    path: String,
    size: u64,
    mtime: f64,
    folder: String,
}

#[derive(Serialize, Clone, Default)]
struct LaunchFiles {
    project: Option<FileMeta>,
    data: Vec<FileMeta>,
}

impl LaunchFiles {
    fn is_empty(&self) -> bool {
        self.project.is_none() && self.data.is_empty()
    }
}

#[derive(Serialize)]
struct FolderPick {
    folder: String,
    files: Vec<FileMeta>,
}

#[derive(Serialize)]
struct Stat {
    size: u64,
    mtime: f64,
}

struct Grants {
    set: Mutex<HashSet<PathBuf>>,
    store: Option<PathBuf>,
}

impl Grants {
    fn load(store: Option<PathBuf>) -> Self {
        let set = store
            .as_ref()
            .and_then(|p| fs::read(p).ok())
            .and_then(|b| serde_json::from_slice::<Vec<PathBuf>>(&b).ok())
            .map(|v| v.into_iter().collect())
            .unwrap_or_default();
        Grants { set: Mutex::new(set), store }
    }
    fn add(&self, p: &Path) {
        let mut s = self.set.lock().unwrap_or_else(|e| e.into_inner());
        if s.len() > MAX_GRANTS {
            s.clear();
        }
        s.insert(p.to_path_buf());
        if let Ok(c) = fs::canonicalize(p) {
            s.insert(c);
        }
    }
    fn allowed(&self, p: &Path) -> bool {
        let s = self.set.lock().unwrap_or_else(|e| e.into_inner());
        s.contains(p) || fs::canonicalize(p).map(|c| s.contains(&c)).unwrap_or(false)
    }
    fn save(&self) {
        if let Some(store) = &self.store {
            let v: Vec<PathBuf> = self.set.lock().unwrap_or_else(|e| e.into_inner()).iter().cloned().collect();
            if let Ok(b) = serde_json::to_vec(&v) {
                let _ = fs::write(store, b);
            }
        }
    }
}

struct Launch {
    pending: Mutex<LaunchFiles>,
    ready: Mutex<bool>,
}

fn ext_of(p: &Path) -> String {
    p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default()
}
fn is_data(p: &Path) -> bool {
    DATA_EXT.contains(&ext_of(p).as_str())
}
fn is_project(p: &Path) -> bool {
    PROJECT_EXT.contains(&ext_of(p).as_str())
}

fn meta(p: &Path, folder: &str) -> Option<FileMeta> {
    let md = fs::metadata(p).ok()?;
    if !md.is_file() {
        return None;
    }
    Some(FileMeta {
        name: p.file_name()?.to_string_lossy().into_owned(),
        path: p.to_string_lossy().into_owned(),
        size: md.len(),
        mtime: mtime_ms(&md),
        folder: folder.to_string(),
    })
}

fn mtime_ms(md: &fs::Metadata) -> f64 {
    md.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

fn walk(dir: &Path, folder: &str, depth: usize, out: &mut Vec<FileMeta>) {
    if out.len() >= MAX_FILES {
        return;
    }
    let Ok(rd) = fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = rd.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        if out.len() >= MAX_FILES {
            return;
        }
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let p = e.path();
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_dir() {
            if depth < MAX_DEPTH {
                walk(&p, folder, depth + 1, out);
            }
        } else if ft.is_file() && is_data(&p) {
            if let Some(m) = meta(&p, folder) {
                out.push(m);
            }
        }
    }
}

fn classify(paths: &[PathBuf], grants: &Grants) -> LaunchFiles {
    let mut lf = LaunchFiles::default();
    for p in paths {
        if p.is_dir() {
            let folder = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "folder".into());
            let mut files = Vec::new();
            walk(p, &folder, 0, &mut files);
            for f in &files {
                grants.add(Path::new(&f.path));
            }
            lf.data.extend(files);
        } else if is_project(p) {
            if lf.project.is_none() {
                if let Some(m) = meta(p, "") {
                    grants.add(p);
                    lf.project = Some(m);
                }
            }
        } else if is_data(p) {
            if let Some(m) = meta(p, "") {
                grants.add(p);
                lf.data.push(m);
            }
        }
    }
    grants.save();
    lf
}

fn paths_from_args<I: IntoIterator<Item = String>>(args: I, cwd: Option<&Path>) -> Vec<PathBuf> {
    args.into_iter()
        .filter(|a| !a.starts_with('-'))
        .map(PathBuf::from)
        .map(|p| match cwd {
            Some(c) if p.is_relative() => c.join(p),
            _ => p,
        })
        .filter(|p| p.exists())
        .collect()
}

fn emit_launch(app: &AppHandle, lf: LaunchFiles) {
    if let Some(p) = lf.project {
        let _ = app.emit("floe://open-project", p);
    }
    if !lf.data.is_empty() {
        let _ = app.emit("floe://open-data", lf.data);
    }
}

fn deliver(app: &AppHandle, paths: Vec<PathBuf>) {
    if paths.is_empty() {
        return;
    }
    let (Some(grants), Some(launch)) = (app.try_state::<Grants>(), app.try_state::<Launch>()) else { return };
    let lf = classify(&paths, &grants);
    if lf.is_empty() {
        return;
    }
    let ready = *launch.ready.lock().unwrap_or_else(|e| e.into_inner());
    if ready {
        emit_launch(app, lf);
    } else {
        let mut pending = launch.pending.lock().unwrap_or_else(|e| e.into_inner());
        if lf.project.is_some() {
            pending.project = lf.project;
        }
        pending.data.extend(lf.data);
    }
}

fn focus_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let hex = |c: u8| -> Option<u8> {
        match c {
            b'0'..=b'9' => Some(c - b'0'),
            b'a'..=b'f' => Some(c - b'a' + 10),
            b'A'..=b'F' => Some(c - b'A' + 10),
            _ => None,
        }
    };
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2])) {
                out.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn into_path(fp: FilePath) -> Option<PathBuf> {
    fp.into_path().ok()
}

#[tauri::command]
fn app_info(app: AppHandle) -> Value {
    json!({
        "name": "Floe",
        "version": app.package_info().version.to_string(),
        "tauri": tauri::VERSION,
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "nativeEngine": cfg!(feature = "polars-engine")
    })
}

#[tauri::command]
async fn pick_files(app: AppHandle, grants: State<'_, Grants>, kind: String, multiple: bool) -> Result<Vec<FileMeta>, String> {
    let (tx, rx) = oneshot::channel::<Vec<FilePath>>();
    let mut d = app.dialog().file();
    if kind == "project" {
        d = d.set_title("Open project").add_filter("Floe project", &["floe", "json", "pqproj"]);
    } else {
        d = d.set_title("Open data").add_filter("Data files", DATA_EXT);
    }
    if let Some(w) = app.get_webview_window("main") {
        d = d.set_parent(&w);
    }
    if multiple {
        d.pick_files(move |r| {
            let _ = tx.send(r.unwrap_or_default());
        });
    } else {
        d.pick_file(move |r| {
            let _ = tx.send(r.map(|p| vec![p]).unwrap_or_default());
        });
    }
    let picked = rx.await.map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for fp in picked {
        if let Some(p) = into_path(fp) {
            if let Some(m) = meta(&p, "") {
                grants.add(&p);
                out.push(m);
            }
        }
    }
    grants.save();
    Ok(out)
}

#[tauri::command]
async fn pick_folder(app: AppHandle, grants: State<'_, Grants>) -> Result<Option<FolderPick>, String> {
    let (tx, rx) = oneshot::channel::<Option<FilePath>>();
    let mut d = app.dialog().file().set_title("Open folder");
    if let Some(w) = app.get_webview_window("main") {
        d = d.set_parent(&w);
    }
    d.pick_folder(move |r| {
        let _ = tx.send(r);
    });
    let Some(dir) = rx.await.map_err(|e| e.to_string())?.and_then(into_path) else { return Ok(None) };
    let folder = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "folder".into());
    let files = tauri::async_runtime::spawn_blocking(move || {
        let mut files = Vec::new();
        walk(&dir, &folder, 0, &mut files);
        (folder, files)
    })
    .await
    .map_err(|e| e.to_string())?;
    for f in &files.1 {
        grants.add(Path::new(&f.path));
    }
    grants.save();
    Ok(Some(FolderPick { folder: files.0, files: files.1 }))
}

#[tauri::command]
async fn pick_save(app: AppHandle, grants: State<'_, Grants>, default_name: String) -> Result<Option<String>, String> {
    let (tx, rx) = oneshot::channel::<Option<FilePath>>();
    let ext = ext_of(Path::new(&default_name));
    let mut d = app.dialog().file().set_title("Save").set_file_name(&default_name);
    if !ext.is_empty() {
        let label = ext.to_uppercase() + " file";
        d = d.add_filter(label, &[ext.as_str()]);
    }
    if let Some(w) = app.get_webview_window("main") {
        d = d.set_parent(&w);
    }
    d.save_file(move |r| {
        let _ = tx.send(r);
    });
    let Some(p) = rx.await.map_err(|e| e.to_string())?.and_then(into_path) else { return Ok(None) };
    grants.add(&p);
    grants.save();
    Ok(Some(p.to_string_lossy().into_owned()))
}

#[tauri::command]
async fn read_file(grants: State<'_, Grants>, path: String) -> Result<Response, String> {
    let p = PathBuf::from(&path);
    if !grants.allowed(&p) {
        return Err(format!("Floe has no permission to read {path}. Open it again from the file picker."));
    }
    let bytes = tauri::async_runtime::spawn_blocking(move || fs::read(&p))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("{path}: {e}"))?;
    Ok(Response::new(bytes))
}

#[tauri::command]
async fn write_file(request: Request<'_>, grants: State<'_, Grants>) -> Result<(), String> {
    let path = request
        .headers()
        .get("x-path")
        .and_then(|v| v.to_str().ok())
        .map(percent_decode)
        .ok_or_else(|| "write_file: missing x-path header".to_string())?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("write_file: expected a binary body".into());
    };
    let p = PathBuf::from(&path);
    if !grants.allowed(&p) {
        return Err(format!("Floe has no permission to write {path}. Use Save As."));
    }
    let bytes = bytes.clone();
    let target = p.clone();
    tauri::async_runtime::spawn_blocking(move || -> std::io::Result<()> {
        let dir = target.parent().map(Path::to_path_buf).unwrap_or_else(|| PathBuf::from("."));
        let name = target.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "file".into());
        let tmp = dir.join(format!(".{name}.floe-tmp"));
        fs::write(&tmp, &bytes)?;
        match fs::rename(&tmp, &target) {
            Ok(()) => Ok(()),
            Err(_) => {
                let r = fs::write(&target, &bytes);
                let _ = fs::remove_file(&tmp);
                r
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| format!("{path}: {e}"))?;
    grants.add(&p);
    grants.save();
    Ok(())
}

#[tauri::command]
fn file_stat(grants: State<'_, Grants>, path: String) -> Result<Option<Stat>, String> {
    let p = PathBuf::from(&path);
    if !grants.allowed(&p) {
        return Err(format!("Floe has no permission to read {path}"));
    }
    match fs::metadata(&p) {
        Ok(md) if md.is_file() => Ok(Some(Stat { size: md.len(), mtime: mtime_ms(&md) })),
        _ => Ok(None),
    }
}

#[tauri::command]
fn take_launch_files(launch: State<'_, Launch>) -> LaunchFiles {
    *launch.ready.lock().unwrap_or_else(|e| e.into_inner()) = true;
    std::mem::take(&mut *launch.pending.lock().unwrap_or_else(|e| e.into_inner()))
}

#[cfg(not(feature = "polars-engine"))]
mod engine_cmds {
    use super::*;
    #[tauri::command]
    pub fn engine_status() -> Value {
        json!({ "available": false })
    }
    #[tauri::command]
    pub fn engine_cancel() {}
    #[tauri::command]
    pub async fn engine_call(_op: String, _args: Value) -> Result<Value, String> {
        Err("This build has no Polars engine".into())
    }
    #[tauri::command]
    pub async fn engine_page(_result_id: String, _offset: usize, _count: usize) -> Result<Response, String> {
        Err("This build has no Polars engine".into())
    }
}

#[cfg(feature = "polars-engine")]
mod engine_cmds {
    use super::*;
    fn allowed_paths(v: &Value, grants: &Grants) -> Result<(), String> {
        match v {
            Value::Object(o) => {
                if let Some(Value::String(p)) = o.get("path") {
                    if !grants.allowed(Path::new(p)) {
                        return Err(format!("Floe has no permission to read {p}. Open it again from the file picker."));
                    }
                }
                o.values().try_for_each(|x| allowed_paths(x, grants))
            }
            Value::Array(a) => a.iter().try_for_each(|x| allowed_paths(x, grants)),
            _ => Ok(()),
        }
    }
    #[tauri::command]
    pub fn engine_status() -> Value {
        floe_engine::status()
    }
    #[tauri::command]
    pub fn engine_cancel() {
        floe_engine::cancel()
    }
    #[tauri::command]
    pub async fn engine_call(grants: State<'_, Grants>, op: String, args: Value) -> Result<Value, String> {
        if let Some(plan) = args.get("plan") {
            allowed_paths(plan, &grants)?;
        }
        if op == "export" {
            let p = args["path"].as_str().unwrap_or("");
            if !grants.allowed(Path::new(p)) {
                return Err(format!("Floe has no permission to write {p}. Use Save As."));
            }
        }
        tauri::async_runtime::spawn_blocking(move || std::panic::catch_unwind(|| floe_engine::call(&op, &args)).unwrap_or_else(|_| Err("Polars engine crashed on this query".into())))
            .await
            .map_err(|e| e.to_string())?
    }
    #[tauri::command]
    pub async fn engine_page(result_id: String, offset: usize, count: usize) -> Result<Response, String> {
        let bytes = tauri::async_runtime::spawn_blocking(move || floe_engine::page(&result_id, offset, count)).await.map_err(|e| e.to_string())??;
        Ok(Response::new(bytes))
    }
}
use engine_cmds::{engine_call, engine_cancel, engine_page, engine_status};

#[cfg(target_os = "macos")]
fn build_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
    let item = |id: &str, text: &str, acc: Option<&str>| MenuItem::with_id(app, id.to_string(), text, true, acc);
    let sep = || PredefinedMenuItem::separator(app);

    let app_menu = Submenu::with_items(
        app,
        "Floe",
        true,
        &[
            &item("help.about", "About Floe", None)?,
            &sep()?,
            &item("file.settings", "Settings…", Some("Cmd+,"))?,
            &sep()?,
            &PredefinedMenuItem::services(app, None)?,
            &sep()?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &sep()?,
            &item("app.quit", "Quit Floe", Some("Cmd+Q"))?,
        ],
    )?;
    let file = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &item("file.new", "New Project", Some("Cmd+N"))?,
            &item("file.open", "Open Project…", Some("Cmd+O"))?,
            &sep()?,
            &item("file.get_data", "Open Data…", None)?,
            &item("file.folder", "Open Folder…", None)?,
            &item("file.samples", "Load Sample Data", None)?,
            &sep()?,
            &item("file.save", "Save", Some("Cmd+S"))?,
            &item("file.save_as", "Save As…", Some("Cmd+Shift+S"))?,
            &sep()?,
            &item("file.export_xlsx", "Export to Excel…", Some("Cmd+E"))?,
            &item("file.export_csv", "Export to CSV…", None)?,
            &item("file.export_python", "Export to Python…", None)?,
            &sep()?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &item("edit.undo", "Undo Step", None)?,
            &item("edit.redo", "Redo Step", None)?,
            &sep()?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let query = Submenu::with_items(
        app,
        "Query",
        true,
        &[
            &item("query.refresh", "Refresh", Some("F5"))?,
            &item("query.refresh_all", "Refresh All Outputs", None)?,
            &sep()?,
            &item("query.preview", "Preview Rows", None)?,
            &item("query.full", "Full Data", Some("Cmd+Shift+F"))?,
            &sep()?,
            &item("query.params", "Parameters…", None)?,
            &item("query.deps", "Dependencies…", None)?,
            &item("query.project_files", "Project Files…", None)?,
        ],
    )?;
    let view = Submenu::with_items(
        app,
        "View",
        true,
        &[&item("view.theme", "Toggle Theme", None)?, &sep()?, &PredefinedMenuItem::fullscreen(app, None)?],
    )?;
    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[&PredefinedMenuItem::minimize(app, None)?, &PredefinedMenuItem::maximize(app, None)?],
    )?;
    let help = Submenu::with_items(
        app,
        "Help",
        true,
        &[&item("help.shortcuts", "Keyboard Shortcuts", None)?, &item("help.about", "About Floe", None)?],
    )?;
    Menu::with_items(app, &[&app_menu, &file, &edit, &query, &view, &window, &help])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            let paths = paths_from_args(argv.into_iter().skip(1), Some(Path::new(&cwd)));
            deliver(app, paths);
            focus_main(app);
        }));
    }

    builder
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let store = app.path().app_data_dir().ok().and_then(|d| {
                fs::create_dir_all(&d).ok()?;
                Some(d.join("granted-paths.json"))
            });
            app.manage(Grants::load(store));
            app.manage(Launch { pending: Mutex::new(LaunchFiles::default()), ready: Mutex::new(false) });

            #[cfg(target_os = "macos")]
            {
                let menu = build_menu(app.handle())?;
                app.handle().set_menu(menu)?;
            }

            let handle = app.handle().clone();
            let initial = paths_from_args(std::env::args().skip(1), None);
            deliver(&handle, initial);
            Ok(())
        })
        .on_menu_event(|app, event| {
            let id = event.id().as_ref().to_string();
            if id == "app.quit" {
                match app.get_webview_window("main") {
                    Some(w) => {
                        let _ = w.close();
                    }
                    None => app.exit(0),
                }
                return;
            }
            let _ = app.emit("floe://menu", id);
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                let app = window.app_handle();
                let grants = app.state::<Grants>();
                let lf = classify(paths, &grants);
                if let Some(p) = lf.project {
                    let _ = app.emit("floe://open-project", p);
                }
                if !lf.data.is_empty() {
                    let _ = app.emit("floe://files-dropped", lf.data);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            pick_files,
            pick_folder,
            pick_save,
            read_file,
            write_file,
            file_stat,
            take_launch_files,
            engine_status,
            engine_cancel,
            engine_call,
            engine_page
        ])
        .build(tauri::generate_context!())
        .expect("error while building Floe")
        .run(on_run_event);
}

#[cfg(target_os = "macos")]
fn on_run_event(app: &AppHandle, event: tauri::RunEvent) {
    if let tauri::RunEvent::Opened { urls } = event {
        let paths: Vec<PathBuf> = urls.into_iter().filter_map(|u| u.to_file_path().ok()).collect();
        deliver(app, paths);
        focus_main(app);
    }
}

#[cfg(not(target_os = "macos"))]
fn on_run_event(_app: &AppHandle, _event: tauri::RunEvent) {}
