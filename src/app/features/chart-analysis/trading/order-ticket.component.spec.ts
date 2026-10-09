import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';

import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import { NotificationService } from '@core/notifications/notification.service';
import { AccountScopeService } from '@core/scope/account-scope.service';
import { declareSignalIo } from '@shared/testing/jit-signal-io';

import { OrderTicketComponent } from './order-ticket.component';
import type { ManualTradePreview, TradeGate } from './manual-trading.types';
import { DEFAULT_TICKET, type TicketState } from './ticket-model';

declareSignalIo(OrderTicketComponent, {
  inputs: ['symbol', 'precision', 'pipSize', 'quote', 'state'],
  outputs: ['closed', 'submitted', 'previewChange', 'stateChange'],
});

const BASE = 'http://test/api/v1/lascodia-trading-engine';
const ok = <T>(data: T) => ({ data, status: true, message: 'Successful', responseCode: '00' });

const ACCOUNT = { id: 17, accountId: '107699364', accountName: 'Demo 17', accountType: 'Demo' };

function preview(
  over: Partial<ManualTradePreview> = {},
  gates: TradeGate[] = [],
): ManualTradePreview {
  return {
    canSubmit: true,
    refusedReason: null,
    mode: 'Paper',
    account: {
      id: 17,
      accountId: '107699364',
      accountName: 'Demo 17',
      accountType: 'Demo',
      currency: 'USD',
      equity: 10_000,
      balance: 10_000,
      riskProfileId: 4,
      riskProfileName: 'RP4',
    },
    manualStrategyId: null,
    symbol: 'EURUSD',
    direction: 'Buy',
    digits: 5,
    pipSize: 0.0001,
    quote: { bid: 1.1, ask: 1.1001, spreadPips: 1, ageSeconds: 1 },
    entry: 1.1001,
    entryAtMarket: true,
    stopLoss: 1.0971,
    takeProfit: 1.1061,
    stopPips: 30,
    targetPips: 60,
    rewardRisk: 2,
    atr: {
      value: 0.002,
      pips: 20,
      timeframe: 'H1',
      period: 14,
      minStopMultiple: 1,
      minStopLevel: 1.0981,
      stopInAtr: 1.5,
    },
    lots: 0.33,
    lotsAfterRiskCheck: 0.32,
    pipValuePerLot: 10,
    riskMoney: 96,
    riskPctOfEquity: 0.96,
    rewardMoney: 192,
    swap: null,
    exposure: null,
    gates: gates.length
      ? gates
      : [
          {
            key: 'tier2',
            name: 'Account risk check (Tier 2)',
            passed: true,
            blocking: true,
            detail: 'ok',
          },
        ],
    notes: [],
    ...over,
  };
}

describe('OrderTicketComponent (SP-I4)', () => {
  let fixture: ComponentFixture<OrderTicketComponent>;
  let http: HttpTestingController;
  let el: HTMLElement;
  const notify = { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() };

  const q = <T extends Element>(sel: string) => el.querySelector(sel) as T;
  const byId = <T extends Element>(id: string) => q<T>(`[data-testid="${id}"]`);

  function render(state: Partial<TicketState> = {}): void {
    fixture = TestBed.createComponent(OrderTicketComponent);
    fixture.componentRef.setInput('symbol', 'EURUSD');
    fixture.componentRef.setInput('precision', 5);
    fixture.componentRef.setInput('pipSize', 0.0001);
    fixture.componentRef.setInput('quote', { bid: 1.1, ask: 1.1001 });
    fixture.componentRef.setInput('state', { ...DEFAULT_TICKET, ...state });
    fixture.detectChanges();
    el = fixture.nativeElement as HTMLElement;
  }

  /** Lets the debounce run and answers the preview it sends. */
  function answerPreview(
    body: ManualTradePreview | null,
    message = 'Successful',
  ): Record<string, unknown> {
    vi.advanceTimersByTime(400);
    const req = http.expectOne(`${BASE}/trade-signal/preview`);
    const sent = req.request.body as Record<string, unknown>;
    req.flush(body ? ok(body) : { data: null, status: false, message, responseCode: '-14' });
    fixture.detectChanges();
    return sent;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    Object.values(notify).forEach((f) => f.mockReset());
    TestBed.configureTestingModule({
      imports: [OrderTicketComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: RUNTIME_CONFIG, useValue: { apiBaseUrl: 'http://test' } },
        { provide: NotificationService, useValue: notify },
        {
          provide: AccountScopeService,
          useValue: {
            liveAccounts: signal([ACCOUNT]),
            accounts: signal([ACCOUNT]),
            effectiveSelectedId: signal(17),
          },
        },
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    fixture?.destroy();
    http.verify();
    vi.useRealTimers();
  });

  it('defaults to the scope account and paper, and previews a market ticket without an entry price', () => {
    render();
    const sent = answerPreview(preview({ stopLoss: null, takeProfit: null }));
    expect(sent).toEqual({
      tradingAccountId: 17,
      symbol: 'EURUSD',
      direction: 'Buy',
      entryPrice: null,
      stopLoss: null,
      takeProfit: null,
      mode: 'Paper',
    });
    // The first answer with an ATR places the default brackets (1.5 ATR, 2R) and asks again.
    const again = answerPreview(preview());
    expect(again['stopLoss']).toBe(1.0971);
    expect(again['takeProfit']).toBe(1.1061);
    expect(byId('ticket-facts').textContent).toContain('0.32 lots');
    expect(byId<HTMLButtonElement>('ticket-submit').disabled).toBe(false);
  });

  it('refuses a stop inside the ATR guard in the chart, before the engine is asked to send it', () => {
    render({ accountId: 17, stop: 1.0995, target: 1.106 });
    answerPreview(preview({ stopLoss: 1.0995 }));
    expect(byId('ticket-guard').textContent).toContain('ATR from the entry');
    expect(byId<HTMLButtonElement>('ticket-submit').disabled).toBe(true);
  });

  it('shows the engine’s refusal and keeps Submit off', () => {
    render({ accountId: 17, stop: 1.0971, target: 1.1061, mode: 'Live' });
    answerPreview(
      preview({ canSubmit: false, refusedReason: 'Real account: live off' }, [
        {
          key: 'mode',
          name: 'Live tickets',
          passed: false,
          blocking: true,
          detail: 'Real account: live off',
        },
        { key: 'eaSafety', name: 'Account EA', passed: true, blocking: true, detail: 'RUNNING' },
      ]),
    );
    expect(byId('ticket-why').textContent).toContain('Real account: live off');
    expect(byId('ticket-gates').textContent).toContain('Live tickets');
    expect(byId<HTMLButtonElement>('ticket-submit').disabled).toBe(true);
  });

  it('submits paper at once', () => {
    render({ accountId: 17, stop: 1.0971, target: 1.1061 });
    answerPreview(preview());
    byId<HTMLButtonElement>('ticket-submit').click();
    const req = http.expectOne(`${BASE}/trade-signal/manual`);
    expect(req.request.body).toMatchObject({ mode: 'Paper', stopLoss: 1.0971 });
    req.flush(
      ok({
        mode: 'Paper',
        tradeSignalId: null,
        paperExecutionId: 77,
        manualStrategyId: 9,
        preview: preview(),
        message: 'Paper trade 77 opened',
      }),
    );
    expect(notify.success).toHaveBeenCalledWith('Paper trade 77 opened');
  });

  it('asks once more before a live order, naming the account and the size', () => {
    render({ accountId: 17, stop: 1.0971, target: 1.1061, mode: 'Live' });
    answerPreview(preview({ mode: 'Live' }));
    byId<HTMLButtonElement>('ticket-submit').click();
    fixture.detectChanges();
    http.expectNone(`${BASE}/trade-signal/manual`);
    expect(byId('ticket-live-confirm').textContent).toContain(
      '0.32 lots EURUSD on Demo account 107699364',
    );
    byId<HTMLButtonElement>('ticket-confirm').click();
    const req = http.expectOne(`${BASE}/trade-signal/manual`);
    expect(req.request.body).toMatchObject({ mode: 'Live' });
    req.flush({
      data: { preview: preview({ canSubmit: false }) },
      status: false,
      message: 'Near-duplicate',
      responseCode: '-11',
    });
    expect(notify.error).toHaveBeenCalledWith('Near-duplicate');
  });

  it('mirrors the brackets when the side flips', () => {
    render({ accountId: 17, stop: 1.0971, target: 1.1061 });
    answerPreview(preview());
    byId<HTMLButtonElement>('ticket-sell').click();
    fixture.detectChanges();
    const sent = answerPreview(preview({ direction: 'Sell' }));
    expect(sent).toMatchObject({ direction: 'Sell', stopLoss: 1.1031, takeProfit: 1.0941 });
  });
});
