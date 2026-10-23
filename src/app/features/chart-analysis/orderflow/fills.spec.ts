import { describe, expect, it } from 'vitest';

import type { ExecutionQualityLogDto, OrderDto } from '@core/api/api.types';
import type { OrderBookSnapshot } from '../panels/side/chart-panels.types';
import { joinFills, pipsToPoints, slippageKind, slippageText } from './fills';
import { bookAtHead, replayClipUtc } from './orderflow-replay';

const log = (over: Partial<ExecutionQualityLogDto> = {}): ExecutionQualityLogDto =>
  ({
    id: 1,
    orderId: 10,
    strategyId: null,
    symbol: 'EURUSD',
    session: 'London',
    requestedPrice: 1.1,
    filledPrice: 1.10012,
    slippagePips: 1.2,
    submitToFillMs: 180,
    wasPartialFill: false,
    fillRate: 1,
    recordedAt: '2026-10-20T10:00:00',
    ...over,
  }) as ExecutionQualityLogDto;

const order = (over: Partial<OrderDto> = {}): OrderDto =>
  ({ id: 10, orderType: 'Buy', tradingAccountId: 7, isPaper: false, ...over }) as OrderDto;

const FROM = Date.parse('2026-10-20T00:00:00Z');
const TO = Date.parse('2026-10-21T00:00:00Z');

describe('fills & slippage (OF-6)', () => {
  it('slippage sign: + is adverse, − is better than requested, tiny is none', () => {
    expect(slippageKind(1.2)).toBe('adverse');
    expect(slippageKind(-0.6)).toBe('favourable');
    expect(slippageKind(0.01)).toBe('none');
    expect(slippageKind(Number.NaN)).toBe('none');
  });

  it('pips to points: 10 points a pip on a 5-digit pair, 10 on a 3-digit JPY pair', () => {
    expect(pipsToPoints(1.2, 0.0001, 0.00001)).toBe(12);
    expect(pipsToPoints(-0.5, 0.01, 0.001)).toBe(-5);
    expect(pipsToPoints(1, 0, 0.00001)).toBeNaN();
  });

  it('joins logs to the orders in scope; others are hidden, not drawn', () => {
    const { fills, hidden } = joinFills(
      [
        log(),
        log({ id: 2, orderId: 11, recordedAt: '2026-10-20T09:00:00Z', slippagePips: -0.4 }),
        log({ id: 3, orderId: 99 }),
      ],
      [order(), order({ id: 11, orderType: 'Sell', isPaper: true })],
      'eurusd',
      FROM,
      TO,
      0.0001,
      0.00001,
    );
    expect(hidden).toBe(1);
    expect(fills.map((f) => f.id)).toEqual([2, 1]);
    expect(fills[1]).toMatchObject({ side: 'Buy', kind: 'adverse', slippagePoints: 12, accountId: 7 });
    expect(fills[0]).toMatchObject({ side: 'Sell', kind: 'favourable', isPaper: true });
    // A missing Z is read as UTC.
    expect(fills[1].time).toBe(Date.parse('2026-10-20T10:00:00Z'));
  });

  it('drops other symbols and fills outside the window', () => {
    const { fills, hidden } = joinFills(
      [log({ symbol: 'GBPUSD' }), log({ recordedAt: '2026-10-22T00:00:00Z' })],
      [order()],
      'EURUSD',
      FROM,
      TO,
      0.0001,
      0.00001,
    );
    expect(fills).toHaveLength(0);
    expect(hidden).toBe(0);
  });

  it('hover text', () => {
    const [f] = joinFills([log()], [order()], 'EURUSD', FROM, TO, 0.0001, 0.00001).fills;
    expect(slippageText(f)).toBe('+1.2 pips (12 pts) adverse');
    expect(slippageText({ ...f, slippagePips: -0.5, slippagePoints: -5, kind: 'favourable' })).toBe(
      '−0.5 pips (5 pts) better than requested',
    );
  });
});

describe('replay (OF-5)', () => {
  const T = Date.parse('2026-10-20T10:00:00Z');

  it('clips at the end of the newest revealed unit', () => {
    expect(replayClipUtc(null, 60_000)).toBeNull();
    expect(replayClipUtc({ time: T }, 60_000)).toBe(T + 60_000);
    expect(replayClipUtc({ time: T, closeTime: T + 4 * 3_600_000 }, 60_000)).toBe(T + 4 * 3_600_000);
    expect(replayClipUtc({ time: T }, null)).toBe(T);
  });

  const snap = (capturedAt: string): OrderBookSnapshot => ({
    id: 1,
    symbol: 'EURUSD',
    bidPrice: 1.1,
    askPrice: 1.10002,
    bidVolume: 1,
    askVolume: 1,
    spreadPoints: 2,
    levelsJson: null,
    instanceId: 'LASC-1',
    capturedAt,
  });

  it('shows only a book captured at or before the head', () => {
    expect(bookAtHead(null, T).kind).toBe('none');
    expect(bookAtHead(snap('2026-10-20T10:00:01Z'), T).kind).toBe('future');
    const at = bookAtHead(snap('2026-10-20T09:59:58Z'), T);
    expect(at).toMatchObject({ kind: 'book', ageMs: 2_000, stale: false });
    expect(bookAtHead(snap('2026-10-20T09:50:00Z'), T)).toMatchObject({ kind: 'book', stale: true });
  });
});
