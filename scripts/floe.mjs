#!/usr/bin/env node
import vm from 'node:vm';
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, readdirSync, openSync, readSync, closeSync } from 'node:fs';
import { dirname, join, resolve, basename, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXIT = { ok: 0, failed: 1, usage: 2, missing: 3 };

const HELP = `floe — run Floe projects from the command line (built-in engine)

Usage
  floe run <project.floe> [--query <name>] [--format csv|tsv|xlsx|parquet|arrow]
                          [--data <dir>] [--out <dir>] [--param name=value]... [--quiet]
  floe inspect <file> [--rows <n>] [--json]
  floe python <project.floe> [--query <name>] [--out <file.py>]
  floe plan <project.floe> --query <name> [--data <dir>]
  floe version

run       Without --query: refreshes every query whose load target is not "Connection only"
          and writes one file per query. With --query: exports that query on full data.
          File sources are looked up by name in --data (default: the project's folder);
          folder sources map to a sub-folder of --data with the same name.
inspect   Shows format, rows, columns and types. Parquet also lists row groups and codec,
          and reads only the footer plus the row groups needed for the preview.
python    Writes the Polars script that Export → Python script produces.
plan      Prints the JSON plan floe-engine (Polars) would run, or the reason it would refuse.

Exit codes: 0 ok · 1 a query failed · 2 usage error · 3 input file not found`;

function parseArgs(argv) {
  const out = { _: [], param: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { out.help = true; continue; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
      const flag = ['quiet', 'json', 'help'].includes(key);
      const val = eq > 0 ? a.slice(eq + 1) : flag ? true : argv[++i];
      if (val === undefined) fail('Missing value for --' + key, EXIT.usage);
      if (key === 'param') out.param.push(val); else out[key] = val;
    } else out._.push(a);
  }
  return out;
}

function fail(msg, code) {
  process.stderr.write('floe: ' + msg + '\n');
  process.exit(code === undefined ? EXIT.failed : code);
}

async function loadEngine() {
  const g = globalThis;
  if (!g.self) g.self = g;
  const run = (rel) => vm.runInThisContext(readFileSync(join(root, rel), 'utf8'), { filename: join(root, rel) });
  run('vendor/xlsx.full.min.js');
  try { run('vendor/arrow.es2015.min.js'); } catch (e) { }
  try { run('vendor/alasql.min.js'); } catch (e) { }
  const mod = (rel) => import(pathToFileURL(join(root, rel)).href);
  const [hyparquet, comp, writer] = await Promise.all([mod('vendor/hyparquet.min.js'), mod('vendor/hyparquet-compressors.min.js'), mod('vendor/hyparquet-writer.min.js')]);
  g.__floeModules = { hyparquet, compressors: comp.compressors, writer };
  for (const f of ['util', 'expr', 'io', 'steps', 'engine', 'host', 'engine-ext', 'parquet', 'plan']) run('js/' + f + '.js');
  const origWarn = console.warn;
  console.warn = (...a) => { if (!/IndexedDB/.test(String(a[0]))) origWarn(...a); };
  return g.PQ;
}

function fileBlob(path, size) {
  const read = (s, e) => {
    const len = Math.max(0, e - s);
    const buf = Buffer.alloc(len);
    const fd = openSync(path, 'r');
    try { let off = 0; while (off < len) { const n = readSync(fd, buf, off, len - off, s + off); if (!n) break; off += n; } } finally { closeSync(fd); }
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + len);
  };
  const make = (s, e) => ({ size: e - s, slice: (a, b) => make(s + (a || 0), s + (b === undefined ? e - s : Math.min(b, e - s))), arrayBuffer: async () => read(s, e) });
  return make(0, size);
}

function register(PQ, id, path, folder) {
  const st = statSync(path);
  const name = basename(path);
  const rec = { id, name, size: st.size, mtime: Math.round(st.mtimeMs), folder: folder || '', path };
  if (PQ.isLazyFile(name)) { rec.buf = null; rec.blob = fileBlob(path, st.size); }
  else { const b = readFileSync(path); rec.buf = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); }
  PQ.Files.set(id, rec);
  return rec;
}

function loadProject(PQ, file, args) {
  if (!existsSync(file)) fail('Project not found: ' + file, EXIT.missing);
  let p;
  try { p = PQ.Steps.migrate(JSON.parse(readFileSync(file, 'utf8'))); } catch (e) { fail('Could not read ' + file + ': ' + e.message, EXIT.usage); }
  for (const kv of args.param) {
    const i = kv.indexOf('=');
    if (i < 1) fail('--param expects name=value, got ' + kv, EXIT.usage);
    const name = kv.slice(0, i), value = kv.slice(i + 1);
    const prm = (p.params || []).find((x) => x.name === name);
    if (!prm) fail('Unknown parameter ' + name + '. Known: ' + ((p.params || []).map((x) => x.name).join(', ') || 'none'), EXIT.usage);
    prm.value = value;
  }
  return p;
}

function linkFiles(PQ, project, dataDir) {
  const missing = [];
  const paths = {};
  const done = new Set();
  for (const q of project.queries || []) {
    for (const s of q.steps || []) {
      const src = s.kind && s.kind.type === 'Source' ? s.kind.source : null;
      if (!src) continue;
      if (src.kind === 'file') {
        const id = src.fileId || src.fileName;
        src.fileId = id;
        if (done.has(id)) continue;
        done.add(id);
        const p = join(dataDir, src.fileName || '');
        if (!src.fileName || !existsSync(p)) { missing.push(src.fileName || '(unnamed file)'); continue; }
        register(PQ, id, p);
        paths[id] = p;
      } else if (src.kind === 'folder') {
        const key = 'folder:' + src.folder;
        if (done.has(key)) continue;
        done.add(key);
        const d = join(dataDir, src.folder || '');
        if (!existsSync(d) || !statSync(d).isDirectory()) { missing.push(src.folder + '/'); continue; }
        for (const n of readdirSync(d).sort()) {
          const p = join(d, n);
          if (statSync(p).isFile() && PQ.IO.fileKind(n) !== 'unknown') register(PQ, 'f:' + src.folder + '/' + n, p, src.folder);
        }
      }
    }
  }
  return { missing, paths };
}

const say = (args, msg) => { if (!args.quiet) process.stderr.write(msg + '\n'); };
const fmtMs = (ms) => (ms < 1000 ? Math.round(ms) + ' ms' : (ms / 1000).toFixed(2) + ' s');
const toBytes = (d) => (typeof d === 'string' ? Buffer.from(d, 'utf8') : Buffer.from(d instanceof ArrayBuffer ? new Uint8Array(d) : d));

async function cmdRun(PQ, args) {
  const file = args._[1];
  if (!file) fail('run needs a project file', EXIT.usage);
  const project = loadProject(PQ, file, args);
  const dataDir = resolve(args.data || dirname(resolve(file)));
  const outDir = resolve(args.out || process.cwd());
  const { missing } = linkFiles(PQ, project, dataDir);
  if (missing.length) fail('Input not found in ' + dataDir + ': ' + missing.join(', '), EXIT.missing);
  PQ.Engine.setProject(project);
  mkdirSync(outDir, { recursive: true });
  const progress = (p) => { if (p && p.stage) say(args, '  ' + p.stage); };
  const t0 = performance.now();
  if (args.query) {
    const q = PQ.Engine.query(args.query);
    if (!q) fail('No query named "' + args.query + '". Queries: ' + project.queries.map((x) => x.name).join(', '), EXIT.usage);
    const fmt = args.format || (q.load && q.load.target && q.load.target !== 'none' ? q.load.target : 'csv');
    if (!['csv', 'tsv', 'xlsx', 'parquet', 'arrow'].includes(fmt)) fail('Unknown format ' + fmt, EXIT.usage);
    let r;
    try { r = await PQ.Host.handle({ op: 'exportQuery', qid: q.id, format: fmt }, progress); } catch (e) { fail(q.name + ': ' + e.message); }
    const dest = join(outDir, PQ.snake(q.name) + '.' + fmt);
    writeFileSync(dest, toBytes(r.data));
    say(args, '✓ ' + q.name + ' → ' + dest + ' · ' + r.rows.toLocaleString('en-US') + ' rows · ' + fmtMs(performance.now() - t0));
    return EXIT.ok;
  }
  if (args.format) fail('--format needs --query (otherwise each query uses its own load target)', EXIT.usage);
  const r = await PQ.Host.handle({ op: 'refreshAll' }, progress);
  if (!r.outputs.length) { say(args, 'Nothing to refresh: every query is "Connection only". Use --query to export one.'); return EXIT.ok; }
  let bad = 0;
  for (const o of r.outputs) {
    if (o.error) { bad++; process.stderr.write('✗ ' + o.name + ': ' + o.error + '\n'); continue; }
    const dest = join(outDir, o.name);
    writeFileSync(dest, toBytes(o.data));
    say(args, '✓ ' + dest + ' · ' + o.rows.toLocaleString('en-US') + ' rows');
  }
  say(args, (bad ? bad + ' failed · ' : '') + 'done in ' + fmtMs(performance.now() - t0));
  return bad ? EXIT.failed : EXIT.ok;
}

async function cmdInspect(PQ, args) {
  const file = args._[1];
  if (!file) fail('inspect needs a data file', EXIT.usage);
  if (!existsSync(file)) fail('File not found: ' + file, EXIT.missing);
  const rec = register(PQ, 'inspect', resolve(file));
  const kind = PQ.IO.fileKind(rec.name);
  if (kind === 'unknown') fail('Unsupported file type: ' + extname(file), EXIT.usage);
  const n = Math.max(0, +(args.rows || 10));
  let info;
  try {
    if (kind === 'parquet') await PQ.IO.prepare(new Set([rec.id]), { op: 'inspectFile', fileId: rec.id });
    info = PQ.IO.inspectFile(rec);
  } catch (e) { fail(e.message); }
  if (kind === 'csv' || kind === 'json') {
    const t = PQ.IO.readFile(rec, { format: kind, csv: { delimiter: info.delimiter, header: info.header !== false } }, 2000);
    info = Object.assign(info, { rows: undefined, cols: t.cols.length, schema: t.cols.map((c, i) => ({ name: c.name, type: PQ.inferType(t.data[i], info.locale) || c.type })), preview: [t.names].concat(t.toRows(n).map((r) => r.map((v) => PQ.fmtValue(v)))) });
  }
  if (args.json) { process.stdout.write(JSON.stringify(Object.assign({}, info, { preview: (info.preview || []).slice(0, n + 1) }), null, 2) + '\n'); return EXIT.ok; }
  const lines = [rec.name + ' · ' + kind.toUpperCase() + ' · ' + (rec.size / 1048576).toFixed(2) + ' MB'];
  if (info.rows !== undefined) lines.push(info.rows.toLocaleString('en-US') + ' rows × ' + info.cols + ' columns');
  if (info.meta && info.meta.rowGroups) lines.push(info.meta.rowGroups + ' row groups' + (info.meta.codec ? ' · ' + info.meta.codec.toLowerCase() : '') + (info.meta.createdBy ? ' · ' + info.meta.createdBy : ''));
  if (info.delimiter) lines.push('delimiter ' + JSON.stringify(info.delimiter) + ' · ' + info.encoding + ' · ' + info.locale);
  if (info.sheets) lines.push('sheets: ' + info.sheets.map((s) => s.name).join(', '));
  if (info.schema) { lines.push(''); const w = Math.max(...info.schema.map((c) => c.name.length)); info.schema.forEach((c) => lines.push('  ' + c.name.padEnd(w) + '  ' + c.type)); }
  const pv = (info.preview || []).slice(0, n + 1);
  if (pv.length > 1 && !info.sheets) {
    lines.push('');
    const widths = pv[0].map((_, i) => Math.min(24, Math.max(...pv.map((r) => String(r[i] === null || r[i] === undefined ? '' : r[i]).length))));
    pv.forEach((r, k) => { lines.push('  ' + r.map((v, i) => String(v === null || v === undefined ? '' : v).slice(0, 24).padEnd(widths[i])).join('  ')); if (!k) lines.push('  ' + widths.map((x) => '─'.repeat(x)).join('  ')); });
  }
  process.stdout.write(lines.join('\n') + '\n');
  return EXIT.ok;
}

function cmdPython(PQ, args) {
  const file = args._[1];
  if (!file) fail('python needs a project file', EXIT.usage);
  const project = loadProject(PQ, file, args);
  let qid;
  if (args.query) { const q = project.queries.find((x) => x.name === args.query || x.id === args.query); if (!q) fail('No query named "' + args.query + '"', EXIT.usage); qid = q.id; }
  const code = PQ.Steps.toPython(project, qid);
  if (args.out) { writeFileSync(resolve(args.out), code); say(args, '✓ ' + resolve(args.out)); }
  else process.stdout.write(code.endsWith('\n') ? code : code + '\n');
  return EXIT.ok;
}

function cmdPlan(PQ, args) {
  const file = args._[1];
  if (!file || !args.query) fail('plan needs a project file and --query', EXIT.usage);
  const project = loadProject(PQ, file, args);
  const q = project.queries.find((x) => x.name === args.query || x.id === args.query);
  if (!q) fail('No query named "' + args.query + '"', EXIT.usage);
  const { paths } = linkFiles(PQ, project, resolve(args.data || dirname(resolve(file))));
  const r = PQ.Plan.lower(project, q.id, { files: paths });
  if (!r.ok) { process.stdout.write(JSON.stringify({ ok: false, reason: r.reason }, null, 2) + '\n'); return EXIT.failed; }
  process.stdout.write(JSON.stringify({ ok: true, plan: r.plan }, null, 2) + '\n');
  return EXIT.ok;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (!cmd || args.help) { process.stdout.write(HELP + '\n'); return cmd || args.help ? EXIT.ok : EXIT.usage; }
  if (cmd === 'version' || cmd === '--version') { const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')); process.stdout.write('floe ' + pkg.version + ' (built-in engine, Node ' + process.versions.node + ')\n'); return EXIT.ok; }
  if (!['run', 'inspect', 'python', 'plan'].includes(cmd)) fail('Unknown command "' + cmd + '". Try floe --help', EXIT.usage);
  const PQ = await loadEngine();
  if (cmd === 'run') return cmdRun(PQ, args);
  if (cmd === 'inspect') return cmdInspect(PQ, args);
  if (cmd === 'python') return cmdPython(PQ, args);
  return cmdPlan(PQ, args);
}

main().then((code) => process.exit(code), (e) => fail(e && e.stack ? e.stack : String(e)));
