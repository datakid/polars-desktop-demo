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

## Deploy the web app (Vercel)
1. Push to GitHub.
2. In Vercel, choose **Add New → Project** and import the repo.
3. Framework preset: **Other**. Leave the build command empty and set the output directory to `.` (both already set in `vercel.json`).
4. Deploy. Each push to `main` redeploys, and each branch gets a preview URL.

The web app runs fully in the browser. Files never leave the device, and projects autosave to local storage. Polars, native dialogs and file association are desktop-only. On the web it uses the built-in engine and shows `Web` in the status bar.

CLI alternative: `npx vercel` (preview), then `npx vercel --prod`.

## Build installers (GitHub Actions)
Open the Actions tab, choose **Desktop build**, then **Run workflow**. Tick the checkbox to bundle Polars. The installers appear as artifacts. The workflow runs only when triggered by hand.

## Run locally
```bash
cd desktop
npm run setup          # Tauri CLI + icons from images/floe-icon.svg
npm run dev            # built-in engine only
npm run dev:native     # builds floe-engine (Polars) first, then launches
npm run build:native   # installers with the Polars engine bundled as a sidecar
npm run test:engine    # cargo test for the engine crates
```
Requires Node 18+, Rust 1.77+ and the [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/).

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

## Verified
- 63 golden tests pass (`tests.html`).
- Native path checked in the browser with a mocked Tauri engine that returns real Arrow IPC: routing, decoding (int, float, text, null, date, error masks), status label, and falling back when `canRun` is false.
- Rust unit tests are written (frame round-trip, evaluate → Arrow page, grants, path decoding) but have **not been compiled** here. Run `npm run test:engine`.

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

## Next
1. `cargo test` against the pinned Polars version (`=0.46.0`), then fix any API drift.
2. Port the remaining steps to Polars (SplitColumn, Pivot, Transpose, Window, ConditionalColumn, ExpandJson, error-handling steps) and folder sources.
3. Native step fingerprint cache written as Arrow IPC in the OS cache directory.
4. `floe` CLI on the same crates.
5. Database connectors with query folding.
6. Code signing and the updater plugin.

## License
MIT. Bundled: SheetJS CE (Apache-2.0), AlaSQL (MIT), apache-arrow (Apache-2.0), Font Awesome Free (icons CC BY 4.0, fonts OFL, code MIT), Instrument Sans, Source Serif 4 and JetBrains Mono (OFL).

## Data
- **Project:** `.floe` files hold stable-key JSON with a `format_version`; the app also autosaves to `localStorage`.
- **Files:** read from granted paths, with a working copy in IndexedDB for the built-in engine.
