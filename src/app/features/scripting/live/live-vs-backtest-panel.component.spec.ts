import { afterEach, describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';

import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import { declareSignalIo } from '@shared/testing/jit-signal-io';
import { RollingRChartComponent } from '../report/rolling-r-chart.component';
import { ChartCardStubComponent } from '../testing/stubs';
import { LiveVsBacktestPanelComponent } from './live-vs-backtest-panel.component';

declareSignalIo(LiveVsBacktestPanelComponent, {
  inputs: ['strategyId', 'trades', 'divergences', 'lifecycleStage', 'lifecycleStageEnteredAt'],
});
declareSignalIo(RollingRChartComponent, { inputs: ['points', 'closed', 'title', 'source'] });

const BASE = 'http://test/api/v1/lascodia-trading-engine';
const ok = <T>(data: T) => ({ data, status: true, message: 'Successful', responseCode: '00' });
const settle = () => new Promise((r) => setTimeout(r, 0));

const trade = (r: number, exit: number) => ({
  tradeKey: exit,
  entryId: 'L',
  direction: 'long',
  qty: 1,
  lots: 0.01,
  entryPrice: 1.1,
  entryTimeMs: exit - 1,
  exitPrice: 1.1 + r * 0.001,
  exitTimeMs: exit,
  exitLeg: '',
  exitComment: '',
  profit: r,
  stopLoss: 1.099,
  takeProfit: null,
  origin: 'live',
});

describe('LiveVsBacktestPanelComponent (U08 live / U09)', () => {
  let http: HttpTestingController;
  afterEach(() => http.verify());

  it('compares the session with the newest non-parity backtest and draws the overlay', async () => {
    TestBed.configureTestingModule({
      imports: [LiveVsBacktestPanelComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: RUNTIME_CONFIG, useValue: { apiBaseUrl: 'http://test' } },
      ],
    });
    for (const cmp of [LiveVsBacktestPanelComponent, RollingRChartComponent]) {
      TestBed.overrideComponent(cmp, {
        remove: { imports: [ChartCardComponent] },
        add: { imports: [ChartCardStubComponent] },
      });
    }
    http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(LiveVsBacktestPanelComponent);
    fixture.componentRef.setInput('strategyId', 9);
    fixture.componentRef.setInput('trades', [trade(1, 1_000), trade(-1, 2_000)]);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;

    const list = http.match(`${BASE}/backtest/list`)[0];
    expect(list.request.body.filter).toEqual({
      strategyId: 9,
      status: 'Completed',
      includeResultJson: true,
    });
    list.flush(
      ok({
        pager: {},
        data: [
          { id: 11, queueSource: 'Parity', resultJson: '{}', fromDate: 'a', toDate: 'b' },
          {
            id: 10,
            queueSource: 'Manual',
            completedAt: '2026-01-01T00:00:00Z',
            fromDate: '2024-01-01T00:00:00',
            toDate: '2025-01-01T00:00:00',
            resultJson: JSON.stringify({ Trades: [{ RMultiple: 1 }, { RMultiple: 0 }] }),
          },
        ],
      }),
    );
    http.expectOne(`${BASE}/walk-forward/list`).flush(ok({ pager: {}, data: [] }));
    http.expectOne(`${BASE}/execution-quality/list`).flush(ok({ pager: {}, data: [] }));
    await settle();
    fixture.detectChanges();
    expect(el.textContent).toContain('backtest #10');
    expect(el.textContent).toContain('0.500 R per trade');
    expect(el.querySelector('[data-testid="lvb-verdict"]')!.textContent).toContain(
      'Live: After 2 trades',
    );
    const titles = [...el.querySelectorAll('.chart-stub')].map((c) => c.getAttribute('data-title'));
    expect(titles).toContain('Cumulative R — expected vs realised');
  });
});
