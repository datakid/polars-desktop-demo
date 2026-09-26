/* Floe application controller: layout, ribbon, queries, applied steps, grid wiring, column menus,
 * suggestions, profiling, status and keyboard. */
(function () {
  const PQ = self.PQ, UI = PQ.UI, h = UI.h, Store = UI.Store, $ = UI.$;
  const App = (UI.App = { files: [], result: null, states: [], queryStatus: new Map(), evalSeq: 0, profile: null, dismissed: new Set() });

  /* ================================ boot ================================ */
  App.boot = async function () {
    App.applyTheme();
    await PQ.Platform.init();
    Store.init();
    $('#env-badge').textContent = PQ.Platform.native ? 'Desktop' : 'Web';
    $('#env-badge').classList.toggle('native', PQ.Platform.native);
    PQ.Platform.onMenu(onNativeMenu);
    PQ.Platform.onFilesDropped(async (files) => App.afterAdd(await App.addFiles(files)));
    addEventListener('beforeunload', (e) => { if (PQ.Platform.native && Store.filePath && Store.dirty()) { e.preventDefault(); e.returnValue = ''; } });
    buildRibbon();
    wireLayout();
    Store.on((kind) => onStoreChange(kind));
    UI.Engine.onState(renderEngineState);
    App.grid = new UI.Grid($('#grid'), {
      onSelect: (cols) => { Store.ui.selCols = cols; renderRibbonState(); if (Store.ui.rightTab === 'profile') loadProfile(); },
      onColMenu: (c, anchor) => columnMenu(c, anchor),
      onTypeMenu: (c, anchor) => typeMenu(c, anchor),
      onCellMenu: (c, v, x, y) => cellMenu(c, v, x, y),
      filtered: (name) => filteredCols().has(name),
    });
    renderAll();
    try {
      await Promise.all([UI.Engine.start(), UI.NativeEngine.init()]);
      await App.reloadFiles();
      await UI.Engine.setProject(Store.project);
      PQ.Platform.onOpenProject((f) => UI.openProject(f));
      if (/[?&]demo\b/.test(location.search) && !Store.project.queries.length) await App.loadSamples();
      // deep links: ?q=<query name>&step=<n>&open=python|merge|deps|files|nav|params|custom
      const qs = new URLSearchParams(location.search);
      const want = qs.get('q') && Store.project.queries.find((x) => x.name === qs.get('q'));
      if (want) Store.setUI({ activeQid: want.id, activeStep: qs.get('step') ? +qs.get('step') - 1 : null });
      await App.refresh();
      const open = qs.get('open');
      if (open) setTimeout(() => ({
        python: () => UI.pythonDialog(Store.ui.activeQid), deps: UI.dependencyDialog, files: UI.projectFilesDialog, params: UI.paramsDialog,
        merge: () => UI.editStep({ qid: Store.ui.activeQid, index: Store.query().steps.findIndex((s) => s.kind.type === 'Merge') }),
        custom: () => stepDialog('AddColumn', { formula: 'if [revenue] > 500 and [region] = "EU" then "Key" else Text.Uper([segment])' }),
        nav: () => { const f = App.files.find((x) => x.name === 'regional_report.xlsx'); if (f) UI.navigator(f.id); },
      }[open] || (() => {}))(), 300);
    } catch (e) {
      console.error(e);
      showGridMessage(h('div', h('div.big', UI.icon('fa-plug-circle-xmark')), h('h2', 'Engine failed to start'), h('p', e.message), h('p.muted', 'Try reloading the window (Ctrl+R). If it keeps failing, clear the cache in Settings.')));
    }
  };
  App.applyTheme = function () {
    const t = localStorage.getItem('floe.theme') || 'system';
    const dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  };
  UI.setSaveState = (t) => { const el = $('#save-state'); if (el) { el.textContent = t; el.classList.toggle('dirty', Store.dirty() && !!Store.filePath); } updateTitle(); };
  function updateTitle() {
    const file = Store.filePath ? String(Store.filePath).split(/[\\/]/).pop() : null;
    PQ.Platform.setTitle((Store.dirty() && file ? '● ' : '') + (file || Store.project.name) + ' — ' + PQ.BRAND.name);
  }
  /** Native menu (desktop/src-tauri/src/menu.rs) → actions. */
  function onNativeMenu(id) {
    const map = {
      'file.new': () => newProject(), 'file.open': () => UI.openProject(), 'file.save': () => UI.saveProject(), 'file.save_as': () => UI.saveProject(true),
      'file.get_data': App.getData, 'file.folder': UI.folderDialog, 'file.samples': App.loadSamples,
      'file.export_xlsx': () => exportAs('xlsx'), 'file.export_csv': () => exportAs('csv'), 'file.export_python': () => UI.pythonDialog(Store.ui.activeQid),
      'file.settings': UI.settingsDialog,
      'edit.undo': Store.undoOne, 'edit.redo': Store.redoOne,
      'query.refresh': () => App.refresh(), 'query.refresh_all': UI.refreshAll, 'query.full': App.runFull, 'query.preview': () => App.setMode('preview'),
      'query.params': UI.paramsDialog, 'query.deps': UI.dependencyDialog, 'query.project_files': UI.projectFilesDialog, 'query.cli': UI.cliDialog,
      'view.theme': toggleTheme, 'help.shortcuts': UI.shortcutsDialog, 'help.about': UI.aboutDialog,
    };
    if (UI.anyModal() && !/^(edit|view|help)\./.test(id)) return;
    (map[id] || (() => console.warn('unhandled menu', id)))();
  }
  function toggleTheme() { const cur = document.documentElement.dataset.theme; localStorage.setItem('floe.theme', cur === 'dark' ? 'light' : 'dark'); App.applyTheme(); }
  async function newProject() { if (await UI.confirm('New project?', 'The current project stays in undo history (Ctrl+Z).', 'Create')) Store.replace(Store.newProject(), 'New project'); }

  function onStoreChange(kind) {
    if (kind === 'saved') { UI.setSaveState('Saved'); return; }
    if (kind === 'project') {
      UI.Engine.setProject(Store.project).then(() => App.refresh());
      renderAll();
    } else renderAll();
  }
  function renderAll() {
    $('#project-name').value = Store.project.name;
    renderQueries(); renderFiles(); renderSteps(); renderRight(); renderRibbonState(); renderFormulaBar();
    const q = Store.query();
    $('#empty-state').classList.toggle('hidden', !!q);
  }

  /* ================================ files ================================ */
  App.reloadFiles = async function () { const r = await UI.Engine.call('listFiles'); App.files = r.files; renderFiles(); };
  App.folders = () => [...new Set(App.files.filter((f) => f.folder).map((f) => f.folder))].sort();
  /** Accepts browser File objects or platform records {name, size, buf, path?, folder?}. */
  App.addFiles = async function (fileList, folder) {
    const added = [];
    for (const file of fileList) {
      if (file.size > 500 * 1048576) { UI.toast(file.name + ': over 500 MB', 'warn'); continue; }
      const buf = file.buf || (await file.arrayBuffer());
      const r = await UI.Engine.call('addFile', { name: file.name, buf, folder: folder || file.folder || '', path: file.path || null }, null, [buf]);
      added.push(r.file);
    }
    await App.reloadFiles();
    return added;
  };
  App.getData = async function () {
    let files;
    try { files = await PQ.Platform.pickDataFiles(); } catch (e) { return UI.toast(e.message || String(e), 'err'); }
    if (!files || !files.length) return;
    App.afterAdd(await App.addFiles(files));
  };
  App.afterAdd = function (added) {
    if (added.length === 1) UI.navigator(added[0].id);
    else if (added.length) UI.toast(added.length + ' files added', 'ok');
  };
  App.addFolder = async function () {
    let r;
    try { r = await PQ.Platform.pickFolder(); } catch (e) { return UI.toast(e.message || String(e), 'err'); }
    if (!r || !r.files.length) return;
    await App.addFiles(r.files, r.folder);
    UI.toast(r.folder + ' · ' + r.files.length + ' files', 'ok');
    UI.folderDialog();
  };
  App.loadSamples = async function () {
    App.busy('Generating sample data', false);
    try {
      await UI.Engine.call('loadSamples');
      await App.reloadFiles();
      if (!Store.project.queries.length) await buildSampleProject();
      UI.toast('Sample project loaded', 'ok');
    } catch (e) { UI.toast(e.message, 'err'); }
    finally { App.busy(null); }
  };
  App.openNavigator = (fileId, opts) => UI.navigator(fileId, opts);

  /** Create a query from a source spec: Source → PromoteHeaders (detected) → ChangeType (inferred). */
  App.createQueryFromSource = async function (source, name, headerRow, replaceQid) {
    let sug = { steps: [] };
    try { sug = await UI.Engine.call('suggestSteps', { source, headerRow }); }
    catch (e) { UI.toast(e.message, 'err'); return false; }
    if (replaceQid) {
      Store.edit('Replace source', (p) => { const q = p.queries.find((x) => x.id === replaceQid); q.steps[0].kind = { type: 'Source', source }; });
      return;
    }
    const q = { id: PQ.uid('q'), name: PQ.uniqueName(name || 'Query', Store.project.queries.map((x) => x.name)), load: { target: 'none' }, steps: [{ id: PQ.uid('s'), name: 'Source', kind: { type: 'Source', source } }] };
    sug.steps.forEach((k) => q.steps.push({ id: PQ.uid('s'), name: PQ.Steps.label(k.type), kind: k }));
    Store.edit('New query ' + q.name, (p) => { p.queries.push(q); }, { activeQid: q.id, activeStep: null, selCols: [] });
    Store.saveUI();
  };

  async function buildSampleProject() {
    const byName = (n) => App.files.find((f) => f.name === n);
    const rep = byName('regional_report.xlsx'), orders = byName('orders.csv'), cust = byName('customers.csv');
    const P = Store.project;
    if (!rep || !orders || !cust) return;
    const mk = (name, steps, load) => ({ id: PQ.uid('q'), name, load: { target: load || 'none' }, steps: steps.map(([nm, kind, note]) => ({ id: PQ.uid('s'), name: nm, kind, note })) });
    const qCust = mk('Customers', [
      ['Source', { type: 'Source', source: { kind: 'file', fileId: cust.id, fileName: cust.name, csv: { delimiter: ',', header: true, encoding: 'auto' } } }],
      ['Changed Type', { type: 'ChangeType', changes: [{ col: 'signup_date', type: 'date' }], onError: 'error' }],
    ]);
    const qOrders = mk('Orders', [
      ['Source', { type: 'Source', source: { kind: 'file', fileId: orders.id, fileName: orders.name, csv: { delimiter: ',', header: true, encoding: 'auto' } } }],
      ['Changed Type', { type: 'ChangeType', changes: [{ col: 'order_id', type: 'int' }, { col: 'order_date', type: 'date' }, { col: 'quantity', type: 'int' }, { col: 'unit_price', type: 'number' }, { col: 'discount', type: 'number' }], onError: 'error' }, 'unit_price contains "n/a" in ~1% of rows — they show up as error cells'],
      ['Cleaned Status', { type: 'TextTransform', op: 'clean', cols: ['status'] }],
      ['Lowercased Status', { type: 'TextTransform', op: 'lower', cols: ['status'] }],
      ['Replaced Errors', { type: 'ReplaceErrors', cols: ['unit_price'], value: '' }],
      ['Added Revenue', { type: 'AddColumn', name: 'revenue', formula: 'Number.Round([quantity] * [unit_price] * (1 - Coalesce([discount], 0)), 2)' }],
      ['Merged Customers', { type: 'Merge', right: qCust.id, on: [['customer_id', 'customer_id']], how: 'left', expand: ['customer_name', 'region', 'segment'] }, 'customers.csv has a duplicated id (C0007) — the merge dialog warns about it'],
      ['Filtered Rows', { type: 'Filter', mode: 'builder', builder: { join: 'and', conds: [{ col: 'status', op: 'ne', value: 'returned', numeric: false }] } }],
    ]);
    const qRegion = mk('Revenue by Region', [
      ['Source', { type: 'Source', source: { kind: 'query', query: qOrders.id } }],
      ['Added Month', { type: 'AddColumn', name: 'month', formula: 'Date.ToText(Date.StartOfMonth([order_date]), "yyyy-MM")' }],
      ['Grouped Rows', { type: 'GroupBy', keys: ['region', 'month'], aggs: [{ fn: 'sum', col: 'revenue', name: 'revenue' }, { fn: 'count_rows', name: 'orders' }, { fn: 'count_distinct', col: 'customer_id', name: 'customers' }] }],
      ['Sorted Rows', { type: 'Sort', by: [{ col: 'month', desc: false }, { col: 'revenue', desc: true }] }],
    ], 'xlsx');
    const qReport = mk('Report Sheet', [
      ['Source', { type: 'Source', source: { kind: 'file', fileId: rep.id, fileName: rep.name, format: 'excel', item: { type: 'range', sheet: 'Report', range: 'A4:F24' }, fillMerged: false } }],
      ['Promoted Headers', { type: 'PromoteHeaders', row: 0 }],
      ['Filled Down', { type: 'FillDown', cols: ['Region'] }, 'Region is a merged cell in the report layout'],
      ['Filtered Rows', { type: 'Filter', mode: 'advanced', formula: '[Product] <> "Subtotal"' }],
      ['Unpivoted Columns', { type: 'Unpivot', ids: ['Region', 'Product'], var: 'Month', val: 'Units' }],
    ], 'csv');
    const next = JSON.parse(JSON.stringify(P));
    next.name = 'Sales demo';
    next.params = [{ name: 'MinRevenue', type: 'number', value: '100' }];
    next.queries.push(qCust, qOrders, qRegion, qReport);
    Store.replace(next, 'Load sample project');
    Store.setUI({ activeQid: qOrders.id, activeStep: null });
  }

  /* ================================ evaluation ================================ */
  App.refresh = async function (opts) {
    opts = opts || {};
    const q = Store.query();
    if (!q) { App.result = null; App.grid.setResult(null); hideGridMessage(); renderSuggestions([]); renderStatus(); return; }
    const my = ++App.evalSeq;
    const upto = Store.activeIndex();
    const mode = opts.mode || Store.ui.mode;
    const t = setTimeout(() => { if (my === App.evalSeq) App.busy(mode === 'full' ? 'Running on full data' : 'Evaluating', true); }, 120);
    try {
      const r = await UI.Engine.call('evaluate', { qid: q.id, upto, mode }, (p) => { if (my === App.evalSeq) App.progress(p); });
      if (my !== App.evalSeq) return;
      App.states = r.states;
      App.lastRun = { ms: r.ms, mode, truncated: r.truncated };
      const failed = r.failedAt;
      App.queryStatus.set(q.id, { error: failed >= 0 ? r.states[failed].error : null });
      if (r.resultId) {
        hideGridMessage();
        App.result = r;
        App.grid.setResult({ resultId: r.resultId, schema: r.schema, n: r.n, quality: r.quality, firstPage: r.firstPage }, opts.keepScroll);
        renderSuggestions(r.suggestions || []);
      } else {
        App.result = null;
        App.grid.setResult(null);
        renderSuggestions([]);
        showStepError(q, failed, r.states[failed]);
      }
      renderSteps(); renderQueries(); renderStatus(); renderRight(); renderBanner();
      if (Store.ui.rightTab === 'profile') loadProfile();
    } catch (e) {
      if (my !== App.evalSeq) return;
      if (e.cancelled) { UI.toast('Cancelled', 'warn'); if (Store.ui.mode === 'full') { Store.ui.mode = 'preview'; renderRibbonState(); } }
      else showGridMessage(h('div.error-card', h('h3', UI.icon('fa-bomb'), 'Query failed, engine restarted'), h('p', e.message), h('div.fixes', h('button.btn.sm', { on: { click: () => App.refresh() } }, 'Retry'))));
    } finally {
      clearTimeout(t);
      if (my === App.evalSeq) App.busy(null);
    }
  };
  App.runFull = function () { Store.ui.mode = 'full'; renderRibbonState(); App.refresh({ mode: 'full' }); };
  App.setMode = function (m) { Store.ui.mode = m; renderRibbonState(); App.refresh(); };

  let busyTimer = null;
  App.busy = function (label, cancellable) {
    const el = $('#busy');
    if (!label) { el.classList.add('hidden'); clearInterval(busyTimer); return; }
    el.classList.remove('hidden');
    const t0 = performance.now();
    UI.clear(el).append(h('span.spinner'), h('span#busy-label', label), h('span#busy-time.faint', ''), cancellable ? h('button.btn.sm', { on: { click: () => UI.Engine.cancel() }, title: 'Stops the engine process immediately (Esc)' }, 'Cancel') : null);
    clearInterval(busyTimer);
    busyTimer = setInterval(() => { const x = $('#busy-time'); if (x) x.textContent = UI.fmtMs(performance.now() - t0); }, 100);
  };
  App.progress = function (p) { const l = $('#busy-label'); if (l && p.stage) l.textContent = p.stage; };

  function showGridMessage(node) { const g = $('#grid-msg'); UI.clear(g).appendChild(node); g.classList.remove('hidden'); }
  function hideGridMessage() { $('#grid-msg').classList.add('hidden'); }

  /** A failed step shows a card that explains the error and offers one-click fixes. */
  function showStepError(q, idx, st) {
    const step = q.steps[idx];
    const fixes = (st.fixes || []).map((f) => h('button.btn.sm', { on: { click: () => applyFix(q, idx, f) } }, f.label));
    fixes.push(h('button.btn.sm', { on: { click: () => UI.editStep({ qid: q.id, index: idx }) } }, UI.icon('fa-pen'), 'Edit step'));
    if (idx > 0) fixes.push(h('button.btn.sm.ghost', { on: { click: () => Store.setUI({ activeStep: idx - 1 }) || App.refresh() } }, 'View previous step'));
    showGridMessage(h('div.grid-error', h('div.error-card', h('h3', UI.icon('fa-circle-exclamation'), 'Step ' + (idx + 1) + ' · ' + step.name + ' failed'), h('p', st.error), h('div.fixes', fixes))));
  }
  function applyFix(q, idx, f) {
    if (f.kind === 'replaceColumn') Store.edit('Fix column reference', (p) => { const s = p.queries.find((x) => x.id === q.id).steps[idx]; s.kind = PQ.Steps.renameColumnInKind(s.kind, f.from, f.to); });
    else if (f.kind === 'deleteStep') Store.edit('Delete step', (p) => { p.queries.find((x) => x.id === q.id).steps.splice(idx, 1); }, { activeStep: null });
    else if (f.kind === 'removeStep') UI.editStep({ qid: q.id, index: f.index });
    else if (f.kind === 'setOnError') Store.edit('Change error handling', (p) => { p.queries.find((x) => x.id === q.id).steps[idx].kind.onError = f.value; });
    else if (f.kind === 'set') Store.edit('Fix step', (p) => { p.queries.find((x) => x.id === q.id).steps[idx].kind[f.field] = f.value; });
    else if (f.kind === 'relink') relinkSource(q);
  }
  async function relinkSource(q) {
    const file = await PQ.Platform.pickOneDataFile();
    if (!file) return;
    const [rec] = await App.addFiles([file]);
    Store.edit('Relink source', (p) => { const s = p.queries.find((x) => x.id === q.id).steps[0].kind.source; s.fileId = rec.id; s.fileName = rec.name; });
  }

  /* ================================ ribbon ================================ */
  const RB = [];
  function rb(icon, label, run, opts) { opts = opts || {}; const b = h('button.rb-btn', { title: opts.title || label, class: opts.danger ? 'danger' : '', on: { click: (e) => run(e) } }, UI.icon(icon), h('span', label)); b._need = opts.need; RB.push(b); return b; }
  function group(label, hue, ...btns) { return h('div.rb-group', { dataset: { label, hue } }, btns); }
  const needQ = 'query', needCols = 'cols';
  function buildRibbon() {
    const r = $('#ribbon');
    r.append(
      group('Data', 'iris',
        rb('fa-file-circle-plus', 'Get Data', (e) => UI.menu([
          { label: 'File (Excel, CSV, JSON)…', icon: 'fa-file-excel', run: App.getData },
          { label: 'Folder…', icon: 'fa-folder-open', run: UI.folderDialog },
          { label: 'Enter / paste data…', icon: 'fa-keyboard', run: enterData },
          { label: 'Reference existing query', icon: 'fa-link', disabled: !Store.project.queries.length, sub: Store.project.queries.map((q) => ({ label: q.name, icon: 'fa-table', run: () => referenceQuery(q) })) },
          '-',
          { label: 'Parquet / Arrow…', icon: 'fa-cubes', disabled: !UI.NativeEngine.available(), run: App.getData },
          { label: 'Database — soon', icon: 'fa-database', disabled: true },
          '-',
          { label: 'Load sample data', icon: 'fa-flask', run: App.loadSamples },
        ], e.currentTarget.getBoundingClientRect().left, e.currentTarget.getBoundingClientRect().bottom + 2)),
        rb('fa-arrows-rotate', 'Refresh', () => App.refresh(), { need: needQ, title: 'Re-evaluate the current step' }),
        rb('fa-arrows-spin', 'Refresh All', UI.refreshAll, { title: 'Run every output on full data in dependency order' })),
      group('Shape', 'glacier',
        rb('fa-table-columns', 'Choose Columns', () => stepDialog('SelectColumns', { cols: Store.ui.selCols.length ? Store.ui.selCols : App.result.schema.map((c) => c.name) }), { need: needQ }),
        rb('fa-delete-left', 'Remove Columns', () => removeSelected(), { need: needCols }),
        rb('fa-list-ol', 'Keep Rows', (e) => UI.menu([
          { label: 'Keep top rows…', run: () => stepDialog('KeepRows', { mode: 'top', n: 100 }) }, { label: 'Keep bottom rows…', run: () => stepDialog('KeepRows', { mode: 'bottom', n: 100 }) }, { label: 'Keep range of rows…', run: () => stepDialog('KeepRows', { mode: 'range', n: 100, offset: 0 }) }, { label: 'Keep duplicates', run: () => Store.addStep({ type: 'KeepDuplicates', subset: Store.ui.selCols }) }, { label: 'Keep errors', run: () => Store.addStep({ type: 'KeepErrors', cols: Store.ui.selCols }) }, '-',
          { label: 'Remove top rows…', run: () => stepDialog('KeepRows', { mode: 'remove_top', n: 1 }) }, { label: 'Remove bottom rows…', run: () => stepDialog('KeepRows', { mode: 'remove_bottom', n: 1 }) }, { label: 'Remove alternate rows…', run: () => stepDialog('KeepRows', { mode: 'alternate', keep: 1, skip: 1 }) }, { label: 'Remove blank rows', run: () => Store.addStep({ type: 'KeepRows', mode: 'remove_blank' }) }, { label: 'Remove duplicates', run: () => Store.addStep({ type: 'Distinct', subset: Store.ui.selCols }) }, { label: 'Remove errors', run: () => Store.addStep({ type: 'RemoveErrors', cols: Store.ui.selCols }) },
        ], e.currentTarget.getBoundingClientRect().left, e.currentTarget.getBoundingClientRect().bottom + 2), { need: needQ }),
        rb('fa-filter', 'Filter', () => stepDialog('Filter', { mode: 'builder', builder: { join: 'and', conds: [{ col: Store.ui.selCols[0] || (App.result && App.result.schema[0] || {}).name, op: 'eq', value: '' }] } }), { need: needQ }),
        rb('fa-arrow-down-wide-short', 'Sort', () => stepDialog('Sort', { by: [{ col: Store.ui.selCols[0] || (App.result && App.result.schema[0] || {}).name, desc: false }] }), { need: needQ })),
      group('Transform', 'violet',
        rb('fa-heading', 'Headers', (e) => UI.menu([{ label: 'Use first row as headers', icon: 'fa-arrow-up', run: () => Store.addStep({ type: 'PromoteHeaders', row: 0 }) }, { label: 'Use row N as headers…', run: () => stepDialog('PromoteHeaders', { row: 0 }) }, { label: 'Use headers as first row', icon: 'fa-arrow-down', run: () => Store.addStep({ type: 'DemoteHeaders' }) }], e.currentTarget.getBoundingClientRect().left, e.currentTarget.getBoundingClientRect().bottom + 2), { need: needQ }),
        rb('fa-shapes', 'Detect Types', () => detectTypes(), { need: needQ }),
        rb('fa-layer-group', 'Group By', () => stepDialog('GroupBy', { keys: Store.ui.selCols.slice(0, 1), aggs: [{ fn: 'count_rows', name: 'Count' }] }), { need: needQ }),
        rb('fa-table-cells', 'Unpivot', () => stepDialog('Unpivot', { ids: App.result.schema.map((c) => c.name).filter((n) => !Store.ui.selCols.includes(n)) }), { need: needQ, title: 'Unpivot the selected columns (keeps the others)' }),
        rb('fa-table-cells-large', 'Pivot', () => stepDialog('Pivot', { on: Store.ui.selCols[0] }), { need: needQ }),
        rb('fa-rotate', 'Transpose', () => stepDialog('Transpose', {}), { need: needQ })),
      group('Combine', 'orchid',
        rb('fa-code-merge', 'Merge', () => UI.mergeDialog({ qid: Store.ui.activeQid, insertAt: Store.activeIndex() + 1, kind: { type: 'Merge' } }), { need: needQ }),
        rb('fa-object-ungroup', 'Append', () => stepDialog('Append', { others: [], mode: 'diagonal' }), { need: needQ })),
      group('Add column', 'apricot',
        rb('fa-square-plus', 'Custom Column', () => stepDialog('AddColumn', { formula: '' }), { need: needQ }),
        rb('fa-code-branch', 'Conditional', () => stepDialog('ConditionalColumn', { rules: [{ when: '', then: '' }], else: 'null' }), { need: needQ }),
        rb('fa-list-ol', 'Index', () => stepDialog('IndexColumn', { name: 'Index', start: 1, step: 1, first: true }), { need: needQ }),
        rb('fa-chart-line', 'Window', () => stepDialog('Window', { op: 'cumsum', col: Store.ui.selCols[0] }), { need: needQ, title: 'Running totals, rank, lag/lead, % of total, moving average' }),
        rb('fa-terminal', 'SQL', () => stepDialog('CustomSql', { sql: 'SELECT *\nFROM self\nLIMIT 100' }), { need: needQ, title: 'Custom SQL step — previous step is `self`' })),
      group('Project', 'ink',
        rb('fa-brands fa-python', 'Python', () => UI.pythonDialog(Store.ui.activeQid), { need: needQ, title: 'Export to a Polars Python script' }),
        rb('fa-code-branch', 'Project File', UI.projectFilesDialog, { title: 'Git-friendly project file view' }),
        rb('fa-diagram-project', 'Dependencies', UI.dependencyDialog),
        rb('fa-sliders', 'Parameters', UI.paramsDialog)),
      h('div.rb-group.mode-toggle', { dataset: { label: 'Evaluate on' } }, h('div.seg#mode-seg', h('button', { on: { click: () => App.setMode('preview') }, title: 'First N source rows — instant' }, 'Preview'), h('button', { on: { click: () => App.runFull() }, title: 'All rows (Ctrl+Shift+F)' }, 'Full data'))),
    );
  }
  function renderRibbonState() {
    const q = Store.query();
    RB.forEach((b) => { b.disabled = (b._need === needQ && (!q || !App.result)) || (b._need === needCols && (!Store.ui.selCols.length || !App.result)); });
    const seg = $('#mode-seg');
    if (seg) { seg.children[0].classList.toggle('on', Store.ui.mode !== 'full'); seg.children[1].classList.toggle('on', Store.ui.mode === 'full'); seg.children[1].classList.toggle('full', Store.ui.mode === 'full'); }
  }

  function stepDialog(type, init) {
    const q = Store.query(); if (!q) return;
    UI.editStep({ qid: q.id, insertAt: Store.activeIndex() + 1, kind: Object.assign({ type }, init || {}), focusCol: Store.ui.selCols[0] });
  }
  function removeSelected() { if (Store.ui.selCols.length) { Store.addStep({ type: 'RemoveColumns', cols: Store.ui.selCols.slice() }); Store.ui.selCols = []; } }
  function detectTypes(cols) {
    const s = (App.result && App.result.suggestions || []).find((x) => x.id === 'types');
    if (s && !cols) return Store.addStep(s.kind);
    UI.toast('Types already set', null, { ms: 2000 });
  }
  async function enterData() {
    const q = { id: PQ.uid('q'), name: PQ.uniqueName('Table', Store.project.queries.map((x) => x.name)), load: { target: 'none' }, steps: [{ id: PQ.uid('s'), name: 'Source', kind: { type: 'Source', source: { kind: 'blank', columns: ['Code', 'Label'], rows: [['EU', 'Europe'], ['US', 'United States'], ['APAC', 'Asia-Pacific'], ['LATAM', 'Latin America']] } } }] };
    Store.edit('Enter data', (p) => { p.queries.push(q); }, { activeQid: q.id, activeStep: null });
    setTimeout(() => UI.editStep({ qid: q.id, index: 0 }), 50);
  }
  function referenceQuery(src) {
    const q = { id: PQ.uid('q'), name: PQ.uniqueName(src.name + ' (2)', Store.project.queries.map((x) => x.name)), load: { target: 'none' }, steps: [{ id: PQ.uid('s'), name: 'Source', kind: { type: 'Source', source: { kind: 'query', query: src.id } } }] };
    Store.edit('Reference ' + src.name, (p) => { p.queries.push(q); }, { activeQid: q.id, activeStep: null });
  }

  /* ================================ left panel ================================ */
  function renderQueries() {
    const ul = UI.clear($('#query-list'));
    Store.project.queries.forEach((q) => {
      const st = App.queryStatus.get(q.id);
      const src = q.steps[0] && q.steps[0].kind.source;
      const kind = !src ? 'blank' : src.kind === 'query' ? 'query' : src.kind === 'folder' ? 'folder' : src.kind === 'blank' ? 'blank' : /xls|ods/i.test(src.fileName || '') ? 'excel' : 'csv';
      const icon = { blank: 'fa-keyboard', query: 'fa-link', folder: 'fa-folder', excel: 'fa-file-excel', csv: 'fa-file-csv' }[kind];
      const li = h('li.q-item', { class: q.id === Store.ui.activeQid ? 'active' : '', dataset: { src: kind }, tabindex: 0, role: 'option', 'aria-selected': q.id === Store.ui.activeQid ? 'true' : 'false', title: q.name, on: { click: () => App.selectQuery(q.id), dblclick: () => renameQuery(q), keydown: (e) => { if (e.key === 'Enter') App.selectQuery(q.id); if (e.key === 'F2') renameQuery(q); }, contextmenu: (e) => { e.preventDefault(); queryMenu(q, e.clientX, e.clientY); } } },
        h('span.q-icon', UI.icon(icon)), h('span.grow', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, q.name),
        h('span.q-meta', st && st.error ? UI.icon('fa-circle-exclamation', 'q-err') : null, q.load && q.load.target !== 'none' ? h('span.load-badge', q.load.target) : null, h('span', q.steps.length)));
      ul.appendChild(li);
    });
    if (!Store.project.queries.length) ul.appendChild(h('li.muted', { style: { padding: '10px', fontSize: '12px' } }, 'No queries yet.'));
  }
  App.selectQuery = function (id) {
    if (id === Store.ui.activeQid) return;
    Store.ui.selCols = [];
    Store.setUI({ activeQid: id, activeStep: null });
    App.grid.setSelection([]);
    App.refresh();
  };
  async function renameQuery(q) {
    const name = await UI.prompt('Rename query', 'Name', q.name);
    if (!name || name === q.name) return;
    if (Store.project.queries.some((x) => x.name === name)) return UI.toast('A query with that name already exists', 'err');
    Store.edit('Rename query', (p) => { p.queries.find((x) => x.id === q.id).name = name; });
  }
  function queryMenu(q, x, y) {
    UI.menu([
      { label: 'Rename', icon: 'fa-i-cursor', kbd: 'F2', run: () => renameQuery(q) },
      { label: 'Duplicate', icon: 'fa-clone', run: () => { const c = JSON.parse(JSON.stringify(q)); c.id = PQ.uid('q'); c.name = PQ.uniqueName(q.name + ' (copy)', Store.project.queries.map((z) => z.name)); c.steps.forEach((s) => (s.id = PQ.uid('s'))); Store.edit('Duplicate query', (p) => { p.queries.splice(p.queries.findIndex((z) => z.id === q.id) + 1, 0, c); }, { activeQid: c.id, activeStep: null }); } },
      { label: 'Reference', icon: 'fa-link', run: () => referenceQuery(q) },
      '-',
      { label: 'Load to', icon: 'fa-file-export', sub: [['none', 'Connection only'], ['xlsx', 'Excel workbook'], ['csv', 'CSV'], ['parquet', 'Parquet (desktop)']].map(([t, l]) => ({ label: l + (q.load && q.load.target === t ? '  ✓' : ''), run: () => Store.edit('Set output', (p) => { p.queries.find((z) => z.id === q.id).load = { target: t }; }) })) },
      { label: 'Export to Python', icon: 'fa-brands fa-python', run: () => UI.pythonDialog(q.id) },
      '-',
      { label: 'Move up', icon: 'fa-arrow-up', run: () => moveQuery(q, -1) },
      { label: 'Move down', icon: 'fa-arrow-down', run: () => moveQuery(q, 1) },
      '-',
      { label: 'Delete', icon: 'fa-trash', danger: true, run: () => deleteQuery(q) },
    ], x, y);
  }
  function moveQuery(q, d) { Store.edit('Move query', (p) => { const i = p.queries.findIndex((z) => z.id === q.id), j = i + d; if (j < 0 || j >= p.queries.length) return false; [p.queries[i], p.queries[j]] = [p.queries[j], p.queries[i]]; }); }
  async function deleteQuery(q) {
    const users = Store.project.queries.filter((o) => o.id !== q.id && o.steps.some((s) => (s.kind.source && s.kind.source.query === q.id) || s.kind.right === q.id || (s.kind.others || []).includes(q.id)));
    if (users.length && !(await UI.confirm('Delete ' + q.name + '?', 'These queries depend on it and will break: ' + users.map((u) => u.name).join(', ') + '. (You can undo.)', 'Delete anyway'))) return;
    Store.edit('Delete query ' + q.name, (p) => { p.queries = p.queries.filter((z) => z.id !== q.id); }, (p) => ({ activeQid: (p.queries[0] || {}).id || null, activeStep: null }));
  }

  function renderFiles() {
    const ul = UI.clear($('#file-list'));
    const loose = App.files.filter((f) => !f.folder);
    const folders = App.folders();
    const item = (f) => h('li.f-item', { title: f.name + ' · ' + UI.fmtBytes(f.size) },
      UI.icon(f.kind === 'excel' ? 'fa-file-excel' : f.kind === 'json' ? 'fa-file-code' : 'fa-file-csv', 'fa-fw muted'),
      h('span.grow', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, f.name),
      h('span.f-actions', !f.folder ? h('button.icon-btn', { title: 'Load into a new query', 'aria-label': 'Load ' + f.name, on: { click: () => UI.navigator(f.id) } }, UI.icon('fa-plus')) : null,
        h('button.icon-btn.danger', { title: 'Remove file', 'aria-label': 'Remove ' + f.name, on: { click: async () => { await UI.Engine.call('removeFile', { id: f.id }); await App.reloadFiles(); App.refresh(); } } }, UI.icon('fa-trash'))));
    loose.forEach((f) => { const li = item(f); li.addEventListener('dblclick', () => UI.navigator(f.id)); ul.appendChild(li); });
    folders.forEach((fd) => { ul.appendChild(h('li.f-folder', UI.icon('fa-folder'), ' ', fd, ' ', h('button.link-btn', { style: { fontSize: '10px' }, on: { click: UI.folderDialog } }, 'combine'))); App.files.filter((f) => f.folder === fd).forEach((f) => ul.appendChild(item(f))); });
    $('#drop-hint').classList.toggle('hidden', App.files.length > 3);
  }

  /* ================================ right panel ================================ */
  function renderRight() {
    UI.$$('#right-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === Store.ui.rightTab));
    $('#tab-steps').classList.toggle('hidden', Store.ui.rightTab !== 'steps');
    $('#tab-profile').classList.toggle('hidden', Store.ui.rightTab !== 'profile');
    $('#tab-schema').classList.toggle('hidden', Store.ui.rightTab !== 'schema');
    renderQueryProps();
    if (Store.ui.rightTab === 'schema') renderSchema();
  }
  function renderQueryProps() {
    const box = UI.clear($('#query-props'));
    const q = Store.query(); if (!q) return;
    const name = h('input.input.sm', { value: q.name, 'aria-label': 'Query name', on: { change: (e) => { const v = e.target.value.trim(); if (!v || v === q.name) return; if (Store.project.queries.some((x) => x.name === v)) { UI.toast('Name already used', 'err'); e.target.value = q.name; return; } Store.edit('Rename query', (p) => { p.queries.find((x) => x.id === q.id).name = v; }); } } });
    const load = UI.W.select([['none', 'Connection only'], ['xlsx', 'Excel workbook (.xlsx)'], ['csv', 'CSV'], ['parquet', 'Parquet (desktop build)']], (q.load || {}).target || 'none', { class: 'sm', 'aria-label': 'Load to' });
    load.classList.add('sm');
    load.addEventListener('change', () => Store.edit('Set output', (p) => { p.queries.find((x) => x.id === q.id).load = { target: load.value }; }));
    box.append(h('div.grid-2', h('div', h('label', 'Name'), name), h('div', h('label', 'Load to'), load)));
  }
  function renderSteps() {
    const ul = UI.clear($('#step-list'));
    const q = Store.query();
    if (!q) return;
    const active = Store.activeIndex();
    q.steps.forEach((s, i) => {
      const st = App.states[i];
      const cat = PQ.Steps.CATALOG[s.kind.type] || {};
      const err = st && !st.ok && !st.blocked;
      const li = h('li.step', { class: (i === active ? 'active ' : '') + (i > active ? 'after ' : '') + (err ? 'error ' : '') + (st && st.ok && i < active ? 'done ' : '') + (cat.materializes ? 'mat ' : '') + (s.disabled ? 'disabled' : ''), draggable: i > 0 ? 'true' : null, tabindex: 0, dataset: { i },
        title: err ? st.error : PQ.Steps.describe(s.kind) + (s.note ? '\n\nNote: ' + s.note : ''),
        on: { click: () => selectStep(i), dblclick: () => UI.editStep({ qid: q.id, index: i }), contextmenu: (e) => { e.preventDefault(); stepMenu(q, i, e.clientX, e.clientY); }, keydown: (e) => { if (e.key === 'Enter') UI.editStep({ qid: q.id, index: i }); if (e.key === 'Delete' && i > 0) deleteStep(q, i); } } },
        h('span.s-idx', i + 1),
        h('span.s-ico', { title: 'Step ' + (i + 1) }, UI.icon(err ? 'fa-circle-exclamation' : cat.icon || 'fa-gear')),
        h('div.s-body', h('div.s-name', s.name), h('div.s-desc', err ? st.error : PQ.Steps.describe(s.kind))),
        h('span.s-flags',
          s.note ? UI.icon('fa-note-sticky', 's-note') : null,
          cat.materializes ? h('span', { title: 'Forces materialization — the engine checkpoints here, later steps stay lazy' }, UI.icon('fa-bolt', 's-mat')) : null,
          st && st.ok && st.cached && !s.disabled ? h('span', { title: 'Result cached (fingerprint ' + (st.fp || '').slice(0, 8) + ')' }, UI.icon('fa-database', 's-cache')) : null,
          st && st.ok && (st.rows || i === active) ? h('span.rows', { title: PQ.fmtInt(st.rows) + ' rows × ' + st.cols + ' cols · ' + UI.fmtMs(st.ms) }, fmtShort(st.rows)) : null),
        h('span.s-actions',
          h('button.icon-btn', { title: 'Edit step', 'aria-label': 'Edit ' + s.name, on: { click: (e) => { e.stopPropagation(); UI.editStep({ qid: q.id, index: i }); } } }, UI.icon('fa-gear')),
          i > 0 ? h('button.icon-btn.danger', { title: 'Delete step', 'aria-label': 'Delete ' + s.name, on: { click: (e) => { e.stopPropagation(); deleteStep(q, i); } } }, UI.icon('fa-xmark')) : null));
      if (i > 0) {
        li.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/step', String(i)); e.dataTransfer.effectAllowed = 'move'; });
        li.addEventListener('dragover', (e) => { if (!e.dataTransfer.types.includes('text/step')) return; e.preventDefault(); const r = li.getBoundingClientRect(); const after = e.clientY > r.top + r.height / 2; li.classList.toggle('drop-after', after); li.classList.toggle('drop-before', !after); });
        li.addEventListener('dragleave', () => li.classList.remove('drop-after', 'drop-before'));
        li.addEventListener('drop', (e) => {
          e.preventDefault(); li.classList.remove('drop-after', 'drop-before');
          const from = +e.dataTransfer.getData('text/step'); const r = li.getBoundingClientRect(); let to = e.clientY > r.top + r.height / 2 ? i + 1 : i;
          if (from < to) to--;
          if (to < 1 || to === from) return;
          Store.edit('Move step', (p) => { const st2 = p.queries.find((x) => x.id === q.id).steps; const [m] = st2.splice(from, 1); st2.splice(to, 0, m); }, { activeStep: null });
        });
      }
      ul.appendChild(li);
    });
  }
  const fmtShort = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e4 ? Math.round(n / 1e3) + 'k' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n));
  function selectStep(i) {
    const q = Store.query();
    Store.ui.activeStep = i === q.steps.length - 1 ? null : i;
    renderSteps(); renderFormulaBar();
    App.refresh({ keepScroll: true });
  }
  function deleteStep(q, i) {
    const after = q.steps.length - 1 - i;
    Store.edit('Delete ' + q.steps[i].name, (p) => { p.queries.find((x) => x.id === q.id).steps.splice(i, 1); }, { activeStep: null });
    if (after > 0) UI.toast('Deleted "' + q.steps[i].name + '". Later steps that referenced its columns will show fixes.', null, { actions: [{ label: 'Undo', run: Store.undoOne }] });
  }
  function stepMenu(q, i, x, y) {
    const s = q.steps[i];
    UI.menu([
      { label: 'Edit settings', icon: 'fa-gear', kbd: 'Enter', run: () => UI.editStep({ qid: q.id, index: i }) },
      { label: 'Rename', icon: 'fa-i-cursor', run: async () => { const n = await UI.prompt('Rename step', 'Name', s.name); if (n) Store.edit('Rename step', (p) => { p.queries.find((z) => z.id === q.id).steps[i].name = n; }); } },
      { label: s.disabled ? 'Enable step' : 'Disable step', icon: s.disabled ? 'fa-eye' : 'fa-eye-slash', disabled: i === 0, run: () => Store.edit('Toggle step', (p) => { const st = p.queries.find((z) => z.id === q.id).steps[i]; st.disabled = !st.disabled || undefined; }) },
      { label: 'Insert step after', icon: 'fa-plus', sub: [['AddColumn', 'Custom column'], ['Filter', 'Filter rows'], ['ChangeType', 'Change type'], ['Rename', 'Rename columns'], ['RemoveColumns', 'Remove columns'], ['CustomSql', 'Custom SQL'], ['Checkpoint', 'Checkpoint (buffer)']].map(([t, l]) => ({ label: l, run: () => { Store.ui.activeStep = i; UI.editStep({ qid: q.id, insertAt: i + 1, kind: { type: t, ...(t === 'CustomSql' ? { sql: 'SELECT * FROM self' } : {}) } }); } })) },
      { label: 'Extract previous', icon: 'fa-scissors', disabled: i === 0, title: 'Split the query here', run: () => extractPrevious(q, i) },
      '-',
      { label: 'Move up', icon: 'fa-arrow-up', disabled: i <= 1, run: () => Store.edit('Move step', (p) => { const st = p.queries.find((z) => z.id === q.id).steps; [st[i - 1], st[i]] = [st[i], st[i - 1]]; }) },
      { label: 'Move down', icon: 'fa-arrow-down', disabled: i === 0 || i >= q.steps.length - 1, run: () => Store.edit('Move step', (p) => { const st = p.queries.find((z) => z.id === q.id).steps; [st[i + 1], st[i]] = [st[i], st[i + 1]]; }) },
      { label: 'Delete until end', icon: 'fa-trash-can-arrow-up', danger: true, disabled: i === 0, run: () => Store.edit('Delete until end', (p) => { p.queries.find((z) => z.id === q.id).steps.splice(i); }, { activeStep: null }) },
      { label: 'Delete', icon: 'fa-trash', danger: true, disabled: i === 0, kbd: 'Del', run: () => deleteStep(q, i) },
    ], x, y);
  }
  /** "Extract previous": steps 0..i-1 become a new query; this query now references it. */
  function extractPrevious(q, i) {
    const nq = { id: PQ.uid('q'), name: PQ.uniqueName(q.name + ' (base)', Store.project.queries.map((x) => x.name)), load: { target: 'none' }, steps: JSON.parse(JSON.stringify(q.steps.slice(0, i))) };
    Store.edit('Extract previous', (p) => {
      const qq = p.queries.find((z) => z.id === q.id);
      qq.steps = [{ id: PQ.uid('s'), name: 'Source', kind: { type: 'Source', source: { kind: 'query', query: nq.id } } }].concat(qq.steps.slice(i));
      p.queries.splice(p.queries.indexOf(qq), 0, nq);
    }, { activeStep: null });
    UI.toast('Created "' + nq.name + '" from steps 1–' + i, 'ok');
  }

  function renderSchema() {
    const box = UI.clear($('#tab-schema'));
    const q = Store.query(); if (!q) return;
    const i = Store.activeIndex(), st = App.states[i];
    if (!st || !st.ok) return box.appendChild(h('p.muted', { style: { padding: '12px' } }, 'No schema — this step has an error.'));
    const prev = i > 0 && App.states[i - 1] && App.states[i - 1].ok ? App.states[i - 1].schema : [];
    const added = st.schema.filter((c) => !prev.some((p) => p.name === c.name)).map((c) => c.name);
    const removed = prev.filter((p) => !st.schema.some((c) => c.name === p.name)).map((c) => c.name);
    const changed = st.schema.filter((c) => prev.some((p) => p.name === c.name && p.type !== c.type)).map((c) => c.name);
    box.append(h('div.props',
      h('h4', UI.icon(PQ.Steps.icon(q.steps[i].kind.type)), 'After step ' + (i + 1) + ': ' + q.steps[i].name),
      h('dl.kv', h('dt', 'Rows'), h('dd', PQ.fmtInt(st.rows) + (App.lastRun && App.lastRun.truncated ? ' (sample)' : '')), h('dt', 'Columns'), h('dd', st.cols), h('dt', 'Step time'), h('dd', UI.fmtMs(st.ms) + (st.cached ? ' (cache hit)' : '')), h('dt', 'Fingerprint'), h('dd', st.fp || '')),
      i > 0 ? h('div.muted', { style: { fontSize: '12px' } }, added.length ? h('div', { style: { color: 'var(--ok)' } }, '+ ' + added.join(', ')) : null, removed.length ? h('div', { style: { color: 'var(--err)' } }, '− ' + removed.join(', ')) : null, changed.length ? h('div', { style: { color: 'var(--warn)' } }, '~ type changed: ' + changed.join(', ')) : null, !added.length && !removed.length && !changed.length ? 'No schema change' : null) : null,
      h('ul.schema-list', st.schema.map((c) => h('li', UI.typeChip(c.type), h('span.grow', { class: added.includes(c.name) ? 'diff-add' : changed.includes(c.name) ? 'diff-mod' : '' }, c.name), h('span.faint', { style: { fontSize: '11px' } }, PQ.TYPES[c.type].label))))));
  }

  async function loadProfile() {
    const box = $('#tab-profile');
    const col = Store.ui.selCols[0];
    if (!App.result || !col) { UI.clear(box).appendChild(h('div.props', h('p.faint', 'Select a column.'))); return; }
    const res = App.result;
    try {
      const { profile: p } = await UI.Engine.call('profile', { resultId: res.resultId, col });
      if (App.result !== res) return;
      const v = (x) => (x === null || x === undefined ? '—' : x && x.__err ? 'Error' : x instanceof Date ? PQ.fmtDate(x) : typeof x === 'number' ? (+x.toFixed(4)).toLocaleString() : String(x));
      const maxTop = p.top.length ? p.top[0].count : 1;
      UI.clear(box).appendChild(h('div.profile',
        h('h4', UI.typeChip(p.type), p.col),
        h('div.stat-grid',
          stat('Count', PQ.fmtInt(p.count)), stat('Distinct', PQ.fmtInt(p.distinct)), stat('Unique', PQ.fmtInt(p.unique)), stat('Empty', PQ.fmtInt(p.empty) + ' (' + Math.round((p.empty / Math.max(1, p.count)) * 100) + '%)'),
          stat('Errors', PQ.fmtInt(p.errors), p.errors ? 'err' : ''), stat('Min', v(p.min)), stat('Max', v(p.max)),
          p.mean !== null ? stat('Mean', v(p.mean)) : null, p.stdev !== null ? stat('Std dev', v(p.stdev)) : null, p.minLen !== null ? stat('Text length', p.minLen + '–' + p.maxLen) : null),
        p.hist ? h('div', h('div.field-label', 'Distribution'), h('div.hist', p.hist.bins.map((b) => h('span', { style: { height: (b / Math.max(...p.hist.bins)) * 100 + '%' }, title: PQ.fmtInt(b) }))), h('div.row.faint', { style: { fontSize: '10.5px', justifyContent: 'space-between' } }, h('span', v(p.hist.min)), h('span', v(p.hist.max)))) : null,
        h('div', h('div.field-label', 'Top values'), h('ul.topv', p.top.map((t) => h('li', { title: 'Filter to this value', style: { cursor: 'pointer' }, on: { click: () => Store.addStep({ type: 'Filter', mode: 'builder', builder: { join: 'and', conds: [{ col, op: 'in', values: [t.value] }] } }) } }, h('span.bar', { style: { width: (t.count / maxTop) * 100 + '%' } }), h('span', v(t.value)), h('span.faint', PQ.fmtInt(t.count)))))),
        p.errors ? h('div.row', h('button.btn.sm', { on: { click: () => Store.addStep({ type: 'KeepErrors', cols: [col] }) } }, 'Keep errors'), h('button.btn.sm', { on: { click: () => Store.addStep({ type: 'RemoveErrors', cols: [col] }) } }, 'Remove errors'), h('button.btn.sm', { on: { click: () => stepDialog('ReplaceErrors', { cols: [col], value: '' }) } }, 'Replace…')) : null,
        h('div.faint', { style: { fontSize: '11px' } }, App.lastRun && App.lastRun.truncated ? 'Sample' : 'All rows')));
    } catch (e) { UI.clear(box).appendChild(h('p.muted', { style: { padding: '12px' } }, e.message)); }
  }
  const stat = (k, v, cls) => h('div.stat', h('div.k', k), h('div.v', { class: cls || '', title: v }, v));

  /* ================================ formula bar / suggestions / banner / status ================================ */
  function renderFormulaBar() {
    const q = Store.query();
    const el = $('#step-summary');
    if (!q) { el.textContent = ''; return; }
    const s = q.steps[Store.activeIndex()];
    UI.clear(el);
    if (s) el.append(h('b', s.name), '  =  ' + PQ.Steps.describe(s.kind));
    el.title = el.textContent;
  }
  function renderSuggestions(list) {
    const bar = UI.clear($('#suggest-bar'));
    const q = Store.query();
    const visible = list.filter((s) => !App.dismissed.has(q.id + ':' + s.id + ':' + Store.activeIndex()));
    if (!visible.length) return;
    bar.appendChild(h('span.suggest-label', UI.icon('fa-wand-magic-sparkles'), ' Suggested'));
    visible.forEach((s) => bar.appendChild(h('button.chip', { class: s.tone || '', title: s.detail || '', on: { click: (e) => { if (e.target.closest('.x')) { App.dismissed.add(q.id + ':' + s.id + ':' + Store.activeIndex()); renderSuggestions(list); return; } Store.addStep(s.kind); } } }, UI.icon(s.icon), s.text, h('span.x', { title: 'Dismiss', role: 'button', 'aria-label': 'Dismiss suggestion' }, UI.icon('fa-xmark')))));
  }
  function renderBanner() {
    const b = $('#preview-banner');
    b.classList.toggle('full', !!(App.lastRun && App.lastRun.mode === 'full'));
    if (App.lastRun && App.lastRun.mode !== 'full' && App.lastRun.truncated) {
      UI.clear(b).append(h('span', 'Sample · first ', h('b', PQ.fmtInt(Store.project.settings.previewRows)), ' rows'), h('button.link-btn', { on: { click: App.runFull } }, 'Run on full data'));
      b.classList.remove('hidden');
    } else if (App.lastRun && App.lastRun.mode === 'full') {
      UI.clear(b).append(UI.icon('fa-mountain-sun'), h('span', 'Showing ', h('b', 'full data'), ' · computed in ' + UI.fmtMs(App.lastRun.ms) + '.'), h('button.link-btn', { on: { click: () => App.setMode('preview') } }, 'Back to preview'));
      b.classList.remove('hidden');
    } else b.classList.add('hidden');
  }
  function renderStatus() {
    const r = App.result;
    $('#st-rows').textContent = r ? PQ.fmtInt(r.n) + ' × ' + r.schema.length : '—';
    $('#st-time').textContent = App.lastRun ? UI.fmtMs(App.lastRun.ms) : '';
    const hits = App.states.filter((s) => s && s.cached).length;
    $('#st-cache').textContent = App.states.length && hits ? hits + '/' + App.states.length + ' cached' : '';
    $('#st-mode').textContent = App.lastRun ? (App.lastRun.mode === 'full' ? 'Full' : 'Sample ' + PQ.fmtInt(Store.project.settings.previewRows)) : '';
    renderEngineState(UI.Engine.state);
    renderRibbonState();
  }
  function renderEngineState(state) {
    const dot = $('#engine-dot'), lbl = $('#engine-label');
    dot.className = 'engine-dot' + (state === 'busy' ? ' busy' : state === 'restarting' || state === 'starting' ? ' dead' : '');
    lbl.textContent = { idle: 'Ready', busy: 'Working', starting: 'Starting', restarting: 'Restarting' }[state] || state;
    const eng = UI.Engine.lastEngine === 'polars' ? 'Polars' : UI.NativeEngine.available() ? 'Built-in' : null;
    if (eng && state === 'idle') lbl.textContent += ' · ' + eng;
  }

  /* ================================ column menus ================================ */
  function filteredCols() {
    const q = Store.query(); const out = new Set(); if (!q) return out;
    q.steps.slice(0, Store.activeIndex() + 1).forEach((s) => { if (s.kind.type === 'Filter') { const f = PQ.Engine.filterFormula(s.kind); PQ.Formula.columns(f).forEach((c) => out.add(c)); } });
    return out;
  }
  function anchorXY(anchor) { const r = anchor.getBoundingClientRect(); return [r.left, r.bottom + 2]; }
  function typeMenu(c, anchor) {
    const [x, y] = anchorXY(anchor);
    UI.menu([{ header: 'Change type of ' + c.name }].concat(Object.keys(PQ.TYPES).filter((t) => t !== 'any').map((t) => ({ label: PQ.TYPES[t].label + (t === c.type ? '  ✓' : ''), icon: null, run: () => changeType([c.name], t) }))).concat(['-', { label: 'Using locale…', icon: 'fa-globe', run: () => stepDialog('ChangeType', { changes: [{ col: c.name, type: c.type === 'text' ? 'number' : c.type }], onError: 'error' }) }]), x, y);
  }
  function changeType(cols, t) { Store.addStep({ type: 'ChangeType', changes: cols.map((col) => ({ col, type: t })), onError: 'error' }); }
  function columnMenu(c, anchor) {
    const [x, y] = anchorXY(anchor);
    const sel = Store.ui.selCols.length ? Store.ui.selCols : [c.name];
    const multi = sel.length > 1;
    const isText = c.type === 'text' || c.type === 'any', isNum = c.type === 'int' || c.type === 'number';
    const items = [
      { node: filterPopover(c) },
      '-',
      { label: 'Sort ascending', icon: 'fa-arrow-up-short-wide', run: () => Store.addStep({ type: 'Sort', by: [{ col: c.name, desc: false }] }) },
      { label: 'Sort descending', icon: 'fa-arrow-down-wide-short', run: () => Store.addStep({ type: 'Sort', by: [{ col: c.name, desc: true }] }) },
      '-',
      { label: multi ? 'Remove ' + sel.length + ' columns' : 'Remove', icon: 'fa-delete-left', kbd: 'Del', run: () => Store.addStep({ type: 'RemoveColumns', cols: sel }) },
      { label: 'Remove other columns', icon: 'fa-table-columns', run: () => Store.addStep({ type: 'SelectColumns', cols: sel }) },
      { label: 'Rename…', icon: 'fa-i-cursor', disabled: multi, run: async () => { const n = await UI.prompt('Rename column', 'New name for ' + c.name, c.name); if (n && n !== c.name) Store.addStep({ type: 'Rename', map: [[c.name, n]] }); } },
      { label: 'Move to front', icon: 'fa-arrow-left', run: () => Store.addStep({ type: 'ReorderColumns', cols: sel }) },
      { label: 'Duplicate column', icon: 'fa-clone', disabled: multi, run: () => Store.addStep({ type: 'DuplicateColumn', col: c.name }) },
      '-',
      { label: 'Change type', icon: 'fa-shapes', sub: Object.keys(PQ.TYPES).filter((t) => t !== 'any').map((t) => ({ label: PQ.TYPES[t].label, run: () => changeType(sel, t) })) },
      { label: 'Replace values…', icon: 'fa-right-left', run: () => stepDialog('ReplaceValues', { cols: sel, find: '', replace: '', wholeCell: !isText }) },
      { label: 'Fill', icon: 'fa-angles-down', sub: [{ label: 'Down', icon: 'fa-angles-down', run: () => Store.addStep({ type: 'FillDown', cols: sel }) }, { label: 'Up', icon: 'fa-angles-up', run: () => Store.addStep({ type: 'FillUp', cols: sel }) }] },
      { label: 'Transform text', icon: 'fa-font', sub: [['trim', 'Trim'], ['clean', 'Clean'], ['upper', 'UPPERCASE'], ['lower', 'lowercase'], ['proper', 'Capitalize Each Word']].map(([op, l]) => ({ label: l, run: () => Store.addStep({ type: 'TextTransform', op, cols: sel }) })) },
      isNum ? { label: 'Round…', icon: 'fa-hashtag', run: () => stepDialog('RoundNumbers', { cols: sel, digits: 2 }) } : null,
      { label: 'Split column', icon: 'fa-scissors', disabled: multi, sub: [{ label: 'By delimiter…', run: () => stepDialog('SplitColumn', { col: c.name, mode: 'each', delimiter: guessDelim(c) }) }, { label: 'By positions…', run: () => stepDialog('SplitColumn', { col: c.name, mode: 'positions', positions: '0, 3' }) }, { label: 'Into rows…', run: () => stepDialog('SplitColumn', { col: c.name, mode: 'rows', delimiter: guessDelim(c) }) }] },
      { label: 'Merge columns…', icon: 'fa-object-group', disabled: !multi, run: () => stepDialog('MergeColumns', { cols: sel, sep: ' ', name: 'Merged' }) },
      { label: 'Expand JSON', icon: 'fa-sitemap', disabled: multi || !isText, run: () => Store.addStep({ type: 'ExpandJson', col: c.name }) },
      '-',
      { label: 'Group by…', icon: 'fa-layer-group', run: () => stepDialog('GroupBy', { keys: sel, aggs: [{ fn: 'count_rows', name: 'Count' }] }) },
      { label: 'Unpivot', icon: 'fa-table-cells', sub: [{ label: 'Unpivot selected columns', run: () => Store.addStep({ type: 'Unpivot', ids: App.result.schema.map((z) => z.name).filter((n) => !sel.includes(n)) }) }, { label: 'Unpivot other columns', run: () => Store.addStep({ type: 'Unpivot', ids: sel }) }] },
      { label: 'Remove duplicates', icon: 'fa-clone', run: () => Store.addStep({ type: 'Distinct', subset: sel }) },
      { label: 'Remove errors', icon: 'fa-circle-xmark', run: () => Store.addStep({ type: 'RemoveErrors', cols: sel }) },
      { label: 'Replace errors…', icon: 'fa-bandage', run: () => stepDialog('ReplaceErrors', { cols: sel, value: '' }) },
      '-',
      { label: 'Profile column', icon: 'fa-chart-simple', run: () => { Store.setUI({ rightTab: 'profile' }); renderRight(); loadProfile(); } },
      { label: 'Copy column values', icon: 'fa-copy', run: () => copyColumn(c) },
    ].filter(Boolean);
    const m = UI.menu(items, x, y, { focus: false });
    m.style.maxHeight = (innerHeight - 20) + 'px'; m.style.overflow = 'auto';
    UI.placeAt(m, x, y);
  }
  function guessDelim(c) {
    const i = App.result.schema.findIndex((z) => z.name === c.name);
    const vals = (App.result.firstPage || []).map((r) => r[i]).filter((v) => typeof v === 'string').slice(0, 50).join('\n');
    for (const d of [', ', ',', ';', ' - ', '-', '|', '/', ' ']) if (vals.split(d).length > 10) return d;
    return ',';
  }
  async function copyColumn(c) {
    const { values } = await UI.Engine.call('distinct', { resultId: App.result.resultId, col: c.name });
    navigator.clipboard.writeText(values.map((v) => UI.cellText(v.value, c.type).text).join('\n'));
    UI.toast('Copied ' + values.length + ' distinct values', 'ok');
  }
  /** Checkbox filter with search, like Excel's autofilter. Produces a Filter step with an `in` condition. */
  function filterPopover(c) {
    const box = h('div.filter-pop', { on: { mousedown: (e) => e.stopPropagation(), click: (e) => e.stopPropagation() } });
    const search = h('input.input.sm', { placeholder: 'Search values…', 'aria-label': 'Search values' });
    const vals = h('div.vals', h('div.muted', { style: { padding: '6px', fontSize: '12px' } }, 'Loading…'));
    const apply = h('button.btn.sm.primary', 'Apply filter');
    const more = h('button.btn.sm', 'Custom…');
    box.append(h('div.row', UI.icon('fa-filter', 'muted'), h('b', { style: { fontSize: '12px' } }, 'Filter ' + c.name)), search, vals, h('div.row', h('span.grow.faint', { style: { fontSize: '10.5px' } }, App.lastRun && App.lastRun.truncated ? 'Values from preview sample' : ''), more, apply));
    let list = [], checked = new Set();
    UI.Engine.call('distinct', { resultId: App.result.resultId, col: c.name }).then(({ values }) => {
      list = values; checked = new Set(values.map((_, i) => i));
      draw();
    });
    const draw = () => {
      const s = search.value.toLowerCase();
      UI.clear(vals);
      const shown = list.map((v, i) => ({ v, i })).filter(({ v }) => !s || UI.cellText(v.value, c.type).text.toLowerCase().includes(s));
      const allOn = shown.every(({ i }) => checked.has(i));
      const all = h('label', h('input', { type: 'checkbox', checked: allOn }), h('b', '(Select all' + (s ? ' matches' : '') + ')'));
      all.querySelector('input').addEventListener('change', (e) => { shown.forEach(({ i }) => (e.target.checked ? checked.add(i) : checked.delete(i))); draw(); });
      vals.appendChild(all);
      shown.slice(0, 500).forEach(({ v, i }) => {
        const t = UI.cellText(v.value, c.type);
        const lab = h('label', h('input', { type: 'checkbox', checked: checked.has(i) }), h('span', { class: t.cls, style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, t.text), h('span.cnt', PQ.fmtInt(v.count)));
        lab.querySelector('input').addEventListener('change', (e) => { e.target.checked ? checked.add(i) : checked.delete(i); });
        vals.appendChild(lab);
      });
      if (list.length >= 1000) vals.appendChild(h('div.faint', { style: { fontSize: '11px', padding: '4px' } }, 'First 1,000 values'));
    };
    search.addEventListener('input', draw);
    apply.addEventListener('click', () => {
      UI.closeMenu();
      if (checked.size === list.length) return;
      const picked = list.filter((_, i) => checked.has(i)).map((v) => v.value).filter((v) => !(v && v.__err));
      const excluded = list.filter((_, i) => !checked.has(i)).map((v) => v.value).filter((v) => !(v && v.__err));
      const toLit = (arr) => arr.map((v) => (v instanceof Date ? PQ.fmtDate(v) : v));
      const cond = excluded.length < picked.length ? { col: c.name, op: 'not_in', values: toLit(excluded) } : { col: c.name, op: 'in', values: toLit(picked) };
      Store.addStep({ type: 'Filter', mode: 'builder', builder: { join: 'and', conds: [cond] } });
    });
    more.addEventListener('click', () => { UI.closeMenu(); stepDialog('Filter', { mode: 'builder', builder: { join: 'and', conds: [{ col: c.name, op: c.type === 'text' ? 'contains' : 'gt', value: '' }] } }); });
    return box;
  }
  function cellMenu(c, v, x, y) {
    const lit = v && v.__err ? null : v;
    const txt = UI.cellText(v, c.type).text;
    UI.menu([
      { header: c.name + ' = ' + (txt.length > 30 ? txt.slice(0, 30) + '…' : txt) },
      { label: 'Copy value', icon: 'fa-copy', run: () => navigator.clipboard.writeText(txt) },
      '-',
      { label: 'Keep rows equal to this', icon: 'fa-filter', run: () => Store.addStep({ type: 'Filter', mode: 'builder', builder: { join: 'and', conds: [{ col: c.name, op: 'in', values: [lit instanceof Date ? PQ.fmtDate(lit) : lit] }] } }) },
      { label: 'Remove rows equal to this', icon: 'fa-filter-circle-xmark', run: () => Store.addStep({ type: 'Filter', mode: 'builder', builder: { join: 'and', conds: [{ col: c.name, op: 'not_in', values: [lit instanceof Date ? PQ.fmtDate(lit) : lit] }] } }) },
      { label: 'Replace this value…', icon: 'fa-right-left', run: () => stepDialog('ReplaceValues', { cols: [c.name], find: lit === null ? '' : String(PQ.fmtValue(lit)), replace: '', wholeCell: true }) },
      v && v.__err ? { label: 'Why is this an error?', icon: 'fa-circle-question', run: () => UI.modal({ title: 'Cell error', icon: 'fa-triangle-exclamation', body: h('div.col', h('div.callout.err', UI.icon('fa-circle-exclamation'), h('div', v.__err))) }) } : null,
    ].filter(Boolean), x, y);
  }

  /* ================================ export ================================ */
  async function exportAs(fmt) {
    const q = Store.query(); if (!q) return;
    App.busy('Exporting ' + q.name, true);
    try {
      const r = await UI.Engine.call('exportQuery', { qid: q.id, format: fmt, limit: fmt === 'tsv' ? 100000 : undefined }, (p) => App.progress(p));
      if (fmt === 'tsv') { await navigator.clipboard.writeText(r.data); UI.toast('Copied ' + PQ.fmtInt(Math.min(r.rows, 100000)) + ' rows as TSV — paste straight into Excel.', 'ok'); }
      else { UI.download(PQ.snake(q.name) + '.' + fmt, r.data, r.mime); UI.toast('Exported ' + PQ.fmtInt(r.rows) + ' rows (full data) to ' + PQ.snake(q.name) + '.' + fmt, 'ok'); }
    } catch (e) { if (!e.cancelled) UI.toast('Export failed: ' + e.message, 'err'); }
    finally { App.busy(null); }
  }
  App.exportAs = exportAs;

  /* ================================ layout wiring ================================ */
  function wireLayout() {
    $('#project-name').addEventListener('change', (e) => { const v = e.target.value.trim() || 'Untitled project'; Store.edit('Rename project', (p) => { p.name = v; }); });
    $('#btn-new-query').addEventListener('click', App.getData);
    $('#btn-add-file').addEventListener('click', App.getData);
    $('#btn-undo').addEventListener('click', Store.undoOne);
    $('#btn-redo').addEventListener('click', Store.redoOne);
    $('#btn-file-menu').addEventListener('click', (e) => { const r = e.currentTarget.getBoundingClientRect(); UI.menu([
      { label: 'New project', icon: 'fa-file', kbd: 'Ctrl+N', run: newProject },
      { label: 'Open project…', icon: 'fa-folder-open', kbd: 'Ctrl+O', run: () => UI.openProject() },
      { label: 'Save', icon: 'fa-floppy-disk', kbd: 'Ctrl+S', run: () => UI.saveProject() },
      { label: 'Save as…', icon: 'fa-copy', kbd: 'Ctrl+Shift+S', run: () => UI.saveProject(true) },
      { label: 'View project files (git)', icon: 'fa-code-branch', run: UI.projectFilesDialog },
      '-',
      { label: 'Export current query', icon: 'fa-file-export', sub: [{ label: 'Excel workbook (.xlsx)', icon: 'fa-file-excel', run: () => exportAs('xlsx') }, { label: 'CSV', icon: 'fa-file-csv', run: () => exportAs('csv') }, { label: 'Copy to clipboard (TSV)', icon: 'fa-clipboard', run: () => exportAs('tsv') }] },
      { label: 'Export to Python…', icon: 'fa-brands fa-python', run: () => UI.pythonDialog(Store.ui.activeQid) },
      { label: 'Run headless (CLI)…', icon: 'fa-terminal', run: UI.cliDialog },
      '-',
      { label: 'Load sample data', icon: 'fa-flask', run: App.loadSamples },
      { label: 'Settings…', icon: 'fa-gear', run: UI.settingsDialog },
      { label: 'Keyboard shortcuts', icon: 'fa-keyboard', kbd: '?', run: UI.shortcutsDialog },
      { label: 'About ' + PQ.BRAND.name, icon: 'fa-circle-info', run: UI.aboutDialog },
    ], r.left, r.bottom + 2); });
    $('#btn-theme').addEventListener('click', toggleTheme);
    $('#btn-export').addEventListener('click', (e) => { const r = e.currentTarget.getBoundingClientRect(); UI.menu([{ label: 'Excel workbook (.xlsx)', icon: 'fa-file-excel', run: () => exportAs('xlsx') }, { label: 'CSV', icon: 'fa-file-csv', run: () => exportAs('csv') }, { label: 'Copy to clipboard (TSV)', icon: 'fa-clipboard', run: () => exportAs('tsv') }, '-', { label: 'Python script…', icon: 'fa-brands fa-python', run: () => UI.pythonDialog(Store.ui.activeQid) }], r.left, r.bottom + 2); });
    UI.$$('#right-tabs button').forEach((b) => b.addEventListener('click', () => { Store.setUI({ rightTab: b.dataset.tab }); if (b.dataset.tab === 'profile') loadProfile(); }));
    UI.$$('[data-action]').forEach((b) => b.addEventListener('click', () => ({ getData: App.getData, samples: App.loadSamples, folder: UI.folderDialog, enter: enterData })[b.dataset.action]()));
    // splitters
    UI.$$('.splitter').forEach((sp) => sp.addEventListener('mousedown', (e) => {
      e.preventDefault(); sp.classList.add('drag');
      const side = sp.dataset.side, x0 = e.clientX, root = document.documentElement;
      const w0 = parseInt(getComputedStyle(root).getPropertyValue(side === 'left' ? '--left-w' : '--right-w')) || (side === 'left' ? 230 : 330);
      const move = (ev) => { const w = Math.max(160, Math.min(560, side === 'left' ? w0 + ev.clientX - x0 : w0 - (ev.clientX - x0))); root.style.setProperty(side === 'left' ? '--left-w' : '--right-w', w + 'px'); };
      const up = () => { sp.classList.remove('drag'); removeEventListener('mousemove', move); removeEventListener('mouseup', up); App.grid.paint(); };
      addEventListener('mousemove', move); addEventListener('mouseup', up);
    }));
    // drag & drop files anywhere
    let dragDepth = 0;
    addEventListener('dragenter', (e) => { if (e.dataTransfer.types.includes('Files')) { dragDepth++; document.body.classList.add('dragging'); } });
    addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) document.body.classList.remove('dragging'); });
    addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); });
    addEventListener('drop', async (e) => {
      if (PQ.Platform.native) { e.preventDefault(); return; } // the Rust side emits floe://files-dropped with real paths
      if (!e.dataTransfer.files.length) return;
      e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging');
      const added = await App.addFiles([...e.dataTransfer.files]);
      if (added.length === 1) UI.navigator(added[0].id); else if (added.length) UI.toast('Added ' + added.length + ' files', 'ok');
    });
    // keyboard
    addEventListener('keydown', (e) => {
      const inField = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === 'Escape' && !UI.anyModal() && UI.Engine.state === 'busy') { UI.Engine.cancel(); return; }
      if (UI.anyModal()) return;
      if (PQ.Platform.menuOwns(e)) return; // accelerator handled by the native menu
      if (mod && e.key.toLowerCase() === 'z' && !inField) { e.preventDefault(); e.shiftKey ? Store.redoOne() : Store.undoOne(); }
      else if (mod && e.key.toLowerCase() === 'y' && !inField) { e.preventDefault(); Store.redoOne(); }
      else if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); UI.saveProject(e.shiftKey); }
      else if (mod && e.key.toLowerCase() === 'n' && !inField) { e.preventDefault(); newProject(); }
      else if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); UI.openProject(); }
      else if (mod && e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); App.runFull(); }
      else if (e.key === 'Delete' && !inField && Store.ui.selCols.length && document.activeElement.closest('#center, body') && !document.activeElement.closest('#step-list')) { removeSelected(); }
      else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && Store.query()) { e.preventDefault(); const i = Store.activeIndex() + (e.key === 'ArrowUp' ? -1 : 1); if (i >= 0 && i < Store.query().steps.length) selectStep(i); }
      else if (e.key === '?' && !inField) UI.shortcutsDialog();
      else if (e.key === 'F2' && !inField && Store.query()) renameQuery(Store.query());
    });
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', App.applyTheme);
  }

  addEventListener('DOMContentLoaded', App.boot);
})();
