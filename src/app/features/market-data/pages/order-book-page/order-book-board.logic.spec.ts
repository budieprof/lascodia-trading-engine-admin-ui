import { describe, expect, it } from 'vitest';

import type { OrderBookSnapshotDto } from '@core/api/api.types';
import { activeSymbols, boardRow, defaultBook, depthOf, sortBoard } from './order-book-board.logic';

const NOW = Date.parse('2026-10-28T23:00:00Z');
const snap = (symbol: string, capturedAt: string, levels: number): OrderBookSnapshotDto => ({
  id: 1,
  symbol,
  bidPrice: 1,
  askPrice: 1.0001,
  bidVolume: 1,
  askVolume: 1,
  spreadPoints: 1,
  instanceId: 'i',
  capturedAt,
  levelsJson: levels
    ? JSON.stringify({ bids: Array(levels).fill({ P: 1, V: 1 }), asks: [] })
    : null,
});

describe('order book board', () => {
  it('finds the symbols streaming M1 candles', () => {
    expect(
      activeSymbols(
        [
          { symbol: 'EURUSD', timeframe: 'M1', latestTimestamp: '2026-10-28T22:55:00Z' },
          { symbol: 'EURUSD', timeframe: 'H1', latestTimestamp: '2026-10-28T22:00:00Z' },
          { symbol: 'AUDNZD', timeframe: 'M1', latestTimestamp: '2026-06-18T07:49:00Z' },
        ],
        NOW,
      ),
    ).toEqual(['EURUSD']);
  });

  it('measures depth and age, and picks a default', () => {
    expect(depthOf('not json')).toBe(0);
    const rows = [
      boardRow('GBPUSD', snap('GBPUSD', '2026-10-28T22:59:50Z', 10), NOW),
      boardRow('EURUSD', snap('EURUSD', '2026-10-28T22:59:00Z', 20), NOW),
      boardRow('USDJPY', null, NOW),
    ];
    expect(rows[1].depth).toBe(20);
    expect(rows[0].ageSeconds).toBe(10);
    expect(sortBoard(rows).map((r) => r.symbol)).toEqual(['GBPUSD', 'EURUSD', 'USDJPY']);
    expect(defaultBook(rows)).toBe('EURUSD');
    expect(defaultBook([rows[0], rows[2]])).toBe('GBPUSD');
    expect(defaultBook([rows[2]])).toBeNull();
  });
});
