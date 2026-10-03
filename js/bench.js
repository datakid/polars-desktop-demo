(function () {
  const PQ = self.PQ, E = PQ.Engine;
  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rng = (seed) => () => (seed = (seed * 16807) % 2147483647) / 2147483647;

  function ordersCsv(n) {
    const r = rng(42), st = ['shipped', 'shipped', 'shipped', 'returned', 'pending', 'Shipped '];
    const lines = new Array(n + 1);
    lines[0] = 'order_id,order_date,customer_id,product_id,quantity,unit_price,discount,status';
    for (let i = 0; i < n; i++) {
      const d = new Date(Date.UTC(2025, 0, 1) + Math.floor(r() * 600) * 864e5).toISOString().slice(0, 10);
      lines[i + 1] = (100000 + i) + ',' + d + ',C' + String(1 + Math.floor(r() * 5000)).padStart(5, '0') + ',P-' + (100 + Math.floor(r() * 40)) + ',' + (1 + Math.floor(r() * 20)) + ',' + (r() * 100).toFixed(2) + ',' + (r() < 0.3 ? (r() * 0.2).toFixed(2) : '') + ',' + st[Math.floor(r() * st.length)];
    }
    return lines.join('\n');
  }
  function customersCsv() {
    const r = rng(7), reg = ['EU', 'US', 'APAC', 'LATAM'], seg = ['Consumer', 'SMB', 'Enterprise'];
    const lines = ['customer_id,customer_name,region,segment'];
    for (let i = 1; i <= 5000; i++) lines.push('C' + String(i).padStart(5, '0') + ',Customer ' + i + ',' + reg[Math.floor(r() * 4)] + ',' + seg[Math.floor(r() * 3)]);
    return lines.join('\n');
  }
  function reportXlsx(n) {
    const r = rng(3), aoa = [['Date', 'Store', 'Amount', 'Units']], stores = ['Berlin', 'Lisbon', 'Austin', 'Osaka'];
    for (let i = 0; i < n; i++) aoa.push(['2026-' + String(1 + (i % 12)).padStart(2, '0') + '-' + String(1 + (i % 28)).padStart(2, '0'), stores[i % 4], +(r() * 900).toFixed(2), 1 + Math.floor(r() * 50)]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Data');
    return XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  }
  function addFile(id, name, data) {
    const buf = typeof data === 'string' ? new TextEncoder().encode(data).buffer : data;
    PQ.Files.set(id, { id, name, size: buf.byteLength, mtime: 1, folder: '', buf });
    return buf.byteLength;
  }

  const src = (id, name, extra) => ({ id: 's0', name: 'Source', kind: { type: 'Source', source: Object.assign({ kind: 'file', fileId: id, fileName: name }, extra) } });
  const st = (kind, i) => ({ id: 's' + i, name: kind.type, kind });
  const csvSrc = () => src('orders', 'orders.csv', { csv: { delimiter: ',', header: true } });
  const types = { type: 'ChangeType', onError: 'error', changes: [{ col: 'order_date', type: 'date' }, { col: 'quantity', type: 'int' }, { col: 'unit_price', type: 'number' }, { col: 'discount', type: 'number' }] };
  const filter = { type: 'Filter', mode: 'advanced', formula: '[quantity] > 5 and [status] = "shipped"' };
  const q = (id, kinds, first) => ({ id, name: id, load: { target: 'none' }, steps: [first || csvSrc()].concat(kinds.map((k, i) => st(k, i + 1))) });
  const PIPES = {
    'A · types + filter': q('A', [types, filter]),
    'B · A + group by': q('B', [types, filter, { type: 'GroupBy', keys: ['customer_id', 'product_id'], aggs: [{ fn: 'sum', col: 'quantity' }, { fn: 'mean', col: 'unit_price' }, { fn: 'count_rows' }] }]),
    'C · A + merge + sort': q('C', [types, filter, { type: 'Merge', right: 'customers', how: 'left', on: [['customer_id', 'customer_id']] }, { type: 'Sort', by: [{ col: 'region' }, { col: 'unit_price', desc: true }] }]),
    'D · unpivot + pivot': q('D', [types, { type: 'SelectColumns', cols: ['order_id', 'quantity', 'unit_price'] }, { type: 'Unpivot', ids: ['order_id'], var: 'Attribute', val: 'Value' }, { type: 'Pivot', on: 'Attribute', index: ['order_id'], values: 'Value', agg: 'sum' }]),
    'E · Excel headers + types': q('E', [{ type: 'PromoteHeaders', row: 0 }, { type: 'ChangeType', onError: 'error', changes: [{ col: 'Date', type: 'date' }, { col: 'Amount', type: 'number' }, { col: 'Units', type: 'int' }] }], src('report', 'report.xlsx', { item: { type: 'sheet', name: 'Data' } })),
    'F · formula column + filter': q('F', [types, { type: 'AddColumn', name: 'revenue', formula: '[quantity] * [unit_price] * (1 - Coalesce([discount], 0))' }, { type: 'Filter', mode: 'advanced', formula: '[revenue] > 500' }]),
  };
  const customers = q('customers', [], src('customers', 'customers.csv', { csv: { delimiter: ',', header: true } }));

  function run(qid, mode) {
    E.setProject({ settings: { previewRows: 1000, locale: 'en-US' }, params: [], queries: Object.values(PIPES).concat([customers]) });
    E.clearCache();
    const t0 = performance.now();
    const r = E.evaluate(qid, undefined, mode);
    const ms = performance.now() - t0;
    if (!r.table) throw new Error(qid + ': ' + (r.states[r.failedAt] || {}).error);
    return { ms, n: r.table.n, steps: r.states.map((s) => Math.round(s.ms)) };
  }
  const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
  const fmt = (ms) => (ms < 1000 ? ms.toFixed(0) + ' ms' : (ms / 1000).toFixed(2) + ' s');

  async function bench(rows) {
    const body = $('rows-out');
    body.innerHTML = '';
    $('status').textContent = 'Generating ' + rows.toLocaleString() + ' rows…';
    await sleep(30);
    const t0 = performance.now();
    const bytes = addFile('orders', 'orders.csv', ordersCsv(rows)) + addFile('customers', 'customers.csv', customersCsv()) + addFile('report', 'report.xlsx', reportXlsx(Math.max(2000, Math.round(rows / 10))));
    $('status').textContent = 'Fixtures: ' + (bytes / 1048576).toFixed(1) + ' MB in ' + fmt(performance.now() - t0) + '. Running…';
    const results = [];
    for (const [label, pq] of Object.entries(PIPES)) {
      await sleep(10);
      const pv = [run(pq.id, 'preview'), run(pq.id, 'preview'), run(pq.id, 'preview')];
      const fu = [run(pq.id, 'full'), run(pq.id, 'full')];
      const res = { pipeline: label, previewCold: pv[0].ms, previewWarm: median(pv.slice(1).map((x) => x.ms)), fullCold: fu[0].ms, fullWarm: fu[1].ms, rowsOut: fu[0].n, stepsMs: fu[1].steps };
      results.push(res);
      const tr = document.createElement('tr');
      [label, fmt(res.previewCold), fmt(res.previewWarm), fmt(res.fullCold), fmt(res.fullWarm), res.rowsOut.toLocaleString()].forEach((v) => { const td = document.createElement('td'); td.textContent = v; tr.appendChild(td); });
      body.appendChild(tr);
      console.log('BENCH', label, '| preview', fmt(res.previewCold), '/', fmt(res.previewWarm), '| full', fmt(res.fullCold), '/', fmt(res.fullWarm), '| rows', res.rowsOut, '| steps', res.stepsMs.join('/'));
    }
    const mem = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) + ' MB heap' : '';
    $('status').textContent = 'Done · ' + rows.toLocaleString() + ' input rows · ' + navigator.userAgent.replace(/^.*(Chrome|Firefox|Safari)\/([\d.]+).*$/, '$1 $2') + (mem ? ' · ' + mem : '');
    self.BENCH = { version: PQ.VERSION, rows, ua: navigator.userAgent, results };
    console.log('BENCH DONE');
  }

  addEventListener('DOMContentLoaded', () => {
    $('run').addEventListener('click', () => bench(+$('size').value));
    $('copy').addEventListener('click', () => navigator.clipboard.writeText(JSON.stringify(self.BENCH || {}, null, 2)));
    bench(+$('size').value);
  });
})();
