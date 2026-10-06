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
