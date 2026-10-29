import type { LookAheadAuditReport, Timeframe } from '@core/api/api.types';

export interface AuditPair {
  symbol: string;
  timeframe: Timeframe;
}

const TIMEFRAMES: readonly string[] = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1', 'W1', 'MN1'];

/**
 * Parses the analyser's pair list setting (`Workers:SyntheticAnalyserWorker:Pairs`,
 * e.g. "GBPUSD:H1,EURUSD:D1"). Malformed entries and duplicates are dropped.
 */
export function parsePairs(raw: string | null | undefined): AuditPair[] {
  const seen = new Set<string>();
  const out: AuditPair[] = [];
  for (const part of (raw ?? '').split(',')) {
    const [sym, tf] = part
      .trim()
      .split(':')
      .map((x) => x?.trim().toUpperCase());
    if (!sym || !tf || !/^[A-Z0-9.]{3,12}$/.test(sym) || !TIMEFRAMES.includes(tf)) continue;
    const key = `${sym}:${tf}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ symbol: sym, timeframe: tf as Timeframe });
  }
  return out;
}

/** What each of the five checks proves, in plain words (engine `LookAheadAuditService`). */
export const AUDIT_TESTS: readonly { key: string; name: string; what: string }[] = [
  {
    key: 'T1_TimestampInvariant',
    name: 'T1 · Timestamp invariant',
    what: 'Every stored analyser decision in the last 24 h used only data stamped before the decision (each feature family and the bid/ask snapshot).',
  },
  {
    key: 'T2_WalkerBoundary',
    name: 'T2 · Walker boundary',
    what: 'The candle query the analyser runs returns only bars that closed strictly before the sample time.',
  },
  {
    key: 'T3_ShiftForwardEquivalence',
    name: 'T3 · Repeatability',
    what: 'Two runs at the same moment give the same recommendation — nothing random or clock-dependent leaks in.',
  },
  {
    key: 'T4_PoisonedCanary',
    name: 'T4 · Poisoned canary',
    what: 'Appending a fake "future" candle changes the features — proving the audit would notice a leak if one happened.',
  },
  {
    key: 'T5_ProductionSmoke',
    name: 'T5 · Production replay',
    what: 'Recent stored decisions are replayed at their decision time; mismatches are rows to investigate, not proof of a leak.',
  },
];

export type AuditVerdict = 'clean' | 'failed' | 'partial';

/** clean = every test passed; failed = any failed; partial = none failed but some were skipped. */
export function verdictOf(r: LookAheadAuditReport): AuditVerdict {
  if (r.failedCount > 0) return 'failed';
  return r.skippedCount > 0 ? 'partial' : 'clean';
}

export const VERDICT_LABEL: Record<AuditVerdict, string> = {
  clean: 'All passed',
  failed: 'Failed',
  partial: 'Passed (some skipped)',
};

/** Status of one named test in a report, or null when the report does not carry it. */
export function testStatus(r: LookAheadAuditReport, key: string): string | null {
  return r.tests.find((t) => t.testName === key)?.status ?? null;
}
