import { describe, expect, it } from 'vitest';

import {
  ORDER_STAGES,
  chartGeometry,
  ema,
  ladder,
  nextCandle,
  nextStage,
  primaryCta,
  seedCandles,
  seededRandom,
  tickCandle,
} from './landing.logic';

describe('landing logic', () => {
  it('seeded random is deterministic and in range', () => {
    const a = seededRandom(42);
    const b = seededRandom(42);
    for (let i = 0; i < 100; i++) {
      const v = a();
      expect(v).toBe(b());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('candles are well formed and chain open to previous close', () => {
    const bars = seedCandles(50, 1.08, seededRandom(7));
    expect(bars).toHaveLength(50);
    bars.forEach((c, i) => {
      expect(c.h).toBeGreaterThanOrEqual(Math.max(c.o, c.c));
      expect(c.l).toBeLessThanOrEqual(Math.min(c.o, c.c));
      if (i > 0) expect(c.o).toBe(bars[i - 1].c);
    });
  });

  it('a ticking bar keeps its open and contains its close', () => {
    const rnd = seededRandom(3);
    let bar = nextCandle(1.1, rnd);
    for (let i = 0; i < 40; i++) {
      bar = tickCandle(bar, rnd);
      expect(bar.o).toBe(1.1);
      expect(bar.h).toBeGreaterThanOrEqual(bar.c);
      expect(bar.l).toBeLessThanOrEqual(bar.c);
    }
  });

  it('ema starts at the first value and stays within the range', () => {
    const out = ema([1, 2, 3, 4, 5], 3);
    expect(out[0]).toBe(1);
    expect(out[4]).toBeGreaterThan(3);
    expect(out[4]).toBeLessThan(5);
    expect(ema([], 9)).toEqual([]);
  });

  it('geometry stays inside the box', () => {
    const bars = seedCandles(30, 1.2, seededRandom(11));
    const g = chartGeometry(bars, 600, 300, 16);
    expect(g.bodies).toHaveLength(30);
    for (const b of g.bodies) {
      expect(b.y).toBeGreaterThanOrEqual(15.99);
      expect(b.y + b.h).toBeLessThanOrEqual(284.01);
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.x + b.w).toBeLessThanOrEqual(600);
    }
    expect(g.lastY).toBeGreaterThan(0);
    expect(g.lastY).toBeLessThan(1);
    expect(g.emaPath.startsWith('M')).toBe(true);
    expect(chartGeometry([], 10, 10).bodies).toEqual([]);
  });

  it('ladder has asks above bids, best prices adjacent', () => {
    const rows = ladder(1.1, seededRandom(5));
    expect(rows).toHaveLength(10);
    expect(rows.slice(0, 5).every((r) => r.side === 'ask')).toBe(true);
    expect(rows.slice(5).every((r) => r.side === 'bid')).toBe(true);
    for (let i = 1; i < rows.length; i++) expect(rows[i].price).toBeLessThan(rows[i - 1].price);
  });

  it('stages cycle through every step and back to idle', () => {
    let s = 0;
    const seen = [s];
    for (let i = 0; i < ORDER_STAGES.length + 1; i++) seen.push((s = nextStage(s)));
    expect(seen.at(-1)).toBe(0);
    expect(Math.max(...seen)).toBe(ORDER_STAGES.length);
  });

  it('primary call to action follows sign-up availability', () => {
    expect(primaryCta({ available: true })).toEqual({
      label: 'Start free',
      route: '/signup',
      kind: 'signup',
    });
    // Sign-up off or unavailable: still a way in — /signup then asks for access.
    expect(primaryCta({ available: false }).route).toBe('/signup');
    expect(primaryCta(null)).toEqual({ label: 'Get started', route: '/signup', kind: 'request' });
  });
});
