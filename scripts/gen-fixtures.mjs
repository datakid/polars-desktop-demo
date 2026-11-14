import vm from 'node:vm';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, process.argv[2] || 'desktop/src-tauri/engine/tests/fixtures/parity.json');

const ctx = { console, TextDecoder, TextEncoder, performance, Intl, setTimeout, clearTimeout, structuredClone, indexedDB: undefined, navigator: {} };
ctx.self = ctx;
vm.createContext(ctx);
for (const f of ['util', 'expr', 'io', 'steps', 'engine', 'engine-ext', 'parquet', 'plan']) {
  vm.runInContext(readFileSync(join(root, 'js', f + '.js'), 'utf8'), ctx, { filename: f + '.js' });
}
const PQ = ctx.PQ, E = PQ.Engine;

const INPUTS = {
  'orders.csv': [
    'order_id,order_date,customer_id,region,qty,price,discount,status',
    '1,2025-01-03,C1,EU,2,"1,234.50",0.1,shipped',
    '2,2025-01-04,C2,US,5,12.00,,returned',
    '3,2025-02-10,C1,EU,1,n/a,0.05,shipped',
    '4,2025-02-11,C3,APAC,7,3.40,,pending',
    '5,2025-03-01,C2,US,3,99.00,0.2,shipped',
    '6,2025-03-02,C4,EU,,45.90,,shipped',
    '7,2025-03-15,C1,EU,4,7.25,0.1,shipped',
    '8,2025-04-01,C5,LATAM,6,30.00,,returned',
  ].join('\n'),
  'customers.csv': ['customer_id,name,segment', 'C1,Ana Silva,Consumer', 'C2,Ben Novak,SMB', 'C3,Chloé Martin,Enterprise', 'C9,Nobody,SMB'].join('\n'),
  'de.csv': ['datum;betrag;menge', '03.04.2026;1.234,50;2', '15.04.2026;12,5;3', '01.05.2026;abc;1'].join('\n'),
  'report.csv': ['ACME report,,', 'generated,,', 'Region,Product,Units', 'EU,Widget,10', ',Gadget,5', 'US,Widget,7', ',Gadget,', 'APAC,Widget,3'].join('\n'),
  'tags.csv': ['id,tags,name', '1,"a, b, c",  Ana  ', '2,b,BEN', '3,,chloé martin'].join('\n'),
  'halves.csv': [
    'id,x,a,b',
    '1,0.5,2025-01-01 12:00:00,2025-01-01 00:00:00',
    '2,1.5,2025-01-01 00:00:00,2025-01-01 12:00:00',
    '3,2.5,2025-01-03 12:00:00,2025-01-01 00:00:00',
    '4,-0.5,2025-01-01 00:00:00,2025-01-03 12:00:00',
    '5,-1.5,2025-01-02 00:00:00,2025-01-02 00:00:00',
    '6,-2.5,2025-06-01 18:00:00,2025-06-01 06:00:00',
    '7,0.125,2025-01-01 06:00:00,2025-01-01 18:00:00',
    '8,0.375,,',
    '9,0.625,2025-03-01 00:00:00,2025-03-01 00:00:00',
    '10,0.875,2025-03-01 01:00:00,2025-03-01 00:00:00',
  ].join('\n'),
};

const types = { type: 'ChangeType', onError: 'error', changes: [{ col: 'order_id', type: 'int' }, { col: 'order_date', type: 'date' }, { col: 'qty', type: 'int' }, { col: 'price', type: 'number' }, { col: 'discount', type: 'number' }] };
const srcOf = (name, csv) => ({ type: 'Source', source: { kind: 'file', fileId: name, fileName: name, csv: Object.assign({ delimiter: name === 'de.csv' ? ';' : ',', header: true }, csv || {}) } });

const CASES = [
  ['types and per-cell errors', 'orders.csv', [types]],
  ['filter with formula', 'orders.csv', [types, { type: 'Filter', mode: 'advanced', formula: '[qty] >= 3 and [status] = "shipped"' }]],
  ['builder filter in list', 'orders.csv', [{ type: 'Filter', mode: 'builder', builder: { join: 'and', conds: [{ col: 'region', op: 'in', values: ['EU', 'US'] }] } }]],
  ['group by aggregations', 'orders.csv', [types, { type: 'GroupBy', keys: ['region'], aggs: [{ fn: 'sum', col: 'qty' }, { fn: 'mean', col: 'price' }, { fn: 'count_rows' }, { fn: 'count', col: 'discount' }, { fn: 'count_distinct', col: 'customer_id' }, { fn: 'min', col: 'order_date' }, { fn: 'max', col: 'qty' }] }]],
  ['custom formula columns', 'orders.csv', [types, { type: 'AddColumn', name: 'revenue', formula: 'try [qty] * [price] * (1 - Coalesce([discount], 0)) otherwise null' }, { type: 'AddColumn', name: 'label', formula: 'Text.Upper([region]) & "-" & Text.From(Date.Year([order_date]))' }, { type: 'ConditionalColumn', name: 'size', rules: [{ when: '[qty] > 4', then: '"big"' }, { when: '[qty] > 1', then: '"mid"' }], else: '"small"' }]],
  ['date formula functions', 'orders.csv', [types, { type: 'AddColumn', name: 'm', formula: 'Date.Month([order_date]) * 100 + Date.Day([order_date])' }, { type: 'AddColumn', name: 'q', formula: 'Date.Quarter([order_date])' }, { type: 'Filter', mode: 'advanced', formula: '[order_date] >= #date(2025, 2, 11)' }]],
  ['merge left with customers', 'orders.csv', [{ type: 'Merge', right: 'customers', how: 'left', on: [['customer_id', 'customer_id']] }]],
  ['merge full coalesces keys', 'orders.csv', [{ type: 'SelectColumns', cols: ['order_id', 'customer_id'] }, { type: 'Merge', right: 'customers', how: 'full', on: [['customer_id', 'customer_id']], expand: ['name'] }]],
  ['merge anti', 'orders.csv', [{ type: 'Merge', right: 'customers', how: 'anti', on: [['customer_id', 'customer_id']] }]],
  ['unpivot then pivot', 'orders.csv', [types, { type: 'SelectColumns', cols: ['order_id', 'qty', 'price'] }, { type: 'Unpivot', ids: ['order_id'], var: 'Attribute', val: 'Value' }, { type: 'Pivot', on: 'Attribute', index: ['order_id'], values: 'Value', agg: 'sum' }]],
  ['distinct and duplicates', 'orders.csv', [{ type: 'Distinct', subset: ['customer_id'] }]],
  ['keep duplicates', 'orders.csv', [{ type: 'KeepDuplicates', subset: ['region'] }]],
  ['keep rows top/remove/alternate', 'orders.csv', [{ type: 'KeepRows', mode: 'remove_top', n: 1 }, { type: 'KeepRows', mode: 'alternate', keep: 1, skip: 1, offset: 0 }, { type: 'KeepRows', mode: 'top', n: 3 }]],
  ['window functions', 'orders.csv', [types, { type: 'Window', op: 'cumsum', col: 'qty', partition: ['region'], name: 'run' }, { type: 'Window', op: 'lag', col: 'qty', partition: ['region'], n: 1, name: 'prev' }, { type: 'Window', op: 'row_number', partition: ['region'], name: 'rn' }]],
  ['rename reorder index duplicate', 'orders.csv', [{ type: 'Rename', map: [['status', 'state']] }, { type: 'ReorderColumns', cols: ['state', 'region'] }, { type: 'IndexColumn', name: 'Index', start: 1, step: 1 }, { type: 'DuplicateColumn', col: 'region', name: 'region2' }, { type: 'RemoveColumns', cols: ['discount'] }]],
  ['replace values and round', 'orders.csv', [types, { type: 'ReplaceValues', cols: ['status'], find: 'returned', replace: 'back', wholeCell: true }, { type: 'ReplaceValues', cols: ['discount'], find: '', replace: '0' }, { type: 'RoundNumbers', cols: ['price'], digits: 0 }]],
  ['remove and replace errors', 'orders.csv', [types, { type: 'ReplaceErrors', cols: ['price'], value: '0' }, { type: 'RemoveErrors', cols: [] }]],
  ['german locale casts', 'de.csv', [{ type: 'ChangeType', onError: 'null', locale: 'de-DE', changes: [{ col: 'datum', type: 'date' }, { col: 'betrag', type: 'number' }, { col: 'menge', type: 'int' }] }]],
  ['report: promote headers, fill down, remove blank', 'report.csv', [{ type: 'PromoteHeaders', row: 2 }, { type: 'FillDown', cols: ['Region'] }, { type: 'KeepRows', mode: 'remove_blank' }, { type: 'ChangeType', onError: 'error', changes: [{ col: 'Units', type: 'int' }] }], { header: false }],
  ['split, text transforms, merge columns', 'tags.csv', [{ type: 'TextTransform', op: 'trim', cols: ['name'] }, { type: 'TextTransform', op: 'lower', cols: ['name'] }, { type: 'SplitColumn', col: 'tags', mode: 'each', delimiter: ',', trim: true }, { type: 'MergeColumns', cols: ['tags.1', 'tags.2'], sep: '|', name: 'first2' }]],
  ['split into rows', 'tags.csv', [{ type: 'SplitColumn', col: 'tags', mode: 'rows', delimiter: ',', trim: true }]],
  ['half-even Number.Round formulas', 'halves.csv', [{ type: 'ChangeType', onError: 'null', changes: [{ col: 'x', type: 'number' }] }, { type: 'AddColumn', name: 'r0', formula: 'Number.Round([x])' }, { type: 'AddColumn', name: 'r2', formula: 'Number.Round([x], 2)' }]],
  ['int cast rounds half up', 'halves.csv', [{ type: 'ChangeType', onError: 'error', changes: [{ col: 'x', type: 'int' }] }]],
  ['Round numbers step on halves', 'halves.csv', [{ type: 'ChangeType', onError: 'null', changes: [{ col: 'x', type: 'number' }] }, { type: 'RoundNumbers', cols: ['x'], digits: 1 }]],
  ['Round numbers step to integers', 'halves.csv', [{ type: 'ChangeType', onError: 'null', changes: [{ col: 'x', type: 'number' }] }, { type: 'RoundNumbers', cols: ['x'], digits: 0 }]],
  ['datetime difference rounds half up', 'halves.csv', [{ type: 'ChangeType', onError: 'null', changes: [{ col: 'a', type: 'datetime' }, { col: 'b', type: 'datetime' }] }, { type: 'AddColumn', name: 'days', formula: '[a] - [b]' }]],
  ['text delimiter and clean functions', 'tags.csv', [{ type: 'AddColumn', name: 'before', formula: 'Text.BeforeDelimiter([tags], \",\")' }, { type: 'AddColumn', name: 'after', formula: 'Text.AfterDelimiter([tags], \",\")' }, { type: 'AddColumn', name: 'after2', formula: 'Text.AfterDelimiter([tags], \", \")' }, { type: 'AddColumn', name: 'cleaned', formula: 'Text.Clean([name])' }, { type: 'AddColumn', name: 'nodelim', formula: 'Text.BeforeDelimiter([name], \"\") & \"|\" & Text.AfterDelimiter([name], \"\")' }]],
  ['number sign, integer divide and log', 'halves.csv', [{ type: 'ChangeType', onError: 'null', changes: [{ col: 'id', type: 'int' }, { col: 'x', type: 'number' }] }, { type: 'AddColumn', name: 'sx', formula: 'Number.Sign([x])' }, { type: 'AddColumn', name: 'sid', formula: 'Number.Sign([id] - 5)' }, { type: 'AddColumn', name: 'q3', formula: 'Number.IntegerDivide([id], 3)' }, { type: 'AddColumn', name: 'qh', formula: 'Number.IntegerDivide([x], 0.5)' }, { type: 'AddColumn', name: 'ln', formula: 'Number.Log([id])' }]],
  ['date month math, names and week on datetimes', 'halves.csv', [{ type: 'ChangeType', onError: 'null', changes: [{ col: 'a', type: 'datetime' }, { col: 'b', type: 'datetime' }] }, { type: 'AddColumn', name: 'am', formula: 'Date.AddMonths([a], 1)' }, { type: 'AddColumn', name: 'am2', formula: 'Date.AddMonths([a], -2)' }, { type: 'AddColumn', name: 'som', formula: 'Date.StartOfMonth([a])' }, { type: 'AddColumn', name: 'eom', formula: 'Date.EndOfMonth([a])' }, { type: 'AddColumn', name: 'wk', formula: 'Date.WeekOfYear([a])' }, { type: 'AddColumn', name: 'mn', formula: 'Date.MonthName([a])' }, { type: 'AddColumn', name: 'dn', formula: 'Date.DayOfWeekName([a])' }, { type: 'AddColumn', name: 'dd', formula: 'Date.DiffDays([a], [b])' }]],
  ['date functions on date columns and literals', 'orders.csv', [types, { type: 'AddColumn', name: 'next', formula: 'Date.AddMonths([order_date], 1)' }, { type: 'AddColumn', name: 'som', formula: 'Date.StartOfMonth([order_date])' }, { type: 'AddColumn', name: 'eom', formula: 'Date.EndOfMonth([order_date])' }, { type: 'AddColumn', name: 'wk', formula: 'Date.WeekOfYear([order_date])' }, { type: 'AddColumn', name: 'since', formula: 'Date.DiffDays(#date(2025, 1, 1), [order_date])' }, { type: 'AddColumn', name: 'clamp', formula: 'Date.AddMonths(#date(2025, 1, 31), 1)' }, { type: 'AddColumn', name: 'leap', formula: 'Date.AddMonths(#date(2024, 1, 31), 1)' }, { type: 'AddColumn', name: 'back', formula: 'Date.AddMonths(#date(2025, 3, 31), -1)' }]],
  ['split by positions', 'tags.csv', [{ type: 'SplitColumn', col: 'name', mode: 'positions', positions: '0, 3, 5', trim: true }]],
  ['split by positions with nulls and untrimmed pieces', 'tags.csv', [{ type: 'SplitColumn', col: 'tags', mode: 'positions', positions: '3, 0', trim: false }]],
  ['append diagonal', 'orders.csv', [{ type: 'SelectColumns', cols: ['customer_id', 'region'] }, { type: 'Append', others: ['customers'], mode: 'diagonal' }]],
];

function wire(v) {
  if (v === null || v === undefined) return null;
  if (PQ.isErr(v)) return '#ERR';
  if (Object.prototype.toString.call(v) === '[object Date]') return { d: v.getTime() };
  return v;
}

function deepWire(v) {
  if (Array.isArray(v)) return v.map(deepWire);
  if (v && typeof v === 'object' && Object.prototype.toString.call(v) !== '[object Date]' && !PQ.isErr(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deepWire(x)]));
  return wire(v);
}

const files = {};
for (const [name, text] of Object.entries(INPUTS)) {
  const buf = new TextEncoder().encode(text).buffer;
  PQ.Files.set(name, { id: name, name, size: buf.byteLength, mtime: 1, folder: '', buf });
  files[name] = '@@/' + name;
}
const customers = { id: 'customers', name: 'customers', load: { target: 'none' }, steps: [{ id: 'c0', name: 'Source', kind: srcOf('customers.csv') }] };

const fixtures = [];
let refused = 0;
for (const [label, input, steps, csv] of CASES) {
  const q = { id: 'q', name: 'q', load: { target: 'none' }, steps: [{ id: 's0', name: 'Source', kind: srcOf(input, csv) }].concat(steps.map((k, i) => ({ id: 's' + (i + 1), name: PQ.Steps.label(k.type), kind: k }))) };
  const project = { settings: { previewRows: 1000, locale: 'en-US' }, params: [], queries: [q, customers] };
  E.setProject(project);
  E.clearCache();
  const r = E.evaluate('q', undefined, 'full');
  if (!r.table) throw new Error(label + ': built-in failed at step ' + (r.failedAt + 1) + ': ' + r.states[r.failedAt].error);
  const low = PQ.Plan.lower(project, 'q', { files });
  if (!low.ok) { refused++; console.warn('refused:', label, '—', low.reason); continue; }
  const names = r.table.schema().map((c) => c.name);
  const profiles = {}, distinct = {};
  for (const c of names) {
    profiles[c] = deepWire(E.profile(r.table, c));
    distinct[c] = deepWire(E.distinctValues(r.table, c, 1000));
  }
  fixtures.push({ name: label, plan: low.plan, expected: { n: r.table.n, schema: r.table.schema(), rows: r.table.toRows(200).map((row) => row.map(wire)), profiles, distinct } });
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ version: PQ.VERSION, inputs: INPUTS, fixtures }, null, 1));
console.log('[fixtures] ' + fixtures.length + ' written, ' + refused + ' refused → ' + out);
if (refused) process.exit(1);
