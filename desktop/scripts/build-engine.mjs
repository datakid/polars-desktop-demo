// Builds the native Polars engine and places it where Tauri's `externalBin` expects it:
//   src-tauri/binaries/floe-engine-<target-triple>[.exe]
// Also copies it next to the dev binary so `npm run dev` finds it without bundling.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, '..');
const ext = process.platform === 'win32' ? '.exe' : '';
const triple = execFileSync('rustc', ['-vV'], { encoding: 'utf8' }).match(/host: (\S+)/)[1];
const profile = process.argv.includes('--debug') ? 'debug' : 'release';

execFileSync('cargo', ['build', '-p', 'pq-worker', ...(profile === 'release' ? ['--release'] : [])], { cwd: desktop, stdio: 'inherit' });

const built = join(desktop, 'target', profile, 'floe-engine' + ext);
if (!existsSync(built)) { console.error('build-engine: missing ' + built); process.exit(1); }
const binDir = join(desktop, 'src-tauri', 'binaries');
mkdirSync(binDir, { recursive: true });
copyFileSync(built, join(binDir, `floe-engine-${triple}${ext}`));
for (const p of ['debug', 'release']) {
  const d = join(desktop, 'src-tauri', 'target', p);
  if (existsSync(d)) copyFileSync(built, join(d, 'floe-engine' + ext));
}
console.log(`build-engine: floe-engine (${profile}) → binaries/floe-engine-${triple}${ext}`);
