(function () {
  const PQ = self.PQ, UI = PQ.UI;
  const T = self.__TAURI__;
  const inv = (c, a) => T.core.invoke(c, a);
  const N = (UI.NativeEngine = { ready: false, info: null, results: new Set(), disabled: false, gen: 0 });
  const schemas = new Map();

  N.available = () => N.ready && !N.disabled;
  N.status = () => ({ ready: N.available(), polars: N.info && N.info.polars, version: N.info && N.info.version });

  const loadScript = (src, test) => (test() ? Promise.resolve() : new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error(src + ' failed to load')); document.head.appendChild(s); }));

  N.init = async function () {
    if (!PQ.Platform.native) return false;
    try {
      const s = await inv('engine_status');
      if (!s || !s.available || !s.info) return false;
      await Promise.all([loadScript('vendor/arrow.es2015.min.js', () => !!self.Arrow), loadScript('js/plan.js', () => !!PQ.Plan)]);
      N.info = s.info;
      N.ready = true;
      N.disabled = localStorage.getItem('floe.nativeEngine') === 'off';
    } catch (e) { console.warn('Polars engine unavailable', e); }
    return N.ready;
  };

  function filesMap() {
    const m = {};
    (UI.App.files || []).forEach((f) => { if (f.path) m[f.id] = f.path; });
    return m;
  }
  function lower(project, qid, upto) {
    const r = PQ.Plan.lower(project, qid, { upto, files: filesMap() });
    UI.Engine.nativeReason = r.ok ? null : r.reason;
    return r;
  }
  const pending = new Map();

  N.shouldRun = function (op, msg, project) {
    if (!N.available()) { UI.Engine.nativeReason = N.disabled ? 'Polars is turned off' : null; return false; }
    if (op === 'page' || op === 'profile' || op === 'distinct') return N.results.has(msg.resultId);
    if (op === 'evaluate') {
      if (msg.draft) return false;
      const r = lower(project, msg.qid, msg.upto);
      if (r.ok) pending.set(msg, r.plan);
      return r.ok;
    }
    if (op === 'exportQuery') {
      if (!['csv', 'xlsx', 'parquet', 'arrow'].includes(msg.format)) return false;
      const r = lower(project, msg.qid);
      if (r.ok) pending.set(msg, r.plan);
      return r.ok;
    }
    return false;
  };

  const ERR = '__err_';
  function decodePage(buf, schema) {
    const table = Arrow.tableFromIPC(new Uint8Array(buf));
    const cols = schema.map((c) => table.getChild(c.name));
    const errCols = schema.map((c) => table.getChild(ERR + c.name));
    const rows = new Array(table.numRows);
    for (let r = 0; r < table.numRows; r++) {
      const row = new Array(schema.length);
      for (let c = 0; c < schema.length; c++) {
        const t = schema[c].type;
        if (errCols[c] && errCols[c].get(r)) { row[c] = { __err: 'Cannot convert to ' + (PQ.TYPES[t] || PQ.TYPES.any).label }; continue; }
        let v = cols[c] ? cols[c].get(r) : null;
        if (v === undefined) v = null;
        if (v !== null) {
          if (typeof v === 'bigint') v = Number(v);
          if (t === 'date' || t === 'datetime') v = new Date(typeof v === 'number' ? v : Number(v));
          else if (typeof v === 'object' && !(v instanceof Date)) v = String(v);
        }
        row[c] = v;
      }
      rows[r] = row;
    }
    return rows;
  }

  function page(resultId, offset, count) {
    return inv('engine_page', { resultId, offset, count }).then((buf) => decodePage(buf, schemas.get(resultId) || []));
  }

  function guard(gen, v) {
    if (gen !== N.gen) { const e = new Error('Cancelled by user'); e.cancelled = true; throw e; }
    return v;
  }

  N.call = async function (op, msg) {
    const gen = N.gen;
    if (op === 'evaluate') {
      const plan = pending.get(msg); pending.delete(msg);
      const project = UI.Engine.lastProject;
      const r = guard(gen, await inv('engine_call', { op: 'evaluate', args: { plan, mode: msg.mode || 'preview', previewRows: project.settings.previewRows } }));
      N.results.add(r.resultId);
      schemas.set(r.resultId, r.schema);
      while (N.results.size > 12) { const old = N.results.values().next().value; N.results.delete(old); schemas.delete(old); }
      const q = project.queries.find((x) => x.id === msg.qid);
      const upto = msg.upto === undefined || msg.upto === null ? q.steps.length - 1 : msg.upto;
      const states = q.steps.slice(0, upto + 1).map((s, i) => (i === upto ? { ok: true, rows: r.n, cols: r.schema.length, schema: r.schema, ms: r.ms, cached: false, truncated: r.truncated } : { ok: true, rows: 0, cols: 0, ms: 0, cached: false, native: true }));
      const out = { resultId: r.resultId, n: r.n, schema: r.schema, quality: r.quality, states, ms: r.ms, truncated: r.truncated, failedAt: -1, fp: null, engine: 'polars', note: 'Polars runs the whole query at once, so row counts are shown for the selected step only.' };
      out.firstPage = guard(gen, await page(r.resultId, 0, 200));
      out.suggestions = await UI.Engine.callWorker('evaluate', { qid: msg.qid, upto: msg.upto, mode: 'preview' }).then((x) => { out.fp = x.fp || null; return x.suggestions || []; }, () => []);
      return out;
    }
    if (op === 'exportQuery') {
      const plan = pending.get(msg); pending.delete(msg);
      const q = UI.Engine.lastProject.queries.find((x) => x.id === msg.qid);
      const ext = msg.format === 'arrow' ? 'arrow' : msg.format;
      const path = await inv('pick_save', { defaultName: PQ.snake(q.name) + '.' + ext });
      if (!path) { const e = new Error('Cancelled'); e.cancelled = true; throw e; }
      const r = guard(gen, await inv('engine_call', { op: 'export', args: { plan, format: msg.format, path, sheet: q.name } }));
      return { rows: r.rows, path, written: true };
    }
    if (op === 'page') return { rows: await page(msg.resultId, msg.offset, msg.count) };
    if (op === 'profile') return inv('engine_call', { op: 'profile', args: { resultId: msg.resultId, col: msg.col } });
    if (op === 'distinct') return inv('engine_call', { op: 'distinct', args: { resultId: msg.resultId, col: msg.col } });
    throw new Error('Polars: unsupported op ' + op);
  };

  N.cancel = function () { N.gen++; if (N.ready) inv('engine_cancel').catch(() => {}); };
  N.setEnabled = function (on) { N.disabled = !on; try { localStorage.setItem('floe.nativeEngine', on ? 'on' : 'off'); } catch (e) { } };
})();
