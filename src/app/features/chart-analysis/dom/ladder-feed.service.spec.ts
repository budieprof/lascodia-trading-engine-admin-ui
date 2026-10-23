import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Injector, NgZone, runInInjectionContext, signal } from '@angular/core';
import { of } from 'rxjs';

import { ApiService } from '@core/api/api.service';
import { AuthService } from '@core/auth/auth.service';
import { RUNTIME_CONFIG } from '@core/config/runtime-config';

import { LiveDepthService } from '../orderflow/live-depth.service';
import type { MdFrame } from './book-state';
import { LadderFeedService } from './ladder-feed.service';

/** The ladder's market-data adapter: C2 events folded per source, the quote, the ≤ 4 Hz beat, the polling fallback. */
describe('LadderFeedService', () => {
  const snapshot = signal<unknown>(null);
  const depthRelease = vi.fn();
  const post = vi.fn();
  let service: LadderFeedService;
  const frame = (f: MdFrame) => (service as unknown as { onFrame(f: MdFrame): void }).onFrame(f);

  beforeEach(() => {
    vi.useFakeTimers();
    depthRelease.mockClear();
    post.mockReset();
    snapshot.set(null);
    const injector = Injector.create({
      providers: [
        { provide: NgZone, useValue: { runOutsideAngular: <T>(f: () => T) => f() } },
        // Signed out: the hub is never dialled in these tests; frames are fed by hand.
        { provide: AuthService, useValue: { isAuthenticated: () => false, mode: 'legacy' } },
        { provide: RUNTIME_CONFIG, useValue: { apiBaseUrl: 'http://test' } },
        {
          provide: LiveDepthService,
          useValue: {
            watch: () => ({ snapshot, error: signal(null), readAt: signal(0), release: depthRelease }),
          },
        },
        { provide: ApiService, useValue: { post } },
      ],
    });
    // A plain injector (the pure-TS runner has no TestBed harness).
    service = runInInjectionContext(injector, () => new LadderFeedService());
  });

  afterEach(() => vi.useRealTimers());

  it('folds S/D events of the first source that streams a book, and beats at most every 250 ms', () => {
    const w = service.watch('eurusd');
    expect(w.mode()).toBe('connecting');
    frame({ symbol: 'EURUSD', sourceId: 'mt5-a', book: [{ t: 10, k: 'S', b: [[1.1, 5]], a: [[1.1002, 3]] }] });
    frame({ symbol: 'EURUSD', sourceId: 'mt5-a', book: [{ t: 11, k: 'D', b: [[1.1001, 2]], a: [] }] });
    expect(w.mode()).toBe('stream');
    expect(w.sourceId()).toBe('mt5-a');
    expect(w.book()!.bids.get(1.1001)).toBe(2);
    expect(w.quote()).toEqual({ bid: 1.1001, ask: 1.1002, t: 11 });

    const v = w.version();
    vi.advanceTimersByTime(249);
    expect(w.version()).toBe(v);
    vi.advanceTimersByTime(2);
    expect(w.version()).toBe(v + 1);
    vi.advanceTimersByTime(1000);
    expect(w.version()).toBe(v + 1); // nothing new arrived: no beat
    w.release();
  });

  it('a newer tick sets the quote and reaches the tick listeners; other sources stay apart', () => {
    const w = service.watch('EURUSD');
    const seen: number[] = [];
    w.onTicks((t) => seen.push(...t.b));
    frame({ symbol: 'EURUSD', sourceId: 'mt5-a', book: [{ t: 10, k: 'S', b: [[1.1, 5]], a: [[1.1002, 3]] }] });
    frame({ symbol: 'EURUSD', sourceId: 'mt5-a', ticks: { t: [12], b: [1.10005], a: [1.10015] } });
    frame({ symbol: 'EURUSD', sourceId: 'mt5-b', ticks: { t: [13], b: [9], a: [10] } });
    expect(w.quote()).toEqual({ bid: 1.10005, ask: 1.10015, t: 12 });
    expect(seen).toEqual([1.10005]);
    expect(w.sources()).toEqual(['mt5-a']);
    w.release();
  });

  it('with no book from the stream it polls the broker snapshot instead, and says so', () => {
    const w = service.watch('EURUSD');
    snapshot.set({
      id: 1, symbol: 'EURUSD', bidPrice: 1.1, askPrice: 1.1002, bidVolume: 1, askVolume: 1, spreadPoints: 2,
      levelsJson: JSON.stringify({ bids: [{ P: 1.1, V: 7 }], asks: [{ P: 1.1002, V: 4 }] }),
      instanceId: 'ea', capturedAt: '2026-10-23T12:00:00Z',
    });
    vi.advanceTimersByTime(6_500);
    expect(w.mode()).toBe('poll');
    expect(w.book()!.bids.get(1.1)).toBe(7);
    expect(w.quote()).toMatchObject({ bid: 1.1, ask: 1.1002 });

    // The stream comes back: it wins, the poll stops.
    frame({ symbol: 'EURUSD', sourceId: 'mt5-a', book: [{ t: 20, k: 'S', b: [[1.2, 1]], a: [[1.2002, 1]] }] });
    expect(w.mode()).toBe('stream');
    expect(depthRelease).toHaveBeenCalled();
    w.release();
  });

  it('one feed per symbol however many watchers; the last release lets it go', () => {
    const a = service.watch('EURUSD');
    const b = service.watch('EURUSD');
    frame({ symbol: 'EURUSD', sourceId: 'mt5-a', book: [{ t: 1, k: 'S', b: [[1.1, 5]], a: [] }] });
    expect(b.book()).toBe(a.book());
    a.release();
    expect(b.book()).not.toBeNull();
    b.release();
    expect(service.watch('EURUSD').book()).toBeNull();
  });

  it('reads the session ticks from md/history (C5)', async () => {
    post.mockReturnValue(of({ status: true, data: { sources: [{ sourceId: 'mt5-a', ticks: { t: [1], b: [1.1], a: [1.1002] } }] } }));
    const ticks = await service.historyTicks('EURUSD', 'mt5-a', 100, 200);
    expect(ticks?.b).toEqual([1.1]);
    expect(post).toHaveBeenCalledWith('/md/history', { symbol: 'EURUSD', sourceIds: ['mt5-a'], from: 100, to: 200, kinds: ['ticks'] }, { silent: true });
  });
});
