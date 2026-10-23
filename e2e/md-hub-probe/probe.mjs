#!/usr/bin/env node
/**
 * READ-ONLY probe of the live market-data hub (C4) with the console's in-repo MessagePack protocol (and JSON):
 *   JWT=... node e2e/md-hub-probe/probe.mjs [symbol] [seconds]
 * Subscribes, counts frames, rebuilds the book, unsubscribes, disconnects. Nothing is written to the engine.
 * HUB_URL defaults to ws://localhost:8080/api/hubs/marketdata (Caddy → api).
 */
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const token = process.env.JWT;
if (!token) {
  console.error('Set JWT.');
  process.exit(2);
}
const symbol = process.argv[2] ?? 'EURUSD';
const seconds = Number(process.argv[3] ?? 5);
const url = process.env.HUB_URL ?? 'http://localhost:8080/api/hubs/marketdata';
const out = await build({
  entryPoints: [join(here, 'probe-entry.ts')],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  tsconfig: join(here, '../../tsconfig.json'),
  external: ['ws', 'eventsource', 'fetch-cookie', 'node-fetch', 'tough-cookie', 'abort-controller'],
});
// Written next to this script (so `require('ws')` resolves from the repo's node_modules), removed afterwards.
const file = join(here, `.probe-${process.pid}.cjs`);
writeFileSync(file, out.outputFiles[0].text);
try {
  const require = createRequire(import.meta.url);
  const { probe } = require(file);
  for (const p of ['messagepack', 'json']) console.log(JSON.stringify(await probe(url, token, symbol, seconds, p), null, 1));
} finally {
  rmSync(file, { force: true });
}
