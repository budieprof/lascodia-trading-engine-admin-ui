import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Component, EventEmitter, Input, Output } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { of, switchMap, throwError, timer } from 'rxjs';

import type { ScriptRunResult } from '@core/api/scripting.types';
import { ScriptingApiError, ScriptingService } from '@core/services/scripting.service';
import { declareSignalIo } from '@shared/testing/jit-signal-io';
import { PinePreviewComponent } from '../../pine-preview/pine-preview.component';
import { StrategyReportComponent } from '../../report/strategy-report.component';
import { strategyReportFixture } from '../../testing/strategy-report.fixture';
import { ScriptPreviewComponent } from './script-preview.component';

// The editor's Preview: it runs the script, hosts the Pine chart (app-pine-preview) in its chart
// slot fed by the run, routes the chart's source-line jumps to the editor and, for a strategy,
// shows the Strategy report of the same run. The chart and the report render on canvas / echarts,
// which jsdom has not got — stand-ins record what they are given.

@Component({ selector: 'app-pine-preview', standalone: true, template: '' })
class PinePreviewStubComponent {
  @Input() result: unknown;
  @Input() request: unknown;
  @Input() source: unknown;
  @Input() symbol: unknown;
  @Input() timeframe: unknown;
  @Output() jumpToLine = new EventEmitter<{ line: number; column?: number | null }>();
}

@Component({ selector: 'app-strategy-report', standalone: true, template: '' })
class StrategyReportStubComponent {
  @Input() report: unknown;
}

declareSignalIo(ScriptPreviewComponent, {
  inputs: ['source', 'inputs', 'symbol', 'timeframe', 'kind', 'disabled'],
  outputs: ['reveal'],
});

const SOURCE = '//@version=6\nstrategy("S", overlay = true)\nplot(close)\n';

const RUN: ScriptRunResult = {
  compile: {
    success: true,
    diagnostics: [],
    declaration: { kind: 'strategy', title: 'S' },
    inputs: [],
  },
  bars: [{ t: 1, o: 1, h: 2, l: 0.5, c: 1.5, v: 10 }],
  outputs: { logs: [{}, {}], alerts: [] },
  report: strategyReportFixture() as ScriptRunResult['report'],
  elapsedMs: 42,
};

describe('ScriptPreviewComponent', () => {
  let fixture: ComponentFixture<ScriptPreviewComponent>;
  let el: HTMLElement;
  let run: ReturnType<typeof vi.fn>;
  let reveals: { line: number; column: number }[];

  function render(kind: 'strategy' | 'indicator' = 'strategy'): void {
    fixture = TestBed.createComponent(ScriptPreviewComponent);
    fixture.componentRef.setInput('source', SOURCE);
    fixture.componentRef.setInput('inputs', { in_len: 21 });
    fixture.componentRef.setInput('symbol', 'EURUSD');
    fixture.componentRef.setInput('timeframe', 'H1');
    fixture.componentRef.setInput('kind', kind);
    reveals = [];
    fixture.componentInstance.reveal.subscribe((r) => reveals.push(r));
    fixture.detectChanges();
    el = fixture.nativeElement as HTMLElement;
  }

  async function preview(): Promise<void> {
    (el.querySelector('.controls .btn-primary') as HTMLButtonElement).click();
    // run() awaits the (synchronous) observable: let its promise chain settle.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    fixture.detectChanges();
  }

  const chart = () =>
    fixture.debugElement.query((d) => d.componentInstance instanceof PinePreviewStubComponent)
      ?.componentInstance as PinePreviewStubComponent | undefined;

  beforeEach(() => {
    run = vi.fn(() => of(RUN));
    TestBed.configureTestingModule({
      imports: [ScriptPreviewComponent],
      providers: [{ provide: ScriptingService, useValue: { run } }],
    });
    TestBed.overrideComponent(ScriptPreviewComponent, {
      remove: { imports: [PinePreviewComponent, StrategyReportComponent] },
      add: { imports: [PinePreviewStubComponent, StrategyReportStubComponent] },
    });
  });

  afterEach(() => fixture?.destroy());

  it('runs a strategy in backtest mode and hosts the chart, fed by the run, in its chart slot', async () => {
    render();
    expect(chart()).toBeUndefined();
    await preview();
    const request = {
      source: SOURCE,
      symbol: 'EURUSD',
      timeframe: 'H1',
      lastBars: 2000,
      inputs: { in_len: 21 },
      mode: 'backtest',
    };
    expect(run).toHaveBeenCalledWith(request);
    const slot = el.querySelector('[data-slot="script-chart-overlay"]')!;
    expect(slot.querySelector('app-pine-preview')).not.toBeNull();
    // The chart re-runs this request for a trace window, a profile or a replay.
    expect(chart()!.result).toBe(RUN);
    expect(chart()!.request).toEqual(request);
    expect(chart()!.symbol).toBe('EURUSD');
    expect(el.querySelector('.meta')!.textContent).toContain('2 logs');
  });

  it('sends every source-line jump from the chart to the editor', async () => {
    render();
    await preview();
    chart()!.jumpToLine.emit({ line: 7, column: null });
    chart()!.jumpToLine.emit({ line: 9, column: 4 });
    expect(reveals).toEqual([
      { line: 7, column: 1 },
      { line: 9, column: 4 },
    ]);
  });

  it('offers the Strategy report of the same run next to the chart', async () => {
    render();
    await preview();
    const tabs = [...el.querySelectorAll<HTMLButtonElement>('.result-tab')];
    expect(tabs.map((t) => t.textContent!.trim().replace(/\s+/g, ' '))).toEqual([
      'Chart',
      'Strategy report 7',
    ]);
    tabs[1].click();
    fixture.detectChanges();
    const report = fixture.debugElement.query(
      (d) => d.componentInstance instanceof StrategyReportStubComponent,
    ).componentInstance as StrategyReportStubComponent;
    expect(report.report).toBe(RUN.report);
    // The chart stays alive (hidden) so switching back keeps its zoom.
    expect(el.querySelector<HTMLElement>('.chart-slot')!.hidden).toBe(true);
    tabs[0].click();
    fixture.detectChanges();
    expect(el.querySelector('app-strategy-report')).toBeNull();
    expect(el.querySelector<HTMLElement>('.chart-slot')!.hidden).toBe(false);
  });

  it('runs an indicator in preview mode, without a report tab', async () => {
    run.mockReturnValue(of({ ...RUN, report: null }));
    render('indicator');
    await preview();
    expect(run.mock.calls[0][0].mode).toBe('preview');
    expect(el.querySelector('.result-tabs')).toBeNull();
    expect(chart()).toBeDefined();
  });

  it('lists compile errors instead of a chart, each one a jump to its line', async () => {
    run.mockReturnValue(
      of({
        compile: {
          success: false,
          diagnostics: [
            {
              code: 'PS2003',
              severity: 'error',
              message: 'Undeclared identifier "clsoe"',
              line: 4,
              column: 12,
              endLine: 4,
              endColumn: 17,
            },
          ],
          declaration: null,
          inputs: [],
        },
      }),
    );
    render();
    await preview();
    expect(chart()).toBeUndefined();
    const issue = el.querySelector<HTMLButtonElement>('.issue')!;
    expect(issue.textContent).toContain('Undeclared identifier');
    issue.click();
    expect(reveals).toEqual([{ line: 4, column: 12 }]);
  });

  it('says why a run failed', async () => {
    // Fails on a later task, as a real request does: a rejection in the same tick as the native
    // `await` reads as unhandled to zone.js under vitest.
    run.mockReturnValue(
      timer(0).pipe(
        switchMap(() =>
          throwError(() => new ScriptingApiError('The engine could not be reached.')),
        ),
      ),
    );
    render();
    (el.querySelector('.controls .btn-primary') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 10));
    for (let i = 0; i < 5; i++) await Promise.resolve();
    fixture.detectChanges();
    expect(el.querySelector('[role="alert"]')!.textContent).toContain('could not be reached');
    expect(chart()).toBeUndefined();
  });
});
