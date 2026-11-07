import { describe, expect, it } from 'vitest';

import { reportPalette } from '../report/report-charts';
import { buildConeOptions, validCone } from './monte-carlo-cone';

describe('Monte Carlo cone (U07, engine-only)', () => {
  const cone = {
    trades: [1, 2, 3],
    p5: [-1, -2, -3],
    p25: [-0.5, -1, -1.5],
    p50: [0.1, 0.2, 0.3],
    p75: [0.6, 1.2, 1.8],
    p95: [1, 2, 3],
    observed: [0.5, -0.5, 2],
  };

  it('accepts a well-formed cone and keeps the optional bands', () => {
    const c = validCone(cone)!;
    expect(c.p25).toEqual(cone.p25);
    expect(c.observed).toEqual(cone.observed);
  });

  it('refuses anything it would have to guess: missing, short, mismatched or non-finite arrays', () => {
    expect(validCone(undefined)).toBeNull();
    expect(validCone({ ...cone, trades: [1] })).toBeNull();
    expect(validCone({ ...cone, p95: [1, 2] })).toBeNull();
    expect(validCone({ ...cone, p50: [0, Number.NaN, 1] })).toBeNull();
    // An optional band of the wrong length is dropped, not stretched.
    expect(validCone({ ...cone, p25: [1] })!.p25).toBeNull();
  });

  it('draws outer + inner bands as stacked areas, the median and the run itself', () => {
    const opts = buildConeOptions(validCone(cone)!, reportPalette('dark')) as {
      series: { name: string; data: number[][] }[];
    };
    const names = opts.series.map((s) => s.name);
    expect(names).toContain('5th–95th percentile');
    expect(names).toContain('25th–75th percentile');
    expect(names).toContain('Median path');
    expect(names).toContain('This run’s order');
    const outerWidth = opts.series.find((s) => s.name === '5th–95th percentile')!.data;
    expect(outerWidth).toEqual([
      [1, 2],
      [2, 4],
      [3, 6],
    ]);
  });
});
