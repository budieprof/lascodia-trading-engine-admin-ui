import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Component, Input, signal, type WritableSignal } from '@angular/core';
import { of, throwError } from 'rxjs';

import { ScriptingApiError } from '@core/services/scripting.service';
import { declareSignalIo } from '@shared/testing/jit-signal-io';
import { PineLogsPaneComponent } from '@shared/pine-chart/panes/pine-logs-pane.component';
import { PineProfilerPaneComponent } from '@shared/pine-chart/panes/pine-profiler-pane.component';
import { PineTracePaneComponent } from '@shared/pine-chart/panes/pine-trace-pane.component';
import { ChartIconComponent } from '../icons/chart-icon.component';
import type { ChartScriptResult } from './chart-script.model';
import { ChartScriptService, type ChartScriptItem } from './chart-script.service';
import { ScriptLogsPanelComponent, type LogsRunRequest } from './script-logs-panel.component';

// The panel's own inputs are swapped for writable signals before the first render (as the other
// component specs do); the shared panes inside get the metadata the AOT compiler would give their
// signal inputs and outputs, so the panel's bindings reach them.
declareSignalIo(PineLogsPaneComponent, {
  inputs: ['logs', 'droppedLogs', 'runtimeError', 'timezone'],
  outputs: ['barJump', 'lineJump'],
});
declareSignalIo(PineTracePaneComponent, {
  inputs: ['trace', 'bar', 'timezone', 'windowSize'],
  outputs: ['barChange', 'lineJump', 'requestTrace'],
});
declareSignalIo(PineProfilerPaneComponent, {
  inputs: ['profile', 'source', 'elapsedMs'],
  outputs: ['lineJump'],
});

@Component({ selector: 'app-chart-icon', template: '' })
class ChartIconStubComponent {
  @Input() name = '';
  @Input() size = 0;
}

const H = 3_600_000;
const T0 = Date.UTC(2026, 8, 1);
const bars = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ t: T0 + i * H, o: 1, h: 1, l: 1, c: 1, v: 0 }));

/** A run on the chart: 300 bars, two logs, the second an error. */
const RUN = {
  bars: bars(300),
  outputs: {
    logs: [
      { level: 'info', message: 'armed', barIndex: 12, time: T0 + 12 * H, isRealtime: false },
      { level: 'error', message: 'no fill', barIndex: 40, time: T0 + 40 * H, isRealtime: false },
    ],
    droppedLogs: 0,
  },
  trace: [],
  profile: [],
  runtimeError: null,
  elapsedMs: 12,
};
const RESULT = { title: 'RSI', run: RUN, error: null } as unknown as ChartScriptResult;
const ITEM: ChartScriptItem = {
  key: 'mine:9',
  source: 'mine',
  name: 'RSI',
  description: '',
  kind: 'indicator',
  pineSource: '//@version=6\nindicator("RSI")',
};
const REQUEST: LogsRunRequest = {
  item: ITEM,
  symbol: 'EURUSD',
  resolution: '60',
  values: { len: 14 },
  lastBars: 2000,
  opts: { chartType: 'standard', toMs: null },
};
const PROFILED = {
  ...RESULT,
  run: { ...RUN, profile: [{ line: 2, executions: 300, totalMicros: 900 }], elapsedMs: 15 },
} as unknown as ChartScriptResult;

describe('ScriptLogsPanelComponent (PC-I6)', () => {
  let fixture: ComponentFixture<ScriptLogsPanelComponent>;
  let cmp: ScriptLogsPanelComponent;
  let host: HTMLElement;
  let request: WritableSignal<LogsRunRequest | null>;
  const runOnChart = vi.fn((..._args: unknown[]) => of(PROFILED));

  function render(): void {
    TestBed.configureTestingModule({
      imports: [ScriptLogsPanelComponent],
      providers: [{ provide: ChartScriptService, useValue: { runOnChart } }],
    });
    TestBed.overrideComponent(ScriptLogsPanelComponent, {
      remove: { imports: [ChartIconComponent] },
      add: { imports: [ChartIconStubComponent] },
    });
    fixture = TestBed.createComponent(ScriptLogsPanelComponent);
    cmp = fixture.componentInstance;
    request = signal<LogsRunRequest | null>(REQUEST);
    const c = cmp as any;
    c.title = signal('RSI');
    c.result = signal(RESULT);
    c.request = request;
    c.source = signal(ITEM.pineSource);
    c.timezone = signal('UTC');
    fixture.detectChanges();
    host = fixture.nativeElement;
  }

  afterEach(() => {
    TestBed.resetTestingModule();
    runOnChart.mockReset();
    runOnChart.mockImplementation(() => of(PROFILED));
  });

  it('shows the chart run’s logs, flagged when one is an error', () => {
    render();
    const badge = host.querySelector('.lp__badge') as HTMLElement;
    expect(badge.textContent?.trim()).toBe('2');
    expect(badge.classList).toContain('err');
    const pane = fixture.debugElement.query((de) => de.name === 'app-pine-logs-pane')
      .componentInstance as PineLogsPaneComponent;
    expect(pane.logs()).toHaveLength(2);
  });

  it('a log’s bar is that bar’s time on the chart; a line opens the editor', () => {
    render();
    const jumps: number[] = [];
    const lines: unknown[] = [];
    cmp.barJump.subscribe((t) => jumps.push(t));
    cmp.lineJump.subscribe((l) => lines.push(l));
    const pane = fixture.debugElement.query((de) => de.name === 'app-pine-logs-pane')
      .componentInstance as PineLogsPaneComponent;
    pane.barJump.emit(40);
    pane.lineJump.emit({ line: 7, column: 3 });
    expect(jumps).toEqual([T0 + 40 * H]);
    expect(lines).toEqual([{ line: 7, column: 3 }]);
  });

  it('a profile run is its own: the run repeated with profile and a trace of the last bars', () => {
    render();
    cmp.tab.set('profiler');
    fixture.detectChanges();
    expect(host.querySelector('app-pine-profiler-pane')).toBeNull();
    (host.querySelector('[data-testid="logs-profile"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(runOnChart).toHaveBeenCalledWith(ITEM, 'EURUSD', '60', { len: 14 }, 2000, {
      chartType: 'standard',
      toMs: null,
      liveBar: null,
      profile: true,
      trace: { fromBar: 200, toBar: 299 },
    });
    expect(cmp.debug()?.profile).toHaveLength(1);
    expect(host.querySelector('app-pine-profiler-pane')).not.toBeNull();
  });

  it('“Why didn’t it fire?” traces the window it asks for, at its last bar', () => {
    render();
    cmp.runTrace({ fromBar: 10, toBar: 30 });
    expect(runOnChart.mock.calls[0][5]).toMatchObject({ trace: { fromBar: 10, toBar: 30 } });
    expect(cmp.traceBar()).toBe(30);
  });

  it('a busy engine is said as such, never as the script’s failure (C5)', () => {
    runOnChart.mockImplementation(() =>
      throwError(() => new ScriptingApiError('busy', '-429', null, 200, 4_000)),
    );
    render();
    cmp.runProfile();
    fixture.detectChanges();
    expect(host.querySelector('.lp__error')?.textContent).toContain(
      'The engine is busy with other runs: try again in 4 s.',
    );
  });

  it('another script, or other inputs: the trace and profile of the old run go', () => {
    render();
    cmp.runProfile();
    expect(cmp.debug()).not.toBeNull();
    request.set({ ...REQUEST, values: { len: 21 } });
    fixture.detectChanges();
    expect(cmp.debug()).toBeNull();
  });
});
