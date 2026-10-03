# Floe — build plan (web + desktop)

> **Status (1.1):** all code steps are done: W1–W4, D2 (opt-in signing, `docs/SIGNING.md`), P0–P6, P7 tooling (`bench.html`, `docs/BENCH.md`).
> Steps that need you: W0/W5 (deploy and check the live URL), D0 (first CI compile; send me the errors), D1 (manual smoke test on an installed build), P7 numbers on your machine.

This plan lists the steps in order. Each step names the files it touches, what to change, and when it counts as done. Work through it top to bottom. Each track ships on its own:

| Track | What it delivers | Needs Rust on your machine? | Required for 1.0? |
|---|---|---|---|
| **W — Web** | Clean web app with only the built-in engine, an engine indicator, measured speed-ups, a verified Vercel deploy | No | **Yes** |
| **D — Desktop shell** | Tauri app running the same built-in engine, with native files, menus, file associations | No: GitHub Actions compiles it | **Yes** |
| **P — Polars engine** | A faster desktop engine for supported queries, falling back to built-in automatically | No: GitHub Actions compiles it | **Optional** (1.1 if it slips) |

The rule that keeps this safe: **tracks W and D never depend on P.** P sits behind a Cargo feature flag (`polars-engine`) that is off by default. If P never compiles, 1.0 still ships.

---

## 0. Decisions already made

1. **The web uses only the built-in JavaScript engine.** Polars has no supported browser build; the web gets faster through targeted work on the existing engine (W4). Very large files are out of scope for Floe.
2. **"Export to Python (Polars script)" stays on both platforms.** It generates code. It isn't an engine and works everywhere.
3. **The desktop runs the built-in engine by default.** If the Polars engine is present (track P), each query uses Polars when it can and the built-in engine otherwise. The user can always see which one ran.
4. **Formula semantics live in one place: JavaScript.** If track P happens, JS lowers each query into a small JSON plan (with formula ASTs already parsed), and Rust only executes that plan. Rust never parses formulas or re-implements step logic it doesn't need. This cuts the Rust code to roughly 1,500 lines and keeps behaviour consistent.
5. **No local Rust toolchain is assumed.** All Rust is compiled by `.github/workflows/desktop.yml`. Local `cargo` is a nice-to-have.

---

## 1. Where the code stands today

Verified in the editor sandbox:
- The engine golden tests pass (78/78) and the UI end-to-end test passes. The app renders on desktop and mobile widths.

Written but **not yet run or compiled**:
- `scripts/build-web.mjs`, `vercel.json` (build into `dist/`), `.vercelignore`.
- `desktop/src-tauri/*` (Rust shell: dialogs, file I/O with path grants, drag & drop, file associations, single instance, macOS menu, close guard).
- `.github/workflows/desktop.yml`, `.github/workflows/web-check.yml`.

Polars code that still exists:
- `js/native-engine.js`: an adapter for a Polars engine that was never built. It does nothing unless the shell's `engine_status` reports `available: true`; today the shell always reports `false`.
- References to `UI.NativeEngine` in `js/ui/core.js` (`Engine.call` router, `Engine.cancel`), `js/ui/app.js` (boot, status bar), and `js/ui/dialogs.js` (Settings, About, Automate).

---

## Track W — Web (required)

### W0. Prove the current build and deploy work
**Goal:** a green Vercel deploy before changing anything else.

1. Locally: `node scripts/build-web.mjs --target web`. It should print `[floe build] web 1.0.0 (<hash>) → dist · N files`.
2. `npx serve dist -l 4173`, then open `http://localhost:4173/`, `/demo.html` and `/tests.html` (expect `78 passed`).
3. Push to GitHub. `web-check.yml` must pass.
4. Vercel:
   - Import the repo with root directory = repo root.
   - Framework preset "Other".
   - Leave every build override **off** so `vercel.json` is used.
   - Deploy.
5. On the deployed URL, check:
   - `/version.json` shows the build hash.
   - DevTools → Application → Service Workers: `sw.js` is active, and its cache name is `floe-1.0.0-<hash>`.
   - DevTools → Network → response headers on `/`: `content-security-policy` is present.
   - The Vercel deployment's source tab shows **no `desktop/` folder**.
   - Reload offline: the app still opens.

**Done when:** all five checks pass on the live URL.
**If it fails:** the build log names the missing file or version mismatch. Fix that file only.

### W1. Remove native-engine code from the web bundle
**Goal:** the web app ships no Polars or desktop-engine code and makes no claims about it.

1. **`js/ui/core.js`:** add a stub before the engine supervisor, used whenever the real adapter isn't loaded:
   - `UI.NativeEngine = { ready: false, info: null, available: () => false, status: () => ({ ready: false }), shouldRun: () => false, call: () => Promise.reject(new Error('no native engine')), cancel() {}, init: async () => false, setEnabled() {} }`
   - Define it only if `UI.NativeEngine` is undefined.
2. **`index.html`:** delete `<script src="js/native-engine.js">`.
3. **`js/platform.js`:** in `P.init`, when `native` is true, inject `js/native-engine.js` with a `<script>` element and await its `onload` before boot continues.
   - `App.boot` already awaits `PQ.Platform.init()` before `UI.NativeEngine.init()`, so the order stays correct.
4. **`sw.js`:** remove `'./js/native-engine.js'` from `CORE`.
5. **`scripts/build-web.mjs`:** add `js/native-engine.js` to a `WEB_SKIP` set, used like `DESKTOP_SKIP` but for the web target.
6. **UI strings:** `grep -rn "Polars" js/ui`. Wording may mention Polars only in two places:
   - the Python export ("Polars script");
   - the desktop engine UI, which only renders when `PQ.Platform.native && UI.NativeEngine.ready`.
7. **`README.md`:** the Engines section says "Web: built-in engine only".

**Done when:**
- `grep -c native-engine dist/index.html dist/sw.js` returns 0 for both.
- `dist/js/native-engine.js` does not exist.
- Engine tests are 78/78 and the UI end-to-end test passes.
- No visible text on the web mentions a Polars engine.

### W2. Engine indicator (web and desktop)
**Goal:** users always know which engine ran, how long it took, and on how much data. It should look like a small, quiet status element, not a banner.

**Design: one chip in the status bar plus a popover.**
- **Chip:** replaces the current `#engine-dot` and `#engine-label` in the footer. It reads, for example:
  - Web, idle after a run: `● Built-in · 42 ms · Sample 1,000`
  - Full data: `● Built-in · 1.8 s · Full`
  - Desktop with Polars: `● Polars · 18 ms · Full`
  - Desktop, Polars couldn't run the query: `● Built-in ↺ · 42 ms · Sample 1,000`. The `↺` means "fell back".
- **Dot colour:**
  - idle → `--ok`
  - busy → `--accent`, with a slow pulse (respect `prefers-reduced-motion`)
  - starting or restarting → `--warn`
  - last run failed → `--err`
- **Popover:** opens on click, Enter or Space; closes on Esc or outside click; `role="dialog"`, `aria-labelledby`. Rows:
  1. **Engine:** name + version. "Built-in (JavaScript)" or "Polars 0.xx".
  2. **Runs on:**
     - Web: "This device, in a background worker. Files never leave your browser."
     - Desktop: "This computer. Files are read from disk."
  3. **Last run:**
     - query name and step ("up to step 5 of 7");
     - data: sample of N rows, or full;
     - rows × columns out;
     - time;
     - cached steps ("4 of 5 reused").
  4. **Why this engine** (desktop only, when Polars is installed):
     - "All steps supported by Polars", or
     - "Step 4 'Validated Rows' isn't supported by Polars yet. Ran on built-in."
  5. **Actions:**
     - "Run on full data" or "Back to sample", which reuses `App.runFull` and `App.setMode('preview')`.
     - Desktop with Polars only: a "Prefer Polars" switch, which reuses `UI.NativeEngine.setEnabled`.
- **Mobile (≤ 760 px):**
  - The chip shrinks to the dot plus the engine name.
  - The popover opens as the existing bottom-sheet modal (`UI.modal`), not as a floating popover.

**Implementation:**
1. **`index.html`:**
   - Replace `<span><span class="engine-dot" id="engine-dot"></span><span id="engine-label">Starting</span></span>` with `<button type="button" id="engine-chip" class="engine-chip" aria-haspopup="dialog" aria-expanded="false"><span class="engine-dot"></span><span class="engine-name">Starting</span><span class="engine-meta"></span></button>`.
   - Remove `#st-time` and `#st-mode`. The chip shows both.
   - Keep `#st-rows` and `#st-cache`.
2. **`js/ui/core.js`:**
   - Record on `UI.Engine` after every `evaluate`:
     - `lastRun = { engine: 'built-in' | 'polars', fellBack: bool, reason: string | null, qid, upto, mode, ms, n, cols, truncated, cachedSteps, totalSteps, failed: bool }`
   - Set `fellBack` and `reason` in the router:
     - `reason` comes from the native `canRun` reply (track P), or `"Polars is turned off"` when the user disabled it.
3. **`js/ui/app.js`:**
   - Rewrite `renderEngineState` and `renderStatus` to render the chip from `UI.Engine.state` + `UI.Engine.lastRun`.
   - Add `engineDetails()`, which builds the popover with the existing `UI.h` and `UI.menu` or `UI.modal` helpers.
   - Remove the `st-time` and `st-mode` writes.
4. **`css/app.css`:**
   - `.engine-chip`: inherits footer font size, no border, `border-radius: 999px`, hover `--panel-3`.
   - `.engine-dot`: 7 px circle; the pulse keyframes go inside `@media (prefers-reduced-motion: no-preference)`.
   - `.engine-meta`: `--muted`, tabular numbers.
   - Mobile rule hides `.engine-meta`.
5. **`js/ui/dialogs.js`:**
   - The About dialog reuses the same engine line.
   - Settings shows the engine row only on desktop with Polars.
6. **`tests-ui.html`:** add three checks:
   - after the first evaluate, `#engine-chip .engine-name` reads `Built-in`;
   - clicking the chip opens a dialog containing `Last run`;
   - after `App.runFull()`, the chip meta contains `Full`.

**Done when:**
- The three new UI checks pass.
- Screenshots at desktop and mobile width show the chip with no overflow.
- Keyboard: Tab reaches the chip, Enter opens it, Esc closes it.
- Screen readers announce "Engine: Built-in, 42 milliseconds, sample of 1,000 rows" (an `aria-label` built from the same data).

### W3. Remove leftover "PQX" and "Polars desktop" wording
1. `grep -rn "PQX\|Polars desktop\|pq-compiler\|pq-worker\|crate pq" js css index.html`.
2. Rewrite the header comment of each file in one plain sentence about what the file does, or delete it.
3. Keep behaviour identical. Rerun both test pages.

**Done when:** the grep returns nothing and the tests pass.

### W4. Make the web engine faster, measured
**Goal:** faster on the files people actually open, with numbers before and after. No new engine.

1. **Benchmark page `bench.html`** (web build only; excluded from the desktop build and from `sw.js`):
   - Generates fixtures in the worker:
     - `orders_1m.csv` (1,000,000 rows × 8 columns, the same shape as the `orders.csv` sample);
     - `wide_100k.csv` (100,000 × 60);
     - `report.xlsx` (200,000 rows).
   - Runs five fixed pipelines:
     - **A** Source → ChangeType → Filter
     - **B** A → GroupBy (2 keys, sum/mean/count)
     - **C** A → Merge with customers → Sort 2 keys
     - **D** Source → Unpivot → Pivot
     - **E** Excel source → PromoteHeaders → ChangeType
   - Each runs 3 times (cold + 2 warm).
   - Prints median ms and peak `performance.memory` (Chromium) as a table, and lets you copy the results as JSON.
2. **Record the baseline** in `docs/BENCH.md`: machine, browser, numbers.
3. **Optimisations, in order.** Stop when the targets are met.
   1. **ChangeType numeric fast path:** when every value is a plain ASCII number, cast in a tight loop without regex. `PQ.parseNumber` already has a partial fast path; extend it to the `de-DE` decimal comma.
   2. **Typed numeric columns:**
      - After ChangeType to `int` or `number` with no errors, store the column as `Float64Array` plus a `Uint8Array` null mask, behind the same `Table` API (`get` returns an array-like).
      - GroupBy sum/mean/min/max, Sort, Filter comparisons and `E.quality` read typed arrays directly.
      - **Risk:** code that does `arr.slice()` or `arr.map` on columns. Wrap these through `mapCol` and `take`, and run all tests after each change.
   3. **Filter with a compiled predicate:** for simple formulas (`[col] op literal`, combined with and/or), compile to a closure over the raw column, skipping the generic row interpreter. Fall back to `Formula.evaluate` otherwise.
   4. **Streaming CSV preview:** in preview mode, parse only `previewRows + 1` records (already done). Make sure `decodeCached` doesn't decode a 200 MB file just to preview: decode the first 8 MB first, and decode in full only when running on full data.
   5. **Transferable pages:** send `page` results as columnar arrays rather than row arrays to cut postMessage cost. This needs a matching change in `grid.js`.
4. **Targets** (Chromium, mid-range laptop):
   - Preview of any pipeline under 150 ms after the first run.
   - Pipelines A and B on 1M rows, full data: at least 30% faster than the baseline.
   - No change in results: all 78 golden tests plus the UI test.

**Done when:** `docs/BENCH.md` shows before and after numbers, the targets are met (or the reason they can't be is written down), and the tests pass.

### W5. Web release checklist
1. Bump the version in **three** places: `package.json`, `PQ.VERSION` in `js/util.js`, `desktop/src-tauri/tauri.conf.json` (+ `desktop/package.json`, `Cargo.toml`). The build script refuses mismatches.
2. `node scripts/build-web.mjs --target web`, then run tests on `dist/`.
3. Deploy, then repeat the W0 checks on the live URL.
4. Tag `v1.0.0`.

---

## Track D — Desktop shell (required; compiled by CI)

This track ships the desktop app on the **built-in engine**. It needs no Polars.

### D0. First compile in CI (no local Rust)
1. On GitHub → Actions → "Desktop build" → **Run workflow** (`workflow_dispatch`).
2. Expect compile errors on the first run: the shell was written without a compiler.
   - Copy the **first** error block from the failing job's "tauri-action" step (`error[E…]` plus the 10 lines after it). Bring it back and fix only that error. Repeat.
   - Fix Linux first (it's the fastest job), then macOS, then Windows.
3. Likely first-run problems to check proactively:
   - `tauri-plugin-dialog` API names (`FilePath::into_path`, `set_parent`, `add_filter` argument types).
   - The `tauri::ipc::Request` body type (`InvokeBody::Raw`).
   - Capability identifiers (`core:window:allow-set-title`, `dialog:default`). Unknown ones fail at build time with a clear message.
   - The `icons/` folder: `ensure-icons.mjs` must run before `tauri build`. CI already does this.
4. Artifacts: each job uploads installers to a **draft release** when the run is for a tag. For `workflow_dispatch` runs, add an `actions/upload-artifact@v4` step after tauri-action that uploads `desktop/src-tauri/target/**/release/bundle/**` so you can download builds without tagging.

**Done when:** all four jobs (macOS arm64, macOS x64, Linux, Windows) are green and the installers can be downloaded.

### D1. Desktop smoke test (manual, about 20 minutes per OS)
Install the artifact and check:

| # | Action | Expected |
|---|---|---|
| 1 | Launch | Window titled "Floe", sample project button works, chip says `Built-in` |
| 2 | Open data → pick a CSV | Navigator opens; the file is listed with its real path |
| 3 | Edit the CSV in another app, press F5 | Toast "Reloaded 1 changed file"; grid updates |
| 4 | Save (Ctrl/⌘+S) | Save dialog first time, then silent saves; file on disk updates |
| 5 | Close with unsaved changes | Save / Don't save / Cancel; Cancel keeps the window open |
| 6 | Drag a `.xlsx` and a `.floe` onto the window | Project opens, file is added |
| 7 | Double-click a `.floe` in Finder/Explorer | App opens it; if already running, the existing window focuses and opens it |
| 8 | Export → Excel | Native save dialog; file opens in Excel |
| 9 | macOS menu: File → Export to CSV | Works; ⌘E exports Excel |
| 10 | Windows/Linux: F5, Ctrl+E, Ctrl+, | Refresh, export, settings |
| 11 | Try to read a path not granted (devtools: `__TAURI__.core.invoke('read_file',{path:'/etc/hosts'})`) | Rejected with the permission message |

**Done when:** all 11 rows pass on at least macOS and Windows.

### D2. Signing (not code, but required to ship to users)
- **macOS:** an Apple Developer ID certificate plus notarisation. Add the secrets `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`; tauri-action picks them up.
- **Windows:** an OV/EV code-signing certificate, or Azure Trusted Signing. Configure `bundle.windows.signCommand` or the certificate thumbprint.
- Without signing, the builds work but warn on first launch. That's acceptable for a beta, not for 1.0 general availability.

### D3. Auto-update (optional for 1.0)
- Add `tauri-plugin-updater`. Generate a key pair with `tauri signer generate` (CI can run the Tauri CLI; you don't need Rust for this).
- Add the public key to the config, the private key to CI secrets, and point the endpoint at the GitHub Releases `latest.json`.
- In the UI: Menu → "Check for updates…", desktop only.

---

## Track P — Polars engine for desktop (optional)

**Only start P after W and D0–D1 are done.** Everything here is behind the Cargo feature `polars-engine`. Building without the feature produces exactly the D-track app.

### P0. Shape of the solution
```
UI (JS)                                         Rust (Tauri, in-process)
───────                                         ────────────────────────
js/plan.js        lower(project, qid, upto)
                  → { ok:true, plan } | { ok:false, reason }
js/native-engine.js  engine_call('evaluate', {plan, files, mode})  →  floe-engine crate
                                                     plan → LazyFrame → collect (preview: head)
                     engine_page(resultId, offset, count)        ←  Arrow IPC bytes
                     engine_call('profile' | 'distinct' | 'export')
```
- **Why lower in JS:** the step catalog, formula parser, defaults and normalisation (`filterFormula`, `conditionalToFormula`, builder filters) already live in JS. Lowering means Rust receives a small, explicit, already-validated plan. Anything that can't be lowered never reaches Rust.
- **Why in-process rather than a sidecar:** no `externalBin` packaging and no IPC framing.
  - Cancel is "soft": the UI stops waiting, and the result is discarded using a generation counter.
  - A sidecar with hard kill can come in 1.2 if long runaway queries become a problem.

### P1. Plan format (JSON, versioned) — `js/plan.js`
Top-level object:

| Field | Meaning |
|---|---|
| `v` | `1` |
| `source` | One of the source kinds below |
| `ops` | List of operations (below) |
| `mode` | `"preview"` or `"full"` |
| `previewRows` | Row limit for preview |
| `locale` | Locale for number/date parsing |
| `params` | `{ name: value }` with typed values |

Source kinds:

| `source` | Fields |
|---|---|
| `csv` | `path`, `delimiter`, `header`, `skipRows`, `encoding: "utf8" \| "lossy"` |
| `excel` | `path`, `sheet`, `range?` (A1), `fillMerged` |
| `parquet` | `path` |
| `ipc` | `path` |
| `json` | `path`, `ndjson: bool` |
| `blank` | `columns`, `rows` |
| `query` | `plan` (nested, for references) |

Each `op` is `{ op, ...args }`:

| op | Args | Polars mapping |
|---|---|---|
| `select` | `cols` | `.select` |
| `drop` | `cols` | `.drop` |
| `reorder` | `cols` | select(cols ++ rest) |
| `rename` | `map: [[from,to]]` | `.rename` |
| `cast` | `changes:[{col,type,locale}], onError: error\|null\|fail` | string-clean + `cast(strict=false)`; error mask (see P3) |
| `filter` | `expr` (formula AST) | `.filter` |
| `sort` | `by:[{col,desc}]` | `.sort(…, nulls_last, maintain_order)` |
| `distinct` | `subset?` | `.unique(keep=first, maintain_order)` |
| `keepDuplicates` | `subset?` | `is_duplicated` over struct |
| `slice` | `mode` (`top`, `bottom`, `range`, `remove_top`, `remove_bottom`, `alternate`, `remove_blank`), `n`, `offset`, `keep`, `skip` | head/tail/slice/row-index filters |
| `promoteHeaders` | `row` | collect head → rename → slice (materializes) |
| `fill` | `cols, dir: down\|up` | `forward_fill`/`backward_fill` |
| `replace` | `cols, find, replace, wholeCell` | `replace` / `str.replace_all(literal)` / `fill_null` |
| `text` | `cols, op: upper\|lower\|trim\|clean\|proper` | `str.*` |
| `round` | `cols, digits` | `round` |
| `split` | `col, mode, delimiter, count, positions, trim` | `str.splitn` + `unnest` / `explode` |
| `merge` | `cols, sep, name` | `concat_str` |
| `addColumn` | `name, expr, castTo?` | `with_columns(expr.alias)` |
| `index` | `name, start, step, first` | `with_row_index` / `int_range` |
| `duplicate` | `col, name` | `alias` |
| `groupBy` | `keys, aggs:[{fn,col,name,sep}]` | `group_by(maintain_order).agg` |
| `unpivot` | `ids, values, var, val, dropNulls` | `.unpivot` |
| `pivot` | `on, index, values, agg` | collect → `pivot` (materializes; limit 500 columns, same as built-in) |
| `join` | `right: plan, how, on:[[l,r]], expand, prefix, castKeys` | `.join` (coalesce for full/right) |
| `append` | `others: [plan], strict` | `concat(diagonal_relaxed)` |
| `window` | `op, col, partition, orderBy, desc, n, name` | `cum_sum`/`rank`/`shift`/`rolling_mean` `.over` |
| `sql` | `sql, tables:{alias: plan}` | `SQLContext` |
| `checkpoint` | — | `collect().lazy()` |

**Formula AST:** exactly what `PQ.Formula.parse` already produces (`lit`, `col`, `param`, `list`, `un`, `bin`, `if`, `try`, `call`). Strip `s`/`e` offsets before sending to save bytes.

**Lowering rules (`lower()` returns `{ ok: false, reason }` when any of these hit):**
- Source is a folder, an Excel table/named range, or a multi-sheet pattern → `"Excel tables, named ranges and folder sources run on the built-in engine"`.
- File has no real path (added by paste or sample) → `"This file isn't on disk"`.
- The step is `Sample`, `ClusterValues`, `Validate`, `ExpandJson`, `Transpose`, `RemoveErrors`, `KeepErrors`, `ReplaceErrors`, `DemoteHeaders` → `"Step N '<name>' isn't supported by Polars yet"`.
- A formula uses a function without a Rust mapping (P3 list) → `"Formula function Text.Similarity isn't supported by Polars"`.
- A draft step is being previewed (dialog open) → silent fallback (dialogs stay on built-in for instant, cached previews).

**Tests for `plan.js`:** in `js/tests.js`, add `plan.*` tests: lowering every sample query either succeeds or gives the expected reason. These run in the browser and need no Rust.

### P2. Rust crate layout (feature-gated)
```
desktop/src-tauri/
  Cargo.toml                [features] polars-engine = ["dep:floe-engine"]   (default = [])
  src/lib.rs                #[cfg(feature="polars-engine")] mod engine_cmds;  else: existing stubs
  src/engine_cmds.rs        engine_status / engine_call / engine_page / engine_cancel
  engine/                   crate floe-engine (workspace member)
    Cargo.toml              polars (pin one version), calamine, polars-excel-writer, serde, serde_json, thiserror
    src/lib.rs              pub fn status(), evaluate(), page(), profile(), distinct(), export()
    src/plan.rs             serde types mirroring P1 (deny_unknown_fields)
    src/source.rs           csv/excel/parquet/ipc/json/blank → LazyFrame
    src/ops.rs              one fn per op
    src/expr.rs             formula AST → polars Expr (P3)
    src/cast.rs             locale-aware string→number/date/bool + error mask
    src/results.rs          LRU of DataFrames (12), page → Arrow IPC (with __err_<col> bool columns)
    tests/parity.rs         runs fixtures from tests/fixtures/*.json (P5)
```
**Pin Polars to one exact version** when you start (e.g. `polars = { version = "=0.xx.y", default-features = false, features = [...] }`). Then confirm every feature name against that version's docs. Expected features: `lazy`, `csv`, `parquet`, `ipc`, `json`, `strings`, `regex`, `temporal`, `dtype-date`, `dtype-datetime`, `dtype-struct`, `is_in`, `pivot`, `cum_agg`, `rank`, `round_series`, `rolling_window`, `sql`, `concat_str`, `diagonal_concat`, `cross_join`, `semi_anti_join`, `unique_counts`, `mode`.

**CI:** add a matrix flag in `desktop.yml`: `features: ["", "polars-engine"]`. That's two builds per OS.
- The Polars build appends `--features polars-engine` to `args` and names its artifacts `Floe-<ver>-polars-*`.
- The plain build always ships. The Polars build ships when green.

### P3. Formula → Polars `Expr` mapping (`expr.rs`)
- **Literals, columns, parameters:**
  - `lit` → `lit()`, `col` → `col()`
  - `param` → `lit(value)`, with typed value from the plan
  - `list` → literal Series, used only by `in` and `List.Contains`
- **Operators:**
  - `and`/`or`/`not` → `&`/`|`/`.not()`
  - `= <> < > <= >=` → `eq`/`neq`/… using **null-aware equality** for `=` with a null literal (`is_null`)
  - `&` → `concat_str([a, b], "", ignore_nulls=true)`
  - `+ - * /` → arithmetic. Division by zero → null (the built-in gives a cell error, which becomes the error mask in P4).
  - date `+`/`-` number → `+ duration(days)`; date − date → `(a-b).dt.total_days()`
- **Control flow:**
  - `if` → `when().then().otherwise()`, flattening nested ifs into chained `when`
  - `try a otherwise b` → `coalesce([a, b])`
- **Functions:** reuse the mapping table already written as Python strings in `js/expr.js` (`def(..., py)`). It names the equivalent Polars method for every function. Port each line to the Rust API. Unsupported in v1: `Text.Similarity`, `Value.IsError` (always false), `Text.Fingerprint` (port it in 1.1).
- **Type checking already happened in JS**, so Rust trusts the AST and returns a plain error if something is off.

### P4. Semantics that must match the built-in engine
| Topic | Built-in | Polars plan | Rule |
|---|---|---|---|
| Failed casts | Per-cell error | null | Emit `__err_<col>` = `cast.is_null() & original.is_not_null()` for `onError=error`; `native-engine.js` already turns it into error cells |
| Locale numbers | `parseNumber` (currency, %, parentheses, thousands) | string-clean regex then cast | Port the exact rules from `PQ.parseNumber`; fixture-tested |
| Dates | ISO, locale-ordered numeric, "12 Mar 2026" | `str.to_date` with an ordered format list (ISO, then `%d.%m.%Y`/`%m/%d/%Y` per locale, then `%d %b %Y`, `%b %d, %Y`) via `coalesce` | Fixture-tested |
| Bool | yes/no/y/n/1/0/wahr/vrai… | `is_in` lists | Same lists as `util.js` |
| Text sort | `Intl.Collator` numeric, accent-insensitive | byte order | **Known difference.** Shown in the popover ("text sorted by code point"). Parity tests compare sorted text columns as sets plus numeric order only |
| Preview | first `previewRows` source rows | `.head(previewRows)` on the source `LazyFrame` (before ops) | Same truncation flag |
| Row order | stable | `maintain_order=true` everywhere it exists | Required |
| GroupBy column names | `"Sum of x"` etc. | names are passed from JS in the plan | JS computes names |

### P5. Parity tests (shared fixtures)
1. **`scripts/gen-fixtures.mjs`** (Node, no browser):
   - Load `js/util.js`, `expr.js`, `io.js`, `steps.js`, `engine.js`, `engine-ext.js`, `plan.js` in a `vm` context with `self = globalThis`.
   - For each test project, write `tests/fixtures/<name>.json` = `{ plan, inputs: { path: base64 }, expected: { schema, rows (first 200), n } }`.
2. **`desktop/src-tauri/engine/tests/parity.rs`:** runs every fixture and compares schema (names + Floe types), `n`, and the rows. Floats are compared to 1e-9; text-sort columns are compared as sets.
3. **CI:** `cargo test -p floe-engine` runs in the Linux Polars job before `tauri build`.

**Done when:** 100% of fixtures pass, or the failures are listed in `docs/PARITY.md` with a reason and the plan lowering refuses those cases.

### P6. Wire `native-engine.js` to the plan
1. `N.shouldRun(op, msg, project)`:
   - for `evaluate`, call `PQ.Plan.lower(project, msg.qid, msg.upto)`;
   - save `reason` on `UI.Engine` for the indicator;
   - return `ok`.
   - Drop the old `clientEligible` and `canRun` round trip.
2. `N.call('evaluate')` sends `{ plan, mode }`. The reply is `{ resultId, schema, n, states, ms, truncated }`.
   - **Per-step states:** Polars runs the whole plan at once, so `states` only has accurate rows/cols for the **last** step. Earlier steps show `—` rows. This is acceptable and is noted in the popover.
3. **Quality strip, overview, suggestions, clusters for Polars results:**
   - **Quality:** Rust returns per-column `{valid, error, empty}`.
   - **Overview and clusters:** run on the built-in engine against the preview sample. The Overview tab labels this "Based on sample (built-in)".
4. **Exports when the active query can lower:**
   - `exportQuery` and `refreshAll` call `engine_call('export', { plan, format, path })`.
   - Rust writes CSV/Parquet/IPC/XLSX **directly to the path** chosen in the native save dialog. No bytes cross IPC.
5. **Cancel:** `engine_cancel` bumps the generation; the UI rejects the pending call immediately; Rust discards the stale result.

**Done when:**
- With the Polars build, all sample queries that lower show `● Polars`.
- The others show `● Built-in ↺` with the right reason.
- Results match the built-in engine for every fixture.
- Exporting the 1M-row fixture to Parquet doesn't freeze the UI.

### P7. Performance targets for the Polars build
Use the same `bench.html` pipelines, run inside the desktop app with "Prefer Polars" on and then off:
- Full-data pipelines A–C on 1M rows: Polars is **at least 5× faster** than built-in.
- Peak memory is no higher than built-in.
- Record the results in `docs/BENCH.md`.

---

## Order of work and rough size

| Step | Size | Can be checked in the editor sandbox |
|---|---|---|
| W0 | small (your machine + Vercel) | partly |
| W1 | small | yes |
| W2 | medium | yes (screenshots, UI test) |
| W3 | small | yes |
| W4 | large, iterative | yes (bench page) |
| W5 | small | — |
| D0 | small to medium, depends on compile errors | CI only |
| D1 | manual test | your machines |
| D2/D3 | config + certificates | CI |
| P1 + plan tests | medium | yes (browser tests) |
| P2–P4 | large (~1,500 lines of Rust) | CI only |
| P5 | medium | Node + CI |
| P6 | medium | needs a Polars desktop build |
| P7 | small | your machine |

**Suggested sessions:**
1. W1 + W2 + W3
2. W0 + D0 (you trigger the runs, I fix errors)
3. W4
4. D1 fixes + W5 → **ship 1.0**
5. P1 (JS only, testable)
6. P2–P5 in CI loops
7. P6 + P7 → ship 1.1 "Polars build"

## What to send back after each CI run
- The job name and the first `error[...]` block with about 10 lines after it.
- For runtime problems: the devtools console output (desktop: right-click → Inspect in debug builds), plus the step from D1 that failed.
