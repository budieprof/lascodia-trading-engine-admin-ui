import type { Bar } from '../datafeed/candle-feed.service';
import { bucketStartFor } from '../datafeed/aggregate';
import type { TvResolution } from '../datafeed/resolution';
import type { ScriptRunBar } from '@core/api/scripting.types';

/**
 * The chart's forming bar as `scripting/run` takes it (`liveBar`), or null when the newest bar is
 * not the period containing `nowMs` (market closed, history still loading, non-time resolution).
 */
export function formingLiveBar(
  bars: readonly Bar[],
  resolution: TvResolution,
  nowMs: number,
): ScriptRunBar | null {
  const last = bars[bars.length - 1];
  if (!last) return null;
  const bucket = bucketStartFor(resolution, nowMs);
  if (bucket === null || bucket !== last.time) return null;
  return { t: last.time, o: last.open, h: last.high, l: last.low, c: last.close, v: last.volume };
}

/**
 * Re-runs live chart scripts as the forming bar ticks, TradingView-style, without flooding the
 * engine. Per key:
 *
 * - never two runs in flight, and requests made while one is in flight or waiting collapse into a
 *   single trailing run;
 * - a run starts no sooner than `intervalMs` after the previous one started — or `rttFactor` times
 *   that run's round trip when longer, so a heavy script whose runs take seconds keeps the engine
 *   busy at most 1/`rttFactor` of the time instead of back to back;
 * - nothing starts while `paused()` (the page passes `document.hidden`): requests wait, and
 *   `resume()` starts one run for each key that asked meanwhile.
 */
export class LiveRerunScheduler {
  private readonly state = new Map<
    string,
    {
      inFlight: boolean;
      pending: boolean;
      lastStart: number;
      /** How long the last finished run took, ms. */
      lastRtt: number;
      timer?: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(
    private readonly run: (key: string, done: () => void) => void,
    private readonly intervalMs = 2_000,
    private readonly now: () => number = () => Date.now(),
    private readonly paused: () => boolean = () => false,
    private readonly rttFactor = 4,
  ) {}

  request(key: string): void {
    const s = this.state.get(key) ?? {
      inFlight: false,
      pending: false,
      lastStart: -Infinity,
      lastRtt: 0,
    };
    this.state.set(key, s);
    if (s.inFlight || s.timer || this.paused()) {
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

  /** Visible again: one run (spaced as usual) for every key that asked while paused. */
  resume(): void {
    if (this.paused()) return;
    for (const [key, s] of this.state) {
      if (!s.pending || s.inFlight || s.timer) continue;
      s.pending = false;
      this.request(key);
    }
  }

  /** Forget a key (script removed, symbol switched); a run in flight finishes but is not repeated. */
  cancel(key: string): void {
    const s = this.state.get(key);
    if (s?.timer) clearTimeout(s.timer);
    this.state.delete(key);
  }

  dispose(): void {
    for (const key of [...this.state.keys()]) this.cancel(key);
  }

  /** Least time between two runs' starts. */
  private gapMs(lastRtt: number): number {
    return Math.max(this.intervalMs, this.rttFactor * lastRtt);
  }

  private fire(key: string): void {
    const s = this.state.get(key);
    if (!s || !s.pending) return;
    // In flight: its completion re-requests. Paused: still pending, so resume() runs it.
    if (s.inFlight || this.paused()) return;
    this.start(key);
  }

  private start(key: string): void {
    const s = this.state.get(key)!;
    s.pending = false;
    s.inFlight = true;
    const started = this.now();
    s.lastStart = started;
    let finished = false;
    this.run(key, () => {
      if (finished) return;
      finished = true;
      const cur = this.state.get(key);
      if (cur !== s) return; // cancelled meanwhile
      s.inFlight = false;
      s.lastRtt = Math.max(0, this.now() - started);
      if (s.pending) {
        s.pending = false;
        this.request(key);
      }
    });
  }
}
