import { Injectable, inject } from '@angular/core';
import { CandleFeedService, type Bar } from '../datafeed/candle-feed.service';
import { foldBars, lastCompleteBarTime } from '../datafeed/aggregate';
import type { TvResolution } from '../datafeed/resolution';
import { mergeSessionTail } from '../datafeed/session-bars';
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
 * The tabs on the stored grid (1m … 1h): one fetch per STORED timeframe, with `30` folded from M15
 * rather than fetched again, and each tab's forming bar folded from M1 — the engine stores a bar only
 * once it has closed. Counts leave room for SMA/EMA 200 plus warm-up.
 */
const STORED_FETCHES: readonly {
  resolution: TvResolution;
  count: number;
  derive: TvResolution[];
}[] = [
  { resolution: '1', count: 400, derive: [] },
  { resolution: '5', count: 400, derive: [] },
  { resolution: '15', count: 800, derive: ['30'] },
  { resolution: '60', count: 800, derive: [] },
];

/**
 * The tabs on the engine's session grid (2h … 1M, `scripting/chart-bars`): the 17:00 New York day,
 * Monday–Friday weeks and calendar months of trading days that TradingView rates and takes pivots
 * from, with the forming bar already built. Counts leave room for SMA/EMA 200 plus warm-up where the
 * history reaches; the engine's H1 starts in 2010, so a month asks for all of it.
 */
export const SESSION_FETCHES: readonly { resolution: TvResolution; count: number }[] = [
  { resolution: '120', count: 800 },
  { resolution: '240', count: 600 },
  { resolution: '1D', count: 1000 },
  { resolution: '1W', count: 400 },
  { resolution: '1M', count: 240 },
];

/**
 * How long a symbol's session-grid history is refreshed by its newest bars alone. The view reloads
 * every minute; years of weeks and months rebuilt from H1 on each reload would be the engine's
 * heaviest chart request, repeated for nothing. Past this the whole history is fetched again.
 */
const SESSION_HISTORY_TTL_MS = 15 * 60_000;
/** Symbols whose session history is kept for those refreshes. */
const SESSION_HISTORY_SYMBOLS = 8;

const HOUR = 3_600_000;
/** M1 for forming bars is fetched only when that recent: the market is trading. */
const MINUTES_WINDOW_MS = 3 * HOUR;

export interface TimeframeTechnicals {
  resolution: TvResolution;
  barCount: number;
  /** Open time of the newest bar rated, UTC ms; null with no bars. */
  lastTime: number | null;
  /** Its period's close on the session grid (2h … 1M), UTC ms; null on the stored grid. */
  lastCloseTime: number | null;
  lastClose: number | null;
  rating: TechnicalRating;
}

export interface SymbolTechnicals {
  symbol: string;
  frames: Record<TvResolution, TimeframeTechnicals>;
  /** Session days (17:00 New York), ascending, the forming one included — daily pivots. */
  daily: Bar[];
  /** Weeks of session days, ascending — weekly pivots. */
  weekly: Bar[];
  /** Months of session days, ascending — monthly pivots, and yearly ones folded from them. */
  monthly: Bar[];
}

interface FormingPlan {
  id: TvResolution;
  /** Bars at or before this are stored history and stay as they are. */
  stored: number;
  /** M1 bars from here on complete the forming bar. */
  minuteFloor: number;
}

function derived(fetched: Partial<Record<TvResolution, Bar[]>>): Record<TvResolution, Bar[]> {
  const out: Record<TvResolution, Bar[]> = {};
  for (const f of STORED_FETCHES) {
    const source = fetched[f.resolution] ?? [];
    out[f.resolution] = source;
    for (const d of f.derive) out[d] = foldBars(source, d);
  }
  return out;
}

/** The stored-grid tabs whose forming bar M1 completes (M1 is its own: every closed minute is stored). */
function formingPlans(frames: Record<TvResolution, Bar[]>): FormingPlan[] {
  const plans: FormingPlan[] = [];
  for (const id of Object.keys(frames)) {
    const bars = frames[id];
    if (id === '1' || !bars?.length) continue;
    const stored = lastCompleteBarTime(bars, id);
    if (stored === null) continue;
    plans.push({ id, stored, minuteFloor: stored + 1 });
  }
  return plans;
}

/**
 * Where to start the one M1 fetch that completes every stored-grid tab's forming bar, or null when
 * no tab's bar can still be forming (the market is shut, or the data is stale) — a weekend must not
 * pull two days of minutes on every refresh.
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
 * Bars for every Technicals tab. The stored-grid tabs: derive `30`, then rebuild each tab's
 * still-forming bar from `minutes` — the engine stores a bar only once it has closed, and
 * TradingView rates the forming one. The session-grid tabs come as the engine built them, forming
 * bar included, and pass through untouched. Pure, so it is tested without HTTP.
 */
export function assembleFrames(
  fetched: Partial<Record<TvResolution, Bar[]>>,
  minutes: { since: number; bars: readonly Bar[] } | null,
): Record<TvResolution, Bar[]> {
  const out = derived(fetched);
  for (const p of formingPlans(out)) {
    // Minutes fetched from later than this tab needs would make its first bucket partial.
    const mins = minutes && minutes.since <= p.minuteFloor ? minutes.bars : [];
    const fresh = mins.filter((m) => m.time >= p.minuteFloor);
    if (!fresh.length) continue;
    // Not mergeForming(): that treats bars past `stored` as live ticks whose close wins, but
    // here they are partial buckets folded from CLOSED source bars only. The fold below rebuilds
    // each forming bucket whole.
    const forming = foldBars(fresh, p.id).filter((b) => b.time > p.stored);
    out[p.id] = [...out[p.id].filter((b) => b.time <= p.stored), ...forming];
  }
  for (const f of SESSION_FETCHES) out[f.resolution] = fetched[f.resolution] ?? [];
  return out;
}

/**
 * Technical ratings for one symbol across all of TradingView's tabs at once,
 * which is what lets the tab strip show every timeframe's verdict side by side.
 */
@Injectable({ providedIn: 'root' })
export class TechnicalsService {
  private readonly feed = inject(CandleFeedService);
  /** Each symbol's session-grid tabs from its last load, and when they were last fetched whole. */
  private readonly sessionHistory = new Map<
    string,
    { fullAt: number; frames: Partial<Record<TvResolution, Bar[]>> }
  >();

  async load(symbol: string): Promise<SymbolTechnicals> {
    const now = Date.now();
    const key = symbol.toUpperCase();
    const held = this.sessionHistory.get(key);
    const refresh = !!held && now - held.fullAt < SESSION_HISTORY_TTL_MS;

    const [stored, session] = await Promise.all([
      Promise.all(
        STORED_FETCHES.map((f) =>
          this.feed
            .getBars(symbol, f.resolution, 0, now, f.count)
            .then((r) => r.bars)
            .catch(() => [] as Bar[]),
        ),
      ),
      Promise.all(
        SESSION_FETCHES.map((f) =>
          this.sessionFrame(
            symbol,
            f.resolution,
            f.count,
            refresh ? held!.frames[f.resolution] : undefined,
          ),
        ),
      ),
    ]);
    const fetched: Partial<Record<TvResolution, Bar[]>> = {};
    STORED_FETCHES.forEach((f, i) => (fetched[f.resolution] = stored[i]));
    const sessionFrames: Partial<Record<TvResolution, Bar[]>> = {};
    SESSION_FETCHES.forEach(
      (f, i) => (fetched[f.resolution] = sessionFrames[f.resolution] = session[i]),
    );
    this.remember(key, refresh ? held!.fullAt : now, sessionFrames);

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
        lastCloseTime: tail?.closeTime ?? null,
        lastClose: tail?.close ?? null,
        rating: technicalRating(b),
      };
    }
    return {
      symbol,
      frames,
      daily: bars['1D'] ?? [],
      weekly: bars['1W'] ?? [],
      monthly: bars['1M'] ?? [],
    };
  }

  /**
   * One session-grid tab: its newest bars laid over `held` (the last load's, still fresh), or the
   * whole history when there is none, the newest ones did not come, or they do not reach back to the
   * held bars. Empty when nothing could be loaded.
   */
  private async sessionFrame(
    symbol: string,
    resolution: TvResolution,
    count: number,
    held: Bar[] | undefined,
  ): Promise<Bar[]> {
    if (held?.length) {
      const tail = await this.feed.sessionTail(symbol, resolution, held[held.length - 1].time);
      // The engine's bars replace the held ones outright: nothing here is moved by ticks.
      if (tail?.length && tail[0].time <= held[held.length - 1].time) {
        return mergeSessionTail(held, tail, false).slice(-count);
      }
    }
    return this.feed
      .getBars(symbol, resolution, 0, Date.now(), count)
      .then((r) => r.bars)
      .catch(() => [] as Bar[]);
  }

  private remember(
    key: string,
    fullAt: number,
    frames: Partial<Record<TvResolution, Bar[]>>,
  ): void {
    // A tab that came back empty is fetched whole next time rather than refreshed from nothing.
    if (SESSION_FETCHES.some((f) => !frames[f.resolution]?.length)) {
      this.sessionHistory.delete(key);
      return;
    }
    this.sessionHistory.delete(key);
    this.sessionHistory.set(key, { fullAt, frames });
    while (this.sessionHistory.size > SESSION_HISTORY_SYMBOLS) {
      this.sessionHistory.delete(this.sessionHistory.keys().next().value!);
    }
  }
}
