import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Component, Input } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';

import { RUNTIME_CONFIG } from '@core/config/runtime-config';

import { ScriptLivePanelComponent } from './script-live-panel.component';
import { StrategyReportComponent } from '../report/strategy-report.component';
import { declareSignalIo } from '@shared/testing/jit-signal-io';
import { strategyReportFixture } from '../testing/strategy-report.fixture';

declareSignalIo(ScriptLivePanelComponent, { inputs: ['strategyId'] });

@Component({
  selector: 'app-strategy-report',
  standalone: true,
  template: '<div class="report-stub">{{ heading }}</div>',
})
class ReportStubComponent {
  @Input() report: unknown = null;
  @Input() heading: string | null = null;
  @Input() backtestRunId: number | null = null;
}

const BASE = 'http://test/api/v1/lascodia-trading-engine';
const LIVE_URL = `${BASE}/strategy/41/script/live`;
const BINDINGS_URL = `${BASE}/strategy/41/account-bindings`;

const ok = <T>(data: T) => ({ data, status: true, message: 'Successful', responseCode: '00' });

function liveSession() {
  return {
    status: 'Running',
    lastBarTimeMs: Date.now() - 30 * 60_000,
    position: { size: 10000, avgPrice: 1.17012, openPnL: 35.4, entryTime: Date.UTC(2026, 0, 5, 8) },
    openTrades: [
      {
        entryId: 'Long',
        direction: 'long',
        qty: 10000,
        entryPrice: 1.17012,
        entryTime: Date.UTC(2026, 0, 5, 8),
        protectedStop: 1.16512,
      },
    ],
    pendingOrders: [
      {
        id: 'Exit TP',
        command: 'Exit',
        side: 'Sell',
        qty: 10000,
        limit: 1.18012,
        stop: null,
        comment: 'TP',
      },
    ],
    equity: 10641.2,
    report: strategyReportFixture(),
    divergences: [
      {
        timeUtc: '2026-01-06T10:00:00Z',
        accountId: 27,
        kind: 'OrderRejected',
        detail: 'Broker rejected: not enough money',
      },
      {
        timeUtc: '2026-01-07T09:30:00Z',
        accountId: 99,
        kind: 'Slippage',
        detail: 'Filled 1.2 pips worse',
      },
    ],
  };
}

describe('ScriptLivePanelComponent', () => {
  let fixture: ComponentFixture<ScriptLivePanelComponent>;
  let http: HttpTestingController;
  let el: HTMLElement;

  function render(): void {
    fixture = TestBed.createComponent(ScriptLivePanelComponent);
    fixture.componentRef.setInput('strategyId', 41);
    fixture.detectChanges();
    el = fixture.nativeElement as HTMLElement;
  }

  function flushBindings(): void {
    http.expectOne(BINDINGS_URL).flush(
      ok([
        {
          tradingAccountId: 27,
          accountName: 'Exness Real 27',
          lotMultiplier: 1,
          isEnabled: true,
        },
      ]),
    );
  }

  const text = () => el.textContent!.replace(/\s+/g, ' ');

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [ScriptLivePanelComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: RUNTIME_CONFIG, useValue: { apiBaseUrl: 'http://test' } },
      ],
    });
    TestBed.overrideComponent(ScriptLivePanelComponent, {
      remove: { imports: [StrategyReportComponent] },
      add: { imports: [ReportStubComponent] },
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    fixture?.destroy();
  });

  it('shows the session, position, open trades, pending orders and equity', () => {
    render();
    http.expectOne(LIVE_URL).flush(ok(liveSession()));
    flushBindings();
    fixture.detectChanges();

    const status = el.querySelector('.status')!;
    expect(status.textContent).toContain('Running');
    expect(status.getAttribute('data-tone')).toBe('success');
    expect(text()).toContain('Long 10,000 units @ 1.17012');
    expect(text()).toContain('Open P&L +35.40 USD');
    expect(text()).toContain('10,641.20 USD');
    expect(text()).toContain('30 min ago');

    const [trades, orders] = [...el.querySelectorAll('.table-wrap table')];
    expect(trades.querySelector('thead')!.textContent).toContain('Entry ID');
    expect(trades.querySelector('tbody')!.textContent).toContain('1.16512');
    // The emulator's quantities are Pine units, never lots.
    expect(trades.querySelector('tbody')!.textContent).toContain('10,000 units');
    expect(orders.querySelector('tbody')!.textContent).toContain('Exit');
    expect(orders.querySelector('tbody')!.textContent).toContain('1.18012');
    expect(orders.querySelector('tbody')!.textContent).toContain('10,000 units');
    // No account position is left over from an earlier script version.
    expect(el.querySelector('#live-orphaned')).toBeNull();

    const report = fixture.debugElement.query((d) => d.name === 'app-strategy-report')
      .componentInstance as ReportStubComponent;
    expect(report.heading).toBe('Live emulator report');
    expect((report.report as any).meta.symbol).toBe('EURUSD');
  });

  it('lists divergences newest first with the bound account’s name', () => {
    render();
    http.expectOne(LIVE_URL).flush(ok(liveSession()));
    flushBindings();
    fixture.detectChanges();

    const rows = [...el.querySelectorAll('.table-wrap')].at(-1)!.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('2026-01-07 09:30');
    expect(rows[0].textContent).toContain('Account #99');
    expect(rows[1].textContent).toContain('Exness Real 27 (#27)');
    expect(rows[1].textContent).toContain('OrderRejected');
    expect(rows[1].textContent).toContain('not enough money');
    expect(el.querySelector('.fact-value.loss')!.textContent!.trim()).toBe('2');
  });

  it('explains a strategy without a live session', () => {
    render();
    http.expectOne(LIVE_URL).flush({
      data: null,
      status: false,
      message: 'No live session for strategy 41',
      responseCode: '-14',
    });
    flushBindings();
    fixture.detectChanges();
    expect(text()).toContain('No live session');
    expect(text()).toContain('No live session for strategy 41');
  });

  it('offers a retry when the first load fails, and keeps the last state on a later failure', () => {
    render();
    http.expectOne(LIVE_URL).flush('boom', { status: 502, statusText: 'Bad Gateway' });
    flushBindings();
    fixture.detectChanges();
    const retry = el.querySelector<HTMLButtonElement>('.error .btn')!;
    expect(el.querySelector('[role="alert"]')).not.toBeNull();

    retry.click();
    http.expectOne(LIVE_URL).flush(ok(liveSession()));
    fixture.detectChanges();
    expect(text()).toContain('Long 10,000');

    el.querySelector<HTMLButtonElement>('.head .btn')!.click();
    http.expectOne(LIVE_URL).flush('down', { status: 503, statusText: 'Unavailable' });
    fixture.detectChanges();
    expect(text()).toContain('Long 10,000');
    expect(text()).toContain('The last refresh failed');
  });

  it('shows the emulator in units ≈ lots, and earlier account positions in lots', () => {
    render();
    http.expectOne(LIVE_URL).flush(
      ok({
        ...liveSession(),
        // The engine's DEC-18 status: sizes in Pine units, with the broker lots they come to.
        position: { size: 100_000, lots: 1, avgPrice: 1.17012, openProfit: 35.4 },
        openTrades: [
          {
            tradeKey: 7,
            entryId: 'Long',
            direction: 'long',
            qty: 100_000,
            lots: 1,
            entryPrice: 1.17012,
            entryTimeMs: Date.UTC(2026, 0, 5, 8),
            stopLoss: 1.16512,
          },
        ],
        orphanedPositions: [
          {
            positionId: 5012,
            accountId: 27,
            symbol: 'EURUSD',
            direction: 'short',
            lots: 0.5,
            entryId: 'Short',
            signalId: 88,
            stopLoss: 1.1821,
            takeProfit: null,
            status: 'Open',
            orphanedAtUtc: '2026-09-24T21:00:00Z',
          },
          {
            positionId: 5013,
            accountId: 99,
            symbol: 'EURUSD',
            direction: 'long',
            lots: 1,
            entryId: 'Long',
            signalId: null,
            stopLoss: null,
            takeProfit: 1.19,
            status: 'Closing',
            orphanedAtUtc: '2026-09-24T21:05:00Z',
          },
        ],
      }),
    );
    flushBindings();
    fixture.detectChanges();

    expect(el.querySelector('.fact-value[data-side="long"]')!.textContent).toContain(
      'Long 100,000 units ≈ 1.00 lot @ 1.17012',
    );
    const trades = el.querySelector('#live-open-trades')!.closest('section')!;
    const headers = [...trades.querySelectorAll('thead th')].map((th) => th.textContent!.trim());
    expect(headers.slice(0, 4)).toEqual(['Entry ID', 'Direction', 'Qty', 'Lots']);
    const cells = [...trades.querySelectorAll('tbody td')].map((td) => td.textContent!.trim());
    expect(cells.slice(0, 4)).toEqual(['Long', 'long', '100,000 units', '1.00 lot']);

    const section = el.querySelector('#live-orphaned')!.closest('section')!;
    expect(section.textContent).toContain('Account positions from an earlier script version');
    expect(section.textContent).toContain('broker lots');
    const rows = section.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('Exness Real 27 (#27)');
    expect(rows[0].textContent).toContain('#5012');
    expect(rows[0].textContent).toContain('Short');
    expect(rows[0].textContent).toContain('0.50 lots');
    expect(rows[0].textContent).toContain('1.18210');
    expect(rows[0].textContent).toContain('2026-09-24 21:00');
    expect(rows[1].textContent).toContain('Account #99');
    expect(rows[1].textContent).toContain('1.00 lot');
    expect(rows[1].textContent).not.toContain('units');
    expect(rows[1].textContent).toContain('Closing');
  });

  it('shows a flat position', () => {
    render();
    http
      .expectOne(LIVE_URL)
      .flush(ok({ ...liveSession(), position: { size: 0 }, openTrades: [], pendingOrders: [] }));
    flushBindings();
    fixture.detectChanges();
    expect(text()).toContain('Flat — no open position');
    expect(text()).toContain('Open trades 0');
  });
});
