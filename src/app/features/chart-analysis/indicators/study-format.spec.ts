import { describe, expect, it } from 'vitest';
import { digitsFormat, legendDigitsFormat, studyDigits } from './study-format';

describe('study decimals by instrument (UA10)', () => {
  it('FX is unchanged: no override, the legend keeps 1.2-5', () => {
    expect(
      studyDigits({ overlay: false, precision: 5, isFx: true, values: [[0.00012, -0.0003]] }),
    ).toBeNull();
    expect(studyDigits({ overlay: true, precision: 3, isFx: true })).toBeNull();
    expect(legendDigitsFormat(null)).toBe('1.2-5');
  });

  it('BTC-USD MACD (≈ ±1000) prints 2 decimals, not -106.04026 on a -1000.00000 axis', () => {
    const d = studyDigits({
      overlay: false,
      precision: 2,
      isFx: false,
      values: [[-106.04026, -1000, 250], [-0.39333]],
    });
    expect(d).toBe(2);
    expect(digitsFormat(d!)).toEqual({ type: 'price', precision: 2, minMove: 0.01 });
    expect((-106.04026).toFixed(d!)).toBe('-106.04');
  });

  it('AAPL MACD (≈ 4) prints 3; a tiny oscillator keeps its significant digits; overlays the instrument precision', () => {
    expect(studyDigits({ overlay: false, precision: 2, isFx: false, values: [[4, -1.2]] })).toBe(3);
    expect(studyDigits({ overlay: false, precision: 2, isFx: false, values: [[0.0003]] })).toBe(7);
    expect(
      studyDigits({ overlay: false, precision: 2, isFx: false, values: [[null, Number.NaN]] }),
    ).toBe(2);
    expect(studyDigits({ overlay: true, precision: 2, isFx: false })).toBe(2);
    expect(studyDigits({ overlay: false, precision: 0, isFx: false, values: [[50000]] })).toBe(0);
    expect(legendDigitsFormat(3)).toBe('1.3-3');
  });
});
