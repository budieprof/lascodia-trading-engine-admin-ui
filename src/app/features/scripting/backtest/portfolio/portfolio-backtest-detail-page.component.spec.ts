import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';

import { AuthService } from '@core/auth/auth.service';
import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { declareSignalIo } from '@shared/testing/jit-signal-io';

import { ScriptDialogService } from '../../shared/script-dialog.service';
import { ChartCardStubComponent } from '../../testing/stubs';
import { PortfolioBacktestDetailPageComponent } from './portfolio-backtest-detail-page.component';
import { PORTFOLIO_POLL_MS } from './portfolio-backtests-page.component';

declareSignalIo(PageHeaderComponent, { inputs: ['title', 'subtitle'] });

const BASE = 'http://test/api/v1/lascodia-trading-engine';
const ok = <T>(data: T) => ({ data, status: true, message: 'Successful', responseCode: '00' });
const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

const member = (index: number, name: string, symbol: string) => ({
  index,
  strategyId: index === 0 ? 7 : null,
  name,
  symbol,
  timeframe: 'H1',
  equitySharePct: 100,
  newsBlackoutExempt: false,
  standaloneCapital: 10_000,
  inputOverrides: index === 0 ? { Length: 21 } : null,
  pineSource: index === 0 ? null : 'strategy("B")',
});

function run(over: Record<string, unknown> = {}) {
  return {
    id: 5,
    name: '2 members: EURUSD H1, GBPUSD H1',
    status: 'Completed',
    fromDate: '2026-01-01T00:00:00Z',
    toDate: '2026-06-01T00:00:00Z',
    accountCurrency: 'USD',
    initialBalance: 20_000,
    leverage: 30,
    memberCount: 2,
    stage: null,
    errorMessage: null,
    failedMemberIndex: null,
    queuedBy: 'analyst',
    queuedAt: '2026-10-09T08:00:00Z',
    executionStartedAt: '2026-10-09T08:00:05Z',
    completedAt: '2026-10-09T08:01:00Z',
    cancelRequested: false,
    finalBalance: 19_721.68,
    netProfit: -278.32,
    totalReturnPct: -1.39,
    maxDrawdownPct: 2.17,
    totalTrades: 121,
    refusedEntries: 2,
    costModelKey: 'cm-1',
    barMagnifier: null,
    exposure: {
      source: 'RiskProfile #4 (Tight)',
      maxSameDirectionCurrencyLegs: 1,
      maxCorrelatedPositions: 0,
      correlationThreshold: 0.7,
      correlationGroups: [],
      symbolLegs: {},
    },
    members: [member(0, 'Trend EU', 'EURUSD'), member(1, 'Mine', 'GBPUSD')],
    result: null,
    ...over,
  };
}

const result = {
  accountCurrency: 'USD',
  initialBalance: 20_000,
  finalBalance: 19_721.68,
  fromUtc: '2026-01-01T00:00:00Z',
  toUtc: '2026-06-01T00:00:00Z',
  costModelKey: 'cm-1',
  account: {
    initialBalance: 20_000,
    finalBalance: 19_721.68,
    netProfit: -278.32,
    totalReturn: -1.39,
    maxDrawdownPct: 2.17,
    maxDrawdown: 440,
    sharpeRatio: -0.4,
    sortinoRatio: -0.5,
    calmarRatio: -0.6,
    cagrPct: -3.3,
    winRate: 0.42,
    profitFactor: 0.91,
    totalTrades: 121,
    expectancyR: -0.05,
    exposurePct: 40,
    totalCommission: 0,
    totalSwap: 0,
    totalSlippage: 0,
    marginCalls: 0,
    notes: [],
  },
  curve: [],
  members: [
    {
      index: 0, name: 'Trend EU', strategyId: 7, symbol: 'EURUSD', timeframe: 'H1', equitySharePct: 100,
      netProfit: -200.5, grossProfit: 900, grossLoss: -1100.5, commission: 0, swap: 0, executionCost: 0, trades: 70,
      winningTrades: 30, losingTrades: 40, winRate: 0.4286, profitFactor: 0.82, sumR: -3.1, rTrades: 70,
      expectancyR: -0.04, drawdownContribution: 318, drawdownSharePct: 72.27, refusedEntries: {}, marginCalls: 0,
      timeInMarketPct: 31.5, costModel: 'Snapshot', notes: [], inputs: null, tradeList: [],
    },
    {
      index: 1, name: 'Mine', strategyId: null, symbol: 'GBPUSD', timeframe: 'H1', equitySharePct: 100,
      netProfit: -77.82, grossProfit: 700, grossLoss: -777.82, commission: 0, swap: 0, executionCost: 0, trades: 51,
      winningTrades: 22, losingTrades: 29, winRate: 0.4314, profitFactor: 0.9, sumR: -1.2, rTrades: 51,
      expectancyR: -0.02, drawdownContribution: 122, drawdownSharePct: 27.73, refusedEntries: { ExposureCap: 2 },
      marginCalls: 0, timeInMarketPct: 22, costModel: 'Snapshot', notes: [], inputs: null, tradeList: [],
    },
  ],
  maxDrawdown: { amount: 440, pct: 2.17, peakUtc: null, troughUtc: null },
  correlation: { members: [0, 1], matrix: [[1, -0.03], [-0.03, 1]], days: 120 },
  exposure: [],
  margin: [],
  refusals: [
    {
      memberIndex: 1, member: 'Mine', symbol: 'GBPUSD', kind: 'ExposureCap', direction: 'Buy', lots: 1.2, price: 1.27,
      timeUtc: '2026-02-03T10:00:00Z',
      reason: 'Currency-leg cap: short USD already has 1 same-direction open position(s) on this account (cap 1).',
    },
    {
      memberIndex: 1, member: 'Mine', symbol: 'GBPUSD', kind: 'ExposureCap', direction: 'Buy', lots: 1.1, price: 1.26,
      timeUtc: '2026-03-03T10:00:00Z', reason: 'Currency-leg cap: …',
    },
  ],
  marginCalls: [],
  comparison: {
    currency: 'USD',
    members: [
      { index: 0, name: 'Trend EU', initialBalance: 10_000, netProfit: -250, totalReturnPct: -2.5, maxDrawdownPct: 3, trades: 70, winRate: 0.4, expectancyR: -0.05, sharpeRatio: -0.5, failure: null },
      { index: 1, name: 'Mine', initialBalance: null, netProfit: null, totalReturnPct: null, maxDrawdownPct: null, trades: null, winRate: null, expectancyR: null, sharpeRatio: null, failure: 'No bars in the window.' },
    ],
    sumInitialBalance: 10_000,
    sumNetProfit: -250,
    sumTrades: 70,
    portfolioNetProfit: -278.32,
    portfolioTrades: 121,
    curve: [],
  },
  exposureRule: {
    source: 'RiskProfile #4 (Tight)', maxSameDirectionCurrencyLegs: 1, maxCorrelatedPositions: 0, correlationThreshold: 0.7,
    correlationGroups: [], symbolLegs: {},
  },
  notes: ['Member 2 ran with the engine cost overlay.'],
  elapsedMs: 511,
};

describe('PortfolioBacktestDetailPageComponent (BT-I12)', () => {
  let fixture: ComponentFixture<PortfolioBacktestDetailPageComponent>;
  let http: HttpTestingController;
  let el: HTMLElement;

  beforeEach(() => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({
      imports: [PortfolioBacktestDetailPageComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: RUNTIME_CONFIG, useValue: { apiBaseUrl: 'http://test' } },
        { provide: AuthService, useValue: { hasPermission: () => true } },
        { provide: ScriptDialogService, useValue: { confirm: vi.fn(async () => true) } },
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({ id: '5' }) } } },
      ],
    });
    TestBed.overrideComponent(PortfolioBacktestDetailPageComponent, {
      remove: { imports: [ChartCardComponent] },
      add: { imports: [ChartCardStubComponent] },
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(PortfolioBacktestDetailPageComponent);
    fixture.detectChanges();
    el = fixture.nativeElement as HTMLElement;
  });

  afterEach(() => {
    http.verify();
    vi.useRealTimers();
  });

  const get = () => http.expectOne(`${BASE}/portfolio-backtest/5`);

  it('shows a completed run’s account, members, correlation, refusals and comparison', async () => {
    get().flush(ok(run({ result })));
    await settle();
    fixture.detectChanges();
    expect(el.querySelector('[data-testid="pf-status"]')?.textContent).toContain('Completed');
    expect(el.querySelector('[data-testid="pf-rule"]')?.textContent).toContain('1 same-direction position(s) per currency');
    expect(el.querySelector('[data-testid="pf-rule"]')?.textContent).toContain('no limit on per correlation group');
    const figures = el.querySelector('[data-testid="pf-figures"]')?.textContent ?? '';
    expect(figures).toContain('−278.32 USD');
    expect(figures).toContain('42.00%');
    const members = el.querySelectorAll('[data-testid="pf-members"] tbody tr');
    expect(members.length).toBe(2);
    expect(members[0].textContent).toContain('72.27%');
    expect(members[1].textContent).toContain('Currency-exposure limit: 2');
    expect(el.querySelector('[data-testid="pf-correlation"]')?.textContent).toContain('−0.03');
    expect(el.querySelector('[data-testid="pf-refusal-counts"]')?.textContent).toContain('Currency-exposure limit: 2');
    expect(el.querySelectorAll('[data-testid="pf-refusals"] tbody tr').length).toBe(2);
    const standalone = el.querySelector('[data-testid="pf-standalone"]')?.textContent ?? '';
    expect(standalone).toContain('Did not run alone: No bars in the window.');
    expect(standalone).toContain('Members alone, summed');
    expect(el.textContent).toContain('Member 2 ran with the engine cost overlay.');
  });

  it('shows why a run failed and which member failed it', async () => {
    get().flush(
      ok(run({ status: 'Failed', errorMessage: 'Member 2 (Mine): Script does not compile.', failedMemberIndex: 1 })),
    );
    await settle();
    fixture.detectChanges();
    const failure = el.querySelector('[data-testid="pf-failure"]')?.textContent ?? '';
    expect(failure).toContain('Member 2 (Mine): Script does not compile.');
    expect(failure).toContain('(member 2)');
    expect(el.querySelector('[data-testid="pf-figures"]')).toBeNull();
  });

  it('re-reads a running run until it finishes', async () => {
    get().flush(ok(run({ status: 'Running', stage: 'Bar 400 of 8,000', completedAt: null })));
    await settle();
    fixture.detectChanges();
    expect(el.textContent).toContain('Bar 400 of 8,000');
    vi.advanceTimersByTime(PORTFOLIO_POLL_MS);
    get().flush(ok(run({ result })));
    await settle();
    fixture.detectChanges();
    expect(el.querySelector('[data-testid="pf-figures"]')).not.toBeNull();
    vi.advanceTimersByTime(PORTFOLIO_POLL_MS);
    http.expectNone(`${BASE}/portfolio-backtest/5`);
  });
});
