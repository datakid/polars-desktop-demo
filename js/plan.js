(function () {
  const PQ = self.PQ;
  const Plan = (PQ.Plan = { VERSION: 1 });

  const FUNCS = new Set(['Text.Upper', 'Text.Lower', 'Text.Trim', 'Text.Length', 'Text.Start', 'Text.End', 'Text.Middle', 'Text.Contains', 'Text.StartsWith', 'Text.EndsWith', 'Text.Replace', 'Text.From', 'Text.Combine', 'Text.PadStart', 'Text.PadEnd', 'Text.RegexExtract', 'Number.Clamp', 'Text.RegexMatch', 'Text.RegexReplace', 'Number.Round', 'Number.RoundUp', 'Number.RoundDown', 'Number.Abs', 'Number.Mod', 'Number.Power', 'Number.Sqrt', 'Number.From', 'Date.Year', 'Date.Month', 'Date.Day', 'Date.Quarter', 'Date.DayOfWeek', 'Date.AddDays', 'Date.AddMonths', 'Date.WeekOfYear', 'Date.MonthName', 'Date.DayOfWeekName', 'Date.StartOfMonth', 'Date.EndOfMonth', 'Date.DiffDays', 'Date.ToText', 'Text.Repeat', 'Text.Clean', 'Text.BeforeDelimiter', 'Text.AfterDelimiter', 'Number.Sign', 'Number.IntegerDivide', 'Number.Log', '#date', 'Coalesce', 'Value.IsNull', 'List.Contains']);
  Plan.FUNCS = FUNCS;
  const TEXT_OPS = new Set(['upper', 'lower', 'trim', 'clean']);
  const WINDOW_OPS = new Set(['cumsum', 'row_number', 'rank', 'dense_rank', 'diff', 'cummax', 'cummin', 'pct_change', 'rolling_sum', 'rolling_min', 'rolling_max', 'rolling_std', 'lag', 'lead', 'pct_of_total', 'moving_avg']);
  const AGGS = new Set(['count_rows', 'count', 'count_distinct', 'sum', 'mean', 'median', 'std', 'var', 'mode', 'percentile', 'min', 'max', 'first', 'last', 'concat']);
  const PIVOT_AGGS = new Set(['sum', 'mean', 'count_rows', 'min', 'max', 'first', 'last', 'median', 'std', 'var', 'mode']);

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
    if (src.kind === 'folder') {
      const listing = (ctx.folders && ctx.folders[src.folder]) || [];
      const re = PQ.globToRegex(src.pattern || '*');
      const picked = listing.filter((f) => re.test(f.name)).sort((a, b) => a.name.localeCompare(b.name));
      if (!picked.length) refuse('No files in folder “' + src.folder + '” match “' + (src.pattern || '*') + '”');
      const parts = picked.map((f) => {
        const one = source(Object.assign({}, src, { kind: 'file', fileId: '#', fileName: f.name, format: undefined }), Object.assign({}, ctx, { files: { '#': f.path } }));
        if (!['csv', 'parquet', 'ipc', 'json'].includes(one.kind)) refuse('Folders with ' + f.name + ' run on the built-in engine');
        return { name: f.name, source: one };
      });
      return { kind: 'folder', fileColumn: src.fileColumn || 'Source.Name', parts };
    }
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
    if (kind === 'json') return { kind: 'json', path };
    refuse('This file type runs on the built-in engine');
  }


  const SQL_RESERVED = new Set(['select', 'from', 'where', 'group', 'by', 'having', 'order', 'limit', 'offset', 'join', 'inner', 'left', 'right', 'full', 'outer', 'cross', 'natural', 'using', 'on', 'as', 'and', 'or', 'not', 'in', 'is', 'null', 'between', 'case', 'when', 'then', 'else', 'end', 'asc', 'desc', 'distinct', 'like', 'ilike', 'union', 'intersect', 'except', 'all', 'any', 'exists', 'over', 'with', 'nulls', 'true', 'false', 'cast', 'interval', 'top', 'into', 'values', 'insert', 'update', 'delete', 'create', 'drop', 'alter']);
  const SQL_AGGS = new Set(['count', 'sum', 'avg', 'min', 'max']);

  function sqlTokens(text) {
    const out = [];
    const n = text.length;
    let i = 0;
    while (i < n) {
      const c = text[i];
      if (/\s/.test(c)) { i++; continue; }
      if (c === "'") {
        let j = i + 1, v = '';
        for (; ;) {
          if (j >= n) refuse('unterminated text in the SQL');
          if (text[j] === "'") { if (text[j + 1] === "'") { v += "'"; j += 2; continue; } break; }
          if (text[j] === '\\') refuse('backslashes in SQL text run on the built-in engine');
          v += text[j++];
        }
        out.push({ t: 'str', v });
        i = j + 1;
        continue;
      }
      const num = /^\d+(\.\d+)?/.exec(text.slice(i));
      if (num) {
        if (/[A-Za-z_.]/.test(text[i + num[0].length] || '')) refuse('this number format runs on the built-in engine');
        out.push({ t: 'num', v: num[0] });
        i += num[0].length;
        continue;
      }
      const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i));
      if (id) { out.push({ t: 'id', v: id[0] }); i += id[0].length; continue; }
      const two = text.slice(i, i + 2);
      if (two === '<=' || two === '>=' || two === '<>' || two === '!=') { out.push({ t: 'op', v: two === '!=' ? '<>' : two }); i += 2; continue; }
      if ('=<>+-*/%(),.'.includes(c)) { out.push({ t: 'op', v: c }); i++; continue; }
      refuse('the character “' + c + '” runs on the built-in engine');
    }
    return out;
  }

  function sqlOp(k, ctx) {
    const raw = String(k.sql || '').trim().replace(/[;\s]+$/, '');
    if (!raw) refuse('Write a SQL query');
    const toks = sqlTokens(raw);
    let p = 0;
    const peek = (o) => toks[p + (o || 0)];
    const isKw = (w, o) => { const t = peek(o); return !!t && t.t === 'id' && t.v.toLowerCase() === w; };
    const isOp = (v, o) => { const t = peek(o); return !!t && t.t === 'op' && t.v === v; };
    const eatKw = (w) => { if (isKw(w)) { p++; return true; } return false; };
    const eatOp = (v) => { if (isOp(v)) { p++; return true; } return false; };
    const want = (what) => refuse('this SQL shape runs on the built-in engine (expected ' + what + ')');
    const wantKw = (w) => { if (!eatKw(w)) want(w.toUpperCase()); };
    const wantOp = (v) => { if (!eatOp(v)) want('“' + v + '”'); };
    const ident = () => {
      const t = peek();
      if (!t || t.t !== 'id' || SQL_RESERVED.has(t.v.toLowerCase())) want('a name');
      p++;
      return t.v;
    };
    const plainWord = () => { const t = peek(); return !!t && t.t === 'id' && !SQL_RESERVED.has(t.v.toLowerCase()); };
    const refs = [];
    const quote = (v) => "'" + v.replace(/'/g, "''") + "'";

    function colref() {
      const a = ident();
      if (eatOp('.')) { const b = ident(); const r = { q: a, name: b }; refs.push(r); return r; }
      const r = { q: null, name: a };
      refs.push(r);
      return r;
    }
    const refText = (r) => (r.q ? r.q + '.' + r.name : r.name);

    function literal() {
      const t = peek();
      if (t && t.t === 'str') { p++; return { s: quote(t.v) }; }
      if (t && t.t === 'num') { p++; return { s: t.v, num: Number(t.v) }; }
      if (isOp('-') && peek(1) && peek(1).t === 'num') { p += 2; return { s: '-' + peek(-1).v, num: -Number(peek(-1).v) }; }
      return null;
    }

    function call(name, allowAgg) {
      const lname = name.toLowerCase();
      if (lname === 'coalesce') {
        const args = [];
        do { args.push(expr(allowAgg)); } while (eatOp(','));
        wantOp(')');
        if (args.length < 2) want('two or more values in COALESCE');
        return { s: 'COALESCE(' + args.map((a) => a.s).join(', ') + ')', agg: args.some((a) => a.agg), bare: [].concat(...args.map((a) => a.bare)) };
      }
      if (!SQL_AGGS.has(lname)) refuse('the function ' + name.toUpperCase() + ' runs on the built-in engine');
      if (!allowAgg) refuse('aggregate functions are only lowered in the column list and HAVING');
      const up = name.toUpperCase();
      if (up === 'COUNT' && isOp('*')) { p++; wantOp(')'); return { s: 'COUNT(*)', agg: true, bare: [] }; }
      if (eatKw('distinct')) {
        if (up !== 'COUNT') refuse(up + '(DISTINCT …) runs on the built-in engine');
        const r = colref();
        wantOp(')');
        return { s: 'COUNT(DISTINCT ' + refText(r) + ')', agg: true, bare: [] };
      }
      const a = expr(false);
      wantOp(')');
      if (up === 'COUNT' && !a.plain) refuse('COUNT over an expression runs on the built-in engine');
      return { s: up + '(' + a.s + ')', agg: true, bare: [] };
    }

    function factor(allowAgg) {
      const lit = literal();
      if (lit) return { s: lit.s, num: lit.num, agg: false, bare: [] };
      if (eatOp('(')) { const e = expr(allowAgg); wantOp(')'); return { s: '(' + e.s + ')', agg: e.agg, bare: e.bare }; }
      if (isKw('case')) {
        p++;
        let s = 'CASE', agg = false, bare = [];
        if (!isKw('when')) want('WHEN');
        while (eatKw('when')) {
          const c = cond(allowAgg);
          wantKw('then');
          const e = expr(allowAgg);
          s += ' WHEN ' + c.s + ' THEN ' + e.s;
          agg = agg || c.agg || e.agg;
          bare = bare.concat(c.bare, e.bare);
        }
        if (eatKw('else')) { const e = expr(allowAgg); s += ' ELSE ' + e.s; agg = agg || e.agg; bare = bare.concat(e.bare); }
        wantKw('end');
        return { s: s + ' END', agg, bare };
      }
      const t = peek();
      if (t && t.t === 'id' && isOp('(', 1)) { p += 2; return call(t.v, allowAgg); }
      if (t && t.t === 'id' && SQL_RESERVED.has(t.v.toLowerCase())) {
        const w = t.v.toLowerCase();
        refuse(w === 'null' ? 'NULL values in expressions run on the built-in engine' : w === 'not' ? 'NOT runs on the built-in engine' : '“' + t.v.toUpperCase() + '” runs on the built-in engine');
      }
      const r = colref();
      return { s: refText(r), agg: false, bare: [r], plain: r };
    }

    function term(allowAgg) {
      let l = factor(allowAgg);
      for (; ;) {
        const t = peek();
        if (!(t && t.t === 'op' && (t.v === '*' || t.v === '/' || t.v === '%'))) return l;
        p++;
        const r = factor(allowAgg);
        if ((t.v === '/' || t.v === '%') && !(r.num !== undefined && r.num !== 0)) refuse('division by a column or by zero runs on the built-in engine');
        l = { s: l.s + ' ' + t.v + ' ' + r.s, agg: l.agg || r.agg, bare: l.bare.concat(r.bare) };
      }
    }

    function expr(allowAgg) {
      let l = term(allowAgg);
      for (; ;) {
        const t = peek();
        if (!(t && t.t === 'op' && (t.v === '+' || t.v === '-'))) return l;
        p++;
        const r = term(allowAgg);
        l = { s: l.s + ' ' + t.v + ' ' + r.s, agg: l.agg || r.agg, bare: l.bare.concat(r.bare) };
      }
    }

    function pred(allowAgg) {
      if (isKw('not')) refuse('NOT runs on the built-in engine');
      if (isOp('(')) {
        const at = p;
        try {
          p++;
          const c = cond(allowAgg);
          wantOp(')');
          const t = peek();
          if (!(t && ((t.t === 'op' && ['=', '<>', '<', '<=', '>', '>=', '+', '-', '*', '/', '%'].includes(t.v)) || (t.t === 'id' && ['is', 'in', 'between'].includes(t.v.toLowerCase()))))) return { s: '(' + c.s + ')', agg: c.agg, bare: c.bare };
        } catch (e) {
          if (!(e instanceof Refuse)) throw e;
          if (!/expected/.test(e.message)) throw e;
        }
        p = at;
      }
      const l = expr(allowAgg);
      if (eatKw('is')) {
        const neg = eatKw('not');
        wantKw('null');
        return { s: l.s + (neg ? ' IS NOT NULL' : ' IS NULL'), agg: l.agg, bare: l.bare };
      }
      if (isKw('not') && (isKw('in', 1))) { p++; }
      const negIn = p > 0 && isKw('in') && toks[p - 1].t === 'id' && toks[p - 1].v.toLowerCase() === 'not';
      if (isKw('in')) {
        p++;
        wantOp('(');
        const items = [];
        do {
          const lit = literal();
          if (!lit) want('a number or text value in the IN list');
          items.push(lit.s);
        } while (eatOp(','));
        wantOp(')');
        return { s: l.s + (negIn ? ' NOT IN (' : ' IN (') + items.join(', ') + ')', agg: l.agg, bare: l.bare };
      }
      if (eatKw('between')) {
        const a = expr(allowAgg);
        wantKw('and');
        const b = expr(allowAgg);
        return { s: l.s + ' BETWEEN ' + a.s + ' AND ' + b.s, agg: l.agg || a.agg || b.agg, bare: l.bare.concat(a.bare, b.bare) };
      }
      if (isKw('like') || isKw('ilike')) refuse('LIKE runs on the built-in engine');
      const t = peek();
      if (t && t.t === 'op' && ['=', '<>', '<', '<=', '>', '>='].includes(t.v)) {
        p++;
        const r = expr(allowAgg);
        return { s: l.s + ' ' + t.v + ' ' + r.s, agg: l.agg || r.agg, bare: l.bare.concat(r.bare) };
      }
      want('a comparison');
    }

    function conj(allowAgg) {
      let l = pred(allowAgg);
      while (eatKw('and')) { const r = pred(allowAgg); l = { s: l.s + ' AND ' + r.s, agg: l.agg || r.agg, bare: l.bare.concat(r.bare) }; }
      return l;
    }

    function cond(allowAgg) {
      let l = conj(allowAgg);
      while (eatKw('or')) { const r = conj(allowAgg); l = { s: l.s + ' OR ' + r.s, agg: l.agg || r.agg, bare: l.bare.concat(r.bare) }; }
      return l;
    }

    wantKw('select');
    if (isKw('distinct')) refuse('SELECT DISTINCT runs on the built-in engine');
    const items = [];
    if (isOp('*')) { p++; items.push({ star: true }); }
    else {
      do {
        const e = expr(true);
        let alias = null;
        if (eatKw('as')) alias = ident();
        else if (plainWord()) refuse('name the column with AS');
        if (!alias && !e.plain) refuse('name the expression ' + e.s + ' with AS');
        items.push({ e, alias });
      } while (eatOp(','));
    }
    wantKw('from');
    const tables = [];
    const source = () => {
      const name = ident();
      let alias = null;
      if (eatKw('as')) alias = ident();
      else if (plainWord()) alias = ident();
      const q = alias || name;
      if (tables.some((t) => t.q === q)) refuse('the table name ' + q + ' is used twice');
      tables.push({ name, alias, q });
      return name + (alias ? ' AS ' + alias : '');
    };
    let from = source();
    let joins = 0;
    for (; ;) {
      let how = null;
      if (isKw('join')) { p++; how = 'INNER JOIN'; }
      else if (isKw('inner') && isKw('join', 1)) { p += 2; how = 'INNER JOIN'; }
      else if (isKw('left') && isKw('join', 1)) { p += 2; how = 'LEFT JOIN'; }
      else if (isKw('left') && isKw('outer', 1) && isKw('join', 2)) { p += 3; how = 'LEFT JOIN'; }
      else if (isKw('right') || isKw('full') || isKw('cross') || isKw('natural') || isOp(',')) refuse('only INNER and LEFT joins are lowered');
      if (!how) break;
      joins++;
      const src = source();
      wantKw('on');
      const parts = [];
      do {
        const a = colref();
        wantOp('=');
        const b = colref();
        parts.push(refText(a) + ' = ' + refText(b));
      } while (eatKw('and'));
      from += ' ' + how + ' ' + src + ' ON ' + parts.join(' AND ');
    }
    let where = null;
    if (eatKw('where')) { const c = cond(false); where = c.s; }
    const group = [];
    if (eatKw('group')) { wantKw('by'); do { group.push(colref()); } while (eatOp(',')); }
    let having = null;
    if (eatKw('having')) { having = cond(true); }
    const order = [];
    if (eatKw('order')) {
      wantKw('by');
      do {
        const r = colref();
        let desc = false;
        if (eatKw('desc')) desc = true; else eatKw('asc');
        order.push({ r, desc });
      } while (eatOp(','));
    }
    let limit = null, offset = null;
    if (eatKw('limit')) {
      const t = peek();
      if (!t || t.t !== 'num' || !/^\d+$/.test(t.v) || Number(t.v) < 1 || Number(t.v) > 2147483647) refuse('LIMIT must be a whole number of 1 or more');
      p++;
      limit = t.v;
      if (eatKw('offset')) {
        const o = peek();
        if (!o || o.t !== 'num' || !/^\d+$/.test(o.v) || Number(o.v) > 2147483647) refuse('OFFSET must be a whole number');
        p++;
        offset = o.v;
      }
    }
    if (p < toks.length) want('the end of the query');

    const quals = new Set(tables.map((t) => t.q));
    refs.forEach((r) => {
      if (r.q !== null && !quals.has(r.q)) refuse('the table name ' + r.q + ' is not in FROM');
      if (joins && r.q === null) refuse('columns must be written as table.column when tables are joined');
    });
    if (joins && !order.length) refuse('joins are lowered only with an ORDER BY');
    const star = items.some((i) => i.star);
    if (star && joins) refuse('SELECT * with joins runs on the built-in engine');
    const aggregated = !star && (items.some((i) => i.e.agg) || (having && having.agg));
    if (group.length || aggregated) {
      if (star) refuse('SELECT * with GROUP BY runs on the built-in engine');
      const keys = new Set(group.map((g) => g.name));
      items.forEach((i) => {
        if (i.e.agg) { if (i.e.bare.length) refuse('mixing a column and an aggregate in one expression runs on the built-in engine'); }
        else if (!(i.e.plain && keys.has(i.e.plain.name))) refuse('every column outside an aggregate must be a GROUP BY column');
      });
      if (having && having.bare.some((b) => !keys.has(b.name))) refuse('HAVING may only use GROUP BY columns and aggregates');
    }
    if (group.length) {
      const aliasOf = new Map(items.filter((i) => i.alias && i.e.plain).map((i) => [i.alias, i.e.plain.name]));
      const covered = new Set(order.map((o) => (o.r.q === null && aliasOf.has(o.r.name) ? aliasOf.get(o.r.name) : o.r.name)));
      if (!group.every((g) => covered.has(g.name))) refuse('GROUP BY is lowered only when ORDER BY lists every GROUP BY column, because the built-in engine orders groups differently');
    }

    const names = [];
    tables.forEach((t) => {
      if (t.name === 'self' || names.some((n) => n.name === t.name)) return;
      const q = (ctx.queries || []).find((x) => PQ.snake(x.name) === t.name);
      if (!q) refuse('the table ' + t.name + ' is not a query in this project');
      names.push({ name: t.name, plan: ctx.sub(q.id) });
    });

    const cols = star ? '*' : items.map((i) => i.e.s + (i.alias ? ' AS ' + i.alias : '')).join(', ');
    let sql = 'SELECT ' + cols + ' FROM ' + from;
    if (where) sql += ' WHERE ' + where;
    if (group.length) sql += ' GROUP BY ' + group.map(refText).join(', ');
    if (having) sql += ' HAVING ' + having.s;
    if (order.length) sql += ' ORDER BY ' + order.map((o) => refText(o.r) + (o.desc ? ' DESC NULLS LAST' : ' NULLS FIRST')).join(', ');
    if (limit !== null) sql += ' LIMIT ' + limit + (offset !== null ? ' OFFSET ' + offset : '');
    return { op: 'sql', sql, tables: names };
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
      case 'ExpandJson': return { op: 'expandJson', col: k.col, fields: Array.isArray(k.fields) ? k.fields : [] };
      case 'Sample': return { op: 'sample', mode: k.mode === 'percent' ? 'percent' : 'n', percent: +k.percent || 0, n: +k.n || 0, seed: k.seed === undefined || k.seed === '' ? 42 : (Number.isFinite(+k.seed) ? +k.seed : null) };
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
        if (k.mode === 'positions') {
          const ps = String(k.positions || '').split(',').map((x) => parseInt(x.trim(), 10)).filter((x) => !isNaN(x)).sort((a, b) => a - b);
          if (!ps.length) refuse('Enter one or more character positions');
          return { op: 'split', col: k.col, mode: 'positions', positions: ps, delimiter: ',', count: k.count ? +k.count : 0, trim: k.trim !== false };
        }
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
          const p = a.p === undefined || a.p === '' ? 50 : +a.p;
          if (a.fn === 'percentile' && !(p >= 0 && p <= 100)) refuse('Percentile must be between 0 and 100');
          const name = PQ.uniqueName(a.name || PQ.Engine.aggName(a), used); used.add(name);
          return { fn: a.fn, col: a.fn === 'count_rows' ? null : a.col, name, sep: a.sep === undefined ? ', ' : a.sep, p };
        });
        return { op: 'groupBy', keys: k.keys || [], aggs };
      }
      case 'Unpivot': return { op: 'unpivot', ids: k.ids || null, values: k.values && k.values.length ? k.values : null, var: k.var || 'Attribute', val: k.val || 'Value', dropNulls: k.dropNulls !== false };
      case 'Pivot': if (!PIVOT_AGGS.has(k.agg || 'sum')) refuse('Pivot aggregation runs on the built-in engine'); return { op: 'pivot', on: k.on, index: k.index && k.index.length ? k.index : null, values: k.values || null, agg: k.agg || 'sum' };
      case 'Merge': return { op: 'join', right: ctx.sub(k.right), how: k.how || 'left', on: k.on || [], expand: k.expand && k.expand.length ? k.expand : null, prefix: k.prefix || '', castKeys: !!k.castKeys };
      case 'Append': return { op: 'append', others: (k.others || []).map((o) => ctx.sub(o)), strict: k.mode === 'strict' };
      case 'Window': {
        if (!WINDOW_OPS.has(k.op)) refuse('Window “' + k.op + '” runs on the built-in engine');
        const wn = Math.max(1, +k.n || (k.op === 'moving_avg' || k.op.startsWith('rolling_') ? 3 : 1));
        if ((k.op === 'moving_avg' || k.op.startsWith('rolling_')) && wn > 500) refuse('Windows wider than 500 rows run on the built-in engine');
        if (k.op === 'rolling_std' && wn > 60) refuse('Rolling std over more than 60 rows runs on the built-in engine');
        return { op: 'window', fn: k.op, col: k.col || null, partition: k.partition || [], orderBy: k.orderBy || null, desc: !!k.desc, n: wn, name: k.name || k.op };
      }
      case 'CustomSql': return sqlOp(k, ctx);
      case 'Checkpoint': return null;
    }
    refuse('Step “' + PQ.Steps.label(k.type) + '” isn’t supported by Polars yet');
  }

  function lowerQuery(project, qid, upto, ctx, stack) {
    const q = project.queries.find((x) => x.id === qid || x.name === qid);
    if (!q) refuse('Referenced query not found');
    if (stack.includes(q.id)) refuse('Circular reference');
    const sub = Object.assign({}, ctx, { queries: project.queries, sub: (ref) => lowerQuery(project, ref, undefined, ctx, stack.concat(q.id)) });
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
    const ctx = { files: opts.files || {}, folders: opts.folders || {}, params: project.params || [], locale: (project.settings && project.settings.locale) || 'en-US' };
    try {
      const body = lowerQuery(project, qid, opts.upto, ctx, []);
      return { ok: true, plan: Object.assign({ v: Plan.VERSION, locale: ctx.locale }, body) };
    } catch (e) {
      if (e instanceof Refuse) return { ok: false, reason: e.message };
      return { ok: false, reason: 'Polars can’t run this query (' + (e.message || e) + ')' };
    }
  };
})();
