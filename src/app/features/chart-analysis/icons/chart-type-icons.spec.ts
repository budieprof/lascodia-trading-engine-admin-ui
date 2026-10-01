import { describe, expect, it } from 'vitest';

import { CHART_TYPE_ICONS } from './chart-type-icons';

const COORD_ATTRS = /\b(?:d|x|y|x1|y1|x2|y2|cx|cy|points)="([^"]*)"/g;

describe('CHART_TYPE_ICONS', () => {
  const KEYS = [
    'candles',
    'hollow',
    'heikin-ashi',
    'bars',
    'hlc-bars',
    'hilo',
    'vol-candle',
    'line',
    'line-markers',
    'stepline',
    'area',
    'hlc-area',
    'baseline',
    'column',
    'renko',
    'line-break',
    'kagi',
    'pnf',
    'range',
    'tpo',
    'session-vp',
  ];

  it('has a non-empty icon for every chart style and nothing else', () => {
    expect(KEYS.filter((k) => !CHART_TYPE_ICONS[k]?.trim())).toEqual([]);
    expect(Object.keys(CHART_TYPE_ICONS).sort()).toEqual([...KEYS].sort());
  });

  it.each(Object.entries(CHART_TYPE_ICONS))('%s parses as SVG markup', (_kind, markup) => {
    const doc = new DOMParser().parseFromString(
      `<svg xmlns="http://www.w3.org/2000/svg">${markup}</svg>`,
      'image/svg+xml',
    );
    expect(doc.getElementsByTagName('parsererror').length).toBe(0);
    expect(doc.documentElement.children.length).toBeGreaterThan(0);
    expect(markup).not.toMatch(/<svg|xmlns/);
  });

  it.each(Object.entries(CHART_TYPE_ICONS))('%s uses only currentColor', (_kind, markup) => {
    expect(markup).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
    for (const m of markup.matchAll(/\b(?:fill|stroke)="([^"]*)"/g)) {
      expect(['currentColor', 'none']).toContain(m[1]);
    }
  });

  it.each(Object.entries(CHART_TYPE_ICONS))('%s stays on the 28×28 grid', (_kind, markup) => {
    for (const m of markup.matchAll(COORD_ATTRS)) {
      for (const num of m[1].match(/-?\d*\.?\d+/g) ?? []) {
        const v = Number(num);
        // Relative path deltas may be negative; magnitudes never exceed the grid.
        expect(Math.abs(v)).toBeLessThanOrEqual(28);
        if (m[0].startsWith('d=') === false) expect(v).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
