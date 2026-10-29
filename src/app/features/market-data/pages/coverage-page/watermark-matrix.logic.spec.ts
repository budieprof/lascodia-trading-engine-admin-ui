import { describe, expect, it } from 'vitest';

import { ageText, watermarkMatrix } from './watermark-matrix.logic';

describe('watermarkMatrix', () => {
  it('builds symbol rows with per-timeframe freshness, current first', () => {
    const now = Date.parse('2026-10-28T23:00:00Z');
    const m = watermarkMatrix(
      [
        { symbol: 'AUDNZD', timeframe: 'M1', latestTimestamp: '2026-06-18T07:49:00Z' },
        ...['M1', 'M5', 'M15', 'H1', 'H4', 'D1'].map((tf) => ({
          symbol: 'EURUSD',
          timeframe: tf,
          latestTimestamp: tf === 'D1' ? '2026-10-27T00:00:00Z' : '2026-10-28T22:55:00Z',
        })),
      ],
      now,
    );
    expect(m.map((r) => r.symbol)).toEqual(['EURUSD', 'AUDNZD']);
    expect(m[0].current).toBe(true);
    expect(m[1].cells['M1'].fresh).toBe(false);
    expect(m[1].cells['H1'].latest).toBeNull();
    expect(ageText(m[0].cells['M1'].ageMinutes)).toBe('5 min');
    expect(ageText(3000)).toBe('2 d');
  });
});
