import { afterEach, describe, expect, it, vi } from 'vitest';
import { computed, signal } from '@angular/core';
import { of, throwError, type Observable } from 'rxjs';

import { ScriptingApiError } from '@core/services/scripting.service';
import type { ScriptInputValues } from '@core/api/scripting.types';
import type { ChartScriptItem, SavedChartScript } from '../../scripts/chart-script.service';
import type { ChartScriptResult } from '../../scripts/chart-script.model';
import { LiveRerunScheduler } from '../../scripts/live-bar';
import { MAX_BUSY_RETRIES } from '../../scripts/script-run-state';
import { ChartAnalysisPageComponent, type ChartScriptRun } from './chart-analysis-page.component';

// The page's runScript and the editor's "Add / Update on chart", run against just the state they
// touch (as the strategy and editor specs do): the component's prototype, its signals, a real
// scheduler, and an engine scripted per script key.

const item = (
  key: string,
  kind: 'indicator' | 'strategy' = 'indicator',
  pineSource = `// ${key}`,
): ChartScriptItem => ({ key, source: 'mine', name: key, description: '', kind, pineSource });

/** Every script here declares one input, `len` (int). */
const LEN = { id: 'len', kind: 'int', title: 'Length', defaultValue: 1 };

const ok = (it: ChartScriptItem, tag = ''): ChartScriptResult =>
  ({
    title: it.name + tag,
    kind: it.kind,
    overlay: true,
    compile: { success: true, diagnostics: [], declaration: null, inputs: [LEN] },
    inputs: [LEN],
    diagnostics: [],
    error: null,
    errorAt: null,
    errorUnit: null,
    errorStack: [],
    strategy: null,
    run: null,
  }) as unknown as ChartScriptResult;

const compileError = (it: ChartScriptItem, line = 3): ChartScriptResult => {
  const diag = {
    code: 'PS1001',
    severity: 'error' as const,
    message: 'Unexpected token',
    line,
    column: 7,
    endLine: line,
    endColumn: 8,
  };
  return {
    ...ok(it),
    compile: { success: false, diagnostics: [diag], declaration: null, inputs: [] },
    diagnostics: [diag],
    error: `Line ${line}: Unexpected token`,
    errorAt: { line, column: 7 },
  } as ChartScriptResult;
};

const runtimeError = (it: ChartScriptItem): ChartScriptResult =>
  ({
    ...ok(it),
    error: 'Stopped by runtime.error() (line 12)',
    errorAt: { line: 12, column: 5 },
    run: {
      bars: [],
      runtimeError: {
        code: 'PS5011',
        message: 'Stopped by runtime.error()',
        line: 12,
        column: 5,
        barIndex: 40,
        unit: null,
        callStack: [],
      },
    },
  }) as unknown as ChartScriptResult;

const busy = (ms = 1_500) =>
  throwError(() => new ScriptingApiError('Script runs are busy.', '-429', null, 200, ms));

const onChart = (it: ChartScriptItem, values: ScriptInputValues = {}): ChartScriptRun => ({
  item: it,
  result: ok(it),
  values,
  symbol: 'EURUSD',
  resolution: '60',
  requestedBars: 1500,
});

/**
 * The page as these specs drive it: its prototype's methods and the state they touch, private ones
 * included (the run machinery is private to the page) — so untyped.
 */
type Page = any;

function page(runs: ChartScriptRun[] = [], saved: Partial<SavedChartScript>[] = []) {
  const p = Object.create(ChartAnalysisPageComponent.prototype) as Page;
  /** How the engine answers each script key, in order; the last answer repeats. */
  const answers = new Map<string, (() => Observable<ChartScriptResult>)[]>();
  const runOnChart = vi.fn((it: ChartScriptItem): Observable<ChartScriptResult> => {
    const list = answers.get(it.key);
    const next = list && list.length > 1 ? list.shift()! : list?.[0];
    return next ? next() : of(ok(it, ' v2'));
  });
  const showCompile = vi.fn();
  const scriptRuns = signal(runs);
  const editorKey = signal<string | null>(null);
  const pendingScripts = signal(new Map());
  const runningKeys = signal<ReadonlyMap<string, number>>(new Map());
  // Bar Replay, as the page derives its head.
  const replayActive = signal(false);
  const displayBars = signal<{ time: number }[]>([]);
  Object.assign(p, {
    // The dock's Pine Logs (PC-I6): closed.
    logsKey: signal(null),
    logsFront: signal(false),
    replayActive,
    displayBars,
    replayHead: computed(() => (replayActive() ? (displayBars().at(-1)?.time ?? null) : null)),
    scriptRuns,
    restoringScripts: signal([]),
    runsInFlight: new Map(),
    runningKeys,
    scriptRunning: computed(() => runningKeys().size > 0),
    runScheduler: new LiveRerunScheduler(vi.fn()),
    scriptError: signal(null),
    scriptFailures: signal(new Map()),
    pendingScripts,
    waitingScripts: signal(new Map()),
    scriptUpdates: signal(new Map()),
    chartBasis: signal('standard'),
    symbol: signal('EURUSD'),
    resolution: signal('60'),
    bars: signal([]),
    barsFor: signal(null),
    serverClock: { now: () => Date.now() },
    chartScripts: {
      runOnChart,
      savedScripts: () => saved,
      itemForSource: (source: string, kind: 'indicator' | 'strategy', name: string, key: string) =>
        ({ key, source: 'mine', name, description: '', kind, pineSource: source }) as ChartScriptItem,
    },
    destroyRef: { destroyed: false, onDestroy: () => () => undefined },
    testerOpen: signal(true),
    dockPreference: signal('editor'),
    settings: { loadStoredInputs: vi.fn(), run: () => null, close: vi.fn() },
    replacedNotice: signal(null),
    editorKey,
    editorOpen: signal(true),
    editorDraft: signal(null),
    assistSource: signal(null),
    editorCleared: signal(false),
    strategySources: signal({}),
    scriptEditor: () => ({ showCompile, revealLine: vi.fn() }),
    notify: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
  });
  // As the page derives it: the run the editor shows, or a script whose first run failed.
  Object.assign(p, {
    editorTarget: computed(() => {
      const key = editorKey();
      const run = scriptRuns().find((r) => r.item.key === key);
      const it = run?.item ?? (key ? pendingScripts().get(key)?.item : undefined);
      return it ? { key: it.key, name: it.name, source: it.pineSource ?? null } : null;
    }),
  });
  return { p, runOnChart, answers, showCompile };
}

const keys = (p: Page) => p.scriptRuns().map((r: ChartScriptRun) => r.item.key);

afterEach(() => vi.useRealTimers());

describe('chart page — "Update on chart" runs first, swaps on success (PC-06)', () => {
  it('the edit lands in the edited script’s place; that one leaves; the editor follows', () => {
    const { p } = page([onChart(item('mine:20'), { len: 3 }), onChart(item('mine:5'))]);
    p.editorKey.set('mine:20');

    p.onEditorAdd({ source: '// v2', kind: 'indicator', name: 'v2' });

    const [first, second] = keys(p);
    expect(first).toMatch(/^editor:/);
    expect(second).toBe('mine:5');
    expect(p.scriptRuns()[0].values).toEqual({ len: 3 });
    expect(p.editorKey()).toBe(first);
    expect(p.scriptFailures().size).toBe(0);
  });

  it('a compile error leaves the script on the chart as it was, and the editor shows why', () => {
    const { p, showCompile } = page([onChart(item('mine:20')), onChart(item('mine:5'))]);
    p.editorKey.set('mine:20');
    const before = p.scriptRuns();
    // Whatever key the edit runs under: answer it with a compile error.
    p.chartScripts.runOnChart.mockImplementationOnce((it: ChartScriptItem) => of(compileError(it)));

    p.onEditorAdd({ source: '// broken', kind: 'indicator', name: 'v2' });

    expect(p.scriptRuns()).toBe(before);
    expect(p.editorKey()).toBe('mine:20');
    expect(showCompile).toHaveBeenCalledWith(
      expect.objectContaining({
        diagnostics: [expect.objectContaining({ line: 3, message: 'Unexpected token' })],
      }),
    );
    // The edit's failure is the editor's: no chip error, no chip left behind for it.
    expect(p.scriptFailures().size).toBe(0);
    expect(p.pendingScripts().size).toBe(0);
  });

  it('a runtime error goes to the editor too, at its line', () => {
    const { p, showCompile } = page([onChart(item('mine:20'))]);
    p.editorKey.set('mine:20');
    p.chartScripts.runOnChart.mockImplementationOnce((it: ChartScriptItem) => of(runtimeError(it)));

    p.onEditorAdd({ source: '// throws', kind: 'indicator', name: 'v2' });

    expect(keys(p)).toEqual(['mine:20']);
    const report = showCompile.mock.calls[0][0];
    expect(report.diagnostics.at(-1)).toMatchObject({
      code: 'PS5011',
      severity: 'error',
      line: 12,
      message: expect.stringContaining('Runtime error on bar 40'),
    });
  });

  it('a strategy’s edit replaces it without the "replaced one strategy with another" notice', () => {
    const { p } = page([onChart(item('strategy:9', 'strategy'))]);
    p.editorKey.set('strategy:9');
    p.onEditorAdd({ source: '// edited', kind: 'strategy', name: 'S' });
    expect(keys(p)).toHaveLength(1);
    expect(keys(p)[0]).toMatch(/^editor:/);
    expect(p.replacedNotice()).toBeNull();
  });
});

describe('chart page — every editor script is its own (PC-07)', () => {
  it('an edit of another script no longer replaces the editor script already on the chart', () => {
    // A was added from the editor earlier; now the editor shows saved script B, edited.
    const { p } = page([onChart(item('editor:a')), onChart(item('mine:7'))]);
    p.editorKey.set('mine:7');

    p.onEditorAdd({ source: '// B edited', kind: 'indicator', name: 'B' });

    const k = keys(p);
    expect(k[0]).toBe('editor:a');
    expect(k[1]).toMatch(/^editor:/);
    expect(k[1]).not.toBe('editor:a');
  });

  it('a saved script whose text is exactly what is saved stays itself (Save as default keeps working)', () => {
    const { p } = page([onChart(item('mine:7'))], [{ id: '7', source: '// B saved' }]);
    p.editorKey.set('mine:7');
    p.onEditorAdd({ source: '// B saved', kind: 'indicator', name: 'B' });
    expect(keys(p)).toEqual(['mine:7']);
    expect(p.scriptRuns()[0].item.pineSource).toBe('// B saved');
  });

  it('an editor script updated again keeps its key', () => {
    const { p } = page([onChart(item('editor:a'))]);
    p.editorKey.set('editor:a');
    p.onEditorAdd({ source: '// a v3', kind: 'indicator', name: 'A' });
    expect(keys(p)).toEqual(['editor:a']);
    expect(p.scriptRuns()[0].item.pineSource).toBe('// a v3');
  });
});

describe('chart page — failures are the script’s own (PC-05, PC-13, PC-I7)', () => {
  it('a quiet re-run that fails keeps the plots and marks the chip stale; the next good one clears it', () => {
    const m = item('mine:5');
    const { p, answers } = page([onChart(m)]);
    const before = p.scriptRuns()[0].result;
    answers.set('mine:5', [() => of(runtimeError(m))]);

    p.runScript(m, {}, true, undefined, p.runScheduler.begin('mine:5'));

    expect(p.scriptRuns()[0].result).toBe(before);
    expect(p.scriptFailures().get('mine:5')).toMatchObject({
      kind: 'stale',
      message: 'Stopped by runtime.error()',
      where: { line: 12, column: 5 },
    });

    answers.set('mine:5', [() => of(ok(m, ' v3'))]);
    p.runScript(m, {}, true, undefined, p.runScheduler.begin('mine:5'));
    expect(p.scriptFailures().has('mine:5')).toBe(false);
    expect(p.scriptRuns()[0].result.title).toBe('mine:5 v3');
  });

  it('a script picked from the dialog that fails stays as a chip with its error, until removed', () => {
    const bad = item('mine:9');
    const { p, answers } = page([onChart(item('mine:5'))]);
    answers.set('mine:9', [() => of(compileError(bad, 4))]);

    p.runScript(bad, {});

    expect(keys(p)).toEqual(['mine:5']);
    expect(p.pendingScripts().has('mine:9')).toBe(true);
    expect(p.scriptFailures().get('mine:9')).toMatchObject({
      kind: 'error',
      message: 'Unexpected token',
      where: { line: 4, column: 7 },
    });
    // Its source opens in the editor, though it is not on the chart.
    p.openScriptSource('mine:9');
    expect(p.editorTarget()?.source).toBe('// mine:9');

    p.removeScriptFromChart('mine:9');
    expect(p.pendingScripts().has('mine:9')).toBe(false);
    expect(p.scriptFailures().has('mine:9')).toBe(false);
  });

  it('new inputs that fail mark the chip with the error and keep the last run on the chart', () => {
    const m = item('mine:5');
    const { p, answers } = page([onChart(m)]);
    const before = p.scriptRuns()[0].result;
    answers.set('mine:5', [() => throwError(() => new ScriptingApiError('Input out of range', '-11'))]);
    p.runScript(m, { len: 0 }, true);
    expect(p.scriptRuns()[0].result).toBe(before);
    expect(p.scriptFailures().get('mine:5')).toMatchObject({ kind: 'error', where: null });
  });

  it('two scripts fail on their own: one’s error never overwrites the other’s', () => {
    const a = item('mine:1');
    const b = item('mine:2');
    const { p, answers } = page([onChart(a), onChart(b)]);
    answers.set('mine:1', [() => of(compileError(a, 3))]);
    answers.set('mine:2', [() => of(compileError(b, 8))]);
    p.runScript(a, {}, true);
    p.runScript(b, {}, true);
    expect(p.scriptFailures().get('mine:1')?.where?.line).toBe(3);
    expect(p.scriptFailures().get('mine:2')?.where?.line).toBe(8);
  });
});

describe('chart page — a busy engine (contract C5)', () => {
  it('an explicit run waits on its chip and is sent again after the wait asked — no error', () => {
    vi.useFakeTimers();
    const m = item('mine:9');
    const { p, answers, runOnChart } = page();
    answers.set('mine:9', [() => busy(1_500), () => of(ok(m))]);

    p.runScript(m, {});
    expect(p.waitingScripts().has('mine:9')).toBe(true);
    expect(p.scriptRunning()).toBe(true);
    expect(p.scriptFailures().size).toBe(0);

    vi.advanceTimersByTime(1_499);
    expect(runOnChart).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(runOnChart).toHaveBeenCalledTimes(2);
    expect(keys(p)).toEqual(['mine:9']);
    expect(p.waitingScripts().size).toBe(0);
    expect(p.scriptFailures().size).toBe(0);
  });

  it('a quiet re-run refused as busy backs off quietly: no chip error, the scheduler waits', () => {
    const m = item('mine:5');
    const { p, answers } = page([onChart(m)]);
    const backoff = vi.spyOn(p.runScheduler, 'backoff');
    answers.set('mine:5', [() => busy(7_000)]);

    p.runScript(m, {}, true, undefined, p.runScheduler.begin('mine:5'));

    expect(backoff).toHaveBeenCalledWith('mine:5', 7_000);
    expect(p.scriptFailures().size).toBe(0);
  });

  it('gives up after the retries and says the engine is busy', () => {
    vi.useFakeTimers();
    const m = item('mine:9');
    const { p, answers, runOnChart } = page();
    answers.set('mine:9', [() => busy(1_000)]);
    p.runScript(m, {});
    vi.advanceTimersByTime(1_000 * MAX_BUSY_RETRIES);
    expect(runOnChart).toHaveBeenCalledTimes(MAX_BUSY_RETRIES + 1);
    expect(p.scriptFailures().get('mine:9')).toMatchObject({
      kind: 'error',
      message: 'Script runs are busy.',
    });
    expect(p.waitingScripts().size).toBe(0);
  });

  it('removing a script while its run waits cancels the retry', () => {
    vi.useFakeTimers();
    const m = item('mine:9');
    const { p, answers, runOnChart } = page();
    answers.set('mine:9', [() => busy(1_000)]);
    p.runScript(m, {});
    p.removeScriptFromChart('mine:9');
    vi.advanceTimersByTime(10_000);
    expect(runOnChart).toHaveBeenCalledTimes(1);
    expect(p.waitingScripts().size).toBe(0);
    expect(p.pendingScripts().size).toBe(0);
  });
});

/** The options a run was asked with (`runOnChart`'s last argument). */
const optsOf = (runOnChart: ReturnType<typeof page>['runOnChart'], call = 0) =>
  (runOnChart.mock.calls[call] as unknown[])[5] as {
    liveBar: unknown;
    chartType: string;
    toMs: number | null;
  };

describe('chart page — runs on the bars the chart draws (PC-09)', () => {
  it('under Heikin-Ashi candles a run is made on the Heikin-Ashi bars, and says so', () => {
    const m = item('mine:9');
    const { p, runOnChart } = page();
    p.chartBasis.set('heikinashi');
    p.runScript(m, {});
    expect(optsOf(runOnChart).chartType).toBe('heikinashi');
    expect(p.scriptRuns()[0].chartType).toBe('heikinashi');
  });

  it('on a price-based style a run is made on the standard bars (it is not drawn there)', () => {
    const m = item('mine:9');
    const { p, runOnChart } = page();
    p.chartBasis.set(null);
    p.runScript(m, {});
    expect(optsOf(runOnChart).chartType).toBe('standard');
    expect(p.scriptRuns()[0].chartType).toBe('standard');
  });
});

describe('chart page — Bar Replay runs the scripts to the head (PC-08, PC-I8)', () => {
  const H = 3_600_000;
  const T0 = Date.UTC(2026, 8, 1);
  const hours = (n: number) => Array.from({ length: n }, (_, i) => ({ time: T0 + i * H }));

  it('a run in replay ends on the head bar: to its close, no forming bar, and it says which head', () => {
    const m = item('mine:9');
    const { p, runOnChart } = page();
    p.replayActive.set(true);
    p.displayBars.set(hours(40));
    p.runScript(m, {});
    expect(optsOf(runOnChart)).toEqual({ liveBar: null, chartType: 'standard', toMs: T0 + 40 * H });
    expect(p.scriptRuns()[0].until).toBe(T0 + 39 * H);
  });

  it('outside replay a run goes to now and carries no head', () => {
    const m = item('mine:9');
    const { p, runOnChart } = page();
    p.runScript(m, {});
    expect(optsOf(runOnChart).toMs).toBeNull();
    expect('until' in p.scriptRuns()[0]).toBe(false);
  });

  it('the quiet re-runs the head asks for run in replay — they used to be dropped there', () => {
    const m = item('mine:5');
    const { p, runOnChart } = page([onChart(m)]);
    p.replayActive.set(true);
    p.displayBars.set(hours(10));
    p.rerunQuietly('mine:5', p.runScheduler.begin('mine:5'));
    expect(optsOf(runOnChart).toMs).toBe(T0 + 10 * H);
    expect(p.scriptRuns()[0].until).toBe(T0 + 9 * H);
  });

  it('a run that lands after the head moved on asks for another, to where the head is now', () => {
    const m = item('mine:5');
    const { p, answers } = page([onChart(m)]);
    p.replayActive.set(true);
    p.displayBars.set(hours(10));
    const request = vi.spyOn(p.runScheduler, 'request');
    answers.set('mine:5', [
      () => {
        // The operator steps on while the run is in flight.
        p.displayBars.set(hours(11));
        return of(ok(m, ' v2'));
      },
    ]);
    p.runScript(m, {}, true, undefined, p.runScheduler.begin('mine:5'));
    expect(p.scriptRuns()[0].until).toBe(T0 + 9 * H);
    expect(request).toHaveBeenCalledWith('mine:5');
  });

  it('one that lands at the head, or outside replay to now, asks for nothing more', () => {
    const m = item('mine:5');
    const { p } = page([onChart(m)]);
    const request = vi.spyOn(p.runScheduler, 'request');
    p.runScript(m, {}, true);
    p.replayActive.set(true);
    p.displayBars.set(hours(10));
    p.runScript(m, {}, true);
    expect(request).not.toHaveBeenCalled();
  });

  it('a run to a head that lands after replay ended runs again to now', () => {
    const m = item('mine:5');
    const { p, answers } = page([onChart(m)]);
    p.replayActive.set(true);
    p.displayBars.set(hours(10));
    const request = vi.spyOn(p.runScheduler, 'request');
    answers.set('mine:5', [
      () => {
        p.replayActive.set(false);
        return of(ok(m, ' v2'));
      },
    ]);
    p.runScript(m, {}, true);
    expect(p.scriptRuns()[0].until).toBe(T0 + 9 * H);
    expect(request).toHaveBeenCalledWith('mine:5');
  });
});
