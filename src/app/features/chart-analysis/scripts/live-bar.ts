import type { Bar } from '../datafeed/candle-feed.service';
import { bucketStartFor } from '../datafeed/aggregate';
import type { TvResolution } from '../datafeed/resolution';
import type { ScriptRunBar } from '@core/api/scripting.types';

/** The symbol and resolution a bar series, or a run made over one, belongs to. */
export interface SeriesId {
  symbol: string;
  resolution: TvResolution;
}

export function sameSeries(
  a: SeriesId | null | undefined,
  b: SeriesId | null | undefined,
): boolean {
  return (
    !!a && !!b && a.resolution === b.resolution && a.symbol.toUpperCase() === b.symbol.toUpperCase()
  );
}

/**
 * Whether a run's outputs may be drawn: it was computed for the chart's symbol and resolution, and
 * the bars on screen are that series too — after a switch the previous series stays up until the new
 * one loads, and a run is drawn by matching its bars' times, which another symbol's bars share.
 */
export function runMatchesChart(run: SeriesId, chart: SeriesId, bars: SeriesId | null): boolean {
  return sameSeries(run, chart) && sameSeries(run, bars);
}

/**
 * The chart's forming bar as a run for `run` takes it (`liveBar`), or null when the newest bar is
 * not the period containing `nowMs` (market closed, history still loading, non-time resolution) —
 * or when the bars are another series' (`barsFor`): right after a switch they are still the previous
 * symbol's or timeframe's, and the engine would merge that bar into this one's.
 */
export function formingLiveBar(
  bars: readonly Bar[],
  barsFor: SeriesId | null,
  run: SeriesId,
  nowMs: number,
): ScriptRunBar | null {
  if (!sameSeries(barsFor, run)) return null;
  const last = bars[bars.length - 1];
  if (!last) return null;
  const bucket = bucketStartFor(run.resolution, nowMs);
  if (bucket === null || bucket !== last.time) return null;
  return { t: last.time, o: last.open, h: last.high, l: last.low, c: last.close, v: last.volume };
}

/**
 * Sequences the runs of the chart's scripts. Every run of a key holds a ticket, and only the newest
 * ticket's result may be drawn ({@link isCurrent}) — a slow run of an old source landing after the
 * operator's update must not put the old source back.
 *
 * Two kinds of run:
 *
 * - **explicit** ({@link begin}: adding a script, "Update on chart", new inputs, a symbol switch, a
 *   restored layout, more history loaded) starts at once and supersedes the key's run in flight;
 * - **quiet re-runs** ({@link request}: the forming bar ticking, the minute timer, a theme switch)
 *   wait their turn. Per key, never two in flight — an explicit run counts — and requests made
 *   while one is in flight or waiting collapse into a single trailing run. One starts no sooner
 *   than `intervalMs` after the previous run started, or `rttFactor` times that run's round trip
 *   when longer, so a heavy script whose runs take seconds keeps the engine busy at most
 *   1/`rttFactor` of the time instead of back to back. Nothing starts while `paused()` (the page
 *   passes `document.hidden`): requests wait, and `resume()` starts one run for each key that
 *   asked meanwhile.
 *
 * Every run ends with {@link settle}, after its result is applied (or dropped): the newest frees its
 * key for the trailing re-run.
 */
export class LiveRerunScheduler {
  private readonly state = new Map<
    string,
    {
      /** Ticket of the run in flight whose result may be applied, null when none is. */
      current: number | null;
      pending: boolean;
      lastStart: number;
      /** How long the last finished run took, ms. */
      lastRtt: number;
      timer?: ReturnType<typeof setTimeout>;
    }
  >();
  private tickets = 0;

  constructor(
    /** Starts a quiet re-run of `key`; it must end with `settle(key, ticket)`. */
    private readonly run: (key: string, ticket: number) => void,
    private readonly intervalMs = 2_000,
    private readonly now: () => number = () => Date.now(),
    private readonly paused: () => boolean = () => false,
    private readonly rttFactor = 4,
  ) {}

  /** A quiet re-run of `key`, spaced and one at a time (see the class comment). */
  request(key: string): void {
    const s = this.stateOf(key);
    if (s.current !== null || s.timer || this.paused()) {
      s.pending = true;
      return;
    }
    const wait = s.lastStart + this.gapMs(s.lastRtt) - this.now();
    if (wait > 0) {
      s.pending = true;
      s.timer = setTimeout(() => {
        s.timer = undefined;
        this.fire(key);
      }, wait);
      return;
    }
    this.start(key);
  }

  /**
   * An explicit run of `key` starts now: the run in flight, if any, is superseded — its result must
   * not be drawn — and quiet re-runs wait for this one. Returns its ticket.
   */
  begin(key: string): number {
    const s = this.stateOf(key);
    s.current = ++this.tickets;
    s.lastStart = this.now();
    return s.current;
  }

  /** Whether a run's result may be drawn: it is its key's newest, and the key was not cancelled since. */
  isCurrent(key: string, ticket: number): boolean {
    return this.state.get(key)?.current === ticket;
  }

  /**
   * A run is over — its result applied, dropped or failed. The newest run of a key frees it, and a
   * re-run asked for meanwhile follows (spaced as usual); a superseded one changes nothing.
   */
  settle(key: string, ticket: number): void {
    const s = this.state.get(key);
    if (!s || s.current !== ticket) return;
    s.current = null;
    s.lastRtt = Math.max(0, this.now() - s.lastStart);
    if (s.pending) {
      s.pending = false;
      this.request(key);
    }
  }

  /** Visible again: one run (spaced as usual) for every key that asked while paused. */
  resume(): void {
    if (this.paused()) return;
    for (const [key, s] of this.state) {
      if (!s.pending || s.current !== null || s.timer) continue;
      s.pending = false;
      this.request(key);
    }
  }

  /**
   * Forget a key (script removed, layout replaced): a run in flight may finish, but its result is not
   * current any more, and nothing waiting runs.
   */
  cancel(key: string): void {
    const s = this.state.get(key);
    if (s?.timer) clearTimeout(s.timer);
    this.state.delete(key);
  }

  cancelAll(): void {
    for (const key of [...this.state.keys()]) this.cancel(key);
  }

  dispose(): void {
    this.cancelAll();
  }

  private stateOf(key: string) {
    let s = this.state.get(key);
    if (!s) {
      s = { current: null, pending: false, lastStart: -Infinity, lastRtt: 0 };
      this.state.set(key, s);
    }
    return s;
  }

  /** Least time between two runs' starts. */
  private gapMs(lastRtt: number): number {
    return Math.max(this.intervalMs, this.rttFactor * lastRtt);
  }

  private fire(key: string): void {
    const s = this.state.get(key);
    if (!s || !s.pending) return;
    // In flight: its settle re-requests. Paused: still pending, so resume() runs it.
    if (s.current !== null || this.paused()) return;
    this.start(key);
  }

  private start(key: string): void {
    const s = this.state.get(key)!;
    s.pending = false;
    const ticket = this.begin(key);
    this.run(key, ticket);
  }
}
