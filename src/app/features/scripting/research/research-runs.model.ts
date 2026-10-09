import { formatNumber, formatPercent } from '../report/report-format';
import { OBJECTIVES } from './parameter-space.model';
import type {
  OptimizationSelectionDto,
  SearchSpec,
  WalkForwardHoldoutScore,
  WalkForwardLaunchRequest,
  WalkForwardWindowMode,
} from './research.types';

/**
 * Plain-data helpers of the research workbench's run lists and readouts: which runs are still going, a run's objective
 * and stage in words, the walk-forward's terminal holdout, the launcher's checks, and the overfitting evidence laid out
 * from the engine's own numbers (never a client-side estimate).
 */

/** Queued or running: the list keeps polling while one is. */
export function isActiveRun(status: string | null | undefined): boolean {
  return status === 'Queued' || status === 'Running';
}

/** The search spec a run was triggered with (null for an automatic run, or unreadable JSON). */
export function parseSpec(json: string | null | undefined): SearchSpec | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as SearchSpec;
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

/** What a run ranked by, in words ("Health score" for a run without a spec). */
export function objectiveLabel(specJson: string | null | undefined): string {
  const spec = parseSpec(specJson);
  const id = spec?.objective ?? 'HealthScore';
  return OBJECTIVES.find((o) => o.id === id)?.label ?? String(id);
}

/** True when a run's spec shaped its space or ranking (shown as a "spec" chip). */
export function hasSpec(specJson: string | null | undefined): boolean {
  return parseSpec(specJson) !== null;
}

/** A run's stage in words: its status, and for a queued/running/failed run where it is and why. */
export function runStageText(run: {
  status: string;
  executionStage?: string | null;
  executionStageMessage?: string | null;
  failureCategory?: string | null;
  errorMessage?: string | null;
  deferralReason?: string | null;
  deferredUntilUtc?: string | null;
}): string {
  if (run.status === 'Failed') {
    const why = run.errorMessage || run.executionStageMessage;
    return [run.failureCategory ? `Failed (${run.failureCategory})` : 'Failed', why]
      .filter(Boolean)
      .join(': ');
  }
  if (run.status === 'Queued' && run.deferralReason) {
    const until = run.deferredUntilUtc
      ? ` until ${run.deferredUntilUtc.slice(0, 16).replace('T', ' ')} UTC`
      : '';
    return `Queued — deferred (${run.deferralReason})${until}`;
  }
  if (isActiveRun(run.status) && run.executionStage && run.executionStage !== run.status) {
    return `${run.status} — ${run.executionStage}${run.executionStageMessage ? `: ${run.executionStageMessage}` : ''}`;
  }
  return run.status;
}

/** The walk-forward's terminal-holdout score (`holdoutResultJson`, PascalCase), or null while locked / unreadable. */
export function parseHoldout(json: string | null | undefined): WalkForwardHoldoutScore | null {
  if (!json) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const get = (k: string): unknown => raw[k] ?? raw[k.charAt(0).toLowerCase() + k.slice(1)];
  const num = (k: string): number | null => {
    const v = get(k);
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  };
  const str = (k: string): string | null => {
    const v = get(k);
    return typeof v === 'string' ? v : null;
  };
  return {
    walkForwardRunId: num('WalkForwardRunId'),
    fromUtc: str('FromUtc'),
    toUtc: str('ToUtc'),
    scoredAtUtc: str('ScoredAtUtc'),
    bars: num('Bars'),
    totalTrades: num('TotalTrades'),
    netProfit: num('NetProfit'),
    sharpeRatio: num('SharpeRatio'),
    expectancyR: num('ExpectancyR'),
    maxDrawdownPct: num('MaxDrawdownPct'),
    winRate: num('WinRate'),
    profitFactor: num('ProfitFactor'),
    healthScore: num('HealthScore'),
    foldsAverageSharpe: num('FoldsAverageSharpe'),
    unscorable: get('Unscorable') === true,
  };
}

/** The holdout in one sentence: locked until approval, scored once, or unscorable. */
export function holdoutText(run: {
  terminalHoldoutFromUtc?: string | null;
  holdoutScoredAt?: string | null;
  holdoutResultJson?: string | null;
  status: string;
}): string {
  if (run.status !== 'Completed')
    return 'The final 10 % of the range is kept back as a holdout once the run completes.';
  const from = run.terminalHoldoutFromUtc ? run.terminalHoldoutFromUtc.slice(0, 10) : null;
  const score = parseHoldout(run.holdoutResultJson);
  if (!run.holdoutScoredAt || !score) {
    return `Locked: the holdout${from ? ` from ${from}` : ''} is scored once, when the strategy is approved — never before, so it stays unseen.`;
  }
  if (score.unscorable)
    return `Scored at approval${from ? ` (from ${from})` : ''}, but too short to judge (fewer than 20 bars).`;
  return (
    `Scored once at approval${from ? ` (from ${from})` : ''}: Sharpe ${formatNumber(score.sharpeRatio, 2)} over ` +
    `${score.totalTrades ?? 0} trades` +
    (score.expectancyR !== null ? `, ${formatNumber(score.expectancyR, 3)} R per trade` : '') +
    (score.foldsAverageSharpe !== null
      ? ` (folds averaged ${formatNumber(score.foldsAverageSharpe, 2)})`
      : '') +
    '.'
  );
}

// ── Walk-forward launcher ────────────────────────────────────────────────

export interface LauncherDraft {
  fromDate: string;
  toDate: string;
  inSampleDays: string;
  outOfSampleDays: string;
  initialBalance: string;
  reOptimizePerFold: boolean;
  windowMode: WalkForwardWindowMode;
}

/** Defaults: the last year, 90-day in-sample, 30-day out-of-sample folds, anchored, re-optimising. */
export function defaultLauncher(now: Date): LauncherDraft {
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const from = new Date(to.getTime() - 365 * 86_400_000);
  return {
    fromDate: from.toISOString().slice(0, 10),
    toDate: to.toISOString().slice(0, 10),
    inSampleDays: '90',
    outOfSampleDays: '30',
    initialBalance: '10000',
    reOptimizePerFold: true,
    windowMode: 'Anchored',
  };
}

/** How many out-of-sample folds a launch makes (before the engine's 10 % holdout and fold embargo). */
export function foldEstimate(d: LauncherDraft): number | null {
  const from = Date.parse(`${d.fromDate}T00:00:00Z`);
  const to = Date.parse(`${d.toDate}T00:00:00Z`);
  const is = Number(d.inSampleDays);
  const oos = Number(d.outOfSampleDays);
  if (!Number.isFinite(from) || !Number.isFinite(to) || !(is > 0) || !(oos > 0)) return null;
  const usable = ((to - from) / 86_400_000) * 0.9 - is;
  return usable <= 0 ? 0 : Math.floor(usable / oos);
}

/** The request, or the first reason it cannot be sent. */
export function launchRequest(
  d: LauncherDraft,
  strategy: { id: number; symbol: string | null; timeframe: string },
): WalkForwardLaunchRequest | string {
  if (!strategy.symbol) return 'The strategy has no symbol to walk forward on.';
  const from = Date.parse(`${d.fromDate}T00:00:00Z`);
  const to = Date.parse(`${d.toDate}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 'Choose the start and end dates.';
  if (to <= from) return 'The end date must be after the start date.';
  const is = Number(d.inSampleDays);
  const oos = Number(d.outOfSampleDays);
  if (!Number.isInteger(is) || is < 1)
    return 'In-sample days must be a whole number of at least 1.';
  if (!Number.isInteger(oos) || oos < 1)
    return 'Out-of-sample days must be a whole number of at least 1.';
  if (is + oos > (to - from) / 86_400_000)
    return 'In-sample plus out-of-sample days are longer than the date range.';
  const balance = Number(d.initialBalance);
  if (!(balance > 0)) return 'The starting balance must be above 0.';
  return {
    strategyId: strategy.id,
    symbol: strategy.symbol,
    timeframe: strategy.timeframe,
    fromDate: new Date(from).toISOString(),
    toDate: new Date(to).toISOString(),
    inSampleDays: is,
    outOfSampleDays: oos,
    initialBalance: balance,
    reOptimizePerFold: d.reOptimizePerFold,
    windowMode: d.windowMode,
  };
}

// ── Overfitting evidence ─────────────────────────────────────────────────

export interface EvidenceRow {
  label: string;
  value: string;
  /** Against the promotion gate's limit: true = within it, false = beyond it, null = not measurable / no limit. */
  ok: boolean | null;
  note: string;
}

/** The engine's selection statistics as rows (DSR against Promotion:MinDSR, PBO against Promotion:MaxPBO, the slope). */
export function evidenceRows(s: OptimizationSelectionDto): EvidenceRow[] {
  const rows: EvidenceRow[] = [];
  rows.push({
    label: 'Deflated Sharpe (effective trials)',
    value: formatNumber(s.deflatedSharpeEffective, 2),
    ok: s.deflatedSharpeEffective === null ? null : s.deflatedSharpeEffective >= s.minDsr,
    note: `deflated by ${s.effectiveTrials} trials (lineage ${s.ledgerTrials}, strategies on the pair ${s.peerStrategies}); minimum ${formatNumber(s.minDsr, 2)}`,
  });
  rows.push({
    label: 'Deflated Sharpe (this run)',
    value: formatNumber(s.deflatedSharpeRun, 2),
    ok: s.deflatedSharpeRun === null ? null : s.deflatedSharpeRun >= s.minDsr,
    note: `deflated by this run's ${s.runTrials} candidates`,
  });
  rows.push({
    label: 'Probability of backtest overfitting',
    value: s.pbo === null ? 'not measurable' : formatPercent(s.pbo * 100, { decimals: 0 }),
    ok: s.pbo === null ? null : s.pbo <= s.maxPbo,
    note:
      s.pbo === null
        ? (s.pboWhyNot ?? '')
        : `CSCV over ${s.pboBlocks} folds, ${s.pboCombinations} splits; limit ${formatPercent(s.maxPbo * 100, { decimals: 0 })}`,
  });
  rows.push({
    label: 'Out-of-sample vs in-sample slope',
    value: formatNumber(s.degradationSlope, 2),
    ok: s.degradationSlope === null ? null : s.degradationSlope >= 0,
    note: 'across the CSCV splits; below 0, better in-sample picks did worse out of sample',
  });
  return rows;
}
