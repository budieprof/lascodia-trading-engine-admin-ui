import { fmtFraction, fmtProfitFactor } from '@shared/utils/metric-format';

import type {
  LabTrialDto,
  PipelineStepDto,
  StrategyHoldoutDto,
  ValidationPipelineDto,
} from './research-cockpit.types';

/**
 * U12 — the research cockpit's decisions, pure: the validation pipeline as a stepper, the lineage holdout in words, the
 * walk-forward's stitched out-of-sample verdict (C10), the lab-import file check (mirrors the engine's validator so a
 * bad file is refused before it is sent), and tolerant readers for the views whose engine endpoints are still to come.
 */

// ── C1 version stamp ──────────────────────────────────────────────────────
/** The first 8 hex digits of a C1 configuration hash (lower-hex sha256); '' when absent. */
export function shortHash(h: string | null | undefined): string {
  return typeof h === 'string' && /^[0-9a-f]{8,}$/i.test(h.trim())
    ? h.trim().slice(0, 8).toLowerCase()
    : '';
}

export type HashRelation = 'current' | 'older' | 'unknown';

/** Whether a row was made by the strategy's CURRENT configuration (both hashes known), else unknown. */
export function hashRelation(
  rowHash: string | null | undefined,
  currentHash: string | null | undefined,
): HashRelation {
  const a = shortHash(rowHash);
  const b = shortHash(currentHash);
  if (!a || !b) return 'unknown';
  return rowHash!.trim().toLowerCase() === currentHash!.trim().toLowerCase() ? 'current' : 'older';
}

// ── S13 pipeline ──────────────────────────────────────────────────────────
export const PIPELINE_STEPS = ['Backtest', 'WalkForward', 'Gates', 'Paper'] as const;

const STEP_LABELS: Record<string, string> = {
  Backtest: 'Evidence backtest',
  WalkForward: 'Walk-forward (re-optimised per fold)',
  Gates: 'Promotion gates (dry run)',
  Paper: 'Start paper trading',
};

export type StepTone = 'done' | 'running' | 'failed' | 'waiting' | 'skipped' | 'cancelled';

export interface StepView {
  name: string;
  label: string;
  tone: StepTone;
  statusText: string;
  outcome: string;
  runId: number | null;
  /** Router link to the step's run, when it has one. */
  link: (string | number)[] | null;
}

function toneOf(status: string): StepTone {
  switch (status) {
    case 'Completed':
      return 'done';
    case 'Running':
      return 'running';
    case 'Failed':
      return 'failed';
    case 'Skipped':
      return 'skipped';
    case 'Cancelled':
      return 'cancelled';
    default:
      return 'waiting';
  }
}

export function isPipelineActive(
  p: Pick<ValidationPipelineDto, 'status'> | null | undefined,
): boolean {
  return !!p && (p.status === 'Queued' || p.status === 'Running');
}

/** The four steps in order, from the engine's stored steps (a missing step reads "waiting"). */
export function pipelineSteps(p: ValidationPipelineDto): StepView[] {
  const byName = new Map<string, PipelineStepDto>((p.steps ?? []).map((s) => [s.name, s]));
  return PIPELINE_STEPS.map((name) => {
    const s = byName.get(name);
    const status = String(s?.status ?? 'Queued');
    const runId =
      s?.runId ??
      (name === 'Backtest'
        ? (p.backtestRunId ?? null)
        : name === 'WalkForward'
          ? (p.walkForwardRunId ?? null)
          : null);
    const link =
      runId === null
        ? null
        : name === 'Backtest'
          ? ['/backtests', runId]
          : name === 'WalkForward'
            ? ['/walk-forward', runId]
            : null;
    return {
      name,
      label: STEP_LABELS[name] ?? name,
      tone: toneOf(status),
      statusText: status === 'Queued' ? 'Waiting' : status,
      outcome: s?.outcome ?? '',
      runId,
      link,
    };
  });
}

// ── V03 holdout ───────────────────────────────────────────────────────────
export interface HoldoutView {
  window: string;
  statusLine: string;
  modeLine: string;
  result: { label: string; value: string }[];
  /** Evaluate spends a LOCKED holdout once; re-carve applies to a SPENT one. */
  canEvaluate: boolean;
  canRecarve: boolean;
}

const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : '—');

export function holdoutView(h: StrategyHoldoutDto): HoldoutView {
  const spent = h.status === 'Spent';
  const r = h.result;
  const result: { label: string; value: string }[] = [];
  if (r) {
    if (r.unscorable) result.push({ label: 'Not scorable', value: r.unscorable });
    else {
      result.push(
        {
          label: 'Expectancy',
          value:
            r.expectancyR == null
              ? '—'
              : `${r.expectancyR >= 0 ? '+' : ''}${r.expectancyR.toFixed(3)} R`,
        },
        { label: 'Trades (with R)', value: `${r.totalTrades ?? '—'} (${r.rTrades ?? '—'})` },
        { label: 'Sharpe in R', value: r.sharpeR == null ? '—' : r.sharpeR.toFixed(3) },
        { label: 'Win rate', value: fmtFraction(r.winRate ?? null) },
        {
          label: 'Profit factor',
          value: fmtProfitFactor(r.profitFactor ?? null, 2, (r.totalTrades ?? 0) > 0),
        },
        {
          label: 'Max drawdown',
          value: r.maxDrawdownPct == null ? '—' : `${r.maxDrawdownPct.toFixed(2)}%`,
        },
      );
    }
    if ((r.touchedByRuns ?? 0) > 0)
      result.push({
        label: 'Contamination',
        value: `${r.touchedByRuns} lineage run(s) reached into the window after it was carved`,
      });
  }
  return {
    window: `${day(h.fromUtc)} → ${day(h.toUtc)}${h.symbol ? ` · ${h.symbol}` : ''}${h.timeframe ? ` ${h.timeframe}` : ''}`,
    statusLine: spent
      ? `Spent ${day(h.spentAtUtc)}${h.spentTrigger ? ` (${h.spentTrigger})` : ''}${h.spentByStrategyId ? ` by #${h.spentByStrategyId}` : ''}` +
        (h.spentOnCurrentConfiguration === false
          ? ' — on ANOTHER configuration: this one can no longer be judged on it until the holdout is re-carved.'
          : h.spentOnCurrentConfiguration
            ? ' — on this configuration.'
            : '.')
      : 'Locked — never scored. Evaluating spends it, once, for the current configuration.',
    modeLine:
      h.mode === 'Enforce'
        ? 'Enforce: automatic evidence, optimizer and walk-forward data stop before the window; approval needs a positive score here.'
        : `Record: the window is scored and reported, not enforced${h.modeReason ? ` — ${h.modeReason}` : ''}.`,
    result,
    canEvaluate: !spent,
    canRecarve: spent,
  };
}

// ── C10 stitched OOS ──────────────────────────────────────────────────────
export interface StitchedRun {
  id: number;
  status?: string;
  completedAt?: string | null;
  strategyConfigHash?: string | null;
  oosExpectancyR?: number | null;
  oosSharpeR?: number | null;
  oosTrades?: number | null;
  oosRTrades?: number | null;
  walkForwardEfficiency?: number | null;
  parameterDriftScore?: number | null;
  zeroTradeFolds?: number | null;
  foldCount?: number | null;
  foldEmbargoBars?: number | null;
  reOptimizePerFold?: boolean;
  strategyHoldoutId?: number | null;
}

/** True when the run carries the C10 fields (an older run, or an older engine, does not). */
export function hasStitched(r: StitchedRun): boolean {
  return r.oosExpectancyR != null || r.foldCount != null || r.oosTrades != null;
}

export function stitchedRows(r: StitchedRun): { label: string; value: string; note: string }[] {
  const n = (v: number | null | undefined, d = 3) => (v == null ? '—' : v.toFixed(d));
  const tStat =
    r.oosSharpeR != null && r.oosRTrades != null && r.oosRTrades > 1
      ? r.oosSharpeR * Math.sqrt(r.oosRTrades)
      : null;
  return [
    {
      label: 'Out-of-sample expectancy',
      value:
        r.oosExpectancyR == null
          ? '—'
          : `${r.oosExpectancyR >= 0 ? '+' : ''}${n(r.oosExpectancyR)} R`,
      note: 'every fold’s OOS trades stitched together; the walk_forward gate needs it above 0',
    },
    {
      label: 'Sharpe in R (per trade)',
      value: n(r.oosSharpeR),
      note: tStat === null ? '' : `t-statistic ${tStat.toFixed(2)} over ${r.oosRTrades} R trades`,
    },
    {
      label: 'OOS trades (with R)',
      value: `${r.oosTrades ?? '—'} (${r.oosRTrades ?? '—'})`,
      note: '',
    },
    {
      label: 'Walk-forward efficiency',
      value:
        r.walkForwardEfficiency == null ? '—' : `${(r.walkForwardEfficiency * 100).toFixed(0)}%`,
      note: 'OOS performance as a share of in-sample',
    },
    {
      label: 'Parameter drift',
      value: n(r.parameterDriftScore, 2),
      note: 'how far the re-optimised inputs moved between folds',
    },
    {
      label: 'Folds',
      value: `${r.foldCount ?? '—'}${r.zeroTradeFolds ? ` (${r.zeroTradeFolds} without a trade)` : ''}`,
      note:
        r.reOptimizePerFold === false
          ? 'fixed parameters (not re-optimised)'
          : 're-optimised per fold',
    },
  ];
}

// ── V16 lab import ────────────────────────────────────────────────────────
export const LAB_MAX_TRIALS = 500;

export interface LabParse {
  batch: string;
  trials: LabTrialDto[];
  errors: string[];
}

/**
 * Reads a lab export: either `{ batch, trials: [...] }` or a bare `[...]` of trials (`batch` then comes from the form).
 * Every engine validator rule is checked here so a bad file never reaches the engine.
 */
export function parseLabImport(text: string, fallbackBatch: string): LabParse {
  const errors: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { batch: fallbackBatch, trials: [], errors: ['The file is not JSON.'] };
  }
  const obj =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(obj?.['trials'])
      ? (obj!['trials'] as unknown[])
      : null;
  const batch = (
    typeof obj?.['batch'] === 'string' ? (obj['batch'] as string) : fallbackBatch
  ).trim();
  if (!list)
    return {
      batch,
      trials: [],
      errors: ['No trials: expected an array or { "batch", "trials": [...] }.'],
    };
  if (!batch) errors.push('A batch name is required (in the file or the form).');
  if (batch.length > 128) errors.push('The batch name is longer than 128 characters.');
  if (list.length === 0) errors.push('The file has no trials.');
  if (list.length > LAB_MAX_TRIALS)
    errors.push(`At most ${LAB_MAX_TRIALS} trials per import (the file has ${list.length}).`);
  const trials: LabTrialDto[] = [];
  list.forEach((t, i) => {
    const where = `Trial ${i + 1}`;
    if (!t || typeof t !== 'object') {
      errors.push(`${where}: not an object.`);
      return;
    }
    const o = t as Record<string, unknown>;
    const from = typeof o['windowFromUtc'] === 'string' ? (o['windowFromUtc'] as string) : '';
    const to = typeof o['windowToUtc'] === 'string' ? (o['windowToUtc'] as string) : '';
    const tFrom = Date.parse(from);
    const tTo = Date.parse(to);
    if (!Number.isFinite(tFrom) || !Number.isFinite(tTo))
      errors.push(`${where}: windowFromUtc / windowToUtc must be dates.`);
    else if (!(tTo > tFrom)) errors.push(`${where}: windowToUtc must be after windowFromUtc.`);
    const dataHash = typeof o['dataHash'] === 'string' ? (o['dataHash'] as string).trim() : '';
    const codeHash = typeof o['codeHash'] === 'string' ? (o['codeHash'] as string).trim() : '';
    if (!dataHash || dataHash.length > 128)
      errors.push(`${where}: dataHash is required (≤ 128 characters).`);
    if (!codeHash || codeHash.length > 128)
      errors.push(`${where}: codeHash is required (≤ 128 characters).`);
    const tradeR = Array.isArray(o['tradeR']) ? (o['tradeR'] as unknown[]) : null;
    if (!tradeR) errors.push(`${where}: tradeR must be an array of numbers.`);
    else if (!tradeR.every((x) => typeof x === 'number' && Number.isFinite(x)))
      errors.push(`${where}: tradeR must be finite numbers.`);
    else if (tradeR.length > 100_000) errors.push(`${where}: at most 100000 trades.`);
    const label = typeof o['label'] === 'string' ? (o['label'] as string) : null;
    if (label && label.length > 256) errors.push(`${where}: label is longer than 256 characters.`);
    const inputs =
      o['inputs'] && typeof o['inputs'] === 'object'
        ? (o['inputs'] as Record<string, unknown>)
        : null;
    const inputsByTitle =
      o['inputsByTitle'] && typeof o['inputsByTitle'] === 'object'
        ? (o['inputsByTitle'] as Record<string, unknown>)
        : null;
    trials.push({
      label,
      inputs,
      inputsByTitle,
      windowFromUtc: from,
      windowToUtc: to,
      tradeR: (tradeR ?? []) as number[],
      dataHash,
      codeHash,
    });
  });
  return { batch, trials, errors };
}

// ── Tolerant readers for views whose endpoints are still to come ─────────
type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const numOr = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;
const strOr = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));

/** An HTTP 404 (or the engine's "not found" route answer): the engine does not offer this view yet. */
export function isNotOffered(err: unknown): boolean {
  const status = isObj(err) ? err['status'] : undefined;
  return status === 404 || status === 405;
}

export interface SequentialRow {
  configHash: string;
  statistic: number | null;
  threshold: number | null;
  observations: number | null;
  baselineMeanR: number | null;
  baselineSdR: number | null;
  alarmedAtUtc: string | null;
  lastObservedAtUtc: string | null;
}

/** S09 state: `{ mode, states: [...] }` or a bare array; field names as the engine entity (camelCase). */
export function readSequential(raw: unknown): { mode: string; rows: SequentialRow[] } {
  const obj = isObj(raw) ? raw : null;
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(obj?.['states'])
      ? (obj!['states'] as unknown[])
      : [];
  return {
    mode: strOr(obj?.['mode']),
    rows: list.filter(isObj).map((s) => ({
      configHash: strOr(s['strategyConfigHash']),
      statistic: numOr(s['statistic'] ?? s['cusum']),
      threshold: numOr(s['threshold'] ?? s['h']),
      observations: numOr(s['observations'] ?? s['observationCount']),
      baselineMeanR: numOr(s['baselineMeanR'] ?? s['mu0']),
      baselineSdR: numOr(s['baselineSdR'] ?? s['sigma0']),
      alarmedAtUtc: strOr(s['alarmedAtUtc']) || null,
      lastObservedAtUtc: strOr(s['lastObservedAtUtc']) || null,
    })),
  };
}

export interface CalibrationRow {
  brokerKey: string;
  sessionBucket: string;
  computedAtUtc: string;
  sampleCount: number | null;
  slippageSource: string;
  slipMean: number | null;
  slipP50: number | null;
  slipP90: number | null;
  spreadMultipleP50: number | null;
  latencyP50: number | null;
  latencyP90: number | null;
  fitVersion: string;
}

/** C7 profiles (`ExecutionCostProfile`, camelCase). */
export function readCalibration(raw: unknown): CalibrationRow[] {
  const list = Array.isArray(raw)
    ? raw
    : isObj(raw) && Array.isArray(raw['profiles'])
      ? (raw['profiles'] as unknown[])
      : [];
  return list.filter(isObj).map((p) => {
    const slip = isObj(p['slippagePips']) ? p['slippagePips'] : {};
    const mult = isObj(p['slippageSpreadMultiple']) ? p['slippageSpreadMultiple'] : {};
    const lat = isObj(p['latencyMs']) ? p['latencyMs'] : {};
    return {
      brokerKey: strOr(p['brokerKey']),
      sessionBucket: strOr(p['sessionBucket']),
      computedAtUtc: strOr(p['computedAtUtc']),
      sampleCount: numOr(p['sampleCount']),
      slippageSource: strOr(p['slippageSource']),
      slipMean: numOr(slip['mean']),
      slipP50: numOr(slip['p50']),
      slipP90: numOr(slip['p90']),
      spreadMultipleP50: numOr(mult['p50']),
      latencyP50: numOr(lat['p50']),
      latencyP90: numOr(lat['p90']),
      fitVersion: strOr(p['fitVersion']),
    };
  });
}

export interface SpecChange {
  validFromUtc: string;
  brokerKey: string;
  /** Fields that changed against the previous row of the same broker key (all fields on a first row). */
  changes: { field: string; from: string; to: string }[];
}

const SPEC_SKIP = new Set([
  'id',
  'validFromUtc',
  'brokerKey',
  'symbol',
  'specHash',
  'tradingAccountId',
  'tenantId',
  'isDeleted',
  'createdAt',
]);

/** C6 history rows (oldest first after sorting) as per-row changes. */
export function readSpecHistory(raw: unknown): SpecChange[] {
  const list = Array.isArray(raw)
    ? raw
    : isObj(raw) && Array.isArray(raw['rows'])
      ? (raw['rows'] as unknown[])
      : [];
  const rows = list
    .filter(isObj)
    .sort((a, b) => strOr(a['validFromUtc']).localeCompare(strOr(b['validFromUtc'])));
  const prevByKey = new Map<string, Json>();
  const out: SpecChange[] = [];
  for (const r of rows) {
    const key = strOr(r['brokerKey'] ?? r['tradingAccountId']);
    const prev = prevByKey.get(key);
    const changes: SpecChange['changes'] = [];
    for (const [field, v] of Object.entries(r)) {
      if (SPEC_SKIP.has(field)) continue;
      const before = prev ? prev[field] : undefined;
      if (prev && JSON.stringify(before) === JSON.stringify(v)) continue;
      changes.push({
        field,
        from: prev ? strOr(before) : '',
        to: strOr(isObj(v) ? JSON.stringify(v) : v),
      });
    }
    prevByKey.set(key, r);
    out.push({ validFromUtc: strOr(r['validFromUtc']), brokerKey: key, changes });
  }
  return out.reverse();
}

// ── C4 execution quality ──────────────────────────────────────────────────
/** An execution-quality row as the list sends it, plus the C4 fields an engine may add to the DTO. */
export interface ExecQualityRow {
  session?: string | number | null;
  slippagePips: number;
  submitToFillMs: number;
  wasPartialFill?: boolean;
  recordedAt?: string;
  /** C4 (optional on the DTO): corrected send→fill latency, engine-derived pips, spread at send. */
  sendToFillMs?: number | null;
  engineSlippagePips?: number | null;
  spreadAtSendPts?: number | null;
}

export interface ExecQualityGroup {
  session: string;
  fills: number;
  partial: number;
  slipMean: number | null;
  slipP50: number | null;
  slipP90: number | null;
  latP50: number | null;
  latP90: number | null;
}

function pct(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Fills grouped by trading session ("All" first). Slippage = the engine-derived pips when every row has them (C4),
 * else the recorded `slippagePips`; latency = `sendToFillMs` when present (C4, corrected) else `submitToFillMs` —
 * which one is said by the returned basis. A latency of 0 is "not measured" (async fills before C4) and left out.
 */
export function execQualitySummary(rows: readonly ExecQualityRow[]): {
  groups: ExecQualityGroup[];
  slippageBasis: 'engine' | 'recorded';
  latencyBasis: 'sendToFill' | 'submitToFill';
} {
  const engine = rows.length > 0 && rows.every((r) => typeof r.engineSlippagePips === 'number');
  const sendToFill = rows.some((r) => typeof r.sendToFillMs === 'number');
  const bySession = new Map<string, ExecQualityRow[]>([['All', [...rows]]]);
  for (const r of rows) {
    const key =
      r.session === null || r.session === undefined || r.session === ''
        ? 'Unknown'
        : String(r.session);
    bySession.set(key, [...(bySession.get(key) ?? []), r]);
  }
  const groups: ExecQualityGroup[] = [];
  for (const [session, list] of bySession) {
    if (list.length === 0) continue;
    const slips = list
      .map((r) => (engine ? (r.engineSlippagePips as number) : r.slippagePips))
      .filter((v) => Number.isFinite(v))
      .sort((a, b) => a - b);
    const lats = list
      .map((r) => (sendToFill ? (r.sendToFillMs ?? null) : r.submitToFillMs))
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0)
      .sort((a, b) => a - b);
    groups.push({
      session,
      fills: list.length,
      partial: list.filter((r) => r.wasPartialFill).length,
      slipMean: slips.length ? slips.reduce((a, b) => a + b, 0) / slips.length : null,
      slipP50: pct(slips, 0.5),
      slipP90: pct(slips, 0.9),
      latP50: pct(lats, 0.5),
      latP90: pct(lats, 0.9),
    });
  }
  return {
    groups,
    slippageBasis: engine ? 'engine' : 'recorded',
    latencyBasis: sendToFill ? 'sendToFill' : 'submitToFill',
  };
}
