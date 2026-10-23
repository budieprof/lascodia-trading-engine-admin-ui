import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { MdBookEventWire, MdTicksWire } from '../marketdata.types';

/**
 * Recorded REAL market data for tests (never synthesized): `md/history` for EURUSD from source `mt5-metaquotes-demo`
 * (one broker's MT5 DOM + ticks) on 2026-10-23, read-only — 150 consecutive book events starting at a snapshot, and
 * the ticks in the same 16 s. Spec-only (reads the file with node:fs).
 */
export interface MdFixture {
  sourceId: string;
  symbol: string;
  book: MdBookEventWire[];
  ticks: Required<MdTicksWire>;
}

export function loadMdFixture(): MdFixture {
  return JSON.parse(readFileSync(join(__dirname, 'md-eurusd-fixture.json'), 'utf8')) as MdFixture;
}
