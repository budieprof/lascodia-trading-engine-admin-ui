import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute, provideRouter } from '@angular/router';

import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import { BacktestDetailPageComponent } from './backtest-detail-page.component';
import { strategyReportFixture } from '@features/scripting/testing/strategy-report.fixture';

// Drives the page's load path (not its template, whose children use signal inputs the JIT
// harness cannot seed) to check which analytics a run gets: a script strategy's run carries a
// Strategy report, every other run keeps the JSON-DSL analytics.

const RUN_URL = 'http://test/api/v1/lascodia-trading-engine/backtest/812';

function run(resultJson: string | null) {
  return {
    data: {
      id: 812,
      strategyId: 41,
      symbol: 'EURUSD',
      timeframe: 'H1',
      fromDate: '2025-01-01T00:00:00Z',
      toDate: '2026-01-10T00:00:00Z',
      initialBalance: 10000,
      status: 'Completed',
      resultJson,
      errorMessage: null,
      startedAt: '2026-01-10T00:00:00Z',
      completedAt: '2026-01-10T00:01:00Z',
      totalTrades: 6,
      winRate: 0.6667,
      profitFactor: 6.97,
      maxDrawdownPct: 0.65,
      sharpeRatio: 0.41,
      finalBalance: 10641.2,
      totalReturn: 6.41,
    },
    status: true,
    message: 'Successful',
    responseCode: '00',
  };
}

describe('BacktestDetailPageComponent (result shape)', () => {
  let http: HttpTestingController;
  let cmp: BacktestDetailPageComponent;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [BacktestDetailPageComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: RUNTIME_CONFIG, useValue: { apiBaseUrl: 'http://test' } },
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => '812' } } } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    cmp = TestBed.createComponent(BacktestDetailPageComponent).componentInstance;
    cmp.ngOnInit();
  });

  afterEach(() => http.verify());

  it('shows a script strategy’s run as a Strategy report', () => {
    http.expectOne(RUN_URL).flush(run(JSON.stringify(strategyReportFixture())));
    expect(cmp.scriptReport()?.meta.symbol).toBe('EURUSD');
    expect(cmp.scriptReport()?.trades).toHaveLength(7);
    // The DSL parser is never pointed at it, so no "couldn't parse" note either.
    expect(cmp.parsed()).toBeNull();
    expect(cmp.parseError()).toBeNull();
  });

  it('keeps the DSL analytics for a JSON-DSL run', () => {
    const dsl = {
      InitialBalance: 10000,
      FinalBalance: 10100,
      TotalReturn: 1,
      TotalTrades: 1,
      Trades: [
        {
          Direction: 0,
          EntryPrice: 1.1,
          ExitPrice: 1.101,
          LotSize: 1,
          PnL: 100,
          EntryTime: '2025-01-01T00:00:00Z',
          ExitTime: '2025-01-02T00:00:00Z',
          ExitReason: 1,
        },
      ],
    };
    http.expectOne(RUN_URL).flush(run(JSON.stringify(dsl)));
    expect(cmp.scriptReport()).toBeNull();
    expect(cmp.parsed()?.Trades).toHaveLength(1);
  });

  it('handles a run that has no result yet', () => {
    http.expectOne(RUN_URL).flush(run(null));
    expect(cmp.scriptReport()).toBeNull();
    expect(cmp.parsed()).toBeNull();
    expect(cmp.parseError()).toBeNull();
  });
});
