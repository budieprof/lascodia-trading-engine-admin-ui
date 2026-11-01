/**
 * Pure presentation helpers for the Drawdown Recovery page. No Angular, no I/O —
 * covered by drawdown-format.spec.ts.
 */

/** "45 min", "8 h 22 min", "3.4 days". */
export function formatDuration(ms: number): string {
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins} min`;
  const hours = mins / 60;
  if (hours < 48) {
    const h = Math.floor(hours);
    const m = mins - h * 60;
    return m > 0 ? `${h} h ${m} min` : `${h} h`;
  }
  return `${(hours / 24).toFixed(1)} days`;
}

/**
 * An elapsed time measured inside the loaded window. When the run started before
 * the oldest loaded row the true figure is unknown, only bounded below — say so
 * with "≥" instead of printing the bound as if it were the answer.
 */
export interface Elapsed {
  ms: number;
  /** True when the start lies before the loaded window: `ms` is a minimum. */
  lowerBound: boolean;
}

export function formatElapsed(e: Elapsed | null, none = '—'): string {
  if (e === null) return none;
  return `${e.lowerBound ? '≥ ' : ''}${formatDuration(Math.max(0, e.ms))}`;
}

/**
 * Upper end of the gauge scale. Drawdown cannot exceed 100%, so the scale never
 * runs past it; otherwise it leaves a quarter of headroom above the halt line so
 * the red zone is visible, and always holds the current value.
 */
export function gaugeMax(value: number, haltedPct: number): number {
  const headroom = Math.ceil((haltedPct * 1.25) / 5) * 5;
  const holdsValue = Math.ceil((value * 1.1) / 5) * 5;
  return Math.max(5, Math.min(100, Math.max(headroom, holdsValue)));
}

/** Most severe first, so a halt reads before a reduction. */
const SEVERITY: string[] = ['Halted', 'Reduced', 'Normal'];

/**
 * Groups items by recovery mode, most severe mode first, empty groups dropped.
 * A mode the page does not know (the account DTO types it as a plain string)
 * keeps its own group after the known ones rather than being dropped.
 */
export function groupByMode<T extends { recoveryMode: string }>(
  items: T[],
): { mode: string; items: T[] }[] {
  const unknown = [...new Set(items.map((i) => i.recoveryMode))].filter(
    (m) => !SEVERITY.includes(m),
  );
  return [...SEVERITY, ...unknown]
    .map((mode) => ({ mode, items: items.filter((i) => i.recoveryMode === mode) }))
    .filter((g) => g.items.length > 0);
}

/** "1 account" / "3 accounts". */
export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}
