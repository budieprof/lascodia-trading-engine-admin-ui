/**
 * Chart watchlists — TradingView-style named lists of sections of symbols.
 *
 * Wire shapes match the engine's `chart-watchlist` and
 * `market-data/watchlist-quotes` endpoints. Everything below the types is pure
 * so the panel's behaviour (sorting, moving, flag cycling, change maths) is
 * unit-tested without a DOM.
 */

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

export interface ChartWatchlist {
  /** 0 = the engine's seeded default, not stored until first written. */
  id: number;
  name: string;
  isActive: boolean;
  sortOrder: number;
  sections: WatchSection[];
  updatedAt?: string | null;
}

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
}

export type SortKey = 'none' | 'symbol' | 'last' | 'change' | 'changePct';
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
 * Last price and change against the previous daily close. The live tick (when
 * newer than the snapshot) replaces `last` and the change is recomputed from
 * it, so the Chg columns move with the price instead of every 30s.
 */
export function rowFor(
  item: WatchItem,
  sectionId: string,
  quote: WatchQuote | undefined,
  liveBid: number | undefined,
  prevTick: number | undefined,
  fallbackDigits: number,
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
  return {
    symbol: item.symbol,
    flag: item.flag,
    sectionId,
    last,
    change,
    changePct,
    digits: quote?.digits || fallbackDigits,
    marketOpen: quote?.marketOpen ?? false,
    tick,
  };
}

export function sortRows(rows: WatchRow[], sort: SortState): WatchRow[] {
  if (sort.key === 'none') return rows;
  const val = (r: WatchRow): string | number | null =>
    sort.key === 'symbol'
      ? r.symbol
      : sort.key === 'last'
        ? r.last
        : sort.key === 'change'
          ? r.change
          : r.changePct;
  return [...rows].sort((a, b) => {
    const x = val(a);
    const y = val(b);
    // Rows without a value sink to the bottom whichever way the column sorts.
    if (x === null && y === null) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return (typeof x === 'string' ? x.localeCompare(y as string) : x - (y as number)) * sort.dir;
  });
}

/** Header click: none → asc → desc → none (TradingView's cycle). Symbol starts ascending, numbers descending. */
export function nextSort(current: SortState, key: SortKey): SortState {
  const firstDir: 1 | -1 = key === 'symbol' ? 1 : -1;
  if (current.key !== key) return { key, dir: firstDir };
  if (current.dir === firstDir) return { key, dir: (firstDir * -1) as 1 | -1 };
  return { key: 'none', dir: 1 };
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

/** The symbol after/before `current` in visible order, for ↑/↓ navigation. */
export function neighbour(order: string[], current: string, step: 1 | -1): string | null {
  if (!order.length) return null;
  const i = order.indexOf(current);
  if (i < 0) return order[0];
  const j = i + step;
  return j < 0 || j >= order.length ? null : order[j];
}
