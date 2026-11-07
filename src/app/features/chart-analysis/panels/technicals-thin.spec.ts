import { describe, expect, it } from 'vitest';
import { historyNeed, technicalRating as rate } from './technicals';

describe('thin history (UA05)', () => {
  it('a row the history is too short for says n/a with the bars it has and needs, and does not vote', () => {
    const bars = Array.from({ length: 87 }, (_, i) => ({
      time: i * 3_600_000,
      open: 100 + i,
      high: 101 + i,
      low: 99 + i,
      close: 100 + i,
      volume: 1,
    }));
    const r = rate(bars);
    const sma200 = r.movingAverages.votes.find((v) => v.name === 'Simple Moving Average (200)')!;
    expect(sma200.value).toBeNull();
    expect(sma200.need).toBe(200);
    expect(sma200.reason).toBe('n/a: 87 of 200 bars (not enough history to compute)');
    const sma50 = r.movingAverages.votes.find((v) => v.name === 'Simple Moving Average (50)')!;
    expect(sma50.value).not.toBeNull();
    expect(sma50.need).toBeUndefined();
    expect(r.movingAverages.buy + r.movingAverages.neutral + r.movingAverages.sell).toBe(
      r.movingAverages.votes.filter((v) => v.value !== null).length,
    );
    expect(historyNeed('Ichimoku Base Line (9, 26, 52, 26)')).toBe(78);
    expect(historyNeed('Hull Moving Average (9)')).toBe(11);
    expect(historyNeed('MACD Level (12, 26)')).toBe(26);
  });
});
