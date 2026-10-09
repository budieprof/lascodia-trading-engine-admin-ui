import { describe, expect, it, vi } from 'vitest';
import { signal } from '@angular/core';
import { Subject, of, type Observable } from 'rxjs';

import type { ScriptInputValues } from '@core/api/scripting.types';
import type { ChartScriptItem } from '../../scripts/chart-script.service';
import type { ChartScriptResult } from '../../scripts/chart-script.model';
import { LiveRerunScheduler } from '../../scripts/live-bar';
import { ChartAnalysisPageComponent, type ChartScriptRun } from './chart-analysis-page.component';
import { realtimePageState } from './chart-analysis-page.realtime.testing';

// The page's own runScript, run against just the state it touches (as the editor and dock specs
// do): the component's prototype with the runs' signals, a scheduler, and an engine that answers
// each run at once — or holds it, to show what a late answer does.

const item = (key: string, name: string, kind: 'indicator' | 'strategy' = 'strategy') =>
  ({ key, source: 'strategy', name, description: '', kind }) as ChartScriptItem;

const resultOf = (it: ChartScriptItem): ChartScriptResult =>
  ({
    title: it.name,
    kind: it.kind,
    overlay: true,
    compile: null,
    inputs: [],
    diagnostics: [],
    error: null,
    errorAt: null,
    errorUnit: null,
    errorStack: [],
    strategy: null,
    run: null,
  }) as ChartScriptResult;

const onChart = (it: ChartScriptItem, values: ScriptInputValues = {}): ChartScriptRun => ({
  item: it,
  result: resultOf(it),
  values,
  symbol: 'EURUSD',
  resolution: '60',
  requestedBars: 1500,
});

type Page = ChartAnalysisPageComponent & Record<string, any>;

function page(runs: ChartScriptRun[] = []) {
  const p = Object.create(ChartAnalysisPageComponent.prototype) as Page;
  /** Runs the engine holds back (by key) instead of answering at once. */
  const held = new Map<string, Subject<ChartScriptResult>>();
  const runOnChart = vi.fn(
    (it: ChartScriptItem): Observable<ChartScriptResult> => held.get(it.key) ?? of(resultOf(it)),
  );
  Object.assign(p, {
    // Warm sessions (PC-I1) and realtime truthfulness (PC-I9): no hub connected.
    ...realtimePageState(),
    // The dock's Pine Logs (PC-I6): closed.
    logsKey: signal(null),
    logsFront: signal(false),
    scriptRuns: signal(runs),
    restoringScripts: signal([]),
    runsInFlight: new Map(),
    runningKeys: signal(new Map()),
    runScheduler: new LiveRerunScheduler(vi.fn()),
    scriptError: signal(null),
    scriptFailures: signal(new Map()),
    pendingScripts: signal(new Map()),
    waitingScripts: signal(new Map()),
    scriptUpdates: signal(new Map()),
    editorKey: signal(null),
    chartBasis: signal('standard'),
    symbol: signal('EURUSD'),
    resolution: signal('60'),
    bars: signal([]),
    barsFor: signal(null),
    replayActive: signal(false),
    displayBars: signal([]),
    replayHead: signal(null),
    serverClock: { now: () => Date.now() },
    chartScripts: { runOnChart },
    destroyRef: { destroyed: false, onDestroy: () => () => undefined },
    testerOpen: signal(true),
    dockPreference: signal('tester'),
    settings: { loadStoredInputs: vi.fn() },
    replacedNotice: signal(null),
  });
  return { p, runOnChart, held };
}

const MEANREV = item('strategy:1181', 'MeanRev v5');
const CROSS = item('mine:7', 'MA Cross');

describe('chart page — one strategy at a time, said out loud', () => {
  it('a strategy added over another replaces it and says so, with Undo', () => {
    const { p } = page([onChart(MEANREV, { 'Risk::Stop (ATR)': 2 })]);

    p.runScript(CROSS, {});

    expect(p.scriptRuns().map((r: ChartScriptRun) => r.item.key)).toEqual(['mine:7']);
    expect(p.replacedNotice()?.message).toBe(
      'Replaced MeanRev v5 with MA Cross: one strategy at a time on the chart',
    );
    expect(p.testerOpen()).toBe(true);
  });

  it('Undo puts the previous strategy back with its own inputs and takes the new one off', () => {
    const { p, runOnChart } = page([onChart(MEANREV, { 'Risk::Stop (ATR)': 2 })]);
    p.runScript(CROSS, {});

    p.undoReplace();

    expect(p.replacedNotice()).toBeNull();
    expect(runOnChart).toHaveBeenLastCalledWith(
      MEANREV,
      'EURUSD',
      '60',
      { 'Risk::Stop (ATR)': 2 },
      1500,
      { liveBar: null, chartType: 'standard', toMs: null },
    );
    const back = p.scriptRuns();
    expect(back.map((r: ChartScriptRun) => [r.item.key, r.values])).toEqual([
      ['strategy:1181', { 'Risk::Stop (ATR)': 2 }],
    ]);
    // Putting it back is no new replacement to announce.
    expect(p.replacedNotice()).toBeNull();
  });

  it('says nothing for a re-run of the same strategy, an indicator, or a layout’s restore', () => {
    const { p } = page([onChart(MEANREV)]);
    p.runScript(MEANREV, { 'Risk::Stop (ATR)': 3 });
    p.runScript(item('mine:3', 'RSI', 'indicator'), {});
    expect(p.replacedNotice()).toBeNull();
    expect(p.scriptRuns().map((r: ChartScriptRun) => r.item.key)).toEqual([
      'strategy:1181',
      'mine:3',
    ]);

    // A restore (or any re-run) still keeps one strategy — quietly.
    p.runScript(CROSS, {}, true);
    expect(p.scriptRuns().map((r: ChartScriptRun) => r.item.key)).toEqual(['mine:3', 'mine:7']);
    expect(p.replacedNotice()).toBeNull();
  });

  it('a late run of the replaced strategy does not bring it back over the new one', () => {
    const { p, held } = page([onChart(MEANREV)]);
    const late = new Subject<ChartScriptResult>();
    held.set(MEANREV.key, late);
    p.runScript(MEANREV, {}, true); // its re-run, still in flight

    p.runScript(CROSS, {});
    late.next(resultOf(MEANREV));

    expect(p.scriptRuns().map((r: ChartScriptRun) => r.item.key)).toEqual(['mine:7']);
    expect(late.observed).toBe(false); // the request was dropped with it
  });

  it('reads the stored inputs of the strategy that lands, for its tester’s defaults', () => {
    const { p } = page();
    p.runScript(MEANREV, {});
    expect(p['settings'].loadStoredInputs).toHaveBeenCalledWith(MEANREV);
  });
});
