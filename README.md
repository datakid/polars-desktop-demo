# Floe — data preparation in the browser

Clean and reshape messy spreadsheets with replayable steps. Excel, CSV and JSON in; Excel, CSV or a Polars Python script out. Everything runs locally in the browser: files are never uploaded. The same UI also runs inside the Tauri desktop shell (see *Desktop*).

## Design: "Clay"
- **Monochrome warm neutrals.** Paper `#f2efe8`, panels `#faf8f4`, ink `#2b2926`. No pure white, no pure black.
- **One accent**, clay `#b5643f`, used only for focus, selection and the logo's drifting block.
- **Data types share one low chroma** (teal, slate, violet, ochre, mauve), so the grid stays quiet.
- **Dark theme "Kiln"** uses warm dark neutrals (`#1d1b18`) with a softer clay accent.
- **Typography:** Source Serif 4 (titles), Instrument Sans (UI), JetBrains Mono (data).
- **Mark:** `images/floe-mark.svg` (mark) and `images/floe-icon.svg` (app icon source).

## Repository layout
```
index.html, demo.html, tests.html        pages
css/app.css                              design system + responsive layout
js/                                      engine (worker) + UI
vendor/                                  SheetJS, AlaSQL, Font Awesome, apache-arrow (desktop only)
manifest.webmanifest, sw.js              PWA: install, offline, file handlers
vercel.json                              static deploy + headers (CSP, caching)
```

## Web app
### Files and projects
| Capability | Chromium (Chrome, Edge, Arc, Opera) | Firefox / Safari |
|---|---|---|
| Open data files | Native picker, file stays **linked** | `<input type=file>` copy |
| Open a folder | Directory picker, recursive (4 levels, 5,000 files) | `webkitdirectory` |
| Refresh | Re-reads linked files that changed on disk | Uses the stored copy |
| Save / Save As | Writes back to the same `.floe` file | Downloads `.floe` |
| Open recent | Last 8 projects (handles in IndexedDB) | — |
| Drop files / folders / `.floe` | Yes, and links the files | Files and `.floe` |
| Installable PWA + OS "Open with" | Yes (`file_handlers`, `launchQueue`) | Safari: Add to Dock / Home Screen |

- **Workspace storage:** data files are kept in IndexedDB (`pqx-files`), the project autosaves to `localStorage` (`floe.project.v1`), and handles and recents are stored in IndexedDB (`floe-web`). After the first file is added the app asks for persistent storage (Settings → *Keep data persistent*).
- **Unsaved changes:** a linked project shows a dot in the title bar. When you open another project or start a new one while changes are unsaved, the app asks Save / Don't save / Cancel. Closing the tab warns you too.
- **Multiple tabs:** if another tab changes the project, this tab offers *Load their version* and does not silently overwrite it.
- **Linked-file sync:** Refresh, Refresh All, Full data and returning to the tab all re-read linked sources whose `lastModified`/size changed.
- **Limits:** 250 MB per file in the browser engine (500 MB in the desktop shell). Pastes over 50,000 rows ask you to use a file instead.

### Input shortcuts
- **Paste a table** (`Ctrl/⌘+V` anywhere outside a field, or *Get Data → Paste from clipboard*). Tab-separated cells from Excel, Sheets or a web table become a new query. Headers are detected and types are inferred automatically. Pasting a copied file adds the file.
- **Keyboard:** browsers reserve `Ctrl+N`, so a new project is `Alt+N`. `F5` refreshes the current query (in the web app it does not reload the page). Shortcut labels show `⌘ ⇧ ⌥` on macOS.

### Mobile and touch
- **≤ 760 px:** single-pane layout with a bottom tab bar (**Queries / Data / Steps**), with counts on the tabs. Choosing a query or loading a file jumps to Data.
- Dialogs open as full-width bottom sheets. Safe-area insets and `100dvh` are respected. Inputs use 16 px text to avoid iOS zoom.
- **Touch:** long-press opens context menus (queries, steps, cells, column headers). Controls that appear on hover elsewhere stay visible. Tap targets are larger. Column resize and splitters use pointer events.
- The ribbon scrolls horizontally with snap.

### Offline and PWA
`sw.js` precaches the app shell. It uses network-first for pages, JS and CSS, and stale-while-revalidate for `vendor/`, `fonts/` and `images/`. The status bar badge shows **Offline**, and everything keeps working. When the browser offers installation, *Menu → Install app* appears.

## Engines
| | Built-in | Polars (desktop only) |
|---|---|---|
| Where | Web Worker (`js/worker.js` → `engine.js`) | `floe-engine` process |
| Steps | All ~40 | 27 |
| Sources | CSV, Excel, JSON, folder, entered/pasted data | + Parquet, Arrow IPC |
| Cancel | Terminate worker (Esc) | Kill process |

In the browser, `apache-arrow` is never loaded. `native-engine.js` loads it on demand only inside Tauri. Desktop-only options (Parquet output, Polars toggle, CLI) are hidden on the web. *Automate…* exports a Polars script instead.

## Entry points
| Path | Purpose |
|---|---|
| `index.html` | App |
| `demo.html` | Fresh workspace with the sample project |
| `index.html?demo` | Load samples if the project is empty |
| `index.html?q=<query>&step=<n>` | Open a query at a step |
| `index.html?pane=queries\|data\|steps` | Mobile pane |
| `index.html?open=python\|merge\|deps\|files\|nav\|params\|custom` | Open a dialog |
| `tests.html` | Engine golden tests (63) |

## Data model
- **Project (`.floe`):** stable-key JSON `{format_version, name, settings:{previewRows, locale}, params[], queries[{id, name, load:{target}, steps[{id, name, kind, note?, disabled?}]}]}`.
- **File record (IndexedDB `pqx-files/files`):** `{id, name, size, mtime, folder, path, buf}`.
- **Web KV (IndexedDB `floe-web/kv`):** `file:<id>` → `FileSystemFileHandle`, `projectHandle`, `recent` → `[{name, handle, at}]`.
- **localStorage:** `floe.project.v1`, `floe.ui`, `floe.theme`, `floe.panes`, `floe.fileName`, `floe.savedHash`.

## Deploy (Vercel)
Static, no build step. `vercel.json` sets CSP (`'unsafe-eval'` is required by AlaSQL for Custom SQL steps), `nosniff`, frame and permissions policies, long caching for `vendor|fonts|images`, and `no-cache` for `sw.js` and the manifest. After deploying a change to cached files, bump `VERSION` in `sw.js`.

## Not implemented / known limits
- Parquet/Arrow input and output on the web (desktop Polars engine only).
- Linked-file sync and in-place Save need the File System Access API (Chromium). Other browsers work on copies and use downloads.
- The engine is single-threaded JS in a worker. Very large files (hundreds of MB) are slow compared with Polars.
- Database sources.

## Next steps
1. Parquet on the web via `parquet-wasm`, and optionally a DuckDB-WASM engine for large files.
2. OPFS for workspace files, which is faster and has a larger quota than IndexedDB blobs.
3. Raster PNG icons (192/512, maskable) next to the SVGs for older Android launchers.
4. Share target (`share_target`) so mobile users can share a CSV into Floe.

## License
MIT. Bundled: SheetJS CE (Apache-2.0), AlaSQL (MIT), apache-arrow (Apache-2.0), Font Awesome Free (icons CC BY 4.0, fonts OFL, code MIT), Instrument Sans, Source Serif 4 and JetBrains Mono (OFL).
