import type { ScriptConversion } from '@core/api/scripting.types';

/**
 * A change proposed to the script — by the converter (PR-I10) or the AI (PE-I6) — that the operator
 * reviews as a diff and accepts or rejects. Never applied without that click, and only onto the
 * text it was proposed for.
 */
export interface ScriptProposal {
  title: string;
  /** The source the proposal was made for. */
  before: string;
  after: string;
  /** What changed, in plain words. */
  notes: string[];
  /** What the operator must know before accepting (refusals, compile errors of the result). */
  warnings: string[];
  acceptLabel: string;
}

/** The converter's result as a proposal; null when there is nothing to accept (with the reason in `problem`). */
export function conversionProposal(
  before: string,
  c: ScriptConversion,
): { proposal: ScriptProposal | null; problem: string | null } {
  if (c.problem) return { proposal: null, problem: c.problem };
  if (c.source === before) {
    return {
      proposal: null,
      problem: c.refusals.length
        ? `Nothing could be converted: ${c.refusals.map((r) => `line ${r.line}: ${r.why}`).join(' ')}`
        : 'Nothing to convert.',
    };
  }
  const warnings = c.refusals.map((r) => `Line ${r.line} — ${r.construct}: ${r.why}`);
  const errors = (c.compile?.diagnostics ?? []).filter((d) => d.severity === 'error');
  if (errors.length) warnings.push(...errors.map((d) => `Line ${d.line}: ${d.message}`));
  return {
    proposal: {
      title:
        c.toVersion === 6
          ? `Convert Pine v${c.fromVersion} to v6`
          : `Convert Pine v${c.fromVersion} to v5 forms (it stays on v5)`,
      before,
      after: c.source,
      notes: c.changes.map((x) => `Line ${x.line}: ${x.what}`),
      warnings,
      acceptLabel: c.toVersion === 6 ? 'Use the v6 script' : 'Use the converted v5 script',
    },
    problem: null,
  };
}

/** The `//@version` of a source, or null. */
export function versionOf(source: string): number | null {
  const m = /^\s*\/\/\s*@version\s*=\s*(\d+)/m.exec(source);
  return m ? Number(m[1]) : null;
}
