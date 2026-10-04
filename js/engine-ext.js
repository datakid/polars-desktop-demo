(function () {
  const PQ = self.PQ, E = PQ.Engine, IO = PQ.IO, S = PQ.Steps;
  const { Table, isErr, StepError } = PQ;
  const X = E.X;

  const stripMarks = (s) => String(s).normalize('NFD').replace(/\p{M}+/gu, '');
  PQ.stripMarks = stripMarks;
  PQ.fingerprint = function (v) {
    const s = stripMarks(v).toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, ' ').trim();
    if (!s) return '';
    return [...new Set(s.split(/\s+/))].sort().join(' ');
  };
  PQ.ngramFingerprint = function (v, n) {
    n = n || 2;
    const s = stripMarks(v).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
    if (s.length < n) return s;
    const g = new Set();
    for (let i = 0; i + n <= s.length; i++) g.add(s.slice(i, i + n));
    return [...g].sort().join('');
  };
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  const nullish = (v) => v === null || v === undefined || isErr(v);

  const baseKind = IO.fileKind;
  IO.fileKind = function (name) {
    const ext = String(name).toLowerCase().split('.').pop();
    if (ext === 'parquet' || ext === 'pq') return 'parquet';
    if (ext === 'arrow' || ext === 'feather' || ext === 'ipc' || ext === 'arrows') return 'arrow';
    return baseKind(name);
  };

  const decoded = new Map();
  const dkey = (rec) => rec.id + ':' + rec.mtime + ':' + rec.size;
  function remember(k, t) {
    decoded.delete(k);
    decoded.set(k, t);
    while (decoded.size > 6) decoded.delete(decoded.keys().next().value);
    return t;
  }
  let hpw = null;
  function arrowLib() {
    if (!self.Arrow && typeof importScripts === 'function') importScripts('../vendor/arrow.es2015.min.js');
    if (!self.Arrow) throw new StepError('Arrow library failed to load');
    return self.Arrow;
  }

  function norm(v) {
    if (v === undefined || v === null) return null;
    if (typeof v === 'bigint') return Number(v);
    if (v instanceof Date) return isNaN(v) ? null : v;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'string' || typeof v === 'boolean') return v;
    if (v instanceof Uint8Array) return Array.from(v, (b) => b.toString(16).padStart(2, '0')).join('');
    try { return JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? Number(x) : x)); } catch (e) { return String(v); }
  }
  function normColumn(c, n) {
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const v = c[i], t = typeof v;
      out[i] = t === 'string' || t === 'boolean' ? v : t === 'number' ? (v - v === 0 ? v : null) : norm(v);
    }
    return out;
  }
  function fromColumns(names, cols, n) {
    const data = cols.map((c) => normColumn(c, n));
    return new Table(PQ.uniquify(names).map((nm, i) => ({ name: nm, type: PQ.valuesType(data[i]) })), data, n);
  }

  IO.decodeArrow = function (rec) {
    const k = dkey(rec);
    if (decoded.has(k)) return decoded.get(k);
    const A = arrowLib();
    if (!rec.buf) throw new StepError('Arrow file "' + rec.name + '" has no data. Re-add it.');
    const at = A.tableFromIPC(new Uint8Array(rec.buf));
    const n = at.numRows;
    const fields = at.schema.fields;
    const cols = fields.map((f, i) => {
      const vec = at.getChildAt(i);
      const tid = f.type.typeId;
      const isDate = tid === A.Type.Date || tid === A.Type.Timestamp;
      const out = new Array(n);
      for (let r = 0; r < n; r++) {
        let v = vec ? vec.get(r) : null;
        if (v !== null && v !== undefined && isDate && !(v instanceof Date)) v = new Date(Number(v));
        out[r] = v;
      }
      return out;
    });
    const t = fromColumns(fields.map((f) => f.name), cols, n);
    t.meta = { format: 'arrow' };
    return remember(k, t);
  };
  IO.prepare = async function () {};
  const columnar = (rec) => IO.decodeArrow(rec);
  const baseRead = IO.readFile;
  IO.readFile = function (rec, spec, maxRows) {
    const kind = (spec && spec.format) || IO.fileKind(rec.name);
    if (kind !== 'arrow') return baseRead(rec, spec || {}, maxRows);
    const t = columnar(rec);
    if (maxRows !== undefined && maxRows !== Infinity && t.n > maxRows) { const s = t.slice(0, maxRows); s.meta = Object.assign({}, t.meta, { truncated: true }); return s; }
    return t;
  };
  const baseInspect = IO.inspectFile;
  IO.inspectFile = function (rec) {
    const kind = IO.fileKind(rec.name);
    if (kind !== 'arrow') return baseInspect(rec);
    const t = columnar(rec);
    return { kind, rows: t.n, cols: t.cols.length, schema: t.schema(), meta: t.meta, preview: [t.names].concat(t.toRows(39).map((r) => r.map((v) => (isErr(v) ? '#ERR' : PQ.fmtValue(v))))) };
  };

  const clean = (v) => (v === undefined || isErr(v) ? null : v);
  IO.toParquet = async function (t) {
    if (!hpw) hpw = self.__floeModules ? self.__floeModules.writer : await import('../vendor/hyparquet-writer.min.js');
    const columnData = t.cols.map((c, i) => {
      const src = t.data[i];
      let type, data;
      if (c.type === 'int' && src.every((v) => nullish(v) || (typeof v === 'number' && Number.isSafeInteger(v)))) { type = 'INT64'; data = src.map((v) => (typeof v === 'number' ? BigInt(v) : null)); }
      else if (c.type === 'int' || c.type === 'number') { type = 'DOUBLE'; data = src.map((v) => (typeof v === 'number' ? v : null)); }
      else if (c.type === 'bool') { type = 'BOOLEAN'; data = src.map((v) => (typeof v === 'boolean' ? v : null)); }
      else if (c.type === 'date' || c.type === 'datetime') { type = 'TIMESTAMP'; data = src.map((v) => (v instanceof Date ? v : null)); }
      else { type = 'STRING'; data = src.map((v) => { v = clean(v); return v === null ? null : String(PQ.fmtValue(v)); }); }
      return { name: c.name, data, type };
    });
    return hpw.parquetWriteBuffer({ columnData });
  };
  IO.toArrow = function (t) {
    const A = arrowLib();
    const vecs = {};
    t.cols.forEach((c, i) => {
      const src = t.data[i];
      let type, vals;
      if (c.type === 'int' || c.type === 'number') {
        const i32 = c.type === 'int' && src.every((v) => nullish(v) || (Number.isInteger(v) && Math.abs(v) < 2147483647));
        type = i32 ? new A.Int32() : new A.Float64();
        vals = src.map((v) => (typeof v === 'number' ? v : null));
      } else if (c.type === 'bool') { type = new A.Bool(); vals = src.map((v) => (typeof v === 'boolean' ? v : null)); }
      else if (c.type === 'date' || c.type === 'datetime') { type = new A.TimestampMillisecond(); vals = src.map((v) => (v instanceof Date ? v.getTime() : null)); }
      else { type = new A.Utf8(); vals = src.map((v) => { v = clean(v); return v === null ? null : String(PQ.fmtValue(v)); }); }
      vecs[c.name] = A.vectorFromArray(vals, type);
    });
    const u8 = A.tableToIPC(new A.Table(vecs), 'file');
    return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
  };
  IO.writeAs = async function (t, fmt, name) {
    if (fmt === 'xlsx') return { data: IO.toXLSX(t, name), mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx' };
    if (fmt === 'parquet') return { data: await IO.toParquet(t), mime: 'application/vnd.apache.parquet', ext: 'parquet' };
    if (fmt === 'arrow') return { data: IO.toArrow(t), mime: 'application/vnd.apache.arrow.file', ext: 'arrow' };
    if (fmt === 'tsv') return { data: IO.toTSV(t), mime: 'text/plain', ext: 'tsv' };
    return { data: IO.toCSV(t), mime: 'text/csv', ext: 'csv' };
  };

  function sortKey(arr, n) {
    const rank = new Float64Array(n), nul = new Uint8Array(n);
    let kind = null, anyNull = false;
    for (let i = 0; i < n; i++) {
      const v = arr[i];
      if (nullish(v)) { anyNull = true; continue; }
      const k = typeof v === 'number' ? 'n' : typeof v === 'string' ? 's' : v instanceof Date ? 'd' : typeof v === 'boolean' ? 'b' : 'x';
      if (kind === null) kind = k; else if (kind !== k) { kind = 'x'; break; }
    }
    if (kind === 's' || kind === 'x') {
      const uniq = new Map();
      for (let i = 0; i < n; i++) { const v = arr[i]; if (nullish(v)) continue; const k = kind === 's' ? v : E.keyOf(v); if (!uniq.has(k)) uniq.set(k, v); }
      const vals = [...uniq.entries()];
      vals.sort(kind === 's' ? (a, b) => collator.compare(a[0], b[0]) : (a, b) => E.compareValues(a[1], b[1], true));
      const rk = new Map();
      let r = 0;
      for (let i = 0; i < vals.length; i++) {
        if (i && (kind === 's' ? collator.compare(vals[i - 1][0], vals[i][0]) : E.compareValues(vals[i - 1][1], vals[i][1], true)) !== 0) r++;
        rk.set(vals[i][0], r);
      }
      for (let i = 0; i < n; i++) { const v = arr[i]; if (nullish(v)) nul[i] = 1; else rank[i] = rk.get(kind === 's' ? v : E.keyOf(v)); }
    } else {
      for (let i = 0; i < n; i++) {
        const v = arr[i];
        if (nullish(v)) { nul[i] = 1; continue; }
        rank[i] = kind === 'n' ? v : kind === 'd' ? v.getTime() : +v;
      }
    }
    return { rank, nul, anyNull };
  }
  X.Sort = function (t, s) {
    const n = t.n;
    const keys = (s.by || []).map((b) => Object.assign(sortKey(t.get(b.col), n), { desc: !!b.desc, nullsLast: b.nullsLast !== false }));
    if (!keys.length || n < 2) return t;
    const ix = new Int32Array(n);
    for (let i = 0; i < n; i++) ix[i] = i;
    if (keys.length === 1 && !keys[0].anyNull) {
      const r = keys[0].rank, d = keys[0].desc ? -1 : 1;
      ix.sort((a, b) => (r[a] - r[b]) * d || a - b);
      return t.take(ix);
    }
    const K = keys.length;
    ix.sort((a, b) => {
      for (let j = 0; j < K; j++) {
        const k = keys[j];
        const an = k.nul[a], bn = k.nul[b];
        if (an || bn) { if (an && bn) continue; return an ? (k.nullsLast ? 1 : -1) : k.nullsLast ? -1 : 1; }
        const c = k.rank[a] - k.rank[b];
        if (c) return k.desc ? -c : c;
      }
      return a - b;
    });
    return t.take(ix);
  };

  function rng(seed) {
    let s = (seed >>> 0) || 0x9e3779b9;
    return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  }
  X.Sample = function (t, s) {
    const n = t.n;
    let k = s.mode === 'percent' ? Math.round((n * Math.max(0, Math.min(100, +s.percent || 0))) / 100) : Math.max(0, Math.floor(+s.n || 0));
    k = Math.min(k, n);
    if (k >= n) return t;
    const r = rng(s.seed === undefined || s.seed === '' ? 42 : +s.seed);
    const ix = new Int32Array(n);
    for (let i = 0; i < n; i++) ix[i] = i;
    for (let i = 0; i < k; i++) { const j = i + Math.floor(r() * (n - i)); const tmp = ix[i]; ix[i] = ix[j]; ix[j] = tmp; }
    return t.take(Array.from(ix.subarray(0, k)).sort((a, b) => a - b));
  };

  E.clusters = function (t, col, method) {
    const arr = t.get(col);
    const counts = new Map();
    for (const v of arr) {
      if (typeof v !== 'string') continue;
      counts.set(v, (counts.get(v) || 0) + 1);
      if (counts.size > 50000) break;
    }
    const key = method === 'ngram' ? PQ.ngramFingerprint : PQ.fingerprint;
    const groups = new Map();
    for (const [v, n] of counts) {
      const k = key(v);
      if (!k) continue;
      let g = groups.get(k);
      if (!g) groups.set(k, (g = []));
      g.push({ value: v, count: n });
    }
    const out = [];
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      g.sort((a, b) => b.count - a.count || (a.value === a.value.trim() ? -1 : 1) || a.value.localeCompare(b.value));
      out.push({ canonical: g[0].value.trim(), values: g, rows: g.reduce((s2, x) => s2 + x.count, 0) });
    }
    return out.sort((a, b) => b.rows - a.rows).slice(0, 500);
  };
  E.clusterPairs = (clusters) => {
    const pairs = [];
    clusters.forEach((c) => c.values.forEach((v) => { if (v.value !== c.canonical) pairs.push([v.value, c.canonical]); }));
    return pairs;
  };
  X.ClusterValues = function (t, s) {
    if (!s.col) throw new StepError('Choose a column to cluster');
    const arr = t.get(s.col);
    const map = new Map(s.auto ? E.clusterPairs(E.clusters(t, s.col, s.method)) : s.pairs || []);
    if (!map.size) return t;
    const out = new Array(arr.length);
    for (let i = 0; i < arr.length; i++) { const v = arr[i]; out[i] = typeof v === 'string' && map.has(v) ? map.get(v) : v; }
    return t.withColumn(s.col, t.type(s.col), out);
  };

  const CHECKS = {
    not_null: { label: (r) => '`' + r.col + '` is empty' },
    unique: { label: (r) => '`' + r.col + '` is duplicated' },
    regex: { label: (r) => '`' + r.col + '` does not match ' + r.arg },
    range: { label: (r) => '`' + r.col + '` outside ' + (r.arg === '' || r.arg === undefined ? '−∞' : r.arg) + '…' + (r.arg2 === '' || r.arg2 === undefined ? '∞' : r.arg2) },
    in: { label: (r) => '`' + r.col + '` not in allowed list' },
    length: { label: (r) => '`' + r.col + '` length outside ' + (r.arg || 0) + '–' + (r.arg2 || '∞') },
    type: { label: (r) => '`' + r.col + '` has a conversion error' },
  };
  E.CHECKS = CHECKS;
  const bound = (x, type) => {
    if (x === '' || x === undefined || x === null) return null;
    if (type === 'date' || type === 'datetime') { const d = PQ.parseDate(x); return d ? d.getTime() : null; }
    const n = PQ.parseNumber(x);
    return n === null ? null : n;
  };
  function ruleTester(t, r) {
    const arr = t.get(r.col), type = t.type(r.col);
    switch (r.check) {
      case 'not_null': return (i) => { const v = arr[i]; return !(v === null || v === undefined || v === '' || isErr(v)); };
      case 'unique': {
        const seen = new Map();
        for (let i = 0; i < arr.length; i++) { const v = arr[i]; if (nullish(v)) continue; const k = E.keyOf(v); seen.set(k, (seen.get(k) || 0) + 1); }
        return (i) => nullish(arr[i]) || seen.get(E.keyOf(arr[i])) === 1;
      }
      case 'regex': {
        let re;
        try { re = new RegExp(r.arg || '', 'u'); } catch (e) { throw new StepError('Invalid regular expression ' + r.arg + ': ' + e.message); }
        return (i) => { const v = arr[i]; return v === null || v === undefined || (!isErr(v) && re.test(String(PQ.fmtValue(v)))); };
      }
      case 'range': {
        const lo = bound(r.arg, type), hi = bound(r.arg2, type);
        return (i) => {
          let v = arr[i];
          if (v === null || v === undefined) return true;
          if (isErr(v)) return false;
          v = v instanceof Date ? v.getTime() : typeof v === 'number' ? v : PQ.parseNumber(v);
          if (v === null) return false;
          return (lo === null || v >= lo) && (hi === null || v <= hi);
        };
      }
      case 'in': {
        const set = new Set(String(r.arg || '').split(',').map((x) => x.trim()).filter((x) => x !== ''));
        return (i) => { const v = arr[i]; return v === null || v === undefined || (!isErr(v) && set.has(String(PQ.fmtValue(v)))); };
      }
      case 'length': {
        const lo = r.arg === '' || r.arg === undefined ? 0 : +r.arg, hi = r.arg2 === '' || r.arg2 === undefined ? Infinity : +r.arg2;
        return (i) => { const v = arr[i]; if (v === null || v === undefined) return true; if (isErr(v)) return false; const L = String(PQ.fmtValue(v)).length; return L >= lo && L <= hi; };
      }
      case 'type': return (i) => !isErr(arr[i]);
    }
    throw new StepError('Unknown check ' + r.check);
  }
  X.Validate = function (t, s) {
    const rules = (s.rules || []).filter((r) => r.col);
    if (!rules.length) throw new StepError('Add at least one rule');
    t.need(rules.map((r) => r.col));
    const testers = rules.map((r) => ({ r, ok: ruleTester(t, r), label: r.label || CHECKS[r.check].label(r) }));
    const issues = new Array(t.n);
    let bad = 0, first = -1;
    for (let i = 0; i < t.n; i++) {
      let msg = null;
      for (const x of testers) if (!x.ok(i)) msg = msg ? msg + '; ' + x.label.replace(/`/g, '') : x.label.replace(/`/g, '');
      issues[i] = msg;
      if (msg) { bad++; if (first < 0) first = i; }
    }
    const action = s.action || 'flag';
    if (action === 'fail' && bad) throw new StepError(PQ.fmtInt(bad) + ' row' + (bad > 1 ? 's' : '') + ' fail validation. Row ' + (first + 1) + ': ' + issues[first], { fixes: [{ kind: 'set', field: 'action', value: 'flag', label: 'Flag rows instead' }, { kind: 'set', field: 'action', value: 'keep_valid', label: 'Drop invalid rows' }] });
    if (action === 'keep_valid') { const ix = []; for (let i = 0; i < t.n; i++) if (!issues[i]) ix.push(i); return t.take(ix); }
    if (action === 'keep_invalid') { const ix = []; for (let i = 0; i < t.n; i++) if (issues[i]) ix.push(i); return t.take(ix).withColumn(PQ.uniqueName(s.name || 'Issues', t.names), 'text', ix.map((i) => issues[i])); }
    if (action === 'fail') return t;
    return t.withColumn(t.has(s.name || 'Issues') ? s.name || 'Issues' : PQ.uniqueName(s.name || 'Issues', t.names), 'text', issues);
  };

  E.overview = function (t) {
    let errCells = 0, emptyCells = 0, wsCells = 0;
    const columns = t.cols.map((c, i) => {
      const a = t.data[i];
      let err = 0, empty = 0, ws = 0, min = null, max = null;
      const seen = new Map();
      let capped = false;
      for (let r = 0; r < a.length; r++) {
        const v = a[r];
        if (v === null || v === undefined || v === '') { empty++; continue; }
        if (isErr(v)) { err++; continue; }
        if (typeof v === 'string' && v !== v.trim()) ws++;
        if (!capped) { const k = E.keyOf(v); const e = seen.get(k); if (e) e.n++; else { seen.set(k, { v, n: 1 }); if (seen.size > 100000) capped = true; } }
        if (typeof v === 'string') { if (min === null || collator.compare(v, min) < 0) min = v; if (max === null || collator.compare(v, max) > 0) max = v; }
        else { if (min === null || E.compareValues(v, min) < 0) min = v; if (max === null || E.compareValues(v, max) > 0) max = v; }
      }
      let top = null;
      let unique = 0;
      for (const e of seen.values()) { if (!top || e.n > top.n) top = e; if (e.n === 1) unique++; }
      errCells += err; emptyCells += empty; wsCells += ws;
      return { name: c.name, type: c.type, valid: t.n - err - empty, error: err, empty, whitespace: ws, distinct: seen.size, distinctCapped: capped, unique, min: E.wire(min), max: E.wire(max), top: top ? E.wire(top.v) : null, topCount: top ? top.n : 0 };
    });
    let dup = 0;
    if (t.n && t.n <= 500000) {
      const seen = new Set();
      for (let r = 0; r < t.n; r++) { let k = ''; for (const col of t.data) k += E.keyOf(col[r]) + '\u001f'; if (seen.has(k)) dup++; else seen.add(k); }
    }
    const cells = t.n * t.cols.length;
    const score = cells ? Math.max(0, Math.min(100, Math.round(100 * (1 - (errCells + 0.5 * emptyCells + 0.25 * wsCells) / cells - (t.n ? (0.5 * dup) / t.n : 0))))) : 100;
    return { rows: t.n, cols: t.cols.length, errors: errCells, empty: emptyCells, whitespace: wsCells, duplicateRows: dup, score, columns };
  };

  const F = PQ.FUNCS;
  const reCache = new Map();
  const re = (p, flags) => {
    const k = flags + '/' + p;
    let r = reCache.get(k);
    if (!r) { r = new RegExp(p, flags); if (reCache.size > 200) reCache.clear(); reCache.set(k, r); }
    r.lastIndex = 0;
    return r;
  };
  const def = (name, sig, ret, doc, impl, py) => { F[name] = { name, sig, ret, doc, impl, py }; };
  const pyFingerprint = (x) => `${x}.str.to_lowercase().str.normalize("NFD").str.replace_all(r"\\p{M}", "").str.replace_all(r"[^\\p{L}\\p{N}\\s]+", " ").str.replace_all(r"\\s+", " ").str.strip_chars().str.split(" ").list.unique().list.sort().list.join(" ")`;
  S.pyFingerprint = pyFingerprint;
  def('Text.RegexMatch', ['t', 't'], 'bool', 'True if the text matches a regular expression: Text.RegexMatch([Code], "^[A-Z]{2}-\\d+$")', (s, p) => re(p, 'u').test(s), (a) => `${a[0]}.str.contains(${a[1]})`);
  def('Text.RegexExtract', ['t', 't', 'n?'], 'text', 'Part of the text matched by a regular expression; optional capture group number', (s, p, g) => { const m = re(p, 'u').exec(s); if (!m) return null; const v = m[g || 0]; return v === undefined ? null : v; }, (a) => `${a[0]}.str.extract(${a[1]}, ${a[2] || 0})`);
  def('Text.RegexReplace', ['t', 't', 't'], 'text', 'Replaces every regular-expression match; $1 refers to a capture group', (s, p, r) => s.replace(re(p, 'gu'), r), (a) => `${a[0]}.str.replace_all(${a[1]}, ${a[2]})`);
  def('Text.RemoveDiacritics', ['t'], 'text', 'Removes accents: "Chloé" → "Chloe"', (s) => stripMarks(s), (a) => `${a[0]}.str.normalize("NFD").str.replace_all(r"\\p{M}", "")`);
  def('Text.Fingerprint', ['t'], 'text', 'Key for fuzzy matching: lower case, no accents or punctuation, sorted unique words', (s) => PQ.fingerprint(s), (a) => pyFingerprint(a[0]));
  def('Text.Similarity', ['t', 't'], 'number', 'Similarity between two texts from 0 (different) to 1 (identical), based on edit distance', (a, b) => { const m = Math.max(a.length, b.length); return m ? 1 - PQ.levenshtein(a, b) / m : 1; }, (a) => `pl.lit(None)  # Text.Similarity: use the polars-ds plugin (str_leven)`);
  def('Number.Clamp', ['n', 'n', 'n'], 'number', 'Limits a number to a range: Number.Clamp([x], 0, 100)', (x, lo, hi) => Math.min(hi, Math.max(lo, x)), (a) => `${a[0]}.clip(${a[1]}, ${a[2]})`);

  Object.assign(S.CATALOG, {
    Sample: { label: 'Sampled Rows', icon: 'fa-dice', lazy: false, describe: (k) => (k.mode === 'percent' ? (k.percent || 0) + '% of rows' : PQ.fmtInt(+k.n || 0) + ' random rows') + ' · seed ' + (k.seed === undefined || k.seed === '' ? 42 : k.seed) },
    ClusterValues: { label: 'Clustered Values', icon: 'fa-object-ungroup', describe: (k) => '`' + k.col + '` ' + (k.auto ? 'auto-merge similar values (' + (k.method || 'fingerprint') + ')' : (k.pairs || []).length + ' variant' + ((k.pairs || []).length === 1 ? '' : 's') + ' merged') },
    Validate: { label: 'Validated Rows', icon: 'fa-shield-halved', describe: (k) => (k.rules || []).length + ' rule' + ((k.rules || []).length === 1 ? '' : 's') + ' → ' + ({ flag: 'flag in `' + (k.name || 'Issues') + '`', keep_valid: 'keep valid rows', keep_invalid: 'keep invalid rows', fail: 'fail on violation' }[k.action || 'flag']) },
  });

  const P = S.py;
  function okExpr(r) {
    const c = `pl.col(${P.py(r.col)})`;
    const lit = (x) => (x === '' || x === undefined || x === null ? null : isNaN(+x) ? `pl.lit(${P.py(x)}).str.to_date(strict=False)` : String(+x));
    switch (r.check) {
      case 'not_null': return `(${c}.is_not_null() & (${c}.cast(pl.String) != "").fill_null(False))`;
      case 'unique': return `(${c}.is_null() | ~${c}.is_duplicated())`;
      case 'regex': return `(${c}.is_null() | ${c}.cast(pl.String).str.contains(${P.py(r.arg || '')}))`;
      case 'range': { const lo = lit(r.arg), hi = lit(r.arg2); const parts = [lo !== null ? `(${c} >= ${lo})` : null, hi !== null ? `(${c} <= ${hi})` : null].filter(Boolean); return parts.length ? `(${c}.is_null() | (${parts.join(' & ')}))` : 'pl.lit(True)'; }
      case 'in': return `(${c}.is_null() | ${c}.cast(pl.String).is_in(${P.pyList(String(r.arg || '').split(',').map((x) => x.trim()).filter(Boolean))}))`;
      case 'length': return `(${c}.is_null() | ${c}.cast(pl.String).str.len_chars().is_between(${+r.arg || 0}, ${r.arg2 === '' || r.arg2 === undefined ? 2 ** 31 : +r.arg2}))`;
      case 'type': return 'pl.lit(True)';
    }
    return 'pl.lit(True)';
  }
  S.HELPERS['def assert_valid'] = `def assert_valid(lf: pl.LazyFrame, ok: pl.Expr, message: str) -> pl.LazyFrame:
    """Stop the pipeline when any row breaks a validation rule (Floe "Validate" step, action = fail)."""
    bad = lf.filter(~ok).select(pl.len()).collect().item()
    if bad:
        raise ValueError(f"{bad} rows fail validation: {message}")
    return lf`;
  S.EXT_CODE = {
    Sample: (k) => `\n    # Sample needs the whole input; Polars' RNG picks different rows than Floe's preview\n    .pipe(lambda lf: lf.collect().sample(${k.mode === 'percent' ? 'fraction=' + (+k.percent || 0) / 100 : 'n=' + (+k.n || 0)}, seed=${k.seed === undefined || k.seed === '' ? 42 : +k.seed}).lazy())`,
    ClusterValues: (k) => {
      const c = `pl.col(${P.py(k.col)})`;
      if (k.auto && (k.method || 'fingerprint') === 'fingerprint') return `.with_columns(${c}.mode().first().str.strip_chars().over(${pyFingerprint(c)}).alias(${P.py(k.col)}))`;
      const pairs = k.pairs || [];
      if (!pairs.length) return `  # ClusterValues: no variants selected`;
      return `.with_columns(${c}.replace({${pairs.map((p) => P.py(p[0]) + ': ' + P.py(p[1])).join(', ')}}))`;
    },
    Validate: (k, ctx) => {
      const rules = (k.rules || []).filter((r) => r.col);
      if (!rules.length) return '  # Validate: no rules';
      const oks = rules.map(okExpr);
      const all = oks.join(' & ');
      const label = (r) => (r.label || CHECKS[r.check].label(r)).replace(/`/g, '');
      const name = P.py(k.name || 'Issues');
      switch (k.action || 'flag') {
        case 'keep_valid': return `.filter(${all})`;
        case 'keep_invalid': return `.filter(~(${all}))`;
        case 'fail': ctx.helpers.add('def assert_valid'); return `.pipe(assert_valid, ${all}, ${P.py(rules.map(label).join('; '))})`;
      }
      return `.with_columns(\n        pl.concat_str([${rules.map((r, i) => `pl.when(~${oks[i]}).then(pl.lit(${P.py(label(r))}))`).join(', ')}], separator="; ", ignore_nulls=True).alias(${name})\n    ).with_columns(pl.when(pl.col(${name}) == "").then(None).otherwise(pl.col(${name})).alias(${name}))`;
    },
  };

  if (PQ.Host) {
    const base = PQ.Host.handle;
    const tables = new Map();
    const baseEval = E.evaluate;
    E.evaluate = function () {
      const r = baseEval.apply(this, arguments);
      E.lastFp = r && r.table ? r.fp : null;
      if (r && r.table && r.fp) { tables.delete(r.fp); tables.set(r.fp, r.table); while (tables.size > 16) tables.delete(tables.keys().next().value); }
      return r;
    };
    const NEED = new Set(['evaluate', 'inspectFile', 'exportQuery', 'refreshAll', 'suggestSteps', 'schemaBefore', 'mergeStats', 'querySchema', 'clusters']);
    const usedFiles = (msg) => {
      const ids = new Set();
      if (msg.fileId) ids.add(msg.fileId);
      if (msg.source && msg.source.fileId) ids.add(msg.source.fileId);
      const p = E.getProject();
      const folders = new Set();
      if (msg.source && msg.source.kind === 'folder') folders.add(msg.source.folder);
      (p && p.queries || []).forEach((q) => q.steps.forEach((s) => {
        const src = s.kind && s.kind.type === 'Source' ? s.kind.source : null;
        if (!src) return;
        if (src.kind === 'file' && src.fileId) ids.add(src.fileId);
        if (src.kind === 'folder') folders.add(src.folder);
      }));
      if (msg.draft && msg.draft.kind && msg.draft.kind.type === 'Source' && msg.draft.kind.source && msg.draft.kind.source.fileId) ids.add(msg.draft.kind.source.fileId);
      if (folders.size) PQ.Files.forEach((f) => { if (folders.has(f.folder || '')) ids.add(f.id); });
      return ids;
    };
    const runFull = (qid) => {
      const r = E.evaluate(qid, undefined, 'full');
      if (!r.table) { const i = r.failedAt; throw new Error('Step ' + (i + 1) + ' failed: ' + (r.states[i] ? r.states[i].error : 'error')); }
      return r.table;
    };
    const H2 = {
      overview(m) { const t = tables.get(m.fp); if (!t) throw new Error('Result expired — re-run the query'); return { overview: E.overview(t) }; },
      clusters(m) {
        const r = E.evaluate(m.qid, m.upto, m.mode || 'preview');
        if (!r.table) throw new Error('An earlier step has an error');
        if (!r.table.has(m.col)) return { clusters: [], error: 'Column `' + m.col + '` not found' };
        return { clusters: E.clusters(r.table, m.col, m.method) };
      },
      async exportQuery(m, progress) {
        if (m.format !== 'parquet' && m.format !== 'arrow') return null;
        const q = E.query(m.qid);
        const t0 = performance.now();
        progress({ stage: 'Running ' + q.name + ' on full data', elapsed: 0 });
        const t = runFull(m.qid);
        progress({ stage: 'Writing ' + (m.format === 'arrow' ? 'Arrow IPC' : 'Parquet'), elapsed: performance.now() - t0 });
        const w = await IO.writeAs(t, m.format, q.name);
        return { data: w.data, rows: t.n, mime: w.mime };
      },
      async refreshAll(m, progress) {
        const p = E.getProject();
        const { order } = PQ.Steps.topo(p);
        const outputs = [];
        const t0 = performance.now();
        for (const id of order) {
          const q = E.query(id);
          const fmt = q.load && q.load.target;
          if (!fmt || fmt === 'none') continue;
          progress({ stage: 'Refreshing ' + q.name, elapsed: performance.now() - t0 });
          try {
            const t = runFull(id);
            const w = await IO.writeAs(t, fmt, q.name);
            outputs.push({ name: PQ.snake(q.name) + '.' + w.ext, rows: t.n, data: w.data, mime: w.mime });
          } catch (e) { outputs.push({ name: q.name, error: e.message }); }
        }
        return { outputs, ms: performance.now() - t0 };
      },
    };
    function clusterSuggestion(out, msg) {
      const d = !msg.draft && out.fp ? PQ.Host.derivedFor(out.fp) : {};
      if (d.cluster !== undefined) { if (d.cluster) out.suggestions = (out.suggestions || []).slice(0, 4).concat([d.cluster]); return; }
      d.cluster = null;
      let t = out.fp && tables.get(out.fp);
      const q = E.query(msg.qid);
      if (!t || !q || t.n < 2) return;
      if (t.n > 20000) t = t.slice(0, 20000);
      const upto = msg.upto === undefined || msg.upto === null ? q.steps.length - 1 : msg.upto;
      const done = new Set(q.steps.slice(0, upto + 1).filter((s) => s.kind.type === 'ClusterValues').map((s) => s.kind.col));
      let best = null;
      t.cols.slice(0, 16).forEach((c) => {
        if (c.type !== 'text' || done.has(c.name) || /^Column\d+$/.test(c.name)) return;
        const cl = E.clusters(t, c.name, 'fingerprint');
        if (!cl.length) return;
        const rows = cl.reduce((s2, x) => s2 + x.rows - x.values[0].count, 0);
        if (!best || rows > best.rows) best = { col: c.name, cl, rows };
      });
      if (!best) return;
      const ex = best.cl[0].values.slice(0, 3).map((v) => '"' + v.value + '"').join(', ');
      d.cluster = { id: 'cluster_' + best.col, icon: 'fa-object-ungroup', text: 'Similar values · ' + best.col, detail: best.cl.length + ' group' + (best.cl.length > 1 ? 's' : '') + ', e.g. ' + ex, kind: { type: 'ClusterValues', col: best.col, method: 'fingerprint', pairs: E.clusterPairs(best.cl) } };
      out.suggestions = (out.suggestions || []).slice(0, 4).concat([d.cluster]);
    }
    PQ.Host.handle = async function (msg, progress) {
      progress = progress || (() => {});
      if (NEED.has(msg.op)) await IO.prepare(usedFiles(msg), msg, progress);
      if (msg.op === 'suggestSteps' && msg.source && (msg.source.format === 'parquet' || msg.source.format === 'arrow')) return { steps: [], columns: [] };
      const x = H2[msg.op];
      if (x) { const r = await x(msg, progress); if (r !== null) return r; }
      E.lastFp = null;
      const out = await base(msg, progress);
      if (msg.op === 'evaluate' && out) out.fp = out.resultId ? E.lastFp : null;
      if (msg.op === 'evaluate' && out && out.resultId && msg.suggest !== false) { try { clusterSuggestion(out, msg); } catch (e) { } }
      if (msg.op === 'storageInfo' && out) out.backend = PQ.storageBackend || 'indexeddb';
      return out;
    };
  }
})();
