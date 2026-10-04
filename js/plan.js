(function () {
  const PQ = self.PQ;
  const Plan = (PQ.Plan = { VERSION: 1 });

  const FUNCS = new Set(['Text.Upper', 'Text.Lower', 'Text.Trim', 'Text.Length', 'Text.Start', 'Text.End', 'Text.Middle', 'Text.Contains', 'Text.StartsWith', 'Text.EndsWith', 'Text.Replace', 'Text.From', 'Text.Combine', 'Text.PadStart', 'Text.PadEnd', 'Text.RegexMatch', 'Text.RegexReplace', 'Number.Round', 'Number.RoundUp', 'Number.RoundDown', 'Number.Abs', 'Number.Mod', 'Number.Power', 'Number.Sqrt', 'Number.From', 'Date.Year', 'Date.Month', 'Date.Day', 'Date.Quarter', 'Date.DayOfWeek', 'Date.AddDays', '#date', 'Coalesce', 'Value.IsNull', 'List.Contains']);
  Plan.FUNCS = FUNCS;
  const TEXT_OPS = new Set(['upper', 'lower', 'trim', 'clean']);
  const WINDOW_OPS = new Set(['cumsum', 'row_number', 'rank', 'lag', 'lead', 'pct_of_total', 'moving_avg']);
  const AGGS = new Set(['count_rows', 'count', 'count_distinct', 'sum', 'mean', 'median', 'min', 'max', 'first', 'last', 'concat']);
  const PIVOT_AGGS = new Set(['sum', 'mean', 'count_rows', 'min', 'max', 'first', 'last', 'median']);

  class Refuse extends Error { }
  const refuse = (msg) => { throw new Refuse(msg); };

  function litValue(v) {
    if (v instanceof Date) return { d: v.getTime() };
    return v === undefined ? null : v;
  }

  function expr(src, params, where) {
    let ast;
    try { ast = PQ.Formula.parse(src); } catch (e) { refuse(where + ': formula error'); }
    const pmap = new Map((params || []).map((p) => [p.name, p]));
    const go = (n) => {
      switch (n.k) {
        case 'lit': return { k: 'lit', v: litValue(n.v) };
        case 'col': return { k: 'col', name: n.name };
        case 'param': {
          const p = pmap.get(n.name);
          const v = p ? PQ.paramValue(p) : null;
          if (Array.isArray(v)) return { k: 'list', items: v.map((x) => ({ k: 'lit', v: x })) };
          return { k: 'lit', v: litValue(v) };
        }
        case 'list': return { k: 'list', items: n.items.map(go) };
        case 'un': return { k: 'un', op: n.op, a: go(n.a) };
        case 'if': return { k: 'if', c: go(n.c), a: go(n.a), b: go(n.b) };
        case 'try': return { k: 'try', a: go(n.a), b: go(n.b) };
        case 'bin': return { k: 'bin', op: n.op, a: go(n.a), b: go(n.b) };
        case 'call':
          if (!FUNCS.has(n.fn)) refuse('Formula function ' + n.fn + ' isn’t supported by Polars yet');
          return { k: 'call', fn: n.fn, args: n.args.map(go) };
      }
      refuse(where + ': unsupported formula');
    };
    return go(ast);
  }

  function source(src, ctx) {
    if (!src) refuse('This query has no source');
    if (src.kind === 'blank') return { kind: 'blank', columns: PQ.uniquify(src.columns || ['Column1']), rows: (src.rows || []).map((r) => r.map((v) => (v === '' || v === undefined ? null : v === null ? null : String(v)))) };
    if (src.kind === 'query') return { kind: 'query', plan: ctx.sub(src.query) };
    if (src.kind === 'folder') refuse('Folder sources run on the built-in engine');
    if (src.kind !== 'file') refuse('Unsupported source');
    const path = ctx.files[src.fileId];
    if (!path) refuse('“' + (src.fileName || 'file') + '” isn’t linked to a file on disk');
    const kind = src.format || PQ.IO.fileKind(src.fileName || path);
    if (kind === 'csv') {
      const c = src.csv || {};
      if (c.encoding && !/^utf-?8/i.test(c.encoding)) refuse('Non-UTF-8 CSV files run on the built-in engine');
      return { kind: 'csv', path, delimiter: c.delimiter || null, header: c.header !== false, skipRows: +c.skipRows || 0 };
    }
    if (kind === 'parquet') return src.columns && src.columns.length ? { kind: 'parquet', path, columns: src.columns.slice() } : { kind: 'parquet', path };
    if (kind === 'arrow') return { kind: 'ipc', path };
    if (kind === 'excel') {
      const it = src.item || { type: 'sheet', name: 0 };
      if (src.fillMerged) refuse('Merged-cell fill runs on the built-in engine');
      if (it.type === 'sheet') return { kind: 'excel', path, sheet: it.sheet !== undefined ? it.sheet : it.name, range: null };
      if (it.type === 'range') return { kind: 'excel', path, sheet: it.sheet || it.name, range: it.range || null };
      refuse(it.type === 'table' ? 'Excel tables run on the built-in engine' : it.type === 'name' ? 'Named ranges run on the built-in engine' : 'Multi-sheet sources run on the built-in engine');
    }
    refuse((kind === 'json' ? 'JSON' : 'This file type') + ' runs on the built-in engine');
  }

  function op(k, ctx) {
    const P = ctx.params;
    switch (k.type) {
      case 'SelectColumns': case 'RemoveOtherColumns': return { op: 'select', cols: k.cols || [] };
      case 'ReorderColumns': return { op: 'reorder', cols: k.cols || [] };
      case 'RemoveColumns': return { op: 'drop', cols: k.cols || [] };
      case 'Rename': return { op: 'rename', map: k.map || [] };
      case 'ChangeType': return { op: 'cast', onError: k.onError || 'error', changes: (k.changes || []).map((c) => ({ col: c.col, type: c.type, locale: c.locale || k.locale || ctx.locale })) };
      case 'Filter': { const f = PQ.Engine.filterFormula(k); return f.trim() === 'true' ? null : { op: 'filter', expr: expr(f, P, 'Filter') }; }
      case 'Sort': return { op: 'sort', by: (k.by || []).map((b) => ({ col: b.col, desc: !!b.desc, nullsLast: b.nullsLast !== false })) };
      case 'Distinct': return { op: 'distinct', subset: k.subset && k.subset.length ? k.subset : null };
      case 'KeepDuplicates': return { op: 'keepDuplicates', subset: k.subset && k.subset.length ? k.subset : null };
      case 'KeepRows': return { op: 'slice', mode: k.mode, n: Math.max(0, +k.n || 0), offset: Math.max(0, +k.offset || 0), keep: Math.max(1, +k.keep || 1), skip: Math.max(0, k.skip === undefined ? 1 : +k.skip || 0) };
      case 'PromoteHeaders': return { op: 'promoteHeaders', row: Math.max(0, +k.row || 0) };
      case 'FillDown': return { op: 'fill', cols: k.cols || [], dir: 'down' };
      case 'FillUp': return { op: 'fill', cols: k.cols || [], dir: 'up' };
      case 'ReplaceValues': return { op: 'replace', cols: k.cols || [], find: k.find === undefined || k.find === '' ? null : k.find, replace: k.replace === undefined || k.replace === '' ? null : k.replace, wholeCell: k.wholeCell !== false };
      case 'ReplaceErrors': return { op: 'replaceErrors', cols: k.cols || [], value: k.value === undefined || k.value === '' ? null : k.value };
      case 'RemoveErrors': return { op: 'errors', cols: k.cols || [], keep: false };
      case 'KeepErrors': return { op: 'errors', cols: k.cols || [], keep: true };
      case 'TextTransform': if (!TEXT_OPS.has(k.op)) refuse('Text transform “' + k.op + '” runs on the built-in engine'); return { op: 'text', cols: k.cols || [], fn: k.op };
      case 'RoundNumbers': return { op: 'round', cols: k.cols || [], digits: +k.digits || 0 };
      case 'SplitColumn':
        if (k.mode === 'positions') refuse('Split by positions runs on the built-in engine');
        return { op: 'split', col: k.col, mode: k.mode || 'each', delimiter: k.delimiter === undefined || k.delimiter === '' ? ',' : k.delimiter, count: k.count ? +k.count : 0, trim: k.trim !== false };
      case 'MergeColumns': return { op: 'mergeColumns', cols: k.cols || [], sep: k.sep === undefined ? ' ' : k.sep, name: k.name || 'Merged' };
      case 'AddColumn': if (!k.name) refuse('Custom column has no name'); return { op: 'addColumn', name: k.name, expr: expr(k.formula || 'null', P, 'Custom column'), castTo: k.castTo && k.castTo !== 'auto' ? k.castTo : null, locale: ctx.locale };
      case 'ConditionalColumn': return { op: 'addColumn', name: k.name, expr: expr(PQ.Engine.conditionalToFormula(k), P, 'Conditional column'), castTo: null, locale: ctx.locale };
      case 'IndexColumn': return { op: 'index', name: k.name || 'Index', start: +k.start || 0, step: k.step === undefined || k.step === '' ? 1 : +k.step, first: !!k.first };
      case 'DuplicateColumn': return { op: 'duplicate', col: k.col, name: k.name || k.col + ' - Copy' };
      case 'GroupBy': {
        const used = new Set(k.keys || []);
        const aggs = (k.aggs || []).map((a) => {
          if (!AGGS.has(a.fn)) refuse('Aggregation ' + a.fn + ' runs on the built-in engine');
          const name = PQ.uniqueName(a.name || (PQ.Engine.AGG[a.fn].label + (a.col ? ' of ' + a.col : '')), used); used.add(name);
          return { fn: a.fn, col: a.fn === 'count_rows' ? null : a.col, name, sep: a.sep === undefined ? ', ' : a.sep };
        });
        return { op: 'groupBy', keys: k.keys || [], aggs };
      }
      case 'Unpivot': return { op: 'unpivot', ids: k.ids || null, values: k.values && k.values.length ? k.values : null, var: k.var || 'Attribute', val: k.val || 'Value', dropNulls: k.dropNulls !== false };
      case 'Pivot': if (!PIVOT_AGGS.has(k.agg || 'sum')) refuse('Pivot aggregation runs on the built-in engine'); return { op: 'pivot', on: k.on, index: k.index && k.index.length ? k.index : null, values: k.values || null, agg: k.agg || 'sum' };
      case 'Merge': return { op: 'join', right: ctx.sub(k.right), how: k.how || 'left', on: k.on || [], expand: k.expand && k.expand.length ? k.expand : null, prefix: k.prefix || '', castKeys: !!k.castKeys };
      case 'Append': return { op: 'append', others: (k.others || []).map((o) => ctx.sub(o)), strict: k.mode === 'strict' };
      case 'Window': if (!WINDOW_OPS.has(k.op)) refuse('Window “' + k.op + '” runs on the built-in engine'); return { op: 'window', fn: k.op, col: k.col || null, partition: k.partition || [], orderBy: k.orderBy || null, desc: !!k.desc, n: Math.max(1, +k.n || (k.op === 'moving_avg' ? 3 : 1)), name: k.name || k.op };
      case 'Checkpoint': return null;
    }
    refuse('Step “' + PQ.Steps.label(k.type) + '” isn’t supported by Polars yet');
  }

  function lowerQuery(project, qid, upto, ctx, stack) {
    const q = project.queries.find((x) => x.id === qid || x.name === qid);
    if (!q) refuse('Referenced query not found');
    if (stack.includes(q.id)) refuse('Circular reference');
    const sub = Object.assign({}, ctx, { sub: (ref) => lowerQuery(project, ref, undefined, ctx, stack.concat(q.id)) });
    const last = upto === undefined || upto === null || upto >= q.steps.length ? q.steps.length - 1 : upto;
    const first = q.steps[0];
    if (!first || first.kind.type !== 'Source') refuse('The first step must be a Source');
    const plan = { source: null, ops: [] };
    for (let i = 0; i <= last; i++) {
      const s = q.steps[i];
      if (s.disabled && i > 0) continue;
      try {
        if (i === 0) plan.source = source(s.kind.source, sub);
        else { const o = op(s.kind, sub); if (o) plan.ops.push(o); }
      } catch (e) {
        if (!(e instanceof Refuse) || e.located) throw e;
        const msg = /^Step “[^”]*” isn’t supported/.test(e.message) ? 'isn’t supported by Polars yet' : e.message;
        const r = new Refuse((stack.length ? 'Query “' + q.name + '”, s' : 'S') + 'tep ' + (i + 1) + ' “' + s.name + '”: ' + msg);
        r.located = true;
        throw r;
      }
    }
    return plan;
  }

  Plan.lower = function (project, qid, opts) {
    opts = opts || {};
    const ctx = { files: opts.files || {}, params: project.params || [], locale: (project.settings && project.settings.locale) || 'en-US' };
    try {
      const body = lowerQuery(project, qid, opts.upto, ctx, []);
      return { ok: true, plan: Object.assign({ v: Plan.VERSION, locale: ctx.locale }, body) };
    } catch (e) {
      if (e instanceof Refuse) return { ok: false, reason: e.message };
      return { ok: false, reason: 'Polars can’t run this query (' + (e.message || e) + ')' };
    }
  };
})();
