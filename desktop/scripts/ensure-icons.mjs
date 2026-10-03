import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const icons = join(desktop, 'src-tauri', 'icons');
const source = resolve(desktop, '..', 'images', 'floe-icon.svg');
const force = process.argv.includes('--force');
const needed = ['32x32.png', '128x128.png', '128x128@2x.png', 'icon.png', 'icon.icns', 'icon.ico'];

if (!force && needed.every((f) => existsSync(join(icons, f)))) process.exit(0);
if (!existsSync(source)) {
  console.error('[floe icons] missing ' + source);
  process.exit(1);
}
console.log('[floe icons] generating app icons from images/floe-icon.svg');
const r = spawnSync('npx', ['tauri', 'icon', source, '-o', icons], { cwd: desktop, stdio: 'inherit', shell: process.platform === 'win32' });
process.exit(r.status === null ? 1 : r.status);
