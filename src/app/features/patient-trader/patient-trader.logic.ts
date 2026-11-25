import type {
  PatientTraderBoardQuery,
  PatientTraderHealth,
  PatientTraderMarketHealth,
  PatientTraderConfig,
  PatientTraderMarket,
  PatientTraderMode,
  PatientTraderOutcome,
  PatientTraderPlan,
  PatientTraderScenario,
} from './patient-trader.types';

/**
 * Pure logic for the Patient Trader cockpit — everything here is framework-free so it can be
 * tested without a component: parsing the engine's JSON blobs, the form's dirty check, spotting a
 * save that would start filing real signals, and the small formatters the panels share.
 */

// ── Outcomes ─────────────────────────────────────────────────────────────────

/** Parses an outcome blob, tolerating absence and malformed JSON. */
export function parseOutcome(json: string | null | undefined): PatientTraderOutcome | null {
  if (!json) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as PatientTraderOutcome;
  } catch {
    return null;
  }
}

const OUTCOME_WORDS: Record<string, string> = {
  hittp: 'hit target',
  takeprofit: 'hit target',
  hitsl: 'hit stop',
  stoploss: 'hit stop',
  breakeven: 'stopped at break-even',
  trailedstop: 'trailed stop',
  closedearly: 'closed early',
  mixed: 'mixed',
  entrynotreached: 'entry never reached',
  invalidatedbeforeentry: 'called off before entry',
  notscorable: 'could not be scored',
  nodata: 'no price data',
  expired: 'ran out of time',
  unresolved: 'still open at the end',
};

/** The engine's outcome code in plain words ("HitTP" → "hit target"). Unknown codes are split. */
export function outcomeWords(code: string | null | undefined): string {
  if (!code) return '';
  const known = OUTCOME_WORDS[code.replace(/[^a-z]/gi, '').toLowerCase()];
  if (known) return known;
  return code
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[-_]/g, ' ')
    .toLowerCase();
}

/** True when a number is present (null / undefined / NaN are "not measured"). */
export function hasNum(v: number | null | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** `+1.25R` / `-0.80R` / `0.00R`; '—' when absent. */
export function formatR(v: number | null | undefined, digits = 2): string {
  if (!hasNum(v)) return '—';
  const s = v.toFixed(digits);
  return `${v > 0 ? '+' : ''}${s}R`;
}

/** A plan outcome reduced to what the table shows. */
export interface OutcomeSummary {
  label: string;
  r: number | null;
  bestR: number | null;
  /** A real position settled it. */
  isTrade: boolean;
  /** Walked over the candles afterwards (no real position). */
  isReplay: boolean;
  /** "as written: hit target +2.00R" — only for real trades that carry it. */
  asWritten: string | null;
  note: string | null;
}

/** Reduces a plan's outcome blob to the table cell's contents. Null when there is no outcome. */
export function summariseOutcome(json: string | null | undefined): OutcomeSummary | null {
  const o = parseOutcome(json);
  if (!o || (!o.outcome && !hasNum(o.rMultiple))) return null;
  const source = (o.source ?? '').toLowerCase();
  const isTrade = source === 'trade';
  const isReplay = source === 'replay' || o.forgone === true;
  let asWritten: string | null = null;
  if (isTrade && o.asWritten && (o.asWritten.outcome || hasNum(o.asWritten.rMultiple))) {
    asWritten = [
      'as written:',
      outcomeWords(o.asWritten.outcome),
      hasNum(o.asWritten.rMultiple) ? formatR(o.asWritten.rMultiple) : '',
    ]
      .filter(Boolean)
      .join(' ');
  }
  return {
    label: outcomeWords(o.outcome),
    r: hasNum(o.rMultiple) ? o.rMultiple : null,
    bestR: hasNum(o.mfeR) ? o.mfeR : null,
    isTrade,
    isReplay,
    asWritten,
    note: o.note?.trim() || null,
  };
}

// ── Scenarios ────────────────────────────────────────────────────────────────

/** A scenario in one renderable shape, whichever engine wrote it. */
export interface ScenarioRow {
  kind: 'level' | 'reaction';
  /** The reason (Assistant) or the trigger (Classic). */
  text: string;
  /** Assistant only: "above 1.08500" — the price that wakes the market. */
  level: string | null;
  /** Assistant only: Up | Down | Flat. */
  direction: string | null;
  /** Assistant only: 0..1 when the analyst gave one. */
  probability: number | null;
  /** Classic only. */
  expectedReaction: string | null;
  myAction: string | null;
  invalidation: string | null;
}

/** Parses a scenario map, returning an empty list rather than throwing. */
export function parseScenarios(json: string | null | undefined): PatientTraderScenario[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed)
      ? (parsed.filter((x) => x && typeof x === 'object') as PatientTraderScenario[])
      : [];
  } catch {
    return [];
  }
}

const OP_WORDS: Record<string, string> = {
  above: 'above',
  below: 'below',
  gt: 'above',
  gte: 'above',
  lt: 'below',
  lte: 'below',
  '>': 'above',
  '>=': 'above',
  '<': 'below',
  '<=': 'below',
};

/** One scenario in renderable form. Null when it carries nothing to show. */
export function normaliseScenario(s: PatientTraderScenario): ScenarioRow | null {
  const text = (s.trigger ?? '').trim();
  const watch = s.watch;
  if (watch && hasNum(watch.value)) {
    const op = OP_WORDS[(watch.op ?? '').toLowerCase()] ?? watch.op ?? 'at';
    return {
      kind: 'level',
      text,
      level: `${op} ${watch.value}`,
      direction: s.direction?.trim() || null,
      probability: hasNum(s.probability) ? s.probability : null,
      expectedReaction: null,
      myAction: null,
      invalidation: null,
    };
  }
  const expectedReaction = s.expectedReaction?.trim() || null;
  const myAction = s.myAction?.trim() || null;
  const invalidation = s.invalidation?.trim() || null;
  const direction = s.direction?.trim() || null;
  if (!text && !expectedReaction && !myAction && !invalidation && !direction) return null;
  return {
    kind: 'reaction',
    text,
    level: null,
    direction,
    probability: hasNum(s.probability) ? s.probability : null,
    expectedReaction,
    myAction,
    invalidation,
  };
}

/** Parses and normalises a view's scenario map in one step. */
export function scenarioRows(json: string | null | undefined): ScenarioRow[] {
  return parseScenarios(json)
    .map(normaliseScenario)
    .filter((r): r is ScenarioRow => r !== null);
}

// ── Modes and the Live check ─────────────────────────────────────────────────

const MODE_RANK: Record<string, number> = { forecastonly: 0, planonly: 1, live: 2 };

function rank(mode: string | null | undefined): number {
  return MODE_RANK[(mode ?? '').toLowerCase()] ?? 0;
}

/** The mode a market actually runs in: its own when set, never further than the module's. */
export function effectiveMode(
  moduleMode: PatientTraderMode,
  market: Pick<PatientTraderMarket, 'mode'> | null | undefined,
): PatientTraderMode {
  const own = market?.mode;
  if (!own) return moduleMode;
  return rank(own) <= rank(moduleMode) ? own : moduleMode;
}

/** Symbols that file real signals under this config. */
export function liveMarkets(c: PatientTraderConfig | null | undefined): string[] {
  if (!c || !c.enabled) return [];
  return c.markets
    .filter((m) => m.enabled !== false && effectiveMode(c.mode, m) === 'Live')
    .map((m) => m.symbol.trim().toUpperCase());
}

/**
 * Markets the save would newly put into Live — the ones that start filing real signals. Covers
 * the module going Live, a market's own mode going Live, enabling while Live, and adding a market
 * to a Live module.
 */
export function newlyLiveMarkets(
  before: PatientTraderConfig | null | undefined,
  after: PatientTraderConfig,
): string[] {
  const was = new Set(liveMarkets(before));
  return liveMarkets(after).filter((s) => !was.has(s));
}

// ── Dirty check ──────────────────────────────────────────────────────────────

/** Fields the engine owns, which never make the form dirty. */
const NON_EDITABLE_KEYS = new Set(['version', 'defaultAnalysisInstruction']);

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as object).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v === undefined) continue;
      out[k] = stable(v);
    }
    return out;
  }
  return value;
}

function comparable(c: PatientTraderConfig): unknown {
  const copy: Record<string, unknown> = { ...c };
  for (const k of NON_EDITABLE_KEYS) delete copy[k];
  copy['markets'] = c.markets.map((m) => ({ ...m, mode: m.mode ?? null }));
  copy['analysisInstruction'] = (c.analysisInstruction ?? '').trim();
  return stable(copy);
}

/** True when the draft differs from the last loaded config in anything the operator can edit. */
export function isConfigDirty(
  loaded: PatientTraderConfig | null | undefined,
  draft: PatientTraderConfig | null | undefined,
): boolean {
  if (!loaded || !draft) return false;
  return JSON.stringify(comparable(loaded)) !== JSON.stringify(comparable(draft));
}

/** True when the instruction differs from the engine's built-in one. */
export function isCustomInstruction(c: PatientTraderConfig): boolean {
  const text = (c.analysisInstruction ?? '').trim();
  return text.length > 0 && text !== (c.defaultAnalysisInstruction ?? '').trim();
}

/**
 * Editable copy of a config, with the engine's built-in instruction filled in when none is saved,
 * so the box shows the text actually being sent rather than an empty field.
 */
export function withInstructionShown(c: PatientTraderConfig): PatientTraderConfig {
  const next = structuredClone(c);
  if (!next.analysisInstruction?.trim()) {
    next.analysisInstruction = next.defaultAnalysisInstruction ?? '';
  }
  return next;
}

/** The body the PUT sends: symbols normalised, engine-owned text dropped, `version` kept. */
export function toSavePayload(c: PatientTraderConfig): PatientTraderConfig {
  const payload = structuredClone(c);
  payload.markets = payload.markets
    .map((m) => ({ ...m, symbol: m.symbol.trim().toUpperCase(), mode: m.mode ?? null }))
    .filter((m) => m.symbol.length > 0);
  delete payload.defaultAnalysisInstruction;
  return payload;
}

// ── Formatters ───────────────────────────────────────────────────────────────

/** A price distance in pips (÷ pipSize), one decimal. '—' when absent or zero. */
export function toPips(
  distance: number | null | undefined,
  pipSize: number | null | undefined,
): string {
  if (!hasNum(distance) || distance <= 0 || !hasNum(pipSize) || pipSize <= 0) return '—';
  return (distance / pipSize).toFixed(1);
}

/**
 * "in 3h 05m" / "12m ago" / "just now". Exact enough for a cockpit and stable under a 30-second
 * clock tick (no seconds once past a minute).
 */
export function relativeTime(iso: string | null | undefined, nowMs: number): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const diff = t - nowMs;
  const abs = Math.abs(diff);
  if (abs < 60_000) return 'just now';
  const mins = Math.round(abs / 60_000);
  let text: string;
  if (mins < 60) text = `${mins}m`;
  else if (mins < 48 * 60) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    text = m ? `${h}h ${String(m).padStart(2, '0')}m` : `${h}h`;
  } else text = `${Math.round(mins / 1440)}d`;
  return diff > 0 ? `in ${text}` : `${text} ago`;
}

/** True when the ISO time is in the past (an absent time is not overdue). */
export function isPast(iso: string | null | undefined, nowMs: number): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  return !Number.isNaN(t) && t < nowMs;
}

/** Samples below this are labelled "too few to judge". */
export const MIN_SAMPLE = 20;

/** A refusal reason code in plain words ("StopTooTight" → "stop too tight"). */
export function codeWords(code: string | null | undefined): string {
  if (!code) return '';
  return code
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .toLowerCase()
    .trim();
}

// ── Plans ────────────────────────────────────────────────────────────────────

/** A plan the agent or a check turned down, rather than one that ran. */
export function isRefused(plan: Pick<PatientTraderPlan, 'status'>): boolean {
  return plan.status === 'Declined' || plan.status === 'Rejected';
}

/** "refused before arming" / "refused when it fired" — null when the plan was not refused. */
export function refusalStage(
  plan: Pick<PatientTraderPlan, 'status' | 'refusedBeforeArming'>,
): string | null {
  if (plan.status !== 'Rejected') return null;
  return plan.refusedBeforeArming ? 'refused before arming' : 'refused when it fired';
}

/** Reward:risk from the plan's own levels when the stored figure is missing. */
export function planRewardRisk(
  p: Pick<PatientTraderPlan, 'rewardRisk' | 'entryPrice' | 'stopLoss' | 'takeProfit'>,
): number | null {
  if (hasNum(p.rewardRisk) && p.rewardRisk > 0) return p.rewardRisk;
  const risk = Math.abs(p.entryPrice - p.stopLoss);
  const reward = Math.abs(p.takeProfit - p.entryPrice);
  if (!(risk > 0) || !(reward > 0)) return null;
  return reward / risk;
}

// ── Plan filters in the URL ──────────────────────────────────────────────────

export interface PlanFilters {
  status: string[];
  direction: string | null;
  rejectionCode: string | null;
  symbol: string | null;
  /** Zero-based page. */
  page: number;
}

export const EMPTY_PLAN_FILTERS: PlanFilters = {
  status: [],
  direction: null,
  rejectionCode: null,
  symbol: null,
  page: 0,
};

/** Query-param names the plan filters live under. */
export const PLAN_FILTER_PARAMS = {
  status: 'pstatus',
  direction: 'pdir',
  rejectionCode: 'pcode',
  symbol: 'psym',
  page: 'ppage',
} as const;

/** Reads plan filters from query params (tolerant of junk). */
export function filtersFromParams(get: (name: string) => string | null): PlanFilters {
  const clean = (v: string | null) => (v && v.trim() ? v.trim() : null);
  const page = Number.parseInt(get(PLAN_FILTER_PARAMS.page) ?? '', 10);
  return {
    status: (get(PLAN_FILTER_PARAMS.status) ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    direction: clean(get(PLAN_FILTER_PARAMS.direction)),
    rejectionCode: clean(get(PLAN_FILTER_PARAMS.rejectionCode)),
    symbol: clean(get(PLAN_FILTER_PARAMS.symbol))?.toUpperCase() ?? null,
    page: Number.isFinite(page) && page > 0 ? page : 0,
  };
}

/** Query params for the filters — null removes a param when merged. */
export function filtersToParams(f: PlanFilters): Record<string, string | null> {
  return {
    [PLAN_FILTER_PARAMS.status]: f.status.length ? f.status.join(',') : null,
    [PLAN_FILTER_PARAMS.direction]: f.direction,
    [PLAN_FILTER_PARAMS.rejectionCode]: f.rejectionCode,
    [PLAN_FILTER_PARAMS.symbol]: f.symbol,
    [PLAN_FILTER_PARAMS.page]: f.page > 0 ? String(f.page) : null,
  };
}

/** The board request for the current filters, page size and OCO focus. */
export function boardQuery(
  f: PlanFilters,
  pageSize: number,
  ocoGroupId: string | null,
): PatientTraderBoardQuery {
  // An OCO focus shows every leg of one group, whatever the filters say.
  if (ocoGroupId) return { limit: 200, offset: 0, ocoGroupId };
  return {
    limit: pageSize,
    offset: f.page * pageSize,
    status: f.status,
    direction: f.direction,
    rejectionCode: f.rejectionCode,
    symbol: f.symbol,
  };
}

/** Builds the board query string (no leading '?'). */
export function boardQueryString(q: PatientTraderBoardQuery): string {
  const p = new URLSearchParams();
  p.set('limit', String(q.limit));
  if (q.offset) p.set('offset', String(q.offset));
  if (q.ocoGroupId) p.set('ocoGroupId', q.ocoGroupId);
  if (q.status?.length) p.set('status', q.status.join(','));
  if (q.direction) p.set('direction', q.direction);
  if (q.rejectionCode) p.set('rejectionCode', q.rejectionCode);
  if (q.symbol) p.set('symbol', q.symbol);
  return p.toString();
}

// ── Cumulative-R line ────────────────────────────────────────────────────────

export interface LinePath {
  /** SVG path `d` for the line. */
  d: string;
  /** y of the zero line (the range always includes zero). */
  zeroY: number;
  min: number;
  max: number;
}

/** Scales a series into an SVG path of the given size (y grows down). Null under two points. */
export function linePath(
  values: readonly number[],
  width: number,
  height: number,
  pad = 2,
): LinePath | null {
  if (values.length < 2) return null;
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const span = max - min || 1;
  const x = (i: number) => pad + (i * (width - 2 * pad)) / (values.length - 1);
  const y = (v: number) => pad + ((max - v) * (height - 2 * pad)) / span;
  const d = values
    .map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`)
    .join(' ');
  return { d, zeroY: Number(y(0).toFixed(1)), min, max };
}

// ── Health ───────────────────────────────────────────────────────────────────

export type MarketHealthState = 'ok' | 'paused' | 'overdue' | 'stuck' | 'off';

/** Grace before a missed "next look" reads as overdue — a run takes a few minutes. */
export const OVERDUE_GRACE_MS = 15 * 60_000;

/**
 * One market's state in a word, so "is it stuck" reads at a glance:
 *  - stuck: the latest analysis ran and wrote no view;
 *  - paused: off for a known reason (module off, kill switch, market closed, blackout, spend cap);
 *  - overdue: the next look is well past due with no known reason;
 *  - ok: otherwise.
 */
export function marketHealthState(
  m: PatientTraderMarketHealth,
  h: Pick<PatientTraderHealth, 'enabled' | 'killSwitchActive' | 'respectKillSwitch' | 'spend'>,
  nowMs: number,
): { state: MarketHealthState; reason: string } {
  if (!h.enabled) return { state: 'off', reason: 'module switched off' };
  const lastView = m.lastViewAtUtc ? Date.parse(m.lastViewAtUtc) : NaN;
  const lastEmpty = m.lastRunWithoutViewAtUtc ? Date.parse(m.lastRunWithoutViewAtUtc) : NaN;
  if (!Number.isNaN(lastEmpty) && (Number.isNaN(lastView) || lastEmpty > lastView)) {
    return { state: 'stuck', reason: 'last analysis wrote no view' };
  }
  if (h.killSwitchActive && h.respectKillSwitch)
    return { state: 'paused', reason: 'kill switch on' };
  if (m.closedUntilUtc && !isPast(m.closedUntilUtc, nowMs)) {
    return { state: 'paused', reason: 'market closed' };
  }
  if (m.blackoutUntilUtc && !isPast(m.blackoutUntilUtc, nowMs)) {
    return { state: 'paused', reason: 'news blackout' };
  }
  if (h.spend.dailyCapReached) return { state: 'paused', reason: 'daily spend cap reached' };
  if (m.marketCapReached) return { state: 'paused', reason: 'market spend cap reached' };
  if (m.nextDueAtUtc) {
    const due = Date.parse(m.nextDueAtUtc);
    if (!Number.isNaN(due) && nowMs - due > OVERDUE_GRACE_MS) {
      return { state: 'overdue', reason: 'next look is overdue' };
    }
  }
  return { state: 'ok', reason: 'running' };
}

/** Upcoming releases as lines (the engine sends one multi-line string). */
export function catalystLines(text: string | null | undefined): string[] {
  return (text ?? '')
    .split(/\r?\n/)
    .map((l) => l.replace(/^[-•*]\s*/, '').trim())
    .filter(Boolean);
}
