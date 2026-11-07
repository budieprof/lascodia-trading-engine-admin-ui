import { describe, expect, it } from 'vitest';
import { countdown, marketView, nextChangeText } from './market-status';

const at = (iso: string) => Date.parse(iso);
const NOW = at('2026-11-10T15:00:00Z');
const base = { liveAt: 0, lastBarEnd: NOW - 30_000, nowMs: NOW };

describe('marketView (UD08: the engine’s session state, not a guess from bar age)', () => {
  it('pre / regular / post with a countdown to the close', () => {
    const pre = marketView({
      ...base,
      state: {
        open: true,
        sessionKind: 'Pre',
        nextOpen: null,
        nextClose: '2026-11-10T15:30:00Z',
        tradingDay: '2026-11-10',
      },
    });
    expect([pre.kind, pre.label, pre.tone]).toEqual(['pre', 'Pre-market', 'open']);
    expect(nextChangeText(pre, NOW)).toBe('closes in 30m 00s');
    const reg = marketView({
      ...base,
      state: {
        open: true,
        sessionKind: 'Regular',
        nextOpen: null,
        nextClose: null,
        tradingDay: null,
      },
    });
    expect([reg.kind, reg.label]).toEqual(['regular', 'Market open']);
    expect(
      marketView({
        ...base,
        state: {
          open: true,
          sessionKind: 'Post',
          nextOpen: null,
          nextClose: null,
          tradingDay: null,
        },
      }).label,
    ).toBe('Post-market');
  });

  it('closed: the closure’s name (holiday, break), and the countdown to the next open', () => {
    const state = {
      open: false,
      sessionKind: null,
      nextOpen: '2026-11-11T14:30:00Z',
      nextClose: null,
      tradingDay: null,
    };
    const holiday = marketView({
      ...base,
      state,
      closures: [{ fromMs: NOW - 1000, toMs: NOW + 1000, kind: 'Holiday', label: 'Veterans Day' }],
    });
    expect([holiday.kind, holiday.label]).toEqual(['closed', 'Market closed: Veterans Day']);
    expect(nextChangeText(holiday, NOW)).toBe('opens in 23h 30m');
    const brk = marketView({
      ...base,
      state,
      closures: [{ fromMs: NOW - 1000, toMs: NOW + 1000, kind: 'Break', label: 'CME maintenance' }],
    });
    expect([brk.kind, brk.label]).toEqual(['break', 'Break']);
    expect(marketView({ ...base, state }).label).toBe('Market closed');
  });

  it('prices arriving while the calendar says closed: trading outside its hours, never "closed"', () => {
    const v = marketView({
      ...base,
      liveAt: NOW - 10_000,
      state: { open: false, sessionKind: null, nextOpen: null, nextClose: null, tradingDay: null },
    });
    expect([v.kind, v.tone]).toEqual(['outside', 'open']);
  });

  it('open but nothing for ten minutes: feed stale', () => {
    const v = marketView({
      state: {
        open: true,
        sessionKind: 'Regular',
        nextOpen: null,
        nextClose: null,
        tradingDay: null,
      },
      liveAt: 0,
      lastBarEnd: NOW - 11 * 60_000,
      nowMs: NOW,
    });
    expect([v.kind, v.tone]).toEqual(['stale', 'stale']);
  });

  it('no engine answer: read from the data and say so; not yet answered: says it is asking', () => {
    expect(marketView({ ...base, state: null }).label).toBe('live (from the data)');
    expect(marketView({ ...base, state: null, lastBarEnd: NOW - 86_400_000 }).label).toBe(
      'quiet (from the data)',
    );
    expect(marketView({ ...base, state: null, lastBarEnd: null }).label).toBe('No data');
    expect(marketView({ ...base, state: undefined }).kind).toBe('unknown');
  });

  it('countdown format', () => {
    expect(countdown(45_000)).toBe('45s');
    expect(countdown(12 * 60_000 + 5_000)).toBe('12m 05s');
    expect(countdown(2 * 3_600_000 + 5 * 60_000)).toBe('2h 05m');
    expect(countdown(3 * 86_400_000 + 4 * 3_600_000)).toBe('3d 4h');
  });
});
