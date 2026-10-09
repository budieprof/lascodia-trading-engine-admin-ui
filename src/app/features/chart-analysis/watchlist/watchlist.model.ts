/**
 * Chart watchlists — TradingView-style named lists of sections of symbols.
 *
 * Wire shapes match the engine's `chart-watchlist` and
 * `market-data/watchlist-quotes` endpoints. Everything below the types is pure
 * so the panel's behaviour (sorting, moving, flag cycling, change maths) is
 * unit-tested without a DOM.
 */

import {
  adrUsedPct,
  atrPct,
  columnDef,
  newsTilt,
  nextEventFor,
  pipSizeOf,
  pips,
  sessionLabel,
  type CalendarEventLite,
  type Legs,
  type NextEvent,
  type WatchColumnKey,
} from './watchlist-columns';

export type WatchFlag = 'red' | 'orange' | 'green' | 'blue' | 'purple';
export const FLAGS: readonly WatchFlag[] = ['red', 'orange', 'green', 'blue', 'purple'];

export interface WatchItem {
  symbol: string;
  flag: WatchFlag | null;
}

export interface WatchSection {
  id: string;
  name: string;
  collapsed: boolean;
  items: WatchItem[];
}

/** A list's display settings (SP-I6), stored with the list on the engine. */
export interface WatchlistSettings {
  /** Column keys in display order. */
  columns: string[];
  /** The sort the list opens with; null = the list's own order. */
  sort: { key: string; dir: number } | null;
}

export interface ChartWatchlist {
  /** 0 = the engine's seeded default, not stored until first written. */
  id: number;
  name: string;
  isActive: boolean;
  sortOrder: number;
  sections: WatchSection[];
  /** Null = the panel's defaults (never changed). */
  settings?: WatchlistSettings | null;
  updatedAt?: string | null;
}

/**
 * One row of `market-data/watchlist-quotes`. The day is the symbol's TRADING day (17:00 New York for FX, the UTC day
 * for crypto — contract C7). Fields after `asOfUtc` are optional: an engine before 2026-10-09 does not send them.
 */
export interface WatchQuote {
  symbol: string;
  bid: number | null;
  ask: number | null;
  last: number | null;
  prevClose: number | null;
  dayOpen: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  change: number | null;
  changePct: number | null;
  digits: number;
  marketOpen: boolean;
  asOfUtc: string | null;
  /** One pip in price units. */
  pipSize?: number;
  /** The trading day the day fields describe (`yyyy-mm-dd`). */
  tradingDay?: string | null;
  /** When that trading day opened, UTC. */
  dayOpenUtc?: string | null;
  /** With `sparkline=true`: the last 24 hourly closes, oldest first. */
  sparkline?: number[] | null;
  /** With `ranges=true`: average daily range and ATR (price units) over `rangeDays` trading days. */
  adr?: number | null;
  atr?: number | null;
  rangeDays?: number | null;
}

/** A column key (see `watchlist-columns.ts`), the symbol, or the list's own order. */
export type SortKey = 'none' | 'symbol' | WatchColumnKey;
export interface SortState {
  key: SortKey;
  dir: 1 | -1;
}

export interface WatchRow {
  symbol: string;
  flag: WatchFlag | null;
  sectionId: string;
  last: number | null;
  change: number | null;
  changePct: number | null;
  digits: number;
  marketOpen: boolean;
  /** Direction of the latest tick, for the flash; null when unchanged. */
  tick: 'up' | 'down' | null;
  bid: number | null;
  ask: number | null;
  pipSize: number;
  /** Live spread, pips. */
  spread: number | null;
  /** Today's high − low, pips. */
  dayRange: number | null;
  /** Average daily range, pips. */
  adr: number | null;
  /** Today's range as % of the ADR. */
  adrUsed: number | null;
  atrPct: number | null;
  sparkline: number[] | null;
  nextEvent: NextEvent | null;
  /** Milliseconds to `nextEvent` (for sorting; null without one). */
  nextEventInMs: number | null;
  news: number | null;
  pnl: number | null;
  session: string;
  /** Whether one of the pair's home sessions is open. */
  homeSession: boolean;
}

/** What a row needs beyond its quote and live tick. All optional. */
export interface RowContext {
  liveAsk?: number;
  nowMs?: number;
  legs?: Legs | null;
  events?: readonly CalendarEventLite[];
  newsScores?: ReadonlyMap<string, number>;
  pnl?: ReadonlyMap<string, number>;
}

let seq = 0;
export function newSectionId(): string {
  seq = (seq + 1) % 1_000_000;
  return `s${Date.now().toString(36)}${seq.toString(36)}`;
}

/** Every symbol in a list, in display order, de-duplicated. */
export function listSymbols(list: ChartWatchlist | null): string[] {
  if (!list) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of list.sections)
    for (const it of s.items)
      if (!seen.has(it.symbol)) {
        seen.add(it.symbol);
        out.push(it.symbol);
      }
  return out;
}

/**
 * Last price and change against the previous trading day's close, plus every optional column's cell. The live tick
 * (when newer than the snapshot) replaces `last` and the change is recomputed from it, so the Chg columns move with
 * the price instead of every 30s.
 */
export function rowFor(
  item: WatchItem,
  sectionId: string,
  quote: WatchQuote | undefined,
  liveBid: number | undefined,
  prevTick: number | undefined,
  fallbackDigits: number,
  ctx: RowContext = {},
): WatchRow {
  const last = liveBid ?? quote?.last ?? quote?.bid ?? null;
  const prev = quote?.prevClose ?? null;
  const change = last !== null && prev !== null ? last - prev : null;
  const changePct = change !== null && prev ? (change / prev) * 100 : null;
  const tick =
    liveBid === undefined || prevTick === undefined || liveBid === prevTick
      ? null
      : liveBid > prevTick
        ? 'up'
        : 'down';
  const digits = quote?.digits || fallbackDigits;
  const pipSize = pipSizeOf(item.symbol, digits, quote?.pipSize);
  const bid = liveBid ?? quote?.bid ?? null;
  const ask = ctx.liveAsk ?? quote?.ask ?? null;
  // The live tick extends the day's range the same way the engine extends it with its cached tick.
  const high = quote?.dayHigh != null && last !== null ? Math.max(quote.dayHigh, last) : (quote?.dayHigh ?? null);
  const low = quote?.dayLow != null && last !== null ? Math.min(quote.dayLow, last) : (quote?.dayLow ?? null);
  const now = ctx.nowMs ?? Date.now();
  const legs = ctx.legs ?? null;
  const nextEvent = ctx.events ? nextEventFor(legs, ctx.events, now) : null;
  const marketOpen = quote?.marketOpen ?? false;
  const session = sessionLabel(legs, marketOpen, now);
  return {
    symbol: item.symbol,
    flag: item.flag,
    sectionId,
    last,
    change,
    changePct,
    digits,
    marketOpen,
    tick,
    bid,
    ask,
    pipSize,
    spread: bid !== null && ask !== null ? pips(ask - bid, pipSize) : null,
    dayRange: high !== null && low !== null ? pips(high - low, pipSize) : null,
    adr: pips(quote?.adr ?? null, pipSize),
    adrUsed: adrUsedPct(high, low, quote?.adr),
    atrPct: atrPct(quote?.atr, last),
    sparkline: quote?.sparkline ?? null,
    nextEvent,
    nextEventInMs: nextEvent ? Math.max(0, nextEvent.atMs - now) : null,
    news: ctx.newsScores ? newsTilt(legs, ctx.newsScores) : null,
    pnl: ctx.pnl?.get(item.symbol) ?? null,
    session: session.text,
    homeSession: session.home,
  };
}

/** The value a row sorts by for `key`. */
export function sortValue(r: WatchRow, key: SortKey): string | number | null {
  switch (key) {
    case 'none':
      return null;
    case 'symbol':
      return r.symbol;
    case 'nextEvent':
      return r.nextEventInMs;
    case 'session':
      return r.marketOpen ? r.session : null;
    case 'sparkline':
      return null;
    default:
      return r[key];
  }
}

export function sortRows(rows: WatchRow[], sort: SortState): WatchRow[] {
  if (sort.key === 'none') return rows;
  return [...rows].sort((a, b) => {
    const x = sortValue(a, sort.key);
    const y = sortValue(b, sort.key);
    // Rows without a value sink to the bottom whichever way the column sorts.
    if (x === null && y === null) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return (typeof x === 'string' ? x.localeCompare(y as string) : x - (y as number)) * sort.dir;
  });
}

/** Keys whose natural first click is ascending: names, and the soonest event. */
const ASCENDING_FIRST = new Set<SortKey>(['symbol', 'session', 'nextEvent']);

/** Header click: none → first → reverse → none (TradingView's cycle). Names and countdowns start ascending, numbers descending. */
export function nextSort(current: SortState, key: SortKey): SortState {
  const firstDir: 1 | -1 = ASCENDING_FIRST.has(key) ? 1 : -1;
  if (current.key !== key) return { key, dir: firstDir };
  if (current.dir === firstDir) return { key, dir: (firstDir * -1) as 1 | -1 };
  return { key: 'none', dir: 1 };
}

/** A saved sort, validated: unknown keys and directions fall back to the list's own order. */
export function sortFromSettings(settings: WatchlistSettings | null | undefined): SortState {
  const s = settings?.sort;
  if (!s) return { key: 'none', dir: 1 };
  const key = s.key as SortKey;
  const valid = key === 'none' || key === 'symbol' || (columnDef(key)?.sortable ?? false);
  return valid ? { key, dir: s.dir < 0 ? -1 : 1 } : { key: 'none', dir: 1 };
}

// ── Flagged lists (SP-I6) ───────────────────────────────────────────────────

/** Every symbol carrying `flag` in any of the lists, first appearance first — TradingView's flagged lists. */
export function flaggedItems(lists: readonly ChartWatchlist[], flag: WatchFlag): WatchItem[] {
  const out: WatchItem[] = [];
  const seen = new Set<string>();
  for (const l of lists)
    for (const s of l.sections)
      for (const it of s.items)
        if (it.flag === flag && !seen.has(it.symbol)) {
          seen.add(it.symbol);
          out.push({ symbol: it.symbol, flag });
        }
  return out;
}

/** How many symbols carry each flag across the lists. */
export function flagCounts(lists: readonly ChartWatchlist[]): Record<WatchFlag, number> {
  const out = Object.fromEntries(FLAGS.map((f) => [f, 0])) as Record<WatchFlag, number>;
  for (const f of FLAGS) out[f] = flaggedItems(lists, f).length;
  return out;
}

// ── Undo of a removal (SP-11) ───────────────────────────────────────────────

/** Where a removed symbol sat, so an undo puts it back exactly there. */
export interface RemovedItem {
  item: WatchItem;
  sectionId: string;
  index: number;
}

export function locate(list: ChartWatchlist, symbol: string): RemovedItem | null {
  for (const s of list.sections) {
    const index = s.items.findIndex((i) => i.symbol === symbol);
    if (index >= 0) return { item: s.items[index], sectionId: s.id, index };
  }
  return null;
}

/** Put a removed symbol back where it was (or at its section's end, or the last section's). No-op when present. */
export function restoreSymbol(list: ChartWatchlist, removed: RemovedItem): ChartWatchlist {
  if (listSymbols(list).includes(removed.item.symbol)) return list;
  const target = list.sections.find((s) => s.id === removed.sectionId) ?? list.sections.at(-1);
  if (!target) return addSymbol(list, removed.item.symbol);
  return {
    ...list,
    sections: list.sections.map((s) => {
      if (s !== target) return s;
      const items = [...s.items];
      items.splice(Math.min(removed.index, items.length), 0, removed.item);
      return { ...s, items };
    }),
  };
}

export function cycleFlag(flag: WatchFlag | null): WatchFlag | null {
  if (flag === null) return FLAGS[0];
  const i = FLAGS.indexOf(flag);
  return i === FLAGS.length - 1 ? null : FLAGS[i + 1];
}

/** Immutable edits. Each returns a new list. */
export function addSymbol(
  list: ChartWatchlist,
  symbol: string,
  sectionId?: string,
): ChartWatchlist {
  const sym = symbol.trim().toUpperCase();
  if (!sym || listSymbols(list).includes(sym)) return list;
  const sections = list.sections.length
    ? list.sections
    : [{ id: newSectionId(), name: 'Symbols', collapsed: false, items: [] }];
  const target = sections.find((s) => s.id === sectionId) ?? sections[sections.length - 1];
  return {
    ...list,
    sections: sections.map((s) =>
      s === target
        ? { ...s, collapsed: false, items: [...s.items, { symbol: sym, flag: null }] }
        : s,
    ),
  };
}

export function removeSymbol(list: ChartWatchlist, symbol: string): ChartWatchlist {
  return {
    ...list,
    sections: list.sections.map((s) => ({
      ...s,
      items: s.items.filter((i) => i.symbol !== symbol),
    })),
  };
}

export function setFlag(
  list: ChartWatchlist,
  symbol: string,
  flag: WatchFlag | null,
): ChartWatchlist {
  return {
    ...list,
    sections: list.sections.map((s) => ({
      ...s,
      items: s.items.map((i) => (i.symbol === symbol ? { ...i, flag } : i)),
    })),
  };
}

/**
 * Move `symbol` to sit before `beforeSymbol` (or at the end of `sectionId`
 * when `beforeSymbol` is null). Moving across sections is allowed — that is
 * how a row is regrouped by dragging, as in TradingView.
 */
export function moveSymbol(
  list: ChartWatchlist,
  symbol: string,
  sectionId: string,
  beforeSymbol: string | null,
): ChartWatchlist {
  if (symbol === beforeSymbol) return list;
  let moving: WatchItem | undefined;
  const stripped = list.sections.map((s) => {
    const hit = s.items.find((i) => i.symbol === symbol);
    if (hit) moving = hit;
    return hit ? { ...s, items: s.items.filter((i) => i.symbol !== symbol) } : s;
  });
  if (!moving) return list;
  const item = moving;
  return {
    ...list,
    sections: stripped.map((s) => {
      if (s.id !== sectionId) return s;
      const at = beforeSymbol === null ? -1 : s.items.findIndex((i) => i.symbol === beforeSymbol);
      const items = [...s.items];
      if (at < 0) items.push(item);
      else items.splice(at, 0, item);
      return { ...s, items };
    }),
  };
}

export function addSection(list: ChartWatchlist, name: string): ChartWatchlist {
  return {
    ...list,
    sections: [
      ...list.sections,
      { id: newSectionId(), name: name.trim() || 'Section', collapsed: false, items: [] },
    ],
  };
}

export function renameSection(list: ChartWatchlist, id: string, name: string): ChartWatchlist {
  const n = name.trim();
  if (!n) return list;
  return { ...list, sections: list.sections.map((s) => (s.id === id ? { ...s, name: n } : s)) };
}

/** Removing a section keeps its symbols: they move to the section above (TradingView does the same). */
export function removeSection(list: ChartWatchlist, id: string): ChartWatchlist {
  const i = list.sections.findIndex((s) => s.id === id);
  if (i < 0) return list;
  const gone = list.sections[i];
  const rest = list.sections.filter((s) => s.id !== id);
  if (!rest.length) return { ...list, sections: [{ ...gone, name: 'Symbols' }] };
  const heir = rest[Math.max(0, i - 1)];
  return {
    ...list,
    sections: rest.map((s) => (s === heir ? { ...s, items: [...s.items, ...gone.items] } : s)),
  };
}

export function toggleSection(list: ChartWatchlist, id: string): ChartWatchlist {
  return {
    ...list,
    sections: list.sections.map((s) => (s.id === id ? { ...s, collapsed: !s.collapsed } : s)),
  };
}

/**
 * Split a price for TradingView's display: the last digit (the fractional
 * pip on a 5-digit quote) is rendered smaller. `1.12848` → ["1.1284", "8"].
 */
export function splitPrice(value: number | null, digits: number): [string, string] {
  if (value === null || !Number.isFinite(value)) return ['—', ''];
  const s = value.toFixed(digits);
  // Only quotes with a fractional pip (3 or 5 digits) get the small last digit.
  return digits === 3 || digits === 5 ? [s.slice(0, -1), s.slice(-1)] : [s, ''];
}

/** A last price split as TradingView's watchlist shows a tick: unchanged digits, changed digits, the small last digit. */
export interface TickParts {
  /** Digits that did not change on the last tick (default text colour). */
  head: string;
  /** Digits from the first one that changed (coloured by the tick's direction). */
  changed: string;
  /** The fractional pip, rendered small ('' when the quote has none). */
  pip: string;
  /** The small last digit changed too (it takes the tick colour). */
  pipChanged: boolean;
}

/**
 * TradingView colours only the digits a tick changed — from the first differing digit to the end, the small
 * fractional pip included — and keeps that colour until the next tick. `previous` is the price before the last
 * change (null: no tick seen yet, nothing coloured). `1.11973` after `1.11981` → head "1.11", changed "97", pip "3".
 */
export function tickParts(value: number | null, digits: number, previous: number | null): TickParts {
  const [main, pip] = splitPrice(value, digits);
  if (value === null || !Number.isFinite(value) || previous === null || !Number.isFinite(previous)) {
    return { head: main, changed: '', pip, pipChanged: false };
  }
  const s = value.toFixed(digits);
  const p = previous.toFixed(digits);
  let i = 0;
  while (i < s.length && i < p.length && s[i] === p[i]) i++;
  if (i >= s.length && s.length === p.length) return { head: main, changed: '', pip, pipChanged: false };
  const cut = Math.min(i, main.length);
  return { head: main.slice(0, cut), changed: main.slice(cut), pip, pipChanged: pip !== '' && i <= s.length - 1 };
}

/** The symbol after/before `current` in visible order, for ↑/↓ navigation. */
export function neighbour(order: string[], current: string, step: 1 | -1): string | null {
  if (!order.length) return null;
  const i = order.indexOf(current);
  if (i < 0) return order[0];
  const j = i + step;
  return j < 0 || j >= order.length ? null : order[j];
}
