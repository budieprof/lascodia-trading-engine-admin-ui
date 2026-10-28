import { describe, expect, it } from 'vitest';

import type { LookAheadAuditReport } from '@core/api/api.types';
import { AUDIT_TESTS, parsePairs, testStatus, verdictOf } from './look-ahead-audit.logic';

function report(p: number, f: number, s: number): LookAheadAuditReport {
  return {
    symbol: 'GBPUSD',
    timeframe: 'H1',
    sampleAt: '2026-10-28T22:46:44Z',
    completedAt: '2026-10-28T22:46:45Z',
    passedCount: p,
    failedCount: f,
    skippedCount: s,
    durationMs: 1011,
    tests: [{ testName: 'T2_WalkerBoundary', status: 'Passed', detail: '', diagnostics: null }],
  };
}

describe('look-ahead audit logic', () => {
  it('parses the analyser pair setting, dropping junk and duplicates', () => {
    expect(parsePairs('GBPUSD:H1, eurgbp:h1,EURUSD:D1,bad,XX:Q9,GBPUSD:H1,')).toEqual([
      { symbol: 'GBPUSD', timeframe: 'H1' },
      { symbol: 'EURGBP', timeframe: 'H1' },
      { symbol: 'EURUSD', timeframe: 'D1' },
    ]);
    expect(parsePairs(null)).toEqual([]);
  });

  it('gives a verdict from the counts', () => {
    expect(verdictOf(report(5, 0, 0))).toBe('clean');
    expect(verdictOf(report(3, 0, 2))).toBe('partial');
    expect(verdictOf(report(3, 1, 1))).toBe('failed');
  });

  it('reads one test status and covers all five tests', () => {
    expect(testStatus(report(1, 0, 0), 'T2_WalkerBoundary')).toBe('Passed');
    expect(testStatus(report(1, 0, 0), 'T1_TimestampInvariant')).toBeNull();
    expect(AUDIT_TESTS.map((t) => t.key.slice(0, 2))).toEqual(['T1', 'T2', 'T3', 'T4', 'T5']);
  });
});
