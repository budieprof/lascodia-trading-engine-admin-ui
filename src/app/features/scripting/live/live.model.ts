import { toCamelCase } from '../report/strategy-report.model';
import {
  NA,
  formatDateTime,
  formatMoney,
  formatNumber,
  formatPrice,
  formatQty,
} from '../report/report-format';
import type { ScriptDivergence, ScriptLiveStatus } from '../api/scripting-api.types';

/**
 * View model for `GET strategy/{id}/script/live`. The contract fixes the top-level fields; the
 * position, open trades and pending orders are the emulator's own state objects and are read
 * defensively — known fields get proper formatting and order, anything else is still shown.
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

/** Normalises the live payload's casing and container types. Null when it is not an object. */
export function normalizeLiveStatus(raw: unknown): ScriptLiveStatus | null {
  if (!isObject(raw)) return null;
  const o = camelShallow(raw);
  const rows = (v: unknown): Json[] =>
    Array.isArray(v) ? v.filter(isObject).map(camelShallow) : [];
  return {
    status: typeof o['status'] === 'string' ? (o['status'] as string) : '',
    lastBarTimeMs: num(o['lastBarTimeMs']),
    position: isObject(o['position']) ? camelShallow(o['position']) : null,
    openTrades: rows(o['openTrades']),
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

/** Formats an emulator field by what its name says it holds. */
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
    if (n === null || !/(price|qty|size|pnl|profit|equity|time|commission)/i.test(key))
      return value;
    value = n;
  }
  if (typeof value !== 'number')
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  const k = key.toLowerCase();
  if (k.endsWith('time') || k.endsWith('timems') || k.endsWith('timeutc') || k === 'time') {
    return value > 1e11 ? `${formatDateTime(value)} UTC` : formatNumber(value, 0);
  }
  if (/(price|stop|limit|target|avg)/.test(k)) return formatPrice(value, priceDecimals);
  if (/(pnl|profit|equity|commission|value|margin)/.test(k)) {
    return formatMoney(value, currency, { signed: /(pnl|profit)/.test(k) });
  }
  if (/(qty|size|contracts|lots)/.test(k)) return formatQty(value);
  if (/(bar|index|count|seq|number)/.test(k)) return formatNumber(value, 0);
  return formatNumber(value, Number.isInteger(value) ? 0 : 4);
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

/** "Long 10,000 @ 1.17000" / "Flat" from whatever the emulator's position object carries. */
export function positionHeadline(position: Json | null, priceDecimals = 5): PositionHeadline {
  if (!position) return { side: 'flat', text: 'Flat — no open position', pnl: null };
  const size = firstNumber(position, SIZE_KEYS);
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
  const qty = size !== null ? ` ${formatQty(Math.abs(size))}` : '';
  const at = price !== null ? ` @ ${formatPrice(price, priceDecimals)}` : '';
  return { side, text: `${side === 'long' ? 'Long' : 'Short'}${qty}${at}`, pnl };
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

export const OPEN_TRADE_COLUMNS = [
  'entryId',
  'direction',
  'qty',
  'entryPrice',
  'entryTime',
  'profit',
  'openPnL',
  'protectedStop',
  'protectedTarget',
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
