import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Component, Input } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';

import type { BacktestRunDto } from '@core/api/api.types';
import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import { PineChartComponent } from '@shared/pine-chart/components/pine-chart.component';
import type { PineChartData } from '@shared/pine-chart/model/chart-data';
import { declareSignalIo } from '@shared/testing/jit-signal-io';
import { normalizeStrategyReport } from '../report/strategy-report.model';
import { strategyReportFixture } from '../testing/strategy-report.fixture';
import { MAX_RUN_CHART_BARS } from './run-chart.model';
import { ScriptRunChartComponent } from './script-run-chart.component';

// The chart above a script backtest's Strategy report: the run's own bars when resultJson has
// them, else the candle store over the run's window with the report's trades. The Lightweight
// Charts canvas is not in jsdom; a stand-in records what the chart is given.

@Component({ selector: 'app-pine-chart', standalone: true, template: '' })
class PineChartStubComponent {
  @Input() result: PineChartData | null = null;
  @Input() symbol = '';
  @Input() timeframe = '';
  @Input() emptyText = '';
}

declareSignalIo(ScriptRunChartComponent, { inputs: ['run', 'report'] });

const CANDLES_URL = 'http://test/api/v1/lascodia-trading-engine/market-data/candle/list';
const report = normalizeStrategyReport(strategyReportFixture())!;

function run(resultJson: string | null): BacktestRunDto {
  return {
    id: 812,
    strategyId: 41,
    symbol: 'EURUSD',
    timeframe: 'H1',
    fromDate: '2025-01-01T00:00:00Z',
    toDate: '2026-01-10T00:00:00Z',
    resultJson,
  } as BacktestRunDto;
}

describe('ScriptRunChartComponent', () => {
  let fixture: ComponentFixture<ScriptRunChartComponent>;
  let http: HttpTestingController;
  let el: HTMLElement;

  function render(resultJson: string | null): void {
    fixture = TestBed.createComponent(ScriptRunChartComponent);
    fixture.componentRef.setInput('run', run(resultJson));
    fixture.componentRef.setInput('report', report);
    fixture.detectChanges();
    el = fixture.nativeElement as HTMLElement;
  }

  const chart = () =>
    fixture.debugElement.query((d) => d.componentInstance instanceof PineChartStubComponent)
      .componentInstance as PineChartStubComponent;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [ScriptRunChartComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: RUNTIME_CONFIG, useValue: { apiBaseUrl: 'http://test' } },
      ],
    });
    TestBed.overrideComponent(ScriptRunChartComponent, {
      remove: { imports: [PineChartComponent] },
      add: { imports: [PineChartStubComponent] },
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    fixture?.destroy();
  });

  it('charts the run window from the candle store, with the run’s trades', () => {
    render(JSON.stringify(strategyReportFixture()));
    const req = http.expectOne(CANDLES_URL);
    expect(req.request.body).toEqual({
      currentPage: 1,
      itemCountPerPage: MAX_RUN_CHART_BARS,
      filter: {
        symbol: 'EURUSD',
        timeframe: 'H1', // the report's Pine "60"
        from: new Date(report.meta.firstBarTime as number).toISOString(),
        to: new Date(report.meta.lastBarTimeClose as number).toISOString(),
      },
    });
    const first = report.trades[0].entryTime as number;
    req.flush({
      status: true,
      data: {
        pager: { totalItemCount: 2 },
        data: [
          {
            timestamp: new Date(first + 3_600_000).toISOString(),
            open: 1,
            high: 1,
            low: 1,
            close: 1,
            volume: 1,
          },
          {
            timestamp: new Date(first).toISOString(),
            open: 1,
            high: 1,
            low: 1,
            close: 1,
            volume: 1,
          },
        ],
      },
      message: 'Successful',
      responseCode: '00',
    });
    fixture.detectChanges();
    expect(chart().result?.bars.map((b) => b.t)).toEqual([first, first + 3_600_000]);
    expect(chart().result?.report?.trades.length).toBe(report.trades.length);
    expect(chart().symbol).toBe('EURUSD');
    expect(el.textContent).toContain('candle store');
  });

  it('says how much of a long window it shows', () => {
    render(JSON.stringify(strategyReportFixture()));
    const last = report.trades[report.trades.length - 1].entryTime as number;
    http.expectOne(CANDLES_URL).flush({
      status: true,
      data: {
        pager: { totalItemCount: 6200 },
        data: [
          {
            timestamp: new Date(last).toISOString(),
            open: 1,
            high: 1,
            low: 1,
            close: 1,
            volume: 1,
          },
        ],
      },
      message: 'Successful',
      responseCode: '00',
    });
    fixture.detectChanges();
    const note = el.querySelector('.note')!.textContent!;
    expect(note).toContain('newest 1 of 6,200 bars');
    expect(note).toContain('6 earlier trades');
  });

  it('draws the run’s own bars without asking the candle store', () => {
    const bars = [
      { t: 1_000, o: 1, h: 2, l: 0.5, c: 1.5, v: 1 },
      { t: 3_601_000, o: 1.5, h: 2, l: 1, c: 1.8, v: 1 },
    ];
    render(JSON.stringify({ report: strategyReportFixture(), bars }));
    http.expectNone(CANDLES_URL);
    expect(chart().result?.bars).toHaveLength(2);
    expect(el.textContent).toContain('own bars');
  });

  it('explains an engine refusal instead of an empty chart', () => {
    render(JSON.stringify(strategyReportFixture()));
    http.expectOne(CANDLES_URL).flush({
      status: false,
      data: null,
      message: "Timeframe 'H2' is not stored by the engine.",
      responseCode: '-11',
    });
    fixture.detectChanges();
    expect(chart().result).toBeNull();
    expect(chart().emptyText).toContain('is not stored by the engine');
  });
});
