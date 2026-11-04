import type { StrategyDto } from '@core/api/api.types';
import { validateBacktestForm } from '@features/scripting/backtest/script-backtest-launcher.model';

/** `#1215` / `1215` → 1215; anything else → null. */
export function strategyIdFromQuery(q: string): number | null {
  const m = /^#?\s*(\d{1,12})$/.exec(q.trim());
  if (!m) return null;
  const id = Number(m[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** Search hits in one list: no duplicates, the first query's order kept. */
export function mergeStrategies(...lists: StrategyDto[][]): StrategyDto[] {
  const seen = new Set<number>();
  const out: StrategyDto[] = [];
  for (const list of lists)
    for (const s of list)
      if (s && !seen.has(s.id)) {
        seen.add(s.id);
        out.push(s);
      }
  return out;
}

/** Problems with a non-script run's form; null when it can be queued. */
export function validateRuleBacktestForm(f: {
  fromDate: string;
  toDate: string;
  symbolOverride: string;
  initialBalance: number | null;
}): string | null {
  const base = validateBacktestForm(f);
  if (base) return base;
  if (f.initialBalance == null || !Number.isFinite(f.initialBalance) || f.initialBalance <= 0)
    return 'The initial balance must be greater than zero.';
  return null;
}
