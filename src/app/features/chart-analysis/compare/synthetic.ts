import type { Bar } from '../datafeed/candle-feed.service';

/**
 * US04: spread and ratio SYMBOLS — "EURUSD ÷ GBPUSD" as the main chart's series, with open, high, low
 * and close, built in the browser from the two legs' bars. And the join that builds them (and the
 * compare panes' ratio / spread / basket lines) across calendars: AS OF, not by exact time — BTC-USD
 * trades every hour, AAPL six and a half a day; an exact match kept only the hours both had a bar.
 *
 * Display only: no instrument the engine knows, so no order, alert, order flow or script runs on it.
 */

export interface SyntheticSpec {
  kind: 'ratio' | 'spread';
  /** Engine symbols, upper case. */
  a: string;
  b: string;
  /** spread: A − mult × B. */
  mult: number;
}

const LEG = /^[A-Z0-9._!-]{1,24}$/;

/** The synthetic's symbol: `RATIO(EURUSD,GBPUSD)`, `SPREAD(EURUSD,GBPUSD)`, `SPREAD(EURUSD,GBPUSD,1.2)`. */
export function syntheticSymbol(spec: SyntheticSpec): string {
  const name = spec.kind === 'ratio' ? 'RATIO' : 'SPREAD';
  const mult = spec.kind === 'spread' && spec.mult !== 1 ? `,${spec.mult}` : '';
  return `${name}(${spec.a},${spec.b}${mult})`;
}

/** The spec of a synthetic symbol; null for any other symbol (every real one). */
export function parseSynthetic(symbol: string | null | undefined): SyntheticSpec | null {
  const m = /^(RATIO|SPREAD)\(([^,()]+),([^,()]+)(?:,([^,()]+))?\)$/i.exec((symbol ?? '').trim());
  if (!m) return null;
  const kind = m[1].toUpperCase() === 'RATIO' ? 'ratio' : 'spread';
  const a = m[2].trim().toUpperCase();
  const b = m[3].trim().toUpperCase();
  if (!LEG.test(a) || !LEG.test(b) || a === b) return null;
  if (kind === 'ratio' && m[4] !== undefined) return null;
  const mult = m[4] === undefined ? 1 : Number(m[4]);
  if (!Number.isFinite(mult) || mult === 0) return null;
  return { kind, a, b, mult };
}

/** "EURUSD ÷ GBPUSD", "EURUSD − 1.2 × GBPUSD". */
export function syntheticTitle(spec: SyntheticSpec): string {
  return spec.kind === 'ratio'
    ? `${spec.a} ÷ ${spec.b}`
    : `${spec.a} − ${spec.mult === 1 ? '' : `${spec.mult} × `}${spec.b}`;
}

/** The synthetic's value from the legs' prices; null where a ratio's divisor is zero. */
export function combine(spec: SyntheticSpec, a: number, b: number): number | null {
  if (spec.kind === 'ratio') return b === 0 ? null : a / b;
  return a - spec.mult * b;
}

/** One time of an as-of join: each leg's bar there — or, where it has none, its last bar before. */
export interface AsOfRow<T extends { time: number }> {
  time: number;
  legs: T[];
  /** Per leg: it had no bar at this time and holds its last one. */
  carried: boolean[];
}

/**
 * The as-of join of ascending series: a row at every time any of them has, from the time they all
 * have started; each leg is its bar at that time or, where it has none (closed, a gap), its last
 * bar before it. On legs with the same times it is exactly the exact-time join.
 */
export function asOfJoin<T extends { time: number }>(legs: readonly (readonly T[])[]): AsOfRow<T>[] {
  if (!legs.length || legs.some((l) => l.length === 0)) return [];
  const start = Math.max(...legs.map((l) => l[0].time));
  const times = new Set<number>();
  for (const l of legs) for (const b of l) if (b.time >= start) times.add(b.time);
  const sorted = [...times].sort((x, y) => x - y);
  const idx = legs.map(() => 0);
  const out: AsOfRow<T>[] = [];
  for (const t of sorted) {
    const row: T[] = [];
    const carried: boolean[] = [];
    legs.forEach((l, k) => {
      while (idx[k] + 1 < l.length && l[idx[k] + 1].time <= t) idx[k]++;
      row.push(l[idx[k]]);
      carried.push(l[idx[k]].time !== t);
    });
    out.push({ time: t, legs: row, carried });
  }
  return out;
}

/** What a synthetic series is built from, for the chart's notice. */
export interface SyntheticBuild {
  bars: Bar[];
  /** Rows where each leg had no bar of its own and held its last close. */
  carriedA: number;
  carriedB: number;
  /** Rows dropped: a ratio over a zero (or crossing) divisor. */
  dropped: number;
  /** Each leg's newest close: the live price of the leg until it ticks. */
  lastA: number | null;
  lastB: number | null;
}

/** A leg as it was during a row: its bar, or — carried — flat at its last close. */
function legPrices(bar: Bar, carried: boolean): [number, number, number, number] {
  return carried ? [bar.close, bar.close, bar.close, bar.close] : [bar.open, bar.high, bar.low, bar.close];
}

/**
 * The synthetic's bars. Open and close from the legs' opens and closes. High and low BOUND the
 * synthetic over the bar: the extremes of the expression over the legs' highs and lows (A's high
 * over B's low for a ratio) — not prices it traded at. No volume (0): the volume pane is off for it.
 */
export function syntheticBars(spec: SyntheticSpec, a: readonly Bar[], b: readonly Bar[]): SyntheticBuild {
  const rows = asOfJoin([a, b]);
  const bars: Bar[] = [];
  let carriedA = 0;
  let carriedB = 0;
  let dropped = 0;
  for (const r of rows) {
    const [oa, ha, la, ca] = legPrices(r.legs[0], r.carried[0]);
    const [ob, hb, lb, cb] = legPrices(r.legs[1], r.carried[1]);
    const open = combine(spec, oa, ob);
    const close = combine(spec, ca, cb);
    const corners = [combine(spec, ha, hb), combine(spec, ha, lb), combine(spec, la, hb), combine(spec, la, lb)];
    // A divisor at or through zero inside the bar: the ratio is unbounded there, so the bar is left out.
    if (open === null || close === null || corners.some((c) => c === null) || (spec.kind === 'ratio' && lb <= 0 && hb >= 0)) {
      dropped++;
      continue;
    }
    const values = [open, close, ...(corners as number[])];
    if (r.carried[0]) carriedA++;
    if (r.carried[1]) carriedB++;
    const own = r.carried[0] ? r.legs[1] : r.legs[0];
    bars.push({
      time: r.time,
      open,
      high: Math.max(...values),
      low: Math.min(...values),
      close,
      volume: 0,
      ...(own.closeTime !== undefined ? { closeTime: own.closeTime } : {}),
    });
  }
  return {
    bars,
    carriedA,
    carriedB,
    dropped,
    lastA: a.at(-1)?.close ?? null,
    lastB: b.at(-1)?.close ?? null,
  };
}

/** The chart's notice for a synthetic series: what it is and where a leg's price was held. */
export function syntheticNotice(spec: SyntheticSpec, build: Pick<SyntheticBuild, 'carriedA' | 'carriedB' | 'dropped'>): string {
  const parts = [
    `${syntheticTitle(spec)} is built in the browser from both legs' bars: display only (no trading, alerts, order flow or scripts), no volume; high and low bound the bar from the legs' highs and lows.`,
  ];
  const held: string[] = [];
  if (build.carriedA) held.push(`${spec.a} on ${build.carriedA} bar${build.carriedA === 1 ? '' : 's'}`);
  if (build.carriedB) held.push(`${spec.b} on ${build.carriedB} bar${build.carriedB === 1 ? '' : 's'}`);
  if (held.length) parts.push(`Joined as of each bar: where a leg has no bar (it trades other hours) its last close is held — ${held.join(', ')}.`);
  if (build.dropped) parts.push(`${build.dropped} bar${build.dropped === 1 ? '' : 's'} left out: the divisor was zero.`);
  return parts.join(' ');
}

/**
 * Live prices of a synthetic main series: each leg's latest price (seeded from its newest close), the
 * synthetic's price whenever either leg moves.
 */
export class SyntheticTicks {
  private spec: SyntheticSpec | null = null;
  private a: number | null = null;
  private b: number | null = null;

  reset(spec: SyntheticSpec | null, lastA: number | null = null, lastB: number | null = null): void {
    this.spec = spec;
    this.a = lastA;
    this.b = lastB;
  }

  /** Whether `symbol` is a leg of the current synthetic. */
  isLeg(symbol: string): boolean {
    const s = this.spec;
    const sym = symbol.toUpperCase();
    return !!s && (sym === s.a || sym === s.b);
  }

  /** A leg's new price → the synthetic's price (null while the other leg is unknown, or a zero divisor). */
  price(symbol: string, price: number): number | null {
    const s = this.spec;
    if (!s) return null;
    const sym = symbol.toUpperCase();
    if (sym === s.a) this.a = price;
    else if (sym === s.b) this.b = price;
    else return null;
    return this.a === null || this.b === null ? null : combine(s, this.a, this.b);
  }
}
