(function () {
  const PQ = self.PQ, E = PQ.Engine, IO = PQ.IO;
  const { Table, StepError } = PQ;

  let hp = null, hpc = null;
  async function lib() {
    if (!hp && self.__floeModules) { hp = self.__floeModules.hyparquet; hpc = self.__floeModules.compressors; }
    if (!hp) [hp, hpc] = await Promise.all([import('../vendor/hyparquet.min.js'), import('../vendor/hyparquet-compressors.min.js')]);
    return hp;
  }
  const isParquet = (rec) => IO.fileKind(rec.name) === 'parquet';
  const dkey = (rec) => rec.id + ':' + rec.mtime + ':' + rec.size;
  const metas = new Map();
  const errors = new Map();
  let entries = [];
  const BUDGET = 30e6;
  IO.parquetLastRead = null;

  function byteSource(rec, stats) {
    if (rec.buf) {
      const b = rec.buf;
      return { byteLength: b.byteLength, slice(s, e) { const end = e === undefined ? b.byteLength : e; stats.bytes += end - s; return b.slice(s, end); } };
    }
    if (rec.blob) {
      const blob = rec.blob;
      return { byteLength: blob.size, slice(s, e) { const end = e === undefined ? blob.size : e; stats.bytes += end - s; return blob.slice(s, end).arrayBuffer(); } };
    }
    throw new StepError('Parquet file "' + rec.name + '" has no data. Re-add it.');
  }

  function floeType(el) {
    if (!el) return 'any';
    if (el.num_children) return 'text';
    const lt = el.logical_type && el.logical_type.type, ct = el.converted_type, pt = el.type;
    if (ct === 'DATE' || lt === 'DATE') return 'date';
    if (ct === 'TIMESTAMP_MILLIS' || ct === 'TIMESTAMP_MICROS' || lt === 'TIMESTAMP' || pt === 'INT96') return 'datetime';
    if (ct === 'TIME_MILLIS' || ct === 'TIME_MICROS' || lt === 'TIME') return 'any';
    if (ct === 'DECIMAL' || lt === 'DECIMAL' || pt === 'FLOAT' || pt === 'DOUBLE' || lt === 'FLOAT16') return 'number';
    if (pt === 'BOOLEAN') return 'bool';
    if (pt === 'INT32' || pt === 'INT64') return 'int';
    if (pt === 'BYTE_ARRAY' || pt === 'FIXED_LEN_BYTE_ARRAY') return 'text';
    return 'any';
  }
  PQ.parquetType = floeType;

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
    for (let i = 0; i < n; i++) {
      const v = c[i], t = typeof v;
      c[i] = t === 'string' || t === 'boolean' ? v : t === 'number' ? (v - v === 0 ? v : null) : norm(v);
    }
    return c;
  }
  function typeOf(el, col) {
    const t = floeType(el);
    if (t === 'datetime') return PQ.valuesType(col) === 'date' ? 'date' : 'datetime';
    if (t === 'any' || (t === 'text' && el && el.num_children)) { const v = PQ.valuesType(col); return v === 'any' ? 'text' : v; }
    return t;
  }

  async function meta(rec) {
    const k = dkey(rec);
    if (metas.has(k)) return metas.get(k);
    await lib();
    const stats = { bytes: 0 };
    const metadata = await hp.parquetMetadataAsync(byteSource(rec, stats));
    const children = hp.parquetSchema(metadata).children;
    const raw = children.map((c) => c.element.name);
    const disp = PQ.uniquify(raw);
    const m = {
      metadata, raw, disp, numRows: Number(metadata.num_rows),
      rawOf: new Map(disp.map((d, i) => [d, raw[i]])),
      el: new Map(disp.map((d, i) => [d, children[i].element])),
      groups: metadata.row_groups.map((g) => Number(g.num_rows)),
      codec: (() => { const c = metadata.row_groups[0] && metadata.row_groups[0].columns[0] && metadata.row_groups[0].columns[0].meta_data; return c ? c.codec : null; })(),
      metaBytes: stats.bytes,
    };
    for (const key of [...metas.keys()]) if (key.split(':')[0] === rec.id) metas.delete(key);
    metas.set(k, m);
    return m;
  }

  const cellsOf = (e) => e.rows * Math.max(1, e.data.size);
  function evict() {
    let total = entries.reduce((s, e) => s + cellsOf(e), 0);
    while (entries.length > 1 && (entries.length > 10 || total > BUDGET)) { const e = entries.shift(); total -= cellsOf(e); }
  }
  function touch(e) { const i = entries.indexOf(e); if (i >= 0) { entries.splice(i, 1); entries.push(e); } }
  function covering(k, cols, n) {
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.k !== k || e.rows < n) continue;
      if (cols.every((c) => e.data.has(c))) return e;
    }
    return null;
  }

  /** Rows left after skipping pruned row groups. */
  const keptRows = (m, skip) => { if (!skip || !skip.length) return m.numRows; let s = m.numRows; for (const g of skip) s -= m.groups[g] || 0; return s; };

  async function readColumns(rec, m, cols, n, progress, skip) {
    await lib();
    const stats = { bytes: 0, groups: 0 };
    const skipSet = new Set(skip || []);
    const data = new Map(cols.map((c) => [c, new Array(n)]));
    if (cols.length && n > 0) {
      const file = byteSource(rec, stats);
      const rawCols = cols.map((c) => m.rawOf.get(c));
      const byRaw = new Map(cols.map((c) => [m.rawOf.get(c), data.get(c)]));
      // Plan: which row groups to read, where they start in the file and how many rows to take.
      const plan = [];
      let fileStart = 0, need = n;
      for (let g = 0; g < m.groups.length && need > 0; g++) {
        const gn = m.groups[g];
        if (gn > 0 && !skipSet.has(g)) { const take = Math.min(gn, need); plan.push({ fileStart, take }); need -= take; }
        fileStart += gn;
      }
      let out = 0;
      for (let i = 0; i < plan.length; i++) {
        const s0 = plan[i].fileStart, end = s0 + plan[i].take, base = out;
        if (progress && plan.length > 1) progress({ stage: 'Reading ' + rec.name + ' · row group ' + (i + 1) + ' of ' + plan.length + (cols.length < m.disp.length ? ' · ' + cols.length + ' of ' + m.disp.length + ' columns' : '') });
        await hp.parquetRead({
          file, metadata: m.metadata, columns: rawCols, rowStart: s0, rowEnd: end, compressors: hpc.compressors,
          onChunk: ({ columnName, columnData, rowStart }) => {
            const dst = byRaw.get(columnName);
            if (!dst) return;
            const from = Math.max(0, s0 - rowStart), to = Math.min(columnData.length, end - rowStart);
            const off = base + rowStart - s0;
            for (let j = from; j < to; j++) dst[off + j] = columnData[j];
          },
        });
        stats.groups++;
        out += plan[i].take;
      }
    }
    const types = new Map();
    data.forEach((arr, c) => { normColumn(arr, n); types.set(c, typeOf(m.el.get(c), arr)); });
    IO.parquetLastRead = { file: rec.name, columns: cols.slice(), totalColumns: m.disp.length, rows: n, rowGroups: stats.groups, totalRowGroups: m.groups.length, skippedRowGroups: skipSet.size, bytes: stats.bytes, size: rec.size };
    return { data, types };
  }

  async function ensure(rec, pl, rows, progress) {
    const k = pl.key, m = pl.m, cols = pl.cols;
    const n = Math.min(rows, keptRows(m, pl.skip));
    if (covering(k, cols, n)) { touch(covering(k, cols, n)); return; }
    const same = entries.filter((e) => e.k === k && e.rows === n).pop();
    if (same) {
      const missing = cols.filter((c) => !same.data.has(c));
      const r = await readColumns(rec, m, missing, n, progress, pl.skip);
      r.data.forEach((v, c) => same.data.set(c, v));
      r.types.forEach((v, c) => same.types.set(c, v));
      touch(same);
    } else {
      const r = await readColumns(rec, m, cols, n, progress, pl.skip);
      const e = { k, rows: n, data: r.data, types: r.types };
      entries = entries.filter((x) => !(x.k === k && x.rows <= n && [...x.data.keys()].every((c) => e.data.has(c))));
      entries.push(e);
    }
    evict();
  }

  function namespace(m, spec) {
    const want = spec && Array.isArray(spec.columns) && spec.columns.length ? spec.columns : null;
    if (!want) return m.disp;
    const miss = want.find((c) => !m.el.has(c));
    if (miss !== undefined) throw new StepError('Column `' + miss + '` is no longer in this Parquet file', { fixes: [{ kind: 'relink', label: 'Pick a replacement file' }] });
    return want.slice();
  }

  const lastIndex = (q, upto) => { const L = q.steps.length - 1; return upto === undefined || upto === null || upto > L ? L : upto; };
  const cand = (space, base) => [...space].filter((n) => n === base || (n.startsWith(base + '_') && /^\d+$/.test(n.slice(base.length + 1))));
  const pref = (space, p) => [...space].filter((n) => n.startsWith(p));
  const fcols = (f) => [...PQ.Formula.columns(f || 'null')];

  function projection(q, upto, ns) {
    const last = lastIndex(q, upto);
    if (!q || last < 1) return null;
    const steps = q.steps;
    const spaces = [new Set(ns)];
    for (let i = 1; i <= last; i++) {
      const s = steps[i], k = s.kind || {}, cur = spaces[i - 1];
      let nx = cur;
      if (!s.disabled) {
        if (k.type === 'Rename') { const mp = new Map(k.map || []); nx = new Set([...cur].map((n) => (mp.has(n) ? mp.get(n) : n))); }
        else if (k.type === 'SelectColumns' || k.type === 'RemoveOtherColumns') nx = new Set((k.cols || []).filter((c) => cur.has(c)));
        else if (k.type === 'RemoveColumns') { const d = new Set(k.cols || []); nx = new Set([...cur].filter((n) => !d.has(n))); }
        else if (k.type === 'GroupBy') nx = new Set((k.keys || []).filter((c) => cur.has(c)));
        else if (k.type === 'Pivot' && k.index && k.index.length) nx = new Set(k.index.filter((c) => cur.has(c)));
        else if (k.type === 'Unpivot' && k.ids && k.ids.length) nx = new Set(k.ids.filter((c) => cur.has(c)));
      }
      spaces[i] = nx;
    }
    let all = true, V = new Set(), X = new Set();
    const D = new Set();
    const val = (cs) => cs.forEach((c) => { if (c === null || c === undefined || c === '') return; if (all) D.delete(c); else { V.add(c); X.delete(c); } });
    const ex = (cs) => { if (!all) cs.forEach((c) => { if (!V.has(c)) X.add(c); }); };
    const toSet = (vals, exs) => { all = false; V = new Set(vals.filter((c) => c !== null && c !== undefined)); X = new Set(exs.filter((c) => !V.has(c))); };
    for (let i = last; i >= 1; i--) {
      const s = steps[i];
      if (s.disabled) continue;
      const k = s.kind || {}, sp = spaces[i - 1];
      switch (k.type) {
        case 'SelectColumns': case 'RemoveOtherColumns': { const cols = k.cols || []; toSet(all ? cols.filter((c) => !D.has(c)) : cols.filter((c) => V.has(c)), cols); break; }
        case 'ReorderColumns': ex(k.cols || []); break;
        case 'RemoveColumns': if (all) (k.cols || []).forEach((c) => D.add(c)); else ex(k.cols || []); break;
        case 'Rename': {
          const mp = k.map || [];
          const back = new Map(mp.map(([o, nn]) => [nn, o]));
          const olds = new Set(mp.map((p) => p[0]));
          const mapName = (n) => (back.has(n) ? back.get(n) : olds.has(n) ? null : n);
          const remap = (set) => new Set([...set].map(mapName).filter((x) => x !== null));
          if (all) { const nd = remap(D); D.clear(); nd.forEach((x) => D.add(x)); }
          else { V = remap(V); X = remap(X); }
          ex([...olds]);
          ex(mp.map((p) => p[1]).filter((nn) => sp.has(nn) && !olds.has(nn)));
          break;
        }
        case 'ChangeType': { const ch = k.changes || []; val(ch.map((c) => c.col)); if (k.onError === 'keep') ch.forEach((c) => ex(cand(sp, c.col + '_error'))); break; }
        case 'Filter': val(fcols(E.filterFormula(k))); break;
        case 'Sort': val((k.by || []).map((b) => b.col)); break;
        case 'Distinct': case 'KeepDuplicates': if (!k.subset || !k.subset.length) return null; val(k.subset); break;
        case 'KeepRows': if (k.mode === 'remove_blank') return null; break;
        case 'Sample': case 'Checkpoint': break;
        case 'FillDown': case 'FillUp': case 'ReplaceValues': case 'ReplaceErrors': case 'TextTransform': case 'RoundNumbers': val(k.cols || []); break;
        case 'RemoveErrors': case 'KeepErrors': if (!k.cols || !k.cols.length) return null; val(k.cols); break;
        case 'ClusterValues': val([k.col]); break;
        case 'SplitColumn': val([k.col]); ex(pref(sp, k.col + '.')); break;
        case 'MergeColumns': val(k.cols || []); ex(cand(sp, k.name || 'Merged')); break;
        case 'AddColumn': case 'ConditionalColumn': {
          const f = k.type === 'AddColumn' ? k.formula : E.conditionalToFormula(k);
          if (!all && k.name) { V.delete(k.name); X.add(k.name); }
          else if (all && k.name) D.add(k.name);
          val(fcols(f));
          break;
        }
        case 'IndexColumn': ex(cand(sp, k.name || 'Index')); break;
        case 'DuplicateColumn': val([k.col]); ex(cand(sp, k.name || k.col + ' - Copy')); break;
        case 'Window': val([k.col, k.orderBy].concat(k.partition || [])); ex(cand(sp, k.name || k.op)); break;
        case 'Validate': val((k.rules || []).map((r) => r.col)); ex(cand(sp, k.name || 'Issues')); break;
        case 'ExpandJson': val([k.col]); ex(pref(sp, k.col + '.')); break;
        case 'GroupBy': toSet((k.keys || []).concat((k.aggs || []).filter((a) => a.fn !== 'count_rows').map((a) => a.col)), []); break;
        case 'Unpivot': if (!(k.ids && k.ids.length) || !(k.values && k.values.length)) return null; toSet(k.ids.concat(k.values), []); break;
        case 'Pivot': if (!(k.index && k.index.length)) return null; toSet(k.index.concat([k.on, k.values]), []); break;
        case 'Merge': {
          val((k.on || []).map((p) => p[0]));
          if (k.how === 'semi' || k.how === 'anti') break;
          if (k.expand && k.expand.length) k.expand.forEach((c) => ex(cand(sp, k.prefix ? k.prefix + '.' + c : c)));
          else ex([...sp]);
          break;
        }
        case 'Append': if (k.mode === 'strict') return null; break;
        default: return null;
      }
    }
    const cols = all ? ns.filter((n) => !D.has(n)) : ns.filter((n) => V.has(n));
    const stubs = all ? ns.filter((n) => D.has(n)) : ns.filter((n) => X.has(n) && !V.has(n));
    if (cols.length === ns.length) return null;
    return { cols, stubs };
  }
  IO.parquetProjection = projection;

  /* ---------- Row-group pruning from Filter steps (full runs only) ----------
   * A row group is skipped only when its column-chunk min/max statistics prove that no row can make
   * a leading Filter return true. Only Filters preceded by column-only steps (select/remove/reorder) count,
   * so the filtered result is identical to an unpruned run. Supported: = <> < <= > >= and `in` between a
   * column and a constant (literal, parameter or constant expression), combined with and/or, on int,
   * number, ASCII text and date columns. Anything else simply isn't used for pruning. */
  const PRUNE_PASS = new Set(['SelectColumns', 'RemoveColumns', 'ReorderColumns', 'RemoveOtherColumns']);
  const ascii = (s) => typeof s === 'string' && /^[\x00-\x7f]*$/.test(s);
  const statVal = (v) => (typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? (Number.isNaN(v) ? undefined : v) : typeof v === 'string' || v instanceof Date ? v : undefined);

  function colRange(m, g, raw) {
    const rg = m.metadata.row_groups[g];
    const ch = rg && rg.columns.find((c) => c.meta_data && c.meta_data.path_in_schema.length === 1 && c.meta_data.path_in_schema[0] === raw);
    const st = ch && ch.meta_data.statistics;
    if (!st) return null;
    const bytes = ch.meta_data.type === 'BYTE_ARRAY' || ch.meta_data.type === 'FIXED_LEN_BYTE_ARRAY';
    let lo = st.min_value, hi = st.max_value;
    if (!bytes) { if (lo === undefined) lo = st.min; if (hi === undefined) hi = st.max; }
    lo = statVal(lo); hi = statVal(hi);
    const nulls = st.null_count === undefined ? undefined : Number(st.null_count);
    return lo === undefined || hi === undefined ? null : { lo, hi, nulls, exact: !bytes, float: ch.meta_data.type === 'FLOAT' || ch.meta_data.type === 'DOUBLE' };
  }

  /** Compare a constant with a statistic of the same kind; undefined when kinds don't match. */
  function kindCmp(t, a, b) {
    if (t === 'int' || t === 'number') return typeof a === 'number' && typeof b === 'number' && isFinite(a) ? a - b : undefined;
    if (t === 'text') return ascii(a) && ascii(b) ? (a < b ? -1 : a > b ? 1 : 0) : undefined;
    if (t === 'date') return a instanceof Date && b instanceof Date && !isNaN(a) ? a.getTime() - b.getTime() : undefined;
    return undefined;
  }

  function pruning(q, upto, ns, m, cols) {
    const last = lastIndex(q, upto);
    const forms = [];
    for (let i = 1; i <= last; i++) {
      const s = q.steps[i];
      if (!s || s.disabled) continue;
      const k = s.kind || {};
      if (k.type === 'Filter') { const f = E.filterFormula(k); if (f && f.trim() !== 'true') forms.push(f); continue; }
      if (PRUNE_PASS.has(k.type)) continue;
      break;
    }
    if (!forms.length || m.groups.length < 2) return null;
    // Timestamp / nested / untyped columns get their type from the values read; skipping rows could change it.
    for (const c of cols) {
      const el = m.el.get(c), t = floeType(el);
      if (!el || el.num_children || t === 'datetime' || t === 'any') return null;
    }
    const nsSet = new Set(ns);
    const project = E.getProject && E.getProject();
    const params = (project && project.params) || [];
    const one = Table.fromRows(['__c'], [[null]], ['any']);
    const asts = [];
    for (const f of forms) { try { asts.push({ src: f, ast: PQ.Formula.parse(f) }); } catch (e) { /* unparseable: no pruning from it */ } }
    const ranges = new Map();
    const rangeOf = (name, g) => {
      const key = name + '\u0001' + g;
      if (!ranges.has(key)) ranges.set(key, nsSet.has(name) && m.rawOf.has(name) ? colRange(m, g, m.rawOf.get(name)) : null);
      return ranges.get(key);
    };
    const hasCol = (n) => { let found = false; (function walk(x) { if (!x || typeof x !== 'object' || found) return; if (x.k === 'col') { found = true; return; } Object.values(x).forEach((v) => (Array.isArray(v) ? v.forEach(walk) : typeof v === 'object' && walk(v))); })(n); return found; };
    const constOf = (src, n) => {
      if (n.k === 'lit') return n.v;
      if (hasCol(n)) return undefined;
      try { const v = PQ.Formula.evaluate(src.slice(n.s, n.e), one, params).values[0]; return PQ.isErr(v) ? undefined : v; } catch (e) { return undefined; }
    };
    const FLIP = { '<': '>', '>': '<', '<=': '>=', '>=': '<=', '=': '=', '<>': '<>' };
    function skips(src, n, g) {
      if (!n || n.k !== 'bin') return false;
      if (n.op === 'and') return skips(src, n.a, g) || skips(src, n.b, g);
      if (n.op === 'or') return skips(src, n.a, g) && skips(src, n.b, g);
      if (n.op === 'in') {
        if (n.a.k !== 'col' || n.b.k !== 'list' || !n.b.items.length) return false;
        const r = rangeOf(n.a.name, g), t = floeType(m.el.get(n.a.name));
        if (!r) return false;
        return n.b.items.every((it) => {
          const v = constOf(src, it);
          const lo = kindCmp(t, v, r.lo), hi = kindCmp(t, v, r.hi);
          return lo !== undefined && hi !== undefined && (lo < 0 || hi > 0);
        });
      }
      if (!FLIP[n.op]) return false;
      let col, other, op = n.op;
      if (n.a.k === 'col') { col = n.a; other = n.b; }
      else if (n.b.k === 'col') { col = n.b; other = n.a; op = FLIP[op]; }
      else return false;
      const r = rangeOf(col.name, g);
      if (!r) return false;
      const t = floeType(m.el.get(col.name));
      const v = constOf(src, other);
      const cLo = kindCmp(t, v, r.lo), cHi = kindCmp(t, v, r.hi);
      if (cLo === undefined || cHi === undefined) return false;
      switch (op) {
        case '=': return cLo < 0 || cHi > 0;
        case '<>': return cLo === 0 && cHi === 0 && r.nulls === 0 && r.exact && !r.float; // nulls (and NaN) pass <>
        case '<': return cLo <= 0;   // every value >= min >= v
        case '<=': return cLo < 0;   // every value >= min > v
        case '>': return cHi >= 0;   // every value <= max <= v
        case '>=': return cHi > 0;   // every value <= max < v
      }
      return false;
    }
    const skip = [];
    for (let g = 0; g < m.groups.length; g++) {
      if (!m.groups[g]) continue;
      if (asts.some((a) => skips(a.src, a.ast, g))) skip.push(g);
    }
    return skip.length ? skip : null;
  }
  IO.parquetPruning = pruning;

  function planFor(rec, spec, q, upto, full) {
    const m = metas.get(dkey(rec));
    if (!m) return null;
    const ns = namespace(m, spec);
    const p = q ? projection(q, upto, ns) : null;
    const cols = p ? p.cols : ns;
    const skip = full && q ? pruning(q, upto, ns, m, cols) : null;
    return { m, ns, cols, stubs: p ? p.stubs : [], projected: !!p, skip, key: dkey(rec) + (skip ? '|skip:' + skip.join(',') : '') };
  }

  const baseRead = IO.readFile;
  IO.readFile = function (rec, spec, maxRows, ctx) {
    const kind = (spec && spec.format) || IO.fileKind(rec.name);
    if (kind !== 'parquet') return baseRead(rec, spec || {}, maxRows, ctx);
    const k = dkey(rec);
    if (errors.has(k)) throw new StepError('Could not read Parquet file "' + rec.name + '": ' + errors.get(k));
    const want = maxRows === undefined || maxRows === null ? Infinity : maxRows;
    const pl = planFor(rec, spec, ctx && ctx.query, ctx && ctx.upto, !!(ctx && ctx.mode === 'full') && want === Infinity);
    if (!pl) throw new StepError('Parquet file "' + rec.name + '" is still being read. Refresh in a moment.');
    const { m, ns } = pl;
    const total = keptRows(m, pl.skip);
    const n = Math.min(want, total);
    const e = covering(pl.key, pl.cols, n);
    if (!e) throw new StepError('Parquet file "' + rec.name + '" is still being read. Refresh in a moment.');
    touch(e);
    const valueSet = new Set(pl.cols), stubSet = new Set(pl.stubs);
    let nulls = null;
    const cols = [], data = [];
    for (const name of ns) {
      if (valueSet.has(name)) {
        const a = e.data.get(name);
        data.push(e.rows > n ? a.slice(0, n) : a);
        cols.push({ name, type: e.types.get(name) });
      } else if (stubSet.has(name)) {
        if (!nulls) nulls = new Array(n).fill(null);
        data.push(nulls);
        cols.push({ name, type: floeType(m.el.get(name)) === 'datetime' ? 'datetime' : floeType(m.el.get(name)) });
      }
    }
    const t = new Table(cols, data, n);
    t.meta = { format: 'parquet', rowGroups: m.groups.length, createdBy: m.metadata.created_by || null, truncated: n < total };
    if (pl.projected) t.meta.projected = { read: pl.cols.length, of: m.disp.length };
    if (pl.skip) t.meta.skippedRowGroups = pl.skip.length;
    return t;
  };

  E.sourceVariant = function (src, q, upto, mode) {
    if (!src) return '';
    const one = (rec) => {
      if (!rec || !isParquet(rec) || (src.format && src.format !== 'parquet')) return '';
      let pl;
      try { pl = planFor(rec, src, q, upto, mode === 'full'); } catch (e) { return '|pq!'; }
      if (!pl) return '|pq?';
      return (pl.projected ? '|pq:' + pl.cols.join('\u0001') + '/' + pl.stubs.join('\u0001') : '') + (pl.skip ? '|skip:' + pl.skip.join(',') : '');
    };
    if (src.kind === 'file') return one(PQ.Files.get(src.fileId));
    if (src.kind === 'folder') {
      const re = PQ.globToRegex(src.pattern || '*');
      return [...PQ.Files.values()].filter((f) => (f.folder || '') === src.folder && re.test(f.name)).map(one).join('');
    }
    return '';
  };

  IO.decodeParquet = async function (rec) {
    const m = await meta(rec);
    await ensure(rec, { m, cols: m.disp, key: dkey(rec), skip: null }, m.numRows);
    return IO.readFile(rec, { format: 'parquet' }, Infinity);
  };

  const baseInspect = IO.inspectFile;
  IO.inspectFile = function (rec) {
    if (!isParquet(rec)) return baseInspect(rec);
    const k = dkey(rec);
    if (errors.has(k)) throw new StepError('Could not read Parquet file "' + rec.name + '": ' + errors.get(k));
    const m = metas.get(k);
    if (!m) throw new StepError('Parquet file "' + rec.name + '" is still being read.');
    const t = IO.readFile(rec, { format: 'parquet' }, 40);
    const schema = m.disp.map((d) => ({ name: d, type: t.has(d) ? t.type(d) : floeType(m.el.get(d)) }));
    return {
      kind: 'parquet', rows: m.numRows, cols: m.disp.length, schema,
      meta: { format: 'parquet', rowGroups: m.groups.length, createdBy: m.metadata.created_by || null, codec: m.codec, size: rec.size, lazy: !rec.buf },
      preview: [t.names].concat(t.toRows(39).map((r) => r.map((v) => (PQ.isErr(v) ? '#ERR' : PQ.fmtValue(v))))),
    };
  };

  function seedsFor(msg, project) {
    const s = [];
    const mode = msg.mode || 'preview';
    const all = () => (project.queries || []).forEach((q) => { if (q.load && q.load.target && q.load.target !== 'none') s.push([q.id, undefined, 'full']); });
    switch (msg.op) {
      case 'evaluate': s.push([msg.qid, msg.upto, mode]); break;
      case 'clusters': s.push([msg.qid, msg.upto, mode]); break;
      case 'schemaBefore': if (msg.index > 0) s.push([msg.qid, msg.index - 1, 'preview']); break;
      case 'mergeStats': s.push([msg.qid, msg.upto, 'preview']); if (msg.right) s.push([msg.right, undefined, 'preview']); break;
      case 'querySchema': s.push([msg.qid, undefined, 'preview']); break;
      case 'exportQuery': s.push([msg.qid, undefined, 'full']); break;
      case 'refreshAll': all(); break;
    }
    return s;
  }

  function targetsFor(msg, ids) {
    const out = [];
    const base = E.getProject();
    if (!msg) {
      PQ.Files.forEach((rec) => { if (isParquet(rec) && (!ids || ids.has(rec.id))) out.push({ rec, spec: null, rows: Infinity }); });
      return out;
    }
    if (msg.op === 'inspectFile') { const rec = PQ.Files.get(msg.fileId); if (rec && isParquet(rec)) out.push({ rec, spec: null, rows: 40 }); return out; }
    if (msg.op === 'suggestSteps') {
      const src = msg.source || {};
      if (src.kind === 'folder') {
        const re = PQ.globToRegex(src.pattern || '*');
        PQ.Files.forEach((rec) => { if (isParquet(rec) && (rec.folder || '') === src.folder && re.test(rec.name)) out.push({ rec, spec: src, rows: 2000 }); });
      }
      return out;
    }
    if (!base) return out;
    const project = PQ.Host && PQ.Host.withDraft ? PQ.Host.withDraft(base, msg.draft) : base;
    E.setProject(project);
    try {
      const seen = new Set();
      const queue = seedsFor(msg, project);
      while (queue.length) {
        const [qid, upto, mode] = queue.shift();
        const q = E.query(qid);
        if (!q) continue;
        const last = lastIndex(q, upto);
        const key = q.id + '|' + last + '|' + mode;
        if (seen.has(key)) continue;
        seen.add(key);
        const rows = mode === 'preview' ? (project.settings && project.settings.previewRows) || 1000 : Infinity;
        const first = q.steps[0];
        const src = first && first.kind && first.kind.type === 'Source' ? first.kind.source : null;
        const add = (rec) => { if (rec && isParquet(rec) && (!src.format || src.format === 'parquet')) out.push({ rec, spec: src, rows, q, upto: last }); };
        if (src && src.kind === 'file') add(PQ.Files.get(src.fileId));
        if (src && src.kind === 'folder') {
          const re = PQ.globToRegex(src.pattern || '*');
          PQ.Files.forEach((rec) => { if ((rec.folder || '') === src.folder && re.test(rec.name)) add(rec); });
        }
        for (let i = 0; i <= last; i++) {
          const st = q.steps[i];
          if (!st || (st.disabled && i > 0)) continue;
          E.refsOf(st).forEach((r) => queue.push([r, undefined, mode]));
        }
      }
    } finally { E.setProject(base); }
    return out;
  }

  IO.prepare = async function (ids, msg, progress) {
    const targets = targetsFor(msg, ids);
    for (const tg of targets) {
      const k = dkey(tg.rec);
      if (errors.has(k)) continue;
      try {
        await meta(tg.rec);
        const project = msg && msg.draft && PQ.Host && PQ.Host.withDraft ? PQ.Host.withDraft(E.getProject(), msg.draft) : null;
        let q = tg.q;
        if (q && project) q = project.queries.find((x) => x.id === q.id) || q;
        const pl = planFor(tg.rec, tg.spec, q, tg.upto, tg.rows === Infinity && !!q);
        await ensure(tg.rec, pl, tg.rows, progress);
      } catch (e) {
        if (e instanceof StepError && /no longer in this Parquet file/.test(e.message)) continue;
        errors.set(k, e.message || String(e));
      }
    }
  };
  if (PQ.Host) {
    const inner = PQ.Host.handle;
    const fmtMB = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');
    PQ.Host.handle = async function (msg, progress) {
      if (msg.op === 'evaluate') IO.parquetLastRead = null;
      const out = await inner(msg, progress);
      if (msg.op === 'evaluate' && out && IO.parquetLastRead && !msg.draft) {
        const r = IO.parquetLastRead;
        out.note = 'Parquet ' + r.file + ': read ' + r.columns.length + ' of ' + r.totalColumns + ' columns, ' + r.rowGroups + ' of ' + r.totalRowGroups + ' row group' + (r.totalRowGroups === 1 ? '' : 's') + (r.skippedRowGroups ? ' (' + r.skippedRowGroups + ' skipped by filter statistics)' : '') + ', ' + fmtMB(r.bytes) + ' of ' + fmtMB(r.size);
        out.parquet = r;
      }
      return out;
    };
  }
  IO.parquetCacheInfo = () => ({ entries: entries.length, cells: entries.reduce((s, e) => s + cellsOf(e), 0), files: metas.size });
  IO.parquetForget = (id) => {
    entries = entries.filter((e) => e.k.split(':')[0] !== id);
    for (const key of [...metas.keys()]) if (key.split(':')[0] === id) metas.delete(key);
    for (const key of [...errors.keys()]) if (key.split(':')[0] === id) errors.delete(key);
  };
})();
