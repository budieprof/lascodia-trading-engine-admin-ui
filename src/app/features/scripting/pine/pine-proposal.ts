import type {
  ScriptAssistResult,
  ScriptConversion,
  ScriptPortResult,
} from '@core/api/scripting.types';

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

/**
 * The AI's fix (PE-I6) as a proposal; null (with the AI's words in `problem`) when it proposed no
 * change. The engine's warnings come first, then any compile error of the proposed script.
 */
export function assistProposal(
  before: string,
  r: ScriptAssistResult,
  what: string,
): { proposal: ScriptProposal | null; problem: string | null } {
  if (!r.source || r.source === before) {
    return { proposal: null, problem: r.explanation || 'The AI did not propose a change.' };
  }
  const warnings = [...(r.warnings ?? [])];
  const errors = (r.compile?.diagnostics ?? []).filter((d) => d.severity === 'error' && !d.unit);
  for (const d of errors) {
    const line = `Line ${d.line}: ${d.message}`;
    if (!warnings.some((w) => w.includes(d.message))) warnings.push(line);
  }
  return {
    proposal: {
      title: `AI fix: ${what}`,
      before,
      after: r.source,
      notes: r.explanation ? [r.explanation] : [],
      warnings,
      acceptLabel: 'Use the AI’s change',
    },
    problem: null,
  };
}

/**
 * A ported TradingView script (PE-I6) as a proposal replacing the editor's text: the conversion's
 * changes as notes; every checklist line that is not `ok` as a warning, problems first.
 */
export function portProposal(before: string, r: ScriptPortResult): ScriptProposal {
  const open = r.checklist.filter((c) => c.status !== 'ok');
  const ordered = [
    ...open.filter((c) => c.status === 'problem'),
    ...open.filter((c) => c.status !== 'problem'),
  ];
  return {
    title: r.conversion?.fromVersion
      ? `Port from TradingView (converted from v${r.conversion.fromVersion})`
      : 'Port from TradingView',
    before,
    after: r.source,
    notes: (r.conversion?.changes ?? []).map((x) => `Line ${x.line}: ${x.what}`),
    warnings: ordered.map(
      (c) =>
        `${c.status === 'problem' ? 'Fix' : 'Check'} — ${c.title}${c.line ? ` (line ${c.line})` : ''}: ${c.detail}`,
    ),
    acceptLabel: 'Open the ported script',
  };
}

/** The `//@version` of a source, or null. */
export function versionOf(source: string): number | null {
  const m = /^\s*\/\/\s*@version\s*=\s*(\d+)/m.exec(source);
  return m ? Number(m[1]) : null;
}
