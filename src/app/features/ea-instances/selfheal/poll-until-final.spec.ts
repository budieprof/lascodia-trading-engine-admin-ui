import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Observable, of, throwError } from 'rxjs';

import { pollUntilFinal, type PollTick } from './poll-until-final';
import { filterLogLines } from './host-logs.logic';

interface Cmd {
  status: string;
}

describe('pollUntilFinal', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** A fetch that answers the given statuses in order, then repeats the last one. */
  function scripted(statuses: (string | null | 'error')[]) {
    let i = 0;
    const calls = { n: 0 };
    const fetch = (): Observable<Cmd | null> => {
      calls.n++;
      const s = statuses[Math.min(i++, statuses.length - 1)];
      if (s === 'error') return throwError(() => new Error('boom'));
      return of(s === null ? null : { status: s });
    };
    return { fetch, calls };
  }

  const isFinal = (c: Cmd) => ['Succeeded', 'Failed', 'Expired'].includes(c.status);

  it('emits every answer and completes on a final status', () => {
    const { fetch, calls } = scripted(['Pending', 'Delivered', 'Succeeded']);
    const ticks: PollTick<Cmd>[] = [];
    let done = false;
    pollUntilFinal(fetch, isFinal, { fastMs: 100 }).subscribe({
      next: (t) => ticks.push(t),
      complete: () => (done = true),
    });
    expect(ticks.map((t) => t.value?.status)).toEqual(['Pending']);
    vi.advanceTimersByTime(100);
    vi.advanceTimersByTime(100);
    expect(ticks.map((t) => t.value?.status)).toEqual(['Pending', 'Delivered', 'Succeeded']);
    expect(ticks[2].final).toBe(true);
    expect(done).toBe(true);
    vi.advanceTimersByTime(10_000);
    expect(calls.n).toBe(3); // no request after the outcome
  });

  it('slows down after the fast window', () => {
    let t = 0;
    const { fetch, calls } = scripted(['Pending']);
    pollUntilFinal(fetch, isFinal, {
      fastMs: 100,
      slowMs: 1000,
      fastForMs: 300,
      now: () => t,
    }).subscribe();
    for (let k = 0; k < 3; k++) {
      t += 100;
      vi.advanceTimersByTime(100);
    }
    // The 4th call ran at the end of the fast window, so the next one is 1000 ms out.
    expect(calls.n).toBe(4);
    vi.advanceTimersByTime(999);
    expect(calls.n).toBe(4);
    vi.advanceTimersByTime(1);
    expect(calls.n).toBe(5);
  });

  it('gives up after the time limit and reports the last value', () => {
    let t = 0;
    const { fetch } = scripted(['Delivered']);
    const ticks: PollTick<Cmd>[] = [];
    pollUntilFinal(fetch, isFinal, { fastMs: 100, giveUpMs: 250, now: () => t }).subscribe((x) =>
      ticks.push(x),
    );
    for (let k = 0; k < 4; k++) {
      t += 100;
      vi.advanceTimersByTime(100);
    }
    const last = ticks[ticks.length - 1];
    expect(last.gaveUp).toBe(true);
    expect(last.final).toBe(false);
    expect(last.value?.status).toBe('Delivered');
  });

  it('tolerates a few errors, then gives up', () => {
    const { fetch, calls } = scripted(['error']);
    const ticks: PollTick<Cmd>[] = [];
    pollUntilFinal(fetch, isFinal, { fastMs: 100, maxErrors: 3 }).subscribe((x) => ticks.push(x));
    vi.advanceTimersByTime(1000);
    expect(calls.n).toBe(3);
    expect(ticks).toHaveLength(1);
    expect(ticks[0].gaveUp).toBe(true);
  });

  it('recovers when an error is followed by an answer', () => {
    const { fetch } = scripted(['error', null, 'Failed']);
    const ticks: PollTick<Cmd>[] = [];
    pollUntilFinal(fetch, isFinal, { fastMs: 100 }).subscribe((x) => ticks.push(x));
    vi.advanceTimersByTime(300);
    expect(ticks.map((x) => [x.value?.status, x.final])).toEqual([['Failed', true]]);
  });

  it('stops at once when unsubscribed', () => {
    const { fetch, calls } = scripted(['Pending']);
    const sub = pollUntilFinal(fetch, isFinal, { fastMs: 100 }).subscribe();
    sub.unsubscribe();
    vi.advanceTimersByTime(1000);
    expect(calls.n).toBe(1);
  });
});

describe('filterLogLines', () => {
  it('numbers lines, drops the trailing empty one and filters case-insensitively', () => {
    const lines = 'INFO start\nERROR boom\ninfo again\n'.split('\n');
    expect(filterLogLines(lines, '')).toEqual([
      { n: 1, text: 'INFO start' },
      { n: 2, text: 'ERROR boom' },
      { n: 3, text: 'info again' },
    ]);
    expect(filterLogLines(lines, 'Info').map((l) => l.n)).toEqual([1, 3]);
  });
});
