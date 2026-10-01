import { describe, expect, it } from 'vitest';
import type { Drawing } from '../model';
import type { PaintCtx } from '../advanced-painters';
import { optionsOf } from './types';
import {
  BEHAVIORS,
  PITCHFORK_LEVELS,
  formatTvTime,
  moveFlatHandle,
  moveParallelHandle,
  parallelRails,
  pitchforkLines,
  regressionLines,
} from './trend';
import { channelOffset, extendSegment, formatSpan, linearRegression, pitchforkOrigin, screenAngle } from './trend-geometry';

const W = 800;
const H = 400;

function drawing(kind: Drawing['kind'], n = 2, options?: Record<string, unknown>): Drawing {
  return {
    id: 'd',
    kind,
    symbol: 'EURUSD',
    resolution: '60',
    points: Array.from({ length: n }, (_, i) => ({ time: i * 3_600_000, price: 1 + i })),
    style: { color: '#2962FF', width: 2, dash: 'solid', fill: null, fontSize: 12, text: '', showLabels: true },
    locked: false,
    createdAt: 0,
    options,
  };
}

function ctxFor(kind: Drawing['kind'], pts: { x: number; y: number }[], extra: Partial<PaintCtx> = {}, opts?: Record<string, unknown>) {
  const d = drawing(kind, pts.length, opts);
  return {
    ctx: null as unknown as CanvasRenderingContext2D,
    drawing: d,
    pts,
    width: W,
    height: H,
    priceAt: (y: number) => 2 - y / H, // y=0 → 2, y=H → 1
    precision: 5,
    options: optionsOf(BEHAVIORS[kind], d),
    ...extra,
  };
}

describe('trend geometry', () => {
  it('linear regression on a known series', () => {
    const r = linearRegression([1, 3, 5, 7, 9])!;
    expect(r.slope).toBeCloseTo(2);
    expect(r.intercept).toBeCloseTo(1);
    expect(r.stdev).toBeCloseTo(0);
    expect(r.pearson).toBeCloseTo(1);
    const q = linearRegression([2, 4, 3, 5])!;
    expect(q.slope).toBeCloseTo(0.8);
    expect(q.intercept).toBeCloseTo(2.3);
    // residuals −0.3, 0.9, −0.9, 0.3 → population stdev sqrt(1.8/4)
    expect(q.stdev).toBeCloseTo(Math.sqrt(0.45));
    expect(q.pearson).toBeCloseTo(0.8, 5);
    expect(linearRegression([1])).toBeNull();
  });

  it('extendSegment extends only the requested sides (chart left/right)', () => {
    const a = { x: 100, y: 100 };
    const b = { x: 200, y: 50 };
    expect(extendSegment(a, b, false, false, W, H)).toEqual([a, b]);
    const [s, e] = extendSegment(a, b, false, true, W, H);
    expect(s).toEqual(a);
    expect(e.x).toBeGreaterThan(W);
    // anchors drawn right-to-left: "right" still extends past the right-most anchor
    const [s2, e2] = extendSegment(b, a, false, true, W, H);
    expect(s2.x).toBeGreaterThan(W);
    expect(e2).toEqual(a);
  });

  it('angle is counter-clockwise positive', () => {
    expect(screenAngle({ x: 0, y: 100 }, { x: 100, y: 0 })).toBeCloseTo(45);
    expect(screenAngle({ x: 0, y: 0 }, { x: 100, y: 100 })).toBeCloseTo(-45);
  });

  it('formats spans and axis time like TV', () => {
    expect(formatSpan(15 * 3_600_000)).toBe('15h');
    expect(formatSpan(26 * 3_600_000 + 30 * 60_000)).toBe('1d 2h 30m');
    expect(formatTvTime(Date.UTC(2026, 9, 1, 14, 0))).toBe("Thu 01 Oct '26  14:00");
  });
});

describe('parallel channel', () => {
  const s = [{ x: 0, y: 200 }, { x: 100, y: 100 }, { x: 50, y: 250 }];

  it('second rail is a vertical offset through P3', () => {
    expect(channelOffset(s[0], s[1], s[2])).toBe(100);
    const r = parallelRails(s)!;
    expect(r.c).toEqual({ x: 0, y: 300 });
    expect(r.d).toEqual({ x: 100, y: 200 });
  });

  it('exposes 4 corner + 2 middle handles', () => {
    const p = ctxFor('parallel-channel', s);
    expect(BEHAVIORS['parallel-channel']!.handles!(p)).toHaveLength(6);
  });

  it('corner handle keeps width; mid handle changes width', () => {
    const moved = moveParallelHandle(s, 3, { x: 120, y: 220 });
    const r = parallelRails(moved)!;
    expect(r.b).toEqual({ x: 120, y: 120 });
    expect(r.c.y - r.a.y).toBe(100);
    const widened = parallelRails(moveParallelHandle(s, 5, { x: 50, y: 300 }))!;
    expect(widened.a).toEqual(s[0]);
    expect(widened.c.y - widened.a.y).toBe(150);
    const baseMoved = parallelRails(moveParallelHandle(s, 4, { x: 50, y: 140 }))!;
    expect(baseMoved.a.y).toBe(190);
    expect(baseMoved.c.y).toBe(300); // second rail stays put
  });

  it('hit-tests the middle line and both rails, and extensions only when on', () => {
    const p = ctxFor('parallel-channel', s);
    const hit = BEHAVIORS['parallel-channel']!.hitTest!;
    expect(hit(p, { x: 50, y: 200 }, 4)).toBe(true); // middle line
    expect(hit(p, { x: 50, y: 250 }, 4)).toBe(true); // second rail
    expect(hit(p, { x: 300, y: -100 }, 4)).toBe(false);
    const ext = ctxFor('parallel-channel', s, {}, { extendRight: true });
    expect(hit(ext, { x: 300, y: -100 }, 4)).toBe(true);
  });
});

describe('flat top/bottom', () => {
  it('flat handle moves level and that end in time', () => {
    const pts = [{ time: 0, price: 1 }, { time: 10, price: 2 }, { time: 5, price: 3 }];
    expect(moveFlatHandle(pts, 3, { time: 12, price: 4 })).toEqual([
      { time: 0, price: 1 },
      { time: 12, price: 2 },
      { time: 5, price: 4 },
    ]);
    expect(BEHAVIORS['flat-channel']!.points).toBe(3);
  });
});

describe('regression trend', () => {
  it('fits the closes between the anchors and offsets ±2σ', () => {
    const bars = [1.2, 1.4, 1.3, 1.5].map((close, i) => ({ time: i * 1000, open: close, high: close, low: close, close, volume: 0 }));
    const p = ctxFor('regression-channel', [{ x: 100, y: 0 }, { x: 400, y: 0 }], {
      bars,
      timeAt: (x: number) => (x === 100 ? 0 : 3000),
    });
    const r = regressionLines(p)!;
    const y = (price: number) => (2 - price) * H;
    // fit: slope 0.08, intercept 1.23, σ = sqrt(0.0045)
    expect(r.base[0]).toEqual({ x: 100, y: expect.closeTo(y(1.23), 6) });
    expect(r.base[1].y).toBeCloseTo(y(1.23 + 0.24), 6);
    expect(r.upper[0].y).toBeCloseTo(y(1.23 + 2 * Math.sqrt(0.0045)), 6);
    expect(r.lower[1].y).toBeCloseTo(y(1.47 - 2 * Math.sqrt(0.0045)), 6);
    expect(r.pearson).toBeCloseTo(0.8, 5);
    expect(BEHAVIORS['regression-channel']!.handles!(p)[0]).toEqual(r.base[0]);
  });
});

describe('pitchforks', () => {
  const p1 = { x: 0, y: 200 };
  const p2 = { x: 100, y: 100 };
  const p3 = { x: 200, y: 300 };

  it('median origin per variant', () => {
    expect(pitchforkOrigin('pitchfork', p1, p2)).toEqual(p1);
    expect(pitchforkOrigin('schiff-pitchfork', p1, p2)).toEqual({ x: 0, y: 150 });
    expect(pitchforkOrigin('modified-schiff-pitchfork', p1, p2)).toEqual({ x: 50, y: 150 });
    expect(pitchforkOrigin('inside-pitchfork', p1, p2)).toEqual({ x: 50, y: 150 });
  });

  it('default levels: 0.5 and 1 visible; level 1 passes through P2/P3 parallel to the median', () => {
    expect(PITCHFORK_LEVELS.map((l) => l.value)).toEqual([0.25, 0.382, 0.5, 0.618, 0.75, 1, 1.5, 1.75, 2]);
    expect(PITCHFORK_LEVELS.filter((l) => l.visible).map((l) => l.value)).toEqual([0.5, 1]);
    const L = pitchforkLines('pitchfork', [p1, p2, p3], {}, W, H)!;
    expect(L.median).toEqual([p1, { x: 300, y: 200 }]);
    const one = L.levels.filter((l) => l.value === 1);
    expect(one[0].from).toEqual(p2);
    expect(one[1].from).toEqual(p3);
    expect(one[0].to).toEqual({ x: 250, y: 100 });
  });

  it('hit-tests along the extended median', () => {
    const p = ctxFor('pitchfork', [p1, p2, p3]);
    const hit = BEHAVIORS['pitchfork']!.hitTest!;
    expect(hit(p, { x: 600, y: 200 }, 4)).toBe(false);
    const ext = ctxFor('pitchfork', [p1, p2, p3], {}, { extendLines: true });
    expect(hit(ext, { x: 600, y: 200 }, 4)).toBe(true);
  });
});

describe('lines', () => {
  it('option defaults: ray extends right, extended line both, info line shows stats', () => {
    const o = (k: Drawing['kind']) => optionsOf(BEHAVIORS[k], drawing(k));
    expect(o('trend-line')).toMatchObject({ extendLeft: false, extendRight: false, alwaysShowStats: false, showAngle: false, showPriceRange: false });
    expect(o('ray')).toMatchObject({ extendLeft: false, extendRight: true });
    expect(o('extended-line')).toMatchObject({ extendLeft: true, extendRight: true });
    expect(o('info-line')).toMatchObject({ alwaysShowStats: true, showAngle: true, showBarsRange: true, statsPosition: 'center' });
    expect(BEHAVIORS['trend-line']!.defaultStyle).toMatchObject({ color: '#2962FF', width: 2 });
  });

  it('ray is grabbable beyond P2 but not behind P1', () => {
    const p = ctxFor('ray', [{ x: 100, y: 100 }, { x: 200, y: 100 }]);
    const hit = BEHAVIORS['ray']!.hitTest!;
    expect(hit(p, { x: 700, y: 101 }, 4)).toBe(true);
    expect(hit(p, { x: 50, y: 100 }, 4)).toBe(false);
  });

  it('single-anchor tools', () => {
    for (const k of ['horizontal-line', 'horizontal-ray', 'vertical-line', 'cross-line'] as const) {
      expect(BEHAVIORS[k]!.points).toBe(1);
    }
    const v = ctxFor('vertical-line', [{ x: 300, y: 50 }]);
    expect(BEHAVIORS['vertical-line']!.handles!(v)).toEqual([{ x: 300, y: H / 2 }]);
    const moved = BEHAVIORS['vertical-line']!.moveHandle!(drawing('vertical-line', 1), 0, { time: 99, price: 7 }, {
      project: () => null,
      unproject: () => null,
    });
    expect(moved).toEqual([{ time: 99, price: 1 }]);
    const hr = ctxFor('horizontal-ray', [{ x: 300, y: 50 }]);
    expect(BEHAVIORS['horizontal-ray']!.hitTest!(hr, { x: 700, y: 50 }, 4)).toBe(true);
    expect(BEHAVIORS['horizontal-ray']!.hitTest!(hr, { x: 100, y: 50 }, 4)).toBe(false);
  });
});
