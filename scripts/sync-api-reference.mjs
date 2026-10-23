#!/usr/bin/env node
/**
 * Copies the engine's generated API reference (docs/api/api-reference.json — written by the engine's
 * ApiReferenceDocumentTests from its OpenAPI document) into public/docs-content/, where the console's
 * /docs/api page reads it. Run after the engine's file changes:
 *
 *   npm run docs:api                 # ENGINE_DIR defaults to ../lascodia-trading-engine
 *   ENGINE_DIR=/path/to/engine npm run docs:api
 *   npm run docs:api:check           # exit 1 when the copy differs (CI)
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const engine = resolve(root, process.env.ENGINE_DIR ?? '../lascodia-trading-engine');
const source = join(engine, 'docs/api/api-reference.json');
const target = join(root, 'public/docs-content/api-reference.json');
const check = process.argv.includes('--check');

if (!existsSync(source)) {
  console.error(`No API reference at ${source} (set ENGINE_DIR to the engine checkout).`);
  process.exit(check ? 1 : 2);
}
const fresh = readFileSync(source, 'utf8');
JSON.parse(fresh); // refuse to copy a broken file
const current = existsSync(target) ? readFileSync(target, 'utf8') : null;
if (check) {
  if (current !== fresh) {
    console.error('public/docs-content/api-reference.json is out of date: run npm run docs:api');
    process.exit(1);
  }
  console.log('API reference is current.');
} else {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, fresh);
  console.log(`Copied ${source} → public/docs-content/api-reference.json`);
}
