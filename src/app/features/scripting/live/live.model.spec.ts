import { describe, expect, it } from 'vitest';

import {
  barAgeMinutes,
  deriveColumns,
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
    expect(l.position).toBeNull();
    expect(l.equity).toBeNull();
    expect(normalizeLiveStatus(null)).toBeNull();
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
    expect(formatLiveValue('qty', 10000)).toBe('10,000');
    expect(formatLiveValue('command', 'Exit')).toBe('Exit');
    expect(formatLiveValue('immediately', false)).toBe('No');
    expect(formatLiveValue('stop', null)).toBe('—');
  });

  it('describes the position in one line', () => {
    expect(positionHeadline({ size: 10000, avgPrice: 1.17, openPnL: 35.4 })).toEqual({
      side: 'long',
      text: 'Long 10,000 @ 1.17000',
      pnl: 35.4,
    });
    expect(positionHeadline({ positionSize: -2, positionAvgPrice: 1.2 }).text).toBe(
      'Short 2 @ 1.20000',
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
