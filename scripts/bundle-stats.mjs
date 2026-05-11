#!/usr/bin/env node
// Walks the production build output and prints a markdown bundle-size report.
// Designed to be piped into $GITHUB_STEP_SUMMARY in CI; also useful locally
// (`node scripts/bundle-stats.mjs`) to spot bundle bloat before pushing.
//
// We classify outputs by Angular's hashed-filename convention:
//   main-*.js / polyfills-*.js / chunk-*.js / styles-*.css
// and roll lazy chunks up into a single line. No third-party deps — the only
// data source is the on-disk dist/, so this runs anywhere Node 20+ runs.

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync, brotliCompressSync } from 'node:zlib';
import { readFileSync } from 'node:fs';

const DIST = process.argv[2] ?? 'dist/lascodia-admin/browser';

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function classify(name) {
  if (name.startsWith('main.') || name.startsWith('main-')) return 'main';
  if (name.startsWith('polyfills.') || name.startsWith('polyfills-')) return 'polyfills';
  if (name.startsWith('runtime.') || name.startsWith('runtime-')) return 'runtime';
  if (name.startsWith('styles.') || name.startsWith('styles-')) return 'styles';
  if (name.endsWith('.js')) return 'chunk';
  if (name.endsWith('.css')) return 'css';
  return 'other';
}

let files;
try {
  files = readdirSync(DIST).filter((n) => !statSync(join(DIST, n)).isDirectory());
} catch (err) {
  console.error(`bundle-stats: cannot read ${DIST} — did the build succeed?`);
  console.error(err.message);
  process.exit(1);
}

const groups = { main: [], polyfills: [], runtime: [], styles: [], chunk: [], css: [], other: [] };
for (const name of files) {
  const path = join(DIST, name);
  const raw = readFileSync(path);
  groups[classify(name)].push({
    name,
    raw: raw.length,
    gz: gzipSync(raw).length,
    br: brotliCompressSync(raw).length,
  });
}

const lines = [];
lines.push('## Bundle size');
lines.push('');
lines.push('| Bucket | Files | Raw | Gzipped | Brotli |');
lines.push('| --- | ---: | ---: | ---: | ---: |');

let totalRaw = 0;
let totalGz = 0;
let totalBr = 0;

for (const [bucket, items] of Object.entries(groups)) {
  if (items.length === 0) continue;
  const raw = items.reduce((s, i) => s + i.raw, 0);
  const gz = items.reduce((s, i) => s + i.gz, 0);
  const br = items.reduce((s, i) => s + i.br, 0);
  totalRaw += raw;
  totalGz += gz;
  totalBr += br;
  lines.push(`| ${bucket} | ${items.length} | ${fmtBytes(raw)} | ${fmtBytes(gz)} | ${fmtBytes(br)} |`);
}
lines.push(`| **total** | **${files.length}** | **${fmtBytes(totalRaw)}** | **${fmtBytes(totalGz)}** | **${fmtBytes(totalBr)}** |`);

// Top-10 largest individual outputs — that's where regressions usually hide.
const all = Object.values(groups).flat().sort((a, b) => b.raw - a.raw).slice(0, 10);
lines.push('');
lines.push('### Top 10 outputs');
lines.push('');
lines.push('| File | Raw | Gzipped | Brotli |');
lines.push('| --- | ---: | ---: | ---: |');
for (const item of all) {
  lines.push(`| \`${item.name}\` | ${fmtBytes(item.raw)} | ${fmtBytes(item.gz)} | ${fmtBytes(item.br)} |`);
}

console.log(lines.join('\n'));
