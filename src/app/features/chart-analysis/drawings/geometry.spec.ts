import { describe, expect, it } from 'vitest';
import {
  distanceToLine,
  distanceToRay,
  distanceToSegment,
  fibPrice,
  hitEllipse,
  hitHandle,
  hitPolyline,
  hitRect,
  hitTestDrawing,
  magnetPrice,
  pointInPolygon,
} from './geometry';
import { TOOLS } from './model';
import type { Pt } from './geometry';

const bounds = { width: 800, height: 400 };

describe('distanceToSegment', () => {
  it('measures perpendicular distance inside the span', () => {
    expect(distanceToSegment({ x: 5, y: 5 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(5);
  });

  it('clamps past the ends so a segment is not an infinite line', () => {
    // The whole point of the clamp: at x=100 the nearest point is the END,
    // 90px away — not the 0px a line would report.
    expect(distanceToSegment({ x: 100, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(90);
  });

  it('handles a degenerate zero-length segment', () => {
    expect(distanceToSegment({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 })).toBe(5);
  });
});

describe('distanceToLine / distanceToRay', () => {
  it('an infinite line stays close far beyond its points', () => {
    expect(distanceToLine({ x: 1000, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(0, 6);
  });

  it('a ray extends forwards but not backwards', () => {
    expect(distanceToRay({ x: 1000, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(0, 6);
    expect(distanceToRay({ x: -50, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(50);
  });
});

describe('hitRect', () => {
  const a = { x: 0, y: 0 };
  const b = { x: 100, y: 50 };

  it('an unfilled rectangle is grabbable only on its edges', () => {
    // An unfilled rect that swallowed interior clicks would block every
    // drawing and candle beneath it.
    expect(hitRect({ x: 50, y: 25 }, a, b, false)).toBe(false);
    expect(hitRect({ x: 50, y: 0 }, a, b, false)).toBe(true);
  });

  it('a filled rectangle is grabbable inside', () => {
    expect(hitRect({ x: 50, y: 25 }, a, b, true)).toBe(true);
  });

  it('misses well outside', () => {
    expect(hitRect({ x: 300, y: 300 }, a, b, true)).toBe(false);
  });
});

describe('hitEllipse', () => {
  const a = { x: 0, y: 0 };
  const b = { x: 100, y: 100 };

  it('filled hits the centre, unfilled does not', () => {
    expect(hitEllipse({ x: 50, y: 50 }, a, b, true)).toBe(true);
    expect(hitEllipse({ x: 50, y: 50 }, a, b, false)).toBe(false);
  });

  it('unfilled hits the perimeter', () => {
    expect(hitEllipse({ x: 100, y: 50 }, a, b, false)).toBe(true);
  });
});

describe('pointInPolygon / hitPolyline', () => {
  const tri = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 50, y: 100 },
  ];

  it('detects inside and outside a triangle', () => {
    expect(pointInPolygon({ x: 50, y: 20 }, tri)).toBe(true);
    expect(pointInPolygon({ x: 5, y: 90 }, tri)).toBe(false);
  });

  it('follows a polyline segment by segment', () => {
    const path = [
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { x: 50, y: 50 },
    ];
    expect(hitPolyline({ x: 50, y: 25 }, path)).toBe(true);
    expect(hitPolyline({ x: 200, y: 200 }, path)).toBe(false);
  });
});

describe('hitHandle', () => {
  const pts = [
    { x: 10, y: 10 },
    { x: 90, y: 90 },
  ];

  it('returns the index of the grabbed anchor', () => {
    expect(hitHandle({ x: 11, y: 12 }, pts)).toBe(0);
    expect(hitHandle({ x: 88, y: 92 }, pts)).toBe(1);
  });

  it('returns -1 away from every anchor', () => {
    expect(hitHandle({ x: 50, y: 50 }, pts)).toBe(-1);
  });
});

describe('hitTestDrawing', () => {
  const a = { x: 100, y: 100 };
  const b = { x: 200, y: 200 };

  it('a trend line is bounded by its anchors', () => {
    expect(hitTestDrawing({ x: 150, y: 150 }, 'trend-line', [a, b], false, bounds)).toBe(true);
    expect(hitTestDrawing({ x: 400, y: 400 }, 'trend-line', [a, b], false, bounds)).toBe(false);
  });

  it('a ray continues past its second anchor but not behind the first', () => {
    expect(hitTestDrawing({ x: 400, y: 400 }, 'ray', [a, b], false, bounds)).toBe(true);
    expect(hitTestDrawing({ x: 50, y: 50 }, 'ray', [a, b], false, bounds)).toBe(false);
  });

  it('an extended line continues in both directions', () => {
    expect(hitTestDrawing({ x: 400, y: 400 }, 'extended-line', [a, b], false, bounds)).toBe(true);
    expect(hitTestDrawing({ x: 50, y: 50 }, 'extended-line', [a, b], false, bounds)).toBe(true);
  });

  it('a horizontal line is grabbable across the full width', () => {
    expect(hitTestDrawing({ x: 700, y: 100 }, 'horizontal-line', [a], false, bounds)).toBe(true);
    expect(hitTestDrawing({ x: 700, y: 180 }, 'horizontal-line', [a], false, bounds)).toBe(false);
  });

  it('a vertical line is grabbable down the full height', () => {
    expect(hitTestDrawing({ x: 100, y: 390 }, 'vertical-line', [a], false, bounds)).toBe(true);
  });

  it('a cross line answers to either axis', () => {
    expect(hitTestDrawing({ x: 700, y: 100 }, 'cross-line', [a], false, bounds)).toBe(true);
    expect(hitTestDrawing({ x: 100, y: 390 }, 'cross-line', [a], false, bounds)).toBe(true);
    expect(hitTestDrawing({ x: 700, y: 390 }, 'cross-line', [a], false, bounds)).toBe(false);
  });

  it('a horizontal ray does not extend behind its origin', () => {
    expect(hitTestDrawing({ x: 700, y: 100 }, 'horizontal-ray', [a, b], false, bounds)).toBe(true);
    expect(hitTestDrawing({ x: 10, y: 100 }, 'horizontal-ray', [a, b], false, bounds)).toBe(false);
  });

  it('a fib is grabbable across the band its levels span', () => {
    expect(hitTestDrawing({ x: 600, y: 150 }, 'fib-retracement', [a, b], false, bounds)).toBe(true);
  });

  it('returns false with no points rather than throwing', () => {
    expect(hitTestDrawing({ x: 0, y: 0 }, 'trend-line', [], false, bounds)).toBe(false);
  });
});

describe('fibPrice', () => {
  it('interpolates between the anchors', () => {
    expect(fibPrice(100, 200, 0)).toBe(100);
    expect(fibPrice(100, 200, 0.618)).toBeCloseTo(161.8, 6);
    expect(fibPrice(100, 200, 1)).toBe(200);
  });

  it('projects past the anchors for extension ratios', () => {
    expect(fibPrice(100, 200, 1.618)).toBeCloseTo(261.8, 6);
  });
});

describe('magnetPrice', () => {
  const bar = { open: 1.1, high: 1.15, low: 1.05, close: 1.12 };

  it('snaps to the nearest OHLC within the threshold', () => {
    expect(magnetPrice(1.149, bar, 0.01)).toBe(1.15);
    expect(magnetPrice(1.051, bar, 0.01)).toBe(1.05);
  });

  it('leaves the price alone when nothing is near enough', () => {
    // Otherwise magnet would yank a point somewhere the operator never clicked.
    expect(magnetPrice(1.3, bar, 0.01)).toBe(1.3);
  });

  it('passes through when there is no bar', () => {
    expect(magnetPrice(1.234, null, 0.01)).toBe(1.234);
  });
});

describe('every tool is selectable', () => {
  /**
   * A drawing that renders but cannot be hit-tested is a trap: the operator
   * places it, then cannot select, move or delete it, and the only way out is
   * clearing the whole chart.
   *
   * This is not hypothetical. `hitTestDrawing`'s default arm requires TWO
   * points, so any single-point tool that is not listed explicitly falls
   * through it and is permanently unselectable — which is exactly what
   * happened to the four arrow marks before they were given a case.
   *
   * The test synthesises each tool at its OWN declared point count and asserts
   * a click on its own geometry registers.
   */
  const pointsFor = (spec: (typeof TOOLS)[number]): Pt[] => {
    const n = spec.points === 'freehand' ? 3 : spec.points;
    // A rising diagonal — non-degenerate in both axes, so no tool is tested
    // against a zero-width or zero-height shape it would rightly reject.
    return Array.from({ length: n }, (_, i) => ({ x: 100 + i * 60, y: 200 - i * 40 }));
  };

  for (const spec of TOOLS) {
    it(`${spec.kind} responds to a click on itself`, () => {
      const pts = pointsFor(spec);
      // Probe the anchors AND the midpoints between them. Anchors alone are
      // not a fair probe for every tool: an inscribed shape such as `ellipse`
      // is BOUNDED by its two anchors and genuinely does not pass through
      // them, so a corner click should miss. Something at or between the
      // anchors must register though — that is what "selectable" means.
      const probes = [...pts];
      for (let i = 0; i + 1 < pts.length; i++) {
        probes.push({ x: (pts[i].x + pts[i + 1].x) / 2, y: (pts[i].y + pts[i + 1].y) / 2 });
      }
      const hit = probes.some((pt) => hitTestDrawing(pt, spec.kind, pts, true, bounds));
      expect(hit, `${spec.kind} is unselectable anywhere on its own geometry`).toBe(true);
    });
  }
});
