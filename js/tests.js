/* Engine golden tests (browser): every step kind and edge cases, plus Polars plan lowering. */
(async function () {
  const PQ = self.PQ, E = PQ.Engine, T = PQ.Table;
  const out = document.getElementById('out');
  let pass = 0, fail = 0;
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  function test(name, fn) {
    try { fn(); pass++; out.insertAdjacentHTML('beforeend', '<li class="ok">✓ ' + PQ.esc(name) + '</li>'); }
    catch (e) { fail++; out.insertAdjacentHTML('beforeend', '<li class="bad">✗ ' + PQ.esc(name) + '<pre>' + PQ.esc(e.stack || e.message) + '</pre></li>'); console.error('FAIL', name, e.message); }
  }
  const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
  const assertEq = (a, b, m) => { if (!eq(a, b)) throw new Error((m || 'not equal') + '\n  got:      ' + JSON.stringify(a) + '\n  expected: ' + JSON.stringify(b)); };
  const ctx = { mode: 'full', previewRows: 1000, locale: 'en-US', params: [{ name: 'Min', type: 'number', value: '10' }], resolve: () => null, sqlTables: () => [] };
  const tbl = () => T.fromRows(['id', 'name', 'region', 'sales'], [[1, 'Ana', 'EU', 100], [2, 'Ben', 'US', 2500], [3, 'Chloé', 'EU', null], [4, 'Dmitri', 'APAC', 1200], [5, 'Eva', 'EU', 2500]], ['int', 'text', 'text', 'int']);
  const col = (t, c) => t.get(c).map((v) => (PQ.isErr(v) ? 'ERR' : v instanceof Date ? PQ.fmtDate(v) : v));

  /* ---------- formula language ---------- */
  test('formula: arithmetic + precedence', () => assertEq(PQ.Formula.evaluate('1 + 2 * 3 - [id]', tbl()).values, [6, 5, 4, 3, 2]));
  test('formula: if/then/else with and', () => assertEq(PQ.Formula.evaluate('if [sales] > 1000 and [region] = "EU" then "Key" else "Other"', tbl()).values, ['Other', 'Other', 'Other', 'Other', 'Key']));
  test('formula: null propagation in comparison → else branch', () => assertEq(PQ.Formula.evaluate('if [sales] > 0 then 1 else 0', tbl()).values[2], 0));
  test('formula: text functions', () => assertEq(PQ.Formula.evaluate('Text.Upper(Text.Start([name], 2)) & "-" & Text.From([id])', tbl()).values, ['AN-1', 'BE-2', 'CH-3', 'DM-4', 'EV-5']));
  test('formula: in list', () => assertEq(PQ.Formula.evaluate('[region] in {"EU", "APAC"}', tbl()).values, [true, false, true, true, true]));
  test('formula: parameters', () => assertEq(PQ.Formula.evaluate('[id] * @Min', tbl(), ctx.params).values, [10, 20, 30, 40, 50]));
  test('formula: try otherwise', () => assertEq(PQ.Formula.evaluate('try 10 / ([id] - 3) otherwise -1', tbl()).values, [-5, -10, -1, 10, 5]));
  test('formula: division by zero is a cell error, not a crash', () => assert(PQ.isErr(PQ.Formula.evaluate('1 / ([id] - 3)', tbl()).values[2])));
  test('formula: type check — text + number rejected with hint', () => { const v = PQ.Formula.validate('[name] + 1', tbl().schema()); assert(!v.ok && /Use &/.test(v.hint), JSON.stringify(v)); });
  test('formula: unknown column suggests closest', () => { const v = PQ.Formula.validate('[slaes] * 2', tbl().schema()); assert(!v.ok && /sales/.test(v.hint) && v.start === 0 && v.end === 7, JSON.stringify(v)); });
  test('formula: unknown function suggests closest', () => { const v = PQ.Formula.validate('Text.Uper([name])', tbl().schema()); assert(!v.ok && /Text.Upper/.test(v.hint), JSON.stringify(v)); });
  test('formula: missing else reports position', () => { const v = PQ.Formula.validate('if [id] > 1 then 2', tbl().schema()); assert(!v.ok && /else/.test(v.message), JSON.stringify(v)); });
  test('formula: date functions', () => { const t = T.fromRows(['d'], [[new Date(Date.UTC(2026, 8, 26))]], ['date']); assertEq(PQ.Formula.evaluate('Date.Year([d]) * 100 + Date.Month([d])', t).values, [202609]); assertEq(PQ.Formula.evaluate('Date.DayOfWeekName([d])', t).values, ['Saturday']); });
  test('formula: Number.Round is banker\'s rounding', () => assertEq(PQ.Formula.evaluate('Number.Round(2.5) + Number.Round(3.5)', tbl()).values[0], 6));
  test('formula → python', () => assertEq(PQ.Formula.toPython('if [a] > 1 then "x" else "y"'), 'pl.when((pl.col("a") > pl.lit(1))).then(pl.lit("x")).otherwise(pl.lit("y"))'));

  /* ---------- Polars plan lowering ---------- */
  if (PQ.Plan) {
    const proj = (steps, extra) => Object.assign({ settings: { previewRows: 1000, locale: 'en-US' }, params: [{ name: 'Min', type: 'number', value: '10' }], queries: [{ id: 'q1', name: 'Orders', steps: steps.map((k, i) => ({ id: 's' + i, name: i ? PQ.Steps.label(k.type) : 'Source', kind: k })) }] }, extra || {});
    const src = { type: 'Source', source: { kind: 'file', fileId: 'f1', fileName: 'orders.csv', csv: { delimiter: ',' } } };
    const files = { files: { f1: '/data/orders.csv' } };
    test('plan: csv source + filter + groupBy lowers', () => {
      const r = PQ.Plan.lower(proj([src, { type: 'Filter', mode: 'advanced', formula: '[qty] > @Min' }, { type: 'GroupBy', keys: ['region'], aggs: [{ fn: 'sum', col: 'qty' }] }]), 'q1', files);
      assert(r.ok, r.reason);
      assertEq(r.plan.source, { kind: 'csv', path: '/data/orders.csv', delimiter: ',', header: true, skipRows: 0 });
      assertEq(r.plan.ops[0].expr, { k: 'bin', op: '>', a: { k: 'col', name: 'qty' }, b: { k: 'lit', v: 10 } });
      assertEq(r.plan.ops[1].aggs[0].name, 'Sum of qty');
    });
    test('plan: file without a disk path is refused', () => { const r = PQ.Plan.lower(proj([src]), 'q1', {}); assert(!r.ok && /isn’t linked to a file on disk/.test(r.reason), r.reason); });
    test('plan: unsupported step names the step', () => { const r = PQ.Plan.lower(proj([src, { type: 'Sample', mode: 'n', n: 5 }]), 'q1', files); assert(!r.ok && /^Step 2 “Sampled Rows”: isn’t supported/.test(r.reason), r.reason); });
    test('plan: unsupported formula function is refused', () => { const r = PQ.Plan.lower(proj([src, { type: 'AddColumn', name: 'x', formula: 'Text.Similarity([a], [b])' }]), 'q1', files); assert(!r.ok && /Text\.Similarity/.test(r.reason), r.reason); });
    test('plan: upto stops lowering before unsupported steps', () => { const r = PQ.Plan.lower(proj([src, { type: 'Distinct' }, { type: 'Sample', mode: 'n', n: 5 }]), 'q1', Object.assign({ upto: 1 }, files)); assert(r.ok && r.plan.ops.length === 1, r.reason); });
    test('plan: merge lowers the right query', () => {
      const p = proj([src, { type: 'Merge', right: 'q2', how: 'left', on: [['cid', 'cid']] }]);
      p.queries.push({ id: 'q2', name: 'Customers', steps: [{ id: 'x', name: 'Source', kind: { type: 'Source', source: { kind: 'blank', columns: ['cid', 'n'], rows: [['1', 'a']] } } }] });
      const r = PQ.Plan.lower(p, 'q1', files);
      assert(r.ok && r.plan.ops[0].right.source.kind === 'blank', r.reason);
    });
    test('plan: excel table refused, sheet ok', () => {
      const x = (item) => ({ type: 'Source', source: { kind: 'file', fileId: 'f1', fileName: 'r.xlsx', item } });
      assert(!PQ.Plan.lower(proj([x({ type: 'table', name: 'T' })]), 'q1', files).ok);
      assert(PQ.Plan.lower(proj([x({ type: 'sheet', name: 'Daily' })]), 'q1', files).ok);
    });
    test('plan: dates in formulas become epoch literals', () => { const r = PQ.Plan.lower(proj([src, { type: 'Filter', mode: 'advanced', formula: '[d] >= #date(2026, 1, 2)' }]), 'q1', files); assertEq(r.plan.ops[0].expr.b, { k: 'call', fn: '#date', args: [{ k: 'lit', v: 2026 }, { k: 'lit', v: 1 }, { k: 'lit', v: 2 }] }); });
  }

  /* ---------- parsing & types ---------- */
  test('parseNumber: accounting, %, thousands, currency', () => assertEq(['(1,234.50)', '12%', '$1,000', '1e3', 'abc'].map((s) => PQ.parseNumber(s)), [-1234.5, 0.12, 1000, 1000, null]));
  test('parseNumber: German locale', () => assertEq(PQ.parseNumber('1.234,5', 'de-DE'), 1234.5));
  test('parseDate: locale order', () => { assertEq(PQ.fmtDate(PQ.parseDate('03/04/2026', 'en-US')), '2026-03-04'); assertEq(PQ.fmtDate(PQ.parseDate('03.04.2026', 'de-DE')), '2026-04-03'); });
  test('Excel serial dates: 1900 leap bug + 1904 system', () => { assertEq(PQ.fmtDate(PQ.excelSerialToDate(45000)), '2023-03-15'); assertEq(PQ.fmtDate(PQ.excelSerialToDate(1)), '1900-01-01'); assertEq(PQ.fmtDate(PQ.excelSerialToDate(0, true)), '1904-01-01'); });
  test('inferType samples beyond the first rows', () => { const a = Array(400).fill('1'); a[350] = 'x'; assertEq(PQ.inferType(a), 'text'); assertEq(PQ.inferType(['1', '2.5', '']), 'number'); assertEq(PQ.inferType(['2026-01-01', '2026-02-03']), 'date'); assertEq(PQ.inferType(['yes', 'no']), 'bool'); });
  test('A1 ranges incl. open-ended', () => { assertEq(PQ.parseA1('B3:H'), { sheet: null, c1: 1, r1: 2, c2: 7, r2: Infinity }); assertEq(PQ.parseA1("'My Sheet'!$A$1:$C$5").sheet, 'My Sheet'); });

  /* ---------- step executors ---------- */
  test('ChangeType: per-cell errors (mode=error)', () => { const t = T.fromRows(['x'], [['1'], ['n/a'], [''], ['1,234']], ['text']); const r = E.X.ChangeType(t, { changes: [{ col: 'x', type: 'number' }], onError: 'error' }, ctx); assertEq(col(r, 'x'), [1, 'ERR', null, 1234]); });
  test('ChangeType: keep original in error column', () => { const t = T.fromRows(['x'], [['1'], ['n/a']], ['text']); const r = E.X.ChangeType(t, { changes: [{ col: 'x', type: 'int' }], onError: 'keep' }, ctx); assertEq(r.names, ['x', 'x_error']); assertEq(col(r, 'x_error'), [null, 'n/a']); });
  test('ChangeType: fail mode throws with row number and fixes', () => { const t = T.fromRows(['x'], [['1'], ['bad']], ['text']); try { E.X.ChangeType(t, { changes: [{ col: 'x', type: 'int' }], onError: 'fail' }, ctx); assert(false); } catch (e) { assert(/Row 2/.test(e.message) && e.fixes.length === 2, e.message); } });
  test('Filter builder → formula', () => assertEq(E.builderToFormula({ join: 'and', conds: [{ col: 'a b', op: 'gt', value: '5' }, { col: 'c', op: 'contains', value: 'x' }] }), '[a b] > 5 and Text.Contains(Text.From([c]), "x")'));
  test('Filter: rows kept', () => assertEq(col(E.X.Filter(tbl(), { mode: 'advanced', formula: '[sales] >= 1200' }, ctx), 'id'), [2, 4, 5]));
  test('Sort: stable, nulls last, multi-key', () => assertEq(col(E.X.Sort(tbl(), { by: [{ col: 'sales', desc: true }, { col: 'id', desc: true }] }), 'id'), [5, 2, 4, 1, 3]));
  test('Distinct subset keeps first', () => assertEq(col(E.X.Distinct(tbl(), { subset: ['region'] }), 'id'), [1, 2, 4]));
  test('KeepRows alternate', () => assertEq(col(E.X.KeepRows(tbl(), { mode: 'alternate', keep: 1, skip: 1, offset: 0 }), 'id'), [1, 3, 5]));
  test('PromoteHeaders from row 2 with duplicates', () => { const t = T.fromRows(['Column1', 'Column2'], [['title', null], ['a', 'a'], [1, 2]]); const r = E.X.PromoteHeaders(t, { row: 1 }); assertEq(r.names, ['a', 'a_1']); assertEq(r.n, 1); });
  test('FillDown', () => { const t = T.fromRows(['g', 'v'], [['A', 1], [null, 2], ['B', 3], [null, 4]]); assertEq(col(E.X.FillDown(t, { cols: ['g'] }), 'g'), ['A', 'A', 'B', 'B']); });
  test('SplitColumn by delimiter + into rows', () => { const t = T.fromRows(['s'], [['a,b,c'], ['d']], ['text']); const r = E.X.SplitColumn(t, { col: 's', mode: 'each', delimiter: ',' }); assertEq(r.names, ['s.1', 's.2', 's.3']); assertEq(col(E.X.SplitColumn(t, { col: 's', mode: 'rows', delimiter: ',' }), 's'), ['a', 'b', 'c', 'd']); });
  test('MergeColumns', () => assertEq(col(E.X.MergeColumns(tbl(), { cols: ['name', 'region'], sep: '/', name: 'nr' }), 'nr')[0], 'Ana/EU'));
  test('GroupBy with sum/count/distinct', () => { const r = E.X.GroupBy(tbl(), { keys: ['region'], aggs: [{ fn: 'sum', col: 'sales', name: 's' }, { fn: 'count_rows', name: 'n' }] }); assertEq(r.toRows(), [['EU', 2600, 3], ['US', 2500, 1], ['APAC', 1200, 1]]); });
  test('Unpivot keeps ids, drops nulls', () => { const t = T.fromRows(['k', 'Jan', 'Feb'], [['a', 1, 2], ['b', null, 3]]); const r = E.X.Unpivot(t, { ids: ['k'] }); assertEq(r.toRows(), [['a', 'Jan', 1], ['a', 'Feb', 2], ['b', 'Feb', 3]]); });
  test('Pivot sum', () => { const t = T.fromRows(['k', 'm', 'v'], [['a', 'Jan', 1], ['a', 'Feb', 2], ['a', 'Jan', 5], ['b', 'Feb', 3]], ['text', 'text', 'int']); const r = E.X.Pivot(t, { on: 'm', values: 'v', agg: 'sum', index: ['k'] }); assertEq(r.toRows(), [['a', 6, 2], ['b', null, 3]]); });
  test('Transpose with header column', () => { const t = T.fromRows(['metric', 'x'], [['a', 1], ['b', 2]]); const r = E.X.Transpose(t, { headerCol: 'metric' }); assertEq(r.names, ['Name', 'a', 'b']); assertEq(r.toRows(), [['x', 1, 2]]); });
  test('Window: running total per partition', () => assertEq(col(E.X.Window(tbl(), { op: 'cumsum', col: 'sales', partition: ['region'], name: 'rt' }), 'rt'), [100, 2500, 100, 1200, 2600]));
  test('Window: rank', () => assertEq(col(E.X.Window(tbl(), { op: 'rank', col: 'sales', name: 'r' }), 'r'), [4, 1, 5, 3, 1]));
  test('ExpandJson objects', () => { const t = T.fromRows(['j'], [['{"a":1,"b":"x"}'], ['{"a":2}']]); const r = E.X.ExpandJson(t, { col: 'j' }); assertEq(r.toRows(), [[1, 'x'], [2, null]]); });
  test('Append diagonal unions columns', () => { const a = T.fromRows(['x'], [[1]]), b = T.fromRows(['x', 'y'], [[2, 'q']]); const r = E.X.Append(a, { others: ['b'], mode: 'diagonal' }, Object.assign({}, ctx, { resolve: () => b })); assertEq(r.toRows(), [[1, null], [2, 'q']]); });
  test('Append strict explains the difference', () => { const a = T.fromRows(['x'], [[1]]), b = T.fromRows(['x', 'y'], [[2, 'q']]); try { E.X.Append(a, { others: ['b'], mode: 'strict' }, Object.assign({}, ctx, { resolve: () => b })); assert(false); } catch (e) { assert(/extra y/.test(e.message), e.message); } });
  test('Merge: left, inner, anti, full', () => {
    const l = T.fromRows(['k', 'v'], [[1, 'a'], [2, 'b'], [3, 'c']]), r = T.fromRows(['k', 'w'], [[1, 'X'], [3, 'Z'], [4, 'Q']]);
    const c2 = Object.assign({}, ctx, { resolve: () => r });
    assertEq(E.X.Merge(l, { right: 'r', on: [['k', 'k']], how: 'left' }, c2).toRows(), [[1, 'a', 'X'], [2, 'b', null], [3, 'c', 'Z']]);
    assertEq(E.X.Merge(l, { right: 'r', on: [['k', 'k']], how: 'inner' }, c2).n, 2);
    assertEq(col(E.X.Merge(l, { right: 'r', on: [['k', 'k']], how: 'anti' }, c2), 'k'), [2]);
    assertEq(col(E.X.Merge(l, { right: 'r', on: [['k', 'k']], how: 'full' }, c2), 'k'), [1, 2, 3, 4]);
  });
  test('mergeStats: match count, duplicate & type warnings', () => {
    const l = T.fromRows(['k'], [[1], [2], [3]], ['int']), r = T.fromRows(['k'], [['1'], ['1'], ['3']], ['text']);
    const s = E.mergeStats(l, r, [['k', 'k']], 'left', false);
    assert(s.warnings.some((w) => w.kind === 'type'), 'type warning');
    const s2 = E.mergeStats(l, r, [['k', 'k']], 'left', true);
    assertEq([s2.matched, s2.dupKeys, s2.outRows], [2, 1, 4]);
  });
  test('CustomSql over self', () => { const r = E.X.CustomSql(tbl(), { sql: 'SELECT region, SUM(sales) AS s FROM self GROUP BY region ORDER BY s DESC' }, Object.assign({}, ctx, { sqlTables: () => [] })); assertEq(r.toRows()[0], ['EU', 2600]); });

  /* ---------- compiler: fingerprints, cache, errors, cycles ---------- */
  const proj = () => ({ settings: { previewRows: 1000, locale: 'en-US' }, params: [], queries: [
    { id: 'a', name: 'A', steps: [{ id: '1', name: 'Source', kind: { type: 'Source', source: { kind: 'blank', columns: ['x', 'y'], rows: [['1', 'a'], ['2', 'b'], ['3', 'c']] } } }, { id: '2', name: 'CT', kind: { type: 'ChangeType', changes: [{ col: 'x', type: 'int' }] } }, { id: '3', name: 'Ren', kind: { type: 'Rename', map: [['y', 'label']] } }, { id: '4', name: 'Add', kind: { type: 'AddColumn', name: 'z', formula: '[x] * 2' } }] },
  ] });
  test('compiler: evaluates and caches each step', () => { E.setProject(proj()); E.clearCache(); let r = E.evaluate('a', undefined, 'preview'); assertEq(r.states.map((s) => s.ok), [true, true, true, true]); r = E.evaluate('a', undefined, 'preview'); assert(r.states.every((s) => s.cached), 'all cached'); });
  test('compiler: editing step 4 keeps steps 1–3 cached', () => { const p = proj(); E.setProject(p); E.evaluate('a', undefined, 'preview'); p.queries[0].steps[3].kind.formula = '[x] * 3'; const r = E.evaluate('a', undefined, 'preview'); assertEq(r.states.map((s) => s.cached), [true, true, true, false]); assertEq(col(r.table, 'z'), [3, 6, 9]); });
  test('compiler: missing column error explains rename + offers fix', () => { const p = proj(); p.queries[0].steps.push({ id: '5', name: 'Rm', kind: { type: 'RemoveColumns', cols: ['y'] } }); E.setProject(p); const r = E.evaluate('a', undefined, 'preview'); const st = r.states[4]; assert(!st.ok && /renamed to `label` in step 3/.test(st.error), st.error); assert(st.fixes.some((f) => f.kind === 'replaceColumn' && f.to === 'label'), 'fix offered'); });
  test('renameColumnInKind fixes formulas and lists', () => { const k = PQ.Steps.renameColumnInKind({ type: 'AddColumn', name: 'y', formula: '[y] & [yy]' }, 'y', 'label'); assertEq(k, { type: 'AddColumn', name: 'y', formula: '[label] & [yy]' }); assertEq(PQ.Steps.renameColumnInKind({ type: 'RemoveColumns', cols: ['y', 'q'] }, 'y', 'label').cols, ['label', 'q']); });
  test('compiler: cycle detection with readable path', () => { const p = proj(); p.queries.push({ id: 'b', name: 'B', steps: [{ id: 'b1', name: 'Source', kind: { type: 'Source', source: { kind: 'query', query: 'a' } } }] }); p.queries[0].steps.push({ id: '9', name: 'M', kind: { type: 'Merge', right: 'b', on: [['x', 'x']] } }); E.setProject(p); let msg = ''; try { PQ.Steps.topo(p); } catch (e) { msg = e.message; } assert(/A → B → A|B → A → B/.test(msg), msg); });
  test('preview mode applies head(N) at the source', () => { const p = proj(); p.settings.previewRows = 2; E.setProject(p); E.clearCache(); const r = E.evaluate('a', undefined, 'preview'); /* blank source is not truncated; file sources are */ assert(r.table.n === 3); });

  /* ---------- Excel: header detection, regions, merged cells, tables ---------- */
  const samples = PQ.IO.makeSamples();
  const rep = samples.find((s) => s.name === 'regional_report.xlsx');
  const rec = { id: 'rep', name: rep.name, buf: rep.buf instanceof ArrayBuffer ? rep.buf : new Uint8Array(rep.buf).buffer, mtime: 1, size: 1 };
  test('Excel navigator: sheets, hidden flag, regions, named range', () => {
    const info = PQ.IO.inspectExcel(rec);
    assertEq(info.sheets.map((s) => s.name), ['Report', 'Daily', 'Sales Q1', 'Sales Q2', 'Sales Q3', 'Lookup']);
    assert(info.sheets[5].hidden, 'Lookup hidden');
    assert(info.sheets[0].regions.length >= 2, 'stacked tables detected: ' + info.sheets[0].regions.length);
    assert(info.names.some((n) => n.name === 'TargetsRange'), 'named range');
    assertEq(info.sheets[0].header.row, 3, 'header row detected under the title rows');
  });
  test('Excel: fill merged cells', () => { const t = PQ.IO.readExcel(rec, { type: 'range', sheet: 'Report', range: 'A5:B9' }, { fillMerged: true }); assertEq(col(t, 'Column1'), ['EU', 'EU', 'EU', 'EU', null]); });
  test('Excel: native dates & booleans', () => { const t = PQ.IO.readExcel(rec, { type: 'sheet', name: 'Daily' }, {}, 5); assert(t.data[0][1] instanceof Date, 'date'); assertEq(typeof t.data[3][1], 'boolean'); });
  test('Excel: combine sheets by pattern (diagonal + _sheet)', () => { const t = PQ.IO.readExcel(rec, { type: 'sheets', pattern: 'Sales*' }, {}); assertEq(t.names, ['_sheet', 'Region', 'Units', 'Revenue', 'Returns']); assertEq(t.n, 12); });
  test('CSV sniffing: semicolon + decimal comma', () => { const s = samples.find((x) => x.name === 'sales_2026-06.csv'); const sn = PQ.IO.sniffCSV(s.text); assertEq([sn.delimiter, sn.locale, sn.header], [';', 'de-DE', true]); });
  test('Excel writer round-trip', () => { const buf = PQ.IO.toXLSX(tbl(), 'T'); const wb = XLSX.read(new Uint8Array(buf), { type: 'array' }); assertEq(XLSX.utils.sheet_to_json(wb.Sheets.T, { header: 1 })[1], [1, 'Ana', 'EU', 100]); });

  /* ---------- codegen & project format ---------- */
  test('Python export covers every step and parses as plausible Python', () => {
    const p = proj(); p.name = 'Demo';
    p.queries[0].steps.push({ id: 'g', name: 'G', kind: { type: 'GroupBy', keys: ['label'], aggs: [{ fn: 'sum', col: 'z', name: 'z' }] } });
    const py = PQ.Steps.toPython(p);
    assert(/import polars as pl/.test(py) && /\.group_by\(\["label"\]/.test(py) && /\.rename\(\{"y": "label"\}\)/.test(py), py);
    assert(!/undefined/.test(py), 'no undefined in output');
  });
  test('Python export: every step kind generates balanced, undefined-free code', () => {
    const kinds = [
      { type: 'SelectColumns', cols: ['x'] }, { type: 'ReorderColumns', cols: ['x'] }, { type: 'RemoveColumns', cols: ['x'] }, { type: 'Rename', map: [['x', 'y']] },
      { type: 'ChangeType', changes: [{ col: 'x', type: 'number' }, { col: 'd', type: 'date' }, { col: 'b', type: 'bool' }] }, { type: 'Filter', mode: 'advanced', formula: '[x] > 1 and [y] in {"a"}' },
      { type: 'Sort', by: [{ col: 'x', desc: true }] }, { type: 'Distinct', subset: [] }, { type: 'KeepDuplicates', subset: [] },
      ...['top', 'bottom', 'range', 'remove_top', 'remove_bottom', 'alternate', 'remove_blank'].map((mode) => ({ type: 'KeepRows', mode, n: 2, offset: 1, keep: 1, skip: 1 })),
      { type: 'PromoteHeaders', row: 1 }, { type: 'DemoteHeaders' }, { type: 'FillDown', cols: ['x'] }, { type: 'FillUp', cols: ['x'] },
      { type: 'ReplaceValues', cols: ['x'], find: 'a', replace: 'b', wholeCell: true }, { type: 'ReplaceValues', cols: ['x'], find: null, replace: '0' }, { type: 'ReplaceErrors', cols: ['x'], value: '0' },
      { type: 'TextTransform', op: 'trim', cols: ['x'] }, { type: 'RoundNumbers', cols: ['x'], digits: 2 },
      { type: 'SplitColumn', col: 'x', mode: 'each', delimiter: ',', count: 2 }, { type: 'SplitColumn', col: 'x', mode: 'rows', delimiter: ',' },
      { type: 'MergeColumns', cols: ['x', 'y'], sep: ' ', name: 'm' }, { type: 'AddColumn', name: 'c', formula: 'Text.Upper([y]) & "-" & Text.From(Date.Year([d]))' },
      { type: 'ConditionalColumn', name: 'k', rules: [{ when: '[x] > 1', then: '"hi"' }], else: '"lo"' }, { type: 'IndexColumn', name: 'i', start: 1, step: 1 }, { type: 'DuplicateColumn', col: 'x' },
      { type: 'GroupBy', keys: ['y'], aggs: [{ fn: 'sum', col: 'x' }, { fn: 'count_rows' }, { fn: 'concat', col: 'y' }] }, { type: 'Unpivot', ids: ['y'] },
      { type: 'Pivot', on: 'y', values: 'x', agg: 'sum', index: [] }, { type: 'Transpose' }, { type: 'Window', op: 'cumsum', col: 'x', partition: ['y'], name: 'w' },
      { type: 'ExpandJson', col: 'j' }, { type: 'CustomSql', sql: 'SELECT * FROM self' }, { type: 'Checkpoint' },
    ];
    const p = { name: 'All', settings: { previewRows: 1000, locale: 'de-DE' }, params: [{ name: 'D', type: 'date', value: '2026-01-01' }], queries: [{ id: 'q', name: 'Q', load: { target: 'xlsx' }, steps: [{ id: 's', name: 'Source', kind: { type: 'Source', source: { kind: 'file', fileName: 'a.csv', csv: { delimiter: ';' } } } }].concat(kinds.map((k, i) => ({ id: 'k' + i, name: k.type, kind: k }))) }] };
    const py = PQ.Steps.toPython(p);
    assert(!/undefined|NaN|\[object/.test(py), 'bad token in output');
    const stripped = py.replace(/"""[\s\S]*?"""/g, '').replace(/r?"(?:[^"\\]|\\.)*"/g, '""').replace(/#[^\n]*/g, '');
    const bal = (o, c) => stripped.split(o).length === stripped.split(c).length;
    assert(bal('(', ')') && bal('[', ']') && bal('{', '}'), 'unbalanced brackets');
    kinds.forEach((k) => assert(py.includes('# ' + k.type), 'missing ' + k.type));
  });
  test('Project files: stable, one file per query, format_version', () => { const p = proj(); p.name = 'X'; const f = PQ.Steps.toFiles(p); assert(f['project.json'].includes('"format_version": 1')); assert(f['queries/a.json']); assertEq(PQ.Steps.toFiles(p)['queries/a.json'], f['queries/a.json']); });
  test('migrate fills defaults, rejects newer format', () => { const m = PQ.Steps.migrate({ queries: [{ id: 'q', name: 'Q' }] }); assertEq(m.settings.previewRows, 1000); let threw = false; try { PQ.Steps.migrate({ format_version: 99 }); } catch (e) { threw = true; } assert(threw); });

  /* ---------- host suggestions ---------- */
  test('suggestions: generic headers, fill down, subtotal rows', () => {
    const p = { settings: { previewRows: 1000, locale: 'en-US' }, params: [], queries: [{ id: 'r', name: 'R', steps: [{ id: 's', name: 'Source', kind: { type: 'Source', source: { kind: 'file', fileId: 'rep', fileName: rep.name, format: 'excel', item: { type: 'range', sheet: 'Report', range: 'A4:F23' } } } }, { id: 'p', name: 'P', kind: { type: 'PromoteHeaders', row: 0 } }] }] };
    PQ.Files.set('rep', rec); E.setProject(p);
    const r = PQ.Host.handle({ op: 'evaluate', qid: 'r', mode: 'preview' });
    return r.then((x) => { const ids = x.suggestions.map((s) => s.id); assert(ids.includes('fill_Region') && ids.includes('subtotal'), ids.join(',')); });
  });

  // perf smoke test: 60k-row CSV → group by
  test('perf: 60k-row CSV parse + type + group by < 3s', () => {
    const o = samples.find((s) => s.name === 'orders.csv');
    const t0 = performance.now();
    const f = { id: 'o', name: 'orders.csv', buf: new TextEncoder().encode(o.text).buffer, mtime: 1, size: 1 };
    let t = PQ.IO.readFile(f, { csv: { delimiter: ',', header: true } }, Infinity);
    t = E.X.ChangeType(t, { changes: [{ col: 'quantity', type: 'int' }, { col: 'unit_price', type: 'number' }] }, ctx);
    t = E.X.GroupBy(t, { keys: ['product_id'], aggs: [{ fn: 'sum', col: 'quantity' }] });
    const ms = performance.now() - t0;
    assert(t.n === 6 && ms < 3000, 'took ' + ms + 'ms, rows ' + t.n);
    out.insertAdjacentHTML('beforeend', '<li class="faint">   60,000 rows in ' + Math.round(ms) + ' ms</li>');
  });

  async function atest(name, fn) {
    try { await fn(); pass++; out.insertAdjacentHTML('beforeend', '<li class="ok">✓ ' + PQ.esc(name) + '</li>'); }
    catch (e) { fail++; out.insertAdjacentHTML('beforeend', '<li class="bad">✗ ' + PQ.esc(name) + '<pre>' + PQ.esc(e.stack || e.message) + '</pre></li>'); console.error('FAIL', name, e.message); }
  }
  const typed = () => T.fromRows(['id', 'name', 'price', 'ok', 'day'], [[1, 'Ana', 1.5, true, new Date(Date.UTC(2026, 0, 2))], [2, null, null, false, null], [3, 'Zoë', 3.25, null, new Date(Date.UTC(2026, 5, 30))]], ['int', 'text', 'number', 'bool', 'date']);
  const roundtrip = (t2) => [t2.names, t2.cols.map((c) => c.type), t2.toRows().map((r) => r.map((v) => (v instanceof Date ? PQ.fmtDate(v) : v)))];

  /* ---------- v0.4: columnar formats ---------- */
  await atest('Parquet: write → read round-trip keeps names, types, nulls', async () => {
    const buf = await PQ.IO.toParquet(typed());
    const t2 = await PQ.IO.decodeParquet({ id: 'pq1', name: 'x.parquet', mtime: 1, size: buf.byteLength, buf });
    assertEq(roundtrip(t2), roundtrip(typed()));
  });
  await atest('Parquet: readFile honours the preview row limit', async () => {
    const buf = await PQ.IO.toParquet(typed());
    const rec = { id: 'pq2', name: 'y.parquet', mtime: 1, size: buf.byteLength, buf };
    PQ.Files.set(rec.id, rec);
    await PQ.IO.prepare();
    const t2 = PQ.IO.readFile(rec, {}, 2);
    assert(t2.n === 2 && t2.meta.truncated, 'rows ' + t2.n);
    PQ.Files.delete(rec.id);
  });
  const hpw = await import('../vendor/hyparquet-writer.min.js');
  const bigParquet = (n, groups) => {
    const id = [], name = [], amt = [], day = [], flag = [];
    for (let i = 0; i < n; i++) { id.push(BigInt(i)); name.push('n' + (i % 7)); amt.push(i * 1.5); day.push(new Date(Date.UTC(2026, 0, 1 + (i % 28)))); flag.push(i % 3 === 0 ? null : i % 2 === 0); }
    return hpw.parquetWriteBuffer({ rowGroupSize: Math.ceil(n / groups), columnData: [{ name: 'id', data: id, type: 'INT64' }, { name: 'name', data: name, type: 'STRING' }, { name: 'amt', data: amt, type: 'DOUBLE' }, { name: 'day', data: day, type: 'TIMESTAMP' }, { name: 'flag', data: flag, type: 'BOOLEAN' }] });
  };
  const pqProj = (steps, recId, extraSrc) => ({ settings: { previewRows: 100, locale: 'en-US' }, params: [], queries: [{ id: 'p', name: 'P', steps: [{ id: 's', name: 'Source', kind: { type: 'Source', source: Object.assign({ kind: 'file', fileId: recId, fileName: recId + '.parquet', format: 'parquet' }, extraSrc || {}) } }].concat(steps.map((k, i) => ({ id: 'k' + i, name: k.type, kind: k }))) }] });
  await atest('Parquet streaming: preview reads only the first row group', async () => {
    const buf = bigParquet(1000, 10);
    const rec = { id: 'pqs1', name: 'pqs1.parquet', mtime: 1, size: buf.byteLength, buf };
    PQ.Files.set(rec.id, rec);
    E.setProject(pqProj([], rec.id)); E.clearCache();
    const r = await PQ.Host.handle({ op: 'evaluate', qid: 'p', mode: 'preview' });
    assert(r.n === 100 && r.truncated, 'rows ' + r.n);
    const lr = PQ.IO.parquetLastRead;
    assert(lr.rowGroups === 1 && lr.totalRowGroups === 10, JSON.stringify(lr));
    assert(lr.bytes < buf.byteLength / 2, 'bytes ' + lr.bytes + ' of ' + buf.byteLength);
    assert(/1 of 10 row groups/.test(r.note), r.note);
    PQ.Files.delete(rec.id);
  });
  await atest('Parquet streaming: full run reads all groups, values intact across boundaries', async () => {
    const buf = bigParquet(1000, 10);
    const rec = { id: 'pqs2', name: 'pqs2.parquet', mtime: 1, size: buf.byteLength, buf };
    PQ.Files.set(rec.id, rec);
    E.setProject(pqProj([], rec.id)); E.clearCache();
    await PQ.Host.handle({ op: 'evaluate', qid: 'p', mode: 'full' });
    const t = E.evaluate('p', undefined, 'full').table;
    assert(t.n === 1000, 'n ' + t.n);
    assertEq([t.get('id')[99], t.get('id')[100], t.get('id')[999]], [99, 100, 999]);
    assertEq(t.cols.map((c) => c.type), ['int', 'text', 'number', 'date', 'bool']);
    assertEq([t.get('flag')[0], t.get('flag')[2], t.get('flag')[1]], [null, true, false]);
    assert(PQ.IO.parquetLastRead.rowGroups === 10, 'groups');
    PQ.Files.delete(rec.id);
  });
  await atest('Parquet projection: unused columns are never read, schema stays in place', async () => {
    const buf = bigParquet(500, 5);
    const rec = { id: 'pqs3', name: 'pqs3.parquet', mtime: 1, size: buf.byteLength, buf };
    PQ.Files.set(rec.id, rec);
    E.setProject(pqProj([{ type: 'Filter', mode: 'advanced', formula: '[amt] > 10' }, { type: 'SelectColumns', cols: ['name', 'amt'] }], rec.id)); E.clearCache();
    const r = await PQ.Host.handle({ op: 'evaluate', qid: 'p', mode: 'full' });
    assertEq(r.schema.map((c) => c.name), ['name', 'amt']);
    assertEq(PQ.IO.parquetLastRead.columns, ['name', 'amt']);
    assert(r.n === 493, 'n ' + r.n);
    const r0 = await PQ.Host.handle({ op: 'evaluate', qid: 'p', upto: 0, mode: 'full' });
    assertEq(r0.schema.map((c) => c.name), ['id', 'name', 'amt', 'day', 'flag']);
    PQ.Files.delete(rec.id);
  });
  test('Parquet projection planner: renames, formulas, group by, removes, unknown steps', () => {
    const ns = ['a', 'b', 'c', 'd', 'e'];
    const q = (steps) => ({ steps: [{ kind: { type: 'Source' } }].concat(steps.map((k) => ({ kind: k }))) });
    const P = PQ.IO.parquetProjection;
    assertEq(P(q([{ type: 'RemoveColumns', cols: ['d', 'e'] }]), undefined, ns).cols, ['a', 'b', 'c']);
    assertEq(P(q([{ type: 'Rename', map: [['a', 'x']] }, { type: 'SelectColumns', cols: ['x', 'c'] }]), undefined, ns).cols, ['a', 'c']);
    assertEq(P(q([{ type: 'AddColumn', name: 'z', formula: '[b] * 2' }, { type: 'SelectColumns', cols: ['z', 'a'] }]), undefined, ns).cols, ['a', 'b']);
    assertEq(P(q([{ type: 'GroupBy', keys: ['c'], aggs: [{ fn: 'sum', col: 'd' }, { fn: 'count_rows' }] }]), undefined, ns).cols, ['c', 'd']);
    assert(P(q([{ type: 'Filter', mode: 'advanced', formula: '[e] > 1' }, { type: 'RemoveColumns', cols: ['e'] }]), undefined, ns) === null, 'a column used before removal must be read');
    assertEq(P(q([{ type: 'Filter', mode: 'advanced', formula: '[e] > 1' }, { type: 'SelectColumns', cols: ['a'] }]), undefined, ns).cols, ['a', 'e']);
    assert(P(q([{ type: 'CustomSql', sql: 'SELECT a FROM self' }, { type: 'SelectColumns', cols: ['a'] }]), undefined, ns) === null, 'unknown step must disable projection');
    assert(P(q([{ type: 'Distinct' }, { type: 'SelectColumns', cols: ['a'] }]), undefined, ns) === null, 'distinct over all columns keeps every column');
    assertEq(P(q([{ type: 'SelectColumns', cols: ['a', 'b'] }, { type: 'Filter', mode: 'advanced', formula: '[c] > 1' }]), 0, ns), null);
  });
  await atest('Parquet projection: source column list limits reading and the schema', async () => {
    const buf = bigParquet(300, 3);
    const rec = { id: 'pqs4', name: 'pqs4.parquet', mtime: 1, size: buf.byteLength, buf };
    PQ.Files.set(rec.id, rec);
    E.setProject(pqProj([], rec.id, { columns: ['amt', 'id'] })); E.clearCache();
    const r = await PQ.Host.handle({ op: 'evaluate', qid: 'p', mode: 'preview' });
    assertEq(r.schema.map((c) => c.name), ['amt', 'id']);
    E.setProject(pqProj([], rec.id, { columns: ['nope'] })); E.clearCache();
    const r2 = await PQ.Host.handle({ op: 'evaluate', qid: 'p', mode: 'preview' });
    assert(/no longer in this Parquet file/.test(r2.states[0].error), r2.states[0].error);
    PQ.Files.delete(rec.id);
  });
  await atest('Parquet lazy: Blob-backed file (no ArrayBuffer) reads by byte range', async () => {
    const buf = bigParquet(800, 8);
    const blob = new Blob([buf]);
    const rec = { id: 'pqs5', name: 'pqs5.parquet', mtime: 1, size: blob.size, buf: null, blob };
    PQ.Files.set(rec.id, rec);
    E.setProject(pqProj([{ type: 'SelectColumns', cols: ['id'] }], rec.id)); E.clearCache();
    const r = await PQ.Host.handle({ op: 'evaluate', qid: 'p', mode: 'preview' });
    assert(r.n === 100, 'n ' + r.n);
    const lr = PQ.IO.parquetLastRead;
    assert(lr.rowGroups === 1 && lr.columns.length === 1 && lr.bytes < blob.size / 4, JSON.stringify(lr));
    const info = (await PQ.Host.handle({ op: 'inspectFile', fileId: rec.id })).info;
    assert(info.rows === 800 && info.meta.rowGroups === 8 && info.meta.lazy, JSON.stringify(info.meta));
    PQ.Files.delete(rec.id);
  });
  const fullRun = async (steps, recId) => {
    PQ.IO.parquetForget(recId);
    E.setProject(pqProj(steps, recId)); E.clearCache();
    const r = await PQ.Host.handle({ op: 'evaluate', qid: 'p', mode: 'full' });
    const t = E.evaluate('p', undefined, 'full').table;
    return { r, t, lr: PQ.IO.parquetLastRead, rows: t.toRows().map((row) => row.map((v) => (v instanceof Date ? PQ.fmtDate(v) : v))) };
  };
  await atest('Parquet pushdown: filter skips row groups by min/max, result identical to a plain filter', async () => {
    const buf = bigParquet(1000, 10); // id 0..999, 100 rows per group, amt = id * 1.5
    const rec = { id: 'pqp1', name: 'pqp1.parquet', mtime: 1, size: buf.byteLength, buf };
    PQ.Files.set(rec.id, rec);
    const cases = [
      ['[id] >= 850', 8], ['[id] > 899', 9], ['[id] < 100', 9], ['[id] <= 99', 9], ['[id] = 512', 9],
      ['[id] in {5, 950}', 8], ['[id] >= 300 and [id] < 400', 9], ['[id] < 100 or [id] >= 900', 8],
      ['[amt] > 1490', 9], ['900 <= [id]', 9], ['[id] > @Cut', 9], ['[id] >= 400 + 500', 9],
    ];
    for (const [f, skipped] of cases) {
      const steps = [{ type: 'SelectColumns', cols: ['id', 'amt'] }, { type: 'Filter', mode: 'advanced', formula: f }];
      const p = pqProj(steps, rec.id); p.params = [{ name: 'Cut', type: 'number', value: '900' }];
      PQ.IO.parquetForget(rec.id);
      E.setProject(p); E.clearCache();
      const res = await PQ.Host.handle({ op: 'evaluate', qid: 'p', mode: 'full' });
      const t = E.evaluate('p', undefined, 'full').table;
      const lr = PQ.IO.parquetLastRead;
      assert(lr, f + ': ' + JSON.stringify(res.states.map((s) => s.error)));
      assert(lr.skippedRowGroups === skipped, f + ' → skipped ' + lr.skippedRowGroups + ', expected ' + skipped);
      // reference: same filter on the full table, computed in JS
      const ids = Array.from({ length: 1000 }, (_, i) => i);
      const ref = PQ.Formula.evaluate(f, T.fromRows(['id', 'amt'], ids.map((i) => [i, i * 1.5]), ['int', 'number']), p.params).values;
      assertEq(t.get('id'), ids.filter((i) => ref[i] === true), f);
    }
    PQ.Files.delete(rec.id);
  });
  await atest('Parquet pushdown: never prunes when it could change the answer', async () => {
    const buf = bigParquet(1000, 10);
    const rec = { id: 'pqp2', name: 'pqp2.parquet', mtime: 1, size: buf.byteLength, buf };
    PQ.Files.set(rec.id, rec);
    const none = [
      [{ type: 'Filter', mode: 'advanced', formula: '[id] <> 5' }],                       // <> keeps almost every group
      [{ type: 'Filter', mode: 'advanced', formula: 'not ([id] < 900)' }],                // negation not analysed
      [{ type: 'Filter', mode: 'advanced', formula: '[id] * 2 > 1900' }],                 // expression over a column
      [{ type: 'Filter', mode: 'advanced', formula: '[id] > "900"' }],                    // kind mismatch
      [{ type: 'Filter', mode: 'advanced', formula: '[id] >= 900 or [name] = "n1"' }],    // one side unprunable
      [{ type: 'IndexColumn', name: 'ix' }, { type: 'Filter', mode: 'advanced', formula: '[id] >= 900' }], // row-sensitive step first
      [{ type: 'Filter', mode: 'advanced', formula: '[id] >= 900 and [day] > #date(2026, 1, 20)' }], // timestamp column read: type comes from values
    ];
    for (const st of none) {
      const steps = st[st.length - 1].formula.includes('[day]') ? st : [{ type: 'SelectColumns', cols: ['id', 'name'] }].concat(st);
      const { lr } = await fullRun(steps, rec.id);
      assert(!lr.skippedRowGroups, JSON.stringify(steps) + ' skipped ' + lr.skippedRowGroups);
    }
    // pruning still applies through column-only steps; preview mode never prunes
    const { lr, t } = await fullRun([{ type: 'SelectColumns', cols: ['id', 'name'] }, { type: 'Filter', mode: 'builder', builder: { join: 'and', conds: [{ col: 'id', op: 'ge', value: '950' }] } }], rec.id);
    assert(lr.skippedRowGroups === 9 && t.n === 50, JSON.stringify(lr) + ' n=' + t.n);
    PQ.IO.parquetForget(rec.id);
    E.setProject(pqProj([{ type: 'SelectColumns', cols: ['id'] }, { type: 'Filter', mode: 'advanced', formula: '[id] >= 950' }], rec.id)); E.clearCache();
    await PQ.Host.handle({ op: 'evaluate', qid: 'p', mode: 'preview' });
    assert(!PQ.IO.parquetLastRead.skippedRowGroups, 'preview pruned');
    PQ.Files.delete(rec.id);
  });
  await atest('Parquet pushdown: text ranges and export use the pruned read', async () => {
    const n = 600, key = [], v = [];
    for (let i = 0; i < n; i++) { key.push('k' + String(i).padStart(4, '0')); v.push(i); }
    const buf = hpw.parquetWriteBuffer({ rowGroupSize: 100, columnData: [{ name: 'key', data: key, type: 'STRING' }, { name: 'v', data: v, type: 'INT32' }] });
    const rec = { id: 'pqp3', name: 'pqp3.parquet', mtime: 1, size: buf.byteLength, buf };
    PQ.Files.set(rec.id, rec);
    const { lr, t } = await fullRun([{ type: 'Filter', mode: 'advanced', formula: '[key] >= "k0550"' }], rec.id);
    assert(lr.skippedRowGroups === 5 && t.n === 50 && t.get('key')[0] === 'k0550', JSON.stringify(lr) + ' n=' + t.n);
    const ex = await PQ.Host.handle({ op: 'exportQuery', qid: 'p', format: 'csv' });
    assert(ex.rows === 50 && PQ.IO.parquetLastRead.skippedRowGroups === 5, 'export rows ' + ex.rows);
    PQ.Files.delete(rec.id);
  });
  test('codegen: parquet source column list becomes a select', () => {
    const p = pqProj([], 'x', { columns: ['a', 'b'] });
    p.queries[0].steps[0].kind.source.fileName = 'x.parquet';
    assert(PQ.Steps.toPython(p).includes('pl.scan_parquet(DATA_DIR / "x.parquet").select(["a", "b"])'), 'select missing');
  });
  test('Arrow IPC: write → read round-trip', () => {
    const buf = PQ.IO.toArrow(typed());
    const t2 = PQ.IO.decodeArrow({ id: 'ar1', name: 'x.arrow', mtime: 1, size: buf.byteLength, buf });
    assertEq(roundtrip(t2), roundtrip(typed()));
  });
  test('fileKind recognises parquet / arrow / feather', () => assertEq(['a.parquet', 'b.arrow', 'c.feather', 'd.csv'].map(PQ.IO.fileKind), ['parquet', 'arrow', 'arrow', 'csv']));

  /* ---------- v0.4: new steps ---------- */
  test('Sort: locale-aware, numeric-aware text, stable, nulls last', () => {
    const t = T.fromRows(['s', 'i'], [['item10', 1], ['Item2', 2], [null, 3], ['élan', 4], ['eagle', 5], ['item2', 6]], ['text', 'int']);
    assertEq(col(E.X.Sort(t, { by: [{ col: 's' }] }), 'i'), [5, 4, 2, 6, 1, 3]);
    assertEq(col(E.X.Sort(t, { by: [{ col: 's', desc: true }] }), 'i'), [1, 2, 6, 4, 5, 3]);
  });
  test('Sort: 200k rows < 1.5s', () => {
    const n = 200000, a = new Array(n), b = new Array(n);
    let s = 7; for (let i = 0; i < n; i++) { s = (s * 16807) % 2147483647; a[i] = 'k' + (s % 5000); b[i] = s % 997; }
    const t = new T([{ name: 'a', type: 'text' }, { name: 'b', type: 'int' }], [a, b], n);
    const t0 = performance.now(); const r = E.X.Sort(t, { by: [{ col: 'a' }, { col: 'b', desc: true }] }); const ms = performance.now() - t0;
    assert(r.n === n && ms < 1500, ms + 'ms');
    out.insertAdjacentHTML('beforeend', '<li class="faint">   200,000-row two-key sort in ' + Math.round(ms) + ' ms</li>');
  });
  test('Sample: deterministic by seed, keeps order, n and percent', () => {
    const t = T.fromRows(['x'], Array.from({ length: 100 }, (_, i) => [i]), ['int']);
    const a = col(E.X.Sample(t, { mode: 'n', n: 10, seed: 1 }), 'x'), b = col(E.X.Sample(t, { mode: 'n', n: 10, seed: 1 }), 'x');
    assertEq(a, b); assert(a.length === 10 && a.every((v, i) => !i || v > a[i - 1]), JSON.stringify(a));
    assert(E.X.Sample(t, { mode: 'percent', percent: 25 }).n === 25);
  });
  test('Fingerprint: case, accents, punctuation, word order', () => assertEq(['Acme, Inc.', 'acme inc', 'Inc ACME', 'Société Générale', 'societe generale'].map(PQ.fingerprint), ['acme inc', 'acme inc', 'acme inc', 'generale societe', 'generale societe']));
  test('ClusterValues: clusters find variants, step merges to most frequent', () => {
    const t = T.fromRows(['c'], [['Berlin'], ['Berlin'], ['berlin '], ['BERLIN'], ['Lisbon'], ['lisbon'], ['Lisbon'], ['Osaka']], ['text']);
    const cl = E.clusters(t, 'c', 'fingerprint');
    assertEq(cl.map((c) => c.canonical), ['Berlin', 'Lisbon']);
    assertEq(col(E.X.ClusterValues(t, { col: 'c', pairs: E.clusterPairs(cl) }), 'c'), ['Berlin', 'Berlin', 'Berlin', 'Berlin', 'Lisbon', 'Lisbon', 'Lisbon', 'Osaka']);
    assertEq(col(E.X.ClusterValues(t, { col: 'c', auto: true }), 'c').filter((v) => v === 'Berlin').length, 4);
  });
  test('Validate: flag / keep_valid / keep_invalid / fail with fixes', () => {
    const t = T.fromRows(['id', 'email', 'age'], [[1, 'a@x.io', 30], [2, 'bad', 200], [2, null, 40]], ['int', 'text', 'int']);
    const rules = [{ col: 'id', check: 'unique' }, { col: 'email', check: 'regex', arg: '^[^@]+@[^@]+$' }, { col: 'age', check: 'range', arg: '0', arg2: '120' }, { col: 'email', check: 'not_null' }];
    const f = E.X.Validate(t, { rules, action: 'flag' });
    assertEq(col(f, 'Issues').map((x) => (x ? x.split('; ').length : 0)), [0, 3, 2]);
    assert(E.X.Validate(t, { rules, action: 'keep_valid' }).n === 1 && E.X.Validate(t, { rules, action: 'keep_invalid' }).n === 2);
    let err = null; try { E.X.Validate(t, { rules, action: 'fail' }); } catch (e) { err = e; }
    assert(err && /2 rows fail/.test(err.message) && err.fixes.length === 2, err && err.message);
  });
  test('Formula: regex + diacritics + clamp', () => {
    const t = T.fromRows(['s'], [['AB-123 Chloé'], ['xx']], ['text']);
    assertEq(PQ.Formula.evaluate('Text.RegexMatch([s], "^[A-Z]{2}-\\d+")', t).values, [true, false]);
    assertEq(PQ.Formula.evaluate('Text.RegexExtract([s], "-(\\d+)", 1)', t).values, ['123', null]);
    assertEq(PQ.Formula.evaluate('Text.RemoveDiacritics(Text.RegexReplace([s], "\\d", "#"))', t).values, ['AB-### Chloe', 'xx']);
    assertEq(PQ.Formula.evaluate('Number.Clamp(Text.Length([s]) * 10, 0, 100)', t).values, [100, 20]);
  });
  test('Overview: quality score, duplicates, whitespace, per-column stats', () => {
    const t = T.fromRows(['a', 'b'], [['x ', 1], ['x ', 1], [null, 2], ['y', new PQ.CellError('bad')]], ['text', 'int']);
    const o = E.overview(t);
    assert(o.duplicateRows === 1 && o.errors === 1 && o.empty === 1 && o.whitespace === 2 && o.score < 100 && o.score > 0, JSON.stringify(o));
    assertEq([o.columns[0].distinct, o.columns[0].top, o.columns[0].topCount], [2, 'x ', 2]);
  });
  test('codegen: new steps + parquet/arrow sources and sinks are emitted', () => {
    const p = { name: 'N', settings: { previewRows: 1000, locale: 'en-US' }, params: [], queries: [
      { id: 'a', name: 'A', load: { target: 'parquet' }, steps: [{ id: 's', name: 'Source', kind: { type: 'Source', source: { kind: 'file', fileName: 'in.parquet' } } },
        { id: 'v', name: 'Validate', kind: { type: 'Validate', rules: [{ col: 'x', check: 'regex', arg: '^\\d+$' }], action: 'fail' } },
        { id: 'c', name: 'ClusterValues', kind: { type: 'ClusterValues', col: 'x', pairs: [['a ', 'a']] } },
        { id: 'm', name: 'Sample', kind: { type: 'Sample', mode: 'n', n: 5, seed: 3 } }] },
      { id: 'b', name: 'B', load: { target: 'arrow' }, steps: [{ id: 's', name: 'Source', kind: { type: 'Source', source: { kind: 'file', fileName: 'in.feather' } } }] }] };
    const py = PQ.Steps.toPython(p);
    ['pl.scan_parquet', 'pl.scan_ipc', 'def assert_valid', '.replace({"a ": "a"})', '.sample(n=5, seed=3)', 'sink_parquet', 'sink_ipc'].forEach((s) => assert(py.includes(s), 'missing ' + s));
  });
  await atest('host: overview + clusters ops, cluster suggestion appears', async () => {
    const p = { settings: { previewRows: 1000, locale: 'en-US' }, params: [], queries: [{ id: 'c', name: 'C', steps: [{ id: 's', name: 'Source', kind: { type: 'Source', source: { kind: 'blank', columns: ['city', 'n'], rows: [['Berlin', '1'], ['berlin', '2'], ['Berlin', '3'], ['Lisbon', '4']] } } }] }] };
    E.setProject(p);
    const r = await PQ.Host.handle({ op: 'evaluate', qid: 'c', mode: 'preview' });
    assert(r.fp && r.suggestions.some((s) => s.id === 'cluster_city'), JSON.stringify(r.suggestions.map((s) => s.id)));
    const o = await PQ.Host.handle({ op: 'overview', fp: r.fp });
    assert(o.overview.rows === 4 && o.overview.columns.length === 2);
    const c = await PQ.Host.handle({ op: 'clusters', qid: 'c', col: 'city' });
    assertEq(c.clusters[0].canonical, 'Berlin');
  });
  await atest('host: export to parquet and arrow on full data', async () => {
    const p = { settings: { previewRows: 2, locale: 'en-US' }, params: [], queries: [{ id: 'e', name: 'E', steps: [{ id: 's', name: 'Source', kind: { type: 'Source', source: { kind: 'blank', columns: ['a'], rows: [['1'], ['2'], ['3']] } } }] }] };
    E.setProject(p);
    for (const format of ['parquet', 'arrow']) {
      const r = await PQ.Host.handle({ op: 'exportQuery', qid: 'e', format });
      assert(r.rows === 3 && r.data.byteLength > 50, format);
    }
  });

  await new Promise((r) => setTimeout(r, 50));
  const sum = document.getElementById('sum');
  sum.textContent = pass + ' passed, ' + fail + ' failed';
  sum.className = 'sum ' + (fail ? 'bad' : 'ok');
  console.log('RESULT ' + pass + ' passed, ' + fail + ' failed');
})();
