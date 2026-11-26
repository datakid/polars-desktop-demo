import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const python = process.env.PYTHON || 'python3';
const dir = mkdtempSync(join(tmpdir(), 'floe-pyexport-'));
const data = join(dir, 'data');
mkdirSync(data);

const names = [' alice smith', 'BOB jones ', 'Carol  white', ''];
const rows = ['id,grp,val,price,name,day,ok,ts,code'];
for (let i = 1; i <= 120; i++) {
  const hour = String(i % 24).padStart(2, '0'), minute = i % 2 ? '30' : '00';
  const code = i % 13 === 0 ? '' : i % 7 === 0 ? 'Z' : String.fromCharCode(65 + (i % 26)) + String.fromCharCode(66 + (i % 25)) + '-' + String(i).padStart(4, '0');
  rows.push([i, 'abc'[i % 3], (i * 37) % 101, i % 11 === 0 ? '' : ((i * 13 % 1000) / 10).toFixed(1), names[i % 4], '2025-01-' + String((i % 28) + 1).padStart(2, '0'), i % 17 === 0 ? '' : i % 3 === 0 ? 'true' : 'false', i % 19 === 0 ? '' : '2025-01-' + String((i % 28) + 1).padStart(2, '0') + ' ' + hour + ':' + minute + ':00', code].join(','));
}
writeFileSync(join(data, 'orders.csv'), rows.join('\n') + '\n');

const src = { type: 'Source', source: { kind: 'file', fileId: 'orders.csv', fileName: 'orders.csv', csv: { delimiter: ',', header: true } } };
const ct = { type: 'ChangeType', changes: [{ col: 'id', type: 'int' }, { col: 'val', type: 'int' }, { col: 'price', type: 'number' }, { col: 'day', type: 'date' }, { col: 'ok', type: 'bool' }, { col: 'ts', type: 'datetime' }] };
const C = [
  ['filter_num', { type: 'Filter', mode: 'advanced', formula: '[val] > 50' }],
  ['filter_or', { type: 'Filter', mode: 'advanced', formula: '[grp] = "a" or [val] < 10' }],
  ['sort', { type: 'Sort', by: [{ col: 'grp', desc: false }, { col: 'val', desc: true }, { col: 'id', desc: false }] }],
  ['distinct', { type: 'Distinct', subset: ['grp', 'val'] }],
  ['keepdup', { type: 'KeepDuplicates', subset: ['grp', 'val'] }],
  ...['top', 'bottom', 'range', 'remove_top', 'remove_bottom', 'alternate', 'remove_blank'].map((mode) => ['keeprows_' + mode, { type: 'KeepRows', mode, n: 5, offset: 2, keep: 2, skip: 1 }]),
  ['filldown', { type: 'FillDown', cols: ['price'] }], ['fillup', { type: 'FillUp', cols: ['price'] }],
  ['replace', { type: 'ReplaceValues', cols: ['name'], find: 'alice', replace: 'ALICE' }],
  ['replace_whole', { type: 'ReplaceValues', cols: ['grp'], find: 'a', replace: 'z', wholeCell: true }],
  ['replace_null', { type: 'ReplaceValues', cols: ['price'], find: null, replace: '0' }],
  ...['trim', 'upper', 'lower', 'proper', 'clean'].map((op) => ['text_' + op, { type: 'TextTransform', op, cols: ['name'] }]),
  ['round0', { type: 'RoundNumbers', cols: ['price'], digits: 0 }], ['round1', { type: 'RoundNumbers', cols: ['price'], digits: 1 }],
  ['split_each', { type: 'SplitColumn', col: 'name', mode: 'each', delimiter: ' ', count: 2 }],
  ['split_rows', { type: 'SplitColumn', col: 'name', mode: 'rows', delimiter: ' ' }],
  ['mergecols', { type: 'MergeColumns', cols: ['grp', 'val'], sep: '-', name: 'm' }],
  ['add_arith', { type: 'AddColumn', name: 'c', formula: '[val] * 2 + 1' }],
  ['add_text', { type: 'AddColumn', name: 'c', formula: 'Text.Upper([grp]) & "-" & Text.From([val])' }],
  ['add_year', { type: 'AddColumn', name: 'c', formula: 'Date.Year([day]) * 100 + Date.Month([day])' }],
  ['add_coalesce', { type: 'AddColumn', name: 'c', formula: 'Coalesce([price], 0) + 1' }],
  ['add_if', { type: 'AddColumn', name: 'c', formula: 'if [val] > 50 then "hi" else "lo"' }],
  ['conditional', { type: 'ConditionalColumn', name: 'k', rules: [{ when: '[val] > 80', then: '"top"' }, { when: '[val] > 40', then: '"mid"' }], else: '"low"' }],
  ['index', { type: 'IndexColumn', name: 'i', start: 5, step: 2 }],
  ['dupcol', { type: 'DuplicateColumn', col: 'val' }],
  ['groupby', { type: 'GroupBy', keys: ['grp'], aggs: [{ fn: 'sum', col: 'val' }, { fn: 'count_rows' }, { fn: 'min', col: 'val' }, { fn: 'max', col: 'val' }, { fn: 'mean', col: 'val' }] }],
  ['groupby2', { type: 'GroupBy', keys: ['grp', 'name'], aggs: [{ fn: 'sum', col: 'val' }] }],
  ['unpivot', { type: 'Unpivot', ids: ['id', 'grp'] }],
  ['pivot', { type: 'Pivot', on: 'grp', values: 'val', agg: 'sum', index: ['name'] }],
  ['win_cumsum', { type: 'Window', op: 'cumsum', col: 'val', partition: ['grp'], name: 'w' }],
  ['win_rank', { type: 'Window', op: 'rank', col: 'val', partition: [], name: 'w' }],
  ['win_lag', { type: 'Window', op: 'lag', col: 'val', partition: ['grp'], name: 'w', n: 1 }],
  ['win_pct', { type: 'Window', op: 'pct_of_total', col: 'val', partition: ['grp'], name: 'w' }],
  ['win_roll', { type: 'Window', op: 'rolling_sum', col: 'val', partition: [], name: 'w', n: 3 }],
  ['sample_n', { type: 'Sample', mode: 'n', n: 37, seed: 7 }],
  ['sample_default_seed', { type: 'Sample', mode: 'n', n: 50 }],
  ['sample_percent', { type: 'Sample', mode: 'percent', percent: 12.5 }],
  ['sample_percent_half', { type: 'Sample', mode: 'percent', percent: 0.1, seed: 3 }],
  ['sample_zero_seed', { type: 'Sample', mode: 'n', n: 20, seed: 0 }],
  ['sample_negative_seed', { type: 'Sample', mode: 'n', n: 20, seed: -5 }],
  ['sample_fractional_seed', { type: 'Sample', mode: 'n', n: 20, seed: 3.9 }],
  ['sample_large_seed', { type: 'Sample', mode: 'n', n: 20, seed: 4294967299 }],
  ['sample_all_rows', { type: 'Sample', mode: 'n', n: 900, seed: 1 }],
  ['sample_none', { type: 'Sample', mode: 'n', n: 0, seed: 1 }],
  ['sample_full_percent', { type: 'Sample', mode: 'percent', percent: 100, seed: 9 }],
  ['sample_one', { type: 'Sample', mode: 'n', n: 1, seed: 11 }],
  ['split_each_auto', { type: 'SplitColumn', col: 'name', mode: 'each', delimiter: ' ' }],
  ['split_each_untrimmed', { type: 'SplitColumn', col: 'name', mode: 'each', delimiter: ' ', count: 3, trim: false }],
  ['dupcol_named', { type: 'DuplicateColumn', col: 'grp', name: 'val' }],
  ['mergecols_clash', { type: 'MergeColumns', cols: ['grp', 'val'], sep: '/', name: 'name' }],
  ['unpivot_keep_nulls', { type: 'Unpivot', ids: ['id'], values: ['price', 'name'], dropNulls: false }],
  ['unpivot_values_only', { type: 'Unpivot', values: ['val', 'price'] }],
  ['split_first', { type: 'SplitColumn', col: 'name', mode: 'first', delimiter: ' ' }],
  ['split_last', { type: 'SplitColumn', col: 'name', mode: 'last', delimiter: ' ' }],
  ['split_first_multichar', { type: 'SplitColumn', col: 'name', mode: 'first', delimiter: '  ' }],
  ['split_last_multichar', { type: 'SplitColumn', col: 'name', mode: 'last', delimiter: '  ' }],
  ['split_first_count1', { type: 'SplitColumn', col: 'name', mode: 'first', delimiter: ' ', count: 1 }],
  ['split_last_untrimmed', { type: 'SplitColumn', col: 'name', mode: 'last', delimiter: ' ', count: 3, trim: false }],
  ['split_positions', { type: 'SplitColumn', col: 'code', mode: 'positions', positions: '0, 2, 3' }],
  ['split_positions_unsorted', { type: 'SplitColumn', col: 'code', mode: 'positions', positions: '5, 1, 3' }],
  ['split_positions_negative', { type: 'SplitColumn', col: 'code', mode: 'positions', positions: '-3' }],
  ['split_positions_mixed', { type: 'SplitColumn', col: 'code', mode: 'positions', positions: '-3, 0' }],
  ['split_positions_count', { type: 'SplitColumn', col: 'code', mode: 'positions', positions: '0, 2', count: 1 }],
  ['split_number_text', { type: 'SplitColumn', col: 'price', mode: 'first', delimiter: '.' }],
  ['split_rows_number', { type: 'SplitColumn', col: 'val', mode: 'rows', delimiter: '5' }],
  ['split_date_text', { type: 'SplitColumn', col: 'day', mode: 'each', delimiter: '-' }],
  ['split_bool_text', { type: 'SplitColumn', col: 'ok', mode: 'positions', positions: '0, 2' }],
  ['mergecols_float_date', { type: 'MergeColumns', cols: ['price', 'day'], sep: '|', name: 'm' }],
  ['mergecols_bool_datetime', { type: 'MergeColumns', cols: ['ok', 'ts', 'val'], sep: ' / ', name: 'm' }],
  ['add_float_product', { type: 'AddColumn', name: 'c', formula: '[price] * 1.1 + 0.1' }],
  ['add_float_division', { type: 'AddColumn', name: 'c', formula: '[val] / 7' }],
  ['keeprows_alternate_wide', { type: 'KeepRows', mode: 'alternate', offset: 0, keep: 3, skip: 2 }],
  ['demote_headers', { type: 'DemoteHeaders' }],
  ['promote_headers', [{ type: 'DemoteHeaders' }, { type: 'PromoteHeaders', row: 0 }]],
  ['floe_unpivot', { type: 'Unpivot', ids: ['id', 'grp'] }],
  ['floe_split_columns', { type: 'SplitColumn', col: 'name', mode: 'each', delimiter: ' ', count: 2 }],
  ['floe_merge_columns', { type: 'MergeColumns', cols: ['grp', 'val'], sep: '-', name: 'm' }],
  ['floe_duplicate_column', { type: 'DuplicateColumn', col: 'val' }],
  ['floe_csv_ready', { type: 'Filter', mode: 'advanced', formula: '[val] > 50' }],
  ['class', { type: 'Sort', by: [{ col: 'val', desc: true }, { col: 'id', desc: false }] }],
  ['lambda', { type: 'Sort', by: [{ col: 'val', desc: false }, { col: 'id', desc: false }] }],
];
const project = {
  name: 'Export check',
  settings: { previewRows: 1000, locale: 'en-US' },
  params: [],
  queries: C.map(([name, kind], i) => ({ id: 'q' + i, name, load: { target: 'csv' }, steps: [{ id: 's0', name: 'Source', kind: src }, { id: 's1', name: 'Types', kind: ct }].concat((Array.isArray(kind) ? kind : [kind]).map((k, j) => ({ id: 's' + (2 + j), name: 'Step', kind: k }))) })),
};
writeFileSync(join(dir, 'check.floe'), JSON.stringify(project));

const run = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd: cwd || root, encoding: 'utf8' });
  if (r.error) { console.error(`cannot run ${cmd}: ${r.error.message}`); process.exit(2); }
  return r;
};
const fail = (r, code) => { console.error(r.stdout + r.stderr); process.exit(code || 1); };
const built = run('node', ['scripts/floe.mjs', 'run', join(dir, 'check.floe'), '--data', data, '--out', join(dir, 'app'), '--quiet']);
if (built.status !== 0) fail(built);
const gen = run('node', ['scripts/floe.mjs', 'python', join(dir, 'check.floe'), '--out', join(dir, 'export.py')]);
if (gen.status !== 0) fail(gen);
const py = run(python, ['export.py'], dir);
if (py.status !== 0) fail(py, py.stderr.includes('No module named') ? 2 : 1);

const table = (file) => readFileSync(file, 'utf8').trim().split(/\r?\n/).map((l) => l.split(',').map((c) => (c === '""' ? '' : c)));
const same = (x, y) => {
  if (x === y) return true;
  if (x === '' || y === '') return false;
  const a = Number(x), b = Number(y);
  return !isNaN(a) && !isNaN(b) && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
};
const problems = [];
for (const [name] of C) {
  let a, b;
  try { a = table(join(dir, 'app', name + '.csv')); b = table(join(dir, 'out', name + '.csv')); } catch (e) { problems.push(`${name}: an output file is missing`); continue; }
  let why = null;
  if (a[0].join() !== b[0].join()) why = `columns [${a[0]}] against [${b[0]}]`;
  else if (a.length !== b.length) why = `${a.length - 1} rows against ${b.length - 1}`;
  else {
    for (let i = 1; i < a.length && !why; i++) for (let j = 0; j < a[i].length; j++) if (!same(a[i][j], b[i][j])) { why = `row ${i} column ${a[0][j]}: ${JSON.stringify(a[i][j])} against ${JSON.stringify(b[i][j])}`; break; }
  }
  if (why) problems.push(`${name}: app and Python differ, ${why}`);
}
rmSync(dir, { recursive: true, force: true });
problems.forEach((x) => console.log('FAIL ' + x));
console.log(problems.length ? `${problems.length} of ${C.length} cases differ` : `all ${C.length} cases match`);
process.exit(problems.length ? 1 : 0);
