/* PQX engine host — the message protocol of the engine process (mirrors crate pq-worker).
 * Control messages are plain objects (MessagePack in the Rust build); pages of rows are sent on demand
 * (Arrow IPC slices in the Rust build). The UI never receives whole tables. */
(function () {
  const PQ = self.PQ;
  const E = PQ.Engine;
  const Host = (PQ.Host = {});

  const results = new Map(); // resultId → Table (LRU)
  function keep(t) {
    const id = PQ.uid('res');
    results.set(id, t);
    while (results.size > 12) results.delete(results.keys().next().value);
    return id;
  }
  function need(id) {
    const t = results.get(id);
    if (!t) throw new Error('Result expired — re-run the query');
    return t;
  }

  /** Effective project with an uncommitted draft step applied (live preview while a dialog is open). */
  function withDraft(project, draft) {
    if (!draft) return project;
    const p = JSON.parse(JSON.stringify(project));
    const q = p.queries.find((x) => x.id === draft.qid);
    if (!q) return p;
    const step = { id: draft.stepId || '__draft', name: 'Draft', kind: draft.kind };
    if (draft.insertAt !== undefined) q.steps.splice(draft.insertAt, 0, step);
    else if (draft.index !== undefined) q.steps[draft.index] = Object.assign({}, q.steps[draft.index], { kind: draft.kind });
    return p;
  }

  /* ---------------- smart suggestions (messy-file assistance) ---------------- */
  const derived = new Map();
  function derivedFor(fp) {
    if (!fp) return {};
    let d = derived.get(fp);
    if (!d) { d = {}; derived.set(fp, d); while (derived.size > 32) derived.delete(derived.keys().next().value); }
    return d;
  }
  Host.derivedFor = derivedFor;
  function suggestions(t, q, upto) {
    const out = [];
    if (!t || !t.n) return out;
    if (t.n > 20000) t = t.slice(0, 20000);
    const names = t.names;
    const steps = q.steps.slice(0, upto + 1);
    const hasStep = (type) => steps.some((s) => s.kind.type === type);
    // 1. generic column names → header row
    if (names.every((n) => /^Column\d+$/.test(n)) && t.n > 1) {
      const grid = [];
      for (let r = 0; r < Math.min(15, t.n); r++) grid.push(t.row(r).map((v) => (PQ.isErr(v) ? null : v)));
      const h = PQ.IO.detectHeader(grid);
      out.push({ id: 'headers', icon: 'fa-heading', text: 'Headers: row ' + (h.row + 1), detail: h.reasons.join(' · '), kind: { type: 'PromoteHeaders', row: h.row } });
    }
    // 2. blank rows
    let blank = 0;
    for (let r = 0; r < t.n; r++) if (t.data.every((c) => PQ.isEmpty(c[r]))) blank++;
    if (blank) out.push({ id: 'blank', icon: 'fa-eraser', text: 'Blank rows · ' + PQ.fmtInt(blank), kind: { type: 'KeepRows', mode: 'remove_blank' } });
    // 3. types: text columns that parse cleanly as something better
    if (!names.every((n) => /^Column\d+$/.test(n))) {
      const changes = [];
      t.cols.forEach((c, i) => {
        if (c.type !== 'text' && c.type !== 'any') return;
        const inf = PQ.inferType(t.data[i], q.__locale);
        if (inf !== 'text' && inf !== 'any' && inf !== c.type) changes.push({ col: c.name, type: inf });
      });
      if (changes.length) out.push({ id: 'types', icon: 'fa-shapes', text: 'Types · ' + changes.length, detail: changes.slice(0, 4).map((c) => c.col + ' → ' + PQ.TYPES[c.type].label).join(', ') + (changes.length > 4 ? ' …' : ''), kind: { type: 'ChangeType', changes, onError: 'error' } });
    }
    // 4. fill down: a column whose values are sparse "group labels" (merged-cell / report-style pattern)
    if (!hasStep('FillDown')) t.cols.forEach((c, i) => {
      if (i > 2) return;
      const col = t.data[i];
      let nulls = 0, runs = 0;
      for (let r = 0; r < t.n; r++) { if (col[r] === null) nulls++; else if (r > 0 && col[r - 1] === null) runs++; }
      if (nulls > t.n * 0.4 && runs >= 2 && col[0] !== null && c.type !== 'number') out.push({ id: 'fill_' + c.name, icon: 'fa-angles-down', text: 'Fill down ' + c.name, detail: PQ.fmtInt(nulls) + ' empty', kind: { type: 'FillDown', cols: [c.name] } });
    });
    // 5. stray whitespace / inconsistent casing in text columns
    const trim = [];
    t.cols.forEach((c, i) => {
      if (c.type !== 'text') return;
      const col = t.data[i];
      let ws = 0; const lower = new Map();
      for (let r = 0; r < Math.min(t.n, 5000); r++) { const v = col[r]; if (typeof v === 'string') { if (v !== v.trim()) ws++; const k = v.trim().toLowerCase(); if (!lower.has(k)) lower.set(k, new Set()); lower.get(k).add(v); } }
      const variants = [...lower.values()].filter((s) => s.size > 1).length;
      if (ws || (variants && lower.size < 50)) trim.push(c.name);
    });
    if (trim.length && !hasStep('TextTransform')) out.push({ id: 'trim', icon: 'fa-broom', text: 'Trim · ' + trim.length, detail: trim.slice(0, 5).join(', '), kind: { type: 'TextTransform', op: 'trim', cols: trim } });
    // 6. subtotal-like rows
    const sub = [];
    t.cols.forEach((c, i) => {
      if (c.type !== 'text' && c.type !== 'any') return;
      let n = 0; for (let r = 0; r < t.n; r++) { const v = t.data[i][r]; if (typeof v === 'string' && /^(sub)?total\b|^grand total/i.test(v.trim())) n++; }
      if (n) sub.push({ col: c.name, n });
    });
    if (sub.length) out.push({ id: 'subtotal', icon: 'fa-filter-circle-xmark', text: 'Subtotals · ' + sub[0].n, detail: sub[0].col, kind: { type: 'Filter', mode: 'advanced', formula: 'not Text.StartsWith(Text.Lower(Text.Trim(Coalesce(Text.From(' + PQ.Formula.quoteCol(sub[0].col) + '), ""))), "subtotal") and not Text.StartsWith(Text.Lower(Text.Trim(Coalesce(Text.From(' + PQ.Formula.quoteCol(sub[0].col) + '), ""))), "total")' } });
    // 7. error cells
    let errCols = [];
    t.data.forEach((c, i) => { for (let r = 0; r < t.n; r++) if (PQ.isErr(c[r])) { errCols.push(names[i]); break; } });
    if (errCols.length) out.push({ id: 'errors', icon: 'fa-triangle-exclamation', tone: 'warn', text: 'Errors · ' + errCols.length, kind: { type: 'KeepErrors', cols: errCols } });
    return out.slice(0, 5);
  }

  /* ---------------- handlers ---------------- */
  const H = {};

  H.init = async function () {
    await PQ.loadFiles();
    return { files: listFiles() };
  };
  function listFiles() { return [...PQ.Files.values()].map((f) => ({ id: f.id, name: f.name, size: f.size, mtime: f.mtime, folder: f.folder || '', path: f.path || null, kind: PQ.IO.fileKind(f.name) })); }
  H.listFiles = () => ({ files: listFiles() });

  H.addFile = async function (m) {
    const extra = { folder: m.folder || '', path: m.path || null };
    if (m.mtime) extra.mtime = m.mtime;
    if (m.replaceId && PQ.Files.has(m.replaceId)) extra.id = m.replaceId;
    const rec = await PQ.addFile(m.name, m.buf, extra);
    if (extra.id) E.clearCache();
    return { file: { id: rec.id, name: rec.name, size: rec.size, mtime: rec.mtime, folder: rec.folder, kind: PQ.IO.fileKind(rec.name) } };
  };
  H.updateFile = async function (m) {
    const rec = PQ.Files.get(m.id);
    if (!rec) throw new Error('File not found');
    const next = Object.assign({}, rec, { buf: m.buf, size: m.buf.byteLength, mtime: m.mtime || Date.now() });
    PQ.Files.set(rec.id, next);
    try { await PQ.IDB.put(next); } catch (e) { }
    E.clearCache();
    results.clear();
    return { file: { id: next.id, name: next.name, size: next.size, mtime: next.mtime, folder: next.folder || '', kind: PQ.IO.fileKind(next.name) } };
  };
  H.storageInfo = function () {
    let bytes = 0;
    PQ.Files.forEach((f) => { bytes += f.size || 0; });
    return { files: PQ.Files.size, bytes };
  };
  H.removeFile = async function (m) { PQ.Files.delete(m.id); await PQ.IDB.del(m.id); E.clearCache(); return { files: listFiles() }; };
  H.loadSamples = async function () {
    const existing = new Set([...PQ.Files.values()].map((f) => f.name));
    for (const s of PQ.IO.makeSamples()) {
      if (existing.has(s.name)) continue;
      const buf = s.buf ? s.buf : new TextEncoder().encode(s.text).buffer;
      await PQ.addFile(s.name, buf instanceof ArrayBuffer ? buf : new Uint8Array(buf).buffer, { folder: s.folder || '' });
    }
    return { files: listFiles() };
  };

  H.setProject = function (m) { E.setProject(m.project); return { ok: true }; };
  H.clearCache = function () { E.clearCache(); results.clear(); derived.clear(); return { ok: true }; };

  H.evaluate = function (m, progress) {
    const base = E.getProject();
    const proj = withDraft(base, m.draft);
    E.setProject(proj);
    try {
      const q = E.query(m.qid);
      if (!q) throw new Error('Query not found');
      q.__locale = proj.settings.locale;
      const t0 = performance.now();
      const r = E.evaluate(m.qid, m.upto, m.mode || 'preview', [], (p) => progress(Object.assign({ elapsed: performance.now() - t0 }, p)));
      const out = { states: r.states, truncated: r.truncated, ms: performance.now() - t0, failedAt: r.failedAt };
      if (r.table) {
        const d = m.draft ? {} : derivedFor(r.fp);
        out.resultId = keep(r.table);
        out.n = r.table.n;
        out.schema = r.table.schema();
        out.quality = d.quality || (d.quality = E.quality(r.table));
        out.firstPage = E.page(r.table, 0, 200);
        out.suggestions = m.suggest === false ? [] : d.suggestions || (d.suggestions = suggestions(r.table, q, m.upto === undefined || m.upto === null ? q.steps.length - 1 : m.upto));
      }
      return out;
    } finally { E.setProject(base); }
  };

  /** Schema flowing into each step (for step dialogs: column pickers, formula checking). */
  H.schemaBefore = function (m) {
    if (m.index <= 0) return { schema: [] };
    const r = E.evaluate(m.qid, m.index - 1, 'preview');
    if (!r.table) return { schema: [], error: 'An earlier step has an error' };
    return { schema: r.table.schema(), resultId: keep(r.table), n: r.table.n };
  };

  H.page = (m) => ({ rows: E.page(need(m.resultId), m.offset, m.count) });
  H.profile = (m) => ({ profile: E.profile(need(m.resultId), m.col) });
  H.distinct = (m) => ({ values: E.distinctValues(need(m.resultId), m.col, 1000) });
  H.inspectFile = (m) => {
    const rec = PQ.Files.get(m.fileId);
    if (!rec) throw new Error('File not found');
    return { info: PQ.IO.inspectFile(rec) };
  };

  /** Build the initial steps for a new source: Source → PromoteHeaders(detected) → ChangeType(inferred). */
  H.suggestSteps = function (m) {
    const src = m.source;
    const loc = (E.getProject() && E.getProject().settings.locale) || 'en-US';
    let t;
    if (src.kind === 'folder') {
      const tmp = { settings: { previewRows: 1000, locale: loc }, params: [], queries: [{ id: 'tmp', name: 'tmp', steps: [{ id: 's', name: 'Source', kind: { type: 'Source', source: src } }] }] };
      const base = E.getProject(); E.setProject(tmp);
      try { const r = E.evaluate('tmp', 0, 'preview'); if (!r.table) throw new Error(r.states[0].error); t = r.table; } finally { E.setProject(base); }
    } else {
      const rec = PQ.Files.get(src.fileId);
      t = PQ.IO.readFile(rec, src, 2000);
    }
    const steps = [];
    let names = t.names;
    let data = t.data;
    if (m.headerRow !== null && m.headerRow !== undefined && m.headerRow >= 0) {
      steps.push({ type: 'PromoteHeaders', row: m.headerRow });
      t = E.X.PromoteHeaders(t, { row: m.headerRow });
      names = t.names; data = t.data;
    }
    const csvLoc = src.csvLocale || loc;
    const changes = [];
    t.cols.forEach((c, i) => {
      const inf = PQ.inferType(data[i], csvLoc);
      if (inf !== 'any' && inf !== c.type && !(c.type === 'int' && inf === 'number' && false)) changes.push({ col: c.name, type: inf });
    });
    if (changes.length) steps.push({ type: 'ChangeType', changes, onError: 'error', locale: csvLoc !== loc ? csvLoc : undefined });
    return { steps, columns: names };
  };

  H.mergeStats = function (m) {
    const base = E.getProject();
    const leftRes = E.evaluate(m.qid, m.upto, 'preview');
    if (!leftRes.table) return { error: 'The current query has an error' };
    const rq = E.query(m.right);
    if (!rq) return { error: 'Choose a query to merge with' };
    const rightRes = E.evaluate(rq.id, undefined, 'preview', [m.qid]);
    if (!rightRes.table) return { error: 'Query "' + rq.name + '" has an error' };
    E.setProject(base);
    return { stats: E.mergeStats(leftRes.table, rightRes.table, m.on || [], m.how || 'left', m.castKeys), leftSchema: leftRes.table.schema(), rightSchema: rightRes.table.schema(), sample: m.on && m.on.length ? null : null };
  };
  H.querySchema = function (m) {
    const r = E.evaluate(m.qid, undefined, 'preview');
    return { schema: r.table ? r.table.schema() : [], error: r.table ? null : 'Query has an error' };
  };

  function runFull(qid) {
    const r = E.evaluate(qid, undefined, 'full');
    if (!r.table) { const i = r.failedAt; throw new Error('Step ' + (i + 1) + ' failed: ' + r.states[i].error); }
    return r.table;
  }
  H.exportQuery = function (m, progress) {
    const q = E.query(m.qid);
    const t0 = performance.now();
    progress({ stage: 'Running ' + q.name + ' on full data', elapsed: 0 });
    const t = runFull(m.qid);
    progress({ stage: 'Writing ' + m.format.toUpperCase(), elapsed: performance.now() - t0 });
    if (m.format === 'csv') return { data: PQ.IO.toCSV(t), rows: t.n, mime: 'text/csv' };
    if (m.format === 'tsv') return { data: PQ.IO.toTSV(t, m.limit), rows: t.n, mime: 'text/plain' };
    if (m.format === 'xlsx') return { data: PQ.IO.toXLSX(t, q.name), rows: t.n, mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
    throw new Error('Unknown format ' + m.format);
  };
  H.refreshAll = function (m, progress) {
    const p = E.getProject();
    const { order } = PQ.Steps.topo(p);
    const outputs = [];
    const t0 = performance.now();
    for (const id of order) {
      const q = E.query(id);
      if (!q.load || !q.load.target || q.load.target === 'none') continue;
      progress({ stage: 'Refreshing ' + q.name, elapsed: performance.now() - t0 });
      try {
        const t = runFull(id);
        const fmt = q.load.target;
        outputs.push({ name: PQ.snake(q.name) + '.' + fmt, rows: t.n, data: fmt === 'xlsx' ? PQ.IO.toXLSX(t, q.name) : PQ.IO.toCSV(t), mime: fmt === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv' });
      } catch (e) { outputs.push({ name: q.name, error: e.message }); }
    }
    return { outputs, ms: performance.now() - t0 };
  };

  /** Dispatch one message. post(type, payload) sends progress; returns a promise of the reply payload. */
  Host.handle = async function (msg, progress) {
    const h = H[msg.op];
    if (!h) throw new Error('Unknown engine op ' + msg.op);
    return h(msg, progress || (() => {}));
  };
})();
