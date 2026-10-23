import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthService } from '@core/auth/auth.service';
import { MarketDataApiService } from '@core/realtime/marketdata-api.service';
import { MarketDataStreamService } from '@core/realtime/marketdata-stream.service';
import type { MdHistoryRequest } from '@core/realtime/marketdata.types';
import { ensureTestBed } from '@core/testing/zoneless-test-bed';
import type { Bar } from '../datafeed/candle-feed.service';
import type { OrderBookSnapshot } from '../panels/side/chart-panels.types';
import { ChartFlowService } from './chart-flow.service';
import { LiveDepthService } from './live-depth.service';
import { OrderFlowFeed } from './orderflow-feed';
import {
  DEFAULT_ORDER_FLOW,
  type OrderBookHeatmapDto,
  type OrderFlowSettings,
  type OrderFlowView,
  type TickBarsDto,
  type TickBarsRequest,
} from './orderflow.types';

ensureTestBed();

const H = 3_600_000;
const T0 = Date.parse('2026-10-20T00:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const bars: Bar[] = Array.from({ length: 48 }, (_, i) => ({
  time: T0 + i * H,
  open: 1.1,
  high: 1.1002,
  low: 1.1,
  close: 1.1,
  volume: 1,
}));
const NOW = T0 + 47 * H + 30 * 60_000;

function tickAnswer(req: TickBarsRequest): TickBarsDto {
  return {
    symbol: req.symbol,
    tickCoverageFromUtc: iso(T0 + 20 * H),
    bars: req.barTimes.map((t, i) => ({
      t,
      source: Date.parse(t) >= T0 + 20 * H ? 'ticks' : 'candle',
      ticks: 10,
      upTicks: 6,
      downTicks: 4,
      delta: 2,
      cumDelta: 2 * (i + 1),
      spreadMinPoints: 1,
      spreadAvgPoints: 2,
      spreadMaxPoints: 3,
      ticksPerMinute: 5,
    })),
  };
}

function heatAnswer(
  symbol: string,
  from: number,
  to: number,
  buckets: number,
): OrderBookHeatmapDto {
  return {
    symbol,
    fromUtc: iso(from),
    toUtc: iso(to),
    bucketSeconds: Math.round((to - from) / buckets / 1000),
    oldestAvailableUtc: iso(T0 + 30 * H),
    sourceInstanceIds: ['LASC-1'],
    columns: [
      {
        t: iso(T0 + 40 * H),
        capturedAtUtc: iso(T0 + 40 * H + 1000),
        bid: 1.1,
        ask: 1.10002,
        bids: [[1.1, 1_000_000]],
        asks: [[1.10002, 2_000_000]],
      },
    ],
    maxLevelVolume: 2_000_000,
  };
}

describe('OrderFlowFeed', () => {
  let api: {
    heatmap: ReturnType<typeof vi.fn>;
    tickBars: ReturnType<typeof vi.fn>;
    fills: ReturnType<typeof vi.fn>;
    bookAsOf: ReturnType<typeof vi.fn>;
  };
  let liveSnapshot: ReturnType<typeof signal<OrderBookSnapshot | null>>;
  let watch: ReturnType<typeof vi.fn>;
  let perms: Set<string>;
  let md: { history: ReturnType<typeof vi.fn>; sources: ReturnType<typeof vi.fn> };
  let gpu = false;
  const settings = signal<OrderFlowSettings>(DEFAULT_ORDER_FLOW);
  const view = signal<OrderFlowView | null>(null);
  const clip = signal<number | null>(null);
  const style = signal('candles');

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    settings.set(DEFAULT_ORDER_FLOW);
    clip.set(null);
    style.set('candles');
    view.set({
      fromUtc: T0 + 24 * H,
      toUtc: T0 + 47 * H,
      fromIndex: 24,
      toIndex: 47,
      widthPx: 900,
      barSpacing: 20,
      rightEdgeInView: true,
      pricePerPx: 0.00001,
    });
    api = {
      heatmap: vi.fn((s: string, f: number, t: number, b: number) =>
        Promise.resolve(heatAnswer(s, f, t, b)),
      ),
      tickBars: vi.fn((req: TickBarsRequest) => Promise.resolve(tickAnswer(req))),
      fills: vi.fn(() => Promise.resolve({ logs: [], orders: [], truncated: false })),
      bookAsOf: vi.fn(),
    };
    liveSnapshot = signal<OrderBookSnapshot | null>(null);
    watch = vi.fn(() => ({
      snapshot: liveSnapshot.asReadonly(),
      error: signal(null).asReadonly(),
      readAt: signal(0).asReadonly(),
      release: vi.fn(),
    }));
    perms = new Set(['access.operator']);
    gpu = false;
    md = {
      history: vi.fn((r: MdHistoryRequest) =>
        Promise.resolve({
          sources: [
            {
              sourceId: 'mt5-metaquotes-demo',
              book: [{ t: r.from + 1000, k: 'S', b: [[1.1, 1_000_000]], a: [[1.10002, 2_000_000]] }],
              ticks: { t: [r.from + 1000], b: [1.1], a: [1.10002] },
            },
          ],
          truncated: false,
          message: null,
        }),
      ),
      sources: vi.fn(() =>
        Promise.resolve([
          {
            sourceId: 'mt5-metaquotes-demo',
            kind: 'Mt5Broker',
            displayName: 'MetaQuotes-Demo (MT5 broker)',
            feedId: 'broker-ticks',
            feeds: { ticks: 'broker-ticks', book: 'broker-dom' },
            enabled: true,
            sizeUnit: 'Lots',
            contractSize: 0,
            priceTransform: 'None',
            symbolMap: {},
          },
        ]),
      ),
    };
    TestBed.configureTestingModule({
      providers: [
        { provide: ChartFlowService, useValue: api },
        { provide: LiveDepthService, useValue: { watch } },
        { provide: MarketDataApiService, useValue: md },
        { provide: MarketDataStreamService, useValue: { watch: () => null, usable: () => false } },
        { provide: AuthService, useValue: { hasPermission: (k: string) => perms.has(k) } },
      ],
    });
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    vi.useRealTimers();
  });

  const make = () =>
    TestBed.runInInjectionContext(
      () =>
        new OrderFlowFeed({
          settings: () => settings(),
          symbol: () => 'EURUSD',
          resolution: () => '60',
          bars: () => bars,
          style: () => style(),
          view: () => view(),
          accountIds: () => [7],
          accountKey: () => '7',
          replayClip: () => clip(),
          precision: () => 5,
          pipSize: () => 0.0001,
          now: () => NOW,
          gpu: () => gpu,
        }),
    );

  async function settle(): Promise<void> {
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(350);
    TestBed.tick();
  }

  it('fetches nothing and draws nothing with every layer off', async () => {
    const feed = make();
    await settle();
    expect(feed.model()).toBeNull();
    expect(api.tickBars).not.toHaveBeenCalled();
    expect(api.heatmap).not.toHaveBeenCalled();
  });

  it('CVD: asks C2 about the chart’s own bar opens and says where ticks stop', async () => {
    settings.set({ ...DEFAULT_ORDER_FLOW, cvd: true });
    const feed = make();
    await settle();
    expect(api.tickBars).toHaveBeenCalledTimes(1);
    const req = api.tickBars.mock.calls[0][0] as TickBarsRequest;
    // Visible 24..47, half again to the left: from bar 12, through the newest (forming) bar, which ends now.
    expect(req.barTimes[0]).toBe(iso(T0 + 12 * H));
    expect(req.barTimes.at(-1)).toBe(iso(T0 + 47 * H));
    expect(req.endUtc).toBe(iso(NOW));
    expect(req.footprint).toBe(false);
    const cvd = feed.model()!.cvd!;
    expect(cvd.bars).toHaveLength(36);
    expect(cvd.notes.join(' ')).toContain('no ticks before 20 Oct 20:00 UTC');
    // A pan inside what was fetched asks nothing more.
    view.update((v) => ({
      ...v!,
      fromUtc: T0 + 20 * H,
      fromIndex: 20,
      toIndex: 45,
      toUtc: T0 + 45 * H,
      rightEdgeInView: false,
    }));
    await settle();
    expect(api.tickBars).toHaveBeenCalledTimes(1);
  });

  it('replay: an answer reaching past the head is not drawn, and the new request ends at the head', async () => {
    settings.set({ ...DEFAULT_ORDER_FLOW, cvd: true, ribbon: true });
    const feed = make();
    await settle();
    expect(feed.model()!.cvd!.bars.length).toBeGreaterThan(0);
    api.tickBars.mockImplementation(() => new Promise(() => undefined));
    clip.set(T0 + 30 * H);
    TestBed.tick();
    expect(feed.model()!.cvd!.bars).toHaveLength(0);
    expect(feed.model()!.ribbon!.bars).toHaveLength(0);
    await settle();
    const req = api.tickBars.mock.calls.at(-1)![0] as TickBarsRequest;
    expect(Date.parse(req.endUtc)).toBeLessThanOrEqual(T0 + 30 * H);
  });

  it('heatmap: names the source and the sampling, says where depth history starts, folds the live book in', async () => {
    settings.set({ ...DEFAULT_ORDER_FLOW, heatmap: true });
    const feed = make();
    await settle();
    expect(api.heatmap).toHaveBeenCalledTimes(1);
    const m = feed.model()!;
    expect(m.heatmap!.grid!.columns).toHaveLength(1);
    expect(m.heatmap!.opacity).toBe(0.6);
    expect(m.captions[0]).toMatch(/^Broker DOM depth — LASC-1, sampled every .+ · live$/);
    expect(m.captions).toContain(
      'Depth history starts 21 Oct 06:00 UTC (order books are kept 7 days)',
    );
    expect(watch).toHaveBeenCalledWith('EURUSD');
    expect(md.history).not.toHaveBeenCalled(); // a 23 h view is past the event-level layer's 2 h
    liveSnapshot.set({
      id: 1,
      symbol: 'EURUSD',
      bidPrice: 1.10001,
      askPrice: 1.10003,
      bidVolume: 1,
      askVolume: 1,
      spreadPoints: 2,
      levelsJson: JSON.stringify({ bids: [{ P: 1.10001, V: 5 }], asks: [{ P: 1.10003, V: 6 }] }),
      instanceId: 'LASC-1',
      capturedAt: iso(NOW - 1000),
    });
    TestBed.tick();
    expect(feed.model()!.heatmap!.grid!.columns).toHaveLength(2);
  });

  it('heatmap zoomed in with WebGL: every book event from md/history (C5), labelled with its source', async () => {
    gpu = true;
    settings.set({ ...DEFAULT_ORDER_FLOW, heatmap: true });
    view.set({
      fromUtc: NOW - 40 * 60_000,
      toUtc: NOW - 60_000,
      fromIndex: 0,
      toIndex: 39,
      widthPx: 900,
      barSpacing: 20,
      rightEdgeInView: false,
      pricePerPx: 0.00001,
    });
    const feed = make();
    await settle();
    await settle();
    expect(api.heatmap).not.toHaveBeenCalled();
    expect(watch).not.toHaveBeenCalled();
    expect(md.history).toHaveBeenCalledTimes(1);
    expect(md.history.mock.calls[0][0]).toMatchObject({ symbol: 'EURUSD', kinds: ['book', 'ticks'] });
    expect(feed.heatMode()).toBe('stream');
    const m = feed.model()!;
    expect(m.heatmap!.stream).toBeDefined();
    expect(m.heatmap!.stream!.layer()).not.toBeNull();
    expect(m.captions[0]).toBe('Broker depth — MetaQuotes-Demo, every book event (event-level, WebGL)');
    expect(m.captions[1]).toMatch(/^Sizes as the source reports them \(registered unit: Lots\)/);
  });

  it('trades: says plainly when no entitled source publishes trades', async () => {
    settings.set({ ...DEFAULT_ORDER_FLOW, trades: true });
    const feed = make();
    await settle();
    expect(feed.model()!.captions).toContain(
      'Trades: no source you are entitled to publishes trades for EURUSD (spot FX brokers have no tape; CME / venue feeds do)',
    );
    expect(feed.model()!.trades).toBeNull();
  });

  it('heatmap in replay: no live poll, nothing after the head', async () => {
    settings.set({ ...DEFAULT_ORDER_FLOW, heatmap: true });
    clip.set(T0 + 40 * H);
    const feed = make();
    await settle();
    expect(watch).not.toHaveBeenCalled();
    const [, , to] = api.heatmap.mock.calls[0];
    expect(to).toBeLessThanOrEqual(T0 + 40 * H);
    // The answer's column was captured a second after the head: it is the future.
    expect(feed.model()!.heatmap!.grid!.columns).toHaveLength(0);
  });

  it('footprint: zoomed out it asks nothing and says so; zoomed in it asks with a row height', async () => {
    settings.set({ ...DEFAULT_ORDER_FLOW, footprint: true });
    const feed = make();
    await settle();
    expect(api.tickBars).not.toHaveBeenCalled();
    expect(feed.model()!.captions).toContain('Zoom in to see the footprint');
    view.update((v) => ({ ...v!, barSpacing: 80, fromIndex: 38, fromUtc: T0 + 38 * H }));
    await settle();
    const req = api.tickBars.mock.calls[0][0] as TickBarsRequest;
    expect(req.footprint).toBe(true);
    // Bars span 2 pips (20 points): adaptive rows of 2 points cut each into ten.
    expect(req.footprintRowPoints).toBe(2);
    expect(feed.model()!.captions[0]).toContain('rows of 0.2 pip (auto)');
    // The operator's fixed size wins and is re-asked.
    settings.update((s) => ({ ...s, footprintRowPoints: 10 }));
    await settle();
    expect((api.tickBars.mock.calls.at(-1)![0] as TickBarsRequest).footprintRowPoints).toBe(10);
    expect(req.barTimes.length).toBeLessThanOrEqual(500);
  });

  it('fills: without the operator permission nothing is read and the chart says why', async () => {
    perms.clear();
    settings.set({ ...DEFAULT_ORDER_FLOW, fills: true });
    const feed = make();
    await settle();
    expect(api.fills).not.toHaveBeenCalled();
    expect(feed.model()!.captions[0]).toContain('operator permission');
  });

  it('price-based styles get no flow', async () => {
    settings.set({ ...DEFAULT_ORDER_FLOW, cvd: true });
    style.set('renko');
    const feed = make();
    await settle();
    expect(api.tickBars).not.toHaveBeenCalled();
    expect(feed.model()!.cvd!.notes[0]).toContain('price-based');
  });
});
