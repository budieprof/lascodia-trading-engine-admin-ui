/**
 * Wire shapes of the public demonstration (engine enterprise onboarding, `docs/api/onboarding-api.md`
 * "Demo"): anonymous, read-only, RECORDED data replayed on a loop. Times are epoch milliseconds; every
 * row that carries a shown time `t` also carries the recorded time it came from.
 */

export interface DemoStatus {
  available: boolean;
  reason: string | null;
  /** Always true. */
  recorded: boolean;
  /** Always true. */
  noTrading: boolean;
  /** The banner every demo screen shows. */
  label: string;
  symbols: string[];
  recordedFromMs: number | null;
  recordedToMs: number | null;
  loopMinutes: number;
  nowMs: number;
  recordedNowMs: number | null;
  shiftMs: number | null;
  loopStartedAtMs: number | null;
  organisationSlug: string | null;
  organisationName: string | null;
}

export interface DemoBar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  ticks: number;
  recordedT: number;
  loopStart: boolean;
  forming: boolean;
}

export interface DemoCandles {
  symbol: string;
  sourceId: string;
  sourceName: string;
  label: string;
  nowMs: number;
  shiftMs: number;
  bars: DemoBar[];
  truncated: boolean;
}

export interface DemoTicks {
  symbol: string;
  nowMs: number;
  shiftMs: number;
  t: number[];
  rt: number[];
  b: number[];
  a: number[];
}

export interface DemoBook {
  symbol: string;
  nowMs: number;
  t: number | null;
  recordedT: number | null;
  sizeUnit: string;
  /** [price, size], best first. */
  bids: [number, number][];
  asks: [number, number][];
  note: string | null;
}
