import { describe, expect, it } from 'vitest';
import { BEHAVIORS } from './fib-gann';
import {
  FIB_LEVELS_TV,
  extensionPrice,
  gannAngleLabel,
  gannSlope,
  hitScene,
  emptyScene,
  levelText,
  levelsOf,
  retracementPrice,
  timezoneBars,
} from './fib-gann-core';

describe('fib retracement math', () => {
  it('puts 0 at the second anchor and 1 at the first', () => {
    expect(retracementPrice(1.1, 1.2, 0)).toBeCloseTo(1.2);
    expect(retracementPrice(1.1, 1.2, 1)).toBeCloseTo(1.1);
    expect(retracementPrice(1.1, 1.2, 0.618)).toBeCloseTo(1.2 - 0.1 * 0.618);
  });
  it('reverse swaps the ends', () => {
    expect(retracementPrice(1.1, 1.2, 0, true)).toBeCloseTo(1.1);
    expect(retracementPrice(1.1, 1.2, 1.618, true)).toBeCloseTo(1.1 + 0.1 * 1.618);
  });
});

describe('trend-based extension math', () => {
  it('projects the p1→p2 move from p3', () => {
    expect(extensionPrice(1.0, 1.2, 1.1, 0)).toBeCloseTo(1.1);
    expect(extensionPrice(1.0, 1.2, 1.1, 1)).toBeCloseTo(1.3);
    expect(extensionPrice(1.0, 1.2, 1.1, 1.618)).toBeCloseTo(1.1 + 0.2 * 1.618);
    expect(extensionPrice(1.0, 1.2, 1.1, 1, true)).toBeCloseTo(0.9);
  });
});

describe('time zones', () => {
  it('lands on Fibonacci bar counts', () => {
    expect(timezoneBars(1, [0, 1, 2, 3, 5, 8, 13])).toEqual([0, 1, 2, 3, 5, 8, 13]);
    expect(timezoneBars(4, [0, 1, 2, 3, 5])).toEqual([0, 4, 8, 12, 20]);
  });
});

describe('gann angles', () => {
  it('scales slope by ratio and labels 1/8 … 8/1', () => {
    expect(gannSlope(1, 0.001)).toBeCloseTo(0.001);
    expect(gannSlope(8, 0.001)).toBeCloseTo(0.008);
    expect(gannSlope(1 / 8, 0.008)).toBeCloseTo(0.001);
    expect([8, 4, 3, 2, 1, 1 / 2, 1 / 3, 1 / 4, 1 / 8].map(gannAngleLabel)).toEqual([
      '8/1', '4/1', '3/1', '2/1', '1/1', '1/2', '1/3', '1/4', '1/8',
    ]);
  });
});

describe('defaults', () => {
  it('uses TV retracement colours', () => {
    const vis = FIB_LEVELS_TV.filter((l) => l.visible).map((l) => [l.value, l.color]);
    expect(vis).toEqual([
      [0, '#787B86'], [0.236, '#F23645'], [0.382, '#FF9800'], [0.5, '#4CAF50'], [0.618, '#089981'],
      [0.786, '#00BCD4'], [1, '#787B86'], [1.618, '#2962FF'], [2.618, '#F23645'], [3.618, '#9C27B0'], [4.236, '#E91E63'],
    ]);
  });
  it('every tool exposes a levels option or is a non-level tool', () => {
    const kinds = Object.keys(BEHAVIORS);
    expect(kinds).toHaveLength(18);
    for (const k of kinds) {
      const b = BEHAVIORS[k as keyof typeof BEHAVIORS]!;
      expect(typeof b.paint).toBe('function');
      for (const o of b.options ?? []) {
        if (o.type === 'levels') for (const l of o.default) expect(l).toEqual({ value: expect.any(Number), color: expect.stringMatching(/^#/), visible: expect.any(Boolean) });
      }
    }
    expect(BEHAVIORS['fib-extension']!.points).toBe(3);
    expect(BEHAVIORS['fib-retracement']!.points).toBe(2);
  });
  it('levelsOf hides invisible levels and honours one-colour', () => {
    const l = levelsOf({ useOneColor: true, oneColor: '#000000' }, FIB_LEVELS_TV);
    expect(l).toHaveLength(11);
    expect(new Set(l.map((x) => x.color))).toEqual(new Set(['#000000']));
  });
  it('formats labels like TV', () => {
    expect(levelText(0.618, 1.123456, {}, 5)).toBe('0.618 (1.12346)');
    expect(levelText(0.618, 1.1, { showLevels: 'percent', showPrices: false }, 5)).toBe('61.8%');
  });
});

describe('hit test', () => {
  it('hits lines and arcs', () => {
    const s = emptyScene();
    s.lines.push({ a: { x: 0, y: 0 }, b: { x: 100, y: 0 }, color: '#000', width: 1 });
    s.arcs.push({ c: { x: 200, y: 200 }, rx: 50, ry: 50, start: Math.PI, end: Math.PI * 2, color: '#000', width: 1 });
    expect(hitScene(s, { x: 50, y: 3 }, 6)).toBe(true);
    expect(hitScene(s, { x: 200, y: 150 }, 6)).toBe(true); // top of arc
    expect(hitScene(s, { x: 200, y: 250 }, 6)).toBe(false); // other half
  });
});
