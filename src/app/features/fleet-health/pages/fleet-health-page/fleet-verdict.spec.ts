import { describe, expect, it } from 'vitest';

import { dbTier, EaStats, fleetVerdict, VerdictInput } from './fleet-verdict';

const stats = (o: Partial<EaStats> = {}): EaStats => ({
  total: 57,
  active: 5,
  disconnected: 47,
  disconnectedRecent: 0,
  shuttingDown: 0,
  deregistered: 5,
  idleOverStale: 0,
  coordinatorsLive: 5,
  accounts: 13,
  versions: 22,
  ...o,
});

const input = (o: Partial<VerdictInput> = {}): VerdictInput => ({
  stats: stats(),
  daemons: { online: 2, total: 2, offline: 0 },
  dbLatencyMs: 1,
  outboxPending: 0,
  staleMinutes: 10,
  ...o,
});

describe('fleet verdict', () => {
  it('is healthy when only retired ids are disconnected', () => {
    const v = fleetVerdict(input());
    expect(v.tone).toBe('ok');
    expect(v.headline).toBe('Fleet healthy');
    expect(v.facts).toEqual([
      '5 of 5 active instances heartbeating',
      'daemons 2/2 online',
      'database 1 ms',
    ]);
  });

  it('puts bad issues before warnings and counts them', () => {
    const v = fleetVerdict(
      input({ stats: stats({ idleOverStale: 1, disconnectedRecent: 2 }), dbLatencyMs: 120 }),
    );
    expect(v.tone).toBe('bad');
    expect(v.headline).toBe('3 things need attention');
    expect(v.issues.map((i) => i.text)).toEqual([
      '2 instances dropped in the last 24 h',
      '1 active instance silent for over 10 min',
      'Database latency 120 ms',
    ]);
  });

  it('uses the single issue as the headline', () => {
    const v = fleetVerdict(input({ daemons: { online: 1, total: 2, offline: 1 } }));
    expect(v.tone).toBe('bad');
    expect(v.headline).toBe('1 daemon offline');
  });

  it('flags a missing instance list and an empty fleet', () => {
    expect(fleetVerdict(input({ stats: null })).headline).toBe('EA instance list unavailable');
    const empty = fleetVerdict(input({ stats: stats({ active: 0 }) }));
    expect(empty.tone).toBe('warn');
    expect(empty.headline).toBe('No EA instance is active');
  });

  it('ignores unknown engine numbers and a small outbox', () => {
    const v = fleetVerdict(input({ dbLatencyMs: null, outboxPending: null, daemons: null }));
    expect(v.tone).toBe('ok');
    expect(fleetVerdict(input({ outboxPending: 101 })).tone).toBe('warn');
  });

  it('tiers db latency like the Engine tile', () => {
    expect(dbTier(49)).toBe('fast');
    expect(dbTier(50)).toBe('warn');
    expect(dbTier(200)).toBe('slow');
  });
});
