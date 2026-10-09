import { describe, expect, it } from 'vitest';

import { placeCanvases, scaleFor } from './chart-snapshot';

describe('chart snapshot geometry (SP-I9)', () => {
  it('places every canvas at its offset in the chart, scaled, skipping empty ones', () => {
    const container = { left: 100, top: 50, width: 800, height: 400 };
    const plan = placeCanvases(
      container,
      [
        { left: 100, top: 50, width: 740, height: 300 }, // price pane
        { left: 840, top: 50, width: 60, height: 300 }, // price axis
        { left: 100, top: 350, width: 800, height: 50 }, // time axis
        { left: 0, top: 0, width: 0, height: 0 }, // hidden
      ],
      2,
    );
    expect(plan.width).toBe(1600);
    expect(plan.height).toBe(800);
    expect(plan.items).toEqual([
      { left: 0, top: 0, width: 1480, height: 600 },
      { left: 1480, top: 0, width: 120, height: 600 },
      { left: 0, top: 600, width: 1600, height: 100 },
    ]);
  });

  it('keeps the picture at most 1600 px wide and never upscales', () => {
    expect(scaleFor(800, 2)).toBe(2);
    expect(scaleFor(1200, 2)).toBeCloseTo(1600 / 1200);
    expect(scaleFor(500, 0)).toBe(1);
  });
});
