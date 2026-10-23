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

/**
 * Recorded REAL CME data (cme-tier2): Databento GLBX.MDP3 6EM6 MBP-10 + trades, 2026-06-05 12:29:37-12:30:01 UTC (into
 * the US payrolls release), replayed by lascodia-cme-feed's live code path into its local test sink — the C3 `md/ingest`
 * requests it captured, merged: 899 book events starting at an `S`, 99 trades, 133 BBO ticks. Raw futures prices,
 * sizes in contracts. Spec-only.
 */
export interface MdCmeFixture {
  source: string;
  sourceId: string;
  symbol: string;
  book: MdBookEventWire[];
  trades: { t: number[]; p: number[]; s: number[]; side: string[]; id: string[] };
  ticks: Required<MdTicksWire>;
}

export function loadCmeFixture(): MdCmeFixture {
  return JSON.parse(readFileSync(join(__dirname, 'md-cme-6e-fixture.json'), 'utf8')) as MdCmeFixture;
}
