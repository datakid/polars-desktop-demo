/* Project-level dialogs: Excel/CSV navigator, From Folder, Python export, project files (git view),
 * dependency graph, parameters, settings, outputs / Refresh All, shortcuts. */
(function () {
  const PQ = self.PQ, UI = PQ.UI, h = UI.h, Store = UI.Store, W = UI.W;

  /* ================================ Navigator ================================ */
  /** Opens a file and shows the navigator tree: Excel Tables first, then sheets + detected regions, named ranges. */
  UI.navigator = async function (fileId, opts) {
    opts = opts || {};
    const f = UI.App.files.find((x) => x.id === fileId);
    if (!f) return UI.toast('File not found', 'err');
    let info;
    const loading = UI.modal({ title: 'Opening ' + f.name, icon: 'fa-spinner fa-spin', body: h('p.muted', 'Reading…'), noFooter: true });
    try { info = (await UI.Engine.call('inspectFile', { fileId })).info; }
    catch (e) { loading.close(); return UI.toast(e.message, 'err'); }
    loading.close();
    if (info.kind === 'csv' || info.kind === 'json') return csvNavigator(f, info, opts);

    const tree = h('div.nav-tree');
    const main = h('div.nav-main');
    let sel = null;
    let state = {};
    const items = [];
    const addItem = (el, item) => { items.push({ el, item }); el.addEventListener('click', () => choose(item, el)); tree.appendChild(el); };
    if (info.tables.length) {
      tree.appendChild(h('div.nav-sec', 'Excel tables'));
      info.tables.forEach((t) => addItem(h('div.nav-item', UI.icon('fa-table', 'fa-fw'), t.name, h('span.tag', 'BEST'), h('span.meta', t.sheet + '!' + t.ref)), { type: 'table', name: t.name, sheet: t.sheet, ref: t.ref }));
    }
    tree.appendChild(h('div.nav-sec', 'Sheets'));
    info.sheets.forEach((s) => {
      addItem(h('div.nav-item', UI.icon(s.empty ? 'fa-file' : 'fa-table-cells', 'fa-fw'), s.name, s.hidden ? h('span.tag.hid', 'HIDDEN') : null, h('span.meta', s.empty ? 'empty' : s.rows + '×' + s.cols)), { type: 'sheet', name: s.name, sheet: s });
      if (s.regions && s.regions.length > 1) s.regions.forEach((r, i) => addItem(h('div.nav-item.sub', UI.icon('fa-vector-square', 'fa-fw'), 'Region ' + (i + 1), h('span.meta', r.a1 + ' · ' + r.rows + '×' + r.cols)), { type: 'range', sheet: s, range: r.a1, headerGuess: r.header }));
    });
    if (info.names.length) {
      tree.appendChild(h('div.nav-sec', 'Named ranges'));
      info.names.forEach((n) => addItem(h('div.nav-item', UI.icon('fa-tag', 'fa-fw'), n.name, h('span.meta', n.ref)), { type: 'name', name: n.name, ref: n.ref }));
    }
    const visible = info.sheets.filter((s) => !s.hidden && !s.empty);
    if (visible.length > 1) {
      tree.appendChild(h('div.nav-sec', 'Combine'));
      addItem(h('div.nav-item', UI.icon('fa-layer-group', 'fa-fw'), 'Combine sheets by pattern…'), { type: 'sheets', pattern: guessPattern(visible.map((s) => s.name)) });
    }
    tree.appendChild(h('div.faint', { style: { fontSize: '11px', padding: '12px 8px' } }, info.date1904 ? '1904 date system detected' : '1900 date system', ' · ', info.sheets.length, ' sheets'));

    function choose(item, el) {
      items.forEach((x) => x.el.classList.toggle('on', x.el === el));
      sel = item;
      renderMain();
    }
    function renderMain() {
      UI.clear(main);
      if (!sel) return main.appendChild(h('div.grid-empty', h('div', h('div.big', UI.icon('fa-sitemap')), 'Select an item')));
      const it = sel;
      if (it.type === 'sheets') {
        const pat = W.text(it.pattern);
        const match = h('div.muted', { style: { fontSize: '12px' } });
        const upd = () => { const re = PQ.globToRegex(pat.value || '*'); const m = info.sheets.filter((s) => !s.hidden && re.test(s.name)).map((s) => s.name); match.textContent = m.length ? 'Matches: ' + m.join(', ') : 'No sheets match'; state = { item: { type: 'sheets', pattern: pat.value || '*', sheetColumn: '_sheet' }, headerRow: null }; };
        pat.addEventListener('input', upd); upd();
        main.append(h('div.nav-opts', h('div.field.grow', h('label', 'Sheet name pattern (* wildcard)'), pat)), h('div', { style: { padding: '14px' } }, match, h('div.faint', { style: { marginTop: '10px', fontSize: '12px' } }, 'Headers detected per sheet. Columns unioned by name. Adds ', h('code', '_sheet'), '.')));
        return;
      }
      const sheet = it.sheet && typeof it.sheet === 'object' ? it.sheet : info.sheets.find((s) => s.name === (it.sheet || (it.ref || '').split('!')[0].replace(/'/g, '')));
      const guess = it.type === 'range' ? it.headerGuess : it.type === 'table' ? { row: -1 } : sheet ? sheet.header : { row: 0, confidence: 0 };
      const rangeInp = W.text(it.type === 'range' ? it.range : it.type === 'table' ? it.ref : '', { placeholder: 'Whole sheet — or type B3:H / B3:H500', disabled: it.type === 'table' || it.type === 'name' });
      const hdrInp = W.num(guess && guess.row >= 0 ? guess.row + 1 : 1, { min: 0, style: { width: '90px' } });
      const noHdr = h('input', { type: 'checkbox', checked: it.type !== 'table' && guess && guess.row < 0 });
      const fillMerged = h('input', { type: 'checkbox', checked: !!(sheet && sheet.merges) });
      const hdrField = h('div.field', h('label', 'Header row (within the range)'), h('div.row', hdrInp, h('label.check', noHdr, 'No header')));
      if (it.type === 'table') hdrField.classList.add('hidden');
      const confidence = guess && guess.confidence !== undefined && it.type !== 'table' ? h('div.callout.' + (guess.confidence > 0.5 ? 'ok' : 'info'), { style: { padding: '4px 8px' } }, UI.icon('fa-check'), h('div', { title: (guess.reasons || []).join(' · ') }, 'Header: row ' + (guess.row + 1) + ' · ' + Math.round(guess.confidence * 100) + '%')) : null;
      const gridWrap = h('div.sheet-grid-wrap');
      main.append(h('div.nav-opts', h('div.field', { style: { width: '220px' } }, h('label', 'Range (A1)'), rangeInp), hdrField, sheet && sheet.merges ? h('label.check', fillMerged, 'Fill ' + sheet.merges + ' merged cell region' + (sheet.merges > 1 ? 's' : '')) : null, confidence), gridWrap);
      const drawGrid = () => {
        UI.clear(gridWrap);
        if (!sheet || !sheet.preview.length) { gridWrap.appendChild(h('p.muted', { style: { padding: '14px' } }, it.type === 'name' ? 'Named range ' + it.ref : 'Sheet is empty')); return; }
        const rg = PQ.parseA1(it.type === 'table' ? it.ref : rangeInp.value) || null;
        const o = sheet.origin || { r: 0, c: 0 };
        const hr = noHdr.checked ? -1 : +hdrInp.value - 1;
        const cols = sheet.preview.reduce((m, r) => Math.max(m, r.length), 0);
        const table = h('table.sheet-grid');
        table.appendChild(h('thead', h('tr', h('th.rh', ''), Array.from({ length: cols }, (_, c) => h('th', PQ.idxToCol(c + o.c))))));
        const tb = h('tbody');
        let drag = null;
        sheet.preview.forEach((row, r) => {
          const R = r + o.r;
          const inRow = !rg || (R >= rg.r1 && R <= rg.r2);
          const isHdr = rg ? R === rg.r1 + hr : R === o.r + hr;
          const tr = h('tr', { class: isHdr && inRow ? 'hdr-row' : '' }, h('th.rh', String(R + 1)));
          for (let c = 0; c < cols; c++) {
            const C = c + o.c;
            const inside = inRow && (!rg || (C >= rg.c1 && C <= rg.c2));
            const td = h('td', { class: inside ? (isHdr ? 'hdr' : 'in') : '', title: row[c] || '', dataset: { r: R, c: C } }, row[c] === null || row[c] === undefined ? '' : row[c]);
            tr.appendChild(td);
          }
          tb.appendChild(tr);
        });
        // drag-select a range visually
        if (it.type !== 'table' && it.type !== 'name') {
          tb.addEventListener('mousedown', (e) => { const td = e.target.closest('td'); if (!td) return; drag = { r: +td.dataset.r, c: +td.dataset.c }; e.preventDefault(); });
          tb.addEventListener('mouseover', (e) => { if (!drag) return; const td = e.target.closest('td'); if (!td) return; const r2 = +td.dataset.r, c2 = +td.dataset.c; const a = { r1: Math.min(drag.r, r2), c1: Math.min(drag.c, c2), r2: Math.max(drag.r, r2), c2: Math.max(drag.c, c2) }; tb.querySelectorAll('td').forEach((x) => { const R = +x.dataset.r, C = +x.dataset.c; x.className = R >= a.r1 && R <= a.r2 && C >= a.c1 && C <= a.c2 ? 'in' : ''; }); drag.cur = a; });
          addEventListener('mouseup', function up() { removeEventListener('mouseup', up); if (drag && drag.cur) { const a = drag.cur; const toEnd = a.r2 >= o.r + sheet.preview.length - 1 && sheet.rows > sheet.preview.length; rangeInp.value = PQ.idxToCol(a.c1) + (a.r1 + 1) + ':' + PQ.idxToCol(a.c2) + (toEnd ? '' : a.r2 + 1); hdrInp.value = 1; noHdr.checked = false; sync(); drawGrid(); } drag = null; }, { once: false });
        }
        table.appendChild(tb);
        gridWrap.appendChild(table);
        if (sheet.rows > sheet.preview.length) gridWrap.appendChild(h('div.faint', { style: { padding: '6px 10px', fontSize: '11px' } }, sheet.preview.length + ' of ' + PQ.fmtInt(sheet.rows) + ' rows · drag to select a range'));
      };
      const sync = () => {
        const item = it.type === 'table' ? { type: 'table', name: it.name } : it.type === 'name' ? { type: 'name', name: it.name } : rangeInp.value.trim() ? { type: 'range', sheet: sheet.name, range: rangeInp.value.trim() } : { type: 'sheet', name: sheet.name };
        state = { item, headerRow: it.type === 'table' ? null : noHdr.checked ? null : Math.max(0, +hdrInp.value - 1), fillMerged: fillMerged.checked };
        rangeInp.classList.toggle('invalid', !!rangeInp.value.trim() && !PQ.parseA1(rangeInp.value));
      };
      [rangeInp, hdrInp, noHdr, fillMerged].forEach((x) => x.addEventListener('input', () => { sync(); drawGrid(); }));
      [noHdr, fillMerged].forEach((x) => x.addEventListener('change', () => { sync(); drawGrid(); }));
      sync(); drawGrid();
    }
    const body = h('div.nav-layout', tree, main);
    const m = UI.modal({
      title: 'Navigator — ' + f.name, icon: 'fa-file-excel', size: 'xwide', body, okLabel: opts.replaceSourceOf ? 'Replace source' : 'Load',
      onOk: async () => {
        if (!sel) { UI.toast('Nothing selected', 'warn'); return false; }
        const source = { kind: 'file', fileId, fileName: f.name, format: 'excel', item: state.item, fillMerged: state.fillMerged || undefined };
        const name = state.item.type === 'sheets' ? f.name.replace(/\.\w+$/, '') + ' (combined)' : state.item.name || state.item.sheet || f.name;
        await UI.App.createQueryFromSource(source, name, state.headerRow, opts.replaceSourceOf);
      },
    });
    m.el.querySelector('.modal-b').style.padding = '0';
    const first = items.find((x) => x.item.type === 'table') || items.find((x) => x.item.type === 'sheet' && !x.item.sheet.empty && !x.item.sheet.hidden) || items[0];
    if (first) choose(first.item, first.el); else renderMain();
  };
  function guessPattern(names) {
    if (names.length < 2) return '*';
    let p = names[0];
    names.forEach((n) => { let i = 0; while (i < p.length && i < n.length && p[i] === n[i]) i++; p = p.slice(0, i); });
    return p.length >= 2 ? p + '*' : '*';
  }

  function csvNavigator(f, info, opts) {
    const d = W.select([[',', 'Comma ,'], [';', 'Semicolon ;'], ['\t', 'Tab'], ['|', 'Pipe |']], info.delimiter || ',');
    const loc = W.select(Object.keys(PQ.LOCALES).map((k) => [k, PQ.LOCALES[k].label]), info.locale || Store.project.settings.locale);
    const hd = h('input', { type: 'checkbox', checked: info.header !== false });
    const prev = h('div');
    const draw = () => {
      const rows = info.preview || [];
      UI.clear(prev).appendChild(h('div.mini-wrap', { style: { maxHeight: '340px' } }, h('table.mini-table', h('tbody', rows.slice(0, 30).map((r, i) => h('tr', { style: i === 0 && hd.checked ? { fontWeight: 700, background: 'var(--accent-2)' } : null }, (info.kind === 'csv' ? reparse(r) : r).map((v) => h('td', v === null ? '' : String(v)))))))));
    };
    const reparse = (r) => r; // preview rows already split with sniffed delimiter
    hd.addEventListener('change', draw);
    draw();
    const body = h('div.col',
      info.kind === 'csv' ? h('div.callout.ok', UI.icon('fa-check'), h('div', 'Detected ', h('b', info.delimiter === '\t' ? 'Tab' : info.delimiter), ' · ', h('b', info.encoding), ' · ', h('b', info.locale), info.header ? ' · header' : ' · no header')) : null,
      info.kind === 'csv' ? h('div.grid-3', W.field('Delimiter', d), W.field('Locale (decimal separator & dates)', loc), h('div.field', h('label', ' '), h('label.check', hd, 'First row contains headers'))) : null,
      prev);
    UI.modal({
      title: f.name, icon: info.kind === 'json' ? 'fa-code' : 'fa-file-csv', size: 'wide', body, okLabel: opts.replaceSourceOf ? 'Replace source' : 'Load',
      onOk: async () => {
        const source = info.kind === 'json' ? { kind: 'file', fileId: f.id, fileName: f.name, format: 'json' } : { kind: 'file', fileId: f.id, fileName: f.name, csv: { delimiter: d.value, header: hd.checked, encoding: 'auto' }, csvLocale: loc.value };
        await UI.App.createQueryFromSource(source, f.name.replace(/\.\w+$/, ''), null, opts.replaceSourceOf);
      },
    });
  }

  /* ================================ From Folder ================================ */
  UI.folderDialog = function () {
    const folders = UI.App.folders();
    if (!folders.length) {
      UI.modal({ title: 'From Folder', icon: 'fa-folder-open', body: h('div.col', h('p', 'Combine every file in a folder with the same transform — Power Query\'s most loved feature.'), h('p.muted', 'Pick a folder from your computer (its files are copied into this workspace), or load the sample data which includes a folder of monthly CSV exports.')), footer: [h('button.btn', { on: { click: () => { UI.closeMenu(); UI.$$('.modal-back').forEach((m) => m.remove()); UI.App.loadSamples(); } } }, 'Load samples')], okLabel: 'Choose folder…', onOk: () => UI.App.addFolder() });
      return;
    }
    const f = W.select(folders, folders[0]);
    const pat = W.text('*.csv');
    const fmt = W.select([['csv', 'CSV / text'], ['excel', 'Excel (first sheet)'], ['json', 'JSON']], 'csv');
    const delim = W.select([[';', 'Semicolon ;'], [',', 'Comma ,'], ['\t', 'Tab'], ['|', 'Pipe |']], ';');
    const loc = W.select(Object.keys(PQ.LOCALES).map((k) => [k, PQ.LOCALES[k].label]), 'de-DE');
    const list = h('div');
    const upd = () => {
      const re = PQ.globToRegex(pat.value || '*');
      const files = UI.App.files.filter((x) => x.folder === f.value && re.test(x.name));
      UI.clear(list).append(h('div.field-label', files.length + ' file' + (files.length === 1 ? '' : 's') + ' match'), h('ul', { style: { margin: '4px 0', paddingLeft: '18px', fontSize: '12px' } }, files.map((x) => h('li', x.name, h('span.faint', ' · ' + UI.fmtBytes(x.size))))));
      if (files.length) { const guess = files[0].name.split('.').pop().toLowerCase(); if (/xls/.test(guess)) fmt.value = 'excel'; }
    };
    [f, pat].forEach((x) => x.addEventListener('input', upd)); upd();
    UI.modal({
      title: 'Combine files from folder', icon: 'fa-folder-open', size: 'wide',
      body: h('div.col', h('div.grid-3', W.field('Folder', f), W.field('File pattern', pat), W.field('Format', fmt)), h('div.grid-2', W.field('CSV delimiter', delim), W.field('Locale', loc)), list, h('div.faint', { style: { fontSize: '12px' } }, 'Columns unioned by name. Adds ', h('code', 'Source.Name'), '.')),
      okLabel: 'Combine',
      onOk: async () => {
        const source = { kind: 'folder', folder: f.value, pattern: pat.value || '*', format: fmt.value === 'csv' ? undefined : fmt.value, csv: { delimiter: delim.value, header: true }, fileColumn: 'Source.Name', csvLocale: loc.value };
        await UI.App.createQueryFromSource(source, f.value, null);
      },
    });
  };

  /* ================================ Python export ================================ */
  function highlightPy(code) {
    const esc = PQ.esc(code);
    return esc.replace(/(#[^\n]*)|(&quot;(?:[^&]|&(?!quot;))*?&quot;|"""[\s\S]*?"""|'[^'\n]*')|\b(import|from|def|return|for|in|if|else|lambda|as|with|None|True|False|not|and|or)\b|\b(\d+(?:\.\d+)?)\b|\b(pl|Path)\b/g, (m, c, s, k, n, f) => c ? '<span class="c">' + c + '</span>' : s ? '<span class="s">' + s + '</span>' : k ? '<span class="k">' + k + '</span>' : n ? '<span class="n">' + n + '</span>' : '<span class="f">' + f + '</span>');
  }
  UI.pythonDialog = function (qid) {
    let code;
    try { code = PQ.Steps.toPython(Store.project, qid); } catch (e) { return UI.toast(e.message, 'err'); }
    const scope = W.select([['', 'Whole project'], ...Store.project.queries.map((q) => [q.id, 'Query: ' + q.name + ' (+ dependencies)'])], qid || '');
    const pre = h('pre.code', { html: highlightPy(code), style: { maxHeight: '60vh' } });
    scope.addEventListener('change', () => { code = PQ.Steps.toPython(Store.project, scope.value || undefined); pre.innerHTML = highlightPy(code); });
    UI.modal({
      title: 'Export to Python (Polars)', icon: 'fa-brands fa-python', size: 'wide',
      body: h('div.col', W.field('Scope', scope), pre),
      footer: [h('button.btn', { on: { click: () => UI.copy(code) } }, UI.icon('fa-copy'), 'Copy')],
      okLabel: 'Download .py', onOk: () => { UI.download(PQ.snake(Store.project.name) + '.py', code, 'text/x-python'); return false; },
    });
  };

  /* ================================ Project files (git-friendly) ================================ */
  UI.projectFilesDialog = function () {
    const files = PQ.Steps.toFiles(Store.project);
    const names = Object.keys(files);
    let cur = names[0];
    const tabs = h('div.file-tabs');
    const pre = h('pre.code', { style: { maxHeight: '55vh', marginTop: 0, borderTopLeftRadius: 0 } });
    const draw = () => { UI.clear(tabs); names.forEach((n) => tabs.appendChild(h('button', { class: n === cur ? 'on' : '', on: { click: () => { cur = n; draw(); } } }, n))); pre.textContent = files[cur]; };
    draw();
    UI.modal({
      title: 'Project file (.floe)', icon: 'fa-code-branch', size: 'wide',
      body: h('div.col', h('div.faint', { style: { fontSize: '12px' } }, 'One file per query. Sorted keys. Diff-friendly.'), h('div', tabs, pre)),
      footer: [h('button.btn', { on: { click: () => UI.saveProject(true) } }, UI.icon('fa-file-zipper'), 'Save single file')],
      okLabel: 'Download all files', onOk: () => { names.forEach((n, i) => setTimeout(() => UI.download(n.replace('/', '__'), files[n], 'application/json'), i * 150)); return false; },
    });
  };
  function bundle() { return JSON.parse(PQ.stableStringify(Object.assign({ format_version: PQ.Steps.FORMAT_VERSION }, Store.project))); }
  /** Save: writes back to the opened .floe file in the desktop app (Save As the first time); downloads in the browser. */
  UI.saveProject = async (saveAs) => {
    const text = PQ.stableStringify(bundle(), 2) + '\n';
    const name = PQ.snake(Store.project.name) + '.' + PQ.BRAND.ext;
    const P = PQ.Platform;
    try {
      if (P.native) {
        const where = Store.filePath && !saveAs ? await P.writePath(Store.filePath, text) : await P.saveFile(name, text, 'application/json');
        if (!where) return false;
        Store.filePath = where; Store.fileName = String(where).split(/[\\/]/).pop();
        Store.markSaved();
        UI.toast('Saved ' + Store.fileName, 'ok', { ms: 2200 });
        return true;
      }
      const r = await P.saveProject(Store.fileName || name, text, saveAs ? null : Store.fileHandle);
      if (!r) return false;
      if (r.handle) { Store.fileHandle = r.handle; Store.fileName = r.name; P.recent.add(r.handle); }
      Store.markSaved();
      UI.toast(r.handle ? 'Saved ' + r.name : 'Downloaded ' + r.name, 'ok', { ms: 2200 });
      return true;
    } catch (e) { UI.toast(e.message || String(e), 'err'); return false; }
  };
  UI.guardUnsaved = async function (action) {
    if (!Store.dirty() || !Store.linked()) return true;
    const choice = await new Promise((res) => {
      const m = UI.modal({
        title: 'Save changes to ' + (Store.fileName || Store.project.name) + '?', icon: 'fa-floppy-disk',
        body: h('p', { style: { margin: 0 } }, 'Your changes will stay in undo history, but they are not in the project file yet.'),
        footer: [h('button.btn', { on: { click: () => { res('discard'); m.close(true); } } }, 'Don’t save')],
        okLabel: 'Save', onOk: () => res('save'), onClose: (ok) => { if (!ok) res('cancel'); },
      });
    });
    if (choice === 'cancel') return false;
    if (choice === 'save') return !!(await UI.saveProject());
    return true;
  };
  UI.openProject = async function (given) {
    if (!given && !(await UI.guardUnsaved('open'))) return;
    let file;
    try { file = given || (await PQ.Platform.openProjectFile()); } catch (e) { return UI.toast(e.message || String(e), 'err'); }
    if (!file) return;
    try {
      const p = PQ.Steps.migrate(JSON.parse(file.text));
      Store.replace(p, 'Open ' + file.name);
      Store.filePath = file.path || null;
      Store.fileHandle = file.handle || null;
      Store.fileName = file.handle || file.path ? file.name : null;
      Store.markSaved();
      if (file.handle) PQ.Platform.recent.add(file.handle);
      const missing = [];
      p.queries.forEach((q) => q.steps.forEach((s) => { const src = s.kind.source; if (s.kind.type === 'Source' && src && src.kind === 'file' && !UI.App.files.some((f) => f.id === src.fileId)) missing.push(src.fileName); }));
      const miss = [...new Set(missing)];
      if (miss.length) UI.toast('Missing source files: ' + miss.join(', '), 'warn', { ms: 12000, actions: [{ label: 'Add files…', run: () => UI.relinkFiles(miss) }] });
      else UI.toast('Opened ' + p.name, 'ok');
    } catch (e) { UI.toast('Not a valid project file: ' + e.message, 'err'); }
  };
  UI.relinkFiles = async function () {
    let files;
    try { files = await PQ.Platform.pickDataFiles(); } catch (e) { return UI.toast(e.message, 'err'); }
    if (!files || !files.length) return;
    const added = await UI.App.addFiles(files);
    const byName = new Map(added.map((f) => [f.name, f]));
    let n = 0;
    Store.edit('Relink sources', (p) => {
      p.queries.forEach((q) => q.steps.forEach((s) => { const src = s.kind.source; if (s.kind.type === 'Source' && src && src.kind === 'file' && !UI.App.files.some((f) => f.id === src.fileId && f.name === src.fileName) && byName.has(src.fileName)) { src.fileId = byName.get(src.fileName).id; n++; } }));
      if (!n) return false;
    });
    UI.toast(n ? 'Relinked ' + n + ' source' + (n === 1 ? '' : 's') : 'No matching file names', n ? 'ok' : 'warn');
  };
  UI.openRecentMenu = async function (x, y) {
    const list = await PQ.Platform.recent.list();
    if (!list.length) return UI.openProject();
    UI.menu([{ header: 'Recent projects' }].concat(list.map((r, i) => ({ label: r.name, icon: 'fa-file-lines', run: async () => { if (!(await UI.guardUnsaved('open'))) return; try { UI.openProject(await PQ.Platform.recent.open(r)); } catch (e) { UI.toast(e.message, 'err'); PQ.Platform.recent.remove(i); } } }))).concat(['-', { label: 'Browse…', icon: 'fa-folder-open', run: () => UI.openProject() }]), x, y);
  };

  /* ================================ Dependency graph ================================ */
  UI.dependencyDialog = function () {
    let topo;
    try { topo = PQ.Steps.topo(Store.project); }
    catch (e) { return UI.modal({ title: 'Query dependencies', icon: 'fa-diagram-project', body: h('div.callout.err', UI.icon('fa-rotate'), h('div', h('b', e.message))) }); }
    const { order, deps } = topo;
    const byId = new Map(Store.project.queries.map((q) => [q.id, q]));
    const level = new Map();
    order.forEach((id) => { const d = deps(byId.get(id)); level.set(id, d.length ? Math.max(...d.map((x) => level.get(x))) + 1 : 0); });
    const cols = new Map();
    order.forEach((id) => { const l = level.get(id); if (!cols.has(l)) cols.set(l, []); cols.get(l).push(id); });
    const NW = 190, NH = 58, GX = 90, GY = 26;
    const pos = new Map();
    cols.forEach((ids, l) => ids.forEach((id, i) => pos.set(id, { x: 30 + l * (NW + GX), y: 30 + i * (NH + GY) })));
    const width = 60 + cols.size * (NW + GX), height = 60 + Math.max(...[...cols.values()].map((c) => c.length)) * (NH + GY);
    const canvas = h('div.dep-canvas');
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('width', width); svg.setAttribute('height', height);
    svg.style.position = 'absolute'; svg.style.left = 0; svg.style.top = 0;
    svg.innerHTML = '<defs><marker id="arr" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#94a3b8"/></marker></defs>';
    order.forEach((id) => deps(byId.get(id)).forEach((d) => {
      const a = pos.get(d), b = pos.get(id);
      const p = document.createElementNS(svgNS, 'path');
      const x1 = a.x + NW, y1 = a.y + NH / 2, x2 = b.x - 4, y2 = b.y + NH / 2;
      p.setAttribute('d', `M${x1},${y1} C${x1 + 45},${y1} ${x2 - 45},${y2} ${x2},${y2}`);
      p.setAttribute('stroke', '#94a3b8'); p.setAttribute('stroke-width', '1.6'); p.setAttribute('fill', 'none'); p.setAttribute('marker-end', 'url(#arr)');
      svg.appendChild(p);
    }));
    const inner = h('div', { style: { position: 'relative', width: width + 'px', height: height + 'px' } });
    inner.appendChild(svg);
    let m;
    order.forEach((id) => {
      const q = byId.get(id), p = pos.get(id);
      const src = q.steps[0] && q.steps[0].kind.source;
      const isSrc = !deps(q).length, isOut = q.load && q.load.target && q.load.target !== 'none';
      const st = UI.App.queryStatus.get(id);
      inner.appendChild(h('div.dep-node', { class: (isSrc ? 'src ' : '') + (isOut ? 'out ' : '') + (st && st.error ? 'err' : ''), style: { left: p.x + 'px', top: p.y + 'px' }, title: 'Open ' + q.name, on: { click: () => { m.close(); UI.App.selectQuery(id); } } },
        h('div.n', UI.icon(isSrc ? 'fa-database' : 'fa-table'), q.name, isOut ? h('span.load-badge', q.load.target) : null),
        h('div.d', src ? PQ.Steps.describe(q.steps[0].kind) : 'No source', ' · ', q.steps.length + ' steps')));
    });
    canvas.appendChild(inner);
    m = UI.modal({ title: 'Query dependencies', icon: 'fa-diagram-project', size: 'xwide', body: h('div.col', { style: { height: '100%' } }, h('div.row.muted', { style: { fontSize: '12px' } }, h('span', UI.icon('fa-square', 'tag-lazy'), ' source'), h('span', UI.icon('fa-square', '', ''), ' '), h('span', { style: { color: 'var(--ok)' } }, UI.icon('fa-square'), ' has output'), h('span', '· Refresh All runs in this order (left → right), independent branches in parallel.')), canvas) });
  };

  /* ================================ Parameters ================================ */
  UI.paramsDialog = function () {
    const rows = W.rows(Store.project.params, (p) => {
      const n = W.text(p.name, { placeholder: 'Name (letters, digits, _)' }), t = W.select([['text', 'Text'], ['number', 'Number'], ['date', 'Date'], ['list', 'List (comma-separated)']], p.type || 'text'), v = W.text(p.value, { placeholder: 'Value' });
      return { el: h('div.grid-3', n, t, v), get: () => ({ name: n.value.trim().replace(/[^A-Za-z0-9_]/g, '_'), type: t.value, value: v.value }) };
    }, () => ({ name: '', type: 'text', value: '' }), 'Add parameter');
    UI.modal({
      title: 'Parameters', icon: 'fa-sliders', size: 'wide',
      body: h('div.col', h('p.muted', { style: { margin: 0 } }, 'Typed values you can use in any formula as ', h('code', '@Name'), ' — e.g. ', h('code', '[Region] = @Region'), ' or ', h('code', '[Date] >= @StartDate'), '. The CLI can override them: ', h('code', 'floe run project.floe --param Region=EU')), W.field('Name · Type · Value', rows)),
      okLabel: 'Save',
      onOk: () => {
        const ps = rows.get().filter((p) => p.name);
        const dup = ps.find((p, i) => ps.findIndex((x) => x.name === p.name) !== i);
        if (dup) { UI.toast('Duplicate name: ' + dup.name, 'err'); return false; }
        Store.edit('Edit parameters', (p) => { p.params = ps; });
      },
    });
  };

  /* ================================ Settings ================================ */
  UI.settingsDialog = function () {
    const s = Store.project.settings;
    const rows = W.select([[200, '200 rows'], [1000, '1,000 rows (default)'], [5000, '5,000 rows'], [10000, '10,000 rows']], s.previewRows);
    const loc = W.select(Object.keys(PQ.LOCALES).map((k) => [k, PQ.LOCALES[k].label]), s.locale);
    const theme = W.select([['light', 'Light'], ['dark', 'Dark'], ['system', 'System']], localStorage.getItem('floe.theme') || 'system');
    const N = UI.NativeEngine;
    const native = h('input', { type: 'checkbox', checked: N.ready && !N.disabled, disabled: !N.ready });
    const store = h('div.help', 'Checking storage…');
    Promise.all([PQ.Platform.storage(), UI.Engine.callWorker('storageInfo')]).then(([s, w]) => {
      const parts = [w.files + ' file' + (w.files === 1 ? '' : 's') + ' · ' + UI.fmtBytes(w.bytes)];
      if (s && s.quota) parts.push(UI.fmtBytes(s.usage) + ' of ' + UI.fmtBytes(s.quota) + ' used');
      if (s) parts.push(s.persisted ? 'persistent storage' : 'the browser may evict data under storage pressure');
      store.textContent = parts.join(' · ');
    }).catch(() => { store.textContent = ''; });
    UI.modal({
      title: 'Settings',
      body: h('div.col', h('div.grid-3', W.field('Preview rows', rows), W.field('Locale', loc), W.field('Theme', theme)),
        PQ.Platform.native ? h('div.field', h('label', 'Engine'), h('label.check', native, N.ready ? 'Polars ' + (N.info.polars || '') : 'Polars (not installed)'), h('div.help', 'Unsupported steps run on the built-in engine.')) : null,
        h('div.field', h('label', 'Workspace files (stored in this browser)'), h('div.row', { style: { flexWrap: 'wrap' } }, h('button.btn.sm', { on: { click: async () => { await UI.Engine.callWorker('clearCache'); UI.toast('Cache cleared', 'ok'); UI.App.refresh(); } } }, 'Clear cache'), !PQ.Platform.native ? h('button.btn.sm', { on: { click: async () => { const ok = await PQ.Platform.persist(); UI.toast(ok ? 'Storage marked persistent' : 'The browser declined persistent storage', ok ? 'ok' : 'warn'); } } }, 'Keep data persistent') : null, h('button.btn.sm.danger', { on: { click: async () => { if (await UI.confirm('Remove all files?', 'Queries keep their steps.', 'Remove')) { for (const f of UI.App.files) { await UI.Engine.call('removeFile', { id: f.id }); PQ.Platform.fileHandles.del(f.id); } await UI.App.reloadFiles(); UI.App.refresh(); } } } }, 'Remove all files')), store),
        !PQ.Platform.native ? h('div.help', PQ.Platform.fsa ? 'Files opened from disk stay linked: Refresh re-reads them when they change.' : 'This browser can’t keep links to files on disk. Re-add a file to update it.') : null),
      okLabel: 'Save',
      onOk: () => {
        if (N.ready && N.disabled === native.checked) { N.setEnabled(native.checked); UI.App.refresh(); }
        localStorage.setItem('floe.theme', theme.value); UI.App.applyTheme();
        Store.edit('Change settings', (p) => { p.settings.previewRows = +rows.value; p.settings.locale = loc.value; });
      },
    });
  };

  /* ================================ Outputs / Refresh All ================================ */
  UI.refreshAll = async function () {
    const outs = Store.project.queries.filter((q) => q.load && q.load.target && q.load.target !== 'none');
    if (!outs.length) return UI.toast('No query has an output. Set "Load to" in the query properties (right panel).', 'warn', { ms: 6000 });
    UI.App.busy('Refresh All', true);
    try {
      const r = await UI.Engine.call('refreshAll', {}, (p) => UI.App.progress(p));
      const list = h('ul', { style: { margin: 0, paddingLeft: '18px' } }, r.outputs.map((o) => h('li', o.error ? h('span', { style: { color: 'var(--err)' } }, o.name + ': ' + o.error) : h('span', h('b', o.name), ' — ' + PQ.fmtInt(o.rows) + ' rows ', h('button.link-btn', { on: { click: () => UI.download(o.name, o.data, o.mime) } }, 'download')))));
      UI.modal({ title: 'Refresh All — done in ' + UI.fmtMs(r.ms), icon: 'fa-arrows-rotate', body: h('div.col', h('p.muted', { style: { margin: 0 } }, 'Ran ' + r.outputs.length + ' output(s) on full data in dependency order.'), list), footer: [h('button.btn.primary', { on: { click: () => r.outputs.filter((o) => !o.error).forEach((o, i) => setTimeout(() => UI.download(o.name, o.data, o.mime), i * 200)) } }, UI.icon('fa-download'), 'Download all')] });
    } catch (e) { if (!e.cancelled) UI.toast('Refresh failed: ' + e.message, 'err'); }
    finally { UI.App.busy(null); }
  };

  /* ================================ CLI dialog ================================ */
  UI.cliDialog = function () {
    if (!PQ.Platform.native) return UI.modal({
      title: 'Automate outside the browser', icon: 'fa-terminal', size: 'wide',
      body: h('div.col', h('p', { style: { margin: 0 } }, 'Export the project as a standalone Polars script. It runs anywhere Python runs — cron, CI or a notebook.'), h('pre.code', 'pip install polars fastexcel xlsxwriter\npython ' + PQ.snake(Store.project.name) + '.py')),
      okLabel: 'Export Python…', onOk: () => { setTimeout(() => UI.pythonDialog(Store.ui.activeQid), 30); },
    });
    const p = Store.project;
    const params = (p.params || []).map((x) => ' --param ' + x.name + '=' + (String(x.value).includes(' ') ? '"' + x.value + '"' : x.value)).join('');
    const f = PQ.snake(p.name) + '.floe';
    const cmd = 'floe run ' + f + params + ' --output ./out';
    UI.modal({
      title: 'Run headless (CLI)', icon: 'fa-terminal', size: 'wide',
      body: h('div.col', h('p', { style: { margin: 0 } }, 'The desktop app ships a ', h('code', 'floe'), ' command-line binary built from the same engine crates. It refreshes every output without a UI — schedule it with cron, Task Scheduler or CI.'),
        h('pre.code', cmd + '\n\n# list queries and outputs\nfloe inspect ' + f + '\n\n# only one query\nfloe run ' + f + ' --query "' + ((p.queries[0] || {}).name || 'Query') + '" --output ./out\n\n# crontab: every weekday at 06:00\n0 6 * * 1-5  cd /reports && floe run ' + f + ' --output ./out')),
    });
  };

  /* ================================ About ================================ */
  UI.aboutDialog = function () {
    const i = PQ.Platform.info;
    const eng = UI.NativeEngine.status();
    UI.modal({ title: 'About', body: h('div.about',
      UI.logo(),
      h('h3', PQ.BRAND.name), h('div.faint', PQ.BRAND.tagline + ' · ' + i.version),
      h('div.row', { style: { justifyContent: 'center', flexWrap: 'wrap', marginTop: '10px' } },
        h('span.env-badge' + (PQ.Platform.native ? '.native' : ''), PQ.Platform.native ? 'Desktop' : 'Web'),
        i.tauri ? h('span.env-badge', 'Tauri ' + i.tauri) : null,
        h('span.env-badge', eng.ready ? 'Polars ' + (eng.polars || '') : 'Built-in engine')),
      !PQ.Platform.native ? h('p.faint', { style: { fontSize: '12px', maxWidth: '380px', margin: '10px auto 0' } }, 'Your data never leaves this device. Files are processed in your browser and kept in its local storage.') : null) });
  };

  /* ================================ Shortcuts ================================ */
  UI.shortcutsDialog = function () {
    const mac = PQ.Platform.os === 'mac';
    const rows = [['Ctrl+Z / Ctrl+Shift+Z', 'Undo / redo'], ['Ctrl+Enter', 'Apply dialog'], ['Ctrl+Space', 'Autocomplete'], ['Ctrl+S', 'Save'], ['Ctrl+Shift+S', 'Save as'], ['Ctrl+O', 'Open project'], ['Alt+N', 'New project'], ['Ctrl+Shift+F', 'Full data'], ['Ctrl+V', 'Paste a table as a new query'], ['Esc', 'Cancel query'], ['Delete', 'Remove columns'], ['Ctrl+click / Shift+click', 'Multi-select'], ['Ctrl+C', 'Copy cell'], ['Alt+↑ / Alt+↓', 'Previous / next step'], ['F2', 'Rename query']];
    const key = (x) => (mac ? { Ctrl: '⌘', Shift: '⇧', Alt: '⌥', Enter: '↩' }[x] || x : x);
    UI.modal({ title: 'Keyboard shortcuts', icon: 'fa-keyboard', body: h('table.shortcuts', rows.map((r) => h('tr', h('td', r[0].split(' / ').map((k, i) => [i ? ' / ' : '', k.split('+').map((x, j) => [j && !mac ? '+' : '', h('kbd', key(x))])])), h('td', r[1])))) });
  };
})();
