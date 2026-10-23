#!/usr/bin/env node
/**
 * WebGL heatmap frame-time benchmark (ui-stream, market-data program).
 *
 *   MD_BENCH_DATA=/path/md-history.json node e2e/md-heatmap-bench/run-bench.mjs
 *
 * MD_BENCH_DATA is a saved `POST md/history` answer (the envelope or its data) — RECORDED broker book events, read-only.
 * Bundles bench-entry.ts with esbuild, opens it in Playwright's Chromium (no server: a data: page, no network, nothing
 * reaches the engine), and prints JSON: setup costs (timeline, fold, first upload) and per-frame times while the view
 * pans with live events appended. Runs: the recorded window as is, and (BENCH_TILE=n) the same events tiled n times
 * back to back — a longer span at the recorded density, labelled as such in the output.
 */
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const dataPath = process.env.MD_BENCH_DATA;
if (!dataPath) {
  console.error('Set MD_BENCH_DATA to a saved md/history answer.');
  process.exit(2);
}
const raw = JSON.parse(readFileSync(dataPath, 'utf8'));
const data = raw.data ?? raw;
const src = [...data.sources].sort((a, b) => (b.book?.length ?? 0) - (a.book?.length ?? 0))[0];
const recorded = src.book;
const tile = Math.max(1, Number(process.env.BENCH_TILE ?? 1));
const span = recorded[recorded.length - 1].t - recorded[0].t + 1;
const events = [];
for (let r = 0; r < tile; r++) for (const e of recorded) events.push({ ...e, t: e.t + r * span });

const bundle = await build({
  entryPoints: [join(here, 'bench-entry.ts')],
  bundle: true,
  write: false,
  format: 'iife',
  target: 'es2022',
  tsconfig: join(here, '../../tsconfig.json'),
});
const js = bundle.outputFiles[0].text;

const headless = process.env.BENCH_HEADED !== '1';
const browser = await chromium.launch({
  headless,
  args: (process.env.BENCH_GL_ARGS ?? '--use-angle=metal --enable-gpu-rasterization --ignore-gpu-blocklist').split(' ').filter(Boolean),
});
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: Number(process.env.BENCH_DPR ?? 2) });
  // Never let anything leave the page.
  await page.route('**/*', (route) => route.abort());
  await page.setContent('<!doctype html><html><body style="margin:0;background:#131722"></body></html>');
  await page.addScriptTag({ content: js });
  const result = await page.evaluate(
    (input) => window.runBench(input),
    {
      events,
      width: Number(process.env.BENCH_WIDTH ?? 1400),
      height: Number(process.env.BENCH_HEIGHT ?? 700),
      dpr: Number(process.env.BENCH_DPR ?? 2),
      frames: Number(process.env.BENCH_FRAMES ?? 600),
      liveEventsPerFrame: Number(process.env.BENCH_LIVE ?? 2),
    },
  );
  console.log(
    JSON.stringify(
      {
        source: src.sourceId,
        recordedEvents: recorded.length,
        recordedSpanMinutes: span / 60_000,
        tiled: tile,
        note: tile > 1 ? `recorded events repeated ${tile}x back to back (same density, ${tile}x the span)` : 'recorded events as stored',
        headless,
        ...result,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
