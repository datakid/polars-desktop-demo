# Floe 1.x — Build Plan (Web + Desktop)

Status: plan only. Nothing in this document has been implemented yet unless marked ✅.
Date: 2026-10-03

---

## 0. The short version

| Release | Web | Desktop | Needs Rust compile? |
|---|---|---|---|
| **1.0** | Built-in JS engine, Polars code removed, new engine indicator | Tauri shell running the same built-in engine | Shell only (local **or** GitHub Actions) |
| **1.1** *(optional)* | Unchanged | Adds a native **Polars engine** (`floe-engine` sidecar) with automatic fallback to built-in | Yes (local **or** GitHub Actions) |

Key principles:
1. **1.0 must ship without the Polars engine.** The Polars work is a separate, optional 1.1 track. If it never compiles, 1.0 is still a complete product.
2. **One UI, two engines, zero surprises.** The user always sees which engine ran, how long it took, and whether the result is a sample or the full data.
3. **No feature regression from the engine choice.** Anything Polars can't do runs on the built-in engine automatically, and the UI says why.

### About "we might have no way of compiling Rust"
- The **Tauri desktop shell is Rust too.** Without *any* Rust compile, there is no desktop installer at all — only the web app.
- You don't need Rust on your own machine. **GitHub Actions** (free for public repos, minutes-based for private) compiles Rust for macOS, Windows and Linux. The workflow `.github/workflows/desktop.yml` already exists for this.
- So there are three compile paths, chosen per release:

| Path | What you need | What you get |
|---|---|---|
| **A. Local** | Rust stable + Tauri prerequisites on your machine | Fast iteration, `npm run dev` |
| **B. CI only** | A GitHub repo; push a tag | Installers as draft release assets; slower feedback (≈10–25 min per build) |
| **C. None** | Nothing | Web app only (Vercel). Desktop is postponed. |

Path B is the realistic default if you can't install Rust. Every Rust step below lists how to verify it **using CI only**.

---

## 1. Where the code is today (baseline)

✅ = already in the repo after the last session.

| Area | State |
|---|---|
| ✅ Built-in engine | `js/util.js, expr.js, io.js, steps.js, engine.js, engine-ext.js, host.js, worker.js`. Runs in a Web Worker. 78 golden tests pass (`tests.html`), UI E2E passes (`tests-ui.html`). |
| ✅ Web deploy | `scripts/build-web.mjs` → `dist/`, `vercel.json` (build + output `dist`), `.vercelignore` (excludes `desktop/`, `.github/`, …). |
| ✅ Tauri shell | `desktop/src-tauri/` with dialogs, binary file IPC, atomic save, path grants, drag & drop, file associations, single instance, macOS menu, close guard. **Never compiled yet.** |
| ⚠️ Polars adapter | `js/native-engine.js` — client for a Rust engine that **does not exist**. Loaded on the web too (inert, but dead weight and confusing). |
| ⚠️ Branding | Some copy still implies Polars runs ("Polars desktop" tagline was changed, but Settings/About/status logic still branch on `UI.NativeEngine`). |
| ⚠️ Engine visibility | Status bar shows only a dot + "Starting/Idle/Busy". The user cannot tell which engine ran or why. |

### Engine protocol (shared contract — both engines must honour it)
Calls go through `UI.Engine.call(op, msg)` in `js/ui/core.js`.

| Op | Purpose | Built-in | Polars (1.1) |
|---|---|---|---|
| `init`, `listFiles`, `addFile`, `updateFile`, `removeFile`, `loadSamples`, `storageInfo`, `clearCache` | File workspace | ✅ | never (always built-in) |
| `setProject` | Send project JSON | ✅ | ✅ (with `files: {fileId: path}`) |
| `evaluate {qid, upto, mode, draft?}` | Run a query | ✅ | ✅ when eligible, no draft |
| `page {resultId, offset, count}` | Rows for the grid | ✅ | ✅ (Arrow IPC bytes) |
| `profile`, `distinct` | Column panel / filter menu | ✅ | ✅ for native results |
| `schemaBefore`, `querySchema`, `mergeStats`, `suggestSteps`, `inspectFile`, `clusters`, `overview` | Dialog helpers on preview samples | ✅ | never (always built-in) |
| `exportQuery {qid, format}` | Export | ✅ | ✅ writes directly to a path |
| `refreshAll` | Run all outputs | ✅ | ✅ per query when eligible |

---

## 2. WEB TRACK — release 1.0

**Goal:** the web app is lean (no desktop-only code shipped), honest (no Polars claims), and shows the running engine in a sleek, intuitive way.

**Engine decision for the web: built-in JS engine only.**
Why not Polars or DuckDB in the browser:
- Polars has no officially supported browser/WASM build; community builds are large (tens of MB), single-threaded without cross-origin isolation, and would need COOP/COEP headers that break other things.
- DuckDB-WASM works but is ~6–30 MB, has SQL semantics that differ from Floe steps (per-cell errors, locale casts, collation), and would be a second engine to keep in parity.
- The built-in engine already handles the target workload (hundreds of thousands of rows, 250 MB file cap) and is fully tested.
- Revisit only if users regularly hit the 250 MB cap (see §6, "Later").

### W1 — Remove desktop-only engine code from the web bundle
Steps:
1. `index.html`: delete `<script src="js/native-engine.js">`.
2. `js/platform.js` → `P.init()`: when `native` is true, load `js/native-engine.js` dynamically (script tag, await load) **before** `UI.NativeEngine.init()` is called.
3. Introduce a tiny stub so web code never touches `UI.NativeEngine` directly:
   - `js/ui/core.js`: `UI.NativeEngine = UI.NativeEngine || { ready: false, available: () => false, status: () => ({ ready: false }), shouldRun: () => false, cancel() {}, init: async () => false };`
   - `App.boot` keeps calling `UI.NativeEngine.init()` (no-op on web).
4. `scripts/build-web.mjs`: for `--target web`, skip `js/native-engine.js`.
5. `sw.js` CORE list: remove `./js/native-engine.js`.
6. Grep check (must return nothing in `dist/` for web): `grep -R "engine_status\|engine_call\|native-engine" dist/js/ui dist/index.html`.

Done when: web `dist/` has no `native-engine.js`; desktop `desktop/dist/` still has it; both test pages pass.

### W2 — Every result says which engine produced it
Steps:
1. `js/host.js` `H.evaluate`: add `engine: 'builtin'` to the returned object.
2. `js/native-engine.js` `N.call('evaluate')`: return `engine: 'polars'` (rename from current `r.engine = 'polars'` — keep the same key).
3. `js/ui/core.js` `Engine.call`: when native is skipped or falls back, attach `route` to the result:
   ```
   route: { engine: 'builtin' | 'polars', reason: null | string, step: null | number }
   ```
   Reasons (fixed vocabulary, used in UI copy):
   - `web` — running in a browser
   - `not-installed` — desktop, engine not bundled/available
   - `disabled` — user chose "Built-in only" in Settings
   - `preview-draft` — a step dialog is open (live preview always uses built-in)
   - `unsupported-step` — with `step` index and step type
   - `unsupported-source` — Excel table/named range/multi-sheet, folder, pasted data without a path
   - `native-error` — Polars failed; built-in result shown instead
4. `App.refresh` stores `App.lastRun.route`.

Done when: `App.lastRun.route` is set after every evaluate on web (`{engine:'builtin', reason:'web'}`).

### W3 — Engine indicator (the "sleek, intuitive" part)
Placement: status bar, far left, replacing the current dot + "Starting" label. Same element on web and desktop.

**Chip anatomy** (one line, ~28 px tall, monospace numbers):
```
[●] Built-in · 42 ms · Sample 1,000
[●] Polars   · 18 ms · Full data
[●] Built-in · 61 ms · Full data   ⓘ   ← desktop fallback marker
```
- Dot colour = engine state: idle (muted), busy (clay accent, pulsing), restarting (warn).
- Engine name: `Built-in` or `Polars`. Never both.
- `ⓘ` only appears on desktop when Polars was available but not used.
- Busy state replaces the text with the current stage from progress (`Orders · Merged Queries…`) and an `Esc to cancel` hint.

**Click → popover** (anchored to the chip, closes on Esc/outside click):
- Title: "Built-in engine" / "Polars engine".
- One sentence on where it runs:
  - Built-in, web: "Runs in your browser. Data never leaves this device."
  - Built-in, desktop: "Runs inside Floe on this computer."
  - Polars: "Runs as a native process on this computer — faster on large files."
- Reason line (from W2 `route.reason`), plain language, e.g. "Step 6 *Validated Rows* isn't supported by Polars yet, so this query ran on the built-in engine."
- Facts: rows × columns, time, sample/full, cached steps `4/7`.
- Desktop only: a segmented control **Auto | Built-in only** (same setting as Settings, see W4), and when relevant a link "Run with Polars anyway after removing step 6" → selects that step.

**Per-step hint** (desktop only): in the Applied Steps list, steps that block Polars get a small outline badge `JS` with tooltip "This step runs on the built-in engine". No badge on web (everything is built-in, so it would be noise).

Files: `index.html` (status bar markup), `css/app.css` (chip, popover, pulse), `js/ui/app.js` (`renderEngineState`, `renderStatus`, new `engineChip()`), `js/ui/core.js` (popover reuse of `UI.menu`/modal helpers).

Accessibility: chip is a `<button>` with `aria-haspopup="dialog"`, `aria-live="polite"` on the text, popover focus-trapped, colour never the only signal (engine name is text).

Mobile (≤ 760 px): chip shows `Built-in · 42 ms` only; popover becomes a bottom sheet (existing modal style).

Done when (screenshot-verified at desktop and mobile viewports):
- Web chip reads `Built-in · <ms> · Sample <n>` after loading the demo, `Full data` after "Run on full data".
- Popover opens, explains, closes with Esc.
- No `ⓘ`, no `JS` badges, no "Auto | Built-in only" control on web.

### W4 — Copy & settings cleanup
| Place | Web | Desktop (no engine) | Desktop (Polars available) |
|---|---|---|---|
| Settings → Engine | hidden | "Built-in (Polars engine not installed)" — read-only | **Auto** (default) / **Built-in only** |
| About badges | `Web` · `Built-in engine` | `Desktop` · `Built-in engine` | `Desktop` · `Polars x.y` |
| File menu | "Automate…" → Python export | same | "Automate…" (CLI only if a CLI ships later) |
| Python export header | "generated by Floe 1.0.0" | same | same |
| Welcome privacy line | "Runs in your browser…" | "Runs on this computer…" | same |

Also: remove every remaining user-visible "Polars desktop" string; keep "Polars" only where it's literally true (codegen output, Polars chip, About when installed).

### W5 — Web performance budget (measure, don't guess)
Measured in `tests-ui.html` with `performance.now()` and logged as `E2E perf …` lines. Targets on a mid-range laptop, Chrome:

| Scenario | Target |
|---|---|
| Cold start to interactive (demo) | < 1.5 s |
| Preview evaluate (1,000 rows, 8 steps), cache miss | < 150 ms |
| Edit last step, cache hit on earlier steps | < 50 ms |
| Full run, `orders.csv` 60k rows + merge + group | < 1.5 s |
| Parquet export 50k rows | < 1 s |

If a target fails: profile in DevTools, fix the hot path in the engine, add a golden test for the fixed step. No new engines.

### W6 — Tests
1. `tests.html`: unchanged (78 must still pass).
2. `tests-ui.html`: add
   - `E2E engine chip <text>` → assert contains `Built-in`.
   - `E2E route <reason>` → assert `web`.
   - `E2E perf …` lines (W5).
3. Build check: `node scripts/build-web.mjs --target web` and `--target desktop` both succeed (already in `.github/workflows/web-check.yml`).

### W7 — Deploy web 1.0
1. `node scripts/build-web.mjs --target web` locally (or let Vercel run it).
2. Vercel project: root = repo root, Framework Preset "Other", leave Build/Output overrides **off** (vercel.json wins).
3. Smoke test the live URL: demo loads, chip shows, offline reload works, `version.json` shows `1.0.0`.

**Web 1.0 acceptance criteria**
- [ ] No desktop engine code in the web bundle.
- [ ] Engine chip + popover on desktop and mobile layouts.
- [ ] No false Polars claims anywhere on web.
- [ ] 78/78 golden tests, UI E2E green, perf targets met or documented.
- [ ] Live on Vercel with `version.json` = 1.0.0.

Estimated effort: **1.5–2.5 days.**

---

## 3. DESKTOP TRACK — release 1.0 (shell, built-in engine)

**Goal:** a signed-or-unsigned installer for macOS, Windows, Linux that runs the same UI and built-in engine, with native file handling. No Polars.

### D1 — First successful shell build
Steps:
1. Choose compile path A or B (§0).
2. Path A: `cd desktop && npm install && npm run dev`.
   Path B: push to GitHub, run the **Desktop build** workflow manually (`workflow_dispatch`).
3. Fix compile errors in `desktop/src-tauri/src/lib.rs` (expected: small API mismatches with the exact Tauri 2.x version — e.g. dialog `FilePath` conversion, `set_parent`, `Request::body`). Pin versions in `Cargo.toml` once green (`tauri = "=2.x.y"` etc.) and commit `Cargo.lock`.
4. Path B tip: add a fast job `cargo check --manifest-path desktop/src-tauri/Cargo.toml` on `ubuntu-22.04` that runs on every push (≈3–5 min with cache). Use it as your "compiler" when you can't compile locally.

Done when: CI produces `.dmg`, `.msi`/`.exe`, `.deb`/`.AppImage` artefacts.

### D2 — Desktop smoke test checklist (manual, ~20 min per OS)
- [ ] App opens, demo loads, chip reads `Built-in · … ` with About = `Desktop`.
- [ ] Open data (dialog), Open folder, drag & drop a CSV and a `.floe`.
- [ ] Double-click a `.floe` in Finder/Explorer opens it (file association); second launch focuses the existing window.
- [ ] Save writes in place; Save As; closing with unsaved changes shows Save / Don't save / Cancel.
- [ ] Edit the source CSV on disk → F5 reloads changed file.
- [ ] Export xlsx/csv/parquet/arrow via native Save dialog.
- [ ] macOS menu items all work; Ctrl/⌘ shortcuts work on Windows/Linux.

### D3 — Packaging
1. Icons: `npm run icons` (from `images/floe-icon.svg`).
2. Versions in lock-step: root `package.json`, `js/util.js` `PQ.VERSION`, `desktop/package.json`, `tauri.conf.json`, `Cargo.toml` — the build script already fails on mismatch for the first three + tauri.conf; add `Cargo.toml` to that check.
3. Signing (optional for 1.0, recommended before public release):
   - macOS: Apple Developer ID cert + notarisation secrets (`APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`) in tauri-action.
   - Windows: code-signing cert (or Azure Trusted Signing) in tauri-action.
   - Unsigned builds work but show Gatekeeper/SmartScreen warnings — document that in the release notes.
4. Release: tag `v1.0.0` → draft release → test → publish.

**Desktop 1.0 acceptance criteria**
- [ ] Installers for 3 OSes from CI.
- [ ] D2 checklist passes on at least macOS + Windows.
- [ ] Engine chip says `Built-in`; Settings shows "Polars engine not installed" (read-only); no Polars claims elsewhere.

Estimated effort: **1–2 days** (mostly waiting for CI and fixing first-compile errors).

---

## 4. DESKTOP TRACK — release 1.1 (OPTIONAL): native Polars engine

**Goal:** large files and heavy steps run in Polars on the desktop, with identical results to the built-in engine for supported steps, and automatic fallback for everything else.

**Gate before starting:** Desktop 1.0 compiles in CI (D1 done). If not, do not start 1.1.

### 4.1 Architecture decision: sidecar process (recommended)
| Option | Pros | Cons |
|---|---|---|
| **Sidecar binary `floe-engine`** ✅ | Crash isolation (a Polars panic never kills the window); **cancel = kill the process**; app shell builds even if the engine doesn't (optional by construction); same binary can become the `floe` CLI later | IPC framing; bundle per target triple |
| In-process library | Simpler IPC | Panics/OOM kill the app; Polars `collect()` can't be cancelled cleanly; heavier shell compile every time |

Layout:
```
desktop/
  Cargo.toml                 workspace = ["src-tauri", "engine"]
  engine/                    crate "floe-engine" (bin + lib)
    src/main.rs              stdio loop
    src/protocol.rs          frames, request/response types
    src/project.rs           serde types for project, queries, steps (mirror of steps.js)
    src/source.rs            csv, json/ndjson, parquet, ipc, excel (calamine)
    src/cast.rs              locale-aware casts + error masks
    src/expr/{lexer,parser,check,compile}.rs   Floe formula → polars Expr
    src/steps.rs             one fn per step kind
    src/eval.rs              per-step fingerprints, LRU cache, states
    src/profile.rs           quality, profile, distinct
    src/export.rs            csv, parquet, ipc (polars), xlsx (rust_xlsxwriter)
    tests/parity.rs          golden parity tests (see 4.6)
  src-tauri/src/engine.rs    supervisor: spawn, frame I/O, request map, kill/respawn
  src-tauri/tauri.engine.conf.json   adds bundle.externalBin = ["binaries/floe-engine"]
  scripts/build-engine.mjs   cargo build -p floe-engine --release, copy to binaries/floe-engine-<target-triple>
```
- `npm run build` → shell only (1.0 behaviour, engine reports unavailable).
- `npm run build:native` → engine + `tauri build --config src-tauri/tauri.engine.conf.json`.
- CI: a second matrix job "Desktop build (with engine)" that is allowed to fail without blocking the shell release.

### 4.2 Wire protocol (shell ⇄ engine over stdin/stdout)
Frame: `u32 LE length` · `u8 kind` (0 = JSON, 1 = Arrow IPC) · `u32 LE request id` · payload.

Tauri commands exposed to the UI (names already used by `js/native-engine.js`):
| Command | Request | Response |
|---|---|---|
| `engine_status` | — | `{available, info: {version, polars, supported: [stepType…], sources: [...]}}` |
| `engine_call {op:'setProject'}` | `{project, files: {fileId: absPath}}` | `{ok}` |
| `engine_call {op:'canRun'}` | `{qid}` | `{ok, reason?, step?, stepType?}` |
| `engine_call {op:'evaluate'}` | `{qid, upto, mode}` | `{resultId, n, schema:[{name,type}], states:[{ok,error,rows,cols,ms,cached}], truncated, failedAt, ms, quality:[{valid,error,empty}]}` |
| `engine_page` | `{resultId, offset, count}` | Arrow IPC bytes; error masks as bool columns `__err_<col>` |
| `engine_call {op:'profile'\|'distinct'}` | `{resultId, col}` | same JSON shape as built-in `E.profile` / `E.distinctValues` |
| `engine_call {op:'export'}` | `{qid, format, path}` | `{rows, bytes}` — engine writes the file itself |
| `engine_cancel` | — | kills + respawns the process; pending calls reject with `cancelled` |

Supervisor rules: start lazily on first `engine_status`; if the binary is missing → `available:false`; restart on crash (max 3/min, then mark unavailable for the session and show a toast); 30 s handshake timeout.

### 4.3 Semantics mapping (the hard part — must match built-in)
| Floe concept | Built-in behaviour | Polars implementation |
|---|---|---|
| Types `text, number, int, bool, date, datetime, any` | JS values | `String, Float64, Int64, Boolean, Date, Datetime(ms, UTC), String` (`any` → String) |
| **Per-cell errors** | `CellError` objects | Companion bool column `__err_<col>`; set by ChangeType (non-strict cast result null **and** source not null); dropped/renamed with its column |
| Error-consuming steps | RemoveErrors, KeepErrors, ReplaceErrors | Filter/replace using masks |
| Errors through formulas | propagate | **Not supported in 1.1** → `canRun` returns `unsupported-step` if a formula references a column that may carry a mask |
| Locale number cast | `PQ.parseNumber` (currency, %, (neg), thousands) | `str.replace_all` pipeline per locale, then `cast(Float64, strict=false)`; `%` and `(x)` handled with `when/then` |
| Locale date cast | ISO, D/M/Y or M/D/Y by locale, "12 Mar 2026", Excel serials | `coalesce` of `str.to_date(fmt, strict=false)` over an ordered format list per locale; numeric → serial conversion |
| Preview mode | `head(previewRows)` **at the source** | `.head(n)` on each scan before steps |
| Text sort | `Intl.Collator` numeric, case/accent-insensitive | Sort by a hidden key `lower(strip_accents(x))`; **numeric-aware ordering is a known difference** (document it, or treat text sort as unsupported if strict parity is required) |
| `Number.Round` | banker's rounding | `round(d)` with half-to-even mode (verify in the pinned Polars version) |
| Nulls in sort | nulls last by default | `nulls_last=true` |
| Distinct / GroupBy order | first-seen order | `maintain_order=true` |
| Merge | hash join, coalesce keys for right/full | `join(..., coalesce=true)` for right/full, suffix rules mirrored from `joinOutput` |
| Append | diagonal by name | `concat(..., how=diagonal_relaxed)` |

Rule: if any row in this table can't be matched for a step's inputs, `canRun` says no and the built-in engine runs it. Correctness beats speed.

### 4.4 Step coverage, in delivery order
**Phase P1 — core (biggest speed win):**
Source (csv, parquet, arrow/ipc, json/ndjson, Excel single sheet or A1 range), SelectColumns, ReorderColumns, RemoveColumns, Rename, ChangeType, Filter, Sort, Distinct, KeepDuplicates, KeepRows, FillDown, FillUp, ReplaceValues, TextTransform, RoundNumbers, AddColumn, ConditionalColumn, IndexColumn, DuplicateColumn, GroupBy, Merge, Append, Checkpoint.

**Phase P2 — reshaping & errors:**
Source = reference to another query, Source = folder, PromoteHeaders, DemoteHeaders, SplitColumn, MergeColumns, Unpivot, Pivot (≤ 500 output columns, same limit), Window, RemoveErrors, KeepErrors, ReplaceErrors.

**Phase P3 — rare:**
ExpandJson, Transpose (≤ 5,000 rows, same limit). CustomSql **off by default** (Polars SQL dialect ≠ AlaSQL) — opt-in per step later.

**Always built-in (never native):** Sample (RNG differs), ClusterValues, Validate, Excel Tables / named ranges / multi-sheet sources, pasted/entered data, all dialog helper ops.

**Formula functions:** map every function in `js/expr.js` + `engine-ext.js` (`Text.*`, `Number.*`, `Date.*`, `#date`, `Coalesce`, `Value.IsNull`, `List.Contains`, regex functions, `Text.RemoveDiacritics`, `Text.Fingerprint`, `Number.Clamp`). Not supported natively → step falls back: `Text.Similarity`, `Value.IsError`. `try … otherwise` maps to `coalesce` (only valid because errors only come from casts in 1.1).

### 4.5 UI integration
1. `js/native-engine.js`: keep routing logic; add `route.reason` from `canRun` (W2 vocabulary).
2. Results from Polars: `fp` is `null` → Overview tab and Similar-values suggestions run on the built-in preview sample (existing behaviour in `native-engine.js` for suggestions; extend to overview).
3. Exports on desktop with Polars: pick path with `pick_save`, then `engine_call export` (no bytes through the webview).
4. Settings → Engine: Auto / Built-in only (persisted `floe.nativeEngine`).
5. Chip + popover + `JS` step badges as specified in W3.

### 4.6 Parity testing (proves "same results")
1. `scripts/export-fixtures.mjs` (Node, no browser): loads the built-in engine files with a `self` shim, runs every golden test project from `js/tests.js` plus the demo project, writes `desktop/engine/tests/fixtures/<name>.json` = `{project, files(base64 or path), expected:{schema, rows}}`.
2. `tests/parity.rs`: for each fixture, run the native engine, compare schema + rows with tolerance `1e-9` for floats and documented exceptions (text sort collation).
3. CI: `cargo test -p floe-engine` on Linux (fastest runner) on every push to the engine.
4. Benchmarks: `cargo bench` or a simple timed test on a generated 5M-row CSV; target ≥ 5× faster than built-in on full runs.

### 4.7 Milestones
| Milestone | Deliverable | Done when | Verify without local Rust |
|---|---|---|---|
| M0 | Workspace + empty engine, `engine_status` handshake | Chip shows `Polars` available in a native build | CI "with engine" job builds; download artefact, open About |
| M1 | Source + 6 basic steps, `page`, Arrow decode | Demo `orders` (up to ChangeType) runs on Polars, grid identical | Parity tests in CI |
| M2 | Rest of P1 + formulas | All P1 parity fixtures green | CI |
| M3 | Exports + profile/distinct | Export 1M rows CSV/Parquet/xlsx from Polars | CI artefact manual test |
| M4 | P2 steps | P2 fixtures green | CI |
| M5 | Polish: cancel, crash restart, fallback reasons, perf | D2 checklist + "kill during run" + 5× benchmark | CI + manual |

### 4.8 Polars crate features (starting point, adjust to pinned version)
`lazy, csv, parquet, ipc, json, strings, regex, temporal, dtype-date, dtype-datetime, round_series, is_in, cum_agg, rank, pivot, diagonal_concat, concat_str, string_pad, abs, sign, mode, dtype-struct, cross_join, semi_anti_join`. Plus `calamine` (Excel), `rust_xlsxwriter` (xlsx export), `serde`, `serde_json`, `unicode-normalization`.
Expect: first compile 10–20 min, installer +25–40 MB.

**Desktop 1.1 acceptance criteria**
- [ ] Shell still builds and ships if the engine job fails.
- [ ] All P1 (+P2 if in scope) parity fixtures pass.
- [ ] Every fallback shows a correct reason in the chip popover.
- [ ] Cancel (Esc) during a long Polars run returns control < 1 s.
- [ ] ≥ 5× faster than built-in on the 5M-row benchmark full run.

Estimated effort: **P1 ≈ 8–12 days, P2 ≈ 4–6 days, P3 ≈ 2 days**, plus CI turnaround if compiling only in CI.

---

## 5. Order of work (recommended)

1. **W1 → W2 → W3 → W4 → W6 → W5 → W7** — web 1.0 live.
2. **D1 → D2 → D3** — desktop 1.0 installers (built-in engine).
3. *(Optional)* **M0 → M1** — prove the Polars pipeline end to end before investing further.
4. *(Optional)* **M2 → M5** — desktop 1.1.

Stop points that still leave a shippable product: after step 1 (web only), after step 2 (web + desktop on built-in), after any milestone in step 4 (Polars covers more queries, the rest falls back).

---

## 6. Risks & mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| No local Rust toolchain | Slow feedback | Path B: `cargo check` CI job on every push; small PRs |
| Tauri API drift breaks first compile | D1 delay | Pin exact versions + `Cargo.lock` once green |
| Polars result differs from built-in | User trust | `canRun` refuses anything not covered by parity fixtures; parity CI |
| Polars version churn (API renames) | Engine breaks on update | Pin Polars version; upgrade deliberately with parity run |
| Installer size grows | Download friction | Engine is optional build; release "Floe" and "Floe + Polars" builds if needed |
| Unsigned installers | OS warnings | Document; add signing before public launch |
| Web users exceed 250 MB | Can't open file | Message suggests desktop app; revisit DuckDB-WASM only with real demand |

---

## 7. Later (not in 1.x)
- `floe` CLI from the same `floe-engine` binary (`floe run project.floe --output ./out`).
- Auto-updater (`tauri-plugin-updater`, signed `latest.json`).
- Streaming Parquet (row groups, column projection) in the built-in engine.
- Optional DuckDB-WASM for very large files on the web.

---

## 8. Decisions needed from you
1. Compile path for desktop: **A (local)**, **B (CI only)** or **C (web only for now)**.
2. Is desktop 1.1 (Polars) in scope now, or after 1.0 ships?
3. Text sort parity: accept the documented collation difference in Polars, or keep text sorts on the built-in engine?
4. Signing certificates: available now, or ship 1.0 unsigned?
