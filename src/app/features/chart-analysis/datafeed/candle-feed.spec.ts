import { describe, expect, it } from 'vitest';
import type { CandleDto } from '@core/api/api.types';
import { normaliseRows, toBar } from './candle-feed.service';

function row(iso: string, o: number, h: number, l: number, c: number, v = 1): CandleDto {
  return {
    id: 0,
    symbol: 'EURUSD',
    timeframe: 'H1',
    open: o,
    high: h,
    low: l,
    close: c,
    volume: v,
    timestamp: iso,
    isClosed: true,
  };
}

describe('normaliseRows', () => {
  // The engine pages candles newest-first. Everything downstream assumes
  // ascending, and the failure mode is an inverted candle rather than an error.
  const descendingPage = [
    row('2026-09-18T12:00:00Z', 3, 3.5, 2.9, 3.2),
    row('2026-09-18T11:00:00Z', 2, 2.5, 1.9, 2.2),
    row('2026-09-18T10:00:00Z', 1, 1.5, 0.9, 1.2),
  ];

  it('flips a newest-first page into ascending bars', () => {
    const bars = normaliseRows(descendingPage, '60');
    expect(bars.map((b) => b.time)).toEqual([
      Date.parse('2026-09-18T10:00:00Z'),
      Date.parse('2026-09-18T11:00:00Z'),
      Date.parse('2026-09-18T12:00:00Z'),
    ]);
    expect(bars[0].open).toBe(1);
    expect(bars[2].close).toBe(3.2);
  });

  it('takes open from the OLDEST bar when aggregating a descending page', () => {
    // Guards the inversion directly: with a descending page fed straight to
    // aggregation, open and close swap and high/low still look plausible.
    const m15 = descendingPage.map((r) => ({ ...r, timeframe: 'M15' }));
    const [bar] = normaliseRows(
      [
        { ...m15[2], timestamp: '2026-09-18T10:15:00Z' },
        { ...m15[1], timestamp: '2026-09-18T10:00:00Z' },
      ],
      '30',
    );
    expect(bar.open).toBe(2); // the 10:00 bar's open
    expect(bar.close).toBe(1.2); // the 10:15 bar's close
  });

  it('returns nothing for an empty page', () => {
    expect(normaliseRows([], '60')).toEqual([]);
  });

  it('drops rows whose timestamp will not parse rather than emitting NaN times', () => {
    // A NaN bar time makes the library reject the whole batch silently.
    const bars = normaliseRows(
      [row('nonsense', 1, 1, 1, 1), row('2026-09-18T10:00:00Z', 2, 2, 2, 2)],
      '60',
    );
    expect(bars).toHaveLength(1);
    expect(Number.isFinite(bars[0].time)).toBe(true);
  });

  it('returns nothing for an unsupported resolution', () => {
    expect(normaliseRows(descendingPage, '3')).toEqual([]);
  });
});

describe('toBar', () => {
  it('maps the DTO onto TradingView bar fields with an epoch-ms time', () => {
    expect(toBar(row('2026-09-18T10:00:00Z', 1, 2, 0.5, 1.5, 42))).toEqual({
      time: Date.parse('2026-09-18T10:00:00Z'),
      open: 1,
      high: 2,
      low: 0.5,
      close: 1.5,
      volume: 42,
    });
  });
});
