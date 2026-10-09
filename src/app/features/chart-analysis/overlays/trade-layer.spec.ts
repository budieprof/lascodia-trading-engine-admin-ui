import { describe, expect, it } from 'vitest';
import type { OrderDto } from '@core/api/api.types';
import {
  closedTradeMarkers,
  concernsSymbol,
  orderLines,
  pnlText,
  positionLines,
  positionPnl,
  type ChartPosition,
} from './trade-layer';

const PIP = 0.0001;

const position = (over: Partial<ChartPosition> = {}): ChartPosition =>
  ({
    id: 1,
    tradingAccountId: 17,
    symbol: 'EURUSD',
    direction: 'Long',
    openLots: 0.5,
    tradedLots: 0.5,
    pnlUnreconciledAt: null,
    averageEntryPrice: 1.09,
    currentPrice: 1.091,
    unrealizedPnL: 50,
    realizedPnL: 0,
    stopLoss: 1.0895,
    takeProfit: 1.092,
    status: 'Open',
    isPaper: false,
    trailingStopLevel: null,
    brokerPositionId: null,
    openedAt: '2026-10-08T10:15:00Z',
    closedAt: null,
    signalGeneratedAt: null,
    originalStopLoss: null,
    bumpedAt: null,
    bumpedSpread: null,
    bumpedSlSnapshot: null,
    bumpReason: null,
    initialStopLoss: 1.088,
    closePrice: null,
    ...over,
  }) as ChartPosition;

const inScope = (id: number | null | undefined) => id === 17;

describe('positionPnl — live P&L in pips, R and money (CC-I3)', () => {
  it('reads a long at the bid, R against the stop it opened with, money scaled from the engine', () => {
    const pnl = positionPnl(position(), { bid: 1.0915, ask: 1.0916 }, PIP);
    expect(pnl.pips).toBeCloseTo(15, 9);
    expect(pnl.r).toBeCloseTo(0.75, 9); // 15 pips over a 20-pip opening risk
    expect(pnl.money).toBeCloseTo(75, 9); // the engine read 50 at +10 pips
  });

  it('reads a short at the ask: the spread is a cost, not a gift', () => {
    const short = position({
      direction: 'Short',
      averageEntryPrice: 1.09,
      initialStopLoss: 1.092,
      currentPrice: 1.089,
      unrealizedPnL: 50,
    });
    const pnl = positionPnl(short, { bid: 1.089, ask: 1.0892 }, PIP);
    expect(pnl.pips).toBeCloseTo(8, 9);
    expect(pnl.r).toBeCloseTo(0.4, 9);
  });

  it('has no R without an opening stop and no money from a reading at the entry', () => {
    const p = position({ initialStopLoss: null, currentPrice: 1.09, unrealizedPnL: 0 });
    const pnl = positionPnl(p, { bid: 1.091, ask: null }, PIP);
    expect(pnl.r).toBeNull();
    expect(pnl.money).toBeNull();
  });

  it('prints pips, R and money with signs', () => {
    expect(pnlText({ pips: -3.24, r: -0.16, money: -16.2 }, 'USD')).toBe(
      '−3.2 pips · −0.16R · ≈ −16.20 USD',
    );
    expect(pnlText({ pips: 15, r: null, money: null }, null)).toBe('+15.0 pips');
  });
});

describe('positionLines / orderLines — the lines of this symbol and account only (CC-09, CC-10)', () => {
  it('labels a long LONG — the old page read Long/Short as Buy/Sell and labelled every position SHORT', () => {
    const lines = positionLines([position()], 'EURUSD', inScope, null, PIP, () => 'USD');
    expect(lines.map((l) => [l.kind, l.label])).toEqual([
      ['entry', 'LONG 0.50'],
      ['stop', 'SL'],
      ['target', 'TP'],
    ]);
    expect(lines[0].color).toBe('#26A69A');
  });

  it('drops another symbol and another account, marks paper, carries the live P&L', () => {
    const lines = positionLines(
      [
        position({ symbol: 'GBPUSD' }),
        position({ tradingAccountId: 99 }),
        position({ isPaper: true }),
      ],
      'EURUSD',
      inScope,
      { bid: 1.0915, ask: 1.0916 },
      PIP,
      () => 'USD',
    );
    const entries = lines.filter((l) => l.kind === 'entry');
    expect(entries).toHaveLength(1);
    expect(entries[0].label).toBe('PAPER LONG 0.50');
    expect(entries[0].pnl).toBe('+15.0 pips · +0.75R · ≈ +75.00 USD');
    expect(entries[0].pnlUp).toBe(true);
  });

  it('draws only working orders', () => {
    const order = (status: string): OrderDto =>
      ({
        id: 1,
        tradingAccountId: 17,
        symbol: 'EURUSD',
        orderType: 'Buy',
        executionType: 'Limit',
        quantity: 0.2,
        price: 1.085,
        stopLoss: 1.083,
        takeProfit: null,
        status,
      }) as unknown as OrderDto;
    const lines = orderLines(
      [order('Pending'), order('Filled'), order('Cancelled')],
      'EURUSD',
      inScope,
    );
    expect(lines.map((l) => l.label)).toEqual(['LIMIT BUY 0.2', 'O·SL']);
  });
});

describe('closedTradeMarkers — fills of closed trades, paper apart (CC-I3)', () => {
  it('marks the entry and the exit with its result in pips', () => {
    const closed = position({
      status: 'Closed',
      closedAt: '2026-10-08T14:40:00Z',
      closePrice: 1.0912,
      realizedPnL: 60,
    });
    const [entry, exit] = closedTradeMarkers([closed], 'EURUSD', inScope, PIP);
    expect(entry).toMatchObject({
      time: Date.parse('2026-10-08T10:15:00Z'),
      position: 'belowBar',
      shape: 'arrowUp',
      text: 'Buy 1.09',
    });
    expect(exit).toMatchObject({
      time: Date.parse('2026-10-08T14:40:00Z'),
      position: 'aboveBar',
      color: '#26A69A',
      text: 'exit +12.0p',
    });
  });

  it('paints paper trades purple and says so; an unknown close price leaves the pips out', () => {
    const paper = position({ isPaper: true, closedAt: '2026-10-08T14:40:00Z', closePrice: null });
    const [entry, exit] = closedTradeMarkers([paper], 'EURUSD', inScope, PIP);
    expect(entry.color).toBe('#7E57C2');
    expect(entry.text).toBe('paper Buy 1.09');
    expect(exit.text).toBe('paper exit');
  });
});

describe('concernsSymbol', () => {
  it('keeps events of this symbol and events that name none', () => {
    expect(concernsSymbol({ symbol: 'eurusd' }, 'EURUSD')).toBe(true);
    expect(concernsSymbol({ symbol: 'GBPUSD' }, 'EURUSD')).toBe(false);
    expect(concernsSymbol({ positionId: 3 }, 'EURUSD')).toBe(true);
    expect(concernsSymbol(null, 'EURUSD')).toBe(true);
  });
});
