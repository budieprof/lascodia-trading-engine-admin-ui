import { describe, expect, it } from 'vitest';
import type { HitRegion } from '@shared/pine-chart/lwc/paint-drawings';
import { placeTooltip, topHit } from './script-hover';

const region = (x: number, y: number, tooltip: string, trades?: number[]): HitRegion => ({
  x,
  y,
  w: 20,
  h: 10,
  tooltip,
  ...(trades ? { trades } : {}),
});

/** A renderer that answers from fixed regions on one pane. */
const renderer = (key: string, pane: number, hits: HitRegion[]) => ({
  key,
  hitAt: (p: number, x: number, y: number) =>
    p !== pane
      ? null
      : ([...hits].reverse().find((h) => x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) ??
        null),
});

describe('topHit (PC-10)', () => {
  it('finds the region under the point, the last-added script first (it draws on top)', () => {
    const a = renderer('a', 0, [region(0, 0, 'from a')]);
    const b = renderer('b', 0, [region(5, 0, 'from b', [3])]);
    expect(topHit([a, b], 0, 10, 5)).toEqual({ key: 'b', hit: region(5, 0, 'from b', [3]) });
    expect(topHit([a, b], 0, 2, 5)?.key).toBe('a');
    expect(topHit([a, b], 0, 200, 5)).toBeNull();
  });

  it('looks only in the pane the pointer is in', () => {
    const p = renderer('p', 2, [region(0, 0, 'in the script pane')]);
    expect(topHit([p], 0, 5, 5)).toBeNull();
    expect(topHit([p], 2, 5, 5)?.hit.tooltip).toBe('in the script pane');
  });
});

describe('placeTooltip', () => {
  it('opens right and below the pointer, toward the free side near the edges', () => {
    expect(placeTooltip('t', 100, 100, 1000, 600)).toEqual({
      text: 't',
      left: 114,
      top: 114,
      flipX: false,
      flipY: false,
    });
    const corner = placeTooltip('t', 900, 550, 1000, 600);
    expect(corner).toMatchObject({ flipX: true, flipY: true, left: 886, top: 536 });
  });
});
