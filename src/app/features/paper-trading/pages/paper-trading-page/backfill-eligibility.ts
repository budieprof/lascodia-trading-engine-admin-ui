import type { StrategyDto } from '@core/api/api.types';

/**
 * Strategies the paper backfill is for (U06, 2026-11-07): the engine's backfill replays an
 * APPROVED-but-not-Active strategy (BackfillPaperExecutionsCommand), and the card says so — but the
 * picker offered every strategy, Drafts and live Actives included. The engine does not refuse the
 * others, so this filter is what keeps the card honest.
 */
export function isBackfillEligible(s: Pick<StrategyDto, 'lifecycleStage'>): boolean {
  return s.lifecycleStage === 'Approved';
}

export function backfillCandidates<T extends Pick<StrategyDto, 'lifecycleStage' | 'name'>>(
  strategies: readonly T[],
): T[] {
  return strategies
    .filter(isBackfillEligible)
    .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
}
