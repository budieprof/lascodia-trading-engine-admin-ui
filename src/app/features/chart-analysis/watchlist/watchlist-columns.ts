/**
 * The watchlist's optional columns (SP-I6): the registry the column picker offers, and the pure maths behind each
 * cell — spread and ranges in pips, ADR used, ATR %, the next high-impact event, news pressure, open P&L and the FX
 * session. Kept apart from the component so every number is unit-tested.
 */
import { timezoneOffsetMinutes } from '../workspace/layout-store.service';

export type WatchColumnKey =
  | 'last'
  | 'change'
  | 'changePct'
  | 'bid'
  | 'ask'
  | 'spread'
  | 'dayRange'
  | 'adr'
  | 'adrUsed'
  | 'atrPct'
  | 'nextEvent'
  | 'news'
  | 'pnl'
  | 'session'
  | 'sparkline';

/** What a column needs fetched beyond the basic quote. */
export type ColumnNeed = 'ranges' | 'sparkline' | 'events' | 'news' | 'positions';

export interface WatchColumn {
  key: WatchColumnKey;
  /** Header text (short — the dock is narrow). */
  label: string;
  /** What the column shows, for the picker and the header tooltip. */
  title: string;
  /** A sparkline has no single value to sort by. */
  sortable: boolean;
  /** Header width in px. */
  width: number;
  needs?: ColumnNeed;
}

export const WATCH_COLUMNS: readonly WatchColumn[] = [
  { key: 'last', label: 'Last', title: 'Last price (the bid)', sortable: true, width: 76 },
  { key: 'change', label: 'Chg', title: 'Change on the trading day', sortable: true, width: 64 },
  { key: 'changePct', label: 'Chg%', title: 'Change on the trading day, %', sortable: true, width: 56 },
  { key: 'bid', label: 'Bid', title: 'Live bid', sortable: true, width: 76 },
  { key: 'ask', label: 'Ask', title: 'Live ask', sortable: true, width: 76 },
  { key: 'spread', label: 'Spr', title: 'Live spread in pips', sortable: true, width: 44 },
  {
    key: 'dayRange',
    label: 'Range',
    title: "Today's high − low in pips (the trading day: 17:00 New York for FX)",
    sortable: true,
    width: 52,
  },
  {
    key: 'adr',
    label: 'ADR',
    title: 'Average daily range over the last 14 trading days, pips',
    sortable: true,
    width: 48,
    needs: 'ranges',
  },
  {
    key: 'adrUsed',
    label: 'ADR%',
    title: "How much of the average daily range today's range has used",
    sortable: true,
    width: 50,
    needs: 'ranges',
  },
  {
    key: 'atrPct',
    label: 'ATR%',
    title: '14-day ATR as a % of price — how volatile the symbol is',
    sortable: true,
    width: 50,
    needs: 'ranges',
  },
  {
    key: 'nextEvent',
    label: 'Event',
    title: 'Countdown to the next high-impact release for either currency',
    sortable: true,
    width: 64,
    needs: 'events',
  },
  {
    key: 'news',
    label: 'News',
    title: 'News pressure: base currency minus quote currency (−2 … +2; above 0 the news favours the base)',
    sortable: true,
    width: 50,
    needs: 'news',
  },
  {
    key: 'pnl',
    label: 'P&L',
    title: 'Open P&L of the positions on this symbol, for the selected account scope',
    sortable: true,
    width: 60,
    needs: 'positions',
  },
  {
    key: 'session',
    label: 'Session',
    title: "FX sessions open now — the pair's home sessions first",
    sortable: true,
    width: 74,
  },
  {
    key: 'sparkline',
    label: '24h',
    title: 'The last 24 hourly closes',
    sortable: false,
    width: 58,
    needs: 'sparkline',
  },
];

export const DEFAULT_COLUMNS: readonly WatchColumnKey[] = ['last', 'change', 'changePct'];

const BY_KEY = new Map(WATCH_COLUMNS.map((c) => [c.key, c]));

export function columnDef(key: string): WatchColumn | undefined {
  return BY_KEY.get(key as WatchColumnKey);
}

/** A list's columns: its saved ones in order (unknown keys dropped), else the defaults. */
export function resolveColumns(saved: readonly string[] | null | undefined): WatchColumn[] {
  if (!saved) return DEFAULT_COLUMNS.map((k) => BY_KEY.get(k)!);
  const seen = new Set<string>();
  const out: WatchColumn[] = [];
  for (const k of saved) {
    const c = BY_KEY.get(k as WatchColumnKey);
    if (c && !seen.has(c.key)) {
      seen.add(c.key);
      out.push(c);
    }
  }
  return out;
}

/** Toggle one column in a list's column set, keeping the registry's order. */
export function toggleColumn(current: readonly WatchColumnKey[], key: WatchColumnKey): WatchColumnKey[] {
  const on = new Set(current);
  if (on.has(key)) on.delete(key);
  else on.add(key);
  return WATCH_COLUMNS.map((c) => c.key).filter((k) => on.has(k));
}

/** Which extra reads the visible columns need. */
export function neededData(columns: readonly WatchColumn[]): Set<ColumnNeed> {
  return new Set(columns.map((c) => c.needs).filter((n): n is ColumnNeed => !!n));
}

// ── Pip maths ───────────────────────────────────────────────────────────────

/** The quote's pip size, else the usual convention (JPY quotes 0.01, metals 0.1/0.01, else by digits). */
export function pipSizeOf(symbol: string, digits: number, quotedPip?: number | null): number {
  if (quotedPip && quotedPip > 0) return quotedPip;
  const s = symbol.toUpperCase();
  if (s.startsWith('XAU')) return 0.1;
  if (s.startsWith('XAG')) return 0.01;
  if (s.endsWith('JPY')) return 0.01;
  return digits === 3 || digits === 5 ? 10 ** -(digits - 1) : 10 ** -digits;
}

/** A price distance in pips, one decimal; null without both ends. */
export function pips(distance: number | null | undefined, pipSize: number): number | null {
  if (distance === null || distance === undefined || !Number.isFinite(distance) || !(pipSize > 0))
    return null;
  return Math.round((distance / pipSize) * 10) / 10;
}

/** Today's range as a % of the average daily range. */
export function adrUsedPct(
  high: number | null | undefined,
  low: number | null | undefined,
  adr: number | null | undefined,
): number | null {
  if (high == null || low == null || adr == null || !(adr > 0)) return null;
  return Math.round(((high - low) / adr) * 100);
}

/** ATR as a % of price, two decimals. */
export function atrPct(atr: number | null | undefined, price: number | null | undefined): number | null {
  if (atr == null || price == null || !(price > 0)) return null;
  return Math.round((atr / price) * 10_000) / 100;
}

// ── Currency legs ───────────────────────────────────────────────────────────

export interface Legs {
  base: string;
  quote: string;
}

/** Base / quote from the pair's columns, else a six-letter symbol; null for an index or energy CFD. */
export function legsOf(
  symbol: string,
  base?: string | null,
  quote?: string | null,
): Legs | null {
  const b = (base ?? '').trim().toUpperCase();
  const q = (quote ?? '').trim().toUpperCase();
  if (b.length === 3 && q.length === 3) return { base: b, quote: q };
  const letters = /^[A-Za-z]+/.exec(symbol.trim())?.[0]?.toUpperCase() ?? '';
  return letters.length === 6 ? { base: letters.slice(0, 3), quote: letters.slice(3) } : null;
}

// ── Next high-impact event ──────────────────────────────────────────────────

export interface CalendarEventLite {
  title: string;
  currency: string;
  scheduledAt: string;
  actual?: string | null;
}

export interface NextEvent {
  title: string;
  currency: string;
  atMs: number;
}

/** The first event for either leg that has not happened yet (no actual, time ahead or within the last minute). */
export function nextEventFor(
  legs: Legs | null,
  events: readonly CalendarEventLite[],
  nowMs: number,
): NextEvent | null {
  if (!legs) return null;
  let best: NextEvent | null = null;
  for (const e of events) {
    const ccy = e.currency.toUpperCase();
    if (ccy !== legs.base && ccy !== legs.quote) continue;
    if (e.actual) continue;
    const at = Date.parse(e.scheduledAt);
    if (!Number.isFinite(at) || at < nowMs - 60_000) continue;
    if (!best || at < best.atMs) best = { title: e.title, currency: ccy, atMs: at };
  }
  return best;
}

/** `now`, `12m`, `2h 05m`, `3d 4h`. */
export function formatCountdown(ms: number): string {
  if (ms <= 60_000) return 'now';
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

// ── News pressure ───────────────────────────────────────────────────────────

/** Base pressure − quote pressure, two decimals; null unless both legs are scored. */
export function newsTilt(legs: Legs | null, scores: ReadonlyMap<string, number>): number | null {
  if (!legs) return null;
  const b = scores.get(legs.base);
  const q = scores.get(legs.quote);
  if (b === undefined || q === undefined) return null;
  return Math.round((b - q) * 100) / 100;
}

// ── Open P&L ────────────────────────────────────────────────────────────────

export interface PositionLite {
  symbol: string | null;
  unrealizedPnL: number | null;
  tradingAccountId?: number;
  status?: string;
}

/** Open P&L per symbol over the accounts in scope (an empty scope set = every account). */
export function pnlBySymbol(
  positions: readonly PositionLite[],
  accountIds: ReadonlySet<number>,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of positions) {
    if (p.status && p.status !== 'Open') continue;
    if (accountIds.size && (p.tradingAccountId === undefined || !accountIds.has(p.tradingAccountId)))
      continue;
    const sym = (p.symbol ?? '').toUpperCase();
    if (!sym) continue;
    out.set(sym, (out.get(sym) ?? 0) + (p.unrealizedPnL ?? 0));
  }
  return out;
}

// ── FX sessions ─────────────────────────────────────────────────────────────

export interface FxSession {
  name: string;
  short: string;
  zone: string;
  /** Local open / close hour (24h clock) in `zone`, Monday to Friday. */
  open: number;
  close: number;
  /** Currencies whose home market this is. */
  home: readonly string[];
}

/** The four conventional FX sessions, each 08:00–17:00 local (Sydney 07:00–16:00), DST-correct via the zone. */
export const FX_SESSIONS: readonly FxSession[] = [
  { name: 'Sydney', short: 'SYD', zone: 'Australia/Sydney', open: 7, close: 16, home: ['AUD', 'NZD'] },
  { name: 'Tokyo', short: 'TKY', zone: 'Asia/Tokyo', open: 9, close: 18, home: ['JPY', 'CNH', 'SGD', 'HKD'] },
  { name: 'London', short: 'LDN', zone: 'Europe/London', open: 8, close: 17, home: ['GBP', 'EUR', 'CHF', 'SEK', 'NOK'] },
  { name: 'New York', short: 'NY', zone: 'America/New_York', open: 8, close: 17, home: ['USD', 'CAD', 'MXN'] },
];

/** The sessions open at `nowMs` (local weekday Monday–Friday, local hour in [open, close)). */
export function openSessions(nowMs: number): FxSession[] {
  return FX_SESSIONS.filter((s) => {
    const local = new Date(nowMs + timezoneOffsetMinutes(s.zone, nowMs) * 60_000);
    const dow = local.getUTCDay();
    if (dow === 0 || dow === 6) return false;
    const h = local.getUTCHours() + local.getUTCMinutes() / 60;
    return h >= s.open && h < s.close;
  });
}

/** The session cell: `Closed` when the market is, else the open sessions with the pair's home ones first. */
export function sessionLabel(
  legs: Legs | null,
  marketOpen: boolean,
  nowMs: number,
): { text: string; home: boolean } {
  if (!marketOpen) return { text: 'Closed', home: false };
  const open = openSessions(nowMs);
  if (!open.length) return { text: 'Quiet', home: false };
  const isHome = (s: FxSession) => !!legs && (s.home.includes(legs.base) || s.home.includes(legs.quote));
  const ordered = [...open.filter(isHome), ...open.filter((s) => !isHome(s))];
  return { text: ordered.map((s) => s.short).join(' · '), home: ordered.some(isHome) };
}

// ── Sparkline ───────────────────────────────────────────────────────────────

/** An SVG polyline `points` string for `values` in a `w`×`h` box (1px inset); '' with fewer than 2 points. */
export function sparklinePoints(values: readonly number[] | null | undefined, w: number, h: number): string {
  if (!values || values.length < 2) return '';
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const span = hi - lo || 1;
  const step = (w - 2) / (values.length - 1);
  return values
    .map((v, i) => `${(1 + i * step).toFixed(1)},${(1 + (h - 2) * (1 - (v - lo) / span)).toFixed(1)}`)
    .join(' ');
}

// ── Instrument label (SP-11) ────────────────────────────────────────────────

/** The details pane's instrument kind, from the engine's asset class (it was hard-coded "Forex"). */
export function instrumentKind(assetClass: string | null | undefined, symbol: string, legs: Legs | null): string {
  switch (assetClass) {
    case 'FxMajor':
      return 'Forex · major';
    case 'FxMinor':
      return 'Forex · cross';
    case 'FxExotic':
      return 'Forex · exotic';
    case 'Index':
      return 'Index CFD';
    case 'Commodity':
      return /^X(AU|AG|PT|PD)/i.test(symbol) ? 'Metal' : 'Commodity';
    case 'Crypto':
      return 'Crypto';
  }
  if (/^X(AU|AG|PT|PD)/i.test(symbol)) return 'Metal';
  return legs ? 'Forex' : 'CFD';
}
