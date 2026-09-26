# Floe — Polars desktop

Data preparation for messy spreadsheets. Replayable steps, git-friendly projects, Polars under the hood. Tauri 2.

## Design: "Clay"
- **Monochrome warm neutrals.** Paper `#f2efe8`, panels `#faf8f4`, ink `#2b2926`. No pure white, no pure black.
- **One accent**, clay `#b5643f`, used only for focus, selection and the logo's drifting block.
- **Data types share one low chroma** (teal, slate, violet, ochre, mauve), so the grid stays quiet.
- **Dark theme "Kiln"** uses warm dark neutrals (`#1d1b18`) with a softer clay accent.
- **Typography:** Source Serif 4 (titles), Instrument Sans (UI), JetBrains Mono (data).
- **Mark:** three settled blocks and one drifting block, drawn as plain 2D SVG so it works from 12 px up. `images/floe-mark.svg` is the mark and `images/floe-icon.svg` is the app icon source. Inline copies use `currentColor`, so the mark follows the theme.

## Repository layout
```
index.html, css/, js/, fonts/, images/, vendor/   web app (also the desktop UI), static, no build step
desktop/                                          Tauri 2 shell + Rust/Polars engine crates
vercel.json, .vercelignore                        web deploy
.github/workflows/desktop.yml                     manual installer builds (macOS / Windows / Linux)
```

## Engines
| | Built-in | Polars (native) |
|---|---|---|
| Where | Web Worker (`js/engine.js`) | `floe-engine` process (`desktop/crates/pq-worker`) |
| Steps | All ~40 | 27 (see `pq_compiler::SUPPORTED`) |
| Sources | CSV, Excel, JSON, folder, entered data | CSV, Excel (sheet/range/table), Parquet, Arrow IPC, JSON, entered data |
| Cancel | Terminate worker | Kill process |

**Routing:** `UI.Engine.call` in `js/ui/core.js` sends `evaluate` to Polars only when *all* of these hold:
- the engine is installed and enabled (Settings → Engine);
- every step in the query, and in every query it references, is supported;
- every file source has a real path;
- no dialog is showing a draft preview.

Otherwise, or if the native call fails, it uses the built-in engine. `page`, `profile` and `distinct` go to whichever engine produced the result. The status bar shows `Ready · Polars` or `Ready · Built-in`.

**How the pieces connect:**
```
UI ── invoke('engine_call' | 'engine_page') ──▶ src-tauri/src/engine.rs (supervisor)
                                                 │ stdin/stdout, u32 length + MessagePack
                                                 ▼
                                          floe-engine (Polars)
page → Arrow IPC bytes → tauri::ipc::Response → ArrayBuffer → apache-arrow → grid rows
```

**Supervisor behaviour:**
- Starts the engine lazily, and replays the last project if it has to restart.
- Kills the process on Cancel or when the app exits.
- Only passes the engine file paths the user has granted.
- Engine location, in order: `FLOE_ENGINE`, next to the app binary (bundled with `externalBin`), then `desktop/target/{release,debug}`.

**Per-cell errors in Polars:** ChangeType casts leniently and writes a hidden `__err_<col>` mask column. Pages carry the mask, and the UI shows those cells as errors. Dates are sent as epoch milliseconds.

## Desktop shell (`desktop/src-tauri`)
- **Native menus** send `floe://menu` events to the UI.
- **Native dialogs** for opening and saving.
- **File I/O as raw bytes;** saves are atomic.
- **Least-privilege file access:** only granted paths, with a strict CSP.
- **OS drag and drop**, **`.floe` file association**, and command-line open.
- **Window:** overlay title bar, and window size/position are remembered.
- **Offline:** every asset is vendored under `vendor/` and `fonts/`.

## Entry points
| Path | Purpose |
|---|---|
| `index.html` | App |
| `demo.html` | Sample project |
| `index.html?q=<query>&step=<n>&open=python\|merge\|deps\|files\|nav\|params\|custom` | Deep link |
| `tests.html` | Golden tests |

## License
MIT. Bundled: SheetJS CE (Apache-2.0), AlaSQL (MIT), apache-arrow (Apache-2.0), Font Awesome Free (icons CC BY 4.0, fonts OFL, code MIT), Instrument Sans, Source Serif 4 and JetBrains Mono (OFL).

## Data
- **Project:** `.floe` files hold stable-key JSON with a `format_version`; the app also autosaves to `localStorage`.
- **Files:** read from granted paths, with a working copy in IndexedDB for the built-in engine.
