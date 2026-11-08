import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
  type TestRequest,
} from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';

import { AuthService } from '@core/auth/auth.service';
import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import type { InstrumentDto } from '@core/instruments/instrument.types';
import { NotificationService } from '@core/notifications/notification.service';
import { AccountScopeService } from '@core/scope/account-scope.service';
import { ModalA11yDirective } from '@shared/directives/modal-a11y.directive';
import { declareSignalIo } from '@shared/testing/jit-signal-io';
import type { ExecutionAccount, VenueRoute, VenueTicketPreview } from '@features/venues/venues.types';

import { VenueOrderTicketComponent } from './venue-order-ticket.component';
import { SWITCHED_OFF_MESSAGE } from './venue-ticket-send';

declareSignalIo(VenueOrderTicketComponent, {
  inputs: ['instrument', 'quote', 'prefill'],
  outputs: ['closed'],
});
declareSignalIo(ModalA11yDirective, { outputs: ['dismiss'] });

const BASE = 'http://test/api/v1/lascodia-trading-engine';

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
  future: {
    root: 'ES',
    contractCode: 'ESZ6',
    expiry: null,
    lastTradeDate: null,
    isFront: true,
    continuousSymbol: 'ES1!',
  },
};

function acct(p: Partial<ExecutionAccount>): ExecutionAccount {
  return {
    id: 1,
    name: 'acct',
    adapterKind: 'cqg',
    venue: 'CME',
    externalAccountId: null,
    tradingAccountId: 7,
    mode: 'Paper',
    status: 'Active',
    currency: 'USD',
    lastConnectResult: null,
    lastConnectedAtUtc: null,
    createdAtUtc: '2026-10-27T00:00:00Z',
    credential: null,
    ...p,
  };
}

function preview(p: Partial<VenueTicketPreview> = {}): VenueTicketPreview {
  return {
    symbol: 'ESZ6',
    assetClass: 'Future',
    instrumentKind: 'Future',
    quantityUnit: 'Contracts',
    tickSize: 0.25,
    tickValue: 12.5,
    multiplier: 50,
    quantityStep: 1,
    minQuantity: 1,
    maxQuantity: 0,
    priceDecimals: 2,
    quoteCurrency: 'USD',
    accountCurrency: 'USD',
    accountEquity: 100000,
    quoteToAccountRate: 1,
    referencePrice: 6000,
    referencePriceSource: 'limit',
    bid: 5999.75,
    ask: 6000,
    notionalQuote: 300000,
    notionalAccount: 300000,
    margin: {
      model: 'futures',
      initialMargin: 15000,
      maintenanceMargin: 13600,
      liquidationPrice: null,
      leverage: null,
      basis: 'CME',
      refusal: null,
    },
    stopLossPrice: null,
    takeProfitPrice: null,
    riskMoney: null,
    rewardMoney: null,
    riskPctOfEquity: null,
    feeEstimate: 2.5,
    feeBasis: 'fee schedule',
    accountLeverage: null,
    accountMarginMode: null,
    multiAssetRiskEnabled: true,
    sessionOpen: true,
    sessionKind: 'Regular',
    valid: true,
    checks: [],
    notes: [],
    ...p,
  };
}

function routeOf(p: Partial<VenueRoute> = {}): VenueRoute {
  return {
    symbol: 'ESZ6',
    kind: 'venue',
    routable: true,
    reason: null,
    exchangeTraded: true,
    executionAccountId: 3,
    executionAccountName: 'CQG paper',
    adapterKind: 'cqg',
    mode: 'Paper',
    venue: 'CME',
    venueName: 'CQG (CME)',
    venueSymbol: 'ESZ6',
    venueTickSize: 0.25,
    venueQuantityStep: 1,
    venueMinQuantity: 1,
    minNotional: null,
    minNotionalCurrency: null,
    fractionable: null,
    timeInForce: ['Day', 'Gtc', 'Ioc'],
    candidates: [],
    ...p,
  };
}

const ACCOUNTS = [
  acct({ id: 3, name: 'CQG paper', tradingAccountId: 7 }),
  acct({ id: 4, name: 'EA route', adapterKind: 'mt5-ea', tradingAccountId: 7 }),
  acct({ id: 5, name: 'Other', adapterKind: 'rithmic', tradingAccountId: 9 }),
];
const ON = { 'Execution:Router:Enabled': 'true', 'Execution:Entries:Enabled': 'true' };
const ok = <T>(data: T) => ({ data, status: true, message: 'ok', responseCode: '00' });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The venue ticket's Send (ticket-send): picker of the trading account's venue accounts, disabled with the engine's
 * reason while a switch is off, a confirm step with the four-eyes notice, the POST body exactly as the engine expects,
 * and the answer read from the envelope. Every request is answered by HttpTestingController — nothing leaves the test.
 */
describe('VenueOrderTicketComponent — Send', () => {
  let fixture: ComponentFixture<VenueOrderTicketComponent>;
  let http: HttpTestingController;
  let perms: Set<string>;
  const notify = { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    perms = new Set(['accounts.read', 'orders.create', 'access.trader']);
    TestBed.configureTestingModule({
      imports: [VenueOrderTicketComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: RUNTIME_CONFIG, useValue: { apiBaseUrl: 'http://test' } },
        { provide: NotificationService, useValue: notify },
        { provide: AuthService, useValue: { hasPermission: (p: string) => perms.has(p) } },
        {
          provide: AccountScopeService,
          useValue: {
            accounts: signal([
              { id: 7, accountId: '1001', accountName: 'Futures desk', accountType: 'Demo' },
            ]),
            effectiveSelectedId: signal(7),
          },
        },
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.match(() => true).forEach((r) => r.flush(ok(null)));
    fixture?.destroy();
  });

  const el = () => fixture.nativeElement as HTMLElement;
  const q = <T extends Element>(sel: string) => el().querySelector(sel) as T | null;

  /** Renders the ticket, answers accounts + health, sets a limit price and answers the dry run. */
  const routeRequests = (): TestRequest[] =>
    http.match((r) => r.url.startsWith(`${BASE}/execution-console/route`));

  async function ready(
    opts: {
      switches?: Record<string, string>;
      pv?: Partial<VenueTicketPreview>;
      /** The engine's route answer (null = leave the question unanswered). */
      route?: Partial<VenueRoute> | null;
    } = {},
  ): Promise<void> {
    fixture = TestBed.createComponent(VenueOrderTicketComponent);
    fixture.componentRef.setInput('instrument', ES);
    fixture.detectChanges();
    if (perms.has('accounts.read')) {
      http.expectOne(`${BASE}/execution/accounts`).flush(ok(ACCOUNTS));
      http
        .expectOne(`${BASE}/execution-console/health`)
        .flush(ok({ switches: opts.switches ?? ON, accounts: [], workers: [] }));
    }
    fixture.detectChanges();
    // FR01: answer every route question asked (an answer for a question no longer current is dropped by the ticket).
    if (opts.route !== null) routeRequests().forEach((r) => r.flush(ok(routeOf(opts.route ?? {}))));
    fixture.detectChanges();
    fixture.componentInstance.patch({ price: 6000 });
    fixture.detectChanges();
    await wait(400);
    const pvs = http.match(`${BASE}/execution-console/ticket/preview`);
    expect(pvs.length).toBe(1);
    pvs[0].flush(ok(preview(opts.pv)));
    fixture.detectChanges();
  }

  const venueTicketPosts = (): TestRequest[] => http.match(`${BASE}/trade-signal/venue-ticket`);

  it('offers only the venue accounts of the chosen trading account and starts on its Active one', async () => {
    await ready();
    const options = Array.from(
      el().querySelectorAll('[data-testid="venue-ticket-account"] option'),
    ).map((o) => o.textContent?.trim());
    expect(options).toEqual(['— none (no account figures) —', 'CQG paper · cqg (Paper, Active)']);
    expect(fixture.componentInstance.state().executionAccountId).toBe(3);
    expect(q('[data-testid="venue-ticket-trading-account"]')?.textContent).toContain(
      'Futures desk',
    );
  });

  it('is disabled with the engine’s words while Execution:Router / Entries are off', async () => {
    await ready({ switches: { 'Execution:Router:Enabled': 'true' } });
    const btn = q<HTMLButtonElement>('[data-testid="venue-ticket-submit"]')!;
    expect(btn.disabled).toBe(true);
    expect(q('[data-testid="venue-ticket-why"]')?.textContent).toContain(SWITCHED_OFF_MESSAGE);
    expect(q('[data-testid="venue-ticket-why"]')?.textContent).toContain(
      'Off: Execution:Entries:Enabled.',
    );
    btn.click();
    fixture.detectChanges();
    expect(q('[data-testid="venue-ticket-confirm-step"]')).toBeNull();
    expect(venueTicketPosts().length).toBe(0);
  });

  it('is disabled while Risk:MultiAsset is off (from the dry run)', async () => {
    await ready({ pv: { multiAssetRiskEnabled: false } });
    expect(q<HTMLButtonElement>('[data-testid="venue-ticket-submit"]')!.disabled).toBe(true);
    expect(q('[data-testid="venue-ticket-why"]')?.textContent).toContain(
      'Off: Risk:MultiAsset:Enabled.',
    );
  });

  it('is disabled without access.trader', async () => {
    perms.delete('access.trader');
    await ready();
    expect(q<HTMLButtonElement>('[data-testid="venue-ticket-submit"]')!.disabled).toBe(true);
    expect(q('[data-testid="venue-ticket-why"]')?.textContent).toContain('access.trader');
  });

  it('one click opens the confirm step (four-eyes notice), sends nothing; Confirm posts the exact body', async () => {
    await ready();
    const btn = q<HTMLButtonElement>('[data-testid="venue-ticket-submit"]')!;
    expect(btn.disabled).toBe(false);
    btn.click();
    fixture.detectChanges();
    expect(q('[data-testid="venue-ticket-confirm-step"]')?.textContent).toContain(
      'Buy 1 contract ESZ6',
    );
    expect(q('[data-testid="venue-ticket-four-eyes"]')?.textContent).toContain(
      'second authorised person',
    );
    expect(venueTicketPosts().length).toBe(0);

    q<HTMLButtonElement>('[data-testid="venue-ticket-confirm"]')!.click();
    fixture.detectChanges();
    const posts = venueTicketPosts();
    expect(posts.length).toBe(1);
    expect(posts[0].request.method).toBe('POST');
    expect(posts[0].request.body).toEqual({
      executionAccountId: 3,
      symbol: 'ESZ6',
      side: 'Buy',
      orderType: 'Limit',
      quantity: 1,
      price: 6000,
      stopPrice: null,
      timeInForce: 'Gtc',
      postOnly: false,
      reduceOnly: false,
      leverage: null,
      marginMode: null,
      stopLossTicks: null,
      takeProfitTicks: null,
    });
    posts[0].flush(
      ok({
        placed: true,
        message: 'Manual venue signal 42 created',
        tradeSignalId: 42,
        manualStrategyId: 9,
        preview: preview(),
      }),
    );
    fixture.detectChanges();
    expect(notify.success).toHaveBeenCalledWith('Manual venue signal 42 created', {
      label: 'Open signal 42',
      route: '/trade-signals/42',
    });
    expect(q('[data-testid="venue-ticket-result"] a')?.getAttribute('href')).toBe(
      '/trade-signals/42',
    );
    // The levels belonged to the order sent; the account stays.
    expect(fixture.componentInstance.state().price).toBeNull();
    expect(fixture.componentInstance.state().executionAccountId).toBe(3);
  });

  it('a refusal shows the engine’s reason and is never reported as sent', async () => {
    await ready();
    q<HTMLButtonElement>('[data-testid="venue-ticket-submit"]')!.click();
    fixture.detectChanges();
    q<HTMLButtonElement>('[data-testid="venue-ticket-confirm"]')!.click();
    venueTicketPosts()[0].flush({
      data: {
        placed: false,
        message: 'Live manual tickets are switched off (ManualTrading:LiveEnabled = false).',
        tradeSignalId: null,
        manualStrategyId: null,
        preview: null,
      },
      status: false,
      message: 'Live manual tickets are switched off (ManualTrading:LiveEnabled = false).',
      responseCode: '-11',
    });
    fixture.detectChanges();
    expect(notify.success).not.toHaveBeenCalled();
    expect(notify.error).toHaveBeenCalledWith(
      'Live manual tickets are switched off (ManualTrading:LiveEnabled = false).',
    );
    expect(q('[data-testid="venue-ticket-result"]')?.textContent).toContain(
      'ManualTrading:LiveEnabled',
    );
  });

  it('a four-eyes hold (202 -202-approval) is pending, not failed', async () => {
    await ready();
    q<HTMLButtonElement>('[data-testid="venue-ticket-submit"]')!.click();
    fixture.detectChanges();
    q<HTMLButtonElement>('[data-testid="venue-ticket-confirm"]')!.click();
    venueTicketPosts()[0].flush(
      {
        data: { approvalId: 77, expiresAtUtc: '2026-10-28T00:00:00Z' },
        status: false,
        message: 'Approval required',
        responseCode: '-202-approval',
      },
      { status: 202, statusText: 'Accepted' },
    );
    fixture.detectChanges();
    expect(notify.error).not.toHaveBeenCalled();
    expect(q('[data-testid="venue-ticket-result"]')?.textContent).toContain(
      'Sent for approval (request #77)',
    );
  });

  it('re-committing the same values (an input blurred as Send is pressed) keeps the confirm step', async () => {
    await ready();
    q<HTMLButtonElement>('[data-testid="venue-ticket-submit"]')!.click();
    fixture.detectChanges();
    fixture.componentInstance.patch({ price: 6000 });
    fixture.detectChanges();
    expect(q('[data-testid="venue-ticket-confirm-step"]')).not.toBeNull();
  });

  it('a stale dry run of an earlier edit never enables Send', async () => {
    await ready();
    fixture.componentInstance.patch({ quantity: 3 });
    fixture.detectChanges();
    // The old preview is still on screen while the new one is debounced, but Send waits for it.
    expect(q('[data-testid="venue-ticket-preview"]')).not.toBeNull();
    expect(q<HTMLButtonElement>('[data-testid="venue-ticket-submit"]')!.disabled).toBe(true);
    expect(q('[data-testid="venue-ticket-why"]')?.textContent).toContain('Waiting for the engine');
    await wait(400);
    http.expectOne(`${BASE}/execution-console/ticket/preview`).flush(ok(preview()));
    fixture.detectChanges();
    expect(q<HTMLButtonElement>('[data-testid="venue-ticket-submit"]')!.disabled).toBe(false);
  });

  it('changing the ticket closes the confirm step', async () => {
    await ready();
    q<HTMLButtonElement>('[data-testid="venue-ticket-submit"]')!.click();
    fixture.detectChanges();
    expect(q('[data-testid="venue-ticket-confirm-step"]')).not.toBeNull();
    fixture.componentInstance.patch({ quantity: 2 });
    fixture.detectChanges();
    expect(q('[data-testid="venue-ticket-confirm-step"]')).toBeNull();
    expect(venueTicketPosts().length).toBe(0);
  });

  // ── FR01: the badge is the engine's route for the chosen account ──

  it('FR01: asks the engine for the chosen trading + venue account, and the badge says where it routes', async () => {
    await ready();
    expect(q('[data-testid="ticket-route"]')?.textContent?.trim()).toBe('Routes to CQG (CME) · ESZ6 (paper)');
    expect(q('[data-testid="ticket-route-why"]')).toBeNull();
    expect(q<HTMLButtonElement>('[data-testid="venue-ticket-submit"]')!.disabled).toBe(false);
  });

  it('FR01: while the route is being asked, the badge says so and Send waits', async () => {
    await ready({ route: null });
    const asked = routeRequests();
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.at(-1)!.request.urlWithParams).toContain('symbol=ESZ6&tradingAccountId=7&executionAccountId=3');
    expect(q('[data-testid="ticket-route"]')?.textContent?.trim()).toBe('Route: resolving…');
    expect(q<HTMLButtonElement>('[data-testid="venue-ticket-submit"]')!.disabled).toBe(true);
    expect(q('[data-testid="venue-ticket-why"]')?.textContent).toContain('where this order would route');
  });

  it('FR01: no route → "No route for this account (why)" in the engine\'s words, and Send is disabled', async () => {
    const reason = 'The execution account has no verified credential: the dispatcher could not sign in.';
    await ready({ route: { kind: 'none', routable: false, reason } });
    expect(q('[data-testid="ticket-route"]')?.textContent?.trim()).toBe('No route for this account');
    expect(q('[data-testid="ticket-route-why"]')?.textContent).toContain(reason);
    expect(q('[data-testid="ticket-route"]')?.textContent).not.toContain('CME');
    expect(q<HTMLButtonElement>('[data-testid="venue-ticket-submit"]')!.disabled).toBe(true);
    expect(q('[data-testid="venue-ticket-why"]')?.textContent).toContain(reason);
  });

  it('FR04: the time-in-force choices are the routed adapter\'s', async () => {
    await ready({ route: { timeInForce: ['Day'] } });
    const tifs = Array.from(el().querySelectorAll('select[aria-label="Time in force"] option')).map((o) =>
      o.textContent?.trim(),
    );
    expect(tifs).toEqual(['DAY']);
  });

  // ── FR07: a ladder click opens the ticket on the ladder's account ──

  it('FR07: a prefill naming a trading account switches the ticket to it (and its venue account) and asks for its route', async () => {
    await ready();
    fixture.componentRef.setInput('prefill', { side: 'Sell', orderType: 'Limit', price: 6001, tradingAccountId: 9, seq: 1 });
    fixture.detectChanges();
    expect(fixture.componentInstance.tradingAccountId()).toBe(9);
    expect(fixture.componentInstance.state().executionAccountId).toBe(5);
    expect(routeRequests().at(-1)!.request.urlWithParams).toContain('tradingAccountId=9&executionAccountId=5');
  });

  it('FR07: the ladder\'s account is offered even without venue accounts, and the ticket says it has no route', async () => {
    await ready();
    fixture.componentRef.setInput('prefill', { side: 'Buy', orderType: 'Market', price: null, tradingAccountId: 17, seq: 2 });
    fixture.detectChanges();
    expect(fixture.componentInstance.tradingAccountId()).toBe(17);
    expect(fixture.componentInstance.state().executionAccountId).toBeNull();
    const options = Array.from(el().querySelectorAll('[data-testid="venue-ticket-trading-account"] option')).map((o) => o.getAttribute('value'));
    expect(options).toContain('17');
    routeRequests().forEach((r) =>
      r.flush(ok(routeOf({ kind: 'none', routable: false, reason: 'This trading account has no venue execution account.', venueSymbol: null }))),
    );
    fixture.detectChanges();
    expect(q('[data-testid="ticket-route-why"]')?.textContent).toContain('no venue execution account');
  });

  it('FR07: a prefill without an account keeps the ticket\'s choice', async () => {
    await ready();
    fixture.componentRef.setInput('prefill', { side: 'Buy', orderType: 'Limit', price: 6000, seq: 3 });
    fixture.detectChanges();
    expect(fixture.componentInstance.tradingAccountId()).toBe(7);
    expect(fixture.componentInstance.state().executionAccountId).toBe(3);
  });
});
