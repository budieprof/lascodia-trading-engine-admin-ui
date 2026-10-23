import type { DemoBar, DemoStatus, DemoTicks } from './demo.types';

/**
 * Folds replayed quotes into the minute bars (bid) the chart draws: a quote in the last bar's minute
 * updates it, a later one opens a new bar. Quotes older than the last bar are ignored (the engine's
 * candles already hold them). Pure; returns the bars that changed or were added, oldest first.
 */
export function foldTicks(bars: DemoBar[], ticks: Pick<DemoTicks, 't' | 'rt' | 'b'>): DemoBar[] {
  const touched: number[] = [];
  let last = bars.length ? bars[bars.length - 1] : null;
  for (let i = 0; i < ticks.t.length; i++) {
    const t = ticks.t[i];
    const minute = t - (((t % 60_000) + 60_000) % 60_000);
    const bid = ticks.b[i];
    if (last && minute < last.t) continue;
    if (!last || minute > last.t) {
      const recordedMinute = ticks.rt[i] - (((ticks.rt[i] % 60_000) + 60_000) % 60_000);
      last = {
        t: minute,
        o: bid,
        h: bid,
        l: bid,
        c: bid,
        ticks: 1,
        recordedT: recordedMinute,
        // A new minute whose recorded minute is not the shown one's predecessor: the loop restarted.
        loopStart:
          bars.length > 0 &&
          recordedMinute - bars[bars.length - 1].recordedT !== minute - bars[bars.length - 1].t,
        forming: true,
      };
      if (bars.length) bars[bars.length - 1] = { ...bars[bars.length - 1], forming: false };
      bars.push(last);
    } else {
      last = {
        ...last,
        h: Math.max(last.h, bid),
        l: Math.min(last.l, bid),
        c: bid,
        ticks: last.ticks + 1,
      };
      bars[bars.length - 1] = last;
    }
    if (!touched.includes(last.t)) touched.push(last.t);
  }
  return touched.map((t) => bars.find((x) => x.t === t)!).filter(Boolean);
}

/** "2026-10-21 08:00–10:00 UTC" for the recorded window. */
export function recordedWindow(s: Pick<DemoStatus, 'recordedFromMs' | 'recordedToMs'>): string {
  if (s.recordedFromMs === null || s.recordedToMs === null) return 'not chosen yet';
  const from = new Date(s.recordedFromMs).toISOString();
  const to = new Date(s.recordedToMs).toISOString();
  return `${from.slice(0, 10)} ${from.slice(11, 16)}–${to.slice(11, 16)} UTC`;
}

/** The recorded instant on screen now, as "recorded 08:43:12 UTC". */
export function recordedClock(recordedMs: number | null): string {
  if (recordedMs === null) return '';
  return `recorded ${new Date(recordedMs).toISOString().slice(11, 19)} UTC`;
}

/** Price digits for a symbol (JPY pairs 3, others 5). */
export function digitsFor(symbol: string): number {
  return /JPY/.test(symbol) ? 3 : 5;
}
