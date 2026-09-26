/* Native Polars engine adapter (desktop only).
 * Talks to the Tauri shell's `engine_*` commands, which supervise the `floe-engine` process.
 * Pages arrive as Arrow IPC bytes and are decoded with apache-arrow into the same row shape the
 * built-in engine produces, so the grid, profile and filter UI don't know which engine ran.
 *
 * Routing (UI.Engine.call):
 *   evaluate  → native when the engine is installed, the query and its references use only supported
 *               steps, every file source has a real path, and no draft step is being previewed.
 *   page / profile / distinct → the engine that produced the resultId.
 *   everything else → built-in engine.
 * Any native failure falls back to the built-in engine for that call. */
(function () {
  const PQ = self.PQ, UI = PQ.UI;
  const T = self.__TAURI__;
  const inv = (c, a) => T.core.invoke(c, a);
  const N = (UI.NativeEngine = { ready: false, info: null, supported: new Set(), results: new Set(), projectSent: null, disabled: false });

  N.available = () => N.ready && !N.disabled;
  N.status = () => ({ ready: N.available(), polars: N.info && N.info.polars, version: N.info && N.info.version });

  N.init = async function () {
    if (!PQ.Platform.native) return false;
    try {
      const s = await inv('engine_status');
      if (!s.available || !s.info) return false;
      N.info = s.info;
      N.supported = new Set(s.info.supported || []);
      N.ready = true;
      N.disabled = localStorage.getItem('floe.nativeEngine') === 'off';
    } catch (e) { console.warn('native engine unavailable', e); }
    return N.ready;
  };

  function filesMap() {
    const m = {};
    (UI.App.files || []).forEach((f) => { if (f.path) m[f.id] = f.path; });
    return m;
  }
  async function sync(project) {
    const key = PQ.hash(JSON.stringify(project) + JSON.stringify(filesMap()));
    if (N.projectSent === key) return;
    await inv('engine_call', { op: 'setProject', args: { project, files: filesMap() } });
    N.projectSent = key;
  }

  /** Cheap client-side check first; the engine confirms with canRun (covers referenced queries). */
  function clientEligible(project, qid) {
    const byId = new Map(project.queries.map((q) => [q.id, q]));
    const files = filesMap();
    const seen = new Set();
    const ok = (id) => {
      if (seen.has(id)) return true;
      seen.add(id);
      const q = byId.get(id); if (!q) return false;
      for (const s of q.steps) {
        if (s.disabled) continue;
        const k = s.kind;
        if (!N.supported.has(k.type)) return false;
        if (k.type === 'Source') {
          const src = k.source || {};
          if (src.kind === 'folder' || src.kind === 'database') return false;
          if (src.kind === 'file' && !files[src.fileId]) return false;
          if (src.kind === 'file' && src.item && (src.item.type === 'sheets' || src.item.type === 'name')) return false;
          if (src.kind === 'query' && !ok(src.query)) return false;
        }
        if (k.type === 'Merge' && !ok(k.right)) return false;
        if (k.type === 'Append' && !(k.others || []).every(ok)) return false;
      }
      return true;
    };
    return ok(qid);
  }

  N.shouldRun = function (op, msg, project) {
    if (!N.available()) return false;
    if (op === 'page' || op === 'profile' || op === 'distinct') return N.results.has(msg.resultId);
    if (op === 'evaluate') return !msg.draft && clientEligible(project, msg.qid);
    return false;
  };

  /* ---------- Arrow → rows in the built-in engine's wire shape ---------- */
  const ERR = '__err_';
  function decodePage(buf, schema) {
    const table = Arrow.tableFromIPC(new Uint8Array(buf));
    const names = schema.map((c) => c.name);
    const cols = names.map((n) => table.getChild(n));
    const errCols = names.map((n) => table.getChild(ERR + n));
    const rows = new Array(table.numRows);
    for (let r = 0; r < table.numRows; r++) {
      const row = new Array(names.length);
      for (let c = 0; c < names.length; c++) {
        const t = schema[c].type;
        if (errCols[c] && errCols[c].get(r)) { row[c] = { __err: 'Cannot convert to ' + (PQ.TYPES[t] || PQ.TYPES.any).label }; continue; }
        let v = cols[c] ? cols[c].get(r) : null;
        if (v === undefined) v = null;
        if (v !== null) {
          if (typeof v === 'bigint') v = Number(v);
          if (t === 'date' || t === 'datetime') v = new Date(Number(v));
          else if (typeof v === 'object' && !(v instanceof Date)) v = String(v);
        }
        row[c] = v;
      }
      rows[r] = row;
    }
    return rows;
  }
  const schemas = new Map(); // resultId → schema

  N.call = async function (op, msg) {
    const project = UI.Engine.lastProject;
    if (op === 'evaluate') {
      await sync(project);
      const can = await inv('engine_call', { op: 'canRun', args: { qid: msg.qid } });
      if (!can.ok) { const e = new Error('fallback'); e.fallback = true; throw e; }
      const r = await inv('engine_call', { op: 'evaluate', args: { qid: msg.qid, upto: msg.upto, mode: msg.mode } });
      // Map native step states onto the UI's shape.
      r.states = (r.states || []).map((s) => ({ ok: s.ok, error: s.error, rows: s.rows, cols: s.cols, ms: s.ms, cached: false }));
      if (r.failedAt === -1) r.failedAt = -1;
      if (r.resultId) {
        N.results.add(r.resultId);
        schemas.set(r.resultId, r.schema);
        r.firstPage = await N.call('page', { resultId: r.resultId, offset: 0, count: 200 }).then((p) => p.rows);
        // Suggestions come from the built-in engine's heuristics on the preview sample (cached, cheap).
        r.suggestions = msg.mode === 'full' ? [] : await UI.Engine.callWorker('evaluate', { qid: msg.qid, upto: msg.upto, mode: 'preview' }).then((x) => x.suggestions || [], () => []);
        // Keep every state's schema for the Schema tab on the selected step.
        const last = r.states[r.states.length - 1];
        if (last) last.schema = r.schema;
      }
      r.engine = 'polars';
      return r;
    }
    if (op === 'page') {
      const buf = await T.core.invoke('engine_page', { resultId: msg.resultId, offset: msg.offset, count: msg.count });
      return { rows: decodePage(buf, schemas.get(msg.resultId) || []) };
    }
    if (op === 'profile') return inv('engine_call', { op: 'profile', args: { resultId: msg.resultId, col: msg.col } });
    if (op === 'distinct') return inv('engine_call', { op: 'distinct', args: { resultId: msg.resultId, col: msg.col } });
    throw new Error('native: unsupported op ' + op);
  };

  N.cancel = function () { if (N.ready) inv('engine_cancel').catch(() => {}); };
  N.setEnabled = function (on) { N.disabled = !on; localStorage.setItem('floe.nativeEngine', on ? 'on' : 'off'); };
})();
