import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';

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
rows.push('121,a,-5,-0.5,Zoë Ünal,2025-02-01,true,2025-02-01 08:15:00,0042');
rows.push('122,b,0,0.0,"O\'Brien, Jr.",2025-02-02,false,2025-02-02 00:00:00,A-1');
rows.push('123,c,9999999999,1000000.5,"say ""hi""",2025-02-03,,2025-02-03 23:59:59,');
rows.push('124,a,101,0.1,   ,2025-02-04,true,,B-2');
rows.push('125,b,7,12.25,İSTANBUL ΑΒΓ,2025-02-05,false,2025-02-05 12:00:00,C-3');
writeFileSync(join(data, 'orders.csv'), rows.join('\n') + '\n');
writeFileSync(join(data, 'j.csv'), 'id,js\n1,"{""a"":1,""b"":""x"",""c"":true}"\n2,"{""a"":2,""b"":""y"",""c"":false}"\n3,"{""a"":3,""b"":null,""c"":true}"\n4,"{""a"":4,""b"":""z"",""c"":true}"\n5,"{""a"":5,""c"":false}"\n');

const src = { type: 'Source', source: { kind: 'file', fileId: 'orders.csv', fileName: 'orders.csv', csv: { delimiter: ',', header: true } } };
const ct = { type: 'ChangeType', changes: [{ col: 'id', type: 'int' }, { col: 'val', type: 'int' }, { col: 'price', type: 'number' }, { col: 'day', type: 'date' }, { col: 'ok', type: 'bool' }, { col: 'ts', type: 'datetime' }] };
const allText = { type: 'ChangeType', changes: ['id', 'grp', 'val', 'price', 'name', 'day', 'ok', 'code'].map((col) => ({ col, type: 'text' })) };
const grpToInt = { type: 'ChangeType', changes: [{ col: 'grp', type: 'int' }] };
const codeToInt = { type: 'ChangeType', changes: [{ col: 'code', type: 'int' }] };
const messy = [
  ['id', 'n', 'd', 't', 'b'],
  ['1', ' 5', '2025-01-05', '2025-01-05 10:30', 'yes'],
  ['2', '1,000', '2025/01/05', '2025-01-05T10:30:00', 'TRUE'],
  ['3', '$7', '01/05/2025', '2025-01-05 10:30:15', 'Y'],
  ['4', '€8', '5 Jan 2025', '2025-01-05', '1'],
  ['5', '9.0', '2025-1-5', '01/05/2025 10:30', '0'],
  ['6', '-10', '20250105', '2025-01-05T10:30:00Z', 'no'],
  ['7', '+11', '2025-02-30', '2025-01-05 10:30:15.123', 'false'],
  ['8', '1e3', 'not a date', 'x', 't'],
  ['9', 'abc', '', '', ''],
  ['10', '12.5', '2025-01-05 10:30:00', '2025-12-31 23:59:59', ' true '],
  ['11', '0x10', ' 2025-01-05 ', ' 2025-01-05 10:30 ', 'maybe'],
  ['12', '', '2024-02-29', '2024-02-29 00:00:00', 'False'],
  ['13', '(5)', '12/31/2025', '2025-13-01 10:00', 'Wahr'],
  ['14', '5%', '31/12/2025', '2025-01-05 24:00', 'N'],
  ['15', '¥3', 'Jan 5, 2025', '2025-01-05 10:60', 'faux'],
  ['16', '1 000', 'January 5 2025', '1/2/99 7:05', 'YES'],
  ['17', '1.234,56', '5-Jan-25', '2025.01.05 10:30:00', '2'],
  ['18', '.5', '2025.01.05', '31-12-2025 23:59:59', 'on'],
  ['19', '5.', '99-1-2', '2025-01-05 9:05', 'si'],
  ['20', '-', '1/2/3', 'Jan 5, 2025', '-1'],
  ['21', 'NaN', '2025-01-05T10:30', 'Mar 3 2025', 'T'],
  ['22', 'Infinity', '0000-01-01', '2025-04-31', ' '],
].map((r) => r.map((c) => (/[",]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c)).join(',')).join('\n') + '\n';
writeFileSync(join(data, 'm.csv'), messy);
const messySrc = { type: 'Source', source: { kind: 'file', fileId: 'm.csv', fileName: 'm.csv', csv: { delimiter: ',', header: true } } };
const messyCase = (col, type) => [messySrc, { type: 'ChangeType', changes: [{ col, type }] }, { type: 'ReplaceErrors', cols: [col] }];
writeFileSync(join(data, 's_semicolon.csv'), 'id;name;note\n1;alpha;"x;y"\n2;beta;plain\n');
writeFileSync(join(data, 's_tab.tsv'), 'id\tname\n1\ta b\n2\tc d\n');
writeFileSync(join(data, 's_noheader.csv'), '1,alpha\n2,beta\n');
writeFileSync(join(data, 's_skip.csv'), 'junk line one\nanother junk\nid,name\n1,alpha\n2,beta\n');
writeFileSync(join(data, 's_latin1.csv'), Buffer.from('id,name\n1,café\n2,señor\n', 'latin1'));
writeFileSync(join(data, 's_bom.csv'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('id,name\n1,alpha\n2,beta\n')]));
writeFileSync(join(data, 's_crlf.csv'), 'id,name\r\n1,alpha\r\n2,"be\r\nta"\r\n3,gamma\r\n');
writeFileSync(join(data, 's_quotes.csv'), 'id,name\n1,"say ""hi"""\n2,"a,b"\n3,\n');
writeFileSync(join(data, 's_ragged.csv'), 'id,name,x\n1,alpha\n2,beta,9\n3,gamma,7\n');
writeFileSync(join(data, 's_dupe_header.csv'), 'id,id,\n1,2,3\n4,5,6\n');
writeFileSync(join(data, 's_blank_lines.csv'), 'id,name\n\n1,alpha\n\n2,beta\n\n');
writeFileSync(join(data, 's_spaces.csv'), 'id , name\n 1 , alpha \n2,  beta\n');
const csvSource = (file, csv) => ({ type: 'Source', source: { kind: 'file', fileId: file, fileName: file, csv: Object.assign({ delimiter: ',', header: true }, csv || {}) } });
const XLSX = (() => { const sandbox = { self: {} }; sandbox.self = sandbox; vm.runInNewContext(readFileSync(join(root, 'vendor', 'xlsx.full.min.js'), 'utf8'), sandbox); return sandbox.XLSX; })();
{
  const book = XLSX.utils.book_new();
  const day = (d) => new Date(Date.UTC(2025, 0, d));
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['id', 'name', 'val', 'price', 'day', 'ok'], [1, 'alpha', 10, 1.5, day(5), true], [2, 'beta', null, 2, day(6), false], [3, null, 30, 3.25, null, true], [4, 'delta', 40, null, day(8), null]]), 'Data');
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['id', 'name'], [10, 'x'], [11, 'y']]), 'Other');
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['id', 'name'], [20, 'z']]), 'Extra');
  writeFileSync(join(data, 'x.xlsx'), XLSX.write(book, { type: 'buffer', bookType: 'xlsx', cellDates: true }));
  mkdirSync(join(data, 'monthly'), { recursive: true });
  writeFileSync(join(data, 'monthly', 'a.csv'), 'id,name\n1,alpha\n2,beta\n');
  writeFileSync(join(data, 'monthly', 'b.csv'), 'id,name,extra\n3,gamma,x\n');
  writeFileSync(join(data, 'monthly', 'ignore.txt'), 'nothing');
}
const excelSource = (item) => ({ type: 'Source', source: { kind: 'file', fileId: 'x.xlsx', fileName: 'x.xlsx', format: 'excel', item } });
const folderSource = (pattern) => ({ type: 'Source', source: { kind: 'folder', folder: 'monthly', pattern, format: 'csv', csv: { delimiter: ',' }, fileColumn: 'Source.Name' } });
const jsonSrc = { type: 'Source', source: { kind: 'file', fileId: 'j.csv', fileName: 'j.csv', csv: { delimiter: ',', header: true } } };
const filterBy = (conds, join) => ({ type: 'Filter', mode: 'builder', builder: { join: join || 'and', conds } });
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
  ['formula_proper', { type: 'AddColumn', name: 'p', formula: 'Text.Proper([name]) & " " & Text.Proper([code])' }],
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
  ['pivot_count_rows', { type: 'Pivot', on: 'grp', values: 'val', agg: 'count_rows', index: ['name'] }],
  ['pivot_mean', { type: 'Pivot', on: 'grp', values: 'val', agg: 'mean', index: ['name'] }],
  ['pivot_min', { type: 'Pivot', on: 'grp', values: 'val', agg: 'min', index: ['name'] }],
  ['pivot_max', { type: 'Pivot', on: 'grp', values: 'val', agg: 'max', index: ['name'] }],
  ['pivot_first', { type: 'Pivot', on: 'grp', values: 'val', agg: 'first', index: ['name'] }],
  ['pivot_last', { type: 'Pivot', on: 'grp', values: 'val', agg: 'last', index: ['name'] }],
  ['pivot_median', { type: 'Pivot', on: 'grp', values: 'val', agg: 'median', index: ['name'] }],
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
  ['promote_headers', [allText, { type: 'PromoteHeaders', row: 0 }]],
  ['promote_headers_row2', [allText, { type: 'PromoteHeaders', row: 2 }]],
  ['floe_unpivot', { type: 'Unpivot', ids: ['id', 'grp'] }],
  ['floe_split_columns', { type: 'SplitColumn', col: 'name', mode: 'each', delimiter: ' ', count: 2 }],
  ['floe_merge_columns', { type: 'MergeColumns', cols: ['grp', 'val'], sep: '-', name: 'm' }],
  ['floe_duplicate_column', { type: 'DuplicateColumn', col: 'val' }],
  ['floe_csv_ready', { type: 'Filter', mode: 'advanced', formula: '[val] > 50' }],
  ['class', { type: 'Sort', by: [{ col: 'val', desc: true }, { col: 'id', desc: false }] }],
  ['lambda', { type: 'Sort', by: [{ col: 'val', desc: false }, { col: 'id', desc: false }] }],
  ['select_cols', { type: 'SelectColumns', cols: ['val', 'id', 'grp'] }],
  ['remove_cols', { type: 'RemoveColumns', cols: ['price', 'code'] }],
  ['reorder_cols', { type: 'ReorderColumns', cols: ['code', 'val'] }],
  ['rename_cols', { type: 'Rename', map: [['val', 'value'], ['grp', 'group']] }],
  ['replace_errors', [grpToInt, { type: 'ReplaceErrors', cols: ['grp'], value: '0' }]],
  ['replace_errors_null', [grpToInt, { type: 'ReplaceErrors', cols: ['grp'] }]],
  ['remove_errors_none', { type: 'RemoveErrors', cols: ['grp'] }],
  ['transpose', [{ type: 'SelectColumns', cols: ['id', 'val'] }, { type: 'Transpose' }]],
  ['transpose_header', [{ type: 'SelectColumns', cols: ['id', 'val'] }, { type: 'Transpose', headerCol: 'id' }]],
  ['append_relaxed', { type: 'Append', others: ['q0'], mode: 'relaxed' }],
  ['append_strict', { type: 'Append', others: ['q0'], mode: 'strict' }],
  ['checkpoint', { type: 'Checkpoint' }],
  ['changetype_text_ts', { type: 'ChangeType', changes: [{ col: 'ts', type: 'text' }] }],
  ['changetype_text_ok', { type: 'ChangeType', changes: [{ col: 'ok', type: 'text' }] }],
  ['changetype_text_day', { type: 'ChangeType', changes: [{ col: 'day', type: 'text' }] }],
  ['expand_json', [jsonSrc, { type: 'ExpandJson', col: 'js' }]],
  ['sql_select', { type: 'CustomSql', sql: 'SELECT id, grp, val FROM self WHERE val > 50 ORDER BY id' }],
  ['sql_group', { type: 'CustomSql', sql: 'SELECT grp, SUM(val) AS sum_val, COUNT(*) AS n FROM self GROUP BY grp ORDER BY grp' }],
  ['sql_alias_limit', { type: 'CustomSql', sql: 'SELECT id AS ident, name FROM self ORDER BY id LIMIT 10' }],
  ['sql_like_in', { type: 'CustomSql', sql: "SELECT id FROM self WHERE grp IN ('a', 'b') AND name LIKE '%smith%' ORDER BY id" }],
  ['messy_int', messyCase('n', 'int')],
  ['messy_number', messyCase('n', 'number')],
  ['messy_date', messyCase('d', 'date')],
  ['messy_datetime', messyCase('t', 'datetime')],
  ['messy_bool', messyCase('b', 'bool')],
  ['filter_contains', filterBy([{ col: 'name', op: 'contains', value: 'smith' }])],
  ['filter_contains_case', filterBy([{ col: 'name', op: 'contains', value: 'ALICE' }])],
  ['filter_not_contains', filterBy([{ col: 'name', op: 'not_contains', value: 'white' }])],
  ['filter_starts', filterBy([{ col: 'name', op: 'starts', value: 'BOB' }])],
  ['filter_ends', filterBy([{ col: 'name', op: 'ends', value: 'white' }])],
  ['filter_null', filterBy([{ col: 'name', op: 'null' }])],
  ['filter_not_null_price', filterBy([{ col: 'price', op: 'not_null' }])],
  ['filter_in', filterBy([{ col: 'grp', op: 'in', values: ['a', 'b'] }])],
  ['filter_not_in', filterBy([{ col: 'grp', op: 'not_in', values: ['a'] }])],
  ['filter_text_gt', filterBy([{ col: 'name', op: 'gt', value: 'C', numeric: false }])],
  ['filter_eq_unicode', filterBy([{ col: 'name', op: 'eq', value: 'Zoë Ünal', numeric: false }])],
  ['filter_ne_text', filterBy([{ col: 'grp', op: 'ne', value: 'a', numeric: false }])],
  ['filter_date_ge', filterBy([{ col: 'day', op: 'ge', value: '2025-01-15' }])],
  ['filter_ts_lt', filterBy([{ col: 'ts', op: 'lt', value: '2025-01-10' }])],
  ['filter_or_mix', filterBy([{ col: 'val', op: 'gt', value: '90' }, { col: 'name', op: 'null' }], 'or')],
  ['sort_ts_price', { type: 'Sort', by: [{ col: 'ts', desc: true }, { col: 'price', desc: false }, { col: 'id', desc: false }] }],
  ['groupby_text', { type: 'GroupBy', keys: ['name'], aggs: [{ fn: 'min', col: 'code' }, { fn: 'max', col: 'code' }, { fn: 'count_distinct', col: 'code' }, { fn: 'first', col: 'code' }, { fn: 'last', col: 'code' }, { fn: 'count_rows' }] }],
  ['groupby_stats', { type: 'GroupBy', keys: ['grp'], aggs: [{ fn: 'median', col: 'val' }, { fn: 'std', col: 'val' }, { fn: 'var', col: 'val' }, { fn: 'mean', col: 'price' }, { fn: 'sum', col: 'price' }, { fn: 'count', col: 'price' }] }],
  ['groupby_two_keys', { type: 'GroupBy', keys: ['grp', 'ok'], aggs: [{ fn: 'count_rows' }, { fn: 'max', col: 'ts' }, { fn: 'min', col: 'day' }] }],
  ['merge_left', { type: 'Merge', right: 'q0', how: 'left', on: [['id', 'id']], expand: ['val'], prefix: 'r' }],
  ['merge_inner', { type: 'Merge', right: 'q0', how: 'inner', on: [['id', 'id']], expand: ['val', 'name'], prefix: 'r' }],
  ['merge_right', { type: 'Merge', right: 'q0', how: 'right', on: [['id', 'id']], expand: ['val'], prefix: 'r' }],
  ['merge_full', { type: 'Merge', right: 'q0', how: 'full', on: [['id', 'id']], expand: ['val'], prefix: 'r' }],
  ['merge_semi', { type: 'Merge', right: 'q0', how: 'semi', on: [['id', 'id']] }],
  ['merge_anti', { type: 'Merge', right: 'q0', how: 'anti', on: [['id', 'id']] }],
  ['merge_null_keys', { type: 'Merge', right: 'q0', how: 'inner', on: [['price', 'price']], expand: ['id'], prefix: 'r' }],
  ['merge_text_keys', { type: 'Merge', right: 'q0', how: 'left', on: [['grp', 'grp'], ['ok', 'ok']], expand: ['id'], prefix: 'r' }],
  ['text_upper', { type: 'TextTransform', cols: ['name'], op: 'upper' }],
  ['text_lower', { type: 'TextTransform', cols: ['name'], op: 'lower' }],
  ['text_trim', { type: 'TextTransform', cols: ['name'], op: 'trim' }],
  ['text_clean', { type: 'TextTransform', cols: ['name'], op: 'clean' }],
];
const formulaCases = [];
{
  const source = readFileSync(join(root, 'js', 'expr.js'), 'utf8');
  const columnsFor = { t: ['[name]', '[code]', '[grp]'], n: ['[val]', '[price]'], d: ['[day]', '[ts]'], a: ['[price]', '[name]', '[val]'], L: ['{"a", "b", "c"}', '{1, 2, 3}'] };
  const literalFor = { t: '"a"', n: '2', d: '[ts]', a: '[price]' };
  const optionalFor = { t: '"*"', n: '1' };
  for (const m of source.matchAll(/def\('([A-Za-z.]+)', \[([^\]]*)\], '([a-z]+)'/g)) {
    const fn = m[1], sig = m[2].split(',').map((x) => x.trim().replace(/'/g, '')).filter(Boolean);
    const required = sig.filter((x) => !x.endsWith('?') && !x.endsWith('...'));
    const variants = fn === 'List.Contains' ? [0, 1] : [0, 1, 2];
    const seen = new Set();
    for (const variant of variants) {
      for (const withOptional of sig.some((x) => x.endsWith('?')) ? [false, true] : [false]) {
        const args = [];
        sig.forEach((p, i) => {
          const kind = p.replace(/[?.]/g, '');
          if (p.endsWith('?') && !withOptional) return;
          if (p.endsWith('...')) { args.push('[name]', '[grp]'); return; }
          if (fn === 'List.Contains') { args.push(i === 0 ? columnsFor.L[variant % 2] : ['[grp]', '[val]'][variant % 2]); return; }
          if (i === 0) { const options = columnsFor[kind] || ['[val]']; args.push(options[variant % options.length]); return; }
          args.push(p.endsWith('?') ? optionalFor[kind] || '1' : literalFor[kind] || '1');
        });
        const formula = `${fn}(${args.join(', ')})`;
        if (seen.has(formula)) continue;
        seen.add(formula);
        formulaCases.push([`fx_${fn.toLowerCase().replace('.', '_')}_${seen.size}`, { type: 'AddColumn', name: 'r', formula }]);
      }
    }
    void required;
  }
}
C.push(
  ['src_semicolon', [csvSource('s_semicolon.csv', { delimiter: ';' })]],
  ['src_tab', [csvSource('s_tab.tsv', { delimiter: '\t' })]],
  ['src_noheader', [csvSource('s_noheader.csv', { header: false })]],
  ['src_skip', [csvSource('s_skip.csv', { skipRows: 2 })]],
  ['src_latin1', [csvSource('s_latin1.csv', { encoding: 'windows-1252' })]],
  ['src_bom', [csvSource('s_bom.csv')]],
  ['src_crlf', [csvSource('s_crlf.csv')]],
  ['src_quotes', [csvSource('s_quotes.csv')]],
  ['src_ragged', [csvSource('s_ragged.csv')]],
  ['src_dupe_header', [csvSource('s_dupe_header.csv')]],
  ['src_blank_lines', [csvSource('s_blank_lines.csv')]],
  ['src_spaces', [csvSource('s_spaces.csv')]],
);
C.push(
  ['excel_sheet', [excelSource({ type: 'sheet', sheet: 'Data' }), { type: 'PromoteHeaders', row: 0 }]],
  ['excel_range', [excelSource({ type: 'range', sheet: 'Data', range: 'B2:D4' })]],
  ['excel_sheets', [excelSource({ type: 'sheets', pattern: '*', sheetColumn: '_sheet' })]],
  ['folder_csv', [folderSource('*.csv')]],
);
C.push(
  ['param_number', filterBy([{ col: 'val', op: 'gt', value: '1' }])],
  ['param_filter_formula', { type: 'Filter', mode: 'advanced', formula: '[val] > @Min' }],
  ['param_lenient_number', { type: 'AddColumn', name: 'r', formula: '[val] + @Big' }],
  ['param_date', { type: 'Filter', mode: 'advanced', formula: '[day] >= @Since' }],
  ['param_date_us', { type: 'Filter', mode: 'advanced', formula: '[day] >= @SinceUs' }],
  ['param_text', { type: 'AddColumn', name: 'r', formula: '[grp] & @Label' }],
);
const messyLocale = (col, type, locale) => [messySrc, { type: 'ChangeType', locale, changes: [{ col, type }] }, { type: 'ReplaceErrors', cols: [col] }];
C.push(
  ['messy_de_number', messyLocale('n', 'number', 'de-DE')],
  ['messy_de_int', messyLocale('n', 'int', 'de-DE')],
  ['messy_de_date', messyLocale('d', 'date', 'de-DE')],
  ['messy_de_datetime', messyLocale('t', 'datetime', 'de-DE')],
  ['messy_gb_date', messyLocale('d', 'date', 'en-GB')],
);
const formatChecks = [];
C.push(
  ['fmt_parquet', [src, ct, { type: 'Filter', mode: 'builder', builder: { join: 'and', conds: [{ col: 'val', op: 'gt', value: '10' }] } }], 'parquet'],
  ['fmt_arrow', [src, ct, { type: 'Sort', by: [{ col: 'id', desc: true }] }], 'arrow'],
  ['fmt_xlsx', [src, ct, { type: 'SelectColumns', cols: ['id', 'grp', 'val', 'price', 'name', 'day', 'ok', 'ts'] }], 'xlsx'],
);
C.push(...formulaCases);
const formulaNames = new Set(formulaCases.map((x) => x[0]));
const project = {
  name: 'Export check',
  settings: { previewRows: 1000, locale: 'en-US' },
  params: [{ name: 'Min', type: 'number', value: '50' }, { name: 'Big', type: 'number', value: '1,000' }, { name: 'Since', type: 'date', value: '2025-01-15' }, { name: 'SinceUs', type: 'date', value: '01/15/2025' }, { name: 'Label', type: 'text', value: 'x' }, { name: 'Regs', type: 'list', value: 'a, b' }],
  queries: C.map(([name, kind, target], i) => ({ id: 'q' + i, name, load: { target: target || 'csv' }, steps: (Array.isArray(kind) && kind[0].type === 'Source' ? kind : [src, ct].concat(Array.isArray(kind) ? kind : [kind])).map((k, j) => ({ id: 's' + j, name: j === 0 ? 'Source' : 'Step', kind: k })) })),
};
writeFileSync(join(dir, 'check.floe'), JSON.stringify(project));

const run = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd: cwd || root, encoding: 'utf8' });
  if (r.error) { console.error(`cannot run ${cmd}: ${r.error.message}`); process.exit(2); }
  return r;
};
const fail = (r, code) => { console.error(r.stdout + r.stderr); process.exit(code || 1); };
const built = run('node', ['scripts/floe.mjs', 'run', join(dir, 'check.floe'), '--data', data, '--out', join(dir, 'app'), '--quiet']);
const rejected = new Set();
if (built.status !== 0) {
  for (const line of built.stderr.split('\n')) { const m = /^✗ ([^:]+):/.exec(line); if (m) rejected.add(m[1]); }
  if ([...rejected].some((n) => !formulaNames.has(n)) || !rejected.size) fail(built);
}
const gen = run('node', ['scripts/floe.mjs', 'python', join(dir, 'check.floe'), '--out', join(dir, 'export.py')]);
if (gen.status !== 0) fail(gen);
const py = run(python, ['export.py'], dir);
if (py.status !== 0) fail(py, py.stderr.includes('No module named') ? 2 : 1);

const table = (file) => {
  const text = readFileSync(file, 'utf8'), out = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); out.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); out.push(row); }
  return out;
};
const plain = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/;
const same = (x, y) => {
  if (x === y) return true;
  if (x === '#ERROR' && y === '') return true;
  if (!plain.test(x) || !plain.test(y)) return false;
  const a = Number(x), b = Number(y);
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
};
const problems = [];
const otherFormats = new Map(C.filter((x) => x[2] && x[2] !== 'csv').map((x) => [x[0], x[2]]));
for (const [name] of C) {
  if (otherFormats.has(name)) continue;
  let a, b;
  if (rejected.has(name)) continue;
  try { a = table(join(dir, 'app', name + '.csv')); b = table(join(dir, 'out', name + '.csv')); } catch (e) { problems.push(`${name}: an output file is missing`); continue; }
  let why = null;
  if (a[0].join() !== b[0].join()) why = `columns [${a[0]}] against [${b[0]}]`;
  else if (a.length !== b.length) why = `${a.length - 1} rows against ${b.length - 1}`;
  else {
    for (let i = 1; i < a.length && !why; i++) for (let j = 0; j < a[i].length; j++) if (!same(a[i][j], b[i][j])) { why = `row ${i} column ${a[0][j]}: ${JSON.stringify(a[i][j])} against ${JSON.stringify(b[i][j])}`; break; }
  }
  if (why) problems.push(`${name}: app and Python differ, ${why}`);
}
const stopsOnBadValue = (errorMode) => {
  const failing = { name: 'Fail mode', settings: { previewRows: 1000, locale: 'en-US' }, params: [], queries: [{ id: 'q0', name: 'strict_types', load: { target: 'csv' }, steps: [messySrc, { type: 'ChangeType', onError: errorMode, changes: [{ col: 'n', type: 'int' }, { col: 'd', type: 'date' }] }].map((k, j) => ({ id: 's' + j, name: j === 0 ? 'Source' : 'Step', kind: k })) }] };
  writeFileSync(join(dir, 'fail.floe'), JSON.stringify(failing));
  const appRun = run('node', ['scripts/floe.mjs', 'run', join(dir, 'fail.floe'), '--data', data, '--out', join(dir, 'fail-app'), '--quiet']);
  const genRun = run('node', ['scripts/floe.mjs', 'python', join(dir, 'fail.floe'), '--out', join(dir, 'fail.py')]);
  if (genRun.status !== 0) return 'the script could not be generated: ' + genRun.stderr.slice(0, 200);
  const pyRun = run(python, ['fail.py'], dir);
  const appStops = appRun.status !== 0, pyStops = pyRun.status !== 0;
  if (errorMode === 'fail') return appStops && pyStops ? null : `with errors set to stop, the app ${appStops ? 'stopped' : 'went on'} and the Python script ${pyStops ? 'stopped' : 'went on'}`;
  return !appStops && !pyStops ? null : `with errors set to ${errorMode}, the app ${appStops ? 'stopped' : 'went on'} and the Python script ${pyStops ? 'stopped' : 'went on'}`;
};
for (const mode of ['fail', 'error', 'null']) { const why = stopsOnBadValue(mode); if (why) problems.push('change type, error mode ' + mode + ': ' + why); }
if (otherFormats.size) {
  const compared = run(python, [join(root, 'scripts', 'compare-formats.py'), dir].concat([...otherFormats].map(([n, f]) => n + ':' + f)), dir);
  if (compared.status !== 0) problems.push('the file formats could not be compared: ' + compared.stderr.slice(0, 200));
  for (const line of compared.stdout.split('\n')) if (line.startsWith('FAIL ')) problems.push(line.slice(5));
}
rmSync(dir, { recursive: true, force: true });
problems.forEach((x) => console.log('FAIL ' + x));
if (rejected.size) console.log(`${rejected.size} generated formulas are rejected by the app and were skipped`);
console.log(problems.length ? `${problems.length} of ${C.length} cases differ` : `all ${C.length} cases match`);
process.exit(problems.length ? 1 : 0);
