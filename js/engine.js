/* Built-in engine: step executors and the query evaluator with a fingerprint cache. Runs in the engine Web Worker. */
(function () {
  const PQ = self.PQ;
  const { Table, CellError, isErr, StepError, MissingColumnError, Formula } = PQ;

  const E = (PQ.Engine = {});

  /* ================================ helpers ================================ */
  const keyOf = (v) => (v === null || v === undefined ? '\u0000' : v instanceof Date ? 'd' + v.getTime() : isErr(v) ? '\u0001' : typeof v === 'number' ? 'n' + v : typeof v === 'boolean' ? 'b' + v : 's' + v);
  const textKey = (v) => (v === null || v === undefined ? '\u0000' : isErr(v) ? '\u0001' : 's' + PQ.fmtValue(v));
  E.keyOf = keyOf;

  function compareValues(a, b, nullsLast) {
    const an = a === null || a === undefined || isErr(a), bn = b === null || b === undefined || isErr(b);
    if (an || bn) return an && bn ? 0 : an ? (nullsLast ? 1 : -1) : nullsLast ? -1 : 1;
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    if (a instanceof Date && b instanceof Date) return a - b;
    if (typeof a === 'boolean' && typeof b === 'boolean') return +a - +b;
    return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
  }
  E.compareValues = compareValues;

  function filterRows(t, pred) {
    const ix = new Int32Array(t.n);
    let k = 0;
    for (let r = 0; r < t.n; r++) if (pred(r)) ix[k++] = r;
    return k === t.n ? t : t.take(ix.subarray(0, k));
  }

  class KeyDict {
    constructor(text) { this.text = !!text; this.num = new Map(); this.str = new Map(); this.date = new Map(); this.t = -1; this.f = -1; this.nul = -1; this.err = -1; this.size = 0; }
    code(v) {
      if (v === null || v === undefined) { if (this.nul < 0) this.nul = this.size++; return this.nul; }
      if (v instanceof CellError) { if (this.err < 0) this.err = this.size++; return this.err; }
      if (this.text) v = PQ.fmtValue(v);
      const ty = typeof v;
      let m;
      if (ty === 'string') m = this.str;
      else if (ty === 'number') m = this.num;
      else if (ty === 'boolean') { if (v) { if (this.t < 0) this.t = this.size++; return this.t; } if (this.f < 0) this.f = this.size++; return this.f; }
      else if (v instanceof Date) { m = this.date; v = v.getTime(); }
      else { m = this.str; v = String(v); }
      let c = m.get(v);
      if (c === undefined) { c = this.size++; m.set(v, c); }
      return c;
    }
  }
  E.KeyDict = KeyDict;

  function encodeColumns(cols, n, dicts, skipNull, out) {
    const a = cols[0], d = dicts[0];
    for (let r = 0; r < n; r++) { const v = a[r]; out[r] = skipNull && (v === null || v === undefined || v instanceof CellError) ? -1 : d.code(v); }
    return out;
  }

  function groupCodes(t, keys) {
    const arrs = keys.map((k) => t.get(k));
    const n = t.n, codes = new Int32Array(n);
    if (!arrs.length) return { codes, ng: 1 };
    if (arrs.length === 1) {
      const d = new KeyDict(false);
      encodeColumns(arrs, n, [d], false, codes);
      return { codes, ng: d.size };
    }
    const dicts = arrs.map(() => new KeyDict(false));
    const per = arrs.map((a, j) => { const c = new Int32Array(n); encodeColumns([a], n, [dicts[j]], false, c); return c; });
    let prev = per[0], card = dicts[0].size;
    for (let j = 1; j < per.length; j++) {
      const cj = per[j], cc = dicts[j].size, map = new Map(), next = j === per.length - 1 ? codes : new Int32Array(n);
      for (let r = 0; r < n; r++) {
        const key = prev[r] * cc + cj[r];
        let id = map.get(key);
        if (id === undefined) { id = map.size; map.set(key, id); }
        next[r] = id;
      }
      prev = next; card = map.size;
    }
    return { codes, ng: card };
  }
  E.groupCodes = groupCodes;

  function csr(codes, ng, n) {
    const off = new Int32Array(ng + 1);
    for (let r = 0; r < n; r++) { const c = codes[r]; if (c >= 0) off[c + 1]++; }
    for (let g = 0; g < ng; g++) off[g + 1] += off[g];
    const pos = off.slice(0, ng), order = new Int32Array(off[ng]);
    for (let r = 0; r < n; r++) { const c = codes[r]; if (c >= 0) order[pos[c]++] = r; }
    return { off, order };
  }
  E.csr = csr;
  function mapCol(arr, f) { const out = new Array(arr.length); for (let i = 0; i < arr.length; i++) out[i] = f(arr[i], i); return out; }

  /** Builder filter → formula text (so the formula is the single source of truth and codegen gets it for free). */
  E.builderToFormula = function (b) {
    if (!b || !b.conds || !b.conds.length) return 'true';
    const parts = b.conds.map((c) => {
      const col = Formula.quoteCol(c.col);
      const v = c.value === undefined ? '' : c.value;
      const lit = (x) => (x === '' || x === null ? 'null' : !isNaN(+x) && String(x).trim() !== '' && c.numeric !== false ? String(+x) : /^\d{4}-\d{2}-\d{2}$/.test(x) ? 'Date.From("' + x + '")' : Formula.lit(String(x)));
      switch (c.op) {
        case 'eq': return col + ' = ' + lit(v);
        case 'ne': return col + ' <> ' + lit(v);
        case 'gt': return col + ' > ' + lit(v);
        case 'ge': return col + ' >= ' + lit(v);
        case 'lt': return col + ' < ' + lit(v);
        case 'le': return col + ' <= ' + lit(v);
        case 'contains': return 'Text.Contains(Text.From(' + col + '), ' + Formula.lit(String(v)) + ')';
        case 'not_contains': return 'not Text.Contains(Text.From(' + col + '), ' + Formula.lit(String(v)) + ')';
        case 'starts': return 'Text.StartsWith(Text.From(' + col + '), ' + Formula.lit(String(v)) + ')';
        case 'ends': return 'Text.EndsWith(Text.From(' + col + '), ' + Formula.lit(String(v)) + ')';
        case 'null': return col + ' = null';
        case 'not_null': return col + ' <> null';
        case 'in': return col + ' in {' + (c.values || []).map((x) => Formula.lit(x)).join(', ') + '}';
        case 'not_in': return 'not (' + col + ' in {' + (c.values || []).map((x) => Formula.lit(x)).join(', ') + '})';
      }
      return 'true';
    });
    return parts.join(b.join === 'or' ? ' or ' : ' and ');
  };
  E.conditionalToFormula = function (s) {
    let f = s.else && s.else.trim() ? s.else : 'null';
    for (let i = (s.rules || []).length - 1; i >= 0; i--) f = 'if ' + (s.rules[i].when || 'false') + ' then ' + (s.rules[i].then || 'null') + ' else ' + f;
    return f;
  };
  E.filterFormula = (s) => (s.mode === 'builder' ? E.builderToFormula(s.builder) : s.formula || 'true');

  /* ================================ aggregation ================================ */
  const AGG = {
    count_rows: { label: 'Count rows', type: () => 'int', fn: (vals) => vals.length },
    count: { label: 'Count (non-empty)', type: () => 'int', fn: (vals) => vals.filter((v) => v !== null && !isErr(v)).length },
    count_distinct: { label: 'Count distinct', type: () => 'int', fn: (vals) => new Set(vals.filter((v) => v !== null).map(keyOf)).size },
    sum: { label: 'Sum', type: (t) => (t === 'int' ? 'int' : 'number'), fn: (vals) => { let s = 0, any = false; for (const v of vals) if (typeof v === 'number') { s += v; any = true; } return any ? s : null; } },
    mean: { label: 'Average', type: () => 'number', fn: (vals) => { let s = 0, n = 0; for (const v of vals) if (typeof v === 'number') { s += v; n++; } return n ? s / n : null; } },
    median: { label: 'Median', type: () => 'number', fn: (vals) => { const a = vals.filter((v) => typeof v === 'number').sort((x, y) => x - y); if (!a.length) return null; const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; } },
    min: { label: 'Min', type: (t) => t, fn: (vals) => { let m = null; for (const v of vals) if (v !== null && !isErr(v) && (m === null || compareValues(v, m) < 0)) m = v; return m; } },
    max: { label: 'Max', type: (t) => t, fn: (vals) => { let m = null; for (const v of vals) if (v !== null && !isErr(v) && (m === null || compareValues(v, m) > 0)) m = v; return m; } },
    first: { label: 'First', type: (t) => t, fn: (vals) => (vals.length ? vals[0] : null) },
    last: { label: 'Last', type: (t) => t, fn: (vals) => (vals.length ? vals[vals.length - 1] : null) },
    concat: { label: 'Concatenate text', type: () => 'text', fn: (vals, sep) => vals.filter((v) => v !== null && !isErr(v)).map((v) => PQ.fmtValue(v)).join(sep === undefined ? ', ' : sep) },
  };
  E.AGG = AGG;

  function groupIndex(t, keys) {
    if (!t.n) return [];
    const { codes, ng } = groupCodes(t, keys);
    const { off, order } = csr(codes, ng, t.n);
    const groups = new Array(ng);
    for (let g = 0; g < ng; g++) groups[g] = Array.prototype.slice.call(order, off[g], off[g + 1]);
    return groups;
  }
  E.groupIndex = groupIndex;

  /* ================================ step executors ================================ */
  const X = {};
  E.X = X;

  X.SelectColumns = (t, s) => t.select(s.cols || []);
  X.ReorderColumns = (t, s) => { const rest = t.names.filter((n) => !(s.cols || []).includes(n)); return t.select((s.cols || []).concat(rest)); };
  X.RemoveColumns = (t, s) => { t.need(s.cols || []); const drop = new Set(s.cols); return t.select(t.names.filter((n) => !drop.has(n))); };
  X.RemoveOtherColumns = X.SelectColumns;
  X.Rename = (t, s) => {
    const map = new Map(s.map || []);
    for (const k of map.keys()) if (!t.has(k)) throw new MissingColumnError(k, t.names);
    const newNames = t.names.map((n) => (map.has(n) ? map.get(n) : n));
    const dup = newNames.find((n, i) => newNames.indexOf(n) !== i);
    if (dup) throw new StepError('Renaming would create two columns named `' + dup + '`');
    return new Table(t.cols.map((c, i) => ({ name: newNames[i], type: c.type })), t.data, t.n);
  };

  X.ChangeType = (t, s, ctx) => {
    let out = t;
    const mode = s.onError || 'error';
    for (const ch of s.changes || []) {
      const src = t.get(ch.col);
      const locale = ch.locale || s.locale || ctx.locale;
      const cc = PQ.castColumn(src, ch.type, locale);
      const casted = cc.values, errs = cc.errors;
      const firstErr = errs ? { row: cc.first, v: src[cc.first], msg: casted[cc.first].msg } : null;
      if (errs && mode === 'fail') throw new StepError('Row ' + (firstErr.row + 1) + ': ' + firstErr.msg + ' (column `' + ch.col + '`, ' + PQ.fmtInt(errs) + ' failing value' + (errs > 1 ? 's' : '') + ')', { fixes: [{ kind: 'setOnError', value: 'error', label: 'Keep errors per cell instead' }, { kind: 'setOnError', value: 'null', label: 'Turn failures into nulls' }] });
      if (errs && mode === 'null') for (let i = 0; i < casted.length; i++) if (isErr(casted[i]) && !isErr(src[i])) casted[i] = null;
      if (mode === 'keep') {
        const orig = new Array(casted.length).fill(null);
        for (let i = 0; i < casted.length; i++) if (isErr(casted[i]) && !isErr(src[i])) { orig[i] = src[i] === null ? null : String(PQ.fmtValue(src[i])); casted[i] = null; }
        out = out.withColumn(ch.col, ch.type, casted);
        out = out.withColumn(PQ.uniqueName(ch.col + '_error', out.names), 'text', orig, out.index(ch.col) + 1);
      } else out = out.withColumn(ch.col, ch.type, casted);
    }
    return out;
  };

  X.Filter = (t, s, ctx) => {
    const f = E.filterFormula(s);
    if (f.trim() === 'true') return t;
    const { values } = Formula.evaluate(f, t, ctx.params);
    const ix = new Int32Array(t.n);
    let k = 0;
    for (let r = 0; r < t.n; r++) if (values[r] === true) ix[k++] = r;
    return k === t.n ? t : t.take(ix.subarray(0, k));
  };

  X.Sort = (t, s) => {
    const by = (s.by || []).map((b) => ({ arr: t.get(b.col), desc: !!b.desc, nullsLast: b.nullsLast !== false }));
    const ix = Array.from({ length: t.n }, (_, i) => i);
    ix.sort((a, b) => {
      for (const k of by) {
        const va = k.arr[a], vb = k.arr[b];
        const an = va === null || isErr(va), bn = vb === null || isErr(vb);
        if (an || bn) { if (an && bn) continue; return an ? (k.nullsLast ? 1 : -1) : k.nullsLast ? -1 : 1; }
        const c = compareValues(va, vb, k.nullsLast);
        if (c) return k.desc ? -c : c;
      }
      return a - b;
    });
    return t.take(ix);
  };

  X.Distinct = (t, s) => {
    const cols = s.subset && s.subset.length ? s.subset : t.names;
    t.need(cols);
    if (!t.n || !cols.length) return t.n > 1 && !cols.length ? t.slice(0, 1) : t;
    const { codes, ng } = groupCodes(t, cols);
    const seen = new Uint8Array(ng);
    return filterRows(t, (r) => { const c = codes[r]; if (seen[c]) return false; seen[c] = 1; return true; });
  };
  X.KeepDuplicates = (t, s) => {
    const cols = s.subset && s.subset.length ? s.subset : t.names;
    t.need(cols);
    if (!t.n) return t;
    if (!cols.length) return t.n > 1 ? t : t.slice(0, 0);
    const { codes, ng } = groupCodes(t, cols);
    const counts = new Int32Array(ng);
    for (let r = 0; r < t.n; r++) counts[codes[r]]++;
    return filterRows(t, (r) => counts[codes[r]] > 1);
  };

  X.KeepRows = (t, s) => {
    const n = Math.max(0, +s.n || 0), off = Math.max(0, +s.offset || 0);
    switch (s.mode) {
      case 'top': return t.slice(0, n);
      case 'bottom': return t.slice(Math.max(0, t.n - n), t.n);
      case 'range': return t.slice(off, off + n);
      case 'remove_top': return t.slice(n, t.n);
      case 'remove_bottom': return t.slice(0, Math.max(0, t.n - n));
      case 'alternate': { const keep = Math.max(1, +s.keep || 1), skip = Math.max(0, +s.skip || 1); return filterRows(t, (r) => r >= off && (r - off) % (keep + skip) < keep); }
      case 'remove_blank': return filterRows(t, (r) => t.data.some((c) => !PQ.isEmpty(c[r])));
    }
    throw new StepError('Unknown keep-rows mode ' + s.mode);
  };

  X.PromoteHeaders = (t, s) => {
    const row = Math.max(0, +s.row || 0);
    if (row >= t.n) throw new StepError('Row ' + (row + 1) + ' does not exist (table has ' + t.n + ' rows)');
    const names = PQ.uniquify(t.data.map((c) => (c[row] === null || isErr(c[row]) ? null : PQ.fmtValue(c[row]))));
    const body = t.slice(row + 1, t.n);
    return new Table(names.map((n, i) => ({ name: n, type: PQ.valuesType(body.data[i]) })), body.data, body.n);
  };
  X.DemoteHeaders = (t) => {
    const data = t.data.map((c, i) => [t.names[i]].concat(c));
    return new Table(t.cols.map((c, i) => ({ name: 'Column' + (i + 1), type: 'any' })), data, t.n + 1);
  };

  const fill = (dir) => (t, s) => {
    let out = t;
    for (const c of s.cols || []) {
      const a = t.get(c).slice();
      if (dir > 0) { let last = null; for (let i = 0; i < a.length; i++) { if (a[i] === null || a[i] === undefined) a[i] = last; else last = a[i]; } }
      else { let last = null; for (let i = a.length - 1; i >= 0; i--) { if (a[i] === null || a[i] === undefined) a[i] = last; else last = a[i]; } }
      out = out.withColumn(c, t.type(c), a);
    }
    return out;
  };
  X.FillDown = fill(1);
  X.FillUp = fill(-1);

  X.ReplaceValues = (t, s, ctx) => {
    let out = t;
    for (const c of s.cols || []) {
      const type = t.type(c);
      const findNull = s.find === null || s.find === undefined || s.find === '';
      const conv = (x) => (x === null || x === undefined || x === '' ? null : type === 'text' || type === 'any' ? String(x) : (() => { const v = PQ.cast(x, type, ctx.locale); return isErr(v) ? String(x) : v; })());
      const find = conv(s.find), rep = conv(s.replace);
      const whole = s.wholeCell !== false || type !== 'text';
      const a = mapCol(t.get(c), (v) => {
        if (isErr(v)) return v;
        if (findNull) return v === null || v === '' ? rep : v;
        if (whole) return PQ.valueEquals(v, find) ? rep : v;
        if (typeof v === 'string') return s.find === '' ? v : v.split(String(s.find)).join(s.replace === null ? '' : String(s.replace));
        return v;
      });
      out = out.withColumn(c, whole ? t.type(c) : 'text', a);
    }
    return out;
  };
  X.ReplaceErrors = (t, s, ctx) => {
    let out = t;
    for (const c of s.cols || []) {
      const type = t.type(c);
      const rep = s.value === '' || s.value === null || s.value === undefined ? null : (() => { const v = PQ.cast(s.value, type === 'any' ? 'text' : type, ctx.locale); return isErr(v) ? s.value : v; })();
      out = out.withColumn(c, type, mapCol(t.get(c), (v) => (isErr(v) ? rep : v)));
    }
    return out;
  };
  X.RemoveErrors = (t, s) => { const arrs = (s.cols && s.cols.length ? s.cols : t.names).map((c) => t.get(c)); return filterRows(t, (r) => !arrs.some((a) => isErr(a[r]))); };
  X.KeepErrors = (t, s) => { const arrs = (s.cols && s.cols.length ? s.cols : t.names).map((c) => t.get(c)); return filterRows(t, (r) => arrs.some((a) => isErr(a[r]))); };

  const TEXT_OPS = {
    upper: (v) => v.toUpperCase(), lower: (v) => v.toLowerCase(), trim: (v) => v.trim(),
    clean: (v) => v.replace(/[\x00-\x1f\x7f]/g, '').replace(/\s+/g, ' ').trim(),
    proper: (v) => v.toLowerCase().replace(/(^|[^\p{L}\p{N}'])(\p{L})/gu, (m, p, c) => p + c.toUpperCase()),
  };
  X.TextTransform = (t, s) => {
    const f = TEXT_OPS[s.op]; if (!f) throw new StepError('Unknown text transform ' + s.op);
    let out = t;
    for (const c of s.cols || []) out = out.withColumn(c, 'text', mapCol(t.get(c), (v) => (v === null || isErr(v) ? v : f(v instanceof Date ? PQ.fmtDate(v) : String(v)))));
    return out;
  };
  X.RoundNumbers = (t, s) => {
    let out = t; const d = +s.digits || 0, f = Math.pow(10, d);
    for (const c of s.cols || []) out = out.withColumn(c, d === 0 ? 'int' : t.type(c), mapCol(t.get(c), (v) => (typeof v === 'number' ? Math.round(v * f) / f : v)));
    return out;
  };

  X.SplitColumn = (t, s) => {
    const src = t.get(s.col), pos = t.index(s.col);
    const text = (v) => (v === null || isErr(v) ? null : String(PQ.fmtValue(v)));
    if (s.mode === 'rows') {
      const d = s.delimiter || ',';
      const ix = [], vals = [];
      for (let r = 0; r < t.n; r++) {
        const v = text(src[r]);
        const parts = v === null ? [null] : v.split(d);
        for (const p of parts) { ix.push(r); vals.push(p === null ? null : s.trim !== false ? p.trim() : p); }
      }
      return t.take(ix).withColumn(s.col, 'text', vals);
    }
    let pieces;
    if (s.mode === 'positions') {
      const ps = String(s.positions || '').split(',').map((x) => parseInt(x.trim(), 10)).filter((x) => !isNaN(x)).sort((a, b) => a - b);
      if (!ps.length) throw new StepError('Enter one or more character positions, e.g. 0, 3, 7');
      pieces = mapCol(src, (v) => { v = text(v); if (v === null) return []; const out = []; for (let i = 0; i < ps.length; i++) out.push(v.slice(ps[i], ps[i + 1])); return out; });
    } else {
      const d = s.delimiter === undefined || s.delimiter === '' ? ',' : s.delimiter;
      pieces = mapCol(src, (v) => {
        v = text(v); if (v === null) return [];
        if (s.mode === 'first') { const i = v.indexOf(d); return i < 0 ? [v] : [v.slice(0, i), v.slice(i + d.length)]; }
        if (s.mode === 'last') { const i = v.lastIndexOf(d); return i < 0 ? [v] : [v.slice(0, i), v.slice(i + d.length)]; }
        return v.split(d);
      });
    }
    let count = s.count ? +s.count : 0;
    if (!count) for (const p of pieces) count = Math.max(count, p.length);
    count = Math.max(1, Math.min(count, 200));
    const existing = new Set(t.names.filter((n) => n !== s.col));
    const names = [];
    for (let k = 0; k < count; k++) { const nm = PQ.uniqueName(s.col + '.' + (k + 1), existing); existing.add(nm); names.push(nm); }
    const cols = t.cols.slice(0, pos).concat(names.map((n) => ({ name: n, type: 'text' })), t.cols.slice(pos + 1));
    const newData = names.map((_, k) => mapCol(pieces, (p) => (p[k] === undefined ? null : s.trim !== false ? p[k].trim() : p[k])));
    const data = t.data.slice(0, pos).concat(newData, t.data.slice(pos + 1));
    return new Table(cols.map((c) => ({ ...c })), data, t.n);
  };

  X.MergeColumns = (t, s) => {
    const cols = s.cols || []; t.need(cols);
    if (cols.length < 2) throw new StepError('Pick at least two columns to merge');
    const arrs = cols.map((c) => t.get(c)), sep = s.sep === undefined ? ' ' : s.sep;
    const merged = new Array(t.n);
    for (let r = 0; r < t.n; r++) merged[r] = arrs.map((a) => (a[r] === null || isErr(a[r]) ? '' : PQ.fmtValue(a[r]))).join(sep);
    const pos = Math.min(...cols.map((c) => t.index(c)));
    const drop = new Set(cols);
    const keep = t.names.filter((n) => !drop.has(n));
    const name = PQ.uniqueName(s.name || 'Merged', keep);
    const base = t.select(keep);
    return base.withColumn(name, 'text', merged, Math.min(pos, keep.length));
  };

  X.AddColumn = (t, s, ctx) => {
    if (!s.name) throw new StepError('Give the new column a name');
    const { values, type } = Formula.evaluate(s.formula || 'null', t, ctx.params);
    const cast = s.castTo && s.castTo !== 'auto' ? s.castTo : null;
    return t.withColumn(s.name, cast || type, cast ? mapCol(values, (v) => PQ.cast(v, cast, ctx.locale)) : values);
  };
  X.ConditionalColumn = (t, s, ctx) => X.AddColumn(t, { name: s.name, formula: E.conditionalToFormula(s) }, ctx);
  X.IndexColumn = (t, s) => {
    const start = +s.start || 0, step = s.step === undefined || s.step === '' ? 1 : +s.step;
    const a = new Array(t.n); for (let i = 0; i < t.n; i++) a[i] = start + i * step;
    return t.withColumn(PQ.uniqueName(s.name || 'Index', t.names), 'int', a, s.first ? 0 : undefined);
  };
  X.DuplicateColumn = (t, s) => t.withColumn(PQ.uniqueName(s.name || s.col + ' - Copy', t.names), t.type(s.col), t.get(s.col).slice(), t.index(s.col) + 1);

  X.GroupBy = (t, s) => {
    const keys = s.keys || [];
    t.need(keys);
    const aggs = s.aggs || [];
    aggs.forEach((a) => { if (a.fn !== 'count_rows') t.need([a.col]); if (!AGG[a.fn]) throw new StepError('Unknown aggregation ' + a.fn); });
    const n = t.n;
    let codes, ng;
    if (keys.length) { if (!n) { codes = new Int32Array(0); ng = 0; } else ({ codes, ng } = groupCodes(t, keys)); }
    else { codes = new Int32Array(n); ng = 1; }
    const first = new Int32Array(ng).fill(-1), last = new Int32Array(ng).fill(-1), size = new Int32Array(ng);
    for (let r = 0; r < n; r++) { const g = codes[r]; if (first[g] < 0) first[g] = r; last[g] = r; size[g]++; }
    let grp = null;
    const groupsOf = () => grp || (grp = csr(codes, ng, n));
    const cols = keys.map((k) => ({ name: k, type: t.type(k) }));
    const data = keys.map((k) => { const a = t.get(k), o = new Array(ng); for (let g = 0; g < ng; g++) o[g] = a[first[g]]; return o; });
    const used = new Set(keys);
    aggs.forEach((a) => {
      const src = a.fn === 'count_rows' ? null : t.get(a.col);
      const name = PQ.uniqueName(a.name || (AGG[a.fn].label + (a.col ? ' of ' + a.col : '')), used); used.add(name);
      cols.push({ name, type: AGG[a.fn].type(a.col ? t.type(a.col) : 'int') });
      const o = new Array(ng);
      switch (a.fn) {
        case 'count_rows': for (let g = 0; g < ng; g++) o[g] = size[g]; break;
        case 'count': { o.fill(0); for (let r = 0; r < n; r++) { const v = src[r]; if (v !== null && !(v instanceof CellError)) o[codes[r]]++; } break; }
        case 'sum': case 'mean': {
          const sum = new Float64Array(ng), cnt = new Int32Array(ng);
          for (let r = 0; r < n; r++) { const v = src[r]; if (typeof v === 'number') { const g = codes[r]; sum[g] += v; cnt[g]++; } }
          for (let g = 0; g < ng; g++) o[g] = cnt[g] ? (a.fn === 'sum' ? sum[g] : sum[g] / cnt[g]) : null;
          break;
        }
        case 'min': case 'max': {
          o.fill(null);
          const sign = a.fn === 'min' ? -1 : 1;
          for (let r = 0; r < n; r++) {
            const v = src[r];
            if (v === null || v instanceof CellError) continue;
            const g = codes[r], m = o[g];
            if (m === null) { o[g] = v; continue; }
            if (typeof v === 'number' && typeof m === 'number') { if ((v - m) * sign > 0) o[g] = v; }
            else if (compareValues(v, m) * sign > 0) o[g] = v;
          }
          break;
        }
        case 'first': for (let g = 0; g < ng; g++) o[g] = first[g] < 0 ? null : src[first[g]]; break;
        case 'last': for (let g = 0; g < ng; g++) o[g] = last[g] < 0 ? null : src[last[g]]; break;
        default: {
          const { off, order } = groupsOf();
          for (let g = 0; g < ng; g++) { const vs = new Array(off[g + 1] - off[g]); for (let k = off[g]; k < off[g + 1]; k++) vs[k - off[g]] = src[order[k]]; o[g] = AGG[a.fn].fn(vs, a.sep); }
        }
      }
      data.push(o);
    });
    const out = new Table(cols, data, ng);
    out.cols.forEach((c, i) => { if (c.type === 'any') c.type = PQ.valuesType(out.data[i]); });
    return out;
  };

  X.Unpivot = (t, s) => {
    let ids = s.ids || [], vals = s.values && s.values.length ? s.values : null;
    t.need(ids); if (vals) t.need(vals);
    if (!vals) vals = t.names.filter((n) => !ids.includes(n));
    if (s.values && s.values.length && !s.ids) ids = t.names.filter((n) => !vals.includes(n));
    const varName = s.var || 'Attribute', valName = s.val || 'Value';
    const n = t.n * vals.length;
    const idArrs = ids.map((i) => t.get(i)), valArrs = vals.map((v) => t.get(v));
    const outIds = ids.map(() => new Array(n)), outVar = new Array(n), outVal = new Array(n);
    let k = 0;
    for (let r = 0; r < t.n; r++) for (let j = 0; j < vals.length; j++) {
      const v = valArrs[j][r];
      if (v === null && s.dropNulls !== false) continue;
      for (let i = 0; i < ids.length; i++) outIds[i][k] = idArrs[i][r];
      outVar[k] = vals[j]; outVal[k] = v; k++;
    }
    const valType = new Set(vals.map((v) => t.type(v))).size === 1 ? t.type(vals[0]) : 'any';
    return new Table(ids.map((i) => ({ name: i, type: t.type(i) })).concat([{ name: varName, type: 'text' }, { name: valName, type: valType }]), outIds.map((a) => a.slice(0, k)).concat([outVar.slice(0, k), outVal.slice(0, k)]), k);
  };

  X.Pivot = (t, s) => {
    t.need([s.on]); if (s.values) t.need([s.values]);
    const index = s.index && s.index.length ? s.index : t.names.filter((n) => n !== s.on && n !== s.values);
    t.need(index);
    const onArr = t.get(s.on), valArr = s.values ? t.get(s.values) : null;
    const n = t.n;
    const newCols = [], colOf = new Map(), colIx = new Int32Array(n);
    for (let r = 0; r < n; r++) {
      const k = onArr[r] === null ? 'null' : String(PQ.fmtValue(onArr[r]));
      let c = colOf.get(k);
      if (c === undefined) { c = newCols.length; colOf.set(k, c); newCols.push(k); }
      colIx[r] = c;
    }
    if (newCols.length > 500) throw new StepError('Pivot would create ' + newCols.length + ' columns (limit 500). Filter or group `' + s.on + '` first.');
    const agg = AGG[s.agg || 'sum'] || AGG.first;
    let codes, ng;
    if (index.length) { if (!n) { codes = new Int32Array(0); ng = 0; } else ({ codes, ng } = groupCodes(t, index)); }
    else { codes = new Int32Array(n); ng = 1; }
    const first = new Int32Array(ng).fill(-1);
    for (let r = 0; r < n; r++) if (first[codes[r]] < 0) first[codes[r]] = r;
    const cols = index.map((k) => ({ name: k, type: t.type(k) }));
    const data = index.map((k) => { const a = t.get(k), o = new Array(ng); for (let g = 0; g < ng; g++) o[g] = a[first[g]]; return o; });
    const nc = newCols.length;
    const cells = new Map();
    for (let r = 0; r < n; r++) {
      const id = codes[r] * nc + colIx[r];
      let b = cells.get(id);
      if (!b) cells.set(id, (b = []));
      b.push(valArr ? valArr[r] : 1);
    }
    const outCols = newCols.map(() => new Array(ng).fill(null));
    cells.forEach((vs, id) => { const g = Math.floor(id / nc); outCols[id - g * nc][g] = agg.fn(vs); });
    const idxNames = new Set(index);
    const valType = valArr ? agg.type(t.type(s.values)) : 'int';
    newCols.forEach((name0, c) => {
      const name = PQ.uniqueName(name0, idxNames); idxNames.add(name);
      cols.push({ name, type: valType === 'any' ? 'number' : valType });
      data.push(outCols[c]);
    });
    return new Table(cols, data, ng);
  };

  X.Transpose = (t, s) => {
    if (t.n > 5000) throw new StepError('Transpose would create ' + PQ.fmtInt(t.n) + ' columns. Filter or group first (limit 5,000).');
    const hc = s.headerCol && t.has(s.headerCol) ? s.headerCol : null;
    const srcCols = t.names.filter((n) => n !== hc);
    const newNames = hc ? PQ.uniquify(t.get(hc).map((v) => (v === null ? null : PQ.fmtValue(v)))) : Array.from({ length: t.n }, (_, i) => 'Column' + (i + 1));
    const cols = [{ name: PQ.uniqueName('Name', newNames), type: 'text' }].concat(newNames.map((n) => ({ name: n, type: 'any' })));
    const data = [srcCols.slice()].concat(newNames.map((_, r) => srcCols.map((c) => t.get(c)[r])));
    const out = new Table(cols, data, srcCols.length);
    out.cols.forEach((c, i) => { c.type = PQ.valuesType(out.data[i]); });
    return out;
  };

  /** Hash join. how: left|right|inner|full|semi|anti|cross */
  X.Merge = (t, s, ctx) => {
    const right = ctx.resolve(s.right);
    const how = s.how || 'left';
    if (how === 'cross') {
      if (t.n * right.n > 5e6) throw new StepError('Cross join would produce ' + PQ.fmtInt(t.n * right.n) + ' rows');
      const li = [], ri = [];
      for (let a = 0; a < t.n; a++) for (let b = 0; b < right.n; b++) { li.push(a); ri.push(b); }
      return joinOutput(t, right, li, ri, s);
    }
    const on = s.on || [];
    if (!on.length) throw new StepError('Choose at least one key column on each side');
    t.need(on.map((p) => p[0]));
    right.need(on.map((p) => p[1]));
    const { lc, rc, ng } = joinCodes(t, right, on, !!s.castKeys);
    const { off, order } = csr(rc, ng, right.n);
    if (how === 'semi' || how === 'anti') return filterRows(t, (r) => { const c = lc[r]; const m = c >= 0 && off[c + 1] > off[c]; return how === 'semi' ? m : !m; });
    const li = [], ri = [];
    const matchedRight = how === 'right' || how === 'full' ? new Uint8Array(right.n) : null;
    const keepLeft = how === 'left' || how === 'full';
    for (let r = 0; r < t.n; r++) {
      const c = lc[r];
      if (c >= 0 && off[c + 1] > off[c]) { for (let k = off[c]; k < off[c + 1]; k++) { const x = order[k]; li.push(r); ri.push(x); if (matchedRight) matchedRight[x] = 1; } }
      else if (keepLeft) { li.push(r); ri.push(-1); }
    }
    if (how === 'right') {
      // keep right order semantics: matched pairs + unmatched right
      for (let x = 0; x < right.n; x++) if (!matchedRight[x]) { li.push(-1); ri.push(x); }
    }
    if (how === 'full') for (let x = 0; x < right.n; x++) if (!matchedRight[x]) { li.push(-1); ri.push(x); }
    if (li.length > 2e7) throw new StepError('Merge would produce ' + PQ.fmtInt(li.length) + ' rows — the right-hand keys are probably not unique');
    const out = joinOutput(t, right, li, ri, s);
    if (how === 'right' || how === 'full') {
      // coalesce keys so unmatched right rows still show the key value
      let o = out;
      on.forEach(([l, r]) => { const la = o.get(l), ra = right.get(r); const a = la.slice(); for (let i = 0; i < a.length; i++) if (li[i] < 0) a[i] = ra[ri[i]]; o = o.withColumn(l, t.type(l), a); });
      return o;
    }
    return out;
  };
  function joinCodes(left, right, on, castKeys) {
    const dicts = on.map(() => new KeyDict(castKeys));
    const la = on.map((p) => left.get(p[0])), ra = on.map((p) => right.get(p[1]));
    const lc = new Int32Array(left.n), rc = new Int32Array(right.n);
    if (on.length === 1) {
      encodeColumns(ra, right.n, dicts, true, rc);
      encodeColumns(la, left.n, dicts, true, lc);
      return { lc, rc, ng: dicts[0].size };
    }
    const enc = (arrs, n) => arrs.map((a, j) => { const c = new Int32Array(n); encodeColumns([a], n, [dicts[j]], true, c); return c; });
    const rp = enc(ra, right.n), lp = enc(la, left.n);
    let rPrev = rp[0], lPrev = lp[0], size = dicts[0].size;
    for (let j = 1; j < on.length; j++) {
      const cc = dicts[j].size, map = new Map();
      const rNext = j === on.length - 1 ? rc : new Int32Array(right.n), lNext = j === on.length - 1 ? lc : new Int32Array(left.n);
      for (let r = 0; r < right.n; r++) {
        const a = rPrev[r], b = rp[j][r];
        if (a < 0 || b < 0) { rNext[r] = -1; continue; }
        const key = a * cc + b;
        let id = map.get(key);
        if (id === undefined) { id = map.size; map.set(key, id); }
        rNext[r] = id;
      }
      for (let r = 0; r < left.n; r++) {
        const a = lPrev[r], b = lp[j][r];
        if (a < 0 || b < 0) { lNext[r] = -1; continue; }
        const id = map.get(a * cc + b);
        lNext[r] = id === undefined ? -1 : id;
      }
      rPrev = rNext; lPrev = lNext; size = map.size;
    }
    return { lc, rc, ng: size };
  }
  E.joinCodes = joinCodes;

  function joinOutput(left, right, li, ri, s) {
    const L = left.take(li);
    const rightKeys = new Set((s.on || []).map((p) => p[1]));
    let expand = s.expand && s.expand.length ? s.expand : right.names.filter((n) => !rightKeys.has(n));
    right.need(expand);
    const R = right.select(expand).take(ri);
    let out = L;
    const prefix = s.prefix === undefined ? '' : s.prefix;
    const existing = new Set(L.names);
    R.cols.forEach((c, i) => {
      let name = prefix ? prefix + '.' + c.name : c.name;
      name = PQ.uniqueName(name, existing); existing.add(name);
      out = out.withColumn(name, c.type, R.data[i]);
    });
    return out;
  }

  X.Append = (t, s, ctx) => {
    const others = (s.others || []).map((q) => ctx.resolve(q));
    if (s.mode === 'strict') {
      const a = t.names.slice().sort().join('|');
      others.forEach((o, i) => {
        if (o.names.slice().sort().join('|') !== a) {
          const missing = t.names.filter((n) => !o.has(n)), extra = o.names.filter((n) => !t.has(n));
          throw new StepError('Strict append: columns differ in table ' + (i + 2) + (missing.length ? ' — missing ' + missing.join(', ') : '') + (extra.length ? ' — extra ' + extra.join(', ') : ''), { fixes: [{ kind: 'set', field: 'mode', value: 'diagonal', label: 'Switch to diagonal (union by name)' }] });
        }
      });
    }
    return PQ.concatDiagonal([t].concat(others));
  };

  X.Window = (t, s) => {
    const part = s.partition || [];
    t.need(part);
    if (s.op !== 'row_number') t.need([s.col]);
    const src = s.col ? t.get(s.col) : null;
    const groups = part.length ? groupIndex(t, part) : [Array.from({ length: t.n }, (_, i) => i)];
    const out = new Array(t.n).fill(null);
    const ord = s.orderBy ? t.get(s.orderBy) : null;
    const n = Math.max(1, +s.n || 1);
    for (let g of groups) {
      if (ord) g = g.slice().sort((a, b) => compareValues(ord[a], ord[b], true) * (s.desc ? -1 : 1) || a - b);
      switch (s.op) {
        case 'cumsum': { let acc = 0; for (const r of g) { if (typeof src[r] === 'number') acc += src[r]; out[r] = acc; } break; }
        case 'row_number': g.forEach((r, i) => (out[r] = i + 1)); break;
        case 'rank': {
          const nul = (v) => v === null || v === undefined || isErr(v);
          const sorted = g.slice().sort((a, b) => (nul(src[a]) || nul(src[b]) ? nul(src[a]) - nul(src[b]) : compareValues(src[b], src[a], true)));
          let rank = 0, prev;
          sorted.forEach((r, i) => { if (i === 0 || compareValues(src[r], prev) !== 0) rank = i + 1; prev = src[r]; out[r] = rank; });
          break;
        }
        case 'lag': g.forEach((r, i) => (out[r] = i - n >= 0 ? src[g[i - n]] : null)); break;
        case 'lead': g.forEach((r, i) => (out[r] = i + n < g.length ? src[g[i + n]] : null)); break;
        case 'pct_of_total': { let tot = 0; for (const r of g) if (typeof src[r] === 'number') tot += src[r]; for (const r of g) out[r] = typeof src[r] === 'number' && tot ? src[r] / tot : null; break; }
        case 'moving_avg': { g.forEach((r, i) => { let sum = 0, c = 0; for (let k = Math.max(0, i - n + 1); k <= i; k++) { const v = src[g[k]]; if (typeof v === 'number') { sum += v; c++; } } out[r] = c ? sum / c : null; }); break; }
        default: throw new StepError('Unknown window operation ' + s.op);
      }
    }
    const typ = s.op === 'row_number' || s.op === 'rank' ? 'int' : s.op === 'lag' || s.op === 'lead' ? t.type(s.col) : 'number';
    return t.withColumn(PQ.uniqueName(s.name || s.op, t.names), typ, out);
  };

  X.ExpandJson = (t, s) => {
    const src = t.get(s.col), pos = t.index(s.col);
    const parsed = mapCol(src, (v) => { if (v === null || isErr(v)) return null; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch (e) { return new CellError('Not valid JSON', v); } });
    const hasArray = parsed.some((v) => Array.isArray(v));
    if (hasArray) {
      const ix = [], vals = [];
      parsed.forEach((v, r) => { if (Array.isArray(v)) { if (!v.length) { ix.push(r); vals.push(null); } v.forEach((x) => { ix.push(r); vals.push(x !== null && typeof x === 'object' ? JSON.stringify(x) : x); }); } else { ix.push(r); vals.push(v !== null && typeof v === 'object' ? JSON.stringify(v) : v); } });
      return t.take(ix).withColumn(s.col, PQ.valuesType(vals), vals);
    }
    const fields = s.fields && s.fields.length ? s.fields : (() => { const f = [], seen = new Set(); parsed.forEach((v) => v && !isErr(v) && typeof v === 'object' && Object.keys(v).forEach((k) => { if (!seen.has(k)) { seen.add(k); f.push(k); } })); return f; })();
    if (!fields.length) throw new StepError('Column `' + s.col + '` has no JSON objects to expand');
    const keep = t.names.filter((n) => n !== s.col);
    let out = t.select(keep);
    const existing = new Set(keep);
    fields.forEach((f, i) => {
      const name = PQ.uniqueName(s.col + '.' + f, existing); existing.add(name);
      const vals = mapCol(parsed, (o) => { if (isErr(o)) return o; if (!o || typeof o !== 'object') return null; const v = o[f]; return v === undefined ? null : v !== null && typeof v === 'object' ? JSON.stringify(v) : v; });
      out = out.withColumn(name, PQ.valuesType(vals), vals, pos + i);
    });
    return out;
  };

  X.CustomSql = (t, s, ctx) => {
    if (!s.sql || !s.sql.trim()) throw new StepError('Write a SQL query. The previous step is available as `self`.');
    const SQL = PQ.lib('alasql');
    if (!SQL) throw new StepError('SQL engine failed to load — reload the app');
    const db = new SQL.Database();
    const register = (name, table) => {
      db.exec('CREATE TABLE [' + name.replace(/]/g, '') + ']');
      const names = table.names;
      db.tables[name].data = table.toRows().map((row) => { const o = {}; names.forEach((n, i) => { o[n] = isErr(row[i]) ? null : row[i]; }); return o; });
    };
    register('self', t);
    const refs = ctx.sqlTables();
    const lower = s.sql.toLowerCase();
    refs.forEach((r) => { if (lower.includes(r.alias.toLowerCase())) register(r.alias, ctx.resolve(r.id)); });
    let rows;
    try { rows = db.exec(s.sql); } catch (e) { throw new StepError('SQL error: ' + e.message); }
    if (!Array.isArray(rows)) throw new StepError('The SQL must be a SELECT statement');
    if (Array.isArray(rows[0]) && rows.length && typeof rows[0][0] === 'object') rows = rows[rows.length - 1];
    const names = [];
    const seen = new Set();
    rows.slice(0, 1000).forEach((r) => Object.keys(r).forEach((k) => { if (!seen.has(k)) { seen.add(k); names.push(k); } }));
    const data = names.map((n) => rows.map((r) => (r[n] === undefined ? null : r[n])));
    return new Table(names.map((n, i) => ({ name: n, type: PQ.valuesType(data[i]) })), data, rows.length);
  };

  X.Checkpoint = (t) => t;

  /* ================================ sources ================================ */
  function readSource(src, ctx) {
    const limit = ctx.mode === 'preview' ? ctx.previewRows : Infinity;
    if (!src) throw new StepError('This query has no source');
    if (src.kind === 'query') return ctx.resolve(src.query);
    if (src.kind === 'blank') {
      const rows = (src.rows || []).map((r) => r.map((v) => (v === '' ? null : v)));
      const names = PQ.uniquify(src.columns || ['Column1']);
      return Table.fromRows(names, rows, names.map(() => 'text'));
    }
    if (src.kind === 'file') {
      const rec = PQ.Files.get(src.fileId);
      if (!rec) throw new StepError('File "' + (src.fileName || src.fileId) + '" is not available. Re-add it with Get Data → File.', { fixes: [{ kind: 'relink', label: 'Pick a replacement file' }] });
      const t = PQ.IO.readFile(rec, src, limit);
      return trimLimit(t, limit);
    }
    if (src.kind === 'folder') {
      const re = PQ.globToRegex(src.pattern || '*');
      const files = [...PQ.Files.values()].filter((f) => (f.folder || '') === src.folder && re.test(f.name)).sort((a, b) => a.name.localeCompare(b.name));
      if (!files.length) throw new StepError('No files in folder "' + src.folder + '" match "' + (src.pattern || '*') + '"');
      const parts = [];
      let remaining = limit;
      for (const f of files) {
        if (remaining <= 0) break;
        let t = PQ.IO.readFile(f, src, remaining);
        t = trimLimit(t, remaining);
        t = t.withColumn(src.fileColumn || 'Source.Name', 'text', new Array(t.n).fill(f.name), 0);
        parts.push(t);
        remaining -= t.n;
      }
      const out = PQ.concatDiagonal(parts);
      out.meta = { truncated: remaining <= 0, files: files.length };
      return out;
    }
    throw new StepError('Unknown source kind ' + src.kind);
  }
  function trimLimit(t, limit) {
    if (limit !== Infinity && t.n > limit) { const s = t.slice(0, limit); s.meta = Object.assign({}, t.meta, { truncated: true }); return s; }
    return t;
  }
  X.Source = (t, s, ctx) => readSource(s.source, ctx);

  /* ================================ compiler ================================ */
  const MATERIALIZES = new Set(['Pivot', 'Transpose', 'Merge', 'GroupBy', 'Sort', 'Distinct', 'CustomSql', 'Checkpoint']);
  E.MATERIALIZES = MATERIALIZES;

  const cache = new Map();
  const CACHE_MAX = 80, CELL_BUDGET = 60e6;
  let cachedCells = 0;
  const cellsOf = (t) => Math.max(1, t.n * Math.max(1, t.cols.length));
  function cacheGet(k) { const v = cache.get(k); if (v) { cache.delete(k); cache.set(k, v); } return v; }
  function cacheDrop(k) { const v = cache.get(k); if (v) { cachedCells -= cellsOf(v); cache.delete(k); } }
  function cachePut(k, v) {
    cacheDrop(k);
    cache.set(k, v); cachedCells += cellsOf(v);
    while (cache.size > 1 && (cache.size > CACHE_MAX || cachedCells > CELL_BUDGET)) cacheDrop(cache.keys().next().value);
  }
  E.clearCache = () => { cache.clear(); cachedCells = 0; };
  E.cacheSize = () => cache.size;

  let project = null;
  E.setProject = (p) => { project = p; };
  E.getProject = () => project;
  E.query = (id) => (project.queries || []).find((q) => q.id === id || q.name === id);

  function refsOf(step) {
    const k = step.kind || {};
    const r = [];
    if (k.type === 'Source' && k.source && k.source.kind === 'query') r.push(k.source.query);
    if (k.type === 'Merge') r.push(k.right);
    if (k.type === 'Append') r.push(...(k.others || []));
    if (k.type === 'CustomSql') {
      const lower = (k.sql || '').toLowerCase();
      E.sqlTables().forEach((t) => { if (lower.includes(t.alias.toLowerCase())) r.push(t.id); });
    }
    return r.filter(Boolean);
  }
  E.refsOf = refsOf;
  E.sqlTables = () => (project.queries || []).map((q) => ({ id: q.id, alias: PQ.snake(q.name) }));

  function sourceFingerprint(src) {
    if (!src) return 'none';
    if (src.kind === 'file') { const f = PQ.Files.get(src.fileId); return 'file:' + src.fileId + ':' + (f ? f.mtime + ':' + f.size : 'missing'); }
    if (src.kind === 'folder') { const re = PQ.globToRegex(src.pattern || '*'); return 'folder:' + [...PQ.Files.values()].filter((f) => (f.folder || '') === src.folder && re.test(f.name)).map((f) => f.id + ':' + f.mtime).sort().join(','); }
    return src.kind;
  }

  /** Fingerprint per step (cheap, no execution). Detects dependency cycles with a readable path. */
  function fingerprints(qid, mode, stack) {
    stack = stack || [];
    const q = E.query(qid);
    if (!q) throw new StepError('Referenced query not found (' + qid + ')');
    if (stack.includes(q.id)) {
      const names = stack.slice(stack.indexOf(q.id)).concat(q.id).map((id) => E.query(id).name);
      throw new StepError('Circular reference: ' + names.join(' → '), { cycle: true });
    }
    const st = stack.concat(q.id);
    const params = PQ.stableStringify(project.params || []);
    const base = [mode, mode === 'preview' ? project.settings.previewRows : 'all', project.settings.locale, params].join('|');
    const out = [];
    let prev = PQ.hash(base);
    for (const step of q.steps) {
      let extra = '';
      if (step.kind.type === 'Source') extra = sourceFingerprint(step.kind.source);
      for (const r of refsOf(step)) { const f = fingerprints(r, mode, st); extra += '|' + f[f.length - 1]; }
      prev = PQ.hash(prev + '|' + PQ.stableStringify(step.kind) + '|' + extra);
      out.push(prev);
    }
    return out;
  }
  E.fingerprints = fingerprints;

  function describeMissing(q, stepIndex, col) {
    // Look back for a rename / removal that explains the missing column
    for (let i = stepIndex - 1; i >= 0; i--) {
      const k = q.steps[i].kind;
      if (k.type === 'Rename') { const m = (k.map || []).find((p) => p[0] === col); if (m) return { because: 'it was renamed to `' + m[1] + '` in step ' + (i + 1) + ' (' + q.steps[i].name + ')', replacement: m[1] }; }
      if ((k.type === 'RemoveColumns' && (k.cols || []).includes(col))) return { because: 'it was removed in step ' + (i + 1) + ' (' + q.steps[i].name + ')', removedAt: i };
      if ((k.type === 'SelectColumns') && !(k.cols || []).includes(col)) return { because: 'it was not kept in step ' + (i + 1) + ' (' + q.steps[i].name + ')', removedAt: i };
      if (k.type === 'MergeColumns' && (k.cols || []).includes(col)) return { because: 'it was merged into `' + k.name + '` in step ' + (i + 1), replacement: k.name };
      if (k.type === 'SplitColumn' && k.col === col && k.mode !== 'rows') return { because: 'it was split into `' + col + '.1`, `' + col + '.2`… in step ' + (i + 1), replacement: col + '.1' };
    }
    return null;
  }

  /**
   * Evaluate a query up to step `upto`. Returns {table, states[]} where each state has
   * {ok, error, fixes, rows, cols, schema, ms, cached, truncated}.
   * Every step's result is cached by fingerprint, so editing step 7 keeps steps 1–6 instant.
   */
  function evaluate(qid, upto, mode, stack, onProgress) {
    stack = stack || [];
    const q = E.query(qid);
    if (!q) throw new StepError('Query not found');
    if (upto === undefined || upto === null || upto >= q.steps.length) upto = q.steps.length - 1;
    const ctx = {
      mode, previewRows: project.settings.previewRows, locale: project.settings.locale, params: project.params || [],
      resolve: (ref) => {
        const rq = E.query(ref);
        if (!rq) throw new StepError('Referenced query not found');
        const r = evaluate(rq.id, undefined, mode, stack.concat(q.id), onProgress);
        const bad = r.states.findIndex((s) => !s.ok);
        if (bad >= 0) throw new StepError('Query "' + rq.name + '" has an error in step ' + (bad + 1) + ': ' + r.states[bad].error);
        return r.table;
      },
      sqlTables: E.sqlTables,
    };
    let fps;
    const states = [];
    try { fps = fingerprints(q.id, mode, stack); }
    catch (e) { return { table: Table.empty(), states: q.steps.map((s, i) => ({ ok: false, error: i === 0 || e.cycle ? e.message : 'Blocked', blocked: i > 0 && !e.cycle })) }; }
    let table = Table.empty(), truncated = false, failed = -1;
    for (let i = 0; i <= upto; i++) {
      const step = q.steps[i];
      if (failed >= 0) { states.push({ ok: false, blocked: true, error: 'Blocked by the error in step ' + (failed + 1) }); continue; }
      if (step.disabled && i > 0) { states.push(Object.assign({}, states[i - 1], { disabled: true, cached: true, ms: 0 })); continue; }
      const hit = cacheGet(fps[i]);
      const t0 = performance.now();
      if (hit) { table = hit; }
      else {
        if (onProgress) onProgress({ stage: q.name + ' · ' + step.name, step: i });
        try {
          const ex = X[step.kind.type];
          if (!ex) throw new StepError('Unknown step type ' + step.kind.type);
          if (i === 0 && step.kind.type !== 'Source') throw new StepError('The first step must be a Source');
          table = ex(table, step.kind, ctx);
          cachePut(fps[i], table);
        } catch (e) {
          failed = i;
          const st = { ok: false, error: e.message || String(e), fixes: e.fixes || [], ms: performance.now() - t0 };
          if (e instanceof MissingColumnError) {
            const why = describeMissing(q, i, e.missingColumn);
            if (why) st.error += ' — ' + why.because;
            const sug = (why && why.replacement && table.has(why.replacement)) ? why.replacement : PQ.closest(e.missingColumn, table.names);
            if (sug) st.fixes.push({ kind: 'replaceColumn', from: e.missingColumn, to: sug, label: 'Use `' + sug + '` instead' });
            if (why && why.removedAt !== undefined) st.fixes.push({ kind: 'removeStep', index: why.removedAt, label: 'Keep `' + e.missingColumn + '` (edit step ' + (why.removedAt + 1) + ')', select: true });
            st.fixes.push({ kind: 'deleteStep', label: 'Delete this step' });
            st.missingColumn = e.missingColumn;
          }
          if (!(e instanceof StepError) && !(e instanceof PQ.FormulaError)) console.error(e);
          states.push(st);
          continue;
        }
      }
      if (table.meta && table.meta.truncated) truncated = true;
      states.push({ ok: true, rows: table.n, cols: table.cols.length, schema: table.schema(), ms: performance.now() - t0, cached: !!hit, truncated, fp: fps[i] });
    }
    return { table: failed >= 0 ? null : table, states, fp: fps[upto], truncated, failedAt: failed };
  }
  E.evaluate = evaluate;

  /* ================================ column quality & profile ================================ */
  E.quality = function (t) {
    return t.data.map((col) => {
      let err = 0, empty = 0;
      for (let i = 0; i < col.length; i++) { const v = col[i]; if (v === null || v === undefined || v === '') empty++; else if (isErr(v)) err++; }
      return { valid: t.n - err - empty, error: err, empty };
    });
  };

  E.profile = function (t, colName) {
    const col = t.get(colName), type = t.type(colName);
    let errors = 0, empty = 0, min = null, max = null, sum = 0, nnum = 0;
    const counts = new Map(), nums = [];
    let minLen = Infinity, maxLen = 0;
    for (const v of col) {
      if (v === null || v === undefined || v === '') { empty++; continue; }
      if (isErr(v)) { errors++; continue; }
      const k = keyOf(v);
      const c = counts.get(k); if (c) c.n++; else counts.set(k, { v, n: 1 });
      if (min === null || compareValues(v, min) < 0) min = v;
      if (max === null || compareValues(v, max) > 0) max = v;
      if (typeof v === 'number') { sum += v; nnum++; nums.push(v); }
      if (typeof v === 'string') { minLen = Math.min(minLen, v.length); maxLen = Math.max(maxLen, v.length); }
    }
    const top = [...counts.values()].sort((a, b) => b.n - a.n).slice(0, 12).map((x) => ({ value: wire(x.v), count: x.n }));
    let hist = null;
    if (nums.length && min !== max && typeof min === 'number') {
      const bins = 20, w = (max - min) / bins, h = new Array(bins).fill(0);
      nums.forEach((v) => { h[Math.min(bins - 1, Math.floor((v - min) / w))]++; });
      hist = { min, max, bins: h };
    }
    let stdev = null;
    if (nnum > 1) { const m = sum / nnum; stdev = Math.sqrt(nums.reduce((a, v) => a + (v - m) * (v - m), 0) / (nnum - 1)); }
    const unique = [...counts.values()].filter((x) => x.n === 1).length;
    return { col: colName, type, count: t.n, errors, empty, distinct: counts.size, unique, min: wire(min), max: wire(max), mean: nnum ? sum / nnum : null, stdev, minLen: minLen === Infinity ? null : minLen, maxLen: maxLen || null, top, hist };
  };

  /** Serialize a value for postMessage (CellError loses its prototype otherwise). */
  function wire(v) { return isErr(v) ? { __err: v.msg } : v === undefined ? null : v; }
  E.wire = wire;

  E.page = function (t, offset, count) {
    const end = Math.min(t.n, offset + count), rows = [];
    for (let r = offset; r < end; r++) { const row = new Array(t.data.length); for (let c = 0; c < t.data.length; c++) row[c] = wire(t.data[c][r]); rows.push(row); }
    return rows;
  };

  E.distinctValues = function (t, colName, limit) {
    const col = t.get(colName), seen = new Map();
    for (const v of col) { const k = keyOf(v); if (!seen.has(k)) { seen.set(k, { v: wire(v), n: 0 }); if (seen.size > (limit || 1000)) break; } seen.get(k).n++; }
    return [...seen.values()].sort((a, b) => compareValues(a.v && a.v.__err ? null : a.v, b.v && b.v.__err ? null : b.v, true)).map((x) => ({ value: x.v, count: x.n }));
  };

  /** Merge dialog: live match count + warnings (type mismatch, non-unique right keys). */
  E.mergeStats = function (left, right, on, how, castKeys) {
    const kf = castKeys ? textKey : keyOf;
    const warnings = [];
    on.forEach(([l, r]) => {
      if (!left.has(l) || !right.has(r)) return;
      const lt = left.type(l), rt = right.type(r);
      const numeric = (x) => x === 'int' || x === 'number';
      if (lt !== rt && !(numeric(lt) && numeric(rt)) && !castKeys) warnings.push({ kind: 'type', text: 'Key types differ: `' + l + '` is ' + PQ.TYPES[lt].label + ', `' + r + '` is ' + PQ.TYPES[rt].label + '. Rows may not match.', fix: 'castKeys' });
    });
    const valid = on.every(([l, r]) => left.has(l) && right.has(r));
    if (!valid || !on.length) return { matched: 0, total: left.n, rightTotal: right.n, rightMatched: 0, dupKeys: 0, warnings };
    const lk = on.map((p) => left.get(p[0])), rk = on.map((p) => right.get(p[1]));
    const key = (arrs, r) => { let k = ''; for (const a of arrs) { const v = a[r]; if (v === null || isErr(v)) return null; k += kf(v) + '\u001f'; } return k; };
    const rmap = new Map();
    for (let r = 0; r < right.n; r++) { const k = key(rk, r); if (k !== null) rmap.set(k, (rmap.get(k) || 0) + 1); }
    let dupKeys = 0, dupSample = null; rmap.forEach((n, k) => { if (n > 1) { dupKeys++; if (!dupSample) dupSample = k.split('\u001f')[0].slice(1); } });
    let matched = 0, outRows = 0;
    const usedRight = new Set();
    for (let r = 0; r < left.n; r++) { const k = key(lk, r); const n = k === null ? 0 : rmap.get(k) || 0; if (n) { matched++; outRows += n; usedRight.add(k); } else if (how === 'left' || how === 'full') outRows++; }
    let rightMatched = 0; usedRight.forEach((k) => (rightMatched += rmap.get(k)));
    if (dupKeys) warnings.push({ kind: 'dup', text: dupKeys + ' key value' + (dupKeys > 1 ? 's are' : ' is') + ' not unique on the right (e.g. "' + dupSample + '"). Matching rows will be duplicated — ' + PQ.fmtInt(outRows) + ' output rows from ' + PQ.fmtInt(left.n) + '.' });
    return { matched, total: left.n, rightTotal: right.n, rightMatched, dupKeys, outRows, warnings };
  };
})();
