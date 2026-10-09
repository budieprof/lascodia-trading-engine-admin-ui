import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';

import type { OrderDto } from '@core/api/api.types';
import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import { NotificationService } from '@core/notifications/notification.service';
import { declareSignalIo } from '@shared/testing/jit-signal-io';

import type { ChartPosition } from '../overlays/trade-layer';
import { ChartTradingComponent } from './chart-trading.component';
import type { PositionChangePreview } from './manual-trading.types';
import type { TradeLine } from './trade-lines';

declareSignalIo(ChartTradingComponent, {
  inputs: [
    'host',
    'symbol',
    'precision',
    'pipSize',
    'quote',
    'lotStep',
    'positions',
    'orders',
    'accountIds',
    'open',
    'prefill',
  ],
  outputs: ['submitted', 'changed', 'openChange'],
});

const BASE = 'http://test/api/v1/lascodia-trading-engine';
const ok = <T>(data: T, code = '00') => ({
  data,
  status: true,
  message: 'Successful',
  responseCode: code,
});

const POSITION = {
  id: 501,
  tradingAccountId: 17,
  symbol: 'EURUSD',
  direction: 'Long',
  openLots: 0.5,
  averageEntryPrice: 1.1,
  stopLoss: 1.097,
  takeProfit: 1.106,
} as ChartPosition;

const ORDER = {
  id: 601,
  tradingAccountId: 17,
  symbol: 'EURUSD',
  orderType: 'Buy',
  executionType: 'Limit',
  quantity: 0.2,
  price: 1.095,
  stopLoss: 1.092,
  takeProfit: 1.101,
  status: 'Submitted',
} as OrderDto;

function preview(over: Partial<PositionChangePreview> = {}): PositionChangePreview {
  return {
    positionId: 501,
    tradingAccountId: 17,
    accountId: '134646967',
    accountName: 'Real 27',
    accountType: 'Real',
    currency: 'USD',
    symbol: 'EURUSD',
    isLong: true,
    openLots: 0.5,
    entry: 1.1,
    initialStop: 1.097,
    currentStop: 1.097,
    currentTarget: 1.106,
    triggerPrice: 1.1,
    pipSize: 0.0001,
    pipValuePerLot: 10,
    atr: null,
    newStop: null,
    stopDistancePips: null,
    stopDistanceAtr: null,
    pnlAtNewStop: null,
    rAtNewStop: null,
    newTarget: null,
    pnlAtNewTarget: null,
    rAtNewTarget: null,
    closeLots: null,
    closePnl: null,
    gates: [
      {
        key: 'eaRoute',
        name: 'Account EA',
        passed: true,
        blocking: true,
        detail: 'Sent through the EA',
      },
    ],
    canApply: true,
    refusedReason: null,
    ...over,
  };
}

describe('ChartTradingComponent (SP-I3)', () => {
  let fixture: ComponentFixture<ChartTradingComponent>;
  let http: HttpTestingController;
  let el: HTMLElement;
  let changed: number;
  const notify = { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() };

  /** The primitive's callbacks, as a drag or a click on the chart would call them. */
  const drag = (line: Partial<TradeLine>, price: number) =>
    (
      fixture.componentInstance as unknown as {
        onLineMoved(m: { line: TradeLine; price: number }): void;
      }
    ).onLineMoved({
      line: line as TradeLine,
      price,
    });
  const click = (line: Partial<TradeLine>) =>
    (fixture.componentInstance as unknown as { onLineClicked(l: TradeLine): void }).onLineClicked(
      line as TradeLine,
    );
  const byId = <T extends Element>(id: string) => el.querySelector(`[data-testid="${id}"]`) as T;

  beforeAll(() => {
    // jsdom has no modal dialogs.
    const proto = HTMLDialogElement.prototype as unknown as Record<string, unknown>;
    proto['showModal'] ??= function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    proto['close'] ??= function (this: HTMLDialogElement) {
      this.removeAttribute('open');
    };
  });

  beforeEach(() => {
    vi.useFakeTimers();
    Object.values(notify).forEach((f) => f.mockReset());
    TestBed.configureTestingModule({
      imports: [ChartTradingComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: RUNTIME_CONFIG, useValue: { apiBaseUrl: 'http://test' } },
        { provide: NotificationService, useValue: notify },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(ChartTradingComponent);
    fixture.componentRef.setInput('symbol', 'EURUSD');
    fixture.componentRef.setInput('precision', 5);
    fixture.componentRef.setInput('pipSize', 0.0001);
    fixture.componentRef.setInput('quote', { bid: 1.1, ask: 1.1001 });
    fixture.componentRef.setInput('positions', [POSITION]);
    fixture.componentRef.setInput('orders', [ORDER]);
    fixture.componentRef.setInput('accountIds', [17]);
    changed = 0;
    fixture.componentInstance.changed.subscribe(() => changed++);
    fixture.detectChanges();
    el = fixture.nativeElement as HTMLElement;
  });

  afterEach(() => {
    fixture.destroy();
    http.verify();
    vi.useRealTimers();
  });

  it('asks before moving a stop, sends it through the EA with a correlation id, and keeps it pending until the EA answers', () => {
    drag({ kind: 'positionStop', refId: 501, price: 1.097 }, 1.0975);
    fixture.detectChanges();

    const pv = http.expectOne(`${BASE}/position/501/change-preview`);
    expect(pv.request.body).toEqual({ stopLoss: 1.0975 });
    pv.flush(
      ok(
        preview({
          newStop: 1.0975,
          stopDistancePips: 25,
          stopDistanceAtr: 1.25,
          pnlAtNewStop: -125,
          rAtNewStop: -0.83,
        }),
      ),
    );
    fixture.detectChanges();
    expect(byId('trade-action-dialog').textContent).toContain('real money');
    expect(byId('trade-action-dialog').textContent).toContain('-125.00 USD');

    byId<HTMLButtonElement>('trade-action-apply').click();
    const mod = http.expectOne(`${BASE}/position/501/modify-sl-tp`);
    expect(mod.request.body).toMatchObject({
      stopLoss: 1.0975,
      takeProfit: null,
      brokerRouteOnly: true,
    });
    const cid = (mod.request.body as { correlationId: string }).correlationId;
    expect(cid).toMatch(/^chart-[0-9a-f]{20}$/);
    mod.flush(ok('Queued'));
    expect(fixture.componentInstance.pending()).toHaveLength(1);

    // The EA refuses it: the reason is shown and the trade layer re-read (the engine restored the broker's stop).
    vi.advanceTimersByTime(1600);
    http
      .expectOne(`${BASE}/position/command-status?correlationId=${cid}`)
      .flush(ok({ acknowledged: true, succeeded: false, result: 'Invalid stops' }));
    expect(fixture.componentInstance.pending()).toHaveLength(0);
    expect(notify.error).toHaveBeenCalledWith(expect.stringContaining('Invalid stops'));
    expect(changed).toBeGreaterThanOrEqual(2);
  });

  it('keeps Apply off when the engine refuses the change, and says why', () => {
    drag({ kind: 'positionStop', refId: 501, price: 1.097 }, 1.0995);
    fixture.detectChanges();
    http.expectOne(`${BASE}/position/501/change-preview`).flush(
      ok(
        preview({
          canApply: false,
          refusedReason: 'The new stop is 0.25 ATR from the current bid',
          gates: [
            {
              key: 'stopGuard',
              name: 'Stop distance',
              passed: false,
              blocking: true,
              detail: 'The new stop is 0.25 ATR from the current bid',
            },
          ],
        }),
      ),
    );
    fixture.detectChanges();
    expect(byId<HTMLButtonElement>('trade-action-apply').disabled).toBe(true);
    expect(byId('trade-action-dialog').textContent).toContain('0.25 ATR');
  });

  it('refuses a stop dragged through the price before asking anyone', () => {
    drag({ kind: 'positionStop', refId: 501, price: 1.097 }, 1.1002);
    expect(notify.warning).toHaveBeenCalledWith(expect.stringContaining('below'));
    http.expectNone(`${BASE}/position/501/change-preview`);
  });

  it('closes part of a position from its entry line at the live price', () => {
    click({ kind: 'positionEntry', refId: 501, price: 1.1 });
    fixture.detectChanges();
    http
      .expectOne(`${BASE}/position/501/change-preview`)
      .flush(ok(preview({ closeLots: 0.5, closePnl: 0 })));
    fixture.detectChanges();

    const lots = byId<HTMLInputElement>('close-lots');
    lots.value = '0.2';
    lots.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    const pv = http.expectOne(`${BASE}/position/501/change-preview`);
    expect(pv.request.body).toEqual({ closeLots: 0.2 });
    pv.flush(ok(preview({ closeLots: 0.2, closePnl: 0 })));
    fixture.detectChanges();

    byId<HTMLButtonElement>('trade-action-apply').click();
    const close = http.expectOne(`${BASE}/position/501/close`);
    expect(close.request.body).toMatchObject({
      id: 501,
      closePrice: 1.1,
      closeLots: 0.2,
      brokerRouteOnly: true,
    });
    close.flush(ok('PartialClose'));
    expect(fixture.componentInstance.pending()[0]).toMatchObject({ kind: 'close', refId: 501 });
  });

  it('cancels a working order from its price line; without an EA command it settles as done', () => {
    click({ kind: 'orderPrice', refId: 601, price: 1.095 });
    fixture.detectChanges();
    byId<HTMLButtonElement>('trade-action-apply').click();
    const req = http.expectOne((r) =>
      r.url.startsWith(`${BASE}/order/601/cancel?correlationId=chart-`),
    );
    req.flush(ok(null));
    expect(fixture.componentInstance.pending()).toHaveLength(1);

    const none = {
      data: null,
      status: false,
      message: 'No EA command carries this correlation id',
      responseCode: '-14',
    };
    // Inside the grace period a missing command is not yet "engine-side only": still pending.
    vi.advanceTimersByTime(1600);
    http.expectOne((x) => x.url.includes('/position/command-status')).flush(none);
    expect(fixture.componentInstance.pending()).toHaveLength(1);
    // After it, the change was engine-side only (no broker ticket): done.
    vi.advanceTimersByTime(4600);
    http.expectOne((x) => x.url.includes('/position/command-status')).flush(none);
    expect(fixture.componentInstance.pending()).toHaveLength(0);
    expect(notify.success).toHaveBeenCalled();
  });

  it('a refused send leaves the line where it was and shows the reason in the dialog', () => {
    drag({ kind: 'positionTarget', refId: 501, price: 1.106 }, 1.108);
    fixture.detectChanges();
    http.expectOne(`${BASE}/position/501/change-preview`).flush(ok(preview({ newTarget: 1.108 })));
    fixture.detectChanges();
    byId<HTMLButtonElement>('trade-action-apply').click();
    http
      .expectOne(`${BASE}/position/501/modify-sl-tp`)
      .flush({
        data: 'NoBrokerRoute',
        status: false,
        message: 'No active EA for account 17 on EURUSD',
        responseCode: '-11',
      });
    fixture.detectChanges();
    expect(fixture.componentInstance.pending()).toHaveLength(0);
    expect(byId('trade-action-error').textContent).toContain('No active EA');
  });
});
