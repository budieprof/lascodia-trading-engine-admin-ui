import { signal } from '@angular/core';
import type { InstrumentAssetClass, InstrumentDto } from '@core/instruments/instrument.types';
import { rankSymbols } from './symbol-info';
import { referenceExchange, venueWords, withoutListingSuffix } from './venue-label';

/**
 * The chart's symbol search over the WHOLE catalogue (multi-asset chart program UD09). The menu used to filter the
 * `hasCandles=true&take=1000` list in the browser: every symbol past the first thousand, and every one without stored
 * candles, could not be found at all. Now:
 * - the loaded catalogue (symbols WITH data) answers at once, ranked as before (Enter takes the first — CC-I13);
 * - from two characters the engine searches its master (`GET instruments?search=`, debounced, paged by "Show more"),
 *   and its rows are added below — each marked "no data yet" when the engine has no candles for it, with why;
 * - rows are keyed by symbol + exchange (the same symbol on two venues is two rows), grouped by asset class.
 */

export interface SearchRow {
  symbol: string;
  description: string | null;
  assetClass: InstrumentAssetClass;
  exchange: string | null;
  /** US08: the venue words the row shows — the candle source, "ref: <listing>" where that differs. */
  venue: string | null;
  /** Where its bars come from ("MT5 broker", "Coinbase"); null: not said. */
  source: string | null;
  /** False: the engine has no candles for it (the chart will show "no data yet"). Null: not said (older engine). */
  hasData: boolean | null;
  /** Why there is no data, in words; null when there is. */
  noDataReason: string | null;
  /** symbol|exchange — the row's identity. */
  key: string;
}

export interface SearchGroup {
  assetClass: InstrumentAssetClass;
  rows: SearchRow[];
}

/** Characters before the engine is asked. */
export const MIN_REMOTE_QUERY = 2;
export const SEARCH_PAGE = 50;
const DEBOUNCE_MS = 250;

const ORDER: InstrumentAssetClass[] = [
  'Fx',
  'Future',
  'Crypto',
  'Equity',
  'Etf',
  'Index',
  'Commodity',
];

export function searchRowOf(
  i: Pick<InstrumentDto, 'symbol' | 'description' | 'assetClass' | 'exchange'> &
    Partial<Pick<InstrumentDto, 'candleSource' | 'hasCandles'>>,
  fromLoadedCatalogue: boolean,
): SearchRow {
  const exchange = (i.exchange ?? '').trim() || null;
  const hasData = fromLoadedCatalogue
    ? true
    : typeof i.hasCandles === 'boolean'
      ? i.hasCandles
      : null;
  const source = i.candleSource
    ? i.candleSource.kind === 'mt5'
      ? 'MT5 broker'
      : i.candleSource.label
    : null;
  return {
    symbol: i.symbol.toUpperCase(),
    // US08: a description's "(Binance)" names the reference listing, not where the bars come from.
    description: i.description ? withoutListingSuffix(i.description, exchange) : null,
    assetClass: i.assetClass,
    exchange,
    source,
    venue: venueWords(source, referenceExchange(i, i.candleSource ?? null)),
    hasData,
    noDataReason:
      hasData === false
        ? i.candleSource
          ? `no data yet from ${source}`
          : 'no data yet (no candle source enabled)'
        : null,
    key: `${i.symbol.toUpperCase()}|${exchange ?? ''}`,
  };
}

/**
 * The loaded catalogue's matches (ranked, as before) followed by the engine's further matches not already listed — the
 * ones with data first — grouped by asset class in a fixed order. `cls` filters both.
 */
export function mergeSearch(
  local: readonly SearchRow[],
  remote: readonly SearchRow[],
  query: string,
  cls: InstrumentAssetClass | null,
): SearchRow[] {
  const keep = (r: SearchRow) => !cls || r.assetClass === cls;
  const ranked = rankSymbols(local.filter(keep), query);
  const seen = new Set(ranked.map((r) => r.key));
  const seenSymbols = new Set(ranked.map((r) => r.symbol));
  const extra = remote.filter(
    (r) => keep(r) && !seen.has(r.key) && !(r.exchange === null && seenSymbols.has(r.symbol)),
  );
  const extraRanked = rankSymbols(extra, query);
  const withData = extraRanked.filter((r) => r.hasData !== false);
  const without = extraRanked.filter((r) => r.hasData === false);
  return [...ranked, ...withData, ...without];
}

/** `rows` grouped by asset class (fixed order), each group keeping the rows' order. */
export function groupSearch(rows: readonly SearchRow[]): SearchGroup[] {
  const by = new Map<InstrumentAssetClass, SearchRow[]>();
  for (const r of rows) {
    const g = by.get(r.assetClass);
    if (g) g.push(r);
    else by.set(r.assetClass, [r]);
  }
  const known = ORDER.filter((c) => by.has(c)).map((c) => ({ assetClass: c, rows: by.get(c)! }));
  const other = [...by.keys()]
    .filter((c) => !ORDER.includes(c))
    .map((c) => ({ assetClass: c, rows: by.get(c)! }));
  return [...known, ...other];
}

export type SearchFetch = (
  query: string,
  opts: { assetClass?: InstrumentAssetClass | null; skip: number; take: number },
) => Promise<{ rows: InstrumentDto[]; total: number | null }>;

/** The engine side of the search: debounced, newest query wins, paged. Plain class (signals, no DI). */
export class RemoteSymbolSearch {
  readonly rows = signal<SearchRow[]>([]);
  readonly total = signal<number | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  /** The query the rows answer. */
  readonly answered = signal('');

  private seq = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private query = '';
  private cls: InstrumentAssetClass | null = null;

  constructor(
    private readonly fetch: SearchFetch,
    private readonly debounceMs = DEBOUNCE_MS,
  ) {}

  /** A new query / class: cleared below {@link MIN_REMOTE_QUERY} characters, else asked after the debounce. */
  set(query: string, cls: InstrumentAssetClass | null): void {
    const q = query.trim();
    if (q === this.query && cls === this.cls) return;
    this.query = q;
    this.cls = cls;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const n = ++this.seq;
    if (q.length < MIN_REMOTE_QUERY) {
      this.rows.set([]);
      this.total.set(null);
      this.error.set(null);
      this.loading.set(false);
      this.answered.set('');
      return;
    }
    this.loading.set(true);
    this.timer = setTimeout(() => void this.page(n, 0), this.debounceMs);
  }

  /** Whether the engine has more matches than listed. */
  hasMore(): boolean {
    const t = this.total();
    return t !== null && this.rows().length < t;
  }

  /** The next page of the current query. */
  more(): void {
    if (this.loading() || !this.hasMore()) return;
    this.loading.set(true);
    void this.page(this.seq, this.rows().length);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.seq++;
  }

  private async page(n: number, skip: number): Promise<void> {
    try {
      const res = await this.fetch(this.query, { assetClass: this.cls, skip, take: SEARCH_PAGE });
      if (n !== this.seq) return;
      const rows = res.rows.map((r) => searchRowOf(r, false));
      this.rows.set(skip === 0 ? rows : [...this.rows(), ...rows]);
      this.total.set(res.total);
      this.error.set(null);
      this.answered.set(this.query);
    } catch (e) {
      if (n !== this.seq) return;
      this.error.set(e instanceof Error && e.message ? e.message : 'the engine did not answer');
    } finally {
      if (n === this.seq) this.loading.set(false);
    }
  }
}
