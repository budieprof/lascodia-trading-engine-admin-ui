import { valueText } from './parameter-space.model';
import type { OptimizationCandidateDto } from './research.types';

/**
 * U10 — the top N candidates of an optimization run as the engine ranked them, each with only the inputs that DIFFER from
 * the reference (the run's chosen parameters, else the first-ranked): the eye goes to what changes between near-equal
 * configurations, which is what tells a plateau (many inputs vary, results hold) from a knife edge. Pure.
 */

const SPACE_MARKER = '__ScriptInputs';

export interface InputChange {
  id: string;
  from: string;
  to: string;
}

export interface TopCandidateRow {
  rank: number;
  isWinner: boolean;
  isReference: boolean;
  expectancyR: number | null;
  sharpeR: number | null;
  trades: number | null;
  rTrades: number | null;
  /** Inputs whose value differs from the reference's (missing on either side counts as a difference). */
  changes: InputChange[];
  /** Expectancy minus the reference's, R; null when either is unknown. */
  deltaExpectancyR: number | null;
}

export interface TopCandidates {
  reference: OptimizationCandidateDto | null;
  rows: TopCandidateRow[];
  /** Inputs that differ in at least one listed row, in first-seen order. */
  varied: string[];
}

function params(c: OptimizationCandidateDto): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(c.parameters ?? {})) if (k !== SPACE_MARKER) out[k] = v;
  return out;
}

const same = (a: unknown, b: unknown): boolean =>
  typeof a === 'number' && typeof b === 'number'
    ? Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(a), Math.abs(b))
    : JSON.stringify(a) === JSON.stringify(b);

export function topCandidatesWithDiff(
  rows: readonly OptimizationCandidateDto[],
  n = 10,
): TopCandidates {
  const top = rows.slice(0, Math.max(1, n));
  const reference = rows.find((r) => r.isWinner) ?? top[0] ?? null;
  if (!reference) return { reference: null, rows: [], varied: [] };
  const ref = params(reference);
  const varied: string[] = [];
  const out: TopCandidateRow[] = top.map((c) => {
    const mine = params(c);
    const keys = [...new Set([...Object.keys(ref), ...Object.keys(mine)])];
    const changes: InputChange[] = [];
    for (const k of keys) {
      if (k in ref && k in mine && same(ref[k], mine[k])) continue;
      changes.push({
        id: k,
        from: k in ref ? valueText(ref[k]) : '—',
        to: k in mine ? valueText(mine[k]) : '—',
      });
      if (!varied.includes(k)) varied.push(k);
    }
    return {
      rank: c.rank,
      isWinner: c.isWinner,
      isReference: c === reference,
      expectancyR: c.expectancyR,
      sharpeR: c.sharpeR,
      trades: c.trades,
      rTrades: c.rTrades,
      changes,
      deltaExpectancyR:
        c.expectancyR !== null && reference.expectancyR !== null
          ? c.expectancyR - reference.expectancyR
          : null,
    };
  });
  return { reference, rows: out, varied };
}
