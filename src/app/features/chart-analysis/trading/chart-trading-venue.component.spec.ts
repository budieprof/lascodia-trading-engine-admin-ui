import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Output } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';

import type { CurrencyPairDto } from '@core/api/api.types';
import { AuthService } from '@core/auth/auth.service';
import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import { instrumentFromCurrencyPair, setInstrumentCatalogue } from '@core/instruments/instrument-math';
import type { InstrumentDto } from '@core/instruments/instrument.types';
import { NotificationService } from '@core/notifications/notification.service';
import { ModalA11yDirective } from '@shared/directives/modal-a11y.directive';
import { declareSignalIo } from '@shared/testing/jit-signal-io';

import { ChartTradingComponent } from './chart-trading.component';
import { OrderTicketComponent } from './order-ticket.component';
import { VenueOrderTicketComponent } from './venue-order-ticket.component';
import { VenueTicketBus } from './venue-ticket-bus.service';

declareSignalIo(ChartTradingComponent, {
  inputs: ['host', 'symbol', 'precision', 'pipSize', 'quote', 'lotStep', 'positions', 'orders', 'accountIds', 'open', 'prefill'],
  outputs: ['submitted', 'changed', 'openChange'],
});
declareSignalIo(OrderTicketComponent, {
  inputs: ['symbol', 'precision', 'pipSize', 'quote', 'state'],
  outputs: ['closed', 'submitted', 'previewChange'],
});
// `state` is a model(): its change event is the model signal itself (the parent binds [(state)]).
(Output as unknown as (alias?: string) => PropertyDecorator)('stateChange')(OrderTicketComponent.prototype, 'state');
declareSignalIo(VenueOrderTicketComponent, { inputs: ['instrument', 'quote', 'prefill'], outputs: ['closed'] });
declareSignalIo(ModalA11yDirective, { outputs: ['dismiss'] });

/** The 26 live MT5 symbols (golden fixture, read-only SELECT 2026-10-24), as the engine's instruments endpoint serves them. */
const LIVE = 'AUDCAD AUDNZD AUDUSD CADJPY DE40 EURAUD EURCAD EURGBP EURJPY EURUSD GBPAUD GBPCAD GBPCHF GBPJPY GBPNZD GBPUSD NAS100 NZDJPY NZDUSD US500 USDCAD USDCHF USDCNH USDJPY USDNGN XAUUSD'.split(' ');

const ES: InstrumentDto = {
  symbol: 'ESZ6',
  assetClass: 'Future',
  exchange: 'CME',
  description: null,
  quoteCurrency: 'USD',
  tickSize: 0.25,
  tickValue: 12.5,
  multiplier: 50,
  quantityUnit: 'Contracts',
  quantityStep: 1,
  minQuantity: 1,
  maxQuantity: 0,
  priceDecimals: 2,
  displayDistance: 'Ticks',
  tradingCalendarCode: 'cme-globex',
  status: 'Active',
  future: { root: 'ES', contractCode: 'ESZ6', expiry: null, lastTradeDate: null, isFront: true, continuousSymbol: 'ES1!' },
};

/**
 * FX GOLDEN for the chart ticket (multi-asset WS7 7.5): with the full catalogue loaded, every live MT5 symbol opens
 * today's `app-order-ticket` and never the venue ticket; an exchange-traded contract opens the venue ticket, and a DOM
 * ladder click on it opens the ticket prefilled.
 */
describe('ChartTradingComponent — which ticket (multi-asset golden)', () => {
  let fixture: ComponentFixture<ChartTradingComponent>;
  let http: HttpTestingController;
  const notify = { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() };

  beforeEach(() => {
    setInstrumentCatalogue([
      ...LIVE.map((symbol, i) => ({
        ...instrumentFromCurrencyPair({ id: i + 1, symbol, baseCurrency: symbol.slice(0, 3), quoteCurrency: symbol.slice(3), decimalPlaces: 5, contractSize: 100000 } as unknown as CurrencyPairDto),
        future: null,
        crypto: null,
        equity: null,
      })),
      ES,
    ]);
    TestBed.configureTestingModule({
      imports: [ChartTradingComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: RUNTIME_CONFIG, useValue: { apiBaseUrl: 'http://test' } },
        { provide: NotificationService, useValue: notify },
        { provide: AuthService, useValue: { hasPermission: () => false } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(ChartTradingComponent);
  });

  afterEach(() => {
    http.match(() => true).forEach((r) => r.flush({ data: [], status: true, message: 'ok', responseCode: '00' }));
    fixture.destroy();
    setInstrumentCatalogue([]);
  });

  const render = (symbol: string) => {
    fixture.componentRef.setInput('symbol', symbol);
    fixture.componentRef.setInput('open', true);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    return {
      fx: !!el.querySelector('[data-testid="order-ticket"]'),
      venue: !!el.querySelector('[data-testid="venue-order-ticket"]'),
    };
  };

  it.each(LIVE)('%s keeps today’s FX ticket', (symbol) => {
    expect(render(symbol)).toEqual({ fx: true, venue: false });
  });

  it('an exchange-traded contract gets the venue ticket', () => {
    expect(render('ESZ6')).toEqual({ fx: false, venue: true });
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Preview only');
  });

  it('a ladder click on the contract opens the ticket prefilled; a click for another symbol does not', () => {
    fixture.componentRef.setInput('symbol', 'ESZ6');
    fixture.detectChanges();
    const bus = TestBed.inject(VenueTicketBus);
    bus.open({ symbol: 'NQZ6', side: 'Buy', orderType: 'Limit', price: 20000 });
    fixture.detectChanges();
    expect(fixture.componentInstance.open()).toBe(false);
    bus.open({ symbol: 'ESZ6', side: 'Sell', orderType: 'Limit', price: 6001.1 });
    fixture.detectChanges();
    fixture.detectChanges();
    expect(fixture.componentInstance.open()).toBe(true);
    const price = (fixture.nativeElement as HTMLElement).querySelector('input[aria-label="Limit price"]') as HTMLInputElement;
    expect(Number(price.value)).toBe(6001);
  });
});
