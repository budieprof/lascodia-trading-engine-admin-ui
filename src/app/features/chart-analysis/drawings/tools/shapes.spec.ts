import { describe, expect, it } from 'vitest';
import type { Pt } from '../geometry';
import { styleFor, type Drawing, type DrawingKind, type DrawingPoint } from '../model';
import { behaviorFor } from './registry';
import { optionsOf, type ToolGeometry } from './types';
import {
  arcThrough,
  ellipseFrom3,
  ellipseHandles,
  hitEllipseGeom,
  rectHandles,
  rotatedRectCorners,
  smoothStroke,
} from './shapes-geom';
import { moveCircleHandle, moveEllipseHandle, moveRectHandle, rotatedRectHandles } from './shapes';
import { polylineClosed } from './shapes-lines';
import { arrowMarkPolygon } from './shapes-marks';

/** Identity-ish geometry: time ↔ x, price ↔ −y (higher price = higher on screen). */
const geo: ToolGeometry = {
  project: (p) => ({ x: p.time, y: -p.price }),
  unproject: (p) => ({ time: p.x, price: -p.y }),
};
const dp = (x: number, y: number): DrawingPoint => ({ time: x, price: -y });
const near = (a: Pt, b: Pt) => {
  expect(a.x).toBeCloseTo(b.x, 6);
  expect(a.y).toBeCloseTo(b.y, 6);
};

function drawing(kind: DrawingKind, points: DrawingPoint[], options?: Record<string, unknown>): Drawing {
  return { id: 'd', kind, symbol: 'X', resolution: '60', points, style: styleFor(kind), locked: false, createdAt: 0, options };
}

function ctxFor(kind: DrawingKind, pts: Pt[], options?: Record<string, unknown>) {
  const d = drawing(kind, pts.map((p) => dp(p.x, p.y)), options);
  return {
    ctx: null as unknown as CanvasRenderingContext2D,
    drawing: d,
    pts,
    width: 800,
    height: 600,
    priceAt: () => null,
    precision: 5,
    options: optionsOf(behaviorFor(kind), d),
  };
}

describe('ellipse', () => {
  it('puts its four handles on the perimeter at the axis ends, rotated with the shape', () => {
    // First axis from (0,0) to (100,100) — 45° — second radius 20.
    const a = { x: 0, y: 0 };
    const b = { x: 100, y: 100 };
    const n = { x: -Math.SQRT1_2, y: Math.SQRT1_2 };
    const c = { x: 50 + n.x * 20, y: 50 + n.y * 20 };
    const e = ellipseFrom3(a, b, c);
    expect(e.rx).toBeCloseTo(Math.hypot(100, 100) / 2, 6);
    expect(e.ry).toBeCloseTo(20, 6);
    const h = ellipseHandles(e);
    near(h[0], a);
    near(h[1], b);
    near(h[2], c);
    near(h[3], { x: 50 - n.x * 20, y: 50 - n.y * 20 });
    for (const p of h) expect(hitEllipseGeom(e, p, false, 0.5)).toBe(true);
  });

  it('moving an axis-end handle keeps the opposite end and the other radius', () => {
    const d = drawing('ellipse', [dp(0, 0), dp(100, 0), dp(50, 30)]);
    const out = moveEllipseHandle(d, 1, dp(0, 100), geo).map((p) => geo.project(p)!);
    near(out[0], { x: 0, y: 0 });
    near(out[1], { x: 0, y: 100 });
    const e = ellipseFrom3(out[0], out[1], out[2]);
    expect(e.ry).toBeCloseTo(30, 6);
    expect(e.angle).toBeCloseTo(Math.PI / 2, 6);
  });

  it('moving a second-axis handle changes only that radius', () => {
    const d = drawing('ellipse', [dp(0, 0), dp(100, 0), dp(50, 30)]);
    const out = moveEllipseHandle(d, 3, dp(70, -45), geo).map((p) => geo.project(p)!);
    near(out[0], { x: 0, y: 0 });
    near(out[1], { x: 100, y: 0 });
    expect(ellipseFrom3(out[0], out[1], out[2]).ry).toBeCloseTo(45, 6);
  });

  it('hit-tests the outline, and the inside only when filled', () => {
    const b = behaviorFor('ellipse')!;
    const pts = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 30 }];
    expect(b.hitTest!(ctxFor('ellipse', pts), { x: 50, y: 31 }, 6)).toBe(true);
    expect(b.hitTest!(ctxFor('ellipse', pts), { x: 50, y: 5 }, 6)).toBe(true);
    expect(b.hitTest!(ctxFor('ellipse', pts, { fillBackground: false }), { x: 50, y: 5 }, 6)).toBe(false);
    expect(b.hitTest!(ctxFor('ellipse', pts), { x: 50, y: 60 }, 6)).toBe(false);
  });

  it('uses TradingView defaults', () => {
    const s = styleFor('ellipse');
    expect(s.color).toBe('#F23645');
    expect(s.fill).toBe('rgba(242,54,69,0.2)');
    expect(behaviorFor('ellipse')!.points).toBe(3);
  });
});

describe('rectangle', () => {
  const d = drawing('rectangle', [dp(10, 10), dp(110, 60)]);
  const screen = (pts: DrawingPoint[]) => pts.map((p) => geo.project(p)!);

  it('exposes 4 corners + 4 edge midpoints', () => {
    const h = rectHandles({ x: 10, y: 10 }, { x: 110, y: 60 });
    expect(h).toHaveLength(8);
    near(h[4], { x: 60, y: 10 });
    near(h[5], { x: 110, y: 35 });
  });

  it('edge handles resize one side only', () => {
    const top = screen(moveRectHandle(d, 4, dp(999, -20), geo));
    expect(Math.min(top[0].y, top[1].y)).toBeCloseTo(-20);
    expect(Math.max(top[0].y, top[1].y)).toBeCloseTo(60);
    expect(Math.min(top[0].x, top[1].x)).toBe(10);
    expect(Math.max(top[0].x, top[1].x)).toBe(110);

    const right = screen(moveRectHandle(d, 5, dp(200, 999), geo));
    expect(Math.max(right[0].x, right[1].x)).toBe(200);
    expect(Math.min(right[0].y, right[1].y)).toBeCloseTo(10);
    expect(Math.max(right[0].y, right[1].y)).toBeCloseTo(60);
  });

  it('corner handles move two sides', () => {
    const br = screen(moveRectHandle(d, 2, dp(150, 90), geo));
    expect(Math.max(br[0].x, br[1].x)).toBe(150);
    expect(Math.max(br[0].y, br[1].y)).toBeCloseTo(90);
    expect(Math.min(br[0].x, br[1].x)).toBe(10);
  });

  it('hit-tests edges, inside when filled, and extends right', () => {
    const b = behaviorFor('rectangle')!;
    const pts = [{ x: 10, y: 10 }, { x: 110, y: 60 }];
    expect(b.hitTest!(ctxFor('rectangle', pts), { x: 60, y: 35 }, 6)).toBe(true);
    expect(b.hitTest!(ctxFor('rectangle', pts, { fillBackground: false }), { x: 60, y: 35 }, 6)).toBe(false);
    expect(b.hitTest!(ctxFor('rectangle', pts, { fillBackground: false }), { x: 60, y: 12 }, 6)).toBe(true);
    expect(b.hitTest!(ctxFor('rectangle', pts), { x: 500, y: 35 }, 6)).toBe(false);
    expect(b.hitTest!(ctxFor('rectangle', pts, { extendRight: true }), { x: 500, y: 35 }, 6)).toBe(true);
  });

  it('defaults to TradingView purple at 20%', () => {
    expect(styleFor('rectangle').color).toBe('#9C27B0');
    expect(styleFor('rectangle').fill).toBe('rgba(156,39,176,0.2)');
  });
});

describe('rotated rectangle', () => {
  it('builds corners from a base and a width point', () => {
    const c = rotatedRectCorners({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 30, y: 40 });
    near(c[2], { x: 100, y: 40 });
    near(c[3], { x: 0, y: 40 });
    const h = rotatedRectHandles([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 30, y: 40 }]);
    near(h[2], { x: 50, y: 40 });
  });

  it('works when rotated 90°', () => {
    const c = rotatedRectCorners({ x: 0, y: 0 }, { x: 0, y: 100 }, { x: -20, y: 10 });
    near(c[2], { x: -20, y: 100 });
    near(c[3], { x: -20, y: 0 });
  });

  it('hit-tests the filled body', () => {
    const b = behaviorFor('rotated-rectangle')!;
    const pts = [{ x: 0, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 40 }];
    expect(b.hitTest!(ctxFor('rotated-rectangle', pts), { x: 50, y: 50 }, 6)).toBe(true);
    expect(b.hitTest!(ctxFor('rotated-rectangle', pts), { x: 90, y: 10 }, 6)).toBe(false);
  });
});

describe('circle', () => {
  it('centre handle translates, perimeter handle resizes', () => {
    const d = drawing('circle', [{ time: 0, price: 0 }, { time: 10, price: 0 }]);
    expect(moveCircleHandle(d, 0, { time: 5, price: 5 })).toEqual([
      { time: 5, price: 5 },
      { time: 15, price: 5 },
    ]);
    expect(moveCircleHandle(d, 1, { time: 0, price: 20 })[1]).toEqual({ time: 0, price: 20 });
  });
  it('hit-tests ring and filled interior', () => {
    const b = behaviorFor('circle')!;
    const pts = [{ x: 0, y: 0 }, { x: 50, y: 0 }];
    expect(b.hitTest!(ctxFor('circle', pts), { x: 0, y: 10 }, 6)).toBe(true);
    expect(b.hitTest!(ctxFor('circle', pts, { fillBackground: false }), { x: 0, y: 10 }, 6)).toBe(false);
    expect(b.hitTest!(ctxFor('circle', pts, { fillBackground: false }), { x: 0, y: 52 }, 6)).toBe(true);
  });
});

describe('strokes, curves and marks', () => {
  it('polyline closes when the last click returns to the first point', () => {
    const r = polylineClosed([{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }, { x: 2, y: 2 }]);
    expect(r.closed).toBe(true);
    expect(r.pts).toHaveLength(3);
  });

  it('brush smoothing keeps endpoints', () => {
    const pts = [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 0 }, { x: 30, y: 10 }];
    const s = smoothStroke(pts, 5);
    near(s[0], pts[0]);
    near(s[3], pts[3]);
  });

  it('arc curve passes through its third anchor', () => {
    const o = arcThrough({ x: 0, y: 0 }, { x: 50, y: -50 }, { x: 100, y: 0 });
    near(o[0], { x: 0, y: 0 });
    near(o[o.length - 1], { x: 100, y: 0 });
    expect(Math.min(...o.map((p) => p.y))).toBeCloseTo(-50, 1);
  });

  it('arrow line hit-tests its segment', () => {
    const b = behaviorFor('arrow')!;
    expect(b.hitTest!(ctxFor('arrow', [{ x: 0, y: 0 }, { x: 100, y: 0 }]), { x: 50, y: 3 }, 6)).toBe(true);
    expect(b.hitTest!(ctxFor('arrow', [{ x: 0, y: 0 }, { x: 100, y: 0 }]), { x: 150, y: 0 }, 6)).toBe(false);
  });

  it('arrow mark tip sits on the anchor and the glyph is grabbable', () => {
    const up = arrowMarkPolygon({ x: 100, y: 100 }, 'up');
    near(up[0], { x: 100, y: 100 });
    expect(Math.max(...up.map((p) => p.y))).toBe(126);
    const down = arrowMarkPolygon({ x: 100, y: 100 }, 'down');
    expect(Math.min(...down.map((p) => p.y))).toBe(74);
    const b = behaviorFor('arrow-mark-up')!;
    expect(b.hitTest!(ctxFor('arrow-mark-up', [{ x: 100, y: 100 }]), { x: 100, y: 115 }, 6)).toBe(true);
    expect(b.hitTest!(ctxFor('arrow-mark-up', [{ x: 100, y: 100 }]), { x: 100, y: 60 }, 6)).toBe(false);
    expect(styleFor('arrow-mark-down').color).toBe('#CC2F3C');
  });

  it('every Geometric-shapes tool has a behaviour', () => {
    const kinds: DrawingKind[] = [
      'brush', 'highlighter', 'arrow', 'arrow-mark-up', 'arrow-mark-down', 'arrow-mark-left', 'arrow-mark-right',
      'rectangle', 'rotated-rectangle', 'path', 'circle', 'ellipse', 'polyline', 'triangle', 'arc', 'curve',
      'double-curve', 'arc-curve',
    ];
    for (const k of kinds) expect(behaviorFor(k), k).toBeDefined();
  });
});
