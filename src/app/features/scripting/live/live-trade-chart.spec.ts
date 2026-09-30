import { describe, expect, it } from 'vitest';

import { normalizeStrategyReport, type ReportTrade } from '../report/strategy-report.model';
import { strategyReportFixture } from '../testing/strategy-report.fixture';
import { liveClosedTradesFixture, liveOpenTradeFixture } from '../testing/live-status.fixture';
import { normalizeLiveStatus } from './live.model';
import {
  hasTradeOrigins,
  liveChartContext,
  liveOpenTradeChart,
  liveReportTradeChart,
  liveTradeBook,
  matchLiveFill,
} from './live-trade-chart';

const report = normalizeStrategyReport(strategyReportFixture())!;
const row = (n: number): ReportTrade => report.trades.find((t) => t.number === n)!;
const ctx = liveChartContext({ symbol: null, timeframe: null }, report.meta);

/** The current engine: closed trades + origins. */
const book = liveTradeBook(
  normalizeLiveStatus({
    status: 'running',
    openTrades: [liveOpenTradeFixture()],
    closedTrades: liveClosedTradesFixture(),
    report: strategyReportFixture(),
  }),
);

/** An engine build before `closedTrades` / `origin`: open trades only, older key spellings. */
const oldBook = liveTradeBook(
  normalizeLiveStatus({
    status: 'running',
    openTrades: [
      {
        entryId: 'Long',
        direction: 'long',
        qty: 10_000,
        entryPrice: 1.17,
        entryTime: Date.UTC(2026, 0, 5, 8),
        protectedStop: 1.165,
      },
    ],
    report: strategyReportFixture(),
  }),
);

describe('liveChartContext', () => {
  it("opens on the report's symbol and timeframe (Pine '60' is H1)", () => {
    expect(ctx).toEqual({ symbol: 'EURUSD', timeframe: 'H1' });
  });

  it("prefers the strategy's own symbol / timeframe", () => {
    expect(liveChartContext({ symbol: 'gbp/usd', timeframe: 'M15' }, report.meta)).toEqual({
      symbol: 'GBPUSD',
      timeframe: 'M15',
    });
  });
});

describe('liveReportTradeChart', () => {
  it('takes SL/TP and the origin of a closed row from the matching closed trade', () => {
    const chart = liveReportTradeChart(row(1), book, ctx)!;
    expect(chart.origin).toBe('warmup');
    const s = chart.selection;
    expect(s.title).toBe(
      'Live session · trade #1 · Warm-up replay · EURUSD · Long · exited on take profit',
    );
    expect([s.stopLoss, s.takeProfit]).toEqual([1.0262, 1.0365]);
    expect([s.exitPrice, s.exitTime]).toEqual([1.0365, '2025-01-08T14:00:00.000Z']);
    expect(s.referenceTime).toBe('2025-01-06T10:00:00.000Z');
    expect(s.timeframe).toBe('H1');
    expect(s.action).toBeNull();
    expect(s.editable).toBeNull();
  });

  it('names paper and live trades', () => {
    expect(liveReportTradeChart(row(5), book, ctx)!.selection.title).toBe(
      'Live session · trade #5 · Paper · EURUSD · Long · exited on trailing stop',
    );
    const live = liveReportTradeChart(row(6), book, ctx)!;
    expect(live.origin).toBe('live');
    expect(live.selection.title).toBe('Live session · trade #6 · Live · EURUSD · Short');
    expect([live.selection.stopLoss, live.selection.takeProfit]).toEqual([1.146, 1.13]);
  });

  it('charts an open row from the open trades: current zones, no exit, runs to now', () => {
    const chart = liveReportTradeChart(row(7), book, ctx)!;
    expect(chart.origin).toBe('paper');
    const s = chart.selection;
    expect(s.title).toBe('Live session · trade #7 · Paper · EURUSD · Long · open');
    expect([s.stopLoss, s.takeProfit]).toEqual([1.165, 1.18]);
    expect([s.exitPrice, s.exitTime]).toEqual([null, null]);
  });

  it('never borrows a closed trade for an open row, or the other way round', () => {
    expect(matchLiveFill(row(7), { closed: book.closed, open: [] })).toBeUndefined();
    expect(matchLiveFill(row(1), { closed: [], open: book.open })).toBeUndefined();
  });

  it('degrades on an older engine: no zones, origin unknown, the exit still from the row', () => {
    expect(hasTradeOrigins(oldBook)).toBe(false);
    expect(hasTradeOrigins(book)).toBe(true);
    const chart = liveReportTradeChart(row(2), oldBook, ctx)!;
    expect(chart.origin).toBeNull();
    const s = chart.selection;
    expect(s.title).toBe(
      'Live session · trade #2 · Origin unknown · EURUSD · Short · exited on stop loss',
    );
    expect([s.stopLoss, s.takeProfit]).toEqual([null, null]);
    expect([s.exitPrice, s.exitTime]).toEqual([1.034, '2025-01-16T12:00:00.000Z']);
  });

  it("still finds an older engine's open trade and its stop", () => {
    const s = liveReportTradeChart(row(7), oldBook, ctx)!.selection;
    expect([s.stopLoss, s.takeProfit]).toEqual([1.165, null]);
    expect(s.exitTime).toBeNull();
  });
});

describe('liveOpenTradeChart', () => {
  it('charts an Open trades row by its report number: entry, current SL/TP, no exit', () => {
    const chart = liveOpenTradeChart(liveOpenTradeFixture(), report.trades, ctx)!;
    expect(chart.origin).toBe('paper');
    const s = chart.selection;
    expect(s.title).toBe('Live session · trade #7 · Paper · EURUSD · Long · open');
    expect(s.referencePrice).toBe(1.17);
    expect(s.referenceTime).toBe('2026-01-05T08:00:00.000Z');
    expect([s.stopLoss, s.takeProfit]).toEqual([1.165, 1.18]);
    expect([s.exitPrice, s.exitTime]).toEqual([null, null]);
    expect(s.currentPrice).toBeNull();
  });

  it('names the trade by its entry id when the report does not list it', () => {
    const s = liveOpenTradeChart(
      { ...liveOpenTradeFixture(), origin: 'warmup' },
      [],
      ctx,
    )!.selection;
    expect(s.title).toBe(
      'Live session · open trade "Long" · Warm-up replay · EURUSD · Long · open',
    );
  });

  it('reads the older payload (entryTime, protectedStop, no origin)', () => {
    const s = liveOpenTradeChart(
      {
        entryId: 'Short',
        direction: 'short',
        entryPrice: 1.2,
        entryTime: Date.UTC(2026, 0, 5, 8),
        protectedStop: 1.21,
      },
      [],
      ctx,
    )!.selection;
    expect(s.direction).toBe('Sell');
    expect([s.stopLoss, s.takeProfit]).toEqual([1.21, null]);
    expect(s.title).toContain('Origin unknown');
  });

  it('refuses a row with no entry', () => {
    expect(liveOpenTradeChart({ entryId: 'Long' }, [], ctx)).toBeNull();
  });
});
