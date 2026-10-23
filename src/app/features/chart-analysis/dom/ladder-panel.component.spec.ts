import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { of } from 'rxjs';

import { Permission } from '@core/auth/permissions.generated';
import { NotificationService } from '@core/notifications/notification.service';
import { AccountScopeService } from '@core/scope/account-scope.service';
import { provideAuthWithPermissions } from '@core/testing/auth-test-double';
import { declareSignalIo } from '@shared/testing/jit-signal-io';

import { ChartPanelsService } from '../panels/side/chart-panels.service';
import { ManualTradingService } from '../trading/manual-trading.service';
import type { ManualTradePreview, ManualTradeRequest } from '../trading/manual-trading.types';
import { MarketDataApiService } from '@core/realtime/marketdata-api.service';
import { MarketDataStreamService } from '@core/realtime/marketdata-stream.service';
import { MdSourceStream, type MdFrameListener, type MdWatchStatus } from '@core/realtime/marketdata-stream';
import type { MdFrame } from '@core/realtime/marketdata.types';
import { LiveDepthService } from '../orderflow/live-depth.service';
import type { OrderBookSnapshot } from '../panels/side/chart-panels.types';
import { LadderArmingService } from './ladder-arming.service';
import { LadderPanelComponent } from './ladder-panel.component';

declareSignalIo(LadderPanelComponent, { inputs: ['symbol', 'digits'] });

const ok = <T>(data: T) => ({ data, status: true, message: 'Successful', responseCode: '00' });

function preview(over: Partial<ManualTradePreview> = {}): ManualTradePreview {
  return {
    canSubmit: true,
    refusedReason: null,
    mode: 'Live',
    account: { id: 17, accountId: '134', accountName: 'Demo 17', accountType: 'Demo', currency: 'USD', equity: 1e4, balance: 1e4, riskProfileId: null, riskProfileName: null },
    manualStrategyId: 3,
    symbol: 'EURUSD',
    direction: 'Buy',
    digits: 5,
    pipSize: 0.0001,
    quote: { bid: 1.1, ask: 1.10002, spreadPips: 0.2, ageSeconds: 1 },
    entry: 1.1,
    entryAtMarket: false,
    stopLoss: null,
    takeProfit: null,
    stopPips: null,
    targetPips: null,
    rewardRisk: 2,
    atr: { value: 0.001, pips: 10, timeframe: 'H1', period: 14, minStopMultiple: 1, minStopLevel: null, stopInAtr: null },
    lots: 0.1,
    lotsAfterRiskCheck: 0.1,
    pipValuePerLot: 10,
    riskMoney: 15,
    riskPctOfEquity: 0.15,
    rewardMoney: 30,
    swap: null,
    exposure: null,
    gates: [],
    notes: [],
    ...over,
  };
}

describe('LadderPanelComponent (price ladder + trading)', () => {
  let fixture: ComponentFixture<LadderPanelComponent>;
  let el: HTMLElement;
  let stream: MdSourceStream;
  let usable = true;
  let entitledDom: boolean | null = null;
  const version = signal(0);
  const status = signal<MdWatchStatus>({
    state: 'connected', protocol: 'messagepack', subscribed: [], denied: [], deniedReasons: {}, notEntitled: null,
    revoked: null, unknown: [], error: null,
  });
  const frameListeners: MdFrameListener[] = [];
  const released = vi.fn();
  const depthReleased = vi.fn();
  const polled = signal<OrderBookSnapshot | null>(null);
  const pollError = signal<string | null>(null);
  const defaultPreview = (r: ManualTradeRequest) => of(ok(preview({ direction: r.direction, entry: r.entryPrice ?? 1.1 })));
  const trading = {
    preview: vi.fn(defaultPreview),
    submit: vi.fn(() => of(ok({ mode: 'Live', tradeSignalId: 55, paperExecutionId: null, manualStrategyId: 3, preview: preview(), message: 'Manual signal 55 created' }))),
    createOco: vi.fn(() => of(ok({ group: null, refusedLeg: null, previews: [], message: 'OCO 12 created' }))),
    ocoGroups: vi.fn(() => of(ok([]))),
    cancelOco: vi.fn(() => of(ok(null))),
    cancelOrder: vi.fn(() => of(ok(null))),
    orderEntryMovePreview: vi.fn(),
    moveOrderEntry: vi.fn(),
  };
  const notify = { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() };

  const mdStream = {
    usable: () => usable,
    watch: () => ({
      symbol: 'EURUSD',
      version: version.asReadonly(),
      status: status.asReadonly(),
      streams: () => [stream],
      stream: () => stream,
      onFrame: (l: MdFrameListener) => {
        frameListeners.push(l);
        return () => undefined;
      },
      onBook: () => () => undefined,
      release: released,
    }),
    entitlements: { load: async () => null, isEntitled: () => entitledDom },
  };
  const liveDepth = {
    watch: () => ({
      snapshot: polled.asReadonly(),
      error: pollError.asReadonly(),
      readAt: signal(0).asReadonly(),
      via: signal<'stream' | 'poll'>('poll').asReadonly(),
      release: depthReleased,
    }),
  };

  const byId = <T extends Element = HTMLElement>(id: string) => el.querySelector(`[data-testid="${id}"]`) as T | null;
  const settle = async () => {
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
      fixture.detectChanges();
    }
  };

  function setup(permissions: string[] = [Permission.AccessTrader, Permission.OrdersCancel, Permission.OrdersModify]): void {
    TestBed.configureTestingModule({
      imports: [LadderPanelComponent],
      providers: [
        provideAuthWithPermissions(...permissions),
        { provide: MarketDataStreamService, useValue: mdStream },
        { provide: LiveDepthService, useValue: liveDepth },
        { provide: MarketDataApiService, useValue: { history: vi.fn(async () => ({ sources: [], truncated: false, message: null })) } },
        { provide: ManualTradingService, useValue: trading },
        { provide: ChartPanelsService, useValue: { accountStrip: vi.fn(() => of(null)) } },
        {
          provide: AccountScopeService,
          useValue: {
            liveAccounts: signal([{ id: 17, accountId: '134', accountName: 'Demo 17', accountType: 'Demo' }]),
            accounts: signal([]),
            effectiveSelectedId: signal(17),
          },
        },
        { provide: NotificationService, useValue: notify },
      ],
    });
    fixture = TestBed.createComponent(LadderPanelComponent);
    fixture.componentRef.setInput('symbol', 'EURUSD');
    fixture.componentRef.setInput('digits', 5);
    fixture.detectChanges();
    el = fixture.nativeElement as HTMLElement;
  }

  beforeEach(() => {
    stream = new MdSourceStream('EURUSD', 'mt5-metaquotes-demo');
    stream.book.apply({ t: 1, k: 'S', b: [[1.1, 1_000_000], [1.09999, 2_000_000]], a: [[1.10002, 500_000]] });
    stream.lastFrameAt = Date.now();
    usable = true;
    entitledDom = null;
    polled.set(null);
    pollError.set(null);
    status.update((st) => ({ ...st, denied: [], deniedReasons: {}, notEntitled: null, revoked: null }));
    frameListeners.length = 0;
    depthReleased.mockClear();
    Object.values(trading).forEach((f) => f.mockClear());
    trading.preview.mockImplementation(defaultPreview);
    Object.values(notify).forEach((f) => f.mockClear());
    released.mockClear();
  });

  afterEach(() => {
    TestBed.inject(LadderArmingService).disarm();
    fixture?.destroy();
  });

  it('draws a fixed ladder around the market with the book and says where the depth comes from', async () => {
    setup();
    await settle();
    expect(byId('ladder-source')?.textContent).toContain('mt5-metaquotes-demo');
    expect(byId('bid-110000')?.textContent).toContain('1M');
    expect(byId('bid-109999')?.textContent).toContain('2M');
    expect(byId('ask-110002')?.textContent).toContain('500K');
    expect(el.querySelectorAll('[data-index]').length).toBe(41);
  });

  it('a bid-column click in Paper mode explains that orders at a price are live only, and sends nothing', async () => {
    setup();
    await settle();
    byId('bid-109990')!.dispatchEvent(new MouseEvent('click'));
    await settle();
    expect(byId('ladder-hint')?.textContent).toContain('live only');
    expect(trading.submit).not.toHaveBeenCalled();
  });

  it('Live: a bid-column click previews a buy limit with the default brackets and sends it only after Confirm', async () => {
    setup();
    await settle();
    byId<HTMLInputElement>('ladder-live')!.dispatchEvent(new Event('change'));
    await settle();
    byId('bid-109990')!.dispatchEvent(new MouseEvent('click'));
    await settle();

    expect(byId('ladder-dialog')?.textContent).toContain('Live Buy Limit EURUSD');
    const sent = trading.preview.mock.calls.at(-1)![0] as ManualTradeRequest;
    expect(sent).toMatchObject({ tradingAccountId: 17, direction: 'Buy', entryPrice: 1.0999, mode: 'Live' });
    // 1.5 ATR (0.001) stop, 2R target.
    expect(sent.stopLoss).toBeCloseTo(1.0984, 5);
    expect(sent.takeProfit).toBeCloseTo(1.1029, 5);
    expect(trading.submit).not.toHaveBeenCalled();

    byId<HTMLButtonElement>('ladder-confirm')!.click();
    await settle();
    expect(trading.submit).toHaveBeenCalledWith(expect.objectContaining({ entryPrice: 1.0999, direction: 'Buy' }));
    expect(notify.success).toHaveBeenCalled();
  });

  it('Shift on the ask column is a buy stop above the market; a wrong-side click is refused with the reason', async () => {
    setup();
    await settle();
    byId<HTMLInputElement>('ladder-live')!.dispatchEvent(new Event('change'));
    await settle();
    byId('ask-109995')!.dispatchEvent(new MouseEvent('click'));
    await settle();
    expect(byId('ladder-hint')?.textContent).toContain('sell limit must be above the bid');

    byId('ask-110010')!.dispatchEvent(new MouseEvent('click', { shiftKey: true }));
    await settle();
    expect(byId('ladder-dialog')?.textContent).toContain('Live Buy Stop');
  });

  it('a refusal by the engine keeps Confirm off and shows the gate', async () => {
    setup();
    trading.preview.mockImplementation((r: ManualTradeRequest) =>
      of(ok(preview({ direction: r.direction, canSubmit: !r.stopLoss, gates: r.stopLoss ? [{ key: 'news', name: 'News blackout', passed: false, blocking: true, detail: 'A high-impact event is near.' }] : [] }))),
    );
    await settle();
    byId<HTMLInputElement>('ladder-live')!.dispatchEvent(new Event('change'));
    await settle();
    byId('bid-109990')!.dispatchEvent(new MouseEvent('click'));
    await settle();
    expect(byId<HTMLButtonElement>('ladder-confirm')!.disabled).toBe(true);
    expect(byId('ladder-dialog-error')?.textContent).toContain('high-impact');
  });

  it('one-click is an explicit opt-in: armed, a click sends at once; changing the account disarms', async () => {
    setup();
    await settle();
    expect(byId<HTMLButtonElement>('ladder-arm')!.disabled).toBe(true); // Paper: no arming
    byId<HTMLInputElement>('ladder-live')!.dispatchEvent(new Event('change'));
    await settle();
    byId<HTMLButtonElement>('ladder-arm')!.click();
    await settle();
    expect(byId('ladder-dialog')?.textContent).toContain('Arm one-click trading?');
    byId<HTMLButtonElement>('ladder-confirm')!.click();
    await settle();
    expect(byId('ladder-armed')).not.toBeNull();

    byId('bid-109990')!.dispatchEvent(new MouseEvent('click'));
    await settle();
    expect(byId('ladder-dialog')).toBeNull();
    expect(trading.submit).toHaveBeenCalledTimes(1);

    fixture.componentInstance.setAccount('18');
    await settle();
    expect(byId('ladder-armed')).toBeNull();
    expect(TestBed.inject(LadderArmingService).armed()).toBe(false);
  });

  it('OCO mode takes one buy and one sell leg and sends them as one pair', async () => {
    setup();
    await settle();
    byId<HTMLInputElement>('ladder-live')!.dispatchEvent(new Event('change'));
    await settle();
    byId<HTMLButtonElement>('ladder-oco')!.click();
    await settle();
    byId('ask-110010')!.dispatchEvent(new MouseEvent('click', { shiftKey: true })); // buy stop
    await settle();
    byId('ask-110012')!.dispatchEvent(new MouseEvent('click', { shiftKey: true })); // a second buy: refused
    await settle();
    expect(byId('ladder-hint')?.textContent).toContain('one buy and one sell');
    byId('bid-109990')!.dispatchEvent(new MouseEvent('click', { shiftKey: true })); // sell stop
    await settle();
    expect(byId('ladder-dialog')?.textContent).toContain('Live OCO pair');

    byId<HTMLButtonElement>('ladder-confirm')!.click();
    await settle();
    const body = (trading.createOco.mock.calls as unknown[][])[0][0] as { accountId: number; legs: ManualTradeRequest[] };
    expect(body.accountId).toBe(17);
    expect(body.legs.map((l) => [l.direction, l.entryPrice, l.mode])).toEqual([
      ['Buy', 1.1001, 'Live'],
      ['Sell', 1.0999, 'Live'],
    ]);
    expect(trading.submit).not.toHaveBeenCalled();
  });

  it('without the trading permission the ladder is read-only', async () => {
    setup([]);
    await settle();
    expect(el.textContent).toContain('needs the access.trader permission');
    expect(byId<HTMLButtonElement>('ladder-buy-mkt')!.disabled).toBe(true);
    byId<HTMLInputElement>('ladder-live')!.dispatchEvent(new Event('change'));
    byId('bid-109990')!.dispatchEvent(new MouseEvent('click'));
    await settle();
    expect(trading.preview).not.toHaveBeenCalled();
  });

  it('counts the session ticks per price from the stream', async () => {
    setup();
    await settle();
    const frame: MdFrame = {
      symbol: 'EURUSD',
      sourceId: 'mt5-metaquotes-demo',
      ticks: { t: [1, 2, 3], b: [1.1, 1.1, 1.09999], a: [1.10002, 1.10002, 1.10001] },
    };
    frameListeners.forEach((l) => l(frame, stream));
    version.update((v) => v + 1);
    await settle();
    const row = el.querySelector('[data-index="110000"] .lp-vol');
    expect(row?.textContent?.trim()).toBe('2');
  });

  it('lets the feed go when the panel closes', async () => {
    setup();
    await settle();
    fixture.destroy();
    expect(released).toHaveBeenCalled();
    expect(depthReleased).toHaveBeenCalled();
  });

  it('while the hub is not delivering, it shows the shared live depth’s polled book and says so', async () => {
    usable = false;
    polled.set({
      id: 1, symbol: 'EURUSD', bidPrice: 1.2, askPrice: 1.20002, bidVolume: 1, askVolume: 1, spreadPoints: 2,
      levelsJson: JSON.stringify({ bids: [{ P: 1.2, V: 3_000_000 }], asks: [{ P: 1.20002, V: 1_000_000 }] }),
      instanceId: 'ea-1', capturedAt: new Date().toISOString(),
    });
    setup();
    await settle();
    expect(byId('ladder-source')?.textContent).toContain('polled every 1.5 s');
    expect(byId('bid-120000')?.textContent).toContain('3M');
  });

  it('says "not entitled" in the engine’s words when the hub refuses or revokes the feed', async () => {
    setup();
    await settle();
    expect(byId('ladder-denied')).toBeNull();
    status.update((st) => ({ ...st, denied: ['broker-dom'], notEntitled: "The licence for 'broker-dom' ended." }));
    version.update((v) => v + 1);
    await settle();
    expect(byId('ladder-denied')?.textContent).toContain("The licence for 'broker-dom' ended.");
  });

  it('says "not entitled" before asking when md/entitlements/me does not list the broker DOM feed', async () => {
    entitledDom = false;
    setup();
    await settle();
    expect(byId('ladder-denied')?.textContent).toContain('broker-dom');
  });
});
