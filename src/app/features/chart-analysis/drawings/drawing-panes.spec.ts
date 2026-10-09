import { Injector, runInInjectionContext } from '@angular/core';
import { Subject, of } from 'rxjs';
import { afterEach, describe, expect, it } from 'vitest';
import type { IChartApi, ISeriesApi, SeriesType } from 'lightweight-charts';
import { ChartDrawingsService, type ChartDrawingDto } from '@core/services/chart-drawings.service';
import { RealtimeService } from '@core/realtime/realtime.service';
import { DrawingController } from './drawing-controller';
import { DrawingStore, fromDto } from './drawing-store.service';
import type { Bar } from '../datafeed/candle-feed.service';

/**
 * Drawing on the studies' panes (DR-07 / DR-I10). The chart is faked to the parts the controller reads: two panes
 * stacked in a container (price 0–300 px, RSI 300–450 px, a script pane 450–520 px), a time scale of 10 px per H1
 * bar, and a scale per pane.
 */
const T0 = Date.UTC(2026, 9, 5, 0);
const H = 3_600_000;
const bars: Bar[] = Array.from({ length: 50 }, (_, i) => ({
  time: T0 + i * H,
  open: 1.1,
  high: 1.11,
  low: 1.09,
  close: 1.1,
  volume: 1,
}));

function rect(top: number, height: number): DOMRect {
  return {
    left: 0,
    top,
    right: 800,
    bottom: top + height,
    width: 800,
    height,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

function fakeSeries(paneIndex: number, toPrice: (y: number) => number, toY: (p: number) => number) {
  const attached: unknown[] = [];
  const series = {
    attached,
    coordinateToPrice: (y: number) => toPrice(y),
    priceToCoordinate: (p: number) => toY(p),
    getPane: () => ({ paneIndex: () => paneIndex }),
    attachPrimitive: (p: unknown) => attached.push(p),
    detachPrimitive: (p: unknown) => attached.splice(attached.indexOf(p), 1),
    options: () => ({ priceFormat: { type: 'price', precision: 2, minMove: 0.01 } }),
  };
  return series;
}

function setup() {
  localStorage.clear();
  const injector = Injector.create({
    providers: [
      {
        provide: ChartDrawingsService,
        useValue: {
          list: () => of({ status: true, data: [] }),
          sync: () => of({ status: true, data: [] }),
          syncOnUnload: () => undefined,
        },
      },
      { provide: RealtimeService, useValue: { on: () => new Subject().asObservable() } },
    ],
  });
  const store = runInInjectionContext(injector, () => new DrawingStore());
  store.setScope('EURUSD', '60');

  // Price pane: y 0..300 ↔ 1.20..0.90; RSI pane: y 0..150 ↔ 100..0.
  const price = fakeSeries(
    0,
    (y) => 1.2 - y * 0.001,
    (p) => (1.2 - p) / 0.001,
  );
  let rsi = fakeSeries(
    1,
    (y) => 100 - (y * 100) / 150,
    (v) => ((100 - v) * 150) / 100,
  );
  const panes = [rect(0, 300), rect(300, 150), rect(450, 70)].map((r, i) => ({
    paneIndex: () => i,
    getHTMLElement: () => ({ getBoundingClientRect: () => r }) as unknown as HTMLElement,
  }));
  const chart = {
    panes: () => panes,
    priceScale: () => ({ width: () => 0 }),
    timeScale: () => ({
      width: () => 740,
      options: () => ({ barSpacing: 10 }),
      coordinateToTime: (x: number) => (T0 + Math.round(x / 10) * H) / 1000,
      timeToCoordinate: (t: number) => ((t * 1000 - T0) / H) * 10,
    }),
    applyOptions: () => undefined,
  } as unknown as IChartApi;

  const container = document.createElement('div');
  container.getBoundingClientRect = () => rect(0, 520);
  Object.assign(container, {
    setPointerCapture: () => undefined,
    releasePointerCapture: () => undefined,
  });
  document.body.appendChild(container);

  const controller = new DrawingController(
    store,
    () => 5,
    () => ({ symbol: 'EURUSD', resolution: '60' }),
  );
  controller.attach(chart, container);
  controller.bindSeries(price as unknown as ISeriesApi<SeriesType>);
  controller.bars = bars;
  controller.paneHost = {
    keyAt: (i) => (i === 1 ? 'rsi-1' : null),
    seriesFor: (uid) => (uid === 'rsi-1' ? (rsi as unknown as ISeriesApi<SeriesType>) : null),
  };
  const click = (x: number, y: number) => {
    for (const type of ['pointerdown', 'pointerup']) {
      container.dispatchEvent(
        new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true }),
      );
    }
  };
  const swapRsi = () => {
    rsi = fakeSeries(
      1,
      (y) => 100 - (y * 100) / 150,
      (v) => ((100 - v) * 150) / 100,
    );
    return rsi;
  };
  return { store, controller, container, click, price, rsi: () => rsi, swapRsi };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('drawing on the studies panes (DR-07 / DR-I10)', () => {
  it('a click on the RSI pane places the drawing there, in RSI units', () => {
    const { store, controller, click } = setup();
    controller.setTool('horizontal-line');
    // 75 px into the RSI pane (y 375 in the container) is RSI 50 — read through the price series it was 0.825.
    click(100, 375);
    const d = store.symbolDrawings()[0];
    expect(d.pane).toBe('rsi-1');
    expect(d.points[0].price).toBeCloseTo(50, 9);
    expect(d.points[0].time).toBe(T0 + 10 * H);
  });

  it('a click on the price pane places it on the price pane as before', () => {
    const { store, controller, click } = setup();
    controller.setTool('trend-line');
    click(100, 100);
    click(200, 150);
    const d = store.symbolDrawings()[0];
    expect(d.pane).toBeUndefined();
    expect(d.points.map((p) => +p.price.toFixed(6))).toEqual([1.1, 1.05]);
  });

  it('a drawing begun in a pane stays in it: the second anchor is read on that pane even off it', () => {
    const { store, controller, click } = setup();
    controller.setTool('trend-line');
    click(100, 330); // RSI 80
    click(200, 120); // over the price pane — still the RSI's scale: y −180 → RSI 220
    const d = store.symbolDrawings()[0];
    expect(d.pane).toBe('rsi-1');
    expect(d.points[0].price).toBeCloseTo(80, 9);
    expect(d.points[1].price).toBeCloseTo(220, 9);
  });

  it('places nothing on a pane drawings cannot go in, nor a price-only tool off the price pane', () => {
    const { store, controller, click } = setup();
    controller.setTool('horizontal-line');
    click(100, 480); // the script pane
    expect(store.symbolDrawings()).toHaveLength(0);
    controller.setTool('long-position');
    click(100, 375); // the RSI pane
    expect(store.symbolDrawings()).toHaveLength(0);
  });

  it('paints a pane drawing with a renderer on the study series, and follows the series when it is made again', () => {
    const { store, controller, click, price, rsi, swapRsi } = setup();
    controller.setTool('horizontal-line');
    click(100, 375);
    controller.sync(store.symbolDrawings(), null);
    expect(rsi().attached).toHaveLength(1);
    expect(price.attached).toHaveLength(1); // the price pane's own renderer
    const old = rsi();
    const fresh = swapRsi();
    controller.rebindPanes();
    expect(old.attached).toHaveLength(0);
    expect(fresh.attached).toHaveLength(1);
  });

  it('selects a pane drawing by a click on it, not by a click at the same height on the price pane', () => {
    const { store, controller, click } = setup();
    controller.setTool('horizontal-line');
    click(100, 375);
    const id = store.symbolDrawings()[0].id;
    controller.sync(store.symbolDrawings(), null);
    store.selectedId.set(null);
    click(300, 75); // the same 75 px, on the price pane
    expect(store.selectedId()).toBeNull();
    click(300, 375);
    expect(store.selectedId()).toBe(id);
  });

  it('keeps the pane through the engine (inside the options, never as a tool option)', () => {
    const row = {
      id: 1,
      clientId: 'd1',
      symbol: 'EURUSD',
      resolution: '60',
      kind: 'horizontal-line',
      pointsJson: JSON.stringify([{ time: T0, price: 50 }]),
      styleJson: JSON.stringify({ color: '#2962FF', width: 1, dash: 'solid', fill: null }),
      locked: false,
      createdAt: new Date(T0).toISOString(),
      updatedAt: new Date(T0).toISOString(),
      optionsJson: JSON.stringify({ $pane: 'rsi-1', showPrice: true }),
    } satisfies ChartDrawingDto;
    const d = fromDto(row)!;
    expect(d.pane).toBe('rsi-1');
    expect(d.options).toEqual({ showPrice: true });
    const bare = fromDto({ ...row, optionsJson: JSON.stringify({ $pane: 'rsi-1' }) })!;
    expect(bare.options).toBeUndefined();
  });
});
