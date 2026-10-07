import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LiveRerunScheduler, formingLiveBar } from './live-bar';

const H = 3_600_000;
const bar = (time: number, close = 1.1) => ({
  time,
  open: 1,
  high: 1.2,
  low: 0.9,
  close,
  volume: 5,
});

describe('formingLiveBar', () => {
  it('is the newest bar when it is the period containing now', () => {
    const t = 1_759_708_800_000; // 2025-10-06 00:00 UTC
    expect(formingLiveBar([bar(t - H), bar(t, 1.15)], '60' as never, t + 90_000)).toEqual({
      t,
      o: 1,
      h: 1.2,
      l: 0.9,
      c: 1.15,
      v: 5,
    });
  });

  it('is null when the newest bar is an older period or there are no bars', () => {
    const t = 1_759_708_800_000;
    expect(formingLiveBar([bar(t - H)], '60' as never, t + 90_000)).toBeNull();
    expect(formingLiveBar([], '60' as never, t)).toBeNull();
  });
});

describe('LiveRerunScheduler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function make() {
    const runs: { key: string; done: () => void }[] = [];
    const s = new LiveRerunScheduler(
      (key, done) => runs.push({ key, done }),
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
});

describe('LiveRerunScheduler — slow runs and hidden tabs', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** A scheduler on a clock the test moves (with the timers) and a hidden flag it sets. */
  function make() {
    let t = 0;
    let hidden = false;
    const runs: { key: string; done: () => void }[] = [];
    const s = new LiveRerunScheduler(
      (key, done) => runs.push({ key, done }),
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
