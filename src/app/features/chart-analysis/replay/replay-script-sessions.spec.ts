import { describe, expect, it, vi } from 'vitest';
import { of, throwError } from 'rxjs';
import { normalizeOutputs } from '@shared/pine-chart/model/normalize';
import type { PineBar, PineReplayFrame } from '@shared/pine-chart/model/pine-outputs.types';
import type { ReplayApi } from '@shared/pine-chart/replay/replay-session';
import type { ChartScriptResult } from '../scripts/chart-script.model';
import { ReplayScriptSessions, foldReplayFrame, type ReplayStepPlan } from './replay-script-sessions';

const H = 3_600_000;
const bar = (i: number): PineBar => ({ t: i * H, o: 1, h: 1, l: 1, c: i, v: 1 }) as PineBar;
const outputs = (first: number, n: number) =>
  normalizeOutputs({
    bars: { firstIndex: first, times: Array.from({ length: n }, (_, k) => (first + k) * H) },
    plots: [{ id: 'p', title: 'p', values: Array.from({ length: n }, (_, k) => first + k) }],
  })!;
const frame = (first: number, n: number): PineReplayFrame => ({
  barIndex: first + n - 1,
  bars: Array.from({ length: n }, (_, k) => bar(first + k)),
  outputsDelta: outputs(first, n),
});
/** A run on the chart over bars 0..9 (its head is bar 9). */
const result = (): ChartScriptResult =>
  ({ run: { bars: Array.from({ length: 10 }, (_, k) => bar(k)), outputs: outputs(0, 10) } }) as unknown as ChartScriptResult;
const plan = (over: Partial<ReplayStepPlan> = {}): ReplayStepPlan => ({
  key: 'mine:1',
  signature: 'sig',
  request: { symbol: 'EURUSD', timeframe: '60', lastBars: 30 },
  startBar: 9,
  firstTime: 0,
  fromTime: 9 * H,
  toTime: 11 * H,
  steps: 2,
  ...over,
});

function api(startBars = 10) {
  const a = {
    startReplay: vi.fn(() => of({ sessionId: 's1', frame: frame(0, startBars) })),
    stepReplay: vi.fn((_id: string, req: { bars: number }) => of(frame(10, req.bars))),
    stopReplay: vi.fn(() => of(true)),
  };
  return a as typeof a & ReplayApi;
}

describe('ReplayScriptSessions', () => {
  it('opens a session at the run’s head and steps it to the new head, folding the frame in', async () => {
    const a = api();
    const s = new ReplayScriptSessions(a);
    const out = await s.step(plan(), result());
    expect(a.startReplay).toHaveBeenCalledWith(expect.objectContaining({ startBar: 9, lastBars: 30 }));
    expect(a.stepReplay).toHaveBeenCalledWith('s1', { bars: 2 });
    expect(out?.run?.bars.at(-1)?.t).toBe(11 * H);
    expect(out?.run?.outputs?.plots[0].values).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    // The next step reuses the session.
    await s.step(plan({ fromTime: 11 * H, toTime: 12 * H, steps: 1 }), out!);
    expect(a.startReplay).toHaveBeenCalledTimes(1);
  });

  it('falls back to a full run — and stops trying — when the engine’s window does not line up', async () => {
    const a = api(8);
    const s = new ReplayScriptSessions(a);
    expect(await s.step(plan(), result())).toBeNull();
    expect(a.stopReplay).toHaveBeenCalledWith('s1');
    expect(s.usable('sig', 1)).toBe(false);
  });

  it('starts again when the head moved back, and ends the session on a failure', async () => {
    const a = api();
    const s = new ReplayScriptSessions(a);
    await s.step(plan(), result());
    a.startReplay.mockClear();
    await s.step(plan({ fromTime: 9 * H }), result()); // the session stands at 11h: a new one
    expect(a.stopReplay).toHaveBeenCalled();
    expect(a.startReplay).toHaveBeenCalledTimes(1);
    a.stepReplay.mockImplementationOnce(() => throwError(() => new Error('busy')));
    expect(await s.step(plan({ fromTime: 11 * H, toTime: 12 * H, steps: 1 }), result())).toBeNull();
    expect(s.has('mine:1')).toBe(false);
  });

  it('refuses moves the step endpoint does not take', () => {
    const s = new ReplayScriptSessions(api());
    expect(s.usable('sig', 0)).toBe(false);
    expect(s.usable('sig', 501)).toBe(false);
  });
});

describe('foldReplayFrame', () => {
  it('will not fold a frame that leaves a gap', () => {
    expect(foldReplayFrame(result(), frame(12, 1))).toBeNull();
  });
});
