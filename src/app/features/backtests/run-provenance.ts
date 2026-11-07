/**
 * What queued a backtest run and whether it may count as evidence — one place for the engine's
 * `ValidationQueueSource` names and the evidence-invalidation fields, so every page says the same thing.
 */

/** Engine `ValidationQueueSource` (serialised by name) → what an operator reads. */
export const QUEUE_SOURCE_LABELS: Readonly<Record<string, string>> = {
  Legacy: 'Legacy',
  Manual: 'Manual',
  AutoRefresh: 'Auto refresh',
  ActivationBaseline: 'Activation baseline',
  StrategyGenerationInitial: 'Strategy generation',
  OptimizationFollowUp: 'Optimization follow-up',
  BacktestFollowUp: 'Backtest follow-up',
  ParityReconcile: 'Parity reconcile',
  // Strategy program S10: fresh evidence for a non-Active strategy (BacktestAutoScheduler).
  EvidenceRefresh: 'Evidence refresh',
  // Strategy program V16: the engine's reproduction of an imported lab trial.
  LabReproduction: 'Lab reproduction',
  // Strategy program S13: the evidence backtest of a one-click validation pipeline.
  ValidationPipeline: 'Validation pipeline',
};

/** Longer explanation for a tooltip; only the sources whose name does not say it all. */
export const QUEUE_SOURCE_HINTS: Readonly<Record<string, string>> = {
  AutoRefresh: 'Re-run of an Active strategy by the auto-scheduler',
  ParityReconcile:
    "Backtest of a live or paper session's span, compared with its fills — never promotion evidence",
  EvidenceRefresh:
    'Fresh-evidence backtest of a paper-trading, approved or paused strategy, queued by the auto-scheduler',
  LabReproduction:
    "The engine's reproduction of an imported lab trial — checks a claim, never promotion evidence",
  ValidationPipeline: 'Evidence backtest of a one-click validation pipeline',
};

/**
 * A readable name for a queue source. Engine enums may arrive as their name or, from an older build, their number;
 * an unknown name is shown as sent rather than hidden.
 */
export function queueSourceLabel(source: string | number | null | undefined): string {
  if (source === null || source === undefined || source === '') return '—';
  const key = typeof source === 'number' ? (QUEUE_SOURCE_BY_NUMBER[source] ?? String(source)) : source;
  return QUEUE_SOURCE_LABELS[key] ?? key;
}

/** Tooltip for a queue source ('' when the label is enough). */
export function queueSourceHint(source: string | null | undefined): string {
  return (source && QUEUE_SOURCE_HINTS[source]) ?? '';
}

const QUEUE_SOURCE_BY_NUMBER: Readonly<Record<number, string>> = {
  0: 'Legacy',
  1: 'Manual',
  2: 'AutoRefresh',
  3: 'ActivationBaseline',
  4: 'StrategyGenerationInitial',
  5: 'OptimizationFollowUp',
  6: 'BacktestFollowUp',
  7: 'ParityReconcile',
  8: 'EvidenceRefresh',
  9: 'LabReproduction',
  10: 'ValidationPipeline',
};

/**
 * Queue sources that measure something other than the strategy (a session, a claim) — the engine never uses them as
 * promotion evidence, so the console does not either.
 */
export const NON_EVIDENCE_QUEUE_SOURCES: ReadonlySet<string> = new Set(['ParityReconcile', 'LabReproduction']);

/** Evidence invalidation (engine `BacktestRunDto.evidenceInvalidatedReason` / `…AtUtc`; optional — older builds omit it). */
export interface EvidenceInvalidationFields {
  evidenceInvalidatedReason?: string | null;
  evidenceInvalidatedAtUtc?: string | null;
}

export interface EvidenceInvalidation {
  reason: string;
  atUtc: string | null;
}

/** The run's invalidation, or null when it is valid (or the engine build does not send the field). */
export function evidenceInvalidation(
  run: EvidenceInvalidationFields | null | undefined,
): EvidenceInvalidation | null {
  const reason = run?.evidenceInvalidatedReason?.trim();
  if (!reason) return null;
  return { reason, atUtc: run?.evidenceInvalidatedAtUtc ?? null };
}

/** The note shown beside an invalidated run. */
export const EVIDENCE_INVALIDATED_NOTE =
  'Excluded from evidence: the engine no longer uses this run for promotion gates, graduation or as a strategy\'s evidence. The row is kept for the record.';

/** True when a run may stand as a strategy's evidence on a console view: not a parity / lab run, not invalidated. */
export function isEvidenceRun(
  run: ({ queueSource?: string | null } & EvidenceInvalidationFields) | null | undefined,
): boolean {
  if (!run) return false;
  if (NON_EVIDENCE_QUEUE_SOURCES.has(String(run.queueSource ?? ''))) return false;
  return evidenceInvalidation(run) === null;
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

/**
 * "Excluded" badge for an AG Grid cell renderer (an HTML string; AG Grid cells sit outside component styles, so it is
 * styled inline). '' for a valid run or an older engine build. The engine's reason is escaped into the tooltip.
 */
export function invalidatedBadgeHtml(run: EvidenceInvalidationFields | null | undefined): string {
  const inv = evidenceInvalidation(run);
  if (!inv) return '';
  return (
    ` <span data-testid="evidence-invalidated-badge" title="${escapeHtml(`Excluded from evidence: ${inv.reason}`)}" ` +
    `style="display:inline-flex;align-items:center;margin-left:6px;padding:0 8px;border-radius:999px;` +
    `border:1px solid color-mix(in srgb, var(--warning) 45%, transparent);` +
    `background:color-mix(in srgb, var(--warning) 14%, transparent);color:var(--text-primary);` +
    `font-size:11px;font-weight:600;line-height:18px;white-space:nowrap">Excluded</span>`
  );
}
