import { describe, expect, it } from 'vitest';

import { hasExcursions, legacyTradeRows, legacyTradesCsv } from './legacy-trades';

describe('legacy trade rows (U11)', () => {
  const trades = [
    {
      Direction: 0,
      EntryTime: '2026-01-02T10:00:00',
      ExitTime: '2026-01-02T14:00:00',
      EntryPrice: 1.1,
      ExitPrice: 1.102,
      LotSize: 0.1,
      PnL: 20,
      RiskedAmount: 10,
      MaxFavorableExcursion: 30,
      MaxAdverseExcursion: 5,
      BarsInTrade: 4,
      ExitReason: 1,
    },
    { Direction: 1, EntryTime: 'a', ExitTime: 'b', PnL: -8, RMultiple: -0.8, ExitReason: 3 },
  ];

  it('reads R, the excursions in money and in R, and the exit reason in words', () => {
    const [a, b] = legacyTradeRows(trades);
    expect(a.r).toBe(2);
    expect(a.mfe).toBe(30);
    expect(a.maeR).toBe(0.5);
    expect(a.exitReason).toBe('Take profit');
    expect(b.direction).toBe('Short');
    expect(b.r).toBe(-0.8);
    // never invented: an older run without excursions leaves them empty
    expect(b.mfe).toBeNull();
    expect(b.mfeR).toBeNull();
    expect(b.exitReason).toBe('Trailing stop');
  });

  it('knows whether the run recorded excursions at all', () => {
    expect(hasExcursions(legacyTradeRows(trades))).toBe(true);
    expect(hasExcursions(legacyTradeRows([trades[1]]))).toBe(false);
  });

  it('writes every row and leaves unknown cells empty', () => {
    const csv = legacyTradesCsv(legacyTradeRows(trades));
    const lines = csv.replace('﻿', '').trim().split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('MFE (R)');
    expect(lines[1]).toContain(',2,30,5,3,0.5,4,Take profit');
    expect(lines[2]).toContain(',-0.8,,,,,,Trailing stop');
  });
});
