# Floe 1.1 — data preparation, web and desktop

## What's new since 1.1
- **Parquet streaming on the web** (`js/parquet.js`):
  - Reads only the footer metadata first.
  - Decodes row group by row group, and only the columns the query needs. Projection is worked out from the steps: Select, Remove, Group by, formulas, and so on.
  - Previews stop after the row groups that cover the preview row count.
  - Large files stay as a lazy `Blob` (or OPFS file) and are read in byte slices, so the whole file is never copied into memory.
  - Decoded columns are cached in an LRU with a budget of about 30M cells.
  - Progress shows "row group i of n · k of m columns".
  - **Filter pushdown:** full runs and exports skip row groups whose min/max statistics show that a leading `Filter` can't match.
    - Operators: `= <> < <= > >= in`, combined with `and` / `or`.
    - Columns: int, number, ASCII text and date.
    - Constants: literals, parameters or constant expressions.
    - Only Filters reached through column-only steps (select/remove/reorder) are used, so results are identical to an unpruned run.
    - The status note reports "N skipped by filter statistics".
- **Column projection in the UI:**
  - The Parquet navigator has column checkboxes.
  - The Source step has a column picker.
  - The Python export adds `.select([...])` after `pl.scan_parquet`.
  - The Polars JSON plan carries the projection.
- **`floe` CLI** (`scripts/floe.mjs`, Node 18+, no dependencies). It runs the same built-in JS engine headlessly:
  ```
  node scripts/floe.mjs run project.floe [--query <name>] [--format csv|tsv|xlsx|parquet|arrow] [--data <dir>] [--out <dir>] [--param k=v]
  node scripts/floe.mjs inspect data.parquet [--rows 20] [--json]
  node scripts/floe.mjs python project.floe [--query <name>] [--out script.py]
  node scripts/floe.mjs plan project.floe --query <name>
  ```
  Exit codes: 0 ok · 1 query failed · 2 usage · 3 input missing. `npm link` installs it as `floe`.
- Engine tests: 96. That includes the Parquet planning, projection and CLI tests, plus 3 pushdown tests that check every case against an unpruned filter.

## What's new in 1.1
- **Engine indicator** in the status bar: `● Built-in · 42 ms · Sample 1,000`. Click it (or press Enter on it) for engine, location, last run, data scope and, on desktop, why that engine ran. The dot shows idle, busy, starting or error. On phones it shrinks to the dot and engine name.
- **Polars engine for desktop** (optional build, `--features polars-engine`):
  - `js/plan.js` lowers a query into a JSON plan, or refuses with a reason naming the step.
  - `desktop/src-tauri/engine` (crate `floe-engine`, Polars 0.46, calamine, rust_xlsxwriter) executes the plan.
  - Pages come back as Arrow IPC. Exports are written straight to the chosen path.
  - Anything Polars can't run falls back to the built-in engine automatically, and the indicator shows `Built-in ↺` with the reason.
- **Web ships no native-engine code.** `native-engine.js` is loaded only inside Tauri and is excluded from the web build.
- Engine tests: 86 (8 new plan-lowering tests).
  - Rust: `engine/tests/plan.rs` (unit tests).
  - `engine/tests/parity.rs` runs 22 shared cases generated from the built-in engine by `scripts/gen-fixtures.mjs` and requires Polars to give the same schema and rows.
- **Faster built-in engine:**
  - CSV parsing writes straight into columns (about −30%).
  - Pivot uses streaming accumulators (−60%).
  - Previews of large CSVs decode only the first 4 MB.
  - Benchmark with `bench.html`; results go in `docs/BENCH.md`.
- **Signing:** opt-in through the repository variable `SIGNING=on` plus secrets; see `docs/SIGNING.md`.

Clean and reshape messy spreadsheets with replayable steps. Excel, CSV, JSON, Parquet and Arrow IPC in; Excel, CSV, Parquet, Arrow or a Polars Python script out. Everything runs locally — files are never uploaded.

One codebase ships two ways:

| | Web (Vercel / any static host) | Desktop (Tauri 2) |
|---|---|---|
| Engine | Built-in columnar JS engine in a Web Worker | Built-in engine; Polars in the `polars` build for supported queries |
| Files | File System Access API on Chromium, copies elsewhere | Native open/save dialogs, real paths, files stay linked |
| Save | In-place on Chromium, download elsewhere | In-place atomic write to the `.floe` file |
| Refresh | Re-reads linked files that changed | Re-reads files whose size/mtime changed on disk |
| Offline | Service worker + PWA install | Always offline |
| OS integration | PWA file handlers, share target | File associations, drag & drop, single instance, macOS menu, unsaved-changes guard on close |

## Repository layout
```
index.html, demo.html, 404.html     app pages
tests.html, tests-ui.html           engine golden tests (96) · UI end-to-end smoke test (web build only)
css/app.css                         "Clay" design system
js/                                 engine (worker), platform layer, UI
js/native-engine.js                 optional Polars adapter; idle unless a desktop engine reports itself available
vendor/                             SheetJS, AlaSQL, apache-arrow, hyparquet(+writer, compressors), Font Awesome (+webfonts)
fonts/                              Instrument Sans, Source Serif 4, JetBrains Mono (variable woff2)
images/                             floe-icon.svg (app icon source), floe-icon-maskable.svg, floe-mark.svg, raster jpgs
manifest.webmanifest, sw.js         PWA
scripts/build-web.mjs               single build script for both targets
scripts/floe.mjs                    headless `floe` CLI (built-in engine under Node)
js/parquet.js                       Parquet metadata, row-group/range planner, projected column scan
package.json                        root version (source of truth) + build scripts
vercel.json, .vercelignore          web deploy
desktop/                            Tauri 2 shell (never uploaded to Vercel)
  package.json, scripts/ensure-icons.mjs
  src-tauri/Cargo.toml, build.rs, tauri.conf.json, capabilities/default.json, src/main.rs, src/lib.rs
.github/workflows/                  web-check.yml (build check) · desktop.yml (macOS/Windows/Linux installers)
```

## Build
`scripts/build-web.mjs` copies only what each target needs into an output folder and validates it:
- verifies `package.json`, `PQ.VERSION` (js/util.js) and, for desktop, `tauri.conf.json` versions match;
- fails if a required vendor/font/icon file is missing;
- web: stamps `sw.js` with a content-hashed cache name (`floe-1.0.0-<hash>`) so every deploy invalidates old caches automatically, and fails if `sw.js` precaches a file that is not in the build;
- desktop: omits `sw.js` and the test pages;
- writes `version.json` (`{version, build, target, builtAt}`).

```
node scripts/build-web.mjs --target web       → dist/
node scripts/build-web.mjs --target desktop   → desktop/dist/
```
No npm dependencies are required for the web build.

## Deploy the web app (Vercel)
`vercel.json` is the full instruction set: `framework: null`, `installCommand` is a no-op, `buildCommand` runs the web build, `outputDirectory` is `dist`. Just import the repo (root directory = repo root) or run `vercel --prod`. Project settings in the dashboard should be left on "Other / override off" so `vercel.json` wins.

`.vercelignore` keeps `desktop/`, `.github/`, `target/`, `node_modules/` and local `dist/` out of the upload, so Rust sources and Tauri build artefacts never reach Vercel and never get touched by it.

Headers: CSP (`'unsafe-eval'` is required by AlaSQL for Custom SQL steps), `nosniff`, frame/permissions policies, long caching for `vendor|fonts|images`, `no-cache` for `sw.js`, the manifest and `version.json`. `/share-target` falls back to a 303 redirect when no service worker is active.

## Build the desktop app (Tauri 2)
Prerequisites: Node 18+, Rust stable, and the [Tauri system prerequisites](https://tauri.app/start/prerequisites/) (WebView2 on Windows, `libwebkit2gtk-4.1-dev` on Linux, Xcode CLT on macOS).
```
cd desktop
npm install
npm run dev        # stages desktop/dist, generates icons if missing, opens the app
npm run build      # installers in desktop/src-tauri/target/release/bundle/
```
Icons are generated from `images/floe-icon.svg` into `desktop/src-tauri/icons/` on first dev/build (`npm run icons` to regenerate).

CI: push a tag `v1.0.0` and `.github/workflows/desktop.yml` builds draft release installers for macOS (arm64 + x64), Windows (NSIS/MSI) and Linux (deb/AppImage/rpm). Code signing/notarisation is not configured — add Apple/Windows signing secrets to tauri-action when you have certificates.

### Desktop shell (src-tauri/src/lib.rs)
Commands used by `js/platform.js`:
| Command | Purpose |
|---|---|
| `app_info` | version, Tauri version, OS |
| `pick_files {kind, multiple}` / `pick_folder` / `pick_save {defaultName}` | native dialogs |
| `read_file {path}` | raw bytes (binary IPC response) |
| `write_file` (raw body, `x-path` header) | atomic write via temp file + rename |
| `file_stat {path}` | size + mtime for change detection |
| `take_launch_files` | files passed on the command line / "Open with" before the UI was ready |
| `engine_status` / `engine_cancel` | report no native engine (keeps the adapter idle) |

Security: the shell only reads or writes paths the user granted through a dialog, a drop or "Open with" (persisted in the app data dir as `granted-paths.json`), so the webview cannot read arbitrary files. CSP is strict (`'self'`, no remote origins). Capabilities grant only core window/title/close and dialog permissions.

Events emitted to the UI: `floe://menu` (macOS menu), `floe://files-dropped`, `floe://open-project`, `floe://open-data`. The window close request is routed through the same Save / Don't save / Cancel guard as the web app.

## Entry points
| Path | Purpose |
|---|---|
| `index.html` | App |
| `demo.html` | Fresh workspace with the sample project |
| `index.html?demo` | Load samples if the project is empty |
| `index.html?q=<query>&step=<n>` | Open a query at a step |
| `index.html?pane=queries\|data\|steps` | Mobile pane |
| `index.html?open=python\|merge\|deps\|files\|nav\|params\|custom\|palette` | Open a dialog |
| `index.html?shared=1` | Import files received through the PWA share target |
| `share-target` (POST) | Web Share Target endpoint (service worker) |
| `version.json` | Deployed build info |
| `tests.html`, `tests-ui.html` | Test pages (web build only) |
| `bench.html` | Engine benchmark, 100k–1M rows (web build only) |

## Data model
- **Project (`.floe`)**: stable-key JSON `{format_version, name, settings:{previewRows, locale}, params[], queries[{id, name, load:{target}, steps[{id, name, kind, note?, disabled?}]}]}`.
- **File record (IndexedDB `pqx-files/files`)**: `{id, name, size, mtime, folder, path, buf | opfs:true}`. On desktop `path` is the real path used for refresh.
- **Web KV (IndexedDB `floe-web/kv`)**: file handles, project handle, recent list.
- **localStorage**: `floe.project.v1`, `floe.ui`, `floe.theme`, `floe.panes`, `floe.fileName`, `floe.filePath` (desktop), `floe.savedHash`.

## What changed for 1.0
- Shippable build pipeline for web and desktop with version and asset checks; content-hashed service-worker cache.
- Fixed Vercel config (`outputDirectory: dist`, explicit build, no framework detection) and added `.vercelignore` so `desktop/` is never uploaded.
- Added the missing pieces the app referenced: `manifest.webmanifest`, Font Awesome webfonts, the three UI fonts, SVG icons (`floe-icon.svg`, `floe-icon-maskable.svg`, `floe-mark.svg`).
- Complete Tauri 2 shell: dialogs, binary IPC, atomic saves, path grants, drag & drop, file associations, single instance, launch files, macOS menu, close guard.
- Desktop refresh re-reads changed files from disk; F5 / Ctrl+E / Ctrl+, work on Windows and Linux.
- UI no longer advertises Polars or a `floe` CLI when they are not installed: Settings hides the engine toggle, *Automate…* exports a Polars script, About shows "Built-in engine".
- `demo.html` uses an external script (works under the strict desktop CSP).

## Polars engine (desktop)
```
cd desktop && npm install
npm run dev:polars        # or: npm run build:polars
npm run test:engine       # cargo tests for floe-engine
```
CI builds both variants for every OS: `Floe_*` uses the built-in engine and `Floe-polars_*` adds Polars. The `polars` variant is about 30 MB larger.

**Polars covers:**
- Sources: CSV (UTF-8), Parquet, Arrow IPC, Excel sheets and ranges, entered data, query references.
- Columns: choose/remove/reorder, rename, change type (locale-aware, with per-cell error flags), split (delimiter, first, last, into rows), merge columns, custom and conditional columns, index, duplicate.
- Rows: filter, sort, distinct, keep duplicates, keep rows, promote headers, fill down/up.
- Values: replace values, replace/remove/keep errors, text transforms (except Proper), round.
- Reshaping and combining: group by, unpivot, pivot, merge (all join types), append, window columns.
- Formula functions: the text, number, date and logic functions listed in `PQ.Plan.FUNCS`.

**Runs on built-in (with the reason shown):**
- Sources: JSON, folders, Excel tables, named ranges, multi-sheet sources, merged-cell fill, non-UTF-8 CSV, pasted files.
- Steps: Sample, ClusterValues, Validate, ExpandJson, Transpose, DemoteHeaders, Custom SQL, Proper case, split by positions.
- Formula functions without a Polars mapping, such as `Text.Similarity`. Dialog previews also stay on built-in.

**Known differences:**
- Polars sorts text in plain character order, while the built-in engine uses natural, accent-insensitive order.
- With Polars, per-step row counts show only for the selected step.
- Division by zero gives null instead of a cell error.

## Not implemented / known limits
- On phones, mobile screenshots show dialog footers (Cancel / OK) below the bottom edge of the sheet. This happens in Parameters and Automate, so it isn't one dialog. Not yet measured on a real device. The CSS to check is `.modal` / `.modal-back` in the `max-width: 760px` block.
- The `floe` CLI runs on the built-in JS engine (Node). A native Rust CLI on `floe-engine` is not built yet.
- The Rust code (`floe-engine` and the Tauri shell) has not been compiled yet. The first CI run may report API-signature errors, especially against Polars 0.46.
- Builds are unsigned; macOS Gatekeeper and Windows SmartScreen will warn until signing is configured.
- No auto-updater yet.
- Parquet filter pushdown uses row-group min/max statistics only. It doesn't use page indexes or bloom filters, and it is off when a timestamp or nested column is read, because those types are inferred from the values. Previews don't prune either. They already stop after the first row groups.
- On desktop, Parquet files that fall back to the built-in engine are still read whole by the shell.
- `Text.Similarity` has no Polars equivalent; codegen emits a placeholder.
- Database sources.

## Roadmap
The full step-by-step plan for web, desktop and the optional Polars engine is in `docs/PLAN.md`.

## Next steps
1. Fix the first CI compile errors in `floe-engine` / the Tauri shell, then add signing secrets (see `docs/SIGNING.md`).
2. Native `floe` CLI binary on `floe-engine` (Polars), reusing the `scripts/floe.mjs` command surface.
3. Ranged reads from the Tauri shell (`read_file_range`) so desktop built-in fallbacks also stream Parquet.
4. Page-index and bloom-filter pushdown in `js/parquet.js`, plus pruning for previews.

## License
MIT. Bundled: SheetJS CE (Apache-2.0), AlaSQL (MIT), apache-arrow (Apache-2.0), hyparquet / hyparquet-writer / hyparquet-compressors (MIT), Font Awesome Free (icons CC BY 4.0, fonts OFL, code MIT), Instrument Sans, Source Serif 4 and JetBrains Mono (OFL).
