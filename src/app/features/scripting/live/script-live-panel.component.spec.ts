import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Component, EventEmitter, Input, Output } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';

import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import {
  EATradeChartModalComponent,
  type TradeChartSelection,
} from '@features/ea-instances/components/ea-trade-chart-modal/ea-trade-chart-modal.component';

import { ScriptLivePanelComponent } from './script-live-panel.component';
import { StrategyReportComponent } from '../report/strategy-report.component';
import { normalizeStrategyReport, type ReportTrade } from '../report/strategy-report.model';
import type { TradeOriginOf } from '../report/report-trades-columns';
import { declareSignalIo } from '@shared/testing/jit-signal-io';
import { strategyReportFixture } from '../testing/strategy-report.fixture';
import { liveClosedTradesFixture, liveOpenTradeFixture } from '../testing/live-status.fixture';

declareSignalIo(ScriptLivePanelComponent, { inputs: ['strategyId', 'symbol', 'timeframe'] });

@Component({
  selector: 'app-strategy-report',
  standalone: true,
  template: '<div class="report-stub">{{ heading }}</div>',
})
class ReportStubComponent {
  @Input() report: unknown = null;
  @Input() heading: string | null = null;
  @Input() headingNote: string | null = null;
  @Input() backtestRunId: number | null = null;
  @Input() tradesClickable = false;
  @Input() tradeOrigin: TradeOriginOf | null = null;
  @Output() readonly tradeClick = new EventEmitter<ReportTrade>();
}

@Component({ selector: 'app-ea-trade-chart-modal', standalone: true, template: '' })
class TradeChartModalStubComponent {
  @Input() selection: TradeChartSelection | null = null;
  @Input() open = false;
  @Output() readonly openChange = new EventEmitter<boolean>();
}

/** The report's List-of-trades rows, as the real report would emit them on a click. */
const reportRows = normalizeStrategyReport(strategyReportFixture())!.trades;
const reportRow = (n: number) => reportRows.find((t) => t.number === n)!;

/** The engine with the closed-trades / origin contract. */
function taggedSession() {
  return {
    ...liveSession(),
    openTrades: [liveOpenTradeFixture()],
    closedTrades: liveClosedTradesFixture(),
  };
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

  const reportStub = () =>
    fixture.debugElement.query((d) => d.name === 'app-strategy-report')
      .componentInstance as ReportStubComponent;
  const chart = () =>
    fixture.debugElement.query((d) => d.name === 'app-ea-trade-chart-modal')
      .componentInstance as TradeChartModalStubComponent;
  const openTradesSection = () => el.querySelector('#live-open-trades')!.closest('section')!;
  const openTradeRows = () => [
    ...openTradesSection().querySelectorAll<HTMLTableRowElement>('tbody tr'),
  ];

  function load(payload: unknown): void {
    render();
    http.expectOne(LIVE_URL).flush(ok(payload));
    flushBindings();
    fixture.detectChanges();
  }

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
      remove: { imports: [StrategyReportComponent, EATradeChartModalComponent] },
      add: { imports: [ReportStubComponent, TradeChartModalStubComponent] },
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

  describe('trade chart', () => {
    it('charts a report trade on the backtest position chart, with its origin in the title', () => {
      load(taggedSession());
      const report = reportStub();
      expect(report.tradesClickable).toBe(true);
      expect(chart().open).toBe(false);

      report.tradeClick.emit(reportRow(1));
      fixture.detectChanges();

      const s = chart().selection!;
      expect(chart().open).toBe(true);
      expect(s.title).toBe(
        'Live session · trade #1 · Warm-up replay · EURUSD · Long · exited on take profit',
      );
      expect(s.symbol).toBe('EURUSD');
      expect(s.timeframe).toBe('H1');
      expect([s.stopLoss, s.takeProfit]).toEqual([1.0262, 1.0365]);
      expect([s.exitPrice, s.exitTime]).toEqual([1.0365, '2025-01-08T14:00:00.000Z']);

      // Closing hands the flag back, and another row opens again.
      chart().openChange.emit(false);
      fixture.detectChanges();
      expect(chart().open).toBe(false);
      report.tradeClick.emit(reportRow(6));
      fixture.detectChanges();
      expect(chart().open).toBe(true);
      expect(chart().selection!.title).toBe('Live session · trade #6 · Live · EURUSD · Short');
    });

    it('tells the report which trades are the warm-up replay', () => {
      load(taggedSession());
      const report = reportStub();
      const origin = report.tradeOrigin!;
      expect(origin(reportRow(1))).toBe('warmup');
      expect(origin(reportRow(5))).toBe('paper');
      expect(origin(reportRow(6))).toBe('live');
      expect(origin(reportRow(7))).toBe('paper');
      expect(report.headingNote).toContain('historical replay');
      expect(report.headingNote).toContain('Origin column');
    });

    it('opens an open trade from its row by click, Enter or Space, with an Origin badge', () => {
      load(taggedSession());
      const headers = [...openTradesSection().querySelectorAll('thead th')].map((th) =>
        th.textContent!.trim(),
      );
      expect(headers[0]).toBe('Origin');
      const [row] = openTradeRows();
      const badge = row.querySelector('.origin')!;
      expect(badge.textContent!.trim()).toBe('Paper');
      expect(badge.getAttribute('data-origin')).toBe('paper');
      expect(row.getAttribute('tabindex')).toBe('0');
      expect(row.getAttribute('role')).toBe('button');
      expect(row.getAttribute('aria-label')).toBe('Chart open long trade Long, Paper');

      row.click();
      fixture.detectChanges();
      const s = chart().selection!;
      expect(chart().open).toBe(true);
      expect(s.title).toBe('Live session · trade #7 · Paper · EURUSD · Long · open');
      expect([s.stopLoss, s.takeProfit]).toEqual([1.165, 1.18]);
      // No exit: no dot, and the chart runs to now.
      expect([s.exitPrice, s.exitTime]).toEqual([null, null]);

      // The key is consumed: the chart takes focus on open, and an un-prevented Enter / Space
      // would go on to "press" its first timeframe button (seen in Chromium: it flipped to M1).
      for (const key of ['Enter', ' ']) {
        chart().openChange.emit(false);
        fixture.detectChanges();
        const press = new KeyboardEvent('keydown', { key, cancelable: true });
        row.dispatchEvent(press);
        fixture.detectChanges();
        expect(chart().open).toBe(true);
        expect(press.defaultPrevented).toBe(true);
      }
    });

    it('keeps an open chart as it is through a refresh', () => {
      load(taggedSession());
      openTradeRows()[0].click();
      fixture.detectChanges();
      const selection = chart().selection;

      // A new bar: the trade's stop trailed up. The open chart keeps its selection (a new one
      // would reload and re-frame it); the table shows the new level.
      el.querySelector<HTMLButtonElement>('.head .btn')!.click();
      http.expectOne(LIVE_URL).flush(
        ok({
          ...taggedSession(),
          lastBarTimeMs: Date.now() - 60_000,
          openTrades: [{ ...liveOpenTradeFixture(), stopLoss: 1.168 }],
        }),
      );
      fixture.detectChanges();

      expect(openTradesSection().textContent).toContain('1.16800');
      expect(chart().open).toBe(true);
      expect(chart().selection).toBe(selection);
    });

    it('opens on the strategy’s own timeframe when the page passes it', () => {
      fixture = TestBed.createComponent(ScriptLivePanelComponent);
      fixture.componentRef.setInput('strategyId', 41);
      fixture.componentRef.setInput('symbol', 'EURUSD');
      fixture.componentRef.setInput('timeframe', 'M15');
      fixture.detectChanges();
      el = fixture.nativeElement as HTMLElement;
      http.expectOne(LIVE_URL).flush(ok(taggedSession()));
      flushBindings();
      fixture.detectChanges();

      reportStub().tradeClick.emit(reportRow(3));
      fixture.detectChanges();
      expect(chart().selection!.timeframe).toBe('M15');
    });

    it('works against an engine without closed trades or origins: no zones, origin unknown', () => {
      load(liveSession());
      const report = reportStub();
      // No Origin column of unknowns, and the hint says why.
      expect(report.tradeOrigin).toBeNull();
      expect(report.headingNote).toContain('does not mark');
      const headers = [...openTradesSection().querySelectorAll('thead th')].map((th) =>
        th.textContent!.trim(),
      );
      expect(headers).not.toContain('Origin');

      report.tradeClick.emit(reportRow(2));
      fixture.detectChanges();
      let s = chart().selection!;
      expect(s.title).toBe(
        'Live session · trade #2 · Origin unknown · EURUSD · Short · exited on stop loss',
      );
      expect([s.stopLoss, s.takeProfit]).toEqual([null, null]);
      expect([s.exitPrice, s.exitTime]).toEqual([1.034, '2025-01-16T12:00:00.000Z']);

      chart().openChange.emit(false);
      fixture.detectChanges();
      openTradeRows()[0].click();
      fixture.detectChanges();
      s = chart().selection!;
      expect(s.title).toBe('Live session · trade #7 · Origin unknown · EURUSD · Long · open');
      // The older payload's stop (`protectedStop`) still draws its zone.
      expect(s.stopLoss).toBe(1.16512);
      expect(s.exitTime).toBeNull();
    });
  });
});
