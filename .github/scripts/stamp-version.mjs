import { readFileSync, writeFileSync } from 'node:fs';

const version = process.env.VERSION;
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`stamp-version: invalid VERSION "${version}"`);
  process.exit(1);
}

function json(file) {
  const data = JSON.parse(readFileSync(file, 'utf8'));
  data.version = version;
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

json('package.json');
json('desktop/package.json');
json('desktop/src-tauri/tauri.conf.json');

const util = 'js/util.js';
const src = readFileSync(util, 'utf8');
const out = src.replace(/PQ\.VERSION\s*=\s*'[^']+'/, `PQ.VERSION = '${version}'`);
if (out === src && !src.includes(`PQ.VERSION = '${version}'`)) {
  console.error('stamp-version: PQ.VERSION not found in js/util.js');
  process.exit(1);
}
writeFileSync(util, out);
console.log(`stamp-version: ${version}`);
