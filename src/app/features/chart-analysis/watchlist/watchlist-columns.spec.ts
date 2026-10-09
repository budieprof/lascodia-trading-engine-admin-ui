import { describe, expect, it } from 'vitest';

import {
  adrUsedPct,
  atrPct,
  formatCountdown,
  instrumentKind,
  legsOf,
  neededData,
  newsTilt,
  nextEventFor,
  openSessions,
  pipSizeOf,
  pips,
  pnlBySymbol,
  resolveColumns,
  sessionLabel,
  sparklinePoints,
  toggleColumn,
  DEFAULT_COLUMNS,
} from './watchlist-columns';

describe('watchlist columns (SP-I6)', () => {
  it('resolves saved columns in their order, drops unknown keys, defaults when never saved', () => {
    expect(resolveColumns(null).map((c) => c.key)).toEqual([...DEFAULT_COLUMNS]);
    expect(resolveColumns(['spread', 'bogus', 'last', 'spread']).map((c) => c.key)).toEqual([
      'spread',
      'last',
    ]);
    expect(resolveColumns([])).toEqual([]);
  });

  it('toggles a column keeping the registry order and knows what extra data columns need', () => {
    expect(toggleColumn(['last', 'changePct'], 'spread')).toEqual(['last', 'changePct', 'spread']);
    expect(toggleColumn(['last', 'changePct'], 'last')).toEqual(['changePct']);
    expect([...neededData(resolveColumns(['last', 'adr', 'atrPct', 'sparkline', 'pnl']))].sort()).toEqual(
      ['positions', 'ranges', 'sparkline'],
    );
  });

  it('pip sizes: the quote’s own, else the convention', () => {
    expect(pipSizeOf('EURUSD', 5, 0.0001)).toBe(0.0001);
    expect(pipSizeOf('EURUSD', 5)).toBeCloseTo(0.0001);
    expect(pipSizeOf('USDJPY', 3)).toBe(0.01);
    expect(pipSizeOf('XAUUSD', 2)).toBe(0.1);
    expect(pips(0.00023, 0.0001)).toBe(2.3);
    expect(pips(null, 0.0001)).toBeNull();
  });

  it('ADR used and ATR %', () => {
    expect(adrUsedPct(1.105, 1.098, 0.0070)).toBe(100);
    expect(adrUsedPct(1.105, null, 0.007)).toBeNull();
    expect(adrUsedPct(1.105, 1.098, 0)).toBeNull();
    expect(atrPct(0.0088, 1.1)).toBe(0.8);
    expect(atrPct(null, 1.1)).toBeNull();
  });

  it('legs from the pair or a six-letter symbol, none for an index', () => {
    expect(legsOf('EURUSDm', 'EUR', 'USD')).toEqual({ base: 'EUR', quote: 'USD' });
    expect(legsOf('GBPJPY.ecn')).toEqual({ base: 'GBP', quote: 'JPY' });
    expect(legsOf('US30')).toBeNull();
  });

  it('the next unreleased event for either leg', () => {
    const now = Date.parse('2026-10-09T10:00:00Z');
    const events = [
      { title: 'CPI', currency: 'EUR', scheduledAt: '2026-10-09T09:00:00Z', actual: null }, // past
      { title: 'NFP', currency: 'USD', scheduledAt: '2026-10-09T12:30:00Z', actual: null },
      { title: 'BoJ', currency: 'JPY', scheduledAt: '2026-10-09T11:00:00Z', actual: null }, // other pair
      { title: 'PMI', currency: 'EUR', scheduledAt: '2026-10-09T10:00:30Z', actual: '50.1' }, // released
    ];
    expect(nextEventFor({ base: 'EUR', quote: 'USD' }, events, now)).toEqual({
      title: 'NFP',
      currency: 'USD',
      atMs: Date.parse('2026-10-09T12:30:00Z'),
    });
    expect(nextEventFor(null, events, now)).toBeNull();
    expect(formatCountdown(2.5 * 3_600_000)).toBe('2h 30m');
    expect(formatCountdown(12 * 60_000)).toBe('12m');
    expect(formatCountdown(30_000)).toBe('now');
    expect(formatCountdown(50 * 3_600_000)).toBe('2d 2h');
  });

  it('news tilt is base minus quote, only when both legs are scored', () => {
    const scores = new Map([
      ['EUR', -0.6],
      ['USD', 0.4],
    ]);
    expect(newsTilt({ base: 'EUR', quote: 'USD' }, scores)).toBe(-1);
    expect(newsTilt({ base: 'EUR', quote: 'JPY' }, scores)).toBeNull();
  });

  it('open P&L per symbol over the accounts in scope', () => {
    const positions = [
      { symbol: 'EURUSD', unrealizedPnL: -4, tradingAccountId: 17, status: 'Open' },
      { symbol: 'EURUSD', unrealizedPnL: 10, tradingAccountId: 17, status: 'Open' },
      { symbol: 'EURUSD', unrealizedPnL: 100, tradingAccountId: 22, status: 'Open' },
      { symbol: 'GBPUSD', unrealizedPnL: 5, tradingAccountId: 17, status: 'Closed' },
    ];
    expect(pnlBySymbol(positions, new Set([17])).get('EURUSD')).toBe(6);
    expect(pnlBySymbol(positions, new Set()).get('EURUSD')).toBe(106);
    expect(pnlBySymbol(positions, new Set([17])).has('GBPUSD')).toBe(false);
  });

  it('FX sessions by local time, DST-correct, home sessions first', () => {
    // Wednesday 2026-10-07 13:00 UTC: London (14:00 BST) and New York (09:00 EDT) are open.
    const overlap = Date.parse('2026-10-07T13:00:00Z');
    expect(openSessions(overlap).map((s) => s.short)).toEqual(['LDN', 'NY']);
    expect(sessionLabel({ base: 'USD', quote: 'CAD' }, true, overlap)).toEqual({ text: 'NY · LDN', home: true });
    expect(sessionLabel({ base: 'AUD', quote: 'NZD' }, true, overlap)).toEqual({ text: 'LDN · NY', home: false });
    // Wednesday 02:00 UTC: Tokyo (11:00) and Sydney (13:00 AEDT) are open.
    expect(openSessions(Date.parse('2026-10-07T02:00:00Z')).map((s) => s.short)).toEqual(['SYD', 'TKY']);
    expect(sessionLabel({ base: 'EUR', quote: 'USD' }, false, overlap)).toEqual({ text: 'Closed', home: false });
    // Saturday: nothing.
    expect(openSessions(Date.parse('2026-10-10T13:00:00Z'))).toEqual([]);
  });

  it('sparkline points span the box and need two values', () => {
    expect(sparklinePoints([1, 2, 3], 10, 6)).toBe('1.0,5.0 5.0,3.0 9.0,1.0');
    expect(sparklinePoints([1], 10, 6)).toBe('');
    expect(sparklinePoints(null, 10, 6)).toBe('');
  });

  it('instrument kind from the asset class (it was always "Forex")', () => {
    expect(instrumentKind('FxMajor', 'EURUSD', { base: 'EUR', quote: 'USD' })).toBe('Forex · major');
    expect(instrumentKind('Commodity', 'XAUUSD', { base: 'XAU', quote: 'USD' })).toBe('Metal');
    expect(instrumentKind('Index', 'US30', null)).toBe('Index CFD');
    expect(instrumentKind(null, 'XAGUSD', { base: 'XAG', quote: 'USD' })).toBe('Metal');
    expect(instrumentKind(null, 'US30', null)).toBe('CFD');
    expect(instrumentKind(null, 'EURGBP', { base: 'EUR', quote: 'GBP' })).toBe('Forex');
  });
});
