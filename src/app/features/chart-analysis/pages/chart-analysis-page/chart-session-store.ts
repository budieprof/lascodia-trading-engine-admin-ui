import { computed, signal } from '@angular/core';

import type { Bar, SessionBar } from '../../datafeed/candle-feed.service';
import {
  applyStoredTick,
  foldBars,
  lastCompleteBarTime,
  mergeForming,
  type BarGrid,
} from '../../datafeed/aggregate';
import { isSessionResolution, type TvResolution } from '../../datafeed/resolution';
import { SessionRollover, applySessionTick, mergeSessionTail } from '../../datafeed/session-bars';
import {
  TradingCalendar,
  nextSessionPeriod,
  type SessionSpec,
} from '../../datafeed/session-calendar';
import { sameSeries, type SeriesId } from '../../scripts/live-bar';
import { ChartHistoryPager, type ChartHistoryPagerDeps } from './chart-history-pager';

/** What the main series reads of the candle feed. */
export interface ChartSessionFeed extends Pick<ChartHistoryPagerDeps['feed'], 'getBars'> {
  invalidate(symbol?: string, resolution?: TvResolution): void;
  sessionOf(symbol: string): SessionSpec | null;
  gridOf(symbol: string): BarGrid;
  minuteBarsSince(symbol: string, sinceMs: number): Promise<Bar[] | null>;
  sessionTail(
    symbol: string,
    resolution: TvResolution,
    sinceMs: number,
  ): Promise<SessionBar[] | null>;
}

/** The page's members the store calls back into (accessors, so it can be built before the page's fields). */
export interface ChartSessionStoreDeps {
  feed: ChartSessionFeed;
  host: ChartHistoryPagerDeps['host'];
  replay: ChartHistoryPagerDeps['replay'];
  loadEvents: ChartHistoryPagerDeps['loadEvents'];
  extendCompareBars: ChartHistoryPagerDeps['extendCompareBars'];
}

/**
 * US02b: the chart page's MAIN series — which symbol and timeframe the chart is on, the bars it holds and whose
 * they are, the bar still forming, live prices applied to it, and the hand-off to scroll-back paging
 * ({@link ChartHistoryPager}). Moved out of ChartAnalysisPageComponent behaviour for behaviour; the page keeps the
 * orchestration around a load (drawings scope, trade layers, synthetic legs, replay, events) and aliases these
 * signals under their old names, so its template and its other members read them as before.
 */
export class ChartSessionStore {
  constructor(private readonly deps: ChartSessionStoreDeps) {}

  readonly symbol = signal<string>('EURUSD');
  readonly resolution = signal<TvResolution>('60');
  readonly bars = signal<Bar[]>([]);
  /**
   * The symbol and resolution `bars` hold. A switch changes the chart's at once, but the previous
   * series stays on screen until the new one loads — so whatever takes the bars to be this
   * symbol's (a run's forming bar, a run's drawings, a tick) checks this first.
   */
  readonly barsFor = signal<SeriesId | null>(null, {
    equal: (a, b) => a === b || sameSeries(a, b),
  });
  /**
   * The series on screen, for the chart: it rebuilds every series when this changes, rather than
   * diffing one instrument's bars against another's (CC-I1).
   */
  readonly dataKey = computed(() => {
    const b = this.barsFor();
    return b ? `${b.symbol}|${b.resolution}` : '';
  });
  /**
   * The series whose oldest loaded bar is the start of the engine's history (a scroll-back page came
   * back empty): the chart stops asking for more (CC-14). Cleared by every load of a series.
   */
  readonly historyStart = signal<string | null>(null);
  readonly historyComplete = computed(
    () => !!this.dataKey() && this.historyStart() === this.dataKey(),
  );
  /**
   * The symbol's session as the engine reports it with its chart bars: the trading days the chart's
   * day-based studies and the Details pane count in, and the calendar a live price opens the next
   * session-grid period by. Null until it is known — and for a symbol without one: UTC days.
   */
  readonly sessionSpec = computed(() => this.deps.feed.sessionOf(this.symbol()));
  readonly tradingCalendar = computed(() => {
    const spec = this.sessionSpec();
    return spec ? new TradingCalendar(spec) : null;
  });
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  /** The series the newest load started for (or loaded). */
  requested: SeriesId | null = null;

  /**
   * Time of the newest bar that is known to be COMPLETE in stored history. Every bar after it is
   * still forming, and is rebuilt from M1 rather than trusted.
   */
  private lastStored: number | null = null;
  /** Ticks applied to the chart's newest bar, ever; against {@link tailMergedAt}: any since the last merge. */
  private ticksApplied = 0;
  /** {@link ticksApplied} when the engine's newest bars were last laid over the chart's. */
  private tailMergedAt = 0;
  /** The request for the newest session bars in flight, by series — shared by the minute resync and a rollover. */
  private tailInFlight: { series: string; done: Promise<void> } | null = null;
  /** One request per bar change when ticks pass the newest session bar's close (`SessionRollover`). */
  private readonly rollover = new SessionRollover(() => Date.now());

  /** Still the chart's series? A switch made while a load is out has a load of its own. */
  isCurrent(symbol: string, resolution: TvResolution): boolean {
    return symbol === this.symbol() && resolution === this.resolution();
  }

  /**
   * The start of a load of the chart's current series: it becomes the requested one, the feed's
   * cache of it is dropped and the session rollover forgets the previous series' bar.
   */
  beginLoad(symbol: string, resolution: TvResolution): void {
    this.requested = { symbol, resolution };
    this.loading.set(true);
    this.error.set(null);
    this.deps.feed.invalidate(symbol, resolution);
    this.rollover.reset();
  }

  /** A load's bars on screen as `symbol`/`resolution`'s, with the forming-bar bookkeeping reset to them. */
  acceptBars(symbol: string, resolution: TvResolution, bars: Bar[]): void {
    this.historyStart.set(null);
    this.bars.set(bars);
    this.barsFor.set({ symbol, resolution });
  }

  /** After {@link acceptBars} (and the page's own steps): the tick/forming-bar state follows the new bars. */
  resetFormingState(bars: Bar[], resolution: TvResolution): void {
    this.tailMergedAt = this.ticksApplied;
    this.lastStored = lastCompleteBarTime(bars, resolution);
    // The stored history ends at the last CLOSED bar; build the one still forming from real data
    // rather than from whatever tick happens to arrive first. (The session grid's came with it.)
    if (!isSessionResolution(resolution)) void this.syncFormingBars();
  }

  /** Scroll-back paging (CC-11, CC-14) — {@link ChartHistoryPager}. */
  loadOlder(): Promise<void> {
    return this.historyPager.loadOlder();
  }

  /** Built on first use. */
  private _historyPager?: ChartHistoryPager;
  private get historyPager(): ChartHistoryPager {
    const d = this.deps;
    return (this._historyPager ??= new ChartHistoryPager({
      symbol: () => this.symbol(),
      resolution: () => this.resolution(),
      bars: this.bars,
      barsFor: () => this.barsFor(),
      loading: this.loading,
      historyStart: this.historyStart,
      feed: d.feed,
      replay: d.replay,
      host: d.host,
      loadEvents: d.loadEvents,
      extendCompareBars: d.extendCompareBars,
    }));
  }

  /**
   * Rebuild the forming bar (and any closed bar the engine has not yet stored) from M1.
   *
   * <p>The engine writes a bar only once it has closed, so the newest bar is never in the history
   * and the chart had to invent it from live ticks — opening it at whatever price arrived first
   * after the page loaded. Load the chart mid-bar and the candle jumped away from the previous close,
   * with an open, high and low that covered seconds instead of the whole period. M1 trails the
   * market by at most a minute, so it gives the real ones.</p>
   *
   * <p>Ticks still move the close between syncs; this corrects everything else.</p>
   *
   * <p>On the session grid (2h … 1M) the engine builds the forming bar itself, on its own calendar:
   * this re-reads the newest bars from it instead ({@link syncSessionTail}).</p>
   */
  async syncFormingBars(): Promise<void> {
    const resolution = this.resolution();
    const symbol = this.symbol();
    if (isSessionResolution(resolution)) return this.syncSessionTail();
    const stored = this.lastStored;
    // While a switch loads, the bars (and `lastStored`) are still the previous series'.
    const onScreen = () => sameSeries(this.barsFor(), { symbol, resolution });
    if (resolution === '1' || stored === null || this.bars().length === 0 || !onScreen()) return;

    const feed = this.deps.feed;
    const minutes = await feed.minuteBarsSince(symbol, stored + 1);
    if (!minutes || minutes.length === 0) return;
    // The operator may have switched symbol or timeframe while the request was in flight.
    if (
      symbol !== this.symbol() ||
      resolution !== this.resolution() ||
      stored !== this.lastStored ||
      !onScreen()
    )
      return;

    this.bars.set(
      mergeForming(this.bars(), foldBars(minutes, resolution, feed.gridOf(symbol)), stored),
    );
  }

  /**
   * Re-read the newest session-grid bars from the engine — the bar still forming, the one or two
   * before it (a period that just closed may have been built before its last minute was stored), and
   * any period that opened since the chart last asked — and lay them over the chart's
   * ({@link mergeSessionTail}). Shared by the minute resync and a tick past the newest bar's close:
   * one request at a time per series.
   */
  private syncSessionTail(): Promise<void> {
    const series = `${this.symbol()}|${this.resolution()}`;
    if (this.tailInFlight?.series === series) return this.tailInFlight.done;
    const done: Promise<void> = this.fetchSessionTail().finally(() => {
      if (this.tailInFlight?.done === done) this.tailInFlight = null;
    });
    this.tailInFlight = { series, done };
    return done;
  }

  private async fetchSessionTail(): Promise<void> {
    const symbol = this.symbol();
    const resolution = this.resolution();
    const onScreen = () =>
      symbol === this.symbol() &&
      resolution === this.resolution() &&
      sameSeries(this.barsFor(), { symbol, resolution });
    const held = this.bars();
    if (held.length === 0 || !onScreen()) return;

    const tail = await this.deps.feed.sessionTail(symbol, resolution, held[held.length - 1].time);
    // A failed request leaves the chart as it is; a switch made meanwhile has bars of its own.
    if (!tail || !onScreen()) return;
    // Ticks since the last merge are newer than the engine's forming bar: they keep its close.
    const ticked = this.ticksApplied !== this.tailMergedAt;
    this.tailMergedAt = this.ticksApplied;
    this.bars.set(mergeSessionTail(this.bars(), tail, ticked));
  }

  /**
   * A live price of the chart's symbol (already resolved to the price the bars are built from, at the
   * tick's own time on the engine's clock) onto the newest bar.
   */
  applyPrice(price: number, at: number): void {
    // Right after a switch the bars on screen are still the previous series': not this tick's.
    if (!sameSeries(this.barsFor(), { symbol: this.symbol(), resolution: this.resolution() }))
      return;
    const current = this.bars();
    if (current.length === 0) return;

    if (isSessionResolution(this.resolution())) {
      this.applyTickOnSessionGrid(current, price, at);
      return;
    }

    // The same bucketing the stored history uses — the UTC epoch grid, exact for 1m … 1h — on the
    // engine's clock, as the countdown and a run's live bar read it. A price past the newest bar's
    // bucket opens its own bucket's bar, so the chart never stalls a timeframe behind the market.
    const next = applyStoredTick(
      current,
      price,
      at,
      this.resolution(),
      this.deps.feed.gridOf(this.symbol()),
    );
    if (next) this.bars.set(next);
  }

  /**
   * A live price on the session grid (2h … 1M), on the engine's clock: it moves the newest bar while
   * that bar's period lasts. From the bar's close on, it opens the next period's bar itself — at the
   * old bar's close, or with the session it is in after the weekend, laid out by the symbol's session
   * (`nextSessionPeriod`) — as TradingView does on a period's first tick: the engine's forming bar is
   * folded from closed M1, so for a period's first minute there is none to ask for. The minute
   * resync then lays the engine's own bar over it. Where the chart cannot tell the period (a gap of
   * a whole period, no session known), it asks for the newest bars instead, once per bar
   * ({@link SessionRollover}).
   */
  private applyTickOnSessionGrid(current: Bar[], price: number, at: number): void {
    const calendar = this.tradingCalendar();
    const resolution = this.resolution();
    const outcome = applySessionTick(
      current,
      price,
      at,
      calendar ? (last, now) => nextSessionPeriod(calendar, resolution, last, now) : undefined,
    );
    if (outcome.kind === 'update' || outcome.kind === 'open') {
      this.ticksApplied++;
      this.bars.set(outcome.bars);
      return;
    }
    if (outcome.kind !== 'rollover') return;
    const key = `${this.symbol()}|${this.resolution()}|${current[current.length - 1].time}`;
    if (!this.rollover.request(key)) return;
    void this.syncSessionTail().finally(() => this.rollover.done(key));
  }
}
