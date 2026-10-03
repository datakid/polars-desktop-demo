(function () {
  const PQ = self.PQ, UI = PQ.UI, h = UI.h, Store = UI.Store, W = UI.W, F = UI.StepForms;
  const onAny = (el, f) => { el.addEventListener('input', f); el.addEventListener('change', f); return el; };
  const App = () => UI.App;

  F.Sample = (k, ctx) => {
    const mode = onAny(W.select([['n', 'Fixed number of rows'], ['percent', 'Percentage of rows']], k.mode || 'n'), ctx.changed);
    const n = onAny(W.num(k.n === undefined ? 1000 : k.n, { min: 0 }), ctx.changed);
    const pct = onAny(W.num(k.percent === undefined ? 10 : k.percent, { min: 0, max: 100, step: 'any' }), ctx.changed);
    const seed = onAny(W.num(k.seed === undefined ? 42 : k.seed), ctx.changed);
    const fN = W.field('Rows', n), fP = W.field('Percent', pct);
    const sync = () => { fN.classList.toggle('hidden', mode.value !== 'n'); fP.classList.toggle('hidden', mode.value !== 'percent'); };
    mode.addEventListener('change', sync); sync();
    return {
      el: h('div.col', h('div.grid-3', W.field('Sample by', mode), fN, fP, W.field('Seed', seed, 'Same seed, same rows. Rows keep their original order.'))),
      get: () => ({ type: 'Sample', mode: mode.value, n: +n.value, percent: +pct.value, seed: seed.value === '' ? 42 : +seed.value }),
    };
  };

  F.ClusterValues = (k, ctx) => {
    const textCols = ctx.schema.filter((c) => c.type === 'text' || c.type === 'any');
    const colSel = W.colSelect(textCols.length ? textCols : ctx.schema, k.col || ctx.focusCol);
    const method = W.select([['fingerprint', 'Fingerprint (case, accents, punctuation, word order)'], ['ngram', 'Character pairs (catches typos such as "Lisbon" / "Lisbno")']], k.method || 'fingerprint');
    const auto = h('input', { type: 'checkbox', checked: !!k.auto });
    const list = h('div.cluster-list', h('div.muted', { style: { padding: '10px' } }, 'Finding similar values\u2026'));
    let clusters = [], picks = new Map();
    const initial = new Map((k.pairs || []).map((p) => [p[0], p[1]]));
    const draw = () => {
      UI.clear(list);
      if (auto.checked) { list.appendChild(h('div.callout', UI.icon('fa-wand-magic-sparkles'), h('div', 'Every refresh re-detects clusters and merges each to its most frequent spelling, so new variants in tomorrow\u2019s file are handled too.'))); }
      if (!clusters.length) { list.appendChild(h('div.callout.ok', UI.icon('fa-check'), h('div', 'No similar values found in `' + colSel.value + '`. Try the other method.'))); return; }
      list.appendChild(h('div.row.faint', { style: { fontSize: '11.5px', padding: '0 2px' } }, h('span.grow', clusters.length + ' cluster' + (clusters.length > 1 ? 's' : '') + ' \u00b7 ' + PQ.fmtInt(clusters.reduce((s, c) => s + c.rows, 0)) + ' rows'),
        h('button.link-btn', { type: 'button', on: { click: () => { clusters.forEach((c, i) => picks.set(i, picks.get(i) || { on: true, to: c.canonical })); picks.forEach((p) => (p.on = true)); draw(); ctx.changed(); } } }, 'Merge all'),
        h('button.link-btn', { type: 'button', on: { click: () => { picks.forEach((p) => (p.on = false)); draw(); ctx.changed(); } } }, 'None')));
      clusters.forEach((c, i) => {
        const p = picks.get(i);
        const on = h('input', { type: 'checkbox', checked: p.on, disabled: auto.checked, 'aria-label': 'Merge cluster ' + (i + 1) });
        const to = h('input.input.sm', { value: p.to, disabled: auto.checked, 'aria-label': 'Merge into' });
        on.addEventListener('change', () => { p.on = on.checked; card.classList.toggle('off', !p.on); ctx.changed(); });
        to.addEventListener('input', PQ.debounce(() => { p.to = to.value; ctx.changed(); }, 250));
        const card = h('div.cluster', { class: p.on ? '' : 'off' },
          h('div.cluster-h', on, h('span.faint', 'Merge into'), to, h('span.faint', PQ.fmtInt(c.rows) + ' rows')),
          h('div.cluster-vals', c.values.map((v) => h('button.chip', { type: 'button', title: 'Use this spelling', disabled: auto.checked, on: { click: () => { p.to = v.value.trim(); to.value = p.to; ctx.changed(); } } }, h('span.mono', JSON.stringify(v.value).slice(1, -1)), h('span.cnt', PQ.fmtInt(v.count))))));
        list.appendChild(card);
      });
    };
    const load = async () => {
      UI.clear(list).appendChild(h('div.muted', { style: { padding: '10px' } }, 'Finding similar values\u2026'));
      try {
        const r = await UI.Engine.call('clusters', { qid: ctx.qid, upto: ctx.index - 1, col: colSel.value, method: method.value, mode: 'preview' });
        clusters = r.clusters || [];
        picks = new Map(clusters.map((c, i) => {
          const hit = c.values.find((v) => initial.has(v.value));
          return [i, { on: initial.size ? !!hit : true, to: hit ? initial.get(hit.value) : c.canonical }];
        }));
        initial.clear();
        draw(); ctx.changed();
      } catch (e) { UI.clear(list).appendChild(h('div.callout.err', UI.icon('fa-circle-exclamation'), h('div', e.message))); }
    };
    colSel.addEventListener('change', load); method.addEventListener('change', load);
    auto.addEventListener('change', () => { draw(); ctx.changed(); });
    load();
    return {
      el: h('div.col', h('div.grid-2', W.field('Column', colSel), W.field('Method', method)), h('label.check', auto, 'Re-detect on every refresh (auto-merge)'), list),
      get: () => {
        const pairs = [];
        clusters.forEach((c, i) => { const p = picks.get(i); if (!p || !p.on) return; c.values.forEach((v) => { if (v.value !== p.to) pairs.push([v.value, p.to]); }); });
        return auto.checked ? { type: 'ClusterValues', col: colSel.value, method: method.value, auto: true } : { type: 'ClusterValues', col: colSel.value, method: method.value, pairs };
      },
    };
  };

  const CHECK_OPTS = [['not_null', 'Required (not empty)'], ['unique', 'Unique'], ['regex', 'Matches pattern (regex)'], ['range', 'Between (min \u2026 max)'], ['in', 'One of (comma-separated)'], ['length', 'Text length between'], ['type', 'No conversion errors']];
  const PRESETS = [['', 'Pattern presets\u2026'], ['^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$', 'E-mail'], ['^\\+?[0-9 ()-]{6,}$', 'Phone'], ['^[A-Z]{2}\\d{2}[A-Z0-9]{11,30}$', 'IBAN'], ['^\\d{5}(-\\d{4})?$', 'US ZIP'], ['^https?://', 'URL'], ['^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', 'UUID']];
  F.Validate = (k, ctx) => {
    const rows = W.rows(k.rules, (r, ch) => {
      const col = onAny(W.colSelect(ctx.schema, r.col), ch);
      const check = onAny(W.select(CHECK_OPTS, r.check || 'not_null'), ch);
      const a = onAny(W.text(r.arg === undefined ? '' : r.arg), ch), b = onAny(W.text(r.arg2 === undefined ? '' : r.arg2), ch);
      const preset = W.select(PRESETS, '');
      preset.addEventListener('change', () => { if (preset.value) { a.value = preset.value; preset.value = ''; ch(); } });
      const sync = () => {
        const c = check.value;
        a.classList.toggle('hidden', !['regex', 'range', 'in', 'length'].includes(c));
        b.classList.toggle('hidden', !['range', 'length'].includes(c));
        preset.classList.toggle('hidden', c !== 'regex');
        a.placeholder = { regex: '^[A-Z]{2}-\\d+$', range: 'min', in: 'EU, US, APAC', length: 'min' }[c] || '';
        b.placeholder = 'max';
      };
      check.addEventListener('change', sync); sync();
      return { el: h('div.validate-row', col, check, a, b, preset), get: () => ({ col: col.value, check: check.value, arg: a.value, arg2: b.value }) };
    }, () => ({ col: (ctx.schema[0] || {}).name, check: 'not_null' }), 'Add rule', ctx.changed);
    const action = onAny(W.select([['flag', 'Flag: add an Issues column'], ['keep_valid', 'Keep valid rows only'], ['keep_invalid', 'Keep invalid rows only (review)'], ['fail', 'Fail the query (stop exports)']], k.action || 'flag'), ctx.changed);
    const name = onAny(W.text(k.name || 'Issues'), ctx.changed);
    const fName = W.field('Issues column', name);
    const sync = () => fName.classList.toggle('hidden', !['flag', 'keep_invalid'].includes(action.value));
    action.addEventListener('change', sync); sync();
    return {
      el: h('div.col', W.field('Rules (every rule must pass)', rows), h('div.grid-2', W.field('When a row breaks a rule', action), fName)),
      get: () => ({ type: 'Validate', rules: rows.get().filter((r) => r.col), action: action.value, name: name.value.trim() || 'Issues' }),
    };
  };

  const baseMaker = F.ClusterValues;
  F.ClusterValues = (k, ctx) => {
    const q = Store.query(ctx.qid);
    const editIdx = q ? q.steps.findIndex((s) => s.kind === k) : -1;
    ctx.index = editIdx >= 0 ? editIdx : Store.activeIndex() + 1;
    return baseMaker(k, ctx);
  };

  const fmtV = (x, type) => (x === null || x === undefined ? '\u2014' : x && x.__err ? 'Error' : UI.cellText(x, type).text);
  UI.renderOverview = async function () {
    const box = UI.$('#tab-overview');
    if (!box) return;
    const res = App().result;
    if (!res || !res.fp) { UI.clear(box).appendChild(h('div.props', h('p.faint', 'Run a query to see its quality overview.'))); return; }
    if (App().overview && App().overview.fp === res.fp) return draw(App().overview.data);
    UI.clear(box).appendChild(h('div.props', h('p.faint', 'Analysing\u2026')));
    try {
      const { overview } = await UI.Engine.call('overview', { fp: res.fp });
      if (App().result !== res) return;
      App().overview = { fp: res.fp, data: overview };
      draw(overview);
    } catch (e) { UI.clear(box).appendChild(h('p.muted', { style: { padding: '12px' } }, e.message)); }
    function draw(o) {
      const tone = o.score >= 90 ? 'ok' : o.score >= 70 ? 'warn' : 'err';
      const sel = (name) => { Store.ui.selCols = [name]; App().grid.setSelection([name]); Store.setUI({ rightTab: 'profile' }); App().loadProfile(); };
      const fix = [];
      if (o.duplicateRows) fix.push(h('button.btn.sm', { on: { click: () => Store.addStep({ type: 'Distinct', subset: [] }) } }, UI.icon('fa-clone'), 'Remove ' + PQ.fmtInt(o.duplicateRows) + ' duplicate rows'));
      const wsCols = o.columns.filter((c) => c.whitespace).map((c) => c.name);
      if (wsCols.length) fix.push(h('button.btn.sm', { on: { click: () => Store.addStep({ type: 'TextTransform', op: 'trim', cols: wsCols }) } }, UI.icon('fa-broom'), 'Trim ' + wsCols.length + ' column' + (wsCols.length > 1 ? 's' : '')));
      const errCols = o.columns.filter((c) => c.error).map((c) => c.name);
      if (errCols.length) fix.push(h('button.btn.sm', { on: { click: () => Store.addStep({ type: 'KeepErrors', cols: errCols }) } }, UI.icon('fa-triangle-exclamation'), 'Review error rows'));
      const empties = o.columns.filter((c) => c.valid === 0).map((c) => c.name);
      if (empties.length) fix.push(h('button.btn.sm', { on: { click: () => Store.addStep({ type: 'RemoveColumns', cols: empties }) } }, UI.icon('fa-delete-left'), 'Drop ' + empties.length + ' empty column' + (empties.length > 1 ? 's' : '')));
      UI.clear(box).appendChild(h('div.overview',
        h('div.ov-score', { class: tone },
          h('div.ov-ring', { style: { '--p': o.score }, role: 'img', 'aria-label': 'Quality score ' + o.score + ' of 100' }, h('span', o.score)),
          h('div', h('div.ov-title', 'Quality score'), h('div.faint', PQ.fmtInt(o.rows) + ' rows \u00b7 ' + o.cols + ' columns' + (App().lastRun && App().lastRun.truncated ? ' \u00b7 sample' : '')))),
        h('div.stat-grid',
          h('div.stat', h('div.k', 'Error cells'), h('div.v', { class: o.errors ? 'err' : '' }, PQ.fmtInt(o.errors))),
          h('div.stat', h('div.k', 'Empty cells'), h('div.v', PQ.fmtInt(o.empty))),
          h('div.stat', h('div.k', 'Duplicate rows'), h('div.v', { class: o.duplicateRows ? 'warn' : '' }, PQ.fmtInt(o.duplicateRows))),
          h('div.stat', h('div.k', 'Stray spaces'), h('div.v', PQ.fmtInt(o.whitespace)))),
        fix.length ? h('div', h('div.field-label', 'Quick fixes'), h('div.ov-fixes', fix)) : null,
        h('div.field-label', 'Columns'),
        h('ul.ov-cols', o.columns.map((c) => {
          const n = o.rows || 1;
          return h('li', { tabindex: 0, title: 'Profile ' + c.name, on: { click: () => sel(c.name), keydown: (e) => { if (e.key === 'Enter') sel(c.name); } } },
            h('div.ov-c1', UI.typeChip(c.type), h('span.ov-name', c.name), h('span.faint', (c.distinctCapped ? '>' : '') + PQ.fmtInt(c.distinct) + ' distinct')),
            h('div.quality', h('span.qv', { style: { width: (c.valid / n) * 100 + '%' } }), h('span.qe', { style: { width: (c.error / n) * 100 + '%' } }), h('span.qn', { style: { width: (c.empty / n) * 100 + '%' } })),
            h('div.ov-c2.faint', h('span', fmtV(c.min, c.type) + ' \u2026 ' + fmtV(c.max, c.type)), c.top !== null && c.topCount > 1 ? h('span', 'top ' + fmtV(c.top, c.type) + ' \u00d7' + PQ.fmtInt(c.topCount)) : null));
        }))));
    }
  };

  function commands() {
    const A = App(), q = Store.query(), has = !!(q && A.result);
    const sd = (type, init) => () => A.stepDialog(type, init);
    const sel = () => (Store.ui.selCols.length ? Store.ui.selCols : []);
    const out = [
      ['Open data file\u2026', 'fa-file-circle-plus', A.getData, 'Ctrl+O file csv excel parquet'],
      ['Open folder\u2026', 'fa-folder-open', UI.folderDialog],
      ['Paste table from clipboard', 'fa-paste', A.pasteFromClipboard],
      ['Enter data\u2026', 'fa-keyboard', A.enterData],
      ['Load sample project', 'fa-flask', A.loadSamples],
      ['Open project\u2026', 'fa-folder-open', () => UI.openProject(), 'Ctrl+O'],
      ['Save project', 'fa-floppy-disk', () => UI.saveProject(), 'Ctrl+S'],
      ['New project', 'fa-file', A.newProject],
      has && ['Refresh', 'fa-arrows-rotate', A.reload, 'F5'],
      ['Refresh all outputs', 'fa-arrows-spin', UI.refreshAll],
      has && ['Run on full data', 'fa-mountain-sun', A.runFull, 'Ctrl+Shift+F'],
      has && ['Back to preview sample', 'fa-eye', () => A.setMode('preview')],
      has && ['Filter rows\u2026', 'fa-filter', sd('Filter', { mode: 'builder', builder: { join: 'and', conds: [{ col: sel()[0] || A.result.schema[0].name, op: 'eq', value: '' }] } })],
      has && ['Sort\u2026', 'fa-arrow-down-wide-short', sd('Sort', { by: [{ col: sel()[0] || A.result.schema[0].name, desc: false }] })],
      has && ['Choose columns\u2026', 'fa-table-columns', sd('SelectColumns', { cols: sel().length ? sel() : A.result.schema.map((c) => c.name) })],
      has && sel().length && ['Remove selected columns', 'fa-delete-left', A.removeSelected, 'Del'],
      has && ['Rename columns\u2026', 'fa-i-cursor', sd('Rename', { map: [] })],
      has && ['Change type\u2026', 'fa-shapes', sd('ChangeType', { changes: [{ col: sel()[0] || A.result.schema[0].name, type: 'number' }], onError: 'error' })],
      has && ['Detect types', 'fa-shapes', A.detectTypes],
      has && ['Use first row as headers', 'fa-heading', () => Store.addStep({ type: 'PromoteHeaders', row: 0 })],
      has && ['Remove blank rows', 'fa-eraser', () => Store.addStep({ type: 'KeepRows', mode: 'remove_blank' })],
      has && ['Remove duplicates', 'fa-clone', () => Store.addStep({ type: 'Distinct', subset: sel() })],
      has && ['Keep top rows\u2026', 'fa-list-ol', sd('KeepRows', { mode: 'top', n: 100 })],
      has && ['Random sample\u2026', 'fa-dice', sd('Sample', { mode: 'n', n: 1000, seed: 42 })],
      has && ['Trim text', 'fa-broom', sd('TextTransform', { op: 'trim', cols: sel() })],
      has && ['Replace values\u2026', 'fa-right-left', sd('ReplaceValues', { cols: sel(), find: '', replace: '', wholeCell: true })],
      has && ['Fill down', 'fa-angles-down', sd('FillDown', { cols: sel() })],
      has && ['Cluster similar values\u2026', 'fa-object-ungroup', sd('ClusterValues', { col: sel()[0] || A.firstText(), method: 'fingerprint', pairs: [] }), 'fuzzy dedupe typos'],
      has && ['Validate rows\u2026', 'fa-shield-halved', sd('Validate', { rules: [{ col: sel()[0] || A.result.schema[0].name, check: 'not_null' }], action: 'flag', name: 'Issues' }), 'quality rules regex'],
      has && ['Custom column\u2026', 'fa-square-plus', sd('AddColumn', { formula: '' }), 'formula'],
      has && ['Conditional column\u2026', 'fa-code-branch', sd('ConditionalColumn', { rules: [{ when: '', then: '' }], else: 'null' })],
      has && ['Index column', 'fa-list-ol', sd('IndexColumn', { name: 'Index', start: 1, step: 1, first: true })],
      has && ['Split column\u2026', 'fa-scissors', sd('SplitColumn', { col: sel()[0] || A.firstText(), mode: 'each', delimiter: ',' })],
      has && ['Group by\u2026', 'fa-layer-group', sd('GroupBy', { keys: sel().slice(0, 1), aggs: [{ fn: 'count_rows', name: 'Count' }] })],
      has && ['Pivot\u2026', 'fa-table-cells-large', sd('Pivot', { on: sel()[0] })],
      has && ['Unpivot\u2026', 'fa-table-cells', sd('Unpivot', { ids: A.result.schema.map((c) => c.name).filter((n) => !sel().includes(n)) })],
      has && ['Window function\u2026', 'fa-chart-line', sd('Window', { op: 'cumsum', col: sel()[0] }), 'running total rank lag lead'],
      has && ['Merge queries\u2026', 'fa-code-merge', () => UI.mergeDialog({ qid: Store.ui.activeQid, insertAt: Store.activeIndex() + 1, kind: { type: 'Merge' } }), 'join lookup'],
      has && ['Append queries\u2026', 'fa-object-ungroup', sd('Append', { others: [], mode: 'diagonal' }), 'union'],
      has && ['Custom SQL\u2026', 'fa-terminal', sd('CustomSql', { sql: 'SELECT *\nFROM self\nLIMIT 100' })],
      has && ['Quality overview', 'fa-gauge-high', () => { Store.setUI({ rightTab: 'overview' }); A.setPane('steps'); }],
      has && ['Profile selected column', 'fa-chart-simple', () => { Store.setUI({ rightTab: 'profile' }); A.loadProfile(); }],
      has && ['Export to Excel', 'fa-file-excel', () => A.exportAs('xlsx')],
      has && ['Export to CSV', 'fa-file-csv', () => A.exportAs('csv')],
      has && ['Export to Parquet', 'fa-cubes', () => A.exportAs('parquet')],
      has && ['Export to Arrow IPC / Feather', 'fa-cube', () => A.exportAs('arrow')],
      has && ['Copy result to clipboard (TSV)', 'fa-clipboard', () => A.exportAs('tsv')],
      q && ['Export to Polars Python\u2026', 'fa-brands fa-python', () => UI.pythonDialog(Store.ui.activeQid), 'script code'],
      q && ['Rename query', 'fa-pen', A.renameQuery, 'F2'],
      ['Parameters\u2026', 'fa-sliders', UI.paramsDialog],
      ['Dependencies\u2026', 'fa-diagram-project', UI.dependencyDialog],
      ['Project files (git view)\u2026', 'fa-code-branch', UI.projectFilesDialog],
      ['Settings\u2026', 'fa-gear', UI.settingsDialog],
      ['Toggle dark / light theme', 'fa-circle-half-stroke', A.toggleTheme],
      ['Keyboard shortcuts', 'fa-keyboard', UI.shortcutsDialog, '?'],
      ['Undo', 'fa-rotate-left', Store.undoOne, 'Ctrl+Z'],
      ['Redo', 'fa-rotate-right', Store.redoOne, 'Ctrl+Shift+Z'],
    ].filter(Boolean).map(([label, icon, run, extra]) => ({ label, icon, run, kbd: extra && /^(Ctrl|F\d|Del|\?)/.test(extra) ? extra.split(' ')[0] : null, terms: (label + ' ' + (extra || '')).toLowerCase(), group: 'Actions' }));
    Store.project.queries.forEach((x) => out.push({ label: x.name, icon: 'fa-table', run: () => A.selectQuery(x.id), terms: 'query ' + x.name.toLowerCase(), group: 'Queries', hint: x.steps.length + ' steps' }));
    if (q) q.steps.forEach((s, i) => out.push({ label: (i + 1) + '. ' + s.name, icon: PQ.Steps.icon(s.kind.type), run: () => A.selectStep(i), terms: 'step ' + s.name.toLowerCase() + ' ' + PQ.Steps.describe(s.kind).toLowerCase(), group: 'Steps in ' + q.name, hint: PQ.Steps.describe(s.kind) }));
    if (A.result) A.result.schema.forEach((c) => out.push({ label: c.name, icon: 'fa-table-columns', run: () => { Store.ui.selCols = [c.name]; A.grid.setSelection([c.name]); A.grid.scrollToColumn && A.grid.scrollToColumn(c.name); }, terms: 'column ' + c.name.toLowerCase(), group: 'Columns', hint: PQ.TYPES[c.type].label }));
    return out;
  }
  function score(item, words) {
    let s = 0;
    for (const w of words) {
      const i = item.terms.indexOf(w);
      if (i < 0) {
        let p = 0;
        for (const ch of w) { p = item.terms.indexOf(ch, p); if (p < 0) return -1; p++; }
        s += 1;
      } else s += i === 0 || item.terms[i - 1] === ' ' ? 10 : 4;
    }
    return s + (item.group === 'Actions' ? 1 : 0);
  }
  const recentKey = 'floe.palette.recent';
  UI.palette = function () {
    if (UI.$('.palette-back')) return;
    const all = commands();
    let recent = [];
    try { recent = JSON.parse(localStorage.getItem(recentKey) || '[]'); } catch (e) { recent = []; }
    const input = h('input.palette-input', { placeholder: 'Type a command, query, step or column\u2026', 'aria-label': 'Command', autocomplete: 'off', spellcheck: 'false', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'palette-list' });
    const list = h('ul.palette-list#palette-list', { role: 'listbox' });
    const back = h('div.palette-back', { on: { mousedown: (e) => { if (e.target === back) close(); } } },
      h('div.palette', { role: 'dialog', 'aria-label': 'Command palette' }, h('div.palette-h', UI.icon('fa-magnifying-glass', 'faint'), input, h('kbd', 'Esc')), list));
    let items = [], idx = 0;
    const prev = document.activeElement;
    function close() { back.remove(); if (prev && prev.focus) prev.focus(); }
    function run(it) {
      close();
      try { localStorage.setItem(recentKey, JSON.stringify([it.label].concat(recent.filter((x) => x !== it.label)).slice(0, 6))); } catch (e) { }
      setTimeout(() => it.run(), 0);
    }
    function draw() {
      const qv = input.value.trim().toLowerCase();
      if (!qv) {
        const rec = recent.map((l) => all.find((x) => x.label === l)).filter(Boolean).map((x) => Object.assign({}, x, { group: 'Recent' }));
        items = rec.concat(all.filter((x) => x.group === 'Actions' && !recent.includes(x.label)).slice(0, 14));
      } else {
        const words = qv.split(/\s+/);
        items = all.map((x) => ({ x, s: score(x, words) })).filter((r) => r.s >= 0).sort((a, b) => b.s - a.s).slice(0, 40).map((r) => r.x);
      }
      idx = Math.min(idx, Math.max(0, items.length - 1));
      UI.clear(list);
      let g = null;
      items.forEach((it, i) => {
        if (it.group !== g) { g = it.group; list.appendChild(h('li.palette-g', { role: 'presentation' }, g)); }
        list.appendChild(h('li.palette-i', { role: 'option', id: 'pi-' + i, 'aria-selected': i === idx ? 'true' : 'false', class: i === idx ? 'on' : '', on: { mousemove: () => { if (idx !== i) { idx = i; mark(); } }, click: () => run(it) } },
          UI.icon(it.icon.startsWith('fa-brands') ? it.icon.replace('fa-brands ', '') : it.icon, (it.icon.startsWith('fa-brands') ? 'fa-brands ' : '') + 'fa-fw'), h('span.grow', it.label), it.hint ? h('span.palette-hint', it.hint) : null, it.kbd ? h('span.kbd', PQ.Platform.kbd(it.kbd)) : null));
      });
      if (!items.length) list.appendChild(h('li.palette-empty', 'No matches'));
      mark();
    }
    function mark() {
      list.querySelectorAll('.palette-i').forEach((el, i) => { el.classList.toggle('on', i === idx); el.setAttribute('aria-selected', i === idx ? 'true' : 'false'); });
      const on = list.querySelector('.palette-i.on');
      if (on) { on.scrollIntoView({ block: 'nearest' }); input.setAttribute('aria-activedescendant', on.id); }
    }
    input.addEventListener('input', () => { idx = 0; draw(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); idx = Math.min(items.length - 1, idx + 1); mark(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); idx = Math.max(0, idx - 1); mark(); }
      else if (e.key === 'Enter') { e.preventDefault(); if (items[idx]) run(items[idx]); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    });
    document.body.appendChild(back);
    draw();
    input.focus();
  };

  UI.takeShared = async function () {
    if (typeof caches === 'undefined') return;
    try {
      const cache = await caches.open('floe-share');
      const reqs = await cache.keys();
      if (!reqs.length) return;
      const files = [];
      let text = null;
      for (const r of reqs) {
        const res = await cache.match(r);
        await cache.delete(r);
        if (!res) continue;
        if (res.headers.get('x-text')) { text = await res.text(); continue; }
        const buf = await res.arrayBuffer();
        files.push({ name: decodeURIComponent(res.headers.get('x-name') || 'shared.csv'), size: buf.byteLength, mtime: Date.now(), buf });
      }
      history.replaceState(null, '', location.pathname);
      if (text && !(await App().pasteTable(text))) UI.toast('The shared text does not look like a table', 'warn');
      if (files.length) App().afterAdd(await App().addFiles(files));
    } catch (e) { UI.toast('Could not read the shared file: ' + e.message, 'err'); }
  };

  addEventListener('DOMContentLoaded', () => {
    const qs = new URLSearchParams(location.search);
    if (qs.has('shared')) setTimeout(function wait() { if (UI.Engine.state === 'idle' && App().files) UI.takeShared(); else setTimeout(wait, 200); }, 400);
    if (qs.get('open') === 'palette') setTimeout(() => UI.palette(), 900);
    const tabs = UI.$('#right-tabs');
    if (tabs && !tabs.querySelector('[data-tab="overview"]')) {
      const b = h('button', { dataset: { tab: 'overview' }, role: 'tab' }, 'Overview');
      tabs.appendChild(b);
      b.addEventListener('click', () => { Store.setUI({ rightTab: 'overview' }); App().renderRight(); });
    }
    const pal = UI.$('#btn-palette');
    if (pal) pal.addEventListener('click', UI.palette);
    Store.on((kind) => { if (kind === 'ui' && Store.ui.rightTab === 'overview') UI.renderOverview(); });
  });
})();
