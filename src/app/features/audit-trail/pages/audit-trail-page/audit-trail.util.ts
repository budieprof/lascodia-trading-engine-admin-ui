/**
 * Outcome buckets — the engine emits ~70 distinct outcome strings; these map them onto the few
 * tones an operator reads at a glance. A refusal (a gate saying "no") is not a failure: the
 * promotion gate rejecting a strategy is the gate doing its job, so it reads amber, not red.
 */
export const POSITIVE_OUTCOMES = new Set([
  'Approved',
  'Executed',
  'Active',
  'Promoted',
  'Passed',
  'Resolved',
  'Allowed',
]);
export const REFUSAL_OUTCOMES = new Set(['Rejected', 'Blocked']);
export const FAILURE_OUTCOMES = new Set(['Failed', 'Critical', 'Error', 'Aborted']);

export type OutcomeTone = 'ok' | 'warn' | 'bad' | 'grey' | 'info';

export function outcomeTone(outcome: string | null | undefined): OutcomeTone {
  const o = outcome ?? '';
  if (POSITIVE_OUTCOMES.has(o)) return 'ok';
  if (FAILURE_OUTCOMES.has(o)) return 'bad';
  if (REFUSAL_OUTCOMES.has(o) || o === 'Detected') return 'warn';
  if (o === 'Skipped' || o === '') return 'grey';
  return 'info';
}

/** CSS tone token for the AG Grid string renderer (component CSS does not reach it). */
export const OUTCOME_TONE_VAR: Record<OutcomeTone, string> = {
  ok: '--tone-green',
  warn: '--tone-amber',
  bad: '--tone-red',
  grey: '--tone-grey',
  info: '--tone-blue',
};

/** Fixed hex for ECharts (it cannot read CSS variables); each reads in both themes. */
export const OUTCOME_TONE_HEX: Record<OutcomeTone, string> = {
  ok: '#34C759',
  warn: '#FF9500',
  bad: '#FF3B30',
  grey: '#8E8E93',
  info: '#0A84FF',
};

/** Escape data-derived text for an HTML string renderer. */
export function escapeHtml(text: unknown): string {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
