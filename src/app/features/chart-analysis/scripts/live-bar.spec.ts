import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LiveRerunScheduler, formingLiveBar, runMatchesChart, sameSeries } from './live-bar';

const H = 3_600_000;
const bar = (time: number, close = 1.1) => ({
  time,
  open: 1,
  high: 1.2,
  low: 0.9,
  close,
  volume: 5,
});
const EURUSD_H1 = { symbol: 'EURUSD', resolution: '60' };
const USDJPY_H1 = { symbol: 'USDJPY', resolution: '60' };
const EURUSD_H4 = { symbol: 'EURUSD', resolution: '240' };

describe('formingLiveBar', () => {
  const t = 1_759_708_800_000; // 2025-10-06 00:00 UTC

  it('is the newest bar when it is the period containing now', () => {
    expect(formingLiveBar([bar(t - H), bar(t, 1.15)], EURUSD_H1, EURUSD_H1, t + 90_000)).toEqual({
      t,
      o: 1,
      h: 1.2,
      l: 0.9,
      c: 1.15,
      v: 5,
    });
  });

  it('is null when the newest bar is an older period or there are no bars', () => {
    expect(formingLiveBar([bar(t - H)], EURUSD_H1, EURUSD_H1, t + 90_000)).toBeNull();
    expect(formingLiveBar([], EURUSD_H1, EURUSD_H1, t)).toBeNull();
  });

  it("is null while the chart still holds another series' bars", () => {
    const bars = [bar(t - H), bar(t, 1.1191)];
    // Switched to USDJPY: the EURUSD forming bar must not be sent as USDJPY's.
    expect(formingLiveBar(bars, EURUSD_H1, USDJPY_H1, t + 90_000)).toBeNull();
    // Switched to 4h (00:00 is a 4h bucket too): the 1h bar is not the 4h bar.
    expect(formingLiveBar(bars, EURUSD_H1, EURUSD_H4, t + 90_000)).toBeNull();
    // Nothing loaded yet.
    expect(formingLiveBar(bars, null, EURUSD_H1, t + 90_000)).toBeNull();
    // Case of the symbol does not matter.
    expect(
      formingLiveBar(bars, { symbol: 'eurusd', resolution: '60' }, EURUSD_H1, t + 90_000),
    ).not.toBeNull();
  });
});

describe('sameSeries / runMatchesChart', () => {
  it('matches symbol and resolution', () => {
    expect(sameSeries(EURUSD_H1, { ...EURUSD_H1 })).toBe(true);
    expect(sameSeries(EURUSD_H1, USDJPY_H1)).toBe(false);
    expect(sameSeries(EURUSD_H1, EURUSD_H4)).toBe(false);
    expect(sameSeries(EURUSD_H1, null)).toBe(false);
    expect(sameSeries(null, null)).toBe(false);
  });

  it("draws a run only on its own series, once that series' bars are on screen", () => {
    expect(runMatchesChart(EURUSD_H1, EURUSD_H1, EURUSD_H1)).toBe(true);
    // Switched away: the previous run is hidden at once.
    expect(runMatchesChart(EURUSD_H1, EURUSD_H4, EURUSD_H1)).toBe(false);
    // The new run came back before the new bars: not over the previous symbol's candles.
    expect(runMatchesChart(USDJPY_H1, USDJPY_H1, EURUSD_H1)).toBe(false);
    expect(runMatchesChart(USDJPY_H1, USDJPY_H1, null)).toBe(false);
  });
});

/** Quiet re-runs the scheduler started; `done()` settles one. */
type Started = { key: string; ticket: number; done: () => void };

describe('LiveRerunScheduler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function make() {
    const runs: Started[] = [];
    const s: LiveRerunScheduler = new LiveRerunScheduler(
      (key, ticket) => runs.push({ key, ticket, done: () => s.settle(key, ticket) }),
      2_000,
      () => Date.now(),
    );
    return { s, runs };
  }

  it('runs at once, then at most once per interval with one trailing run', () => {
    const { s, runs } = make();
    s.request('a');
    expect(runs.length).toBe(1);
    runs[0].done();
    s.request('a');
    s.request('a');
    s.request('a');
    expect(runs.length).toBe(1);
    vi.advanceTimersByTime(2_000);
    expect(runs.length).toBe(2);
    runs[1].done();
    vi.advanceTimersByTime(10_000);
    expect(runs.length).toBe(2);
  });

  it('never runs a key twice concurrently; requests during a run coalesce', () => {
    const { s, runs } = make();
    s.request('a');
    vi.advanceTimersByTime(5_000);
    s.request('a');
    s.request('a');
    expect(runs.length).toBe(1);
    runs[0].done();
    // One trailing run, once the gap after a 5 s round trip (4 × 5 s from its start) has passed.
    expect(runs.length).toBe(1);
    vi.advanceTimersByTime(15_000);
    expect(runs.length).toBe(2);
    vi.advanceTimersByTime(60_000);
    expect(runs.length).toBe(2);
  });

  it('keys are independent and cancel stops a pending run', () => {
    const { s, runs } = make();
    s.request('a');
    s.request('b');
    expect(runs.map((r) => r.key)).toEqual(['a', 'b']);
    runs[0].done();
    s.request('a');
    s.cancel('a');
    vi.advanceTimersByTime(5_000);
    expect(runs.length).toBe(2);
  });

  it('settling twice, or settling a superseded run, frees nothing', () => {
    const { s, runs } = make();
    s.request('a');
    const first = runs[0];
    first.done();
    first.done();
    s.request('a'); // spaced: due in 2 s
    vi.advanceTimersByTime(2_000);
    expect(runs.length).toBe(2);
    first.done(); // a stale settle must not free the run now in flight
    s.request('a');
    vi.advanceTimersByTime(10_000);
    expect(runs.length).toBe(2);
  });
});

describe('LiveRerunScheduler — explicit runs and the newest result', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function make() {
    let t = 0;
    const runs: Started[] = [];
    const s: LiveRerunScheduler = new LiveRerunScheduler(
      (key, ticket) => runs.push({ key, ticket, done: () => s.settle(key, ticket) }),
      2_000,
      () => t,
    );
    const advance = (ms: number) => {
      t += ms;
      vi.advanceTimersByTime(ms);
    };
    return { s, runs, advance };
  }

  it("an update supersedes a slow re-run of the old source in flight (the editor's race)", () => {
    const { s, runs, advance } = make();
    s.request('editor:current'); // a 4 s re-run of the OLD source starts
    const stale = runs[0];
    advance(600);
    const update = s.begin('editor:current'); // "Update on chart"
    expect(s.isCurrent('editor:current', stale.ticket)).toBe(false);
    expect(s.isCurrent('editor:current', update)).toBe(true);
    advance(150);
    s.settle('editor:current', update); // the update lands first and is drawn
    advance(3_250);
    // The old re-run lands last: not current, so it is dropped, and settling it changes nothing.
    expect(s.isCurrent('editor:current', stale.ticket)).toBe(false);
    stale.done();
    expect(runs.length).toBe(1);
  });

  it('quiet re-runs wait for an explicit run in flight, then follow it spaced', () => {
    const { s, runs, advance } = make();
    const t = s.begin('a');
    s.request('a'); // a tick, the minute timer, a theme switch…
    s.request('a');
    advance(5_000);
    expect(runs.length).toBe(0); // never beside the explicit run
    s.settle('a', t); // a 5 s round trip: the next run may start 20 s after it started
    expect(runs.length).toBe(0);
    advance(14_999);
    expect(runs.length).toBe(0);
    advance(1);
    expect(runs.length).toBe(1);
    expect(s.isCurrent('a', runs[0].ticket)).toBe(true);
  });

  it('a timer that comes due during an explicit run waits for it', () => {
    const { s, runs, advance } = make();
    s.request('a');
    runs[0].done();
    s.request('a'); // spaced: due at 2 s
    advance(1_000);
    const t = s.begin('a');
    advance(2_000);
    expect(runs.length).toBe(1);
    s.settle('a', t); // started at 1 s, took 2 s: next start no sooner than 9 s (now: 3 s)
    advance(5_999);
    expect(runs.length).toBe(1);
    advance(1);
    expect(runs.length).toBe(2);
  });

  it('only the newest of two explicit runs is current', () => {
    const { s } = make();
    const first = s.begin('a');
    const second = s.begin('a');
    expect(s.isCurrent('a', first)).toBe(false);
    expect(s.isCurrent('a', second)).toBe(true);
    s.settle('a', first);
    expect(s.isCurrent('a', second)).toBe(true);
  });

  it('cancel makes every run of the key stale (removed script, replaced layout)', () => {
    const { s, runs } = make();
    s.request('a');
    const t = s.begin('b');
    s.cancelAll();
    expect(s.isCurrent('a', runs[0].ticket)).toBe(false);
    expect(s.isCurrent('b', t)).toBe(false);
    // The key starts afresh.
    s.request('a');
    expect(runs.length).toBe(2);
  });
});

describe('LiveRerunScheduler — slow runs and hidden tabs', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** A scheduler on a clock the test moves (with the timers) and a hidden flag it sets. */
  function make() {
    let t = 0;
    let hidden = false;
    const runs: Started[] = [];
    const s: LiveRerunScheduler = new LiveRerunScheduler(
      (key, ticket) => runs.push({ key, ticket, done: () => s.settle(key, ticket) }),
      2_000,
      () => t,
      () => hidden,
    );
    const advance = (ms: number) => {
      t += ms;
      vi.advanceTimersByTime(ms);
    };
    const setHidden = (h: boolean) => (hidden = h);
    return { s, runs, advance, setHidden };
  }

  it('spaces the runs of a slow script by 4× its round trip, from the start of the last run', () => {
    const { s, runs, advance } = make();
    s.request('a');
    advance(3_000);
    runs[0].done(); // a 3 s round trip: the next run may start 12 s after this one started
    s.request('a');
    s.request('a');
    advance(8_999);
    expect(runs.length).toBe(1);
    advance(1);
    expect(runs.length).toBe(2);
  });

  it('keeps the 2 s floor for a fast script, and adapts again once it speeds up', () => {
    const { s, runs, advance } = make();
    s.request('a');
    advance(100);
    runs[0].done();
    s.request('a');
    advance(1_899);
    expect(runs.length).toBe(1);
    advance(1);
    expect(runs.length).toBe(2);

    // Slow once (gap 4 × 1 s), then fast again (back to the floor).
    advance(1_000);
    runs[1].done();
    s.request('a');
    advance(2_999);
    expect(runs.length).toBe(2);
    advance(1);
    expect(runs.length).toBe(3);
    advance(50);
    runs[2].done();
    s.request('a');
    advance(1_949);
    expect(runs.length).toBe(3);
    advance(1);
    expect(runs.length).toBe(4);
  });

  it('still never runs a key twice concurrently', () => {
    const { s, runs, advance } = make();
    s.request('a');
    advance(30_000);
    s.request('a');
    expect(runs.length).toBe(1);
    runs[0].done(); // 30 s round trip: the trailing run waits until 120 s after the first started
    expect(runs.length).toBe(1);
    advance(89_999);
    expect(runs.length).toBe(1);
    advance(1);
    expect(runs.length).toBe(2);
  });

  it('runs nothing while hidden, then one run per waiting key when shown', () => {
    const { s, runs, advance, setHidden } = make();
    setHidden(true);
    s.request('a');
    s.request('a');
    s.request('b');
    advance(60_000);
    expect(runs.length).toBe(0);
    s.resume(); // still hidden: no-op
    expect(runs.length).toBe(0);
    setHidden(false);
    s.resume();
    expect(runs.map((r) => r.key)).toEqual(['a', 'b']);
    s.resume();
    expect(runs.length).toBe(2);
  });

  it('holds a trailing run that comes due while hidden until resume', () => {
    const { s, runs, advance, setHidden } = make();
    s.request('a');
    runs[0].done();
    s.request('a'); // throttled: due in 2 s
    setHidden(true);
    advance(5_000);
    expect(runs.length).toBe(1);
    setHidden(false);
    s.resume();
    expect(runs.length).toBe(2);
  });

  it('holds the trailing run of a run that finishes while hidden', () => {
    const { s, runs, advance, setHidden } = make();
    s.request('a');
    s.request('a'); // collapses into a trailing run
    setHidden(true);
    advance(500);
    runs[0].done();
    advance(10_000);
    expect(runs.length).toBe(1);
    setHidden(false);
    s.resume();
    expect(runs.length).toBe(2);
  });

  it('resumes nothing for a key with nothing waiting', () => {
    const { s, runs, setHidden } = make();
    s.request('a');
    runs[0].done();
    setHidden(true);
    setHidden(false);
    s.resume();
    expect(runs.length).toBe(1);
  });
});
