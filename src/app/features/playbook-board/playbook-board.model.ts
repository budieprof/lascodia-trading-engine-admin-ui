import type { ScreenerRow } from '@features/scripting/api/scripting-api.types';

/**
 * The Playbook board: chart script #21 ("LLM Analyst Playbook") read on every pair at once through the
 * engine's script screener (`POST scripting/screener`), one row per pair in plain words.
 *
 * The script marks its reading plots (decision, classes, biases, regime, veto mask…) and a `close` plot for the
 * screener (`display.data_window + display.pine_screener`), so the page runs it by id (`chartScriptId`): no source
 * is sent. Display flags only say where a value is shown; they change no call.
 */

/** The engine chart script ("My scripts") the board runs. */
export const PLAYBOOK_SCRIPT_ID = 21;

/** The close the board measures distances from (script #21's screener-only `close` plot). */
export const CLOSE_PLOT = 'close';

/** Plot titles the board reads (verified against the screener's answer on 2026-11-24, script revision f84d1099). */
export const PLOT = {
  decision: 'decision',
  module: 'module',
  positionModule: 'position module',
  middle: 'middle',
  bestLong: 'Best long',
  bestShort: 'Best short',
  bestLongClass: 'best long class',
  bestShortClass: 'best short class',
  bestLongVisits: 'best long visits',
  bestLongHeld: 'best long held',
  bestShortVisits: 'best short visits',
  bestShortHeld: 'best short held',
  watchLong: 'Watch long',
  watchShort: 'Watch short',
  watchLongState: 'watch long state',
  watchShortState: 'watch short state',
  entry: 'Entry',
  planStop: 'plan stop',
  planTarget: 'plan target',
  planR: 'plan R',
  topLongLevel: 'top long level',
  topShortLevel: 'top short level',
  vetoMask: 'veto mask',
  d1Bias: 'D1 bias',
  h4Bias: 'H4 bias',
  regime: 'regime',
  /** Held-back setups resolved recently: not plotted by the script today — shown when a later version adds them. */
  heldR: 'held R',
  heldN: 'held n',
} as const;

/**
 * The source the screener runs: every data-window plot also on the screener, plus the close. Idempotent.
 */

/** What the board needs to know about a symbol to price distances: the pip (or point / tick) and the quote decimals. */
export interface DistanceFacts {
  /** One display-distance unit in price (a pip for FX). */
  unit: number;
  /** `pips`, `points`, `ticks`… */
  label: string;
  /** Quote decimals. */
  digits: number;
}

export type CallKind = 'trade' | 'in-trade' | 'watch' | 'hold' | 'error';

export interface LevelView {
  price: number;
  priceText: string;
  /** Distance from the close in the symbol's unit (pips…); null when the close is unknown. */
  distance: number | null;
  distanceText: string;
  /** reliable / mixed / weak from its visits; else the class word (strong / respected / tested / broken). */
  quality: string;
  /** "held 5/8" — null when the script reported no visits. */
  heldText: string | null;
  /** Price often goes through it: under 40% held on 3+ visits, or classed broken. */
  weak: boolean;
}

export interface BoardRow {
  symbol: string;
  error: string | null;
  lastBarTimeMs: number | null;
  close: number | null;
  callKind: CallKind;
  /** The call in plain words: "TRADE NOW · BUY at 1.0950", "WATCH SELL at 87.365", "HOLD". */
  call: string;
  /** Stop, target and R of a trade-now call; the order-resting note of a watch. */
  callDetail: string | null;
  /** Short: "mid-range", "at buy level", "at sell level", "wait for the sell level", "trade now", "in a trade"… */
  next: string;
  /** Why a setup was held back (the script's safety rules), when it was. */
  heldBack: string | null;
  buy: LevelView | null;
  sell: LevelView | null;
  trend: string;
  regime: string;
  /** Held-back setups resolved recently ("3 resolved · +1.2R") — null when the script does not report them. */
  heldResolved: string | null;
  /** Sort keys: actionable first, then nearest to a level (relative to price, so pairs compare fairly). */
  rank: number;
  nearness: number;
}

const RANK: Record<CallKind, number> = { trade: 0, 'in-trade': 1, watch: 2, hold: 3, error: 4 };

/** The script's veto bits, in order (`l8_vetoText`). */
const VETO_REASONS = [
  'price is in the middle of its range',
  'a High-impact news release is due before the order expires',
  'less than 4 h since a High-impact release',
  'weekend window (Fri 12:00 – Sun 22:00 UTC)',
  'this level has failed too often lately',
  'against the trend with no reversal sign and no trigger',
  'price is at a range extreme',
  'the entry is too far from the level',
  'this kind of level rarely holds',
  'order flow (net buying vs selling) disagrees',
  'London open: waits for a second confirming close',
  'the trend is too strong to fade (ADX above 35)',
  'thin, quiet session',
  'sellers / buyers are taking over against it',
  'the US dollar index (DXY) disagrees',
  'reward too small for the risk',
  'stop too tight for normal price noise',
  'a High-impact release is due before the target can be reached',
  'no valid stop and target',
] as const;

export function vetoReasons(mask: number | null | undefined): string[] {
  if (mask == null || !Number.isFinite(mask) || mask <= 0) return [];
  const out: string[] = [];
  for (let i = 0; i < VETO_REASONS.length; i++)
    if (Math.floor(mask / 2 ** i) % 2 === 1) out.push(VETO_REASONS[i]);
  return out;
}

/** The script's `l8_trendPhrase`. */
export function trendPhrase(d1: number | null, h4: number | null): string {
  const d = Math.sign(d1 ?? 0);
  const h = Math.sign(h4 ?? 0);
  if (d1 == null && h4 == null) return '—';
  if (d !== 0 && h === d) return d === 1 ? 'Uptrend (daily & 4h)' : 'Downtrend (daily & 4h)';
  if (d !== 0 && h === 0) return d === 1 ? 'Daily up, 4h pausing' : 'Daily down, 4h pausing';
  if (d !== 0) return d === 1 ? 'Daily up, 4h pulling back' : 'Daily down, 4h bouncing';
  if (h !== 0) return `No daily trend, 4h ${h === 1 ? 'up' : 'down'}`;
  return 'No trend (daily & 4h sideways)';
}

/** The `regime` plot (1 Trending … 6 Crisis) in the script's words. */
export function regimePhrase(code: number | null): string {
  switch (code) {
    case 1:
      return 'Trending: strong one-way moves';
    case 2:
      return 'Ranging: choppy, range-bound';
    case 3:
      return 'Low volatility: quiet';
    case 4:
      return 'High volatility';
    case 5:
      return 'Breaking out';
    case 6:
      return 'Crisis: extremely volatile';
    default:
      return 'Unclear';
  }
}

/** The script's `l8_cls`. */
export function classWord(cls: number | null): string {
  switch (cls) {
    case 3:
      return 'strong';
    case 2:
      return 'respected';
    case 1:
      return 'tested';
    case -1:
      return 'broken';
    default:
      return 'untested';
  }
}

/** The script's `l8_qual` once a level has 3+ visits; below that the class word says more. */
export function levelQuality(
  cls: number | null,
  held: number | null,
  visits: number | null,
): string {
  if (visits != null && held != null && visits >= 3) {
    const rate = held / visits;
    return rate >= 0.6 ? 'reliable' : rate >= 0.4 ? 'mixed' : 'weak';
  }
  return classWord(cls);
}

export function formatPrice(price: number | null, digits: number | null): string {
  if (price == null || !Number.isFinite(price)) return '—';
  return digits != null && digits >= 0 && digits <= 10 ? price.toFixed(digits) : String(price);
}

const num = (values: Record<string, number | null>, key: string): number | null => {
  const v = values[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
};

function level(
  price: number | null,
  close: number | null,
  cls: number | null,
  held: number | null,
  visits: number | null,
  facts: DistanceFacts | null,
  side: 'below' | 'above',
): LevelView | null {
  if (price == null) return null;
  const distance =
    close != null && facts && facts.unit > 0 ? Math.abs(price - close) / facts.unit : null;
  const quality = levelQuality(cls, held, visits);
  return {
    price,
    priceText: formatPrice(price, facts?.digits ?? null),
    distance,
    distanceText: distance == null ? '' : `${distance.toFixed(1)} ${facts!.label} ${side}`,
    quality,
    heldText: visits != null && visits > 0 && held != null ? `held ${held}/${visits}` : null,
    weak: quality === 'weak' || quality === 'broken',
  };
}

const relDistance = (price: number | null, close: number | null): number =>
  price != null && close != null && close !== 0
    ? Math.abs(price - close) / Math.abs(close)
    : Infinity;

/** One screener row → one board row. `facts` null = distances unknown (prices still shown). */
export function mapRow(row: ScreenerRow, facts: DistanceFacts | null): BoardRow {
  const symbol = row.symbol;
  if (row.error) {
    return {
      symbol,
      error: row.error,
      lastBarTimeMs: row.lastBarTimeMs ?? null,
      close: null,
      callKind: 'error',
      call: 'NO READING',
      callDetail: null,
      next: '—',
      heldBack: null,
      buy: null,
      sell: null,
      trend: '—',
      regime: '—',
      heldResolved: null,
      rank: RANK.error,
      nearness: Infinity,
    };
  }
  const v = row.values ?? {};
  const digits = facts?.digits ?? null;
  const px = (p: number | null) => formatPrice(p, digits);
  const close = num(v, CLOSE_PLOT);
  const decision = num(v, PLOT.decision) ?? 0;
  const posMod = num(v, PLOT.positionModule) ?? 0;
  const middle = num(v, PLOT.middle) === 1;

  const bestLong = num(v, PLOT.bestLong);
  const bestShort = num(v, PLOT.bestShort);
  const buy = level(
    bestLong,
    close,
    num(v, PLOT.bestLongClass),
    num(v, PLOT.bestLongHeld),
    num(v, PLOT.bestLongVisits),
    facts,
    'below',
  );
  const sell = level(
    bestShort,
    close,
    num(v, PLOT.bestShortClass),
    num(v, PLOT.bestShortHeld),
    num(v, PLOT.bestShortVisits),
    facts,
    'above',
  );

  const watchLong = num(v, PLOT.watchLong) ?? num(v, PLOT.topLongLevel) ?? bestLong;
  const watchShort = num(v, PLOT.watchShort) ?? num(v, PLOT.topShortLevel) ?? bestShort;
  const resting = (state: number | null) => (state === 2 ? 'order resting at the level' : null);

  let callKind: CallKind;
  let call: string;
  let callDetail: string | null = null;
  let target: number | null = null;
  if (decision === 1 || decision === -1) {
    const buySide = decision === 1;
    const entry =
      num(v, PLOT.entry) ?? num(v, buySide ? PLOT.topLongLevel : PLOT.topShortLevel) ?? close;
    callKind = 'trade';
    call = `TRADE NOW · ${buySide ? 'BUY' : 'SELL'}${entry != null ? ` at ${px(entry)}` : ''}`;
    const stop = num(v, PLOT.planStop);
    const tgt = num(v, PLOT.planTarget);
    const r = num(v, PLOT.planR);
    const parts = [
      stop != null ? `exit ${px(stop)} if wrong` : null,
      tgt != null ? `profit at ${px(tgt)}` : null,
      r != null ? `${r.toFixed(1)}R` : null,
    ].filter((p): p is string => p !== null);
    callDetail = parts.length ? parts.join(' · ') : null;
    target = entry;
  } else if (decision === 2 || decision === -2) {
    const buySide = decision === 2;
    const at = buySide ? watchLong : watchShort;
    callKind = 'watch';
    call = `WATCH · ${buySide ? 'BUY' : 'SELL'}${at != null ? ` at ${px(at)}` : ''}`;
    callDetail = resting(num(v, buySide ? PLOT.watchLongState : PLOT.watchShortState));
    target = at;
  } else if (decision === 3) {
    callKind = 'watch';
    call = `WATCH · BOTH SIDES · buy at ${px(watchLong)}, sell at ${px(watchShort)}`;
    const notes = [
      resting(num(v, PLOT.watchLongState)) ? 'buy order resting' : null,
      resting(num(v, PLOT.watchShortState)) ? 'sell order resting' : null,
    ].filter((p): p is string => p !== null);
    callDetail = notes.length ? notes.join(' · ') : null;
    target =
      relDistance(watchLong, close) <= relDistance(watchShort, close) ? watchLong : watchShort;
  } else if (posMod !== 0) {
    callKind = 'in-trade';
    const entry = num(v, PLOT.entry);
    call = `IN A TRADE · ${posMod > 0 ? 'BUY' : 'SELL'}${entry != null ? ` from ${px(entry)}` : ''}`;
    callDetail = 'a virtual trade the indicator follows';
  } else {
    callKind = 'hold';
    call = 'HOLD';
  }

  const reasons = vetoReasons(num(v, PLOT.vetoMask));
  const heldBack =
    (callKind === 'hold' || callKind === 'watch') && reasons.length ? reasons.join('; ') : null;

  let next: string;
  if (callKind === 'in-trade') next = 'in a trade';
  else if (callKind === 'trade') next = 'trade now';
  else if (decision === 2) next = 'wait for the buy level';
  else if (decision === -2) next = 'wait for the sell level';
  else if (decision === 3) next = 'wait for either level';
  else if (middle) next = 'mid-range';
  else if (buy == null && sell == null) next = 'no level in reach';
  else if (
    sell == null ||
    (buy != null && relDistance(buy.price, close) <= relDistance(sell.price, close))
  )
    next = 'at buy level';
  else next = 'at sell level';

  const heldR = num(v, PLOT.heldR);
  const heldN = num(v, PLOT.heldN);
  const heldResolved =
    heldN != null && heldN > 0
      ? `${heldN} resolved${heldR != null ? ` · ${heldR >= 0 ? '+' : ''}${heldR.toFixed(1)}R` : ''}`
      : heldN === 0
        ? 'none resolved'
        : null;

  const nearness =
    target != null
      ? relDistance(target, close)
      : Math.min(relDistance(bestLong, close), relDistance(bestShort, close));

  return {
    symbol,
    error: null,
    lastBarTimeMs: row.lastBarTimeMs ?? null,
    close,
    callKind,
    call,
    callDetail,
    next,
    heldBack,
    buy,
    sell,
    trend: trendPhrase(num(v, PLOT.d1Bias), num(v, PLOT.h4Bias)),
    regime: regimePhrase(num(v, PLOT.regime)),
    heldResolved,
    rank: RANK[callKind],
    nearness,
  };
}

/** Actionable first (trade now, in a trade, watch, hold, no reading), then nearest to a level, then by name. */
export function sortRows(rows: readonly BoardRow[]): BoardRow[] {
  return [...rows].sort(
    (a, b) =>
      a.rank - b.rank ||
      (a.nearness === b.nearness ? 0 : a.nearness < b.nearness ? -1 : 1) ||
      a.symbol.localeCompare(b.symbol),
  );
}

/** Timeframes the board offers (the screener's names) and their chart resolutions. */
export const BOARD_TIMEFRAMES: ReadonlyArray<{ value: string; label: string; ms: number }> = [
  { value: 'M15', label: '15m', ms: 15 * 60_000 },
  { value: 'H1', label: '1h', ms: 60 * 60_000 },
  { value: 'H4', label: '4h', ms: 4 * 60 * 60_000 },
  { value: 'D1', label: '1D', ms: 24 * 60 * 60_000 },
];

const FIFTEEN_MIN = 15 * 60_000;

/**
 * Should the timer re-read the board now? The screener reads the last CLOSED bar, so a re-read before the next
 * bar closes returns the same reading for a whole run of the script on every pair. Due once a newer bar should
 * have closed (`lastBarMs` is the open of the bar read: its successor closes at + 2 bars), and at most every
 * 15 minutes (or every bar, if shorter) while the market is shut and no newer bar arrives.
 */
export function refreshDue(
  nowMs: number,
  lastRunMs: number | null,
  lastBarMs: number | null,
  tfMs: number,
): boolean {
  if (lastRunMs == null) return true;
  const sinceRun = nowMs - lastRunMs;
  if (lastBarMs == null) return sinceRun >= FIFTEEN_MIN;
  return nowMs >= lastBarMs + 2 * tfMs && sinceRun >= Math.min(tfMs, FIFTEEN_MIN);
}
