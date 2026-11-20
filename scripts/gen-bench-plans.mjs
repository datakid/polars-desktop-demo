import vm from 'node:vm';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rows = Math.max(1000, +process.argv[2] || 1000000);
const dir = resolve(process.argv[3] || '/tmp/floe_bench_plans');
mkdirSync(dir, { recursive: true });

const ctx = { console, TextDecoder, TextEncoder, performance, Intl, setTimeout, clearTimeout, structuredClone, indexedDB: undefined, navigator: {}, document: { getElementById: () => null }, addEventListener: () => {}, location: { search: '' } };
ctx.self = ctx;
vm.createContext(ctx);
for (const f of ['util', 'expr', 'io', 'steps', 'engine', 'engine-ext', 'parquet', 'plan', 'bench']) {
  vm.runInContext(readFileSync(join(root, 'js', f + '.js'), 'utf8'), ctx, { filename: f + '.js' });
}
const D = ctx.BENCH_DEFS;
const ordersPath = join(dir, 'orders.csv'), customersPath = join(dir, 'customers.csv');
writeFileSync(ordersPath, D.ordersCsv(rows));
writeFileSync(customersPath, D.customersCsv());

const queries = Object.values(D.PIPES).concat([D.customers]);
const project = { settings: { previewRows: 1000, locale: 'en-US' }, params: [], queries };
const files = { orders: ordersPath, customers: customersPath };
const plans = {};
for (const [label, pq] of Object.entries(D.PIPES)) {
  if (pq.id === 'E') continue;
  const low = ctx.PQ.Plan.lower(project, pq.id, { files });
  if (!low.ok) throw new Error(label + ': ' + low.reason);
  plans[label] = low.plan;
}
writeFileSync(join(dir, 'plans.json'), JSON.stringify({ rows, plans }));
console.log('[bench plans]', Object.keys(plans).length, 'pipelines,', rows.toLocaleString(), 'rows →', dir);
