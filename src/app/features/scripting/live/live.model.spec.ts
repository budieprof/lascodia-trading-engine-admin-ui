import { describe, expect, it } from 'vitest';

import {
  barAgeMinutes,
  deriveColumns,
  formatBrokerLots,
  formatAge,
  formatLiveValue,
  humanize,
  liveStatusTone,
  normalizeLiveStatus,
  positionHeadline,
} from './live.model';
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

  it('tolerates missing collections', () => {
    const l = normalizeLiveStatus({ status: 'Stopped' })!;
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

  it('ages the last bar', () => {
    expect(barAgeMinutes(0, 5 * 60_000)).toBe(5);
    expect(formatAge(0)).toBe('just now');
    expect(formatAge(45)).toBe('45 min ago');
    expect(formatAge(180)).toBe('3 h ago');
    expect(formatAge(60 * 72)).toBe('3 d ago');
  });
});
