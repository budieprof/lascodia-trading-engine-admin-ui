import { Injectable, inject } from '@angular/core';
import { CandleFeedService, type Bar } from '../datafeed/candle-feed.service';
import { foldBars, lastCompleteBarTime } from '../datafeed/aggregate';
import type { TvResolution } from '../datafeed/resolution';
import { technicalRating, type TechnicalRating } from './technicals';

/** TradingView's Technicals tabs, in its order. */
export const TECHNICALS_TIMEFRAMES: readonly { id: TvResolution; label: string }[] = [
  { id: '1', label: '1 minute' },
  { id: '5', label: '5 minutes' },
  { id: '15', label: '15 minutes' },
  { id: '30', label: '30 minutes' },
  { id: '60', label: '1 hour' },
  { id: '120', label: '2 hours' },
  { id: '240', label: '4 hours' },
  { id: '1D', label: '1 day' },
  { id: '1W', label: '1 week' },
  { id: '1M', label: '1 month' },
];

/**
 * One fetch per STORED timeframe; the tabs the engine does not store are
 * folded from the nearest one rather than fetched again (`getBars('1W')` would
 * re-download the same D1 rows the `1D` tab already has). Counts leave room for
 * SMA/EMA 200 plus warm-up; the engine holds less D1 than that for most
 * symbols, and rows it cannot fill simply show no value.
 */
const FETCHES: readonly { resolution: TvResolution; count: number; derive: TvResolution[] }[] = [
  { resolution: '1', count: 400, derive: [] },
  { resolution: '5', count: 400, derive: [] },
  { resolution: '15', count: 800, derive: ['30'] },
  { resolution: '60', count: 800, derive: ['120'] },
  { resolution: '240', count: 400, derive: [] },
  { resolution: '1D', count: 5000, derive: ['1W', '1M'] },
];

const HOUR = 3_600_000;
/**
 * Tabs whose forming bar can be folded from whole closed H1 bars — every one of
 * their bucket edges is an hour edge. A forming day is then ≤ 23 H1 rows plus
 * the minutes of the current hour, instead of up to two days of M1.
 */
const HOURLY: ReadonlySet<TvResolution> = new Set(['120', '240', '1D', '1W', '1M']);
/** M1 for forming bars is fetched only when that recent: the market is trading. */
const MINUTES_WINDOW_MS = 3 * HOUR;

export interface TimeframeTechnicals {
  resolution: TvResolution;
  barCount: number;
  /** Open time of the newest bar rated, UTC ms; null with no bars. */
  lastTime: number | null;
  lastClose: number | null;
  rating: TechnicalRating;
}

export interface SymbolTechnicals {
  symbol: string;
  frames: Record<TvResolution, TimeframeTechnicals>;
  /** Daily bars, ascending, today's forming one included — the pivots' source. */
  daily: Bar[];
}

interface FormingPlan {
  id: TvResolution;
  /** Bars at or before this are stored history and stay as they are. */
  stored: number;
  /** Closed H1 bars after `stored` that fall in the forming bucket(s). */
  hourly: Bar[];
  /** M1 bars from here on complete the forming bar. */
  minuteFloor: number;
}

function derived(fetched: Partial<Record<TvResolution, Bar[]>>): Record<TvResolution, Bar[]> {
  const out: Record<TvResolution, Bar[]> = {};
  for (const f of FETCHES) {
    const source = fetched[f.resolution] ?? [];
    out[f.resolution] = source;
    for (const d of f.derive) out[d] = foldBars(source, d);
  }
  return out;
}

function formingPlans(frames: Record<TvResolution, Bar[]>): FormingPlan[] {
  const h1 = frames['60'] ?? [];
  const plans: FormingPlan[] = [];
  for (const { id } of TECHNICALS_TIMEFRAMES) {
    const bars = frames[id];
    // M1 is its own forming source: the engine stores every closed minute.
    if (id === '1' || !bars?.length) continue;
    const stored = lastCompleteBarTime(bars, id);
    if (stored === null) continue;
    if (HOURLY.has(id)) {
      // A forming bucket folded from H1 that starts after the bucket does is a partial bar
      // passed off as whole (a month's open taken from its last few weeks). Keep the stored one.
      if (!h1.length || h1[0].time > stored + 1) continue;
      const hourly = h1.filter((b) => b.time > stored);
      const tail = hourly[hourly.length - 1];
      plans.push({ id, stored, hourly, minuteFloor: tail ? tail.time + HOUR : stored + 1 });
    } else {
      plans.push({ id, stored, hourly: [], minuteFloor: stored + 1 });
    }
  }
  return plans;
}

/**
 * Where to start the one M1 fetch that completes every tab's forming bar, or
 * null when no tab's bar can still be forming (the market is shut, or the data
 * is stale) — a weekend must not pull two days of minutes on every refresh.
 */
export function minutesNeededSince(
  fetched: Partial<Record<TvResolution, Bar[]>>,
  nowMs: number,
): number | null {
  const floors = formingPlans(derived(fetched))
    .map((p) => p.minuteFloor)
    .filter((f) => nowMs - f <= MINUTES_WINDOW_MS);
  return floors.length ? Math.min(...floors) : null;
}

/**
 * Bars for every Technicals tab from the stored-timeframe fetches: derive the
 * folded tabs, then rebuild each tab's still-forming bar from closed H1 bars
 * plus `minutes` — the engine stores a bar only once it has closed, and
 * TradingView rates the forming one. Pure, so it is tested without HTTP.
 */
export function assembleFrames(
  fetched: Partial<Record<TvResolution, Bar[]>>,
  minutes: { since: number; bars: readonly Bar[] } | null,
): Record<TvResolution, Bar[]> {
  const out = derived(fetched);
  for (const p of formingPlans(out)) {
    // Minutes fetched from later than this tab needs would make its first bucket partial.
    const mins = minutes && minutes.since <= p.minuteFloor ? minutes.bars : [];
    const fresh = [...p.hourly, ...mins.filter((m) => m.time >= p.minuteFloor)];
    if (!fresh.length) continue;
    // Not mergeForming(): that treats bars past `stored` as live ticks whose close wins, but
    // here they are partial buckets folded from CLOSED source bars only — a week built from
    // D1 ends at yesterday's close. The fold below rebuilds each forming bucket whole.
    const forming = foldBars(fresh, p.id).filter((b) => b.time > p.stored);
    out[p.id] = [...out[p.id].filter((b) => b.time <= p.stored), ...forming];
  }
  return out;
}

/**
 * Technical ratings for one symbol across all of TradingView's tabs at once,
 * which is what lets the tab strip show every timeframe's verdict side by side.
 */
@Injectable({ providedIn: 'root' })
export class TechnicalsService {
  private readonly feed = inject(CandleFeedService);

  async load(symbol: string): Promise<SymbolTechnicals> {
    const now = Date.now();
    const results = await Promise.all(
      FETCHES.map((f) =>
        this.feed
          .getBars(symbol, f.resolution, 0, now, f.count)
          .then((r) => r.bars)
          .catch(() => [] as Bar[]),
      ),
    );
    const fetched: Partial<Record<TvResolution, Bar[]>> = {};
    FETCHES.forEach((f, i) => (fetched[f.resolution] = results[i]));

    const since = minutesNeededSince(fetched, now);
    const minuteBars = since === null ? null : await this.feed.minuteBarsSince(symbol, since);
    const bars = assembleFrames(
      fetched,
      since !== null && minuteBars ? { since, bars: minuteBars } : null,
    );

    const frames: Record<TvResolution, TimeframeTechnicals> = {};
    for (const { id } of TECHNICALS_TIMEFRAMES) {
      const b = bars[id] ?? [];
      const tail = b[b.length - 1];
      frames[id] = {
        resolution: id,
        barCount: b.length,
        lastTime: tail?.time ?? null,
        lastClose: tail?.close ?? null,
        rating: technicalRating(b),
      };
    }
    return { symbol, frames, daily: bars['1D'] ?? [] };
  }
}
