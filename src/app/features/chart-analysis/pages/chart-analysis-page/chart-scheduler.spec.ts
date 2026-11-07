import { describe, expect, it, vi } from 'vitest';
import { BASE_TICK_MS, ChartScheduler, type SchedulerEnv } from './chart-scheduler';

function fakeEnv() {
  let now = 0;
  let hidden = false;
  const timers = new Map<number, { fn: () => void; ms: number; next: number }>();
  let id = 0;
  let listener: (() => void) | null = null;
  const env: SchedulerEnv = {
    now: () => now,
    hidden: () => hidden,
    setInterval: (fn, ms) => {
      timers.set(++id, { fn, ms, next: now + ms });
      return id;
    },
    clearInterval: (h) => void timers.delete(h as number),
    onVisibility: (fn) => {
      listener = fn;
      return () => (listener = null);
    },
  };
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = [...timers.values()].filter((t) => t.next <= end).sort((a, b) => a.next - b.next)[0];
      if (!due) break;
      now = due.next;
      due.next += due.ms;
      due.fn();
    }
    now = end;
  };
  const setHidden = (h: boolean) => {
    hidden = h;
    listener?.();
  };
  return { env, advance, setHidden, timers };
}

describe('US06 chart scheduler (one visibility-aware timer)', () => {
  it('runs each job every period on one base timer', () => {
    const { env, advance, timers } = fakeEnv();
    const s = new ChartScheduler(env);
    const clock = vi.fn();
    const minute = vi.fn();
    s.every('clock', 1_000, clock);
    s.every('minute', 60_000, minute);
    expect(timers.size).toBe(1);
    advance(60_000);
    expect(clock).toHaveBeenCalledTimes(60);
    expect(minute).toHaveBeenCalledTimes(1);
  });

  it('nothing runs while hidden (the base timer stops); on showing, what was due runs at once', () => {
    const { env, advance, setHidden, timers } = fakeEnv();
    const s = new ChartScheduler(env);
    const minute = vi.fn();
    const halfHour = vi.fn();
    s.every('minute', 60_000, minute);
    s.every('long', 1_800_000, halfHour);
    advance(30_000);
    setHidden(true);
    expect(timers.size).toBe(0);
    advance(10 * 60_000);
    expect(minute).not.toHaveBeenCalled();
    setHidden(false);
    expect(minute).toHaveBeenCalledTimes(1); // overdue: at once
    expect(halfHour).not.toHaveBeenCalled(); // not due yet
    advance(60_000 - BASE_TICK_MS);
    expect(minute).toHaveBeenCalledTimes(1);
    advance(BASE_TICK_MS);
    expect(minute).toHaveBeenCalledTimes(2); // a period from when it ran
  });

  it('a cancelled job never runs again; dispose stops everything', () => {
    const { env, advance, timers } = fakeEnv();
    const s = new ChartScheduler(env);
    const a = vi.fn();
    const cancel = s.every('a', 1_000, a);
    advance(2_000);
    cancel();
    advance(5_000);
    expect(a).toHaveBeenCalledTimes(2);
    expect(timers.size).toBe(0);
    s.every('b', 1_000, vi.fn());
    s.dispose();
    expect(timers.size).toBe(0);
  });
});
