import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpErrorResponse } from '@angular/common/http';
import { Subject, of, throwError } from 'rxjs';
import { normalizeOutputs } from '../model/normalize';
import type { PineReplayFrame, PineRunRequest } from '../model/pine-outputs.types';
import { FixtureReplayApi } from '../testing/fixture-replay-api';
import { overlayStrategyFixture } from '../testing/pine-fixtures';
import { ReplaySession, appendBars, type ReplayApi } from './replay-session';

const request: PineRunRequest = { source: 'x', symbol: 'EURUSD', timeframe: '60' };
const decl = { kind: 'strategy', title: 'EMA X', overlay: true };
const flush = () => new Promise((r) => setTimeout(r, 0));

function fixtureSession(n = 120) {
  const run = overlayStrategyFixture(n);
  const api = new FixtureReplayApi(run);
  const spy = {
    startReplay: vi.spyOn(api, 'startReplay'),
    stepReplay: vi.spyOn(api, 'stepReplay'),
    stopReplay: vi.spyOn(api, 'stopReplay'),
  };
  return { run, api, spy, session: new ReplaySession(api) };
}

describe('ReplaySession', () => {
  it('starts at a bar with a snapshot of every bar up to it', async () => {
    const { session, spy } = fixtureSession();
    await session.start(request, 60, decl);
    expect(spy.startReplay).toHaveBeenCalledWith({ ...request, startBar: 60 });
    expect(session.status()).toBe('ready');
    expect(session.barIndex()).toBe(60);
    const data = session.data()!;
    expect(data.bars).toHaveLength(61);
    expect(data.outputs!.bars.times).toHaveLength(61);
    expect(data.declaration).toBe(decl);
    // The frame's strategy position is kept for the controls' readout.
    expect(session.position()).toMatchObject({ size: expect.any(Number) });
  });

  it('steps 1, 5 and 20 bars, appending bars and outputs', async () => {
    const { session, run } = fixtureSession();
    await session.start(request, 60, decl);
    expect(await session.step(1)).toBe(true);
    expect(await session.step(5)).toBe(true);
    expect(await session.step(20)).toBe(true);
    expect(session.barIndex()).toBe(86);
    const data = session.data()!;
    expect(data.bars).toHaveLength(87);
    expect(data.bars.map((b) => b.t)).toEqual(run.bars.slice(0, 87).map((b) => b.t));
    const full = normalizeOutputs(run.outputs)!;
    expect(data.outputs!.plots[0].values).toEqual(full.plots[0].values.slice(0, 87));
    // Trades that closed later are reported open as of the replayed bar.
    expect(data.report!.trades.every((t) => t.isOpen || (t.exitBarIndex ?? 0) <= 86)).toBe(true);
  });

  it('ends at the last bar', async () => {
    const { session } = fixtureSession(40);
    await session.start(request, 35, decl);
    expect(await session.step(20)).toBe(true); // 36..39
    expect(session.barIndex()).toBe(39);
    expect(await session.step(1)).toBe(false);
    expect(session.status()).toBe('ended');
  });

  describe('playing', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('plays one bar per tick at the chosen speed and pauses', async () => {
      const { session } = fixtureSession();
      await session.start(request, 50, decl);
      session.setSpeed(10); // 100 ms per bar
      session.play();
      expect(session.status()).toBe('playing');
      await vi.advanceTimersByTimeAsync(0);
      expect(session.barIndex()).toBe(51);
      await vi.advanceTimersByTimeAsync(300);
      expect(session.barIndex()).toBe(54);
      session.pause();
      expect(session.status()).toBe('ready');
      await vi.advanceTimersByTimeAsync(1000);
      expect(session.barIndex()).toBe(54);
    });

    it('stops playing at the end of the data', async () => {
      const { session } = fixtureSession(60);
      await session.start(request, 57, decl);
      session.setSpeed(20);
      session.play();
      await vi.advanceTimersByTimeAsync(500);
      expect(session.barIndex()).toBe(59);
      expect(session.status()).toBe('ended');
    });
  });

  it('stop deletes the session on the engine and clears the replay', async () => {
    const { session, spy } = fixtureSession();
    await session.start(request, 30, decl);
    session.stop();
    expect(spy.stopReplay).toHaveBeenCalledWith('fixture-1');
    expect(session.status()).toBe('idle');
    expect(session.data()).toBeNull();
    expect(await session.step(1)).toBe(false);
  });

  it('reports an expired session', async () => {
    const api: ReplayApi = {
      startReplay: () =>
        of({ sessionId: 's1', frame: { barIndex: 5, bars: [], outputsDelta: null } }),
      stepReplay: () => throwError(() => new HttpErrorResponse({ status: 404 })),
      stopReplay: vi.fn(() => of(true)),
    };
    const session = new ReplaySession(api);
    await session.start(request, 5, null);
    expect(await session.step(1)).toBe(false);
    expect(session.status()).toBe('error');
    expect(session.error()).toContain('expired');
    session.stop();
    // The engine already dropped it: nothing to delete.
    expect(api.stopReplay).not.toHaveBeenCalled();
  });

  it('ignores a frame that lands after stop', async () => {
    const pending = new Subject<PineReplayFrame>();
    const api: ReplayApi = {
      startReplay: () =>
        of({
          sessionId: 's1',
          frame: {
            barIndex: 5,
            bars: [{ t: 1, o: 1, h: 1, l: 1, c: 1, v: 1 }],
            outputsDelta: null,
          },
        }),
      stepReplay: () => pending,
      stopReplay: () => of(true),
    };
    const session = new ReplaySession(api);
    await session.start(request, 5, null);
    const stepping = session.step(1);
    session.stop();
    pending.next({
      barIndex: 6,
      bars: [{ t: 2, o: 1, h: 1, l: 1, c: 1, v: 1 }],
      outputsDelta: null,
    });
    pending.complete();
    expect(await stepping).toBe(false);
    expect(session.data()).toBeNull();
    expect(session.status()).toBe('idle');
  });

  it('does not overlap step requests', async () => {
    const pending = new Subject<PineReplayFrame>();
    const stepReplay = vi.fn(() => pending);
    const api: ReplayApi = {
      startReplay: () =>
        of({ sessionId: 's1', frame: { barIndex: 5, bars: [], outputsDelta: null } }),
      stepReplay,
      stopReplay: () => of(true),
    };
    const session = new ReplaySession(api);
    await session.start(request, 5, null);
    void session.step(1);
    expect(await session.step(1)).toBe(false);
    expect(stepReplay).toHaveBeenCalledTimes(1);
    pending.next({
      barIndex: 6,
      bars: [{ t: 2, o: 1, h: 1, l: 1, c: 1, v: 1 }],
      outputsDelta: null,
    });
    pending.complete();
    await flush();
    expect(session.barIndex()).toBe(6);
  });
});

describe('appendBars', () => {
  const bar = (t: number, c = 1) => ({ t, o: c, h: c, l: c, c, v: 0 });
  it('appends new bars and replaces a re-sent tail', () => {
    expect(appendBars([bar(1), bar(2)], [bar(3)]).map((b) => b.t)).toEqual([1, 2, 3]);
    const replaced = appendBars([bar(1), bar(2, 5)], [bar(2, 9), bar(3)]);
    expect(replaced.map((b) => [b.t, b.c])).toEqual([
      [1, 1],
      [2, 9],
      [3, 1],
    ]);
  });
});
