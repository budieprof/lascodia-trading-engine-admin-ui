import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';

import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import { ThemeService } from '@core/theme/theme.service';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import { declareSignalIo } from '@shared/testing/jit-signal-io';

import { ChartCardStubComponent } from '../testing/stubs';
import { BASKET_POLL_MS, BasketMatrixComponent } from './basket-matrix.component';
import { RunComparisonComponent } from './run-comparison.component';

declareSignalIo(BasketMatrixComponent, { inputs: ['runIds'] });
declareSignalIo(RunComparisonComponent, { inputs: ['strategyId'] });

const BASE = 'http://test/api/v1/lascodia-trading-engine';
const ok = <T>(data: T) => ({ data, status: true, message: 'Successful', responseCode: '00' });
const settle = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

function runDto(id: number, over: Record<string, unknown> = {}) {
  return {
    id,
    strategyId: 41,
    symbol: 'EURUSD',
    timeframe: 'H1',
    fromDate: '2025-01-01T00:00:00Z',
    toDate: '2026-01-01T00:00:00Z',
    status: 'Completed',
    totalTrades: 100,
    winRate: 0.5,
    profitFactor: 1.2,
    maxDrawdownPct: 9,
    sharpeRatio: 0.8,
    totalReturn: 10,
    resultJson: null,
    ...over,
  };
}

describe('BasketMatrixComponent (PE-I7)', () => {
  let fixture: ComponentFixture<BasketMatrixComponent>;
  let http: HttpTestingController;
  let el: HTMLElement;

  beforeEach(() => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({
      imports: [BasketMatrixComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: RUNTIME_CONFIG, useValue: { apiBaseUrl: 'http://test' } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    vi.useRealTimers();
  });

  it('fills in each market as its run finishes, then stops reading', async () => {
    fixture = TestBed.createComponent(BasketMatrixComponent);
    fixture.componentRef.setInput('runIds', [901, 902]);
    fixture.detectChanges();
    el = fixture.nativeElement as HTMLElement;

    http
      .expectOne(`${BASE}/backtest/901`)
      .flush(ok(runDto(901, { resultJson: JSON.stringify({ ExpectancyR: 0.2 }) })));
    http
      .expectOne(`${BASE}/backtest/902`)
      .flush(ok(runDto(902, { symbol: 'GBPUSD', symbolOverride: 'GBPUSD', status: 'Running' })));
    await settle();
    fixture.detectChanges();
    expect(el.querySelector('[data-run="901"]')!.textContent).toContain('(its own)');
    expect(el.querySelector('[data-run="902"]')!.textContent).toContain('Running');
    expect(el.querySelector('[role="status"]')!.textContent).toContain('1 of 2 runs finished');

    await vi.advanceTimersByTimeAsync(BASKET_POLL_MS);
    http.expectOne(`${BASE}/backtest/902`).flush(
      ok(
        runDto(902, {
          symbol: 'GBPUSD',
          symbolOverride: 'GBPUSD',
          totalReturn: -3,
          resultJson: JSON.stringify({ ExpectancyR: -0.05 }),
        }),
      ),
    );
    await settle();
    fixture.detectChanges();
    expect(el.querySelector('[data-run="902"]')!.textContent).toContain('−3.00%');
    expect(el.querySelector('[data-testid="basket-verdict"]')!.textContent).toContain(
      'Only the strategy’s own market',
    );
    // Every run finished: no further reads.
    await vi.advanceTimersByTimeAsync(BASKET_POLL_MS * 3);
    http.expectNone((r) => r.url.startsWith(`${BASE}/backtest/`));
  });
});

describe('RunComparisonComponent (PE-I7)', () => {
  let fixture: ComponentFixture<RunComparisonComponent>;
  let http: HttpTestingController;
  let el: HTMLElement;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [RunComparisonComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: RUNTIME_CONFIG, useValue: { apiBaseUrl: 'http://test' } },
        { provide: ThemeService, useValue: { theme: () => 'light' } },
      ],
    });
    TestBed.overrideComponent(RunComparisonComponent, {
      remove: { imports: [ChartCardComponent] },
      add: { imports: [ChartCardStubComponent] },
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(RunComparisonComponent);
    fixture.componentRef.setInput('strategyId', 41);
    fixture.detectChanges();
    el = fixture.nativeElement as HTMLElement;
  });

  afterEach(() => http.verify());

  const script = (hash: string, len: number) =>
    JSON.stringify({ ExpectancyR: 0.1, script: { sourceHash: hash, inputs: { len } } });

  it('compares the two newest completed runs: metrics, equity and setup', async () => {
    el.querySelector<HTMLButtonElement>('.head .btn')!.click();
    fixture.detectChanges();
    const list = http.expectOne(`${BASE}/backtest/list`);
    expect(list.request.body.filter).toEqual({ strategyId: 41 });
    list.flush(
      ok({
        pager: { totalItemCount: 3 },
        data: [runDto(1, { status: 'Failed' }), runDto(3), runDto(2)],
      }),
    );
    await settle();
    http.expectOne(`${BASE}/backtest/2`).flush(ok(runDto(2, { resultJson: script('aaa', 20) })));
    http
      .expectOne(`${BASE}/backtest/3`)
      .flush(ok(runDto(3, { totalReturn: 14, resultJson: script('bbb', 30) })));
    await settle();
    fixture.detectChanges();

    const metrics = el.querySelector('[data-testid="compare-metrics"]')!.textContent!;
    expect(metrics).toContain('#2');
    expect(metrics).toContain('#3');
    expect(metrics).toContain('+4.00');
    expect(el.querySelector('[data-testid="compare-script-differs"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="compare-setup"]')!.textContent).toContain('len');
    // No equity curves in these runs: the chart says so instead of drawing nothing.
    expect(el.querySelector('.chart-stub-empty')).not.toBeNull();
  });

  it('says why when the runs cannot be listed', async () => {
    el.querySelector<HTMLButtonElement>('.head .btn')!.click();
    http
      .expectOne(`${BASE}/backtest/list`)
      .flush({ data: null, status: false, message: 'Strategy not found', responseCode: '-14' });
    await settle();
    fixture.detectChanges();
    expect(el.querySelector('[role="alert"]')!.textContent).toContain('Strategy not found');
  });
});
