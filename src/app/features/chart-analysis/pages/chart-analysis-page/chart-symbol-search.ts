import { computed, effect, signal, untracked, type DestroyRef } from '@angular/core';

import type { CurrencyPairDto } from '@core/api/api.types';
import { resolveInstrument } from '@core/instruments/instrument-math';
import type { InstrumentAssetClass, InstrumentDto } from '@core/instruments/instrument.types';
import type { InstrumentsService } from '@core/instruments/instruments.service';
import { RemoteSymbolSearch, groupSearch, mergeSearch, searchRowOf } from '../../datafeed/symbol-search';
import { ASSET_CLASS_LABEL } from '../../watchlist/instrument-icon.component';

/** What the symbol search reads on the chart page (accessors, so it can be built before the page's fields). */
export interface ChartSymbolSearchDeps {
  /** The menu is open / its query (the page's: the route spec and the hotkeys drive them there). */
  open: () => boolean;
  query: () => string;
  symbols: () => CurrencyPairDto[];
  selectSymbol: (symbol: string) => void;
  instruments: Pick<InstrumentsService, 'source' | 'assetClasses' | 'all' | 'search'>;
  destroyRef: DestroyRef;
}

/**
 * b9-maint — the toolbar's symbol search (CC-I13, UD09: the loaded catalogue plus the engine's paged catalogue search,
 * filtered by asset class), moved out of ChartAnalysisPageComponent behaviour for behaviour (build it as a page field: the
 * remote search follows the menu in an effect). The template reads it as `symbolSearch`.
 */
export class ChartSymbolSearch {
  constructor(private readonly deps: ChartSymbolSearchDeps) {
    deps.destroyRef.onDestroy(() => this.remoteSearch.dispose());
  }

  readonly symbolClass = signal<InstrumentAssetClass | null>(null);
  readonly symbolClasses = computed(() =>
    // Only once the engine serves its instrument master: in front of today's engine the menu is unchanged.
    this.deps.instruments.source() === 'instruments'
      ? [
          ...new Set([
            ...this.deps.instruments.assetClasses(),
            ...this.remoteSearch.rows().map((r) => r.assetClass),
          ]),
        ]
      : [],
  );
  readonly assetClassLabel = ASSET_CLASS_LABEL;

  /**
   * What the symbol search lists: every tradable instrument of the catalogue (FX derived from the currency pairs while
   * the engine has no instrument master — the same active pairs as before), else the pairs themselves.
   */
  private readonly searchable = computed(() => {
    const all = this.deps.instruments.all().filter((i) => i.status !== 'Inactive');
    if (all.length) return all;
    return this.deps.symbols().map((p) => ({
      symbol: (p.symbol ?? '').toUpperCase(),
      description:
        p.baseCurrency && p.quoteCurrency
          ? `${p.baseCurrency}/${p.quoteCurrency}`
          : (p.symbol ?? ''),
      assetClass: resolveInstrument(p.symbol, { assetClass: p.assetClass ?? null }).assetClass,
    }));
  });

  /** The search row's second column: the master's description, or "AUD/CAD" where it only repeats an FX symbol. */
  symbolDescription(symbol: string, description: string | null | undefined): string {
    const d = (description ?? '').trim();
    if (d && d.toUpperCase() !== symbol.toUpperCase()) return d;
    return /^[A-Z]{6}$/i.test(symbol)
      ? `${symbol.slice(0, 3)}/${symbol.slice(3)}`.toUpperCase()
      : d;
  }

  /**
   * UD09: the engine searches the whole catalogue from two characters (debounced, paged); its rows join the loaded
   * catalogue's below them, keyed by symbol + exchange, those without data marked "no data yet".
   */
  readonly remoteSearch = new RemoteSymbolSearch((q, o) => this.deps.instruments.search(q, o));
  private readonly remoteSearchFollow = effect(() => {
    const open = this.deps.open();
    const query = this.deps.query();
    const cls = this.symbolClass();
    // Only once the engine serves its instrument master (in front of an older engine: the menu as it was).
    const master = this.deps.instruments.source() === 'instruments';
    untracked(() => this.remoteSearch.set(open && master ? query : '', cls));
  });
  readonly filteredSymbols = computed(() =>
    mergeSearch(
      this.searchable().map((i) => searchRowOf(i as InstrumentDto, true)),
      this.remoteSearch.rows(),
      this.deps.query(),
      this.symbolClass(),
    ),
  );
  /** {@link filteredSymbols} by asset class, for the menu (one group: no headers). */
  readonly symbolGroups = computed(() => groupSearch(this.filteredSymbols()));

  /** Enter in the symbol search: the first (best) match, as on TradingView (CC-I13). */
  pickFirstSymbol(): void {
    const first = this.filteredSymbols()[0]?.symbol;
    if (first) this.deps.selectSymbol(first);
  }
}
