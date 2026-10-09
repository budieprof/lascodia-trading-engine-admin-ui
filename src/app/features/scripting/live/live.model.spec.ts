import { describe, expect, it } from 'vitest';

import {
  OPEN_TRADE_COLUMNS,
  barAgeMinutes,
  deriveColumns,
  formatBrokerLots,
  formatAge,
  formatLiveValue,
  heartbeatLate,
  humanize,
  liveModeInfo,
  liveStatusTone,
  liveWarningHint,
  normalizeLiveStatus,
  originStats,
  positionHeadline,
  sortLiveWarnings,
  timeframeMinutes,
  tradeR,
} from './live.model';
import type { ScriptLiveClosedTrade } from '../api/scripting-api.types';
import { liveClosedTradesFixture } from '../testing/live-status.fixture';
import { MINUS } from '../report/report-format';

describe('normalizeLiveStatus', () => {
  it('reads the contract’s fields in either casing', () => {
    const l = normalizeLiveStatus({
      Status: 'Running',
      LastBarTimeMs: 1_767_600_000_000,
      Position: { Size: 10000, AvgPrice: 1.17 },
      OpenTrades: [{ EntryId: 'Long', Qty: 10000 }],
      PendingOrders: [],
      Equity: 10641.2,
      Report: { performance: { all: {} } },
      Divergences: [
        { TimeUtc: '2026-01-06T10:00:00Z', AccountId: 27, Kind: 'Rejected', Detail: 'No money' },
      ],
    })!;
    expect(l.status).toBe('Running');
    expect(l.lastBarTimeMs).toBe(1_767_600_000_000);
    expect(l.position).toEqual({ size: 10000, avgPrice: 1.17 });
    expect(l.openTrades[0]).toEqual({ entryId: 'Long', qty: 10000 });
    expect(l.equity).toBe(10641.2);
    expect(l.divergences[0]).toEqual({
      timeUtc: '2026-01-06T10:00:00Z',
      accountId: 27,
      kind: 'Rejected',
      detail: 'No money',
    });
  });

  it('reads the closed trades and every trade’s origin (either casing)', () => {
    const l = normalizeLiveStatus({
      Status: 'Running',
      OpenTrades: [{ TradeKey: 7, Direction: 'long', Origin: 'paper' }],
      ClosedTrades: [
        {
          TradeKey: 3,
          EntryId: 'Long',
          Direction: 'Long',
          Qty: 10000,
          Lots: 0.1,
          EntryPrice: 1.17,
          EntryTimeMs: 1_767_600_000_000,
          ExitPrice: 1.175,
          ExitTimeMs: 1_767_603_600_000,
          ExitLeg: 'TakeProfit',
          ExitComment: 'TP',
          Profit: 50,
          StopLoss: 1.165,
          TakeProfit: 1.175,
          Origin: 'warmup',
        },
        { TradeKey: 4, Direction: 'short', StopLoss: null, Origin: 'mystery' },
      ],
    })!;
    expect(l.openTrades[0]['origin']).toBe('paper');
    expect(l.closedTrades[0]).toEqual({
      tradeKey: 3,
      entryId: 'Long',
      direction: 'long',
      qty: 10000,
      lots: 0.1,
      entryPrice: 1.17,
      entryTimeMs: 1_767_600_000_000,
      exitPrice: 1.175,
      exitTimeMs: 1_767_603_600_000,
      exitLeg: 'TakeProfit',
      exitComment: 'TP',
      profit: 50,
      stopLoss: 1.165,
      takeProfit: 1.175,
      origin: 'warmup',
    });
    // An origin the console does not know reads as unknown, never as a guess.
    expect(l.closedTrades[1].origin).toBeNull();
    expect(l.closedTrades[1].stopLoss).toBeNull();
    expect(l.closedTrades[1].exitTimeMs).toBeNull();
  });

  it('tolerates missing collections', () => {
    const l = normalizeLiveStatus({ status: 'Stopped' })!;
    expect(l.closedTrades).toEqual([]);
    expect(l.openTrades).toEqual([]);
    expect(l.pendingOrders).toEqual([]);
    expect(l.divergences).toEqual([]);
    expect(l.orphanedPositions).toEqual([]);
    expect(l.position).toBeNull();
    expect(l.equity).toBeNull();
    expect(normalizeLiveStatus(null)).toBeNull();
  });

  it('reads the account positions an earlier script version left open (D90)', () => {
    const l = normalizeLiveStatus({
      Status: 'Running',
      OrphanedPositions: [
        {
          PositionId: 5012,
          AccountId: 27,
          Symbol: 'EURUSD',
          Direction: 'Short',
          Lots: 0.5,
          EntryId: 'Short',
          SignalId: 88,
          StopLoss: 1.1821,
          TakeProfit: null,
          Status: 'Open',
          OrphanedAtUtc: '2026-09-24T21:00:00Z',
        },
      ],
    })!;
    expect(l.orphanedPositions).toEqual([
      {
        positionId: 5012,
        accountId: 27,
        symbol: 'EURUSD',
        direction: 'short',
        lots: 0.5,
        entryId: 'Short',
        stopLoss: 1.1821,
        takeProfit: null,
        status: 'Open',
        orphanedAtUtc: '2026-09-24T21:00:00Z',
      },
    ]);
  });
});

describe('presentation helpers', () => {
  it('maps a session status to a tone', () => {
    expect(liveStatusTone('Running')).toBe('success');
    expect(liveStatusTone('WarmingUp')).toBe('info');
    expect(liveStatusTone('Faulted')).toBe('error');
    expect(liveStatusTone('Stopped')).toBe('neutral');
  });

  it('humanises emulator field names', () => {
    expect(humanize('positionAvgPrice')).toBe('Position avg price');
    expect(humanize('openPnL')).toBe('Open P&L');
    expect(humanize('entryId')).toBe('Entry ID');
  });

  it('formats a field by what it holds', () => {
    expect(formatLiveValue('entryTime', Date.UTC(2026, 0, 5, 8))).toBe('2026-01-05 08:00 UTC');
    expect(formatLiveValue('limit', 1.1712)).toBe('1.17120');
    expect(formatLiveValue('openPnL', -12.5, 'USD')).toBe(`${MINUS}12.50 USD`);
    expect(formatLiveValue('command', 'Exit')).toBe('Exit');
    expect(formatLiveValue('immediately', false)).toBe('No');
    expect(formatLiveValue('stop', null)).toBe('—');
  });

  it('prints an open trade’s take-profit as a price, and its open profit as money', () => {
    expect(formatLiveValue('takeProfit', 1.15125)).toBe('1.15125');
    expect(formatLiveValue('stopLoss', 1.14475)).toBe('1.14475');
    expect(formatLiveValue('openProfit', 4.2, 'USD')).toBe('+4.20 USD');
  });

  it('prints emulator quantities in Pine units, and the lots the engine derives from them', () => {
    expect(formatLiveValue('qty', 100_000)).toBe('100,000 units');
    expect(formatLiveValue('size', 1)).toBe('1 unit');
    expect(formatLiveValue('positionSize', -25_000.5)).toBe(`${MINUS}25,000.5 units`);
    expect(formatLiveValue('qty', null)).toBe('—');
    expect(formatLiveValue('lots', 1)).toBe('1.00 lot');
    expect(formatLiveValue('lots', '0.25')).toBe('0.25 lots');
    expect(formatBrokerLots(1)).toBe('1.00 lot');
    expect(formatBrokerLots(0.5)).toBe('0.50 lots');
    expect(formatBrokerLots(null)).toBe('—');
  });

  it('describes the position in one line: units, and lots when the engine sends them', () => {
    expect(positionHeadline({ size: 100_000, avgPrice: 1.17, openPnL: 35.4 })).toEqual({
      side: 'long',
      text: 'Long 100,000 units @ 1.17000',
      pnl: 35.4,
    });
    expect(positionHeadline({ size: 100_000, lots: 1, avgPrice: 1.17 }).text).toBe(
      'Long 100,000 units ≈ 1.00 lot @ 1.17000',
    );
    expect(positionHeadline({ size: -50_000, lots: -0.5, avgPrice: 1.17 }).text).toBe(
      'Short 50,000 units ≈ 0.50 lots @ 1.17000',
    );
    expect(positionHeadline({ positionSize: -2, positionAvgPrice: 1.2 }).text).toBe(
      'Short 2 units @ 1.20000',
    );
    expect(positionHeadline({ size: 0 }).side).toBe('flat');
    expect(positionHeadline(null).text).toBe('Flat — no open position');
  });

  it('derives table columns with the preferred ones first', () => {
    const cols = deriveColumns(
      [
        { qty: 1, zeta: 'z', entryId: 'L', nested: { a: 1 } },
        { alpha: 2, entryId: 'S' },
      ],
      ['entryId', 'qty'],
    );
    expect(cols.map((c) => c.key)).toEqual(['entryId', 'qty', 'alpha', 'zeta']);
  });

  it('puts an open trade’s origin first, and only when the engine sends one', () => {
    const tagged = deriveColumns([{ entryId: 'L', qty: 1, origin: 'paper' }], OPEN_TRADE_COLUMNS);
    expect(tagged.map((c) => c.label)).toEqual(['Origin', 'Entry ID', 'Qty']);
    const untagged = deriveColumns([{ entryId: 'L', qty: 1 }], OPEN_TRADE_COLUMNS);
    expect(untagged.map((c) => c.key)).toEqual(['entryId', 'qty']);
  });

  it('ages the last bar', () => {
    expect(barAgeMinutes(0, 5 * 60_000)).toBe(5);
    expect(formatAge(0)).toBe('just now');
    expect(formatAge(45)).toBe('45 min ago');
    expect(formatAge(180)).toBe('3 h ago');
    expect(formatAge(60 * 72)).toBe('3 d ago');
  });
});

describe('PE-08 — mode, reason, heartbeat and compile findings', () => {
  it('reads mode, reason, heartbeat and warnings (either casing; UTC times without a zone)', () => {
    const l = normalizeLiveStatus({
      Status: 'Running',
      Mode: 'paper',
      Reason: 'Paper trading (paper-only stage, before approval)',
      LastHeartbeatUtc: '2026-10-09T08:00:00',
      StartedAtUtc: '2026-10-09T07:00:00Z',
      Warnings: [
        { Code: 'PS6202', Severity: 'Info', Message: 'lower tf', Line: 9, Column: 1 },
        {
          Code: 'PS9301',
          Severity: 'Warning',
          Message: 'Input "Length" was not applied',
          Line: 0,
          Column: 0,
        },
      ],
    })!;
    expect(l.mode).toBe('paper');
    expect(l.reason).toContain('Paper trading');
    expect(l.lastHeartbeatMs).toBe(Date.UTC(2026, 9, 9, 8));
    expect(l.startedAtMs).toBe(Date.UTC(2026, 9, 9, 7));
    expect(sortLiveWarnings(l.warnings).map((w) => [w.code, w.severity])).toEqual([
      ['PS9301', 'warning'],
      ['PS6202', 'info'],
    ]);
    // An older engine sends none of these.
    const old = normalizeLiveStatus({ Status: 'Running' })!;
    expect([old.mode, old.reason, old.lastHeartbeatMs, old.warnings]).toEqual([
      'none',
      '',
      null,
      [],
    ]);
  });

  it('explains each mode, and which of them reach a broker', () => {
    expect(liveModeInfo('live')).toMatchObject({ label: 'Live', sendsOrders: true });
    expect(liveModeInfo('paper')).toMatchObject({ label: 'Paper', sendsOrders: false });
    expect(liveModeInfo('ExitsOnly')).toMatchObject({ label: 'Exits only', sendsOrders: true });
    expect(liveModeInfo('alertsOnly').sendsOrders).toBe(false);
    expect(liveModeInfo('weird').label).toBe('weird');
  });

  it('calls a heartbeat late after two bars of the timeframe (at least 15 minutes)', () => {
    const now = Date.UTC(2026, 9, 9, 12);
    expect(heartbeatLate(now - 14 * 60_000, 'M1', now)).toBe(false);
    expect(heartbeatLate(now - 16 * 60_000, 'M1', now)).toBe(true);
    expect(heartbeatLate(now - 119 * 60_000, 'H1', now)).toBe(false);
    expect(heartbeatLate(now - 121 * 60_000, 'H1', now)).toBe(true);
    expect(heartbeatLate(null, 'H1', now)).toBe(false);
    expect(timeframeMinutes('D1')).toBe(1440);
  });

  it('PS9301 says the saved input was not applied — the default runs', () => {
    expect(liveWarningHint('ps9301')).toContain('runs that input’s default');
    expect(liveWarningHint('PS1234')).toBeNull();
  });
});

describe('PE-I2 (part) — paper and live statistics leave the warm-up out', () => {
  const trades = liveClosedTradesFixture() as unknown as ScriptLiveClosedTrade[];

  it('measures R against the stop the trade opened with', () => {
    expect(tradeR(trades[4])).toBeCloseTo(5, 6); // paper long 1.08 → 1.13, stop 1.07
    expect(tradeR(trades[5])).toBeCloseTo(0.0008 / 0.006, 6); // live short
    expect(tradeR({ ...trades[4], stopLoss: null })).toBeNull();
  });

  it('counts each origin on its own, never the warm-up replay', () => {
    const paper = originStats(trades, 'paper');
    const live = originStats(trades, 'live');
    expect([paper.trades, live.trades]).toEqual([1, 1]);
    expect(paper.expectancyR).toBeCloseTo(5, 6);
    expect(paper.wins).toBe(1);
    expect(paper.netProfit).toBeNull(); // the fixture carries no money
    expect(originStats(trades, 'warmup').trades).toBe(4);
  });

  it('sums money, profit factor and drawdown when the engine sends profit', () => {
    const withMoney = trades.map((t, i) => ({
      ...t,
      origin: 'paper' as const,
      profit: [10, -5, 20, -15, 30, -2][i],
    }));
    const s = originStats(withMoney, 'paper');
    expect(s.netProfit).toBe(38);
    expect(s.profitFactor).toBeCloseTo(60 / 22, 6);
    expect(s.winRate).toBeCloseTo(0.5, 6);
    // Cumulative 10, 5, 25, 10, 40, 38 → the deepest fall is 25 → 10.
    expect(s.maxDrawdown).toBe(15);
  });
});
