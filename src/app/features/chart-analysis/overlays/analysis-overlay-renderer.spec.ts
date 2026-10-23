import type { CanvasRenderingTarget2D } from 'fancy-canvas';
import type { ISeriesApi, SeriesType } from 'lightweight-charts';
import { describe, expect, it } from 'vitest';
import type { Ohlc } from '../indicators/math';
import { EURUSD_H1 } from './__fixtures__/eurusd-h1';
import { AnalysisOverlayRenderer } from './analysis-overlay-renderer';
import { profileWithValueArea } from './analysis-overlays';
import { marketStructure } from './market-structure';

const REAL: Ohlc[] = EURUSD_H1.map(([time, open, high, low, close, volume]) => ({
  time,
  open,
  high,
  low,
  close,
  volume,
}));

const W = 800;
const H = 600;
const lo = Math.min(...REAL.map((b) => b.low));
const hi = Math.max(...REAL.map((b) => b.high));
/** Price → y over the whole pane: the fixture's range fills it. */
const yOf = (p: number) => ((hi - p) / (hi - lo)) * H;
const series = { priceToCoordinate: yOf } as unknown as ISeriesApi<SeriesType>;
const t0 = REAL[0].time;
const t1 = REAL[REAL.length - 1].time;
const xOf = (ms: number) => ((ms - t0) / (t1 - t0)) * W;

/** A canvas that records nothing but answers what the renderer asks of it. */
function target(): CanvasRenderingTarget2D {
  const context = new Proxy(
    { measureText: (text: string) => ({ width: text.length * 5 }) },
    {
      get: (t, prop) => (prop in t ? t[prop as keyof typeof t] : () => undefined),
      set: () => true,
    },
  );
  return {
    useBitmapCoordinateSpace: (draw: (scope: unknown) => void) =>
      draw({
        context,
        mediaSize: { width: W, height: H },
        horizontalPixelRatio: 1,
        verticalPixelRatio: 1,
      }),
  } as unknown as CanvasRenderingTarget2D;
}

function frame(setup: (r: AnalysisOverlayRenderer) => void): AnalysisOverlayRenderer {
  const r = new AnalysisOverlayRenderer(() => series, () => 5, xOf);
  setup(r);
  r.paneViews()[0].renderer().draw(target());
  return r;
}

describe('AnalysisOverlayRenderer — hover and right-click targets (PR-4, PR-7)', () => {
  const structure = marketStructure(REAL);
  const rangeHigh = structure.levels.find((l) => l.label === 'Range high')!;

  it('offers the range edge at its exact price on a right-click near its line', () => {
    const r = frame((x) => x.setStructure(structure));
    expect(r.levelAt(300, yOf(rangeHigh.price) + 3)).toEqual({
      label: 'Range high',
      price: rangeHigh.price,
    });
    // Hovering it explains it.
    expect(r.hit(300, yOf(rangeHigh.price))?.key).toBe('structure.rangeHigh');
  });

  it('explains the stop pool as an estimate band', () => {
    const r = frame((x) => x.setStructure(structure));
    const pool = structure.zones.find((z) => z.kind === 'pool' && z.from >= rangeHigh.price - 1e-9)!;
    const mid = yOf((pool.from + pool.to) / 2);
    expect(r.hit(400, mid)?.key).toBe('structure.pool');
    expect(r.hit(400, mid)?.facts.structure).toBe(structure.basis);
  });

  it('offers the visible-range POC, and a naked POC by its label', () => {
    const profile = profileWithValueArea(REAL)!;
    const r = frame((x) => {
      x.setProfile(profile);
      x.setProfileExtras({
        naked: [
          {
            price: 1.1234,
            from: REAL[100].time,
            until: null,
            label: 'nPOC Mon 21 Sep',
            period: 'Mon 21 Sep',
            bars: 24,
          },
        ],
        developing: [],
        notice: null,
      });
    });
    expect(r.levelAt(W - 20, yOf(profile.poc))).toEqual({ label: 'POC', price: profile.poc });
    expect(r.levelAt(500, yOf(1.1234) + 2)).toEqual({ label: 'nPOC Mon 21 Sep', price: 1.1234 });
    // Not before the period it came from ended.
    expect(r.levelAt(xOf(REAL[50].time), yOf(1.1234))).toBeNull();
  });

  it('draws and answers nothing for a group at opacity 0 (PR-5)', () => {
    const r = frame((x) => {
      x.setStructure(structure);
      x.setOpacity({ structure: 0, profiles: 1 });
    });
    expect(r.levelAt(300, yOf(rangeHigh.price))).toBeNull();
    expect(r.hit(300, yOf(rangeHigh.price))).toBeNull();
  });
});
