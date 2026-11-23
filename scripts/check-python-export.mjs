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

const rows = ['id,grp,val'];
for (let i = 1; i <= 500; i++) rows.push(`${i},${'abc'[i % 3]},${(i * 37) % 101}`);
writeFileSync(join(data, 'orders.csv'), rows.join('\n') + '\n');

const source = { type: 'Source', source: { kind: 'file', fileId: 'orders.csv', fileName: 'orders.csv', csv: { delimiter: ',', header: true } } };
const cases = [
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
];
const project = {
  name: 'Export check',
  settings: { previewRows: 1000, locale: 'en-US' },
  params: [],
  queries: cases.map(([name, kind], i) => ({ id: 'q' + i, name, load: { target: 'csv' }, steps: [{ id: 's0', name: 'Source', kind: source }, { id: 's1', name: 'Step', kind }] })),
};
writeFileSync(join(dir, 'check.floe'), JSON.stringify(project));

const run = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd: cwd || root, encoding: 'utf8' });
  if (r.error) { console.error(`cannot run ${cmd}: ${r.error.message}`); process.exit(2); }
  return r;
};
const built = run('node', ['scripts/floe.mjs', 'run', join(dir, 'check.floe'), '--data', data, '--out', join(dir, 'app'), '--quiet']);
if (built.status !== 0) { console.error(built.stdout + built.stderr); process.exit(1); }
const gen = run('node', ['scripts/floe.mjs', 'python', join(dir, 'check.floe'), '--out', join(dir, 'export.py')]);
if (gen.status !== 0) { console.error(gen.stdout + gen.stderr); process.exit(1); }
const py = run(python, ['export.py'], dir);
if (py.status !== 0) { console.error(py.stdout + py.stderr); process.exit(py.stderr.includes('No module named') ? 2 : 1); }

const ids = (file) => readFileSync(file, 'utf8').trim().split(/\r?\n/).slice(1).map((l) => l.split(',')[0]);
let bad = 0;
for (const [name] of cases) {
  const a = ids(join(dir, 'app', name + '.csv')), b = ids(join(dir, 'out', name + '.csv'));
  const same = a.length === b.length && a.every((v, i) => v === b[i]);
  console.log(`${same ? 'ok  ' : 'FAIL'} ${name}: app ${a.length} rows, Python ${b.length} rows${same ? '' : ', first rows ' + a.slice(0, 5) + ' against ' + b.slice(0, 5)}`);
  if (!same) bad++;
}
rmSync(dir, { recursive: true, force: true });
console.log(bad ? `${bad} of ${cases.length} cases differ` : `all ${cases.length} cases match`);
process.exit(bad ? 1 : 0);
