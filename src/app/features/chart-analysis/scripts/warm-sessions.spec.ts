import { describe, expect, it } from 'vitest';

import type { ScriptSessionFrame } from '@core/api/scripting.types';
import type { PineScriptOutputs } from '@shared/pine-chart/model/pine-outputs.types';
import type { ChartScriptResult } from './chart-script.model';
import { WarmSessionBook, applyFrame, formingIndexOf, mergeBars } from './warm-sessions';

const H = 3_600_000;
const T0 = Date.UTC(2026, 9, 9, 0);

/** Raw engine outputs (the wire shape the normaliser reads) for bars [first, first+values.length). */
function rawOutputs(first: number, values: number[], extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    bars: { firstIndex: first, times: values.map((_, i) => T0 + (first + i) * H), timeframe: '60' },
    plots: [
      { id: 0, title: 'SMA', plotNumber: 0, style: 'line', lineStyle: 'solid', lineWidth: 1, offset: 0, display: ['all'], color: '#2962FFFF', values },
    ],
    ...extra,
  };
}

function outputs(first: number, values: number[]): PineScriptOutputs {
  return {
    schemaVersion: 1,
    bars: { firstIndex: first, times: values.map((_, i) => T0 + (first + i) * H), timeframe: '60' },
    plots: [
      {
        id: 0,
        title: 'SMA',
        plotNumber: 0,
        style: 'line',
        lineStyle: 'solid',
        lineWidth: 1,
        offset: 0,
        display: ['all'],
        forceOverlay: false,
        trackPrice: false,
        histBase: 0,
        join: false,
        color: '#2962FFFF',
        colors: null,
        values,
      },
    ],
    markers: [],
    candles: [],
    backgrounds: [],
    barColors: [],
    hlines: [],
    fills: [],
    labels: [],
    lines: [],
    boxes: [],
    polylines: [],
    linefills: [],
    tables: [],
    alertConditions: [{ id: 0, title: 'Cross', message: 'x' }],
    alerts: [],
    droppedAlerts: 0,
    logs: [],
    droppedLogs: 0,
  };
}

function bar(i: number, c: number) {
  return { t: T0 + i * H, o: c, h: c, l: c, c, v: 1 };
}

function result(values: number[]): ChartScriptResult {
  return {
    title: 'SMA',
    kind: 'indicator',
    overlay: true,
    compile: null,
    inputs: [],
    diagnostics: [],
    error: null,
    errorAt: null,
    errorUnit: null,
    errorStack: [],
    strategy: null,
    run: {
      compile: null,
      bars: values.map((v, i) => bar(i, v)),
      outputs: outputs(0, values),
      report: null,
      trace: [],
      profile: [],
      runtimeError: null,
      elapsedMs: 5,
    },
    session: { id: 's1', warm: true, delta: false, fromBar: 0, barIndex: values.length - 1, lastBarForming: true, seq: 0 },
  };
}

function frame(seq: number, fromBar: number, values: number[], over: Partial<ScriptSessionFrame> = {}): ScriptSessionFrame {
  return {
    sessionId: 's1',
    seq,
    fromBar,
    barIndex: fromBar + values.length - 1,
    lastBarForming: true,
    bars: values.map((v, i) => bar(fromBar + i, v)),
    outputsDelta: rawOutputs(fromBar, values) as never,
    reset: false,
    ...over,
  };
}

describe('WarmSessionBook', () => {
  it('routes consecutive frames to their script, asks a resync after a gap and ignores repeats', () => {
    const book = new WarmSessionBook();
    book.attach('mine:7', result([1, 2, 3]).session, 1000);

    expect(book.decide(frame(1, 2, [3.5]))).toEqual({ kind: 'apply', key: 'mine:7' });
    book.applied('mine:7', frame(1, 2, [3.5]), 2000);
    expect(book.decide(frame(1, 2, [3.5]))).toEqual({ kind: 'ignore' });
    expect(book.decide(frame(4, 2, [3.6]))).toEqual({ kind: 'resync', key: 'mine:7', sessionId: 's1', sinceSeq: 1 });
    expect(book.decide({ ...frame(2, 0, []), sessionId: 'other' })).toEqual({ kind: 'ignore' });
    expect(book.decide(frame(2, 0, [], { reset: true, note: 'idle' }))).toEqual({ kind: 'ended', key: 'mine:7', note: 'idle' });
  });

  it('a run without a warm session detaches the script; a new session replaces the old one', () => {
    const book = new WarmSessionBook();
    book.attach('k', result([1]).session, 0);
    const replaced = book.attach('k', { id: 's2', warm: true, delta: false, fromBar: 0, barIndex: 0, lastBarForming: false, seq: 3 }, 10);
    expect(replaced?.sessionId).toBe('s1');
    expect(book.keyOf('s1')).toBeNull();
    expect(book.get('k')?.seq).toBe(3);

    const gone = book.attach('k', { id: null, warm: false, delta: false, fromBar: 0, barIndex: 0, lastBarForming: false, seq: 0, note: 'off' }, 20);
    expect(gone?.sessionId).toBe('s2');
    expect(book.get('k')).toBeNull();
  });

  it('a session is live while it has been heard from recently', () => {
    const book = new WarmSessionBook();
    book.attach('k', result([1]).session, 1000);
    expect(book.isLive('k', 50_000, 60_000)).toBe(true);
    expect(book.isLive('k', 70_000, 60_000)).toBe(false);
    book.touch('k', 70_000);
    expect(book.isLive('k', 70_000, 60_000)).toBe(true);
  });
});

describe('applyFrame', () => {
  it('replaces the run from the frame’s first bar: the forming bar confirmed and a new one forming', () => {
    const r = result([1, 2, 3]);
    // Bar 2 (forming) closed at 3.4; bar 3 forms at 3.6.
    const next = applyFrame(r, frame(1, 2, [3.4, 3.6]))!;

    expect(next.run!.bars.map((b) => b.c)).toEqual([1, 2, 3.4, 3.6]);
    expect(next.run!.outputs!.plots[0].values).toEqual([1, 2, 3.4, 3.6]);
    expect(next.run!.outputs!.bars.firstIndex).toBe(0);
    expect(next.run!.outputs!.bars.times).toHaveLength(4);
    expect(next.session).toBe(r.session);
    // The run it came from is untouched (the chart's previous copy stays valid until replaced).
    expect(r.run!.outputs!.plots[0].values).toEqual([1, 2, 3]);
  });

  it('a frame that would leave a hole is refused (resync instead)', () => {
    expect(applyFrame(result([1, 2, 3]), frame(1, 5, [9]))).toBeNull();
  });

  it('an empty frame keeps the bars and takes the whole-exported state', () => {
    const next = applyFrame(result([1, 2, 3]), {
      ...frame(1, 3, []),
      outputsDelta: rawOutputs(3, [], { labels: [] }) as never,
    })!;
    expect(next.run!.outputs!.plots[0].values).toEqual([1, 2, 3]);
  });
});

describe('mergeBars / formingIndexOf', () => {
  it('a re-sent bar replaces the old copy', () => {
    expect(mergeBars([bar(0, 1), bar(1, 2)], [bar(1, 2.5), bar(2, 3)]).map((b) => b.c)).toEqual([1, 2.5, 3]);
    expect(mergeBars([bar(0, 1)], []).map((b) => b.c)).toEqual([1]);
  });

  it('the forming bar is the run’s last when the engine says the last bar forms', () => {
    expect(formingIndexOf(result([1, 2, 3]), true)).toBe(2);
    expect(formingIndexOf(result([1, 2, 3]), false)).toBeNull();
  });
});
