import { describe, expect, it } from 'vitest';
import { xAtLogical, type LogicalScale } from './time-x';

/**
 * Lightweight Charts 5.2 as it behaves in a browser (checked 2026-10-09): whole indexes map
 * linearly — on screen, past the last bar, before the first — and a fractional index reads 0.
 */
const scale: LogicalScale = {
  logicalToCoordinate: (l) => (Number.isInteger(l) ? 828 - (1500 - l) * 6 : 0),
  options: () => ({ barSpacing: 6 }),
};

describe('xAtLogical — between bars (CC-I2, CC-I9)', () => {
  it('is the whole index’s x plus the fraction of a bar', () => {
    expect(xAtLogical(scale, 1495)).toBe(798);
    expect(xAtLogical(scale, 1495.5)).toBe(801);
    expect(xAtLogical(scale, 1499.25)).toBe(823.5);
  });

  it('works past the last bar and before the first', () => {
    expect(xAtLogical(scale, 1503.5)).toBe(849);
    expect(xAtLogical(scale, -2.5)).toBe(828 - 1503 * 6 + 3);
  });

  it('has no x without a scale answer or a number', () => {
    expect(
      xAtLogical({ logicalToCoordinate: () => null, options: () => ({ barSpacing: 6 }) }, 3),
    ).toBeNull();
    expect(xAtLogical(scale, Number.NaN)).toBeNull();
  });
});
