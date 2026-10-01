import { describe, expect, it } from 'vitest';
import { TOOLS } from '../drawings/model';
import { TOOL_ICONS } from './tool-icons';

const COORD_ATTRS = /\b(?:d|x|y|x1|y1|x2|y2|cx|cy|points)="([^"]*)"/g;

describe('TOOL_ICONS', () => {
  it('has a non-empty icon for every drawing tool', () => {
    const missing = TOOLS.filter((t) => !TOOL_ICONS[t.kind]?.trim()).map((t) => t.kind);
    expect(missing).toEqual([]);
  });

  it('has no icons for unknown kinds', () => {
    const kinds = new Set<string>(TOOLS.map((t) => t.kind));
    expect(Object.keys(TOOL_ICONS).filter((k) => !kinds.has(k))).toEqual([]);
  });

  it.each(Object.entries(TOOL_ICONS))('%s parses as SVG markup', (_kind, markup) => {
    const doc = new DOMParser().parseFromString(
      `<svg xmlns="http://www.w3.org/2000/svg">${markup}</svg>`,
      'image/svg+xml',
    );
    expect(doc.getElementsByTagName('parsererror').length).toBe(0);
    expect(doc.documentElement.children.length).toBeGreaterThan(0);
    expect(markup).not.toMatch(/<svg|xmlns/);
  });

  it.each(Object.entries(TOOL_ICONS))('%s uses only currentColor', (_kind, markup) => {
    expect(markup).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
    for (const m of markup.matchAll(/\b(?:fill|stroke)="([^"]*)"/g)) {
      expect(['currentColor', 'none']).toContain(m[1]);
    }
  });

  it.each(Object.entries(TOOL_ICONS))('%s stays on the 28×28 grid', (_kind, markup) => {
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
