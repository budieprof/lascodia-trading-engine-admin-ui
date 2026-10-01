import { describe, expect, it } from 'vitest';
import type { Drawing, DrawingKind } from '../model';
import {
  BEHAVIORS,
  abcdRatios,
  cycleXs,
  cypherRatios,
  elliottLabel,
  elliottLabels,
  hsHumps,
  isSwingHigh,
  legRatio,
  neckline,
  sinePoints,
  sineY,
  threeDrivesRatios,
  timeCycleArcs,
  trianglePolygon,
  withAlpha,
  xabcdRatios,
} from './patterns';
import { optionsOf } from './types';

function ctxFor(kind: DrawingKind, pts: { x: number; y: number }[], options: Record<string, unknown> = {}) {
  const drawing = {
    kind,
    points: pts.map((p) => ({ time: p.x, price: -p.y })),
    style: { color: '#2962FF', width: 2, dash: 'solid', fill: null, fontSize: 12, text: '', showLabels: true },
    options,
  } as unknown as Drawing;
  return {
    ctx: null as unknown as CanvasRenderingContext2D,
    drawing,
    pts,
    width: 1000,
    height: 600,
    priceAt: () => null,
    precision: 5,
    options: optionsOf(BEHAVIORS[kind], drawing),
  };
}

describe('ratio math', () => {
  it('legRatio is |bc| / |ab|', () => {
    expect(legRatio(0, 10, 3.82)).toBeCloseTo(0.618, 3);
    expect(legRatio(5, 5, 9)).toBe(0);
  });
  it('xabcd places AB/XA, BC/AB, CD/BC, AD/XA', () => {
    const r = xabcdRatios([100, 200, 138.2, 176.4, 121.4]);
    expect(r.xb).toBeCloseTo(0.618, 3);
    expect(r.ac).toBeCloseTo(0.618, 3);
    expect(r.bd).toBeCloseTo(1.44, 2);
    expect(r.xd).toBeCloseTo(0.786, 3);
  });
  it('partial xabcd only fills reached legs', () => {
    expect(xabcdRatios([1, 2, 1.5]).ac).toBeUndefined();
  });
  it('abcd', () => {
    const r = abcdRatios([10, 20, 13.82, 23.82]);
    expect(r.ac).toBeCloseTo(0.618, 3);
    expect(r.bd).toBeCloseTo(1.618, 3);
  });
  it('cypher: XC as extension of XA, CD as retracement of XC', () => {
    const r = cypherRatios([100, 200, 150, 227.2, 0]);
    expect(r.xb).toBeCloseTo(0.5, 3);
    expect(r.xc).toBeCloseTo(1.272, 3);
    expect(r.xd).toBeCloseTo(227.2 / 127.2, 3);
  });
  it('three drives ratios per leg', () => {
    expect(threeDrivesRatios([0, 10, 4, 16, 10, 22, 16])).toHaveLength(5);
    expect(threeDrivesRatios([0, 10, 4])[0]).toBeCloseTo(0.6, 6);
  });
  it('withAlpha', () => {
    expect(withAlpha('#2962FF', 0.2)).toBe('rgba(41, 98, 255, 0.2)');
  });
});

describe('Elliott labels per degree', () => {
  it('impulse at each canonical degree', () => {
    expect(elliottLabels('elliott-impulse', 'Intermediate')).toEqual(['', '(1)', '(2)', '(3)', '(4)', '(5)']);
    expect(elliottLabels('elliott-impulse', 'Minor')).toEqual(['', '1', '2', '3', '4', '5']);
    expect(elliottLabels('elliott-impulse', 'Primary')).toEqual(['', '◯1', '◯2', '◯3', '◯4', '◯5']);
    expect(elliottLabels('elliott-impulse', 'Cycle')).toEqual(['', 'I', 'II', 'III', 'IV', 'V']);
    expect(elliottLabels('elliott-impulse', 'Supercycle')[1]).toBe('(I)');
    expect(elliottLabels('elliott-impulse', 'Grand Supercycle')[5]).toBe('((V))');
    expect(elliottLabels('elliott-impulse', 'Minuette')[4]).toBe('(iv)');
    expect(elliottLabels('elliott-impulse', 'Subminuette')[3]).toBe('iii');
  });
  it('corrective and combos', () => {
    expect(elliottLabels('elliott-correction', 'Intermediate')).toEqual(['', '(A)', '(B)', '(C)']);
    expect(elliottLabels('elliott-triangle', 'Minute')).toEqual(['', '◯a', '◯b', '◯c', '◯d', '◯e']);
    expect(elliottLabels('elliott-double-combo', 'Minor')).toEqual(['', 'W', 'X', 'Y']);
    expect(elliottLabels('elliott-triple-combo', 'Minuette')).toEqual(['', '(w)', '(x)', '(y)', '(x)', '(z)']);
  });
  it('minor / intermediate tools default to their degree', () => {
    const minor = BEHAVIORS['elliott-minor']!.options!.find((o) => o.key === 'degree')!;
    const inter = BEHAVIORS['elliott-intermediate']!.options!.find((o) => o.key === 'degree')!;
    expect(minor.default).toBe('Minor');
    expect(inter.default).toBe('Intermediate');
    expect(elliottLabel('', 'Minor').text).toBe('');
  });
  it('label above swing highs, below lows', () => {
    const pts = [
      { x: 0, y: 100 },
      { x: 10, y: 50 },
      { x: 20, y: 80 },
    ];
    expect(isSwingHigh(pts, 1)).toBe(true);
    expect(isSwingHigh(pts, 2)).toBe(false);
    expect(isSwingHigh(pts, 0)).toBe(false);
  });
});

describe('point counts', () => {
  it.each([
    ['xabcd-pattern', 5],
    ['cypher-pattern', 5],
    ['five-point-pattern', 5],
    ['abcd-pattern', 4],
    ['triangle-pattern', 4],
    ['three-drives', 7],
    ['head-and-shoulders', 7],
    ['head-and-shoulders-inverse', 7],
    ['elliott-impulse', 6],
    ['elliott-correction', 4],
    ['elliott-triangle', 6],
    ['elliott-double-combo', 4],
    ['elliott-triple-combo', 6],
    ['elliott-minor', 6],
    ['elliott-intermediate', 6],
    ['cyclic-lines', 2],
    ['time-cycles', 2],
    ['sine-line', 2],
  ] as const)('%s takes %d', (kind, n) => expect(BEHAVIORS[kind]!.points).toBe(n));
});

describe('cycles', () => {
  it('cyclic lines are equally spaced from the earlier anchor past the right edge', () => {
    expect(cycleXs(100, 150, 300)).toEqual([100, 150, 200, 250, 300, 350]);
    expect(cycleXs(150, 100, 200)).toEqual([100, 150, 200, 250]);
    expect(cycleXs(10, 10, 100)).toEqual([10]);
  });
  it('time cycles: arcs of diameter |P2-P1| tile from P1', () => {
    const arcs = timeCycleArcs({ x: 0, y: 0 }, { x: 40, y: 10 }, 100);
    expect(arcs[0]).toEqual({ cx: 20, r: 20 });
    expect(arcs[1]).toEqual({ cx: 60, r: 20 });
  });
  it('sine: crest at P1, trough at P2, period 2·(x2-x1)', () => {
    const a = { x: 100, y: 50 };
    const b = { x: 150, y: 150 };
    expect(sineY(a, b, 100)).toBeCloseTo(50);
    expect(sineY(a, b, 150)).toBeCloseTo(150);
    expect(sineY(a, b, 200)).toBeCloseTo(50);
    expect(sineY(a, b, 125)).toBeCloseTo(100);
    const pts = sinePoints(a, b, 400, 50);
    expect(pts.map((p) => p.x)).toEqual([0, 50, 100, 150, 200, 250, 300, 350, 400]);
    expect(pts[2].y).toBeCloseTo(50);
  });
});

describe('geometry helpers', () => {
  it('converging triangle closes at the apex', () => {
    const poly = trianglePolygon([
      { x: 0, y: 0 },
      { x: 10, y: 100 },
      { x: 20, y: 20 },
      { x: 30, y: 80 },
    ]);
    expect(poly).toHaveLength(3);
    expect(poly[2].x).toBeGreaterThan(30);
  });
  it('head & shoulders humps and neckline', () => {
    const pts = [0, 1, 2, 3, 4, 5, 6].map((i) => ({ x: i * 10, y: i % 2 ? 0 : 100 }));
    expect(hsHumps(pts)).toHaveLength(3);
    const n = neckline(pts)!;
    expect(n[0]).toEqual({ x: 0, y: 100 });
    expect(n[1]).toEqual({ x: 60, y: 100 });
  });
});

describe('hitTest', () => {
  const xabcd = [
    { x: 0, y: 200 },
    { x: 50, y: 50 },
    { x: 100, y: 150 },
    { x: 150, y: 80 },
    { x: 200, y: 180 },
  ];
  it('xabcd hits legs and the filled XAB triangle, misses empty space', () => {
    const b = BEHAVIORS['xabcd-pattern']!;
    expect(b.hitTest!(ctxFor('xabcd-pattern', xabcd), { x: 25, y: 125 }, 6)).toBe(true);
    expect(b.hitTest!(ctxFor('xabcd-pattern', xabcd), { x: 50, y: 120 }, 6)).toBe(true);
    expect(b.hitTest!(ctxFor('xabcd-pattern', xabcd, { fillBackground: false }), { x: 50, y: 120 }, 6)).toBe(false);
    expect(b.hitTest!(ctxFor('xabcd-pattern', xabcd), { x: 500, y: 500 }, 6)).toBe(false);
  });
  it('elliott hits wave segments only', () => {
    const b = BEHAVIORS['elliott-impulse']!;
    expect(b.hitTest!(ctxFor('elliott-impulse', xabcd), { x: 75, y: 100 }, 6)).toBe(true);
    expect(b.hitTest!(ctxFor('elliott-impulse', xabcd), { x: 50, y: 120 }, 6)).toBe(false);
  });
  it('cyclic lines hit any vertical', () => {
    const b = BEHAVIORS['cyclic-lines']!;
    const c = ctxFor('cyclic-lines', [
      { x: 100, y: 50 },
      { x: 150, y: 50 },
    ]);
    expect(b.hitTest!(c, { x: 352, y: 400 }, 6)).toBe(true);
    expect(b.hitTest!(c, { x: 375, y: 400 }, 6)).toBe(false);
  });
  it('time cycles hit the arc rim and fill, not below the baseline', () => {
    const b = BEHAVIORS['time-cycles']!;
    const c = ctxFor('time-cycles', [
      { x: 0, y: 300 },
      { x: 100, y: 300 },
    ]);
    expect(b.hitTest!(c, { x: 50, y: 250 }, 6)).toBe(true);
    expect(b.hitTest!(c, { x: 150, y: 260 }, 6)).toBe(true);
    expect(b.hitTest!(c, { x: 50, y: 400 }, 6)).toBe(false);
  });
  it('sine line hits along the wave', () => {
    const b = BEHAVIORS['sine-line']!;
    const c = ctxFor('sine-line', [
      { x: 100, y: 50 },
      { x: 150, y: 150 },
    ]);
    expect(b.hitTest!(c, { x: 200, y: 52 }, 6)).toBe(true);
    expect(b.hitTest!(c, { x: 200, y: 150 }, 6)).toBe(false);
  });
});
