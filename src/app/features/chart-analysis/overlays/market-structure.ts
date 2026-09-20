import { atr, type Ohlc } from '../indicators/math';
import { profileWithValueArea } from './analysis-overlays';

/**
 * Market structure read off the bars: the current balance range, the value area, the stop
 * pools either side of it, and the structural events that formed it.
 *
 * <p>The vocabulary deliberately matches `price-annotations.ts` — `structure` / `value` /
 * `pool` levels, `balance` / `value` / `pool` zones, and markers — so that what the operator
 * toggles on the live chart is the same set of concepts the assistant draws in chat. Two
 * different names for the same idea across two surfaces is how a console stops being one
 * tool.</p>
 *
 * <p>Everything is derived from OHLCV. The stop pools are the one INFERRED element: nobody
 * publishes where stops rest, so they are the conventional read — just beyond the range that
 * everyone can see — and are labelled as estimated wherever they are drawn.</p>
 */

export type StructureLevelKind = 'structure' | 'value' | 'pool' | 'live';
export type StructureZoneKind = 'balance' | 'value' | 'pool';

export interface StructureLevel {
  price: number;
  label: string;
  kind: StructureLevelKind;
}

export interface StructureZone {
  from: number;
  to: number;
  label: string;
  kind: StructureZoneKind;
}

export interface StructureMarker {
  time: number;
  price: number;
  label: string;
  kind: 'climax' | 'spring' | 'upthrust';
}

export interface MarketStructure {
  levels: StructureLevel[];
  zones: StructureZone[];
  markers: StructureMarker[];
  /** One line describing the balance, or null when price is not balancing. */
  summary: string | null;
}

export interface StructureOptions {
  /**
   * A balance ends when the running range exceeds this many ATR.
   *
   * <p>6 by default, calibrated against a real read: a 43-pip range over 48 EURUSD H1 bars,
   * against an ATR of roughly 8 pips. 2.5 was the first guess and found nothing at all —
   * consolidations are wider than they feel.</p>
   */
  balanceAtr?: number;
  /** Fewest bars that count as a balance rather than a pause. */
  minBalanceBars?: number;
  /** A climax bar's range and volume must both exceed this multiple of their averages. */
  climaxMult?: number;
  /** How far beyond the range stops are assumed to rest, in ATR. */
  poolAtr?: number;
}

/** Pip size for the label — 0.0001 on most pairs, 0.01 on JPY crosses. */
function pipSize(price: number): number {
  return price < 20 ? 0.0001 : 0.01;
}

/**
 * The most recent balance: the stretch back from the last bar whose total range stays
 * inside `balanceAtr × ATR`.
 *
 * <p>Walking BACK from the newest bar rather than scanning for the widest quiet patch is
 * deliberate — the operator is asking "what is price doing now", and a beautiful balance
 * from three weeks ago does not answer that.</p>
 */
function findBalance(
  bars: readonly Ohlc[],
  atrValue: number,
  balanceAtr: number,
  minBars: number,
): { fromIndex: number; low: number; high: number } | null {
  const limit = atrValue * balanceAtr;
  if (limit <= 0) return null;

  let low = bars[bars.length - 1].low;
  let high = bars[bars.length - 1].high;
  let fromIndex = bars.length - 1;

  for (let i = bars.length - 2; i >= 0; i--) {
    const nextLow = Math.min(low, bars[i].low);
    const nextHigh = Math.max(high, bars[i].high);
    if (nextHigh - nextLow > limit) break;
    low = nextLow;
    high = nextHigh;
    fromIndex = i;
  }

  const bars_ = bars.length - fromIndex;
  return bars_ >= minBars ? { fromIndex, low, high } : null;
}

/** Rolling mean of the last `n` values, or null when there are too few. */
function meanOfLast(values: number[], n: number): number | null {
  if (values.length < n || n <= 0) return null;
  let sum = 0;
  for (let i = values.length - n; i < values.length; i++) sum += values[i];
  return sum / n;
}

export function marketStructure(
  bars: readonly Ohlc[],
  opts: StructureOptions = {},
): MarketStructure {
  const empty: MarketStructure = { levels: [], zones: [], markers: [], summary: null };
  if (bars.length < 30) return empty;

  const atrSeries = atr(bars as Ohlc[], 14);
  const atrValue = [...atrSeries].reverse().find((v) => v !== null && v > 0) ?? null;
  // No ATR means no scale, and every threshold below is expressed in it. Saying nothing
  // beats drawing a balance whose width was picked arbitrarily.
  if (atrValue === null) return empty;

  const levels: StructureLevel[] = [];
  const zones: StructureZone[] = [];
  const markers: StructureMarker[] = [];

  // ── Value area ───────────────────────────────────────────────────────────
  const profile = profileWithValueArea(bars);
  if (profile) {
    zones.push({
      from: profile.valueAreaLow,
      to: profile.valueAreaHigh,
      label: 'Value area — ~70% of volume',
      kind: 'value',
    });
    levels.push(
      { price: profile.valueAreaHigh, label: 'VAH', kind: 'value' },
      { price: profile.poc, label: 'POC', kind: 'value' },
      { price: profile.valueAreaLow, label: 'VAL', kind: 'value' },
    );
  }

  // ── Balance, stop pools, and the events inside it ────────────────────────
  const balance = findBalance(bars, atrValue, opts.balanceAtr ?? 6, opts.minBalanceBars ?? 12);

  let summary: string | null = null;
  if (balance) {
    const span = balance.high - balance.low;
    const pips = Math.round(span / pipSize(balance.high));
    const count = bars.length - balance.fromIndex;
    zones.push({
      from: balance.low,
      to: balance.high,
      label: `Balance — ${pips} pips, ${count} bars`,
      kind: 'balance',
    });
    levels.push(
      { price: balance.high, label: 'Range high', kind: 'structure' },
      { price: balance.low, label: 'Range low', kind: 'structure' },
    );

    // Where stops are ASSUMED to rest: just beyond the range everyone can see. Nobody
    // publishes this, so the label says so wherever it is drawn.
    const pool = atrValue * (opts.poolAtr ?? 0.4);
    zones.push(
      { from: balance.high, to: balance.high + pool, label: 'Stop pool (est.)', kind: 'pool' },
      { from: balance.low - pool, to: balance.low, label: 'Stop pool (est.)', kind: 'pool' },
    );

    summary =
      `Balancing ${pips} pips over ${count} bars, ` +
      `${balance.low.toFixed(5)}–${balance.high.toFixed(5)}.`;

    // A spring undercuts the range low and closes back inside; an upthrust is the mirror.
    // Both are only meaningful relative to the range they broke, which is why they are
    // found here rather than as a standalone scan.
    //
    // Only the DEEPEST of each is kept. A stair-step lower marks four bars that each
    // undercut the running low, and labelling all four says the range was tested four times
    // when it was tested once and then extended. The extreme is the one an operator means.
    let spring: StructureMarker | null = null;
    let upthrust: StructureMarker | null = null;
    for (let i = balance.fromIndex + 1; i < bars.length; i++) {
      let priorLow = Infinity;
      let priorHigh = -Infinity;
      for (let k = balance.fromIndex; k < i; k++) {
        priorLow = Math.min(priorLow, bars[k].low);
        priorHigh = Math.max(priorHigh, bars[k].high);
      }
      if (bars[i].low < priorLow && bars[i].close > priorLow) {
        if (!spring || bars[i].low < spring.price) {
          spring = {
            time: bars[i].time,
            price: bars[i].low,
            label: `Spring ${bars[i].low.toFixed(5)}`,
            kind: 'spring',
          };
        }
      } else if (bars[i].high > priorHigh && bars[i].close < priorHigh) {
        if (!upthrust || bars[i].high > upthrust.price) {
          upthrust = {
            time: bars[i].time,
            price: bars[i].high,
            label: `Upthrust ${bars[i].high.toFixed(5)}`,
            kind: 'upthrust',
          };
        }
      }
    }
    if (spring) markers.push(spring);
    if (upthrust) markers.push(upthrust);
  }

  // ── Climax bars ──────────────────────────────────────────────────────────
  // Outsized on BOTH range and volume. Range alone catches every news spike; volume alone
  // catches the open. The pair is what makes it a climax rather than a busy bar.
  const mult = opts.climaxMult ?? 2.5;
  const ranges = bars.map((b) => b.high - b.low);
  const volumes = bars.map((b) => b.volume);
  const window = Math.min(50, bars.length);
  for (let i = window; i < bars.length; i++) {
    const meanRange = meanOfLast(ranges.slice(0, i), window);
    const meanVolume = meanOfLast(volumes.slice(0, i), window);
    if (meanRange === null || meanVolume === null || meanRange <= 0 || meanVolume <= 0) continue;
    if (ranges[i] > meanRange * mult && volumes[i] > meanVolume * mult) {
      const down = bars[i].close < bars[i].open;
      const pips = Math.round(ranges[i] / pipSize(bars[i].high));
      markers.push({
        time: bars[i].time,
        price: down ? bars[i].low : bars[i].high,
        label: `${down ? 'Selling' : 'Buying'} climax — ${pips}p, ${Math.round(volumes[i] / 1000)}k vol`,
        kind: 'climax',
      });
    }
  }

  levels.push({
    price: bars[bars.length - 1].close,
    label: 'Last',
    kind: 'live',
  });

  return { levels, zones, markers, summary };
}
