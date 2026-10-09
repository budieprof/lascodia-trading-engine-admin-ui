import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';

import type { StrategyDto } from '@core/api/api.types';
import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import { declareSignalIo } from '@shared/testing/jit-signal-io';

import { ChartCardStubComponent } from '../testing/stubs';
import { MonteCarloPanelComponent, monteCarloRows } from './monte-carlo-panel.component';
import { WalkForwardAnalysisComponent } from './walk-forward-analysis.component';
import { WalkForwardLauncherComponent } from './walk-forward-launcher.component';
import type { MonteCarloDto, WalkForwardAnalysisDto } from './research.types';

declareSignalIo(WalkForwardLauncherComponent, {
  inputs: ['strategy', 'canRun'],
  outputs: ['launched'],
});
declareSignalIo(WalkForwardAnalysisComponent, { inputs: ['runId'] });
declareSignalIo(MonteCarloPanelComponent, { inputs: ['source'] });

const BASE = 'http://test/api/v1/lascodia-trading-engine';
const ok = <T>(data: T) => ({ data, status: true, message: 'Successful', responseCode: '00' });
const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
const providers = [
  provideHttpClient(),
  provideHttpClientTesting(),
  { provide: RUNTIME_CONFIG, useValue: { apiBaseUrl: 'http://test' } },
];

const strategy = {
  id: 7,
  symbol: 'EURUSD',
  timeframe: 'H1',
  authoringMode: 'Script',
  scriptSource: '//@version=6',
} as unknown as StrategyDto;

function mc(): MonteCarloDto {
  const p = (a: number, b: number, c: number) => ({ p5: a, p50: b, p95: c });
  return {
    source: 'walk-forward 9',
    backtestRunId: null,
    walkForwardRunId: 9,
    strategyId: 7,
    tradesInSource: 41,
    tradesWithR: 39,
    firstTradeUtc: '2026-01-02T00:00:00Z',
    lastTradeUtc: '2026-06-30T00:00:00Z',
    tradesPerYear: 80,
    daysPerTrade: 4.5,
    result: {
      trades: 39,
      iterations: 2000,
      blockSize: 7,
      riskPerTradePct: 1,
      ruinDrawdownPct: 50,
      meanR: 0.08,
      totalR: 3.1,
      years: 0.5,
      maxDrawdownPct: p(2.1, 4.4, 9.9),
      totalReturnPct: p(-1, 3, 8),
      cagrPct: null,
      timeToRecoverTrades: p(5, 12, 30),
      timeToRecoverDays: p(20, 50, 130),
      riskOfRuin: 0,
      probabilityOfLoss: 0.21,
      unrecoveredShare: 0.4,
    },
    notes: ['2 trade(s) without a stop have no R and are left out.'],
  };
}

function analysis(): WalkForwardAnalysisDto {
  return {
    runId: 9,
    strategyId: 7,
    symbol: 'EURUSD',
    timeframe: 'H1',
    windowMode: 'Anchored',
    reOptimizePerFold: true,
    fromDate: '2025-10-01T00:00:00Z',
    toDate: '2026-10-01T00:00:00Z',
    terminalHoldoutFromUtc: '2026-08-25T00:00:00Z',
    averageOutOfSampleSharpe: 0.9,
    sharpeStdDev: 0.3,
    folds: [
      {
        windowIndex: 0,
        inSampleFrom: '2025-10-01T00:00:00Z',
        inSampleTo: '2025-12-30T00:00:00Z',
        outOfSampleFrom: '2026-01-01T00:00:00Z',
        outOfSampleTo: '2026-01-31T00:00:00Z',
        reOptimized: true,
        parameters: { __ScriptInputs: 9, len: 10 },
        oosSharpe: 1,
        oosTrades: 14,
        oosWinRate: 0.57,
        oosProfitFactor: 1.4,
        oosNetProfit: 100,
        oosExpectancyR: 0.12,
        oosMaxDrawdownPct: 2.1,
        isSharpe: 2,
        isNetProfit: 400,
        isTrades: 31,
        isHealthScore: 0.71,
        efficiency: 0.5,
      },
      {
        windowIndex: 1,
        inSampleFrom: '2025-10-01T00:00:00Z',
        inSampleTo: '2026-01-30T00:00:00Z',
        outOfSampleFrom: '2026-02-01T00:00:00Z',
        outOfSampleTo: '2026-03-02T00:00:00Z',
        reOptimized: true,
        parameters: { __ScriptInputs: 9, len: 14 },
        oosSharpe: 0.4,
        oosTrades: 9,
        oosWinRate: 0.44,
        oosProfitFactor: 1.1,
        oosNetProfit: 30,
        oosExpectancyR: 0.05,
        oosMaxDrawdownPct: 3,
        isSharpe: 1.5,
        isNetProfit: 300,
        isTrades: 25,
        isHealthScore: 0.6,
        efficiency: 0.3,
      },
    ],
    stitched: {
      startingEquity: 10000,
      endingEquity: 10130,
      netProfit: 130,
      maxDrawdownPct: 2.8,
      totalTrades: 23,
      winRate: 0.52,
      profitFactor: 1.3,
      expectancyR: 0.09,
      totalR: 2.1,
      rTrades: 23,
      outOfSampleDays: 60,
      annualisedReturnPct: 8,
      equity: [
        { time: '2026-01-01T00:00:00Z', equity: 10000, drawdownPct: 0, fold: 0, cumulativeR: 0 },
        { time: '2026-01-10T00:00:00Z', equity: 10100, drawdownPct: 0, fold: 0, cumulativeR: 1 },
        { time: '2026-02-10T00:00:00Z', equity: 10130, drawdownPct: 0, fold: 1, cumulativeR: 2.1 },
      ],
      trades: [
        {
          fold: 0,
          direction: 'Buy',
          entryTime: '2026-01-02T00:00:00Z',
          exitTime: '2026-01-03T00:00:00Z',
          entryPrice: 1.1,
          exitPrice: 1.101,
          lotSize: 0.1,
          pnL: 100,
          r: 1.2,
          exitReason: 'TakeProfit',
          equity: 10100,
        },
      ],
    },
    efficiency: {
      walkForwardEfficiency: 0.83,
      sharpeEfficiency: 0.68,
      foldsCompared: 2,
      note: null,
    },
    parameterDrift: [
      {
        id: 'len',
        numeric: true,
        values: [10, 14],
        min: 10,
        max: 14,
        median: 12,
        relativeSpread: 0.333,
        meanRelativeStep: 0.333,
        changes: 1,
        distinct: 2,
      },
    ],
    notes: [],
  };
}

describe('WalkForwardLauncherComponent (BT-I5, BT-13)', () => {
  let fixture: ComponentFixture<WalkForwardLauncherComponent>;
  let http: HttpTestingController;
  let el: HTMLElement;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [WalkForwardLauncherComponent], providers });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(WalkForwardLauncherComponent);
    fixture.componentRef.setInput('strategy', strategy);
    fixture.detectChanges();
    el = fixture.nativeElement as HTMLElement;
  });

  afterEach(() => http.verify());

  it('starts an anchored, re-optimising walk-forward on the strategy’s market', async () => {
    let launched: number | null = null;
    fixture.componentInstance.launched.subscribe((id) => (launched = id));
    const mode = el.querySelector<HTMLSelectElement>('[data-testid="wfl-mode"]')!;
    mode.value = 'Rolling';
    mode.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    (el.querySelector('[data-testid="wfl-start"]') as HTMLButtonElement).click();
    const req = http.expectOne(`${BASE}/walk-forward`);
    expect(req.request.body).toMatchObject({
      strategyId: 7,
      symbol: 'EURUSD',
      timeframe: 'H1',
      inSampleDays: 90,
      outOfSampleDays: 30,
      reOptimizePerFold: true,
      windowMode: 'Rolling',
      initialBalance: 10000,
    });
    req.flush(ok(9));
    await settle();
    expect(launched).toBe(9);
  });

  it('refuses a launch that cannot make a fold before sending it', () => {
    fixture.componentInstance.set('inSampleDays', '400');
    fixture.detectChanges();
    (el.querySelector('[data-testid="wfl-start"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    http.expectNone(`${BASE}/walk-forward`);
    expect(el.querySelector('[data-testid="wfl-problem"]')!.textContent).toContain(
      'longer than the date range',
    );
    expect(el.querySelector('[data-testid="wfl-folds"]')!.textContent).toContain(
      'Too short for a fold',
    );
  });
});

describe('WalkForwardAnalysisComponent (BT-I5, BT-I6)', () => {
  let fixture: ComponentFixture<WalkForwardAnalysisComponent>;
  let http: HttpTestingController;
  let el: HTMLElement;

  beforeEach(async () => {
    TestBed.configureTestingModule({ imports: [WalkForwardAnalysisComponent], providers });
    TestBed.overrideComponent(WalkForwardAnalysisComponent, {
      remove: { imports: [ChartCardComponent] },
      add: { imports: [ChartCardStubComponent] },
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(WalkForwardAnalysisComponent);
    fixture.componentRef.setInput('runId', 9);
    fixture.detectChanges();
    el = fixture.nativeElement as HTMLElement;
    http.expectOne(`${BASE}/walk-forward/9`).flush(
      ok({
        id: 9,
        status: 'Completed',
        terminalHoldoutFromUtc: '2026-08-25T00:00:00Z',
        holdoutScoredAt: null,
      }),
    );
    await settle();
    http.expectOne(`${BASE}/walk-forward/9/analysis`).flush(ok(analysis()));
    await settle();
    fixture.detectChanges();
    http
      .expectOne(
        `${BASE}/walk-forward/9/monte-carlo?iterations=2000&riskPerTradePct=1&ruinDrawdownPct=50`,
      )
      .flush(ok(mc()));
    await settle();
    fixture.detectChanges();
  });

  afterEach(() => http.verify());

  it('shows the stitched result, efficiency and the locked holdout', () => {
    expect(el.querySelector('[data-testid="wfa-figures"]')!.textContent).toContain('0.090 R');
    expect(el.querySelector('[data-testid="wfa-efficiency"]')!.textContent).toContain('83%');
    expect(el.querySelector('[data-testid="wfa-holdout"]')!.textContent).toContain('Locked');
    const titles = [...el.querySelectorAll('.chart-stub')].map((c) => c.getAttribute('data-title'));
    expect(titles).toEqual([
      'Equity, out of sample',
      'In-sample vs out-of-sample Sharpe, per fold',
    ]);
  });

  it('lists each fold’s inputs and how they drifted', () => {
    const folds = el.querySelector('[data-testid="wfa-folds"]')!.textContent!;
    expect(folds).toContain('len=10');
    expect(folds).toContain('len=14');
    expect(folds).not.toContain('__ScriptInputs');
    expect(el.querySelector('[data-testid="wfa-drift"]')!.textContent).toContain('10 → 14');
  });

  it('switches the curve to cumulative R', () => {
    const radios = el.querySelectorAll<HTMLInputElement>('input[name="wfa-mode"]');
    radios[1].dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(el.querySelector('.chart-stub')!.getAttribute('data-title')).toBe(
      'Cumulative R, out of sample',
    );
  });

  it('runs the engine’s Monte Carlo of the stitched trades', async () => {
    const panel = el.querySelector('[data-testid="monte-carlo-panel"]')!;
    expect(panel.querySelector('[data-testid="mc-ruin"]')!.textContent).toContain(
      'Risk of ruin 0.0%',
    );
    expect(panel.querySelector('[data-testid="mc-table"]')!.textContent).toContain('9.9%');
    expect(panel.textContent).toContain('without a stop');

    const risk = panel.querySelector<HTMLInputElement>('input[type="number"]')!;
    risk.value = '2';
    risk.dispatchEvent(new Event('change'));
    (panel.querySelector('button') as HTMLButtonElement).click();
    http
      .expectOne(
        `${BASE}/walk-forward/9/monte-carlo?iterations=2000&riskPerTradePct=2&ruinDrawdownPct=50`,
      )
      .flush(ok(mc()));
    await settle();
  });
});

describe('monteCarloRows', () => {
  it('says when a measure cannot be made', () => {
    const rows = monteCarloRows(mc());
    expect(rows.find((r) => r.label.startsWith('Annual'))!.p).toBeNull();
    expect(rows.find((r) => r.label.startsWith('Annual'))!.note).toContain('less than a day');
  });
});
