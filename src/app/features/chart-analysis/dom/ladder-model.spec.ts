import { describe, expect, it } from 'vitest';

import { BookState } from '@core/realtime/md-book';
import {
  addTicks,
  buildLadder,
  centreIndexFor,
  dropProblem,
  ladderBrackets,
  ladderIntent,
  needsRecentre,
  ocoPairProblem,
  pipSizeOf,
  pointSize,
  rowIndex,
  rowPrice,
  type LadderOrder,
} from './ladder-model';
import { fxSessionStart, ladderOrdersFrom, ladderPositionsFrom, movedLevels } from './ladder-orders';
import type { AccountStrip } from '../panels/side/chart-panels.types';
import type { OcoGroup } from '../trading/manual-trading.types';

const PT = 0.00001;

describe('the ladder reads the shared hub book', () => {
  it('takes the core BookState (S/D folded by the stream service) as it is', () => {
    const book = new BookState();
    book.apply({ t: 1, k: 'S', b: [[1.1, 5], [1.09999, 3]], a: [[1.10002, 4]] });
    book.apply({ t: 2, k: 'D', b: [[1.1, 0]], a: [] });
    const rows = buildLadder({ rowSize: PT, centerIndex: 110000, halfRows: 2 }, 5, book, [], [], new Map(), PT);
    expect(rows.find((r) => r.price === 1.1)!.bidSize).toBe(0);
    expect(rows.find((r) => r.price === 1.09999)).toMatchObject({ bidSize: 3, bestBid: true });
    expect(rows.find((r) => r.price === 1.10002)).toMatchObject({ askSize: 4, bestAsk: true });
  });
});

describe('the ladder grid', () => {
  it('points and pips by digits', () => {
    expect(pointSize(5)).toBeCloseTo(0.00001);
    expect(pipSizeOf(5)).toBeCloseTo(0.0001);
    expect(pipSizeOf(3)).toBeCloseTo(0.01);
    expect(pipSizeOf(2)).toBeCloseTo(0.01);
  });

  it('maps prices to stable rows (binary floats do not split a price across rows)', () => {
    expect(rowIndex(1.10003, PT)).toBe(110003);
    expect(rowIndex(1.1 + 0.00003, PT)).toBe(110003);
    expect(rowPrice(110003, PT, 5)).toBe(1.10003);
    expect(rowIndex(1.10049, PT * 10)).toBe(11004);
  });

  it('centres on the mid and asks to re-centre once the market leaves the middle', () => {
    expect(centreIndexFor(1.1, 1.10002, PT)).toBe(110001);
    expect(centreIndexFor(null, null, PT)).toBeNull();
    const grid = { rowSize: PT, centerIndex: 110000, halfRows: 20 };
    expect(needsRecentre(grid, 1.10005, 1.10007)).toBe(false);
    expect(needsRecentre(grid, 1.10019, 1.10021)).toBe(true);
  });

  it('rows carry book sizes, best prices, the spread, my orders, my position and the session ticks', () => {
    const book = new BookState();
    book.apply({ t: 1, k: 'S', b: [[1.1, 2_000_000], [1.09998, 1_000_000]], a: [[1.10003, 500_000]] });
    const order: LadderOrder = {
      id: 7, isSignal: false, direction: 'Buy', price: 1.09998, lots: 0.1, stopLoss: null, takeProfit: null,
      kind: 'Limit', status: 'Submitted', ocoGroupId: null,
    };
    const ticks = new Map<number, number>();
    addTicks(ticks, [1.1, 1.1, 1.10001], PT);
    const rows = buildLadder(
      { rowSize: PT, centerIndex: 110001, halfRows: 4 },
      5,
      book,
      [order],
      [{ direction: 'Sell', price: 1.10003, lots: 0.2 }],
      ticks,
      PT,
    );
    expect(rows).toHaveLength(9);
    expect(rows[0].price).toBe(1.10005);
    expect(rows.at(-1)!.price).toBe(1.09997);
    const at = (p: number) => rows.find((r) => r.price === p)!;
    expect(at(1.1)).toMatchObject({ bidSize: 2_000_000, bestBid: true, bidShare: 1, ticks: 2 });
    expect(at(1.10003)).toMatchObject({ askSize: 500_000, bestAsk: true, askShare: 0.25 });
    expect(at(1.10003).positions).toHaveLength(1);
    expect(at(1.10001)).toMatchObject({ inSpread: true, ticks: 1, tickShare: 0.5 });
    expect(at(1.09998).buys.map((o) => o.id)).toEqual([7]);
  });

  it('aggregates book levels and ticks into wider rows', () => {
    const book = new BookState();
    book.apply({ t: 1, k: 'S', b: [[1.10001, 1], [1.10004, 2]], a: [[1.10012, 5]] });
    const ticks = new Map<number, number>();
    addTicks(ticks, [1.10001, 1.10009], PT);
    const rows = buildLadder({ rowSize: PT * 10, centerIndex: 11000, halfRows: 2 }, 5, book, [], [], ticks, PT);
    const r = rows.find((x) => x.index === 11000)!;
    expect(r.bidSize).toBe(3);
    expect(r.ticks).toBe(2);
    expect(rows.find((x) => x.index === 11001)!.askSize).toBe(5);
  });
});

describe('what a ladder click means', () => {
  const bid = 1.1;
  const ask = 1.10002;

  it('bid column = buy limit below the ask, ask column = sell limit above the bid', () => {
    expect(ladderIntent('bid', 1.0999, bid, ask, false)).toEqual({ direction: 'Buy', kind: 'Limit', price: 1.0999 });
    expect(ladderIntent('ask', 1.1003, bid, ask, false)).toEqual({ direction: 'Sell', kind: 'Limit', price: 1.1003 });
  });

  it('Shift = stops: the ask column a buy stop above the ask, the bid column a sell stop below the bid', () => {
    expect(ladderIntent('ask', 1.1003, bid, ask, true)).toEqual({ direction: 'Buy', kind: 'Stop', price: 1.1003 });
    expect(ladderIntent('bid', 1.0999, bid, ask, true)).toEqual({ direction: 'Sell', kind: 'Stop', price: 1.0999 });
  });

  it('a price on the wrong side is refused with the reason, never silently the other kind', () => {
    expect(ladderIntent('bid', 1.1003, bid, ask, false)).toHaveProperty('problem');
    expect(ladderIntent('ask', 1.0999, bid, ask, false)).toHaveProperty('problem');
    expect(ladderIntent('ask', 1.0999, bid, ask, true)).toHaveProperty('problem');
    expect(ladderIntent('bid', 1.1003, bid, ask, true)).toHaveProperty('problem');
    expect(ladderIntent('bid', 1.0999, null, ask, false)).toHaveProperty('problem');
  });

  it('a dragged order keeps its side of the market', () => {
    expect(dropProblem({ direction: 'Buy', kind: 'Limit' }, 1.0999, bid, ask)).toBeNull();
    expect(dropProblem({ direction: 'Buy', kind: 'Limit' }, 1.1003, bid, ask)).not.toBeNull();
    expect(dropProblem({ direction: 'Sell', kind: 'Stop' }, 1.0999, bid, ask)).toBeNull();
    expect(dropProblem({ direction: 'Sell', kind: 'Stop' }, 1.1003, bid, ask)).not.toBeNull();
  });

  it('brackets from the ATR and the ticket defaults', () => {
    expect(ladderBrackets('Buy', 1.1, 0.001, { stopAtr: 1.5, targetR: 2 }, 5)).toEqual({ stopLoss: 1.0985, takeProfit: 1.103 });
    expect(ladderBrackets('Sell', 1.1, 0.001, { stopAtr: 1.5, targetR: 0 }, 5)).toEqual({ stopLoss: 1.1015, takeProfit: null });
    expect(ladderBrackets('Buy', 1.1, null, { stopAtr: 1.5, targetR: 2 }, 5)).toBeNull();
  });

  it('an OCO pair is one buy and one sell at different prices', () => {
    const buy = { direction: 'Buy' as const, kind: 'Stop' as const, price: 1.101 };
    const sell = { direction: 'Sell' as const, kind: 'Stop' as const, price: 1.099 };
    expect(ocoPairProblem(buy, sell)).toBeNull();
    expect(ocoPairProblem(buy, { ...buy, price: 1.102 })).toContain('one buy and one sell');
  });
});

describe('my orders on the ladder', () => {
  const strip = {
    tradingAccountIds: [17],
    symbol: 'EURUSD',
    positionsOnSymbol: [
      { id: 1, tradingAccountId: 17, symbol: 'EURUSD', direction: 'Long', lots: 0.3, entryPrice: 1.098, stopLoss: null, takeProfit: null, unrealizedPnl: 0, isPaper: false, openedAt: '' },
      { id: 2, tradingAccountId: 17, symbol: 'EURUSD', direction: 'Short', lots: 0.1, entryPrice: 1.2, stopLoss: null, takeProfit: null, unrealizedPnl: 0, isPaper: true, openedAt: '' },
    ],
    ordersOnSymbol: [
      { id: 601, tradingAccountId: 17, symbol: 'EURUSD', side: 'Buy', executionType: 'Limit', status: 'Submitted', lots: 0.2, price: 1.095, stopLoss: 1.09, takeProfit: 1.105, tradeSignalId: 901, createdAt: '' },
      { id: 602, tradingAccountId: 17, symbol: 'EURUSD', side: 'Sell', executionType: 'Limit', status: 'Filled', lots: 0.2, price: 1.105, stopLoss: null, takeProfit: null, tradeSignalId: null, createdAt: '' },
    ],
    signalsOnSymbol: [
      { id: 901, strategyId: 3, strategyName: null, symbol: 'EURUSD', direction: 'Buy', status: 'Executed', entryPrice: 1.095, stopLoss: 1.09, takeProfit: 1.105, isManual: true, generatedAt: '', expiresAt: '' },
      { id: 902, strategyId: 3, strategyName: null, symbol: 'EURUSD', direction: 'Sell', status: 'Approved', entryPrice: 1.105, stopLoss: 1.11, takeProfit: 1.095, isManual: true, generatedAt: '', expiresAt: '' },
      { id: 903, strategyId: 4, strategyName: 'auto', symbol: 'EURUSD', direction: 'Sell', status: 'Pending', entryPrice: 1.106, stopLoss: 1.11, takeProfit: 1.095, isManual: false, generatedAt: '', expiresAt: '' },
    ],
  } as unknown as AccountStrip;
  const pair = {
    id: 12,
    legs: [
      { leg: 1, tradeSignalId: 901, orderId: 601 },
      { leg: 2, tradeSignalId: 902, orderId: null },
    ],
  } as unknown as OcoGroup;

  it('working orders and my unplaced manual signals, each linked to its OCO pair', () => {
    const orders = ladderOrdersFrom(strip, [pair]);
    expect(orders.map((o) => [o.id, o.isSignal, o.direction, o.ocoGroupId])).toEqual([
      [601, false, 'Buy', 12],
      [902, true, 'Sell', 12],
    ]);
  });

  it('positions: real ones only (paper trades are not at the broker)', () => {
    expect(ladderPositionsFrom(strip)).toEqual([{ direction: 'Buy', price: 1.098, lots: 0.3 }]);
  });

  it('a moved order keeps its shape', () => {
    expect(movedLevels({ price: 1.095, stopLoss: 1.09, takeProfit: 1.105 }, 1.096, 5)).toEqual({
      price: 1.096,
      stopLoss: 1.091,
      takeProfit: 1.106,
    });
  });

  it('the FX session starts at 17:00 New York', () => {
    // 2026-10-23 12:00 UTC = 08:00 EDT → the session began 2026-10-22 17:00 EDT = 21:00 UTC.
    expect(new Date(fxSessionStart(Date.UTC(2026, 9, 23, 12, 0))).toISOString()).toBe('2026-10-22T21:00:00.000Z');
    // 22:30 UTC = 18:30 EDT → it began at 21:00 UTC the same day.
    expect(new Date(fxSessionStart(Date.UTC(2026, 9, 23, 22, 30))).toISOString()).toBe('2026-10-23T21:00:00.000Z');
    // Winter (EST, UTC-5): 2026-12-01 12:00 UTC → 2026-11-30 22:00 UTC.
    expect(new Date(fxSessionStart(Date.UTC(2026, 11, 1, 12, 0))).toISOString()).toBe('2026-11-30T22:00:00.000Z');
  });
});
