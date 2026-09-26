/* PQX UI core: DOM helpers, toasts, menus, modals, engine supervisor, project store with undo/redo.
 * In the Tauri build: the engine client talks to src-tauri commands; the supervisor lives in Rust. */
(function () {
  const PQ = self.PQ;
  const UI = (PQ.UI = {});

  /* ================================ DOM ================================ */
  /** h('div.cls#id', {attrs, on:{click}}, ...children) */
  UI.h = function (sel, attrs, ...kids) {
    const m = /^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i.exec(sel) || [];
    const el = document.createElement(m[1] || 'div');
    (m[2] || '').replace(/([.#])([\w-]+)/g, (_, t, v) => { if (t === '.') el.classList.add(v); else el.id = v; });
    if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) { kids.unshift(attrs); attrs = null; }
    if (attrs) for (const k of Object.keys(attrs)) {
      const v = attrs[k];
      if (v === undefined || v === null || v === false) continue;
      if (k === 'on') { for (const ev of Object.keys(v)) el.addEventListener(ev, v[ev]); }
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'class') el.className += ' ' + v;
      else if (k === 'value') el.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = !!v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    const add = (c) => { if (c === null || c === undefined || c === false) return; if (Array.isArray(c)) c.forEach(add); else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c))); };
    kids.forEach(add);
    return el;
  };
  const h = UI.h;
  UI.icon = (name, extra) => h('i', { class: 'fa-solid ' + name + ' ' + (extra || ''), 'aria-hidden': 'true' });
  UI.$ = (s, r) => (r || document).querySelector(s);
  UI.$$ = (s, r) => [...(r || document).querySelectorAll(s)];
  UI.clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
  UI.typeIcon = (t) => (PQ.TYPES[t] || PQ.TYPES.any).icon;
  /** Floe mark, inline so it follows the theme: ink blocks = currentColor, drifting block = accent. */
  UI.LOGO = '<svg viewBox="0 0 32 32" aria-hidden="true"><g fill="currentColor"><rect x="3" y="17" width="12" height="12" rx="3.2"/><rect x="17" y="17" width="12" height="12" rx="3.2"/><rect x="3" y="3" width="12" height="12" rx="3.2"/></g><rect x="18" y="2" width="12" height="12" rx="3.2" fill="var(--accent)" transform="rotate(12 24 8)"/></svg>';
  UI.logo = (cls) => { const s = document.createElement('span'); s.className = cls || ''; s.innerHTML = UI.LOGO; return s.firstChild; };
  /** Colour-coded type chip: each data type owns a chroma. */
  UI.typeChip = (t, attrs) => h('span.t-ico', Object.assign({ dataset: { t: t || 'any' }, title: (PQ.TYPES[t] || PQ.TYPES.any).label }, attrs || {}), UI.typeIcon(t));

  /* ================================ Toasts ================================ */
  UI.toast = function (text, kind, opts) {
    opts = opts || {};
    const box = UI.$('#toasts');
    const el = h('div.toast' + (kind ? '.' + kind : ''), { role: 'status' },
      UI.icon(kind === 'err' ? 'fa-circle-exclamation' : kind === 'ok' ? 'fa-circle-check' : kind === 'warn' ? 'fa-triangle-exclamation' : 'fa-circle-info'),
      h('div.t-body', h('div', text), opts.actions ? h('div.t-act', opts.actions.map((a) => h('button.btn.sm', { on: { click: () => { a.run(); el.remove(); } } }, a.label))) : null),
      h('button.icon-btn', { 'aria-label': 'Dismiss', on: { click: () => el.remove() } }, UI.icon('fa-xmark')));
    box.appendChild(el);
    setTimeout(() => el.remove(), opts.ms || (kind === 'err' ? 9000 : 4000));
  };

  /* ================================ Menus ================================ */
  let openMenu = null;
  UI.closeMenu = () => { if (openMenu) { openMenu.remove(); openMenu = null; } UI.$$('.menu').forEach((m) => m.remove()); };
  /** items: [{label, icon, run, kbd, danger, disabled, sub:[...]}, '-', {header}] */
  UI.menu = function (items, x, y, opts) {
    UI.closeMenu();
    const el = buildMenu(items);
    document.body.appendChild(el);
    place(el, x, y);
    openMenu = el;
    if (opts && opts.focus !== false) { const first = el.querySelector('.mi:not(:disabled)'); if (first) first.focus(); }
    return el;
  };
  function buildMenu(items, isSub) {
    const el = h('div.menu', { role: 'menu', on: { keydown: menuKeys } });
    items.forEach((it) => {
      if (it === '-') return el.appendChild(h('hr'));
      if (it.header) return el.appendChild(h('div.mh', it.header));
      if (it.node) return el.appendChild(it.node);
      const btn = h('button.mi', { role: 'menuitem', disabled: it.disabled, class: it.danger ? 'danger' : '' },
        it.icon ? UI.icon(it.icon, 'fa-fw') : h('span', { style: { width: '1.25em', display: 'inline-block' } }),
        h('span', it.label), it.kbd ? h('span.kbd', it.kbd) : null, it.sub ? UI.icon('fa-chevron-right', 'sub-arrow') : null);
      if (it.sub) {
        let sub = null;
        const openSub = () => {
          el.querySelectorAll(':scope > .menu').forEach((m) => m.remove());
          sub = buildMenu(it.sub, true);
          document.body.appendChild(sub);
          const r = btn.getBoundingClientRect();
          place(sub, r.right - 2, r.top - 4, r.left);
          sub.dataset.sub = '1';
          el._sub && el._sub !== sub && el._sub.remove();
          el._sub = sub;
        };
        btn.addEventListener('mouseenter', openSub);
        btn.addEventListener('click', openSub);
        btn.addEventListener('keydown', (e) => { if (e.key === 'ArrowRight') { openSub(); const f = sub.querySelector('.mi'); f && f.focus(); } });
      } else {
        btn.addEventListener('mouseenter', () => { if (el._sub) { el._sub.remove(); el._sub = null; } });
        btn.addEventListener('click', (e) => { e.stopPropagation(); UI.closeMenu(); if (it.run) it.run(); });
      }
      el.appendChild(btn);
    });
    return el;
  }
  function menuKeys(e) {
    const items = [...e.currentTarget.querySelectorAll(':scope > .mi:not(:disabled)')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); (items[i + 1] || items[0]).focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); (items[i - 1] || items[items.length - 1]).focus(); }
    else if (e.key === 'Escape') { UI.closeMenu(); }
    else if (e.key === 'ArrowLeft' && e.currentTarget.dataset.sub) { e.currentTarget.remove(); }
  }
  function place(el, x, y, altX) {
    const r = el.getBoundingClientRect();
    let left = x, top = y;
    if (left + r.width > innerWidth - 6) left = altX !== undefined ? Math.max(6, altX - r.width) : Math.max(6, innerWidth - r.width - 6);
    if (top + r.height > innerHeight - 6) top = Math.max(6, innerHeight - r.height - 6);
    el.style.left = left + 'px'; el.style.top = top + 'px';
  }
  UI.placeAt = place;
  document.addEventListener('mousedown', (e) => { if (!e.target.closest('.menu')) UI.closeMenu(); });
  addEventListener('blur', () => UI.closeMenu());
  addEventListener('resize', () => UI.closeMenu());

  /* ================================ Modals ================================ */
  const modalStack = [];
  /** UI.modal({title, icon, body: Node, wide, footer: [nodes], onOk, okLabel, onClose}) → {close, el, setBusy} */
  UI.modal = function (o) {
    const prevFocus = document.activeElement;
    const okBtn = o.onOk ? h('button.btn.primary', { on: { click: () => doOk() } }, o.okLabel || 'OK') : null;
    const footLeft = h('div.left');
    const m = h('div.modal' + (o.size ? '.' + o.size : ''), { role: 'dialog', 'aria-modal': 'true', 'aria-label': o.title },
      h('div.modal-h', h('h2', o.icon ? UI.icon(o.icon) : null, o.title), h('button.icon-btn.close', { 'aria-label': 'Close', on: { click: () => close() } }, UI.icon('fa-xmark'))),
      h('div.modal-b', o.body),
      o.noFooter ? null : h('div.modal-f', footLeft, o.footer || null, o.onOk ? h('button.btn', { on: { click: () => close() } }, o.cancelLabel || 'Cancel') : h('button.btn', { on: { click: () => close() } }, 'Close'), okBtn));
    const back = h('div.modal-back', { on: { mousedown: (e) => { if (e.target === back) back._down = true; }, mouseup: (e) => { if (e.target === back && back._down && !o.sticky) close(); back._down = false; } } }, m);
    document.body.appendChild(back);
    modalStack.push(api);
    async function doOk() {
      if (!okBtn || okBtn.disabled) return;
      try { const r = await o.onOk(); if (r !== false) close(true); }
      catch (e) { UI.toast(e.message || String(e), 'err'); }
    }
    function close(ok) {
      if (!back.isConnected) return;
      back.remove();
      modalStack.splice(modalStack.indexOf(api), 1);
      if (o.onClose) o.onClose(!!ok);
      if (prevFocus && prevFocus.focus) prevFocus.focus();
    }
    function api() {}
    api.close = close; api.el = m; api.ok = doOk; api.footLeft = footLeft;
    api.setOkEnabled = (v) => { if (okBtn) okBtn.disabled = !v; };
    m.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !e.target.closest('.ac')) { e.stopPropagation(); close(); }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doOk(); }
    });
    setTimeout(() => { const f = m.querySelector('[autofocus]') || m.querySelector('.modal-b input, .modal-b select, .modal-b textarea'); if (f) f.focus(); }, 30);
    return api;
  };
  UI.anyModal = () => modalStack.length > 0;
  UI.confirm = (title, text, okLabel) => new Promise((res) => { UI.modal({ title, icon: 'fa-circle-question', body: h('p', { style: { margin: 0 } }, text), okLabel: okLabel || 'OK', onOk: () => res(true), onClose: (ok) => { if (!ok) res(false); } }); });
  UI.prompt = (title, label, value) => new Promise((res) => {
    const inp = h('input.input', { value: value || '', autofocus: true, on: { keydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); m.ok(); } } } });
    const m = UI.modal({ title, icon: 'fa-pen', body: h('div.field', h('label', label), inp), onOk: () => { const v = inp.value.trim(); if (!v) return false; res(v); }, onClose: (ok) => { if (!ok) res(null); } });
    setTimeout(() => inp.select(), 40);
  });

  /* ================================ Engine supervisor ================================ */
  const Engine = (UI.Engine = { worker: null, pending: new Map(), seq: 0, restarts: 0, state: 'starting', listeners: new Set(), lastProject: null });
  Engine.start = function () {
    Engine.state = 'starting'; notify();
    const w = new Worker('js/worker.js');
    Engine.worker = w;
    Engine.ready = new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('Engine did not start')), 30000);
      w.addEventListener('message', function once(ev) { if (ev.data && ev.data.type === 'ready') { clearTimeout(t); w.removeEventListener('message', once); res(); } });
    });
    w.onmessage = (ev) => {
      const m = ev.data; if (!m || !m.id) return;
      const p = Engine.pending.get(m.id); if (!p) return;
      if (m.type === 'progress') { p.onProgress && p.onProgress(m.payload); return; }
      Engine.pending.delete(m.id);
      if (!Engine.pending.size) { Engine.state = 'idle'; notify(); }
      if (m.type === 'done') p.resolve(m.payload); else { const e = new Error(m.payload.message); e.engine = true; p.reject(e); }
    };
    w.onerror = (ev) => {
      ev.preventDefault && ev.preventDefault();
      console.error('Engine crashed', ev.message);
      crash('Engine crashed: ' + (ev.message || 'unknown error'));
    };
    return Engine.ready.then(async () => {
      await Engine.call('init');
      if (Engine.lastProject) await Engine.call('setProject', { project: Engine.lastProject });
      Engine.state = 'idle'; notify();
    });
  };
  function crash(msg) {
    const pend = [...Engine.pending.values()];
    Engine.pending.clear();
    try { Engine.worker.terminate(); } catch (e) { /* ignore */ }
    Engine.restarts++;
    Engine.state = 'restarting'; notify();
    pend.forEach((p) => { const e = new Error(msg); e.cancelled = /cancel/i.test(msg); p.reject(e); });
    return Engine.start();
  }
  /** Cancel = kill the worker (and the native engine process). Always works, even mid-collect. */
  Engine.cancel = () => { if (UI.NativeEngine) UI.NativeEngine.cancel(); return crash('Cancelled by user'); };
  /** Router: native Polars engine when eligible, built-in engine otherwise (and as fallback). */
  Engine.call = function (op, msg, onProgress, transfer) {
    const N = UI.NativeEngine;
    if (N && Engine.lastProject && N.shouldRun(op, msg || {}, Engine.lastProject)) {
      Engine.state = 'busy'; notify();
      Engine.nativeInFlight = (Engine.nativeInFlight || 0) + 1;
      return N.call(op, msg).then((r) => { Engine.lastEngine = op === 'evaluate' ? 'polars' : Engine.lastEngine; return r; }, (e) => {
        if (op === 'evaluate') { if (!e.fallback) console.warn('native engine fell back:', e); Engine.lastEngine = 'built-in'; return Engine.callWorker(op, msg, onProgress, transfer); }
        throw e;
      }).finally(() => { Engine.nativeInFlight--; if (!Engine.pending.size && !Engine.nativeInFlight) { Engine.state = 'idle'; notify(); } });
    }
    if (op === 'evaluate') Engine.lastEngine = 'built-in';
    return Engine.callWorker(op, msg, onProgress, transfer);
  };
  Engine.callWorker = function (op, msg, onProgress, transfer) {
    const id = ++Engine.seq;
    Engine.state = 'busy'; notify();
    return new Promise((resolve, reject) => {
      Engine.pending.set(id, { resolve, reject, onProgress, op });
      Engine.worker.postMessage(Object.assign({ id, op }, msg || {}), transfer || []);
    });
  };
  Engine.setProject = function (project) {
    Engine.lastProject = JSON.parse(JSON.stringify(project));
    return Engine.call('setProject', { project: Engine.lastProject });
  };
  Engine.onState = (f) => Engine.listeners.add(f);
  function notify() { Engine.listeners.forEach((f) => f(Engine.state)); }

  /* ================================ Project store (immutable snapshots + undo/redo) ================================ */
  const Store = (UI.Store = { project: null, undo: [], redo: [], listeners: new Set(), filePath: null, savedSnapshot: null, ui: { activeQid: null, activeStep: null, mode: 'preview', selCols: [], rightTab: 'steps' } });
  Store.dirty = () => Store.savedSnapshot !== null && Store.savedSnapshot !== Store.project;
  Store.markSaved = () => { Store.savedSnapshot = Store.project; try { localStorage.setItem('floe.filePath', Store.filePath || ''); } catch (e) { /* ignore */ } emit('saved'); };
  const LS_KEY = 'floe.project.v1';
  // one-time migration from the pre-rename key
  try { if (!localStorage.getItem(LS_KEY) && localStorage.getItem('pqx.project.v1')) localStorage.setItem(LS_KEY, localStorage.getItem('pqx.project.v1')); } catch (e) { /* storage disabled */ }
  Store.newProject = () => ({ format_version: PQ.Steps.FORMAT_VERSION, name: 'Untitled project', settings: { previewRows: 1000, locale: 'en-US' }, params: [], queries: [] });
  Store.load = function () {
    try { const raw = localStorage.getItem(LS_KEY); if (raw) return PQ.Steps.migrate(JSON.parse(raw)); } catch (e) { console.warn('Could not restore project', e); }
    return Store.newProject();
  };
  Store.init = function () {
    Store.project = Store.load();
    Store.savedSnapshot = Store.project;
    Store.filePath = localStorage.getItem('floe.filePath') || null;
    const ui = JSON.parse(localStorage.getItem('floe.ui') || '{}');
    Store.ui.activeQid = ui.activeQid && Store.project.queries.some((q) => q.id === ui.activeQid) ? ui.activeQid : (Store.project.queries[0] || {}).id || null;
  };
  const persist = PQ.debounce(() => {
    try { localStorage.setItem(LS_KEY, JSON.stringify(Store.project)); UI.setSaveState && UI.setSaveState(Store.dirty() && Store.filePath ? 'Autosaved · unsaved changes' : 'Autosaved'); }
    catch (e) { UI.setSaveState && UI.setSaveState('Not saved: ' + e.message); }
  }, 400);
  Store.saveUI = () => localStorage.setItem('floe.ui', JSON.stringify({ activeQid: Store.ui.activeQid }));

  /** Apply an edit. fn receives a deep copy and mutates it; the previous snapshot goes on the undo stack. */
  Store.edit = function (label, fn, uiPatch) {
    const before = Store.project;
    const next = JSON.parse(JSON.stringify(before));
    const r = fn(next);
    if (r === false) return;
    Store.undo.push({ label, project: before, ui: { activeQid: Store.ui.activeQid, activeStep: Store.ui.activeStep } });
    if (Store.undo.length > 200) Store.undo.shift();
    Store.redo = [];
    Store.project = next;
    if (uiPatch) Object.assign(Store.ui, typeof uiPatch === 'function' ? uiPatch(next) : uiPatch);
    UI.setSaveState && UI.setSaveState('Saving…');
    persist();
    emit('project');
  };
  Store.undoOne = function () {
    const e = Store.undo.pop(); if (!e) return;
    Store.redo.push({ label: e.label, project: Store.project, ui: { activeQid: Store.ui.activeQid, activeStep: Store.ui.activeStep } });
    Store.project = e.project; Object.assign(Store.ui, e.ui);
    persist(); emit('project');
    UI.toast('Undo · ' + e.label, null, { ms: 1500 });
  };
  Store.redoOne = function () {
    const e = Store.redo.pop(); if (!e) return;
    Store.undo.push({ label: e.label, project: Store.project, ui: { activeQid: Store.ui.activeQid, activeStep: Store.ui.activeStep } });
    Store.project = e.project; Object.assign(Store.ui, e.ui);
    persist(); emit('project');
    UI.toast('Redo · ' + e.label, null, { ms: 1500 });
  };
  Store.replace = function (project, label) {
    Store.undo.push({ label: label || 'Open project', project: Store.project, ui: { activeQid: Store.ui.activeQid, activeStep: Store.ui.activeStep } });
    Store.redo = [];
    Store.project = project;
    Store.ui.activeQid = (project.queries[0] || {}).id || null;
    Store.ui.activeStep = null; Store.ui.selCols = [];
    Store.filePath = null; Store.savedSnapshot = project;
    persist(); emit('project');
  };
  Store.setUI = function (patch) { Object.assign(Store.ui, patch); Store.saveUI(); emit('ui'); };
  Store.on = (f) => Store.listeners.add(f);
  function emit(kind) { Store.listeners.forEach((f) => f(kind)); }

  Store.query = (id) => Store.project.queries.find((q) => q.id === (id || Store.ui.activeQid));
  Store.activeIndex = function () { const q = Store.query(); if (!q) return -1; const a = Store.ui.activeStep; return a === null || a === undefined || a >= q.steps.length ? q.steps.length - 1 : a; };
  PQ.queryName = (id) => { const q = Store.project && Store.project.queries.find((x) => x.id === id); return q ? q.name : '(missing query)'; };

  /** Default step name, made unique within the query ("Filtered Rows 2"). */
  Store.stepName = function (q, type) {
    const base = PQ.Steps.label(type);
    const names = new Set(q.steps.map((s) => s.name));
    if (!names.has(base)) return base;
    let i = 2; while (names.has(base + ' ' + i)) i++;
    return base + ' ' + i;
  };

  /** Add a step after the active step. Consecutive compatible steps are folded together (like Power Query). */
  Store.addStep = function (kind, opts) {
    opts = opts || {};
    const q = Store.query(); if (!q) return;
    const at = Store.activeIndex() + 1;
    const prev = q.steps[at - 1];
    const isLast = at === q.steps.length;
    if (!opts.noFold && isLast && prev && prev.kind.type === kind.type && !prev.note) {
      const folded = foldSteps(prev.kind, kind);
      if (folded) {
        Store.edit(PQ.Steps.label(kind.type), (p) => { const qq = p.queries.find((x) => x.id === q.id); qq.steps[at - 1].kind = folded; }, { activeStep: null });
        return;
      }
    }
    Store.edit(PQ.Steps.label(kind.type), (p) => {
      const qq = p.queries.find((x) => x.id === q.id);
      qq.steps.splice(at, 0, { id: PQ.uid('s'), name: opts.name || Store.stepName(qq, kind.type), kind });
    }, { activeStep: isLast ? null : at });
  };
  function foldSteps(a, b) {
    if (a.type === 'RemoveColumns') return { type: 'RemoveColumns', cols: a.cols.concat(b.cols.filter((c) => !a.cols.includes(c))) };
    if (a.type === 'Rename') {
      const map = a.map.map((p) => p.slice());
      b.map.forEach(([from, to]) => { const hit = map.find((p) => p[1] === from); if (hit) hit[1] = to; else map.push([from, to]); });
      return { type: 'Rename', map: map.filter((p) => p[0] !== p[1]) };
    }
    if (a.type === 'ChangeType' && (a.onError || 'error') === (b.onError || 'error') && a.locale === b.locale) {
      const changes = a.changes.map((c) => ({ ...c }));
      b.changes.forEach((c) => { const hit = changes.find((x) => x.col === c.col); if (hit) Object.assign(hit, c); else changes.push(c); });
      return Object.assign({}, a, { changes });
    }
    return null;
  }

  /* ================================ Files ================================ */
  /** Save output: native Save-As dialog in the desktop app, a download in the browser. Resolves to path/name or null. */
  UI.download = async function (name, data, mime) {
    try { return await PQ.Platform.saveFile(name, data, mime); }
    catch (e) { UI.toast(e.message || String(e), 'err'); return null; }
  };
  UI.pickFiles = (accept, multiple, dir) => new Promise((res) => {
    const inp = h('input', { type: 'file', accept: accept || '', multiple: multiple ? true : null, webkitdirectory: dir ? true : null, style: { display: 'none' } });
    inp.addEventListener('change', () => { res([...inp.files]); inp.remove(); });
    document.body.appendChild(inp); inp.click();
  });
  UI.fmtBytes = (n) => (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB');
  UI.fmtMs = (ms) => (ms < 1 ? '<1 ms' : ms < 1000 ? Math.round(ms) + ' ms' : (ms / 1000).toFixed(ms < 10000 ? 2 : 1) + ' s');

  /** Render a value from the engine (errors arrive as {__err}) */
  UI.cellText = function (v, type) {
    if (v === null || v === undefined) return { text: 'null', cls: 'null' };
    if (v && v.__err) return { text: 'Error', cls: 'err', title: v.__err };
    if (v instanceof Date) return { text: PQ.fmtDate(v, type), cls: '' };
    if (typeof v === 'number') return { text: type === 'number' && !Number.isInteger(v) ? String(+v.toFixed(10)) : String(v), cls: 'num' };
    if (typeof v === 'boolean') return { text: v ? 'TRUE' : 'FALSE', cls: v ? 'bool-t' : 'bool-f' };
    return { text: String(v), cls: '' };
  };

  /** Small preview table used in dialogs. */
  UI.miniTable = function (schema, rows, opts) {
    opts = opts || {};
    const hl = new Set(opts.highlight || []);
    return h('div.mini-wrap', { style: opts.maxHeight ? { maxHeight: opts.maxHeight } : null },
      h('table.mini-table',
        h('thead', h('tr', schema.map((c, i) => h('th', { class: (hl.has(c.name) ? 'newcol ' : '') + (opts.clickable ? 'clickable' : ''), dataset: { i }, on: opts.onHeader ? { click: () => opts.onHeader(c.name, i) } : null }, UI.typeChip(c.type), c.name)))),
        h('tbody', rows.map((r) => h('tr', r.map((v, i) => { const c = UI.cellText(v, schema[i] && schema[i].type); return h('td', { class: c.cls + (hl.has(schema[i] && schema[i].name) ? ' newcol' : ''), title: c.title || c.text }, c.text); }))))));
  };
})();
