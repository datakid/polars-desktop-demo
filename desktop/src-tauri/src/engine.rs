//! Supervisor for the native Polars engine (`floe-engine`, crate desktop/crates/pq-worker).
//!
//! * Spawned lazily on first use; located next to the app binary (bundled via `externalBin`)
//!   or via FLOE_ENGINE for development.
//! * Frames: u32-LE length + MessagePack. One request in flight (Mutex) — the UI keeps a single
//!   evaluation active and supersedes older ones.
//! * Cancel = kill. Crash = next call respawns and re-sends the last project.
//! * Absent binary = `engine_status` reports unavailable and the UI keeps using the built-in engine.

use serde::Serialize;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::ipc::{Request, Response};
use tauri::{AppHandle, Manager, State};

struct Proc { child: Child, stdin: ChildStdin, stdout: ChildStdout }

#[derive(Default)]
pub struct Engine {
    proc: Mutex<Option<Proc>>,
    /// Kept outside `proc` so `cancel` can kill without waiting for the in-flight call's lock.
    pid: Mutex<Option<u32>>,
    last_project: Mutex<Option<Vec<u8>>>,
    hello: Mutex<Option<serde_json::Value>>,
    seq: AtomicU64,
    restarts: AtomicU64,
}

#[derive(Serialize)]
pub struct Status { available: bool, running: bool, restarts: u64, path: Option<String>, info: Option<serde_json::Value> }

fn exe_name() -> &'static str { if cfg!(windows) { "floe-engine.exe" } else { "floe-engine" } }

fn locate(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(p) = std::env::var("FLOE_ENGINE") { let p = PathBuf::from(p); if p.is_file() { return Some(p); } }
    let mut dirs = vec![];
    if let Ok(exe) = std::env::current_exe() { if let Some(d) = exe.parent() { dirs.push(d.to_path_buf()); } }
    if let Ok(r) = app.path().resource_dir() { dirs.push(r); }
    // dev: desktop/target/{release,debug}
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("target");
    dirs.push(dev.join("release"));
    dirs.push(dev.join("debug"));
    dirs.into_iter().map(|d| d.join(exe_name())).find(|p| p.is_file())
}

pub fn installed(app: &AppHandle) -> bool { locate(app).is_some() }

fn write_frame(w: &mut impl Write, body: &[u8]) -> std::io::Result<()> {
    w.write_all(&(body.len() as u32).to_le_bytes())?;
    w.write_all(body)?;
    w.flush()
}
fn read_frame(r: &mut impl Read) -> std::io::Result<Vec<u8>> {
    let mut len = [0u8; 4];
    r.read_exact(&mut len)?;
    let mut buf = vec![0u8; u32::from_le_bytes(len) as usize];
    r.read_exact(&mut buf)?;
    Ok(buf)
}

#[derive(serde::Deserialize)]
pub struct Reply { ok: bool, #[serde(default)] result: Option<serde_json::Value>, #[serde(default, with = "serde_bytes")] bytes: Option<Vec<u8>>, #[serde(default)] error: Option<String> }

impl Engine {
    fn spawn(&self, app: &AppHandle) -> Result<Proc, String> {
        let path = locate(app).ok_or("native engine not installed")?;
        let mut cmd = Command::new(&path);
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit());
        #[cfg(windows)]
        { use std::os::windows::process::CommandExt; cmd.creation_flags(0x0800_0000); } // CREATE_NO_WINDOW
        let mut child = cmd.spawn().map_err(|e| format!("engine: {e}"))?;
        *self.pid.lock().unwrap() = Some(child.id());
        let stdin = child.stdin.take().ok_or("engine stdin")?;
        let stdout = child.stdout.take().ok_or("engine stdout")?;
        let mut p = Proc { child, stdin, stdout };
        let hello = Self::roundtrip(&mut p, self.next(), "hello", serde_json::json!({}))?;
        *self.hello.lock().unwrap() = hello.result;
        if let Some(proj) = self.last_project.lock().unwrap().clone() {
            let args: serde_json::Value = rmp_serde::from_slice(&proj).map_err(|e| e.to_string())?;
            Self::roundtrip(&mut p, self.next(), "setProject", args)?;
        }
        Ok(p)
    }

    fn next(&self) -> u64 { self.seq.fetch_add(1, Ordering::Relaxed) + 1 }

    fn roundtrip(p: &mut Proc, id: u64, op: &str, args: serde_json::Value) -> Result<Reply, String> {
        let body = rmp_serde::to_vec_named(&serde_json::json!({ "id": id, "op": op, "args": args })).map_err(|e| e.to_string())?;
        write_frame(&mut p.stdin, &body).map_err(|e| format!("engine write: {e}"))?;
        let frame = read_frame(&mut p.stdout).map_err(|e| format!("engine stopped: {e}"))?;
        rmp_serde::from_slice::<Reply>(&frame).map_err(|e| format!("engine reply: {e}"))
    }

    /// One call; respawns once if the process died (crash or cancel).
    pub fn call(&self, app: &AppHandle, op: &str, args: serde_json::Value) -> Result<Reply, String> {
        let mut guard = self.proc.lock().unwrap();
        for attempt in 0..2 {
            if guard.as_mut().map(|p| matches!(p.child.try_wait(), Ok(Some(_)))).unwrap_or(true) {
                if guard.is_some() { self.restarts.fetch_add(1, Ordering::Relaxed); }
                *guard = Some(self.spawn(app)?);
            }
            let p = guard.as_mut().unwrap();
            match Self::roundtrip(p, self.next(), op, args.clone()) {
                Ok(r) if r.ok => return Ok(r),
                Ok(r) => return Err(r.error.unwrap_or_else(|| "engine error".into())),
                Err(e) => { let _ = p.child.kill(); *guard = None; if attempt == 1 { return Err(e); } }
            }
        }
        Err("engine unavailable".into())
    }

    pub fn kill(&self) {
        if let Some(pid) = self.pid.lock().unwrap().take() {
            #[cfg(unix)]
            { let _ = Command::new("kill").arg("-9").arg(pid.to_string()).status(); }
            #[cfg(windows)]
            { let _ = Command::new("taskkill").args(["/F", "/PID", &pid.to_string()]).status(); }
        }
    }
}

/* ─────────────────────────────── commands ─────────────────────────────── */

#[tauri::command]
pub async fn engine_status(app: AppHandle, eng: State<'_, Engine>) -> Result<Status, String> {
    let path = locate(&app);
    if path.is_some() && eng.hello.lock().unwrap().is_none() {
        let _ = eng.call(&app, "hello", serde_json::json!({}));
    }
    let running = eng.proc.lock().map(|g| g.is_some()).unwrap_or(true);
    Ok(Status { available: path.is_some(), running, restarts: eng.restarts.load(Ordering::Relaxed), path: path.map(|p| p.to_string_lossy().into_owned()), info: eng.hello.lock().unwrap().clone() })
}

/// JSON ops (setProject, canRun, evaluate, profile, distinct, export, drop). File ids → granted paths
/// are resolved here so the engine never sees paths the user didn't grant.
#[tauri::command]
pub async fn engine_call(app: AppHandle, eng: State<'_, Engine>, grants: State<'_, crate::Grants>, op: String, args: serde_json::Value) -> Result<serde_json::Value, String> {
    let mut args = args;
    if op == "setProject" {
        if let Some(files) = args.get("files").and_then(|f| f.as_object()) {
            let mut ok = serde_json::Map::new();
            for (id, p) in files { if let Some(s) = p.as_str() { if grants.check(std::path::Path::new(s)).is_ok() { ok.insert(id.clone(), p.clone()); } } }
            args["files"] = serde_json::Value::Object(ok);
        }
        *eng.last_project.lock().unwrap() = Some(rmp_serde::to_vec_named(&args).map_err(|e| e.to_string())?);
    }
    if op == "export" {
        let p = args.get("path").and_then(|p| p.as_str()).ok_or("path")?;
        grants.check(std::path::Path::new(p))?;
    }
    let app2 = app.clone();
    let res = tauri::async_runtime::spawn_blocking(move || { let eng = app2.state::<Engine>(); eng.call(&app2, &op, args) }).await.map_err(|e| e.to_string())??;
    Ok(res.result.unwrap_or(serde_json::Value::Null))
}

/// A page of rows as raw Arrow IPC bytes (ArrayBuffer in JS). Args in the JSON body.
#[tauri::command]
pub async fn engine_page(app: AppHandle, request: Request<'_>) -> Result<Response, String> {
    let args: serde_json::Value = match request.body() {
        tauri::ipc::InvokeBody::Json(v) => v.clone(),
        tauri::ipc::InvokeBody::Raw(b) => serde_json::from_slice(b).map_err(|e| e.to_string())?,
    };
    let app2 = app.clone();
    let r = tauri::async_runtime::spawn_blocking(move || { let eng = app2.state::<Engine>(); eng.call(&app2, "page", args) }).await.map_err(|e| e.to_string())??;
    Ok(Response::new(r.bytes.unwrap_or_default()))
}

#[tauri::command]
pub fn engine_cancel(eng: State<'_, Engine>) { eng.kill(); }
