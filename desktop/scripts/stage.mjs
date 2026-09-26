// Copies the Floe UI (repo root) into desktop/dist — the Tauri frontendDist.
// Runs automatically before `tauri dev` / `tauri build`. Pure Node, no dependencies.
import { cpSync, existsSync, mkdirSync, rmSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const dist = resolve(here, '..', 'dist');
const include = ['index.html', 'css', 'js', 'fonts', 'images', 'vendor'];
const skip = new Set(['tests.js']);

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
let files = 0;
for (const entry of include) {
  const src = join(root, entry);
  if (!existsSync(src)) { console.error(`stage: missing ${entry}`); process.exit(1); }
  cpSync(src, join(dist, entry), { recursive: true, filter: (p) => !skip.has(p.split(/[\\/]/).pop()) });
}
const count = (d) => readdirSync(d).reduce((n, f) => { const p = join(d, f); return n + (statSync(p).isDirectory() ? count(p) : 1); }, 0);
files = count(dist);
console.log(`stage: ${files} files → ${dist}`);
