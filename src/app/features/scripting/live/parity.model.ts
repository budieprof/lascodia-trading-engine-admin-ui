import { NA, MINUS, formatDateTime, formatPrice } from '../report/report-format';
import type {
  ParityDistribution,
  ParityDrift,
  ParityLiveSummary,
  ParityReconcilePair,
  ParityReconcileStatus,
  ScriptParityReconcile,
  ScriptParitySession,
  ScriptParitySummary,
} from '../api/scripting-api.types';

/**
 * View model of the Live tab's parity panel (BT-I3 / PE-I2): the engine's emulator trade ledger
 * compared with the bound accounts' fills (the rolling summary) and with a backtest of a session's
 * span on the same script (the reconcile). Pure — no Angular.
 *
 * Every slippage the engine sends is SIGNED for the strategy: positive = worse (a buy filled higher,
 * a sell lower). Texts say "worse" / "better" in words so a sign is never the only cue.
 */

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function int(v: unknown): number {
  return num(v) ?? 0;
}

function text(v: unknown): string {
  return typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v);
}

function textOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** An ISO UTC time as unix ms (a value without a zone is UTC); null when absent. */
export function isoMs(v: string | null | undefined): number | null {
  if (!v) return null;
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(v) ? v : `${v}Z`);
  return Number.isFinite(t) ? t : null;
}

const EMPTY_DIST: ParityDistribution = {
  n: 0,
  mean: null,
  median: null,
  p10: null,
  p90: null,
  min: null,
  max: null,
  positiveShare: null,
};

export function distribution(raw: unknown): ParityDistribution {
  if (!isObject(raw)) return { ...EMPTY_DIST };
  return {
    n: int(raw['n']),
    mean: num(raw['mean']),
    median: num(raw['median']),
    p10: num(raw['p10']),
    p90: num(raw['p90']),
    min: num(raw['min']),
    max: num(raw['max']),
    positiveShare: num(raw['positiveShare']),
  };
}

/** `GET …/parity/summary` read defensively (null when it is not an object). */
export function normalizeParitySummary(raw: unknown): ScriptParitySummary | null {
  if (!isObject(raw)) return null;
  const t = isObject(raw['trades']) ? raw['trades'] : {};
  const l = isObject(raw['live']) ? raw['live'] : {};
  const p = isObject(raw['paper']) ? raw['paper'] : {};
  const d = isObject(raw['drift']) ? raw['drift'] : {};
  return {
    strategyId: int(raw['strategyId']),
    symbol: text(raw['symbol']),
    timeframe: text(raw['timeframe']),
    fromUtc: text(raw['fromUtc']),
    toUtc: text(raw['toUtc']),
    windowDays: int(raw['windowDays']),
    pipSize: num(raw['pipSize']) ?? 0.0001,
    currentScriptRevision: textOrNull(raw['currentScriptRevision']),
    sessions: int(raw['sessions']),
    trades: {
      total: int(t['total']),
      closed: int(t['closed']),
      live: int(t['live']),
      paper: int(t['paper']),
      exitsOnly: int(t['exitsOnly']),
      catchUp: int(t['catchUp']),
      signalSent: int(t['signalSent']),
      notSent: int(t['notSent']),
      paperBlocked: int(t['paperBlocked']),
      failed: int(t['failed']),
    },
    live: {
      emulatorTrades: int(l['emulatorTrades']),
      tradesSent: int(l['tradesSent']),
      tradesFilled: int(l['tradesFilled']),
      tradesMissed: int(l['tradesMissed']),
      accountFills: int(l['accountFills']),
      closedRoundTrips: int(l['closedRoundTrips']),
      expectedR: distribution(l['expectedR']),
      realisedR: distribution(l['realisedR']),
      rGap: distribution(l['rGap']),
      entrySlippagePips: distribution(l['entrySlippagePips']),
      entrySlippagePipsLong: distribution(l['entrySlippagePipsLong']),
      entrySlippagePipsShort: distribution(l['entrySlippagePipsShort']),
      exitSlippagePips: distribution(l['exitSlippagePips']),
      exitSlippagePipsLong: distribution(l['exitSlippagePipsLong']),
      exitSlippagePipsShort: distribution(l['exitSlippagePipsShort']),
      entryLatencyMs: distribution(l['entryLatencyMs']),
      exitLatencyMs: distribution(l['exitLatencyMs']),
    },
    paper: {
      trades: int(p['trades']),
      closed: int(p['closed']),
      expectedR: distribution(p['expectedR']),
    },
    drift: {
      status: text(d['status']) || 'noLiveTrades',
      reasons: strings(d['reasons']),
      minTrades: int(d['minTrades']),
      maxRGapPerTrade: num(d['maxRGapPerTrade']) ?? 0,
      maxSlippagePips: num(d['maxSlippagePips']) ?? 0,
      alertActive: d['alertActive'] === true,
      alertLastTriggeredAtUtc: textOrNull(d['alertLastTriggeredAtUtc']),
    },
  };
}

export function normalizeParitySessions(raw: unknown): ScriptParitySession[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isObject).map((s) => ({
    id: int(s['id']),
    scriptRevision: text(s['scriptRevision']),
    isCurrentRevision: s['isCurrentRevision'] === true,
    symbol: text(s['symbol']),
    timeframe: text(s['timeframe']),
    warmupFromUtc: textOrNull(s['warmupFromUtc']),
    liveFromUtc: text(s['liveFromUtc']),
    startedAtUtc: text(s['startedAtUtc']),
    lastStartedAtUtc: text(s['lastStartedAtUtc']),
    restarts: int(s['restarts']),
    stoppedAtUtc: textOrNull(s['stoppedAtUtc']),
    endedAtUtc: textOrNull(s['endedAtUtc']),
    endReason: textOrNull(s['endReason']),
    trades: int(s['trades']),
    liveTrades: int(s['liveTrades']),
    paperTrades: int(s['paperTrades']),
    lastReconcileRunId: num(s['lastReconcileRunId']),
  }));
}

function side(raw: unknown): ParityReconcilePair['backtest'] {
  if (!isObject(raw)) return null;
  return {
    entryTimeUtc: text(raw['entryTimeUtc']),
    entryPrice: num(raw['entryPrice']) ?? 0,
    exitTimeUtc: textOrNull(raw['exitTimeUtc']),
    exitPrice: num(raw['exitPrice']),
    lots: num(raw['lots']) ?? 0,
    initialStopPrice: num(raw['initialStopPrice']),
    r: num(raw['r']),
    mode: textOrNull(raw['mode']),
    outcome: textOrNull(raw['outcome']),
    tradeKey: num(raw['tradeKey']),
    signalId: num(raw['signalId']),
    exitKind: textOrNull(raw['exitKind']),
  };
}

/** `GET …/parity/reconcile/{runId}` read defensively. */
export function normalizeParityReconcile(raw: unknown): ScriptParityReconcile | null {
  if (!isObject(raw)) return null;
  const s = isObject(raw['session']) ? raw['session'] : {};
  const sum = isObject(raw['summary']) ? raw['summary'] : null;
  return {
    backtestRunId: int(raw['backtestRunId']),
    sessionId: int(raw['sessionId']),
    status: text(raw['status']) || 'queued',
    error: textOrNull(raw['error']),
    queuedAtUtc: textOrNull(raw['queuedAtUtc']),
    completedAtUtc: textOrNull(raw['completedAtUtc']),
    session: {
      scriptRevision: text(s['scriptRevision']),
      isCurrentRevision: s['isCurrentRevision'] === true,
      warmupFromUtc: textOrNull(s['warmupFromUtc']),
      liveFromUtc: text(s['liveFromUtc']),
      endedAtUtc: textOrNull(s['endedAtUtc']),
      stoppedAtUtc: textOrNull(s['stoppedAtUtc']),
      restarts: int(s['restarts']),
    },
    fromUtc: text(raw['fromUtc']),
    toUtc: text(raw['toUtc']),
    compareFromUtc: text(raw['compareFromUtc']),
    compareToUtc: text(raw['compareToUtc']),
    pipSize: num(raw['pipSize']) ?? 0.0001,
    matchToleranceBars: int(raw['matchToleranceBars']),
    summary: sum
      ? {
          backtestTrades: int(sum['backtestTrades']),
          sessionTrades: int(sum['sessionTrades']),
          matched: int(sum['matched']),
          missing: int(sum['missing']),
          extra: int(sum['extra']),
          matchedWithAccounts: int(sum['matchedWithAccounts']),
          entrySlippagePips: distribution(sum['entrySlippagePips']),
          exitSlippagePips: distribution(sum['exitSlippagePips']),
          rDifference: distribution(sum['rDifference']),
          accountEntrySlippagePips: distribution(sum['accountEntrySlippagePips']),
          accountExitSlippagePips: distribution(sum['accountExitSlippagePips']),
          accountRDifference: distribution(sum['accountRDifference']),
        }
      : null,
    pairs: Array.isArray(raw['pairs'])
      ? raw['pairs'].filter(isObject).map((p) => ({
          status: text(p['status']),
          direction: text(p['direction']) || 'long',
          entryId: text(p['entryId']),
          backtest: side(p['backtest']),
          session: side(p['session']),
          accounts: Array.isArray(p['accounts'])
            ? p['accounts'].filter(isObject).map((a) => ({
                accountId: int(a['accountId']),
                orderId: int(a['orderId']),
                positionId: num(a['positionId']),
                orderStatus: text(a['orderStatus']),
                lots: num(a['lots']) ?? 0,
                entryPrice: num(a['entryPrice']),
                entryTimeUtc: textOrNull(a['entryTimeUtc']),
                exitPrice: num(a['exitPrice']),
                exitTimeUtc: textOrNull(a['exitTimeUtc']),
                entrySlippagePips: num(a['entrySlippagePips']),
                exitSlippagePips: num(a['exitSlippagePips']),
                rDifference: num(a['rDifference']),
              }))
            : [],
          entrySlippagePips: num(p['entrySlippagePips']),
          exitSlippagePips: num(p['exitSlippagePips']),
          rDifference: num(p['rDifference']),
          note: textOrNull(p['note']),
        }))
      : [],
    notes: strings(raw['notes']),
  };
}

// ── texts ─────────────────────────────────────────────────────────────────────

function fixed(v: number, decimals: number): string {
  return Math.abs(v).toFixed(decimals);
}

/** A signed slippage in pips: "1.2 pips worse", "0.4 pips better", "even". */
export function slippageText(pips: number | null | undefined, decimals = 1): string {
  if (pips === null || pips === undefined || !Number.isFinite(pips)) return NA;
  if (Math.abs(pips) < 0.5 * Math.pow(10, -decimals)) return 'even';
  const unit = fixed(pips, decimals) === (1).toFixed(decimals) ? 'pip' : 'pips';
  return `${fixed(pips, decimals)} ${unit} ${pips > 0 ? 'worse' : 'better'}`;
}

/** An R value with its sign: "+1.60 R", "−0.40 R". */
export function rText(v: number | null | undefined, decimals = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return NA;
  if (Math.abs(v) < 0.5 * Math.pow(10, -decimals)) return `${(0).toFixed(decimals)} R`;
  return `${v < 0 ? MINUS : '+'}${fixed(v, decimals)} R`;
}

/** A latency: "350 ms", "2.0 s", "3.1 min". */
export function latencyText(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return NA;
  const sign = ms < 0 ? MINUS : '';
  const a = Math.abs(ms);
  if (a < 1000) return `${sign}${Math.round(a)} ms`;
  if (a < 120_000) return `${sign}${(a / 1000).toFixed(1)} s`;
  return `${sign}${(a / 60_000).toFixed(1)} min`;
}

/** A share 0–1 as "67%". */
export function shareText(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v) ? NA : `${Math.round(v * 100)}%`;
}

/**
 * The decimals a symbol quotes at, from its pip size: one more than the pip's (EURUSD 0.0001 → 5,
 * USDJPY 0.01 → 3, gold 0.1 → 2), clamped to 0–6; 5 when the pip size is unusable.
 */
export function pricePrecision(pipSize: number | null | undefined): number {
  if (pipSize === null || pipSize === undefined || !Number.isFinite(pipSize) || pipSize <= 0)
    return 5;
  return Math.min(6, Math.max(0, Math.round(-Math.log10(pipSize)) + 1));
}

export type ParityTone = 'success' | 'warning' | 'error' | 'neutral';

export interface DriftView {
  tone: ParityTone;
  title: string;
  lines: string[];
}

/** What the drift judgement (the alarm's own) means, in words. */
export function driftView(drift: ParityDrift, live: ParityLiveSummary): DriftView {
  const lines: string[] = [];
  let view: DriftView;
  switch (drift.status) {
    case 'drifting':
      view = { tone: 'error', title: 'Live fills drift from the emulator', lines: drift.reasons };
      break;
    case 'ok':
      view = {
        tone: 'success',
        title: 'Live fills match the emulator within the limits',
        lines: [
          `Over ${live.closedRoundTrips} closed live trade${live.closedRoundTrips === 1 ? '' : 's'}: ` +
            `R gap ${rText(live.rGap.mean)} per trade (limit ${MINUS}${drift.maxRGapPerTrade.toFixed(2)} R), ` +
            `entries ${slippageText(live.entrySlippagePips.mean)}, exits ${slippageText(live.exitSlippagePips.mean)} ` +
            `(limit ${drift.maxSlippagePips.toFixed(1)} pips).`,
        ],
      };
      break;
    case 'insufficient':
      view = {
        tone: 'neutral',
        title: 'Too few closed live trades to judge yet',
        lines: [
          `The alarm judges once ${drift.minTrades} trades have closed on an account; ${live.closedRoundTrips} have so far.`,
        ],
      };
      break;
    default:
      view = {
        tone: 'neutral',
        title: 'No live trades in this window',
        lines: [
          'Paper trades fill at the emulator’s own prices, so only live trades show slippage.',
        ],
      };
  }
  if (drift.alertActive) {
    const at = isoMs(drift.alertLastTriggeredAtUtc);
    lines.push(
      `The drift alert is active${at === null ? '' : ` (last sent ${formatDateTime(at)} UTC)`}.`,
    );
  }
  return { ...view, lines: [...view.lines, ...lines] };
}

export type ParityMetricKind = 'slippage' | 'r' | 'rgap' | 'latency';

export interface ParityMetricRow {
  label: string;
  hint: string;
  kind: ParityMetricKind;
  dist: ParityDistribution;
}

/** The rows of the "live fills against the emulator" table. */
export function liveMetricRows(live: ParityLiveSummary): ParityMetricRow[] {
  return [
    {
      label: 'Entry slippage',
      hint: 'The account’s entry fill against the emulator’s.',
      kind: 'slippage',
      dist: live.entrySlippagePips,
    },
    { label: '· longs', hint: 'Buys.', kind: 'slippage', dist: live.entrySlippagePipsLong },
    { label: '· shorts', hint: 'Sells.', kind: 'slippage', dist: live.entrySlippagePipsShort },
    {
      label: 'Exit slippage',
      hint: 'The account’s close against the emulator’s volume-weighted exit.',
      kind: 'slippage',
      dist: live.exitSlippagePips,
    },
    { label: '· longs', hint: 'Closing sells.', kind: 'slippage', dist: live.exitSlippagePipsLong },
    {
      label: '· shorts',
      hint: 'Closing buys.',
      kind: 'slippage',
      dist: live.exitSlippagePipsShort,
    },
    {
      label: 'Expected R',
      hint: 'The emulator’s result per closed trade, in R (its risk at entry).',
      kind: 'r',
      dist: live.expectedR,
    },
    {
      label: 'Realised R',
      hint: 'The account’s result, measured against the emulator’s 1R.',
      kind: 'r',
      dist: live.realisedR,
    },
    {
      label: 'R gap',
      hint: 'Realised minus expected R: what execution cost per trade (negative is worse).',
      kind: 'rgap',
      dist: live.rGap,
    },
    {
      label: 'Entry latency',
      hint: 'From the emulator’s fill to the account’s.',
      kind: 'latency',
      dist: live.entryLatencyMs,
    },
    {
      label: 'Exit latency',
      hint: 'From the emulator’s exit to the account’s close.',
      kind: 'latency',
      dist: live.exitLatencyMs,
    },
  ];
}

/** One statistic of a metric row, formatted for its kind. */
export function metricText(kind: ParityMetricKind, v: number | null): string {
  switch (kind) {
    case 'slippage':
      return slippageText(v);
    case 'latency':
      return latencyText(v);
    default:
      return rText(v);
  }
}

/**
 * The share of fills that were worse for the strategy — slippage only, where positive IS worse. (The
 * summary counts values above zero; for an R gap that would be the share that did BETTER, and an
 * even trade is neither, so no share is claimed there.)
 */
export function worseShareText(kind: ParityMetricKind, dist: ParityDistribution): string {
  if (kind !== 'slippage' || dist.n === 0 || dist.positiveShare === null) return NA;
  return shareText(dist.positiveShare);
}

/** A session in the reconcile picker: when it ran, its revision, whether it still runs. */
export function sessionLabel(s: ScriptParitySession): string {
  const live = isoMs(s.liveFromUtc);
  const ended = isoMs(s.endedAtUtc);
  const stopped = isoMs(s.stoppedAtUtc);
  const state =
    ended !== null
      ? `ended ${formatDateTime(ended)}`
      : stopped !== null
        ? `stopped ${formatDateTime(stopped)}`
        : 'running';
  const revision = `${s.scriptRevision.slice(0, 8) || '?'}${s.isCurrentRevision ? ', the current script' : ', an earlier script'}`;
  return (
    `Session ${s.id} — live from ${live === null ? NA : formatDateTime(live)} UTC, ${state}; ` +
    `${s.trades} trade${s.trades === 1 ? '' : 's'}; revision ${revision}`
  );
}

/** Whether a reconcile is finished (nothing more to poll for). */
export function reconcileDone(status: ParityReconcileStatus | null | undefined): boolean {
  return status === 'completed' || status === 'failed';
}

export function reconcileStatusText(r: ScriptParityReconcile): string {
  switch (r.status) {
    case 'queued':
      return `Backtest #${r.backtestRunId} is queued.`;
    case 'running':
      return `Backtest #${r.backtestRunId} is running.`;
    case 'failed':
      return `Backtest #${r.backtestRunId} failed: ${r.error ?? 'no reason given'}.`;
    default:
      return `Backtest #${r.backtestRunId} finished${
        isoMs(r.completedAtUtc) !== null ? ` ${formatDateTime(isoMs(r.completedAtUtc))} UTC` : ''
      }.`;
  }
}

export const PAIR_STATUS_LABEL: Readonly<Record<string, string>> = {
  matched: 'Matched',
  missing: 'Backtest only',
  extra: 'Session only',
};

export interface PairView {
  status: string;
  statusLabel: string;
  timeText: string;
  direction: string;
  backtestText: string;
  sessionText: string;
  entryText: string;
  exitText: string;
  rText: string;
  accounts: string[];
  note: string | null;
}

function sideText(
  s: ParityReconcilePair['backtest'],
  decimals: number,
  extra?: string | null,
): string {
  if (!s) return NA;
  const exit = s.exitPrice === null ? 'open' : formatPrice(s.exitPrice, decimals);
  const r = s.r === null ? '' : ` (${rText(s.r)})`;
  return `${formatPrice(s.entryPrice, decimals)} → ${exit}${r}${extra ? ` · ${extra}` : ''}`;
}

/** One reconcile row as the table shows it. */
export function pairView(
  p: ParityReconcilePair,
  decimals: number,
  accountName: (id: number) => string = (id) => `Account #${id}`,
): PairView {
  const time = isoMs(p.backtest?.entryTimeUtc ?? p.session?.entryTimeUtc ?? null);
  return {
    status: p.status,
    statusLabel: PAIR_STATUS_LABEL[p.status] ?? p.status,
    timeText: time === null ? NA : formatDateTime(time),
    direction: p.direction === 'short' ? 'Short' : 'Long',
    backtestText: sideText(p.backtest, decimals),
    sessionText: sideText(p.session, decimals, p.session?.mode ?? null),
    entryText: p.status === 'matched' ? slippageText(p.entrySlippagePips) : NA,
    exitText: p.status === 'matched' ? slippageText(p.exitSlippagePips) : NA,
    rText: p.status === 'matched' ? rText(p.rDifference) : NA,
    accounts: p.accounts.map((a) => {
      const exit = a.exitPrice === null ? 'still open' : formatPrice(a.exitPrice, decimals);
      const parts = [
        a.entrySlippagePips === null ? null : `in ${slippageText(a.entrySlippagePips)}`,
        a.exitSlippagePips === null ? null : `out ${slippageText(a.exitSlippagePips)}`,
        a.rDifference === null ? null : `${rText(a.rDifference)} vs the backtest`,
      ].filter((x): x is string => x !== null);
      const entry = a.entryPrice === null ? NA : formatPrice(a.entryPrice, decimals);
      return `${accountName(a.accountId)}: ${entry} → ${exit}${parts.length ? ` (${parts.join(', ')})` : ''}`;
    }),
    note: p.note,
  };
}
