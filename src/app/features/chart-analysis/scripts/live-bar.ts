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
 * engine: per key at most one run every `intervalMs`, never two in flight, and requests made while
 * one is in flight or throttled collapse into a single trailing run.
 */
export class LiveRerunScheduler {
  private readonly state = new Map<
    string,
    {
      inFlight: boolean;
      pending: boolean;
      lastStart: number;
      timer?: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(
    private readonly run: (key: string, done: () => void) => void,
    private readonly intervalMs = 2_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  request(key: string): void {
    const s = this.state.get(key) ?? { inFlight: false, pending: false, lastStart: -Infinity };
    this.state.set(key, s);
    if (s.inFlight || s.timer) {
      s.pending = true;
      return;
    }
    const wait = s.lastStart + this.intervalMs - this.now();
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

  /** Forget a key (script removed, symbol switched); a run in flight finishes but is not repeated. */
  cancel(key: string): void {
    const s = this.state.get(key);
    if (s?.timer) clearTimeout(s.timer);
    this.state.delete(key);
  }

  dispose(): void {
    for (const key of [...this.state.keys()]) this.cancel(key);
  }

  private fire(key: string): void {
    const s = this.state.get(key);
    if (!s || !s.pending) return;
    if (s.inFlight) return;
    this.start(key);
  }

  private start(key: string): void {
    const s = this.state.get(key)!;
    s.pending = false;
    s.inFlight = true;
    s.lastStart = this.now();
    let finished = false;
    this.run(key, () => {
      if (finished) return;
      finished = true;
      const cur = this.state.get(key);
      if (cur !== s) return; // cancelled meanwhile
      s.inFlight = false;
      if (s.pending) {
        s.pending = false;
        this.request(key);
      }
    });
  }
}
