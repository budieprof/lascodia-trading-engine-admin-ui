import { formatLots } from '@shared/pine-chart/core/quantity';

import { toCamelCase } from '../report/strategy-report.model';
import {
  NA,
  formatDateTime,
  formatMoney,
  formatNumber,
  formatPrice,
  formatUnits,
} from '../report/report-format';
import { parseTradeOrigin } from '../report/trade-origin';
import type {
  ScriptDivergence,
  ScriptLiveClosedTrade,
  ScriptLiveMode,
  ScriptLiveStatus,
  ScriptLiveWarning,
  ScriptOrphanedPosition,
} from '../api/scripting-api.types';
import type { TradeOrigin } from '../report/trade-origin';

/**
 * View model for `GET strategy/{id}/script/live`. The contract fixes the top-level fields; the
 * position, open trades and pending orders are the emulator's own state objects and are read
 * defensively — known fields get proper formatting and order, anything else is still shown.
 *
 * Two kinds of quantity meet on the live tab: the emulator's, in Pine units of the underlying
 * (100,000 units = one EURUSD lot), and the bound accounts' positions, in broker lots. Every
 * quantity is printed with its unit so they are never read as the same number.
 */

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function camelShallow(o: Json): Json {
  const out: Json = {};
  for (const [k, v] of Object.entries(o)) out[toCamelCase(k)] = v;
  return out;
}

function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '' && !['NaN', 'Infinity', '-Infinity'].includes(v)) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function text(v: unknown): string {
  return typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v);
}

function orphanedPosition(p: Json): ScriptOrphanedPosition {
  const account = p['accountId'];
  return {
    positionId: num(p['positionId']),
    accountId: typeof account === 'number' || typeof account === 'string' ? account : null,
    symbol: text(p['symbol']),
    direction: text(p['direction']).toLowerCase(),
    lots: num(p['lots']),
    entryId: typeof p['entryId'] === 'string' ? (p['entryId'] as string) : null,
    stopLoss: num(p['stopLoss']),
    takeProfit: num(p['takeProfit']),
    status: text(p['status']),
    orphanedAtUtc: text(p['orphanedAtUtc']),
  };
}

function closedTrade(t: Json): ScriptLiveClosedTrade {
  return {
    tradeKey: num(t['tradeKey']),
    entryId: text(t['entryId']),
    direction: text(t['direction']).toLowerCase(),
    qty: num(t['qty']),
    lots: num(t['lots']),
    entryPrice: num(t['entryPrice']),
    entryTimeMs: num(t['entryTimeMs']),
    exitPrice: num(t['exitPrice']),
    exitTimeMs: num(t['exitTimeMs']),
    exitLeg: text(t['exitLeg']),
    exitComment: text(t['exitComment']),
    profit: num(t['profit']),
    stopLoss: num(t['stopLoss']),
    takeProfit: num(t['takeProfit']),
    origin: parseTradeOrigin(t['origin']),
  };
}

/** An ISO time (or unix ms) as unix ms; null when absent or unreadable. */
function timeMs(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string' || !v.trim()) return null;
  // The engine's DateTimes are UTC; a value without a zone designator is read as UTC too.
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(v) ? v : `${v}Z`);
  return Number.isFinite(t) ? t : null;
}

function warning(w: Json): ScriptLiveWarning {
  return {
    code: text(w['code']),
    severity: text(w['severity']).toLowerCase() || 'warning',
    message: text(w['message']),
    line: num(w['line']) ?? 0,
    column: num(w['column']) ?? 0,
  };
}

/** Normalises the live payload's casing and container types. Null when it is not an object. */
export function normalizeLiveStatus(raw: unknown): ScriptLiveStatus | null {
  if (!isObject(raw)) return null;
  const o = camelShallow(raw);
  const rows = (v: unknown): Json[] =>
    Array.isArray(v) ? v.filter(isObject).map(camelShallow) : [];
  return {
    status: typeof o['status'] === 'string' ? (o['status'] as string) : '',
    reason: text(o['reason']),
    mode: text(o['mode']) || 'none',
    lastHeartbeatMs: timeMs(o['lastHeartbeatUtc']),
    startedAtMs: timeMs(o['startedAtUtc']),
    stateAtMs: timeMs(o['stateAtUtc']),
    warnings: rows(o['warnings']).map(warning),
    lastBarTimeMs: num(o['lastBarTimeMs']),
    position: isObject(o['position']) ? camelShallow(o['position']) : null,
    openTrades: rows(o['openTrades']),
    closedTrades: rows(o['closedTrades']).map(closedTrade),
    pendingOrders: rows(o['pendingOrders']),
    equity: isObject(o['equity']) ? camelShallow(o['equity']) : num(o['equity']),
    report: o['report'] ?? null,
    divergences: rows(o['divergences']).map(
      (d): ScriptDivergence => ({
        timeUtc:
          typeof d['timeUtc'] === 'string' ? (d['timeUtc'] as string) : String(d['timeUtc'] ?? ''),
        accountId:
          typeof d['accountId'] === 'number' || typeof d['accountId'] === 'string'
            ? (d['accountId'] as number | string)
            : null,
        kind: typeof d['kind'] === 'string' ? (d['kind'] as string) : String(d['kind'] ?? ''),
        detail:
          typeof d['detail'] === 'string'
            ? (d['detail'] as string)
            : JSON.stringify(d['detail'] ?? ''),
      }),
    ),
    orphanedPositions: rows(o['orphanedPositions']).map(orphanedPosition),
  };
}

export type LiveTone = 'success' | 'info' | 'neutral' | 'error';

/** Colour family for the session status (the text itself is always shown). */
export function liveStatusTone(status: string): LiveTone {
  const s = status.toLowerCase();
  if (/(error|fault|fail|halt|crash|diverg)/.test(s)) return 'error';
  if (/(warm|start|catch|restor|load|pending|sync)/.test(s)) return 'info';
  if (/(run|live|active|ok|healthy)/.test(s)) return 'success';
  return 'neutral';
}

/** "Position avg price" from `positionAvgPrice`. */
export function humanize(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  const withAcronyms = spaced
    .replace(/\bpn l\b/g, 'P&L')
    .replace(/\bpnl\b/g, 'P&L')
    .replace(/\bid\b/g, 'ID')
    .replace(/\bsl\b/g, 'SL')
    .replace(/\btp\b/g, 'TP');
  return withAcronyms.charAt(0).toUpperCase() + withAcronyms.slice(1);
}

/**
 * Formats an emulator field by what its name says it holds. The emulator's quantities (qty, size,
 * contracts) are Pine units — "10,000 units"; `lots` is the engine's conversion of one of them to
 * broker lots (DEC-18) — "0.10 lots".
 */
export function formatLiveValue(
  key: string,
  value: unknown,
  currency = '',
  priceDecimals = 5,
): string {
  if (value === null || value === undefined || value === '') return NA;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'string') {
    const n = num(value);
    if (n === null || !/(price|qty|size|lots|pnl|profit|equity|time|commission)/i.test(key))
      return value;
    value = n;
  }
  if (typeof value !== 'number')
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  const k = key.toLowerCase();
  if (k.endsWith('time') || k.endsWith('timems') || k.endsWith('timeutc') || k === 'time') {
    return value > 1e11 ? `${formatDateTime(value)} UTC` : formatNumber(value, 0);
  }
  // `takeProfit` is a price level, not an amount — tested before the money keys ("profit").
  if (/(price|stop|limit|target|avg|takeprofit)/.test(k)) return formatPrice(value, priceDecimals);
  if (/(pnl|profit|equity|commission|value|margin)/.test(k)) {
    return formatMoney(value, currency, { signed: /(pnl|profit)/.test(k) });
  }
  if (k.endsWith('lots')) return formatLots(value);
  if (/(qty|size|contracts)/.test(k)) return formatUnits(value);
  if (/(bar|index|count|seq|number)/.test(k)) return formatNumber(value, 0);
  return formatNumber(value, Number.isInteger(value) ? 0 : 4);
}

/** A quantity in broker lots: "0.50 lots", "1.00 lot". */
export function formatBrokerLots(lots: number | null): string {
  return lots === null ? NA : formatLots(lots);
}

const SIZE_KEYS = ['size', 'positionSize', 'netQty', 'qty', 'contracts'];
const PRICE_KEYS = ['avgPrice', 'averagePrice', 'positionAvgPrice', 'entryPrice', 'price'];
const PNL_KEYS = ['openPnL', 'openPnl', 'openProfit', 'unrealizedPnL', 'unrealizedPnl', 'profit'];

function firstNumber(o: Json, keys: readonly string[]): number | null {
  for (const k of keys) {
    const v = num(o[k]);
    if (v !== null) return v;
  }
  return null;
}

export interface PositionHeadline {
  side: 'long' | 'short' | 'flat' | 'unknown';
  text: string;
  pnl: number | null;
}

/**
 * "Long 100,000 units ≈ 1.00 lot @ 1.17000" / "Flat" from whatever the emulator's position object
 * carries: the size in Pine units, and in broker lots when the engine sends them (`lots`, DEC-18).
 */
export function positionHeadline(position: Json | null, priceDecimals = 5): PositionHeadline {
  if (!position) return { side: 'flat', text: 'Flat — no open position', pnl: null };
  const size = firstNumber(position, SIZE_KEYS);
  const lots = num(position['lots']);
  const price = firstNumber(position, PRICE_KEYS);
  const pnl = firstNumber(position, PNL_KEYS);
  const dir =
    typeof position['direction'] === 'string'
      ? (position['direction'] as string).toLowerCase()
      : '';
  if (size === null && !dir) return { side: 'unknown', text: 'Position', pnl };
  if (size === 0) return { side: 'flat', text: 'Flat — no open position', pnl: null };
  const side: PositionHeadline['side'] =
    size !== null ? (size > 0 ? 'long' : 'short') : dir.startsWith('s') ? 'short' : 'long';
  const qty = size !== null ? ` ${formatUnits(Math.abs(size))}` : '';
  const inLots = size !== null && lots !== null ? ` ≈ ${formatLots(Math.abs(lots))}` : '';
  const at = price !== null ? ` @ ${formatPrice(price, priceDecimals)}` : '';
  return { side, text: `${side === 'long' ? 'Long' : 'Short'}${qty}${inLots}${at}`, pnl };
}

export interface LiveColumn {
  key: string;
  label: string;
}

/**
 * Columns for a list of emulator objects: every primitive field any row carries, the preferred
 * ones first in the given order, the rest alphabetically. Nested objects are left out.
 */
export function deriveColumns(rows: readonly Json[], preferred: readonly string[]): LiveColumn[] {
  const keys = new Set<string>();
  for (const r of rows) {
    for (const [k, v] of Object.entries(r)) {
      if (v === null || typeof v !== 'object') keys.add(k);
    }
  }
  const ordered = [
    ...preferred.filter((k) => keys.has(k)),
    ...[...keys].filter((k) => !preferred.includes(k)).sort((a, b) => a.localeCompare(b)),
  ];
  return ordered.map((key) => ({ key, label: humanize(key) }));
}

/**
 * Preferred order of an open trade's fields: where it came from (warm-up replay, paper, live),
 * then the size in units, then in lots, then the rest.
 */
export const OPEN_TRADE_COLUMNS = [
  'origin',
  'entryId',
  'direction',
  'qty',
  'lots',
  'entryPrice',
  'entryTime',
  'entryTimeMs',
  'profit',
  'openPnL',
  'openProfit',
  'protectedStop',
  'stopLoss',
  'protectedTarget',
  'takeProfit',
  'entryComment',
];

export const PENDING_ORDER_COLUMNS = [
  'id',
  'command',
  'side',
  'type',
  'qty',
  'limit',
  'stop',
  'placedTime',
  'ocaName',
  'comment',
];

/** How old the last processed bar is, for the "stale" hint. */
export function barAgeMinutes(lastBarTimeMs: number | null, nowMs = Date.now()): number | null {
  if (lastBarTimeMs === null) return null;
  return Math.max(0, Math.round((nowMs - lastBarTimeMs) / 60_000));
}

export function formatAge(minutes: number | null): string {
  if (minutes === null) return '';
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const h = Math.floor(minutes / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

// ── Mode, heartbeat, warnings (PE-08) ────────────────────────────────────────

export interface LiveModeInfo {
  label: string;
  /** What the mode means for orders, in a sentence. */
  explanation: string;
  /** Real orders can reach a broker account. */
  sendsOrders: boolean;
}

const MODES: Record<string, LiveModeInfo> = {
  live: {
    label: 'Live',
    explanation:
      'The strategy is Active: the emulator’s fills are sent as real orders to its enabled bound accounts (lots × each binding’s multiplier) — to no account when none is bound; the reason says which.',
    sendsOrders: true,
  },
  paper: {
    label: 'Paper',
    explanation:
      'The strategy is paused in a paper stage (Paper trading or Approved): fills are recorded as paper executions and nothing reaches a broker.',
    sendsOrders: false,
  },
  exitsOnly: {
    label: 'Exits only',
    explanation:
      'The strategy is not active but still holds positions it opened: exits and stop / target changes keep reaching the accounts; new entries are not sent.',
    sendsOrders: true,
  },
  alertsOnly: {
    label: 'Alerts only',
    explanation:
      'An indicator script with enabled alert bindings: it runs for its outputs and alerts, and sends no orders.',
    sendsOrders: false,
  },
  none: {
    label: 'Not trading',
    explanation: 'The session is not running in a mode that trades.',
    sendsOrders: false,
  },
};

/** Plain words for a session's mode. */
export function liveModeInfo(mode: ScriptLiveMode | null | undefined): LiveModeInfo {
  const key = String(mode ?? '');
  const exact = MODES[key] ?? MODES[key.charAt(0).toLowerCase() + key.slice(1)];
  return exact ?? { label: key || 'Unknown', explanation: '', sendsOrders: false };
}

/** Minutes in an engine timeframe (`M1`…`D1`); 60 when unknown. */
export function timeframeMinutes(tf: string | null | undefined): number {
  switch ((tf ?? '').toUpperCase()) {
    case 'M1':
      return 1;
    case 'M5':
      return 5;
    case 'M15':
      return 15;
    case 'M30':
      return 30;
    case 'H1':
      return 60;
    case 'H4':
      return 240;
    case 'D1':
      return 1440;
    default:
      return 60;
  }
}

/**
 * The live worker advances a session on each closed bar of its timeframe; a heartbeat older than
 * two bars (at least 15 minutes) on a running session means it is not being advanced.
 */
export function heartbeatLate(
  heartbeatMs: number | null,
  timeframe: string | null | undefined,
  nowMs = Date.now(),
): boolean {
  if (heartbeatMs === null) return false;
  const limit = Math.max(15, 2 * timeframeMinutes(timeframe)) * 60_000;
  return nowMs - heartbeatMs > limit;
}

/**
 * What each finding means for the money (kept in one place so a renumbered code is one edit).
 * PS9301 matters most: the saved input was NOT applied, so the live session runs the input's
 * default — not what was backtested.
 */
export const LIVE_WARNING_HINTS: Readonly<Record<string, string>> = {
  PS9301:
    'A saved input value was not applied: the live session runs that input’s default, not the value you saved (and backtested). Fix the value on the script’s Inputs and save.',
  PS9302:
    'A saved input belongs to no input of the script (renamed or removed): it is ignored. Save the script again to clear it.',
  PS6202:
    'A request.security of a LOWER timeframe than the chart: live, it reads only the bars that closed, unlike a backtest with the bar magnifier.',
  PS6204:
    'A request of the chart’s own symbol and timeframe: it repeats data the script already has.',
};

/** The hint for a live finding, or null when it needs none beyond its message. */
export function liveWarningHint(code: string): string | null {
  return LIVE_WARNING_HINTS[code.toUpperCase()] ?? null;
}

/** The engine's own suggestion for a finding, else the hint its code gets here, else null. */
export function liveFindingHint(w: Pick<ScriptLiveWarning, 'code' | 'hint'>): string | null {
  const own = typeof w.hint === 'string' ? w.hint.trim() : '';
  return own || liveWarningHint(w.code);
}

/** "(line 12)", or "(line 12 of library a/b/1)" when the finding is in an imported library. */
export function liveFindingWhere(w: Pick<ScriptLiveWarning, 'line' | 'unit'>): string | null {
  if (!(w.line > 0)) return null;
  const unit = typeof w.unit === 'string' ? w.unit.trim() : '';
  return unit ? `(line ${w.line} of library ${unit})` : `(line ${w.line})`;
}

/** Findings that change what the session trades come first. */
export function sortLiveWarnings(warnings: readonly ScriptLiveWarning[]): ScriptLiveWarning[] {
  const rank = (w: ScriptLiveWarning) => (w.code === 'PS9301' ? 0 : w.code === 'PS9302' ? 1 : 2);
  return [...warnings].sort((a, b) => rank(a) - rank(b) || a.line - b.line);
}

// ── Paper / live statistics (PE-I2, part) ────────────────────────────────────

export interface OriginStats {
  origin: TradeOrigin;
  trades: number;
  wins: number;
  losses: number;
  breakeven: number;
  /** Sum of the trades' profit (account currency); null when no trade carries one. */
  netProfit: number | null;
  /** Gross profit ÷ gross loss; null without a loss. */
  profitFactor: number | null;
  /** Wins ÷ trades (0–1). */
  winRate: number | null;
  avgTrade: number | null;
  /** Mean R over the trades with a stop at entry (price-based R). */
  expectancyR: number | null;
  rTrades: number;
  /** Largest peak-to-trough fall of the cumulative profit, in money (positive). */
  maxDrawdown: number | null;
  firstEntryMs: number | null;
  lastExitMs: number | null;
}

/** A closed trade's result in R: (exit − entry) ÷ (entry − stop), signed by side; null without a stop. */
export function tradeR(t: ScriptLiveClosedTrade): number | null {
  if (t.entryPrice === null || t.exitPrice === null || t.stopLoss === null) return null;
  const risk = Math.abs(t.entryPrice - t.stopLoss);
  if (!(risk > 0)) return null;
  const side = t.direction === 'short' ? -1 : 1;
  return (side * (t.exitPrice - t.entryPrice)) / risk;
}

/**
 * The statistics of the trades a session took for real — paper or live, each on its own. Warm-up
 * trades (a replay of history before the session went live) are never part of them: the report's
 * own statistics include them, these do not.
 */
export function originStats(
  trades: readonly ScriptLiveClosedTrade[],
  origin: TradeOrigin,
): OriginStats {
  const mine = trades
    .filter((t) => t.origin === origin)
    .sort((a, b) => (a.exitTimeMs ?? 0) - (b.exitTimeMs ?? 0));
  let wins = 0;
  let losses = 0;
  let even = 0;
  let gross = 0;
  let grossLoss = 0;
  let money = 0;
  let withMoney = 0;
  let peak = 0;
  let cum = 0;
  let dd = 0;
  const rs: number[] = [];
  for (const t of mine) {
    const p = t.profit;
    if (p !== null) {
      withMoney++;
      money += p;
      if (p > 0) {
        wins++;
        gross += p;
      } else if (p < 0) {
        losses++;
        grossLoss -= p;
      } else even++;
      cum += p;
      peak = Math.max(peak, cum);
      dd = Math.max(dd, peak - cum);
    } else {
      const r = tradeR(t);
      if (r !== null) {
        if (r > 0) wins++;
        else if (r < 0) losses++;
        else even++;
      }
    }
    const r = tradeR(t);
    if (r !== null) rs.push(r);
  }
  const n = mine.length;
  return {
    origin,
    trades: n,
    wins,
    losses,
    breakeven: even,
    netProfit: withMoney ? money : null,
    profitFactor: withMoney && grossLoss > 0 ? gross / grossLoss : null,
    winRate: n ? wins / n : null,
    avgTrade: withMoney ? money / withMoney : null,
    expectancyR: rs.length ? rs.reduce((s, r) => s + r, 0) / rs.length : null,
    rTrades: rs.length,
    maxDrawdown: withMoney ? dd : null,
    firstEntryMs: mine.reduce<number | null>(
      (m, t) =>
        t.entryTimeMs === null ? m : m === null ? t.entryTimeMs : Math.min(m, t.entryTimeMs),
      null,
    ),
    lastExitMs: mine.reduce<number | null>(
      (m, t) => (t.exitTimeMs === null ? m : m === null ? t.exitTimeMs : Math.max(m, t.exitTimeMs)),
      null,
    ),
  };
}

/** How many closed trades came from each origin. */
export function originCounts(trades: readonly ScriptLiveClosedTrade[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of trades) {
    const k = t.origin ?? 'unknown';
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}
