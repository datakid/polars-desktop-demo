import { cpSync, rmSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf('--' + k);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};
const target = opt('target', 'web');
if (!['web', 'desktop'].includes(target)) fail('Unknown --target ' + target + ' (expected web or desktop)');
const out = resolve(root, opt('out', target === 'web' ? 'dist' : 'desktop/dist'));

function fail(msg) {
  console.error('\n[floe build] ' + msg + '\n');
  process.exit(1);
}
const rel = (p) => relative(root, p).split(sep).join('/');

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = pkg.version;

const utilSrc = readFileSync(join(root, 'js/util.js'), 'utf8');
const m = /PQ\.VERSION\s*=\s*'([^']+)'/.exec(utilSrc);
if (!m) fail('PQ.VERSION not found in js/util.js');
if (m[1] !== version) fail('Version mismatch: package.json is ' + version + ' but js/util.js PQ.VERSION is ' + m[1]);
if (target === 'desktop') {
  const conf = JSON.parse(readFileSync(join(root, 'desktop/src-tauri/tauri.conf.json'), 'utf8'));
  if (conf.version !== version) fail('Version mismatch: package.json is ' + version + ' but tauri.conf.json is ' + conf.version);
}

const COMMON = ['index.html', 'demo.html', 'manifest.webmanifest', 'css', 'js', 'vendor', 'fonts', 'images'];
const WEB_ONLY = ['sw.js', 'tests.html', 'tests-ui.html', '404.html', 'robots.txt'];
const DESKTOP_SKIP = new Set(['js/tests.js']);
const REQUIRED = [
  'index.html', 'css/app.css', 'js/util.js', 'js/worker.js', 'js/ui/app.js',
  'vendor/xlsx.full.min.js', 'vendor/alasql.min.js', 'vendor/arrow.es2015.min.js',
  'vendor/hyparquet.min.js', 'vendor/hyparquet-compressors.min.js', 'vendor/hyparquet-writer.min.js',
  'vendor/fontawesome/css/all.min.css', 'vendor/fontawesome/webfonts/fa-solid-900.woff2',
  'fonts/instrument-sans.woff2', 'fonts/source-serif-4.woff2', 'fonts/jetbrains-mono.woff2',
  'images/floe-icon.svg',
];
const missing = REQUIRED.filter((p) => !existsSync(join(root, p)));
if (missing.length) fail('Missing required files:\n  ' + missing.join('\n  '));

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const entries = target === 'web' ? COMMON.concat(WEB_ONLY) : COMMON;
for (const e of entries) {
  const src = join(root, e);
  if (!existsSync(src)) continue;
  cpSync(src, join(out, e), {
    recursive: true,
    filter: (s) => {
      const r = rel(s);
      if (/(^|\/)\.[^/]+$/.test(r) && r !== '.') return false;
      if (target === 'desktop' && DESKTOP_SKIP.has(r)) return false;
      return true;
    },
  });
}

function walk(dir, acc) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}
const files = walk(out, []);
const hash = createHash('sha256');
let bytes = 0;
for (const f of files) {
  const r = relative(out, f).split(sep).join('/');
  if (r === 'sw.js') continue;
  const buf = readFileSync(f);
  bytes += buf.length;
  hash.update(r).update('\0').update(buf);
}
const build = hash.digest('hex').slice(0, 10);
const cacheName = 'floe-' + version + '-' + build;

if (target === 'web') {
  const swPath = join(out, 'sw.js');
  let sw = readFileSync(swPath, 'utf8');
  if (!/const VERSION = '[^']*';/.test(sw)) fail('sw.js: VERSION constant not found');
  sw = sw.replace(/const VERSION = '[^']*';/, "const VERSION = '" + cacheName + "';");
  writeFileSync(swPath, sw);
  const core = [...sw.matchAll(/'\.\/([^']+)'/g)].map((x) => x[1]).filter((p) => p && !p.startsWith('__shared') && !p.includes('?'));
  const absent = core.filter((p) => !existsSync(join(out, p)));
  if (absent.length) fail('sw.js precaches files that are not in the build:\n  ' + absent.join('\n  '));
}

writeFileSync(join(out, 'version.json'), JSON.stringify({ name: 'floe', version, build, target, builtAt: new Date().toISOString() }, null, 2) + '\n');

console.log('[floe build] ' + target + ' ' + version + ' (' + build + ') → ' + rel(out) + ' · ' + files.length + ' files · ' + (bytes / 1048576).toFixed(1) + ' MB');
