import { PairIconComponent, pairFlags } from './pair-icon.component';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { firstValueFrom, map } from 'rxjs';
import type { CurrencyPairDto } from '@core/api/api.types';
import { EconomicCalendarService } from '@core/services/economic-calendar.service';
import { NewsIntelService } from '@core/services/news-intel.service';
import { PositionsService } from '@core/services/positions.service';
import { AccountScopeService } from '@core/scope/account-scope.service';
import { RealtimeService } from '@core/realtime/realtime.service';
import type { Ohlc } from '../indicators/math';
import { ChartIconComponent } from '../icons/chart-icon.component';
import { PerformanceTilesComponent } from '../panels/performance-tiles.component';
import { SeasonalsComponent } from '../panels/seasonals.component';
import { TechnicalsGaugeComponent } from '../panels/technicals-gauge.component';
import { ChartAlertFormComponent } from '../alerts/chart-alert-form.component';
import { ChartAlertsService } from '../alerts/chart-alerts.service';
import {
  HOTLISTS,
  WatchlistService,
  type Hotlist,
  type HotlistKind,
  type QuoteOptions,
} from './watchlist.service';
import {
  FLAGS,
  addSection,
  addSymbol,
  cycleFlag,
  flagCounts,
  flaggedItems,
  listSymbols,
  locate,
  moveSymbol,
  neighbour,
  nextSort,
  removeSection,
  removeSymbol,
  renameSection,
  restoreSymbol,
  rowFor,
  setFlag,
  sortFromSettings,
  sortRows,
  splitPrice,
  tickParts,
  toggleSection,
  type ChartWatchlist,
  type RemovedItem,
  type RowContext,
  type SortKey,
  type SortState,
  type WatchFlag,
  type WatchItem,
  type WatchQuote,
  type WatchRow,
} from './watchlist.model';
import {
  WATCH_COLUMNS,
  formatCountdown,
  instrumentKind,
  legsOf,
  neededData,
  pnlBySymbol,
  resolveColumns,
  sparklinePoints,
  toggleColumn,
  type CalendarEventLite,
  type Legs,
  type PositionLite,
  type WatchColumn,
  type WatchColumnKey,
} from './watchlist-columns';
import { ChartPrefsService } from '../workspace/chart-prefs.service';
import { ScriptDialogService } from '@features/scripting/shared/script-dialog.service';
import { askName, confirmDelete } from '../dialog/chart-dialogs';

const QUOTE_REFRESH_MS = 30_000;
/** Calendar, news pressure and positions change slowly; one read per this period while their column shows. */
const CONTEXT_REFRESH_MS = 300_000;
const POSITIONS_REFRESH_MS = 30_000;
const HOTLIST_REFRESH_MS = 60_000;
const CLOCK_MS = 15_000;
const UNDO_MS = 8_000;
const SPLIT_KEY = 'lascodia.chart.watchlist.split';

export interface WatchHeadline {
  title: string;
  source: string;
  at: string;
}

interface SectionView {
  id: string;
  name: string;
  collapsed: boolean;
  rows: WatchRow[];
}

/** What the rows show: a list, a flag across every list, or a server-side hotlist. Only a list is editable. */
type WatchView = { kind: 'list' } | { kind: 'flag'; flag: WatchFlag } | { kind: 'hotlist'; hot: HotlistKind };

/** The engine sends `assetClass` with every pair; the console's shared type does not declare it yet. */
type PairMeta = CurrencyPairDto & { assetClass?: string | null };

/**
 * TradingView-style watchlist dock: named lists, collapsible sections, a column picker (bid/ask, spread, day range,
 * ADR, ATR %, next high-impact event, news pressure, open P&L, session, 24h sparkline) and the sort saved with each
 * list, flagged lists and server-side hotlists, live ticks with the changed digits coloured up/down, colour flags, drag-to-reorder, ↑/↓ to
 * walk the chart through the list, Delete with Undo, an alert from any row, and the selected symbol's details beneath.
 */
@Component({
  selector: 'app-watchlist-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DecimalPipe,
    PairIconComponent,
    ChartIconComponent,
    PerformanceTilesComponent,
    SeasonalsComponent,
    TechnicalsGaugeComponent,
    ChartAlertFormComponent,
  ],
  host: {
    class: 'watchlist-panel',
    tabindex: '0',
    '(keydown)': 'onKeydown($event)',
    '(document:click)': 'closeMenus()',
  },
  templateUrl: './watchlist-panel.component.html',
  styleUrl: './watchlist-panel.component.scss',
})
export class WatchlistPanelComponent {
  readonly store = inject(WatchlistService);
  private readonly prefs = inject(ChartPrefsService);
  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly calendar = inject(EconomicCalendarService);
  private readonly newsIntel = inject(NewsIntelService);
  private readonly positions = inject(PositionsService);
  private readonly scope = inject(AccountScopeService);
  private readonly realtime = inject(RealtimeService);
  private readonly alerts = inject(ChartAlertsService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly dialogs = inject(ScriptDialogService);

  readonly pairs = input<CurrencyPairDto[]>([]);
  readonly current = input.required<string>();
  /** Latest bid per symbol from the realtime price stream. */
  readonly liveBids = input<Record<string, number>>({});
  /** The chart's bars, for the technicals gauge of the current symbol. */
  readonly bars = input<readonly Ohlc[]>([]);
  readonly timeframe = input<string>('');
  readonly headline = input<WatchHeadline | null>(null);

  readonly selected = output<string>();
  /** Symbols the panel needs live prices for. */
  readonly symbolsChange = output<string[]>();
  readonly closed = output<void>();
  readonly openNews = output<void>();
  /** "More technicals" on the technicals gauge. */
  readonly openTechnicals = output<void>();
  /** "More seasonals" on the seasonals panel. */
  readonly openSeasonals = output<void>();

  readonly flags = FLAGS;
  readonly split = splitPrice;
  readonly tickParts = tickParts;
  readonly pairFlags = pairFlags;
  readonly allColumns = WATCH_COLUMNS;
  readonly hotlists = HOTLISTS;
  readonly countdown = formatCountdown;

  readonly quotes = signal<Record<string, WatchQuote>>({});
  /** Why the last quote read failed (shown, not swallowed — SP-10); null when it worked. */
  readonly quoteError = signal<string | null>(null);
  readonly sort = signal<SortState>({ key: 'none', dir: 1 });
  readonly view = signal<WatchView>({ kind: 'list' });
  readonly hotlist = signal<Hotlist | null>(null);
  readonly hotlistError = signal<string | null>(null);
  /**
   * Each symbol's last tick: its direction and the price before it. TradingView colours the digits that tick changed
   * and keeps them coloured until the next tick (no timed flash).
   */
  readonly tick = signal<Record<string, { dir: 'up' | 'down'; prev: number }>>({});
  readonly listMenuOpen = signal(false);
  readonly moreMenuOpen = signal(false);
  readonly columnsMenuOpen = signal(false);
  readonly addOpen = signal(false);
  readonly addQuery = signal('');
  readonly rowMenu = signal<{ symbol: string; x: number; y: number } | null>(null);
  readonly editingSection = signal<string | null>(null);
  readonly dragging = signal<string | null>(null);
  readonly dropTarget = signal<{ sectionId: string; before: string | null } | null>(null);
  /** Fraction of the panel height the list takes; the rest is details. */
  readonly listFraction = signal(this.loadSplit());
  /** The last removal, for Undo (SP-11). */
  readonly undo = signal<{ listId: number; removed: RemovedItem } | null>(null);
  /** The row whose "Add alert" form is open. */
  readonly alertFor = signal<{ symbol: string; digits: number; last: number } | null>(null);
  /** Ticks for countdowns and sessions; paused while the tab is hidden. */
  readonly now = signal(Date.now());

  private readonly events = signal<CalendarEventLite[]>([]);
  private readonly newsScores = signal<ReadonlyMap<string, number> | null>(null);
  private readonly openPositions = signal<PositionLite[]>([]);
  private readonly hidden = signal(typeof document !== 'undefined' && document.hidden);

  private readonly addInput = viewChild<ElementRef<HTMLInputElement>>('addInput');
  private readonly alertDialog = viewChild<ElementRef<HTMLDialogElement>>('alertDialog');
  private lastBids: Record<string, number> = {};
  private undoTimer: ReturnType<typeof setTimeout> | null = null;
  private quoteSeq = 0;

  /** The open list — null while none is loaded (the store's `active` cannot say so in its type). */
  readonly list = computed<ChartWatchlist | null>(() => this.store.active() ?? null);
  readonly editable = computed(() => this.view().kind === 'list');
  /** Symbols of what is on screen (the list, a flagged list, or a hotlist). */
  readonly symbols = computed(() => {
    const v = this.view();
    if (v.kind === 'flag') return flaggedItems(this.store.lists(), v.flag).map((i) => i.symbol);
    if (v.kind === 'hotlist') return (this.hotlist()?.items ?? []).map((i) => i.symbol);
    return listSymbols(this.list());
  });
  readonly flagCounts = computed(() => flagCounts(this.store.lists()));

  readonly columns = computed<WatchColumn[]>(() => resolveColumns(this.list()?.settings?.columns));
  readonly columnKeys = computed(() => new Set(this.columns().map((c) => c.key)));
  private readonly needs = computed(() => neededData(this.columns()), {
    equal: (a, b) => a.size === b.size && [...a].every((n) => b.has(n)),
  });
  /** The row grid: flag, symbol, then one track per column (the dock scrolls sideways when they overflow). */
  readonly gridTemplate = computed(
    () => `16px minmax(84px, 1fr) ${this.columns().map((c) => `${c.width}px`).join(' ')}`,
  );

  private readonly pairBySymbol = computed(() => {
    const out = new Map<string, PairMeta>();
    for (const p of this.pairs() as PairMeta[]) out.set((p.symbol ?? '').toUpperCase(), p);
    return out;
  });

  private readonly digitsBySymbol = computed(() => {
    const out: Record<string, number> = {};
    for (const [sym, p] of this.pairBySymbol()) out[sym] = Math.trunc(p.decimalPlaces) || 5;
    return out;
  });

  private legs(symbol: string): Legs | null {
    const p = this.pairBySymbol().get(symbol);
    return legsOf(symbol, p?.baseCurrency, p?.quoteCurrency);
  }

  /** Accounts the P&L column sums over (the console's account scope). */
  private readonly scopeIds = computed(() => new Set(this.scope.accountIds()), {
    equal: (a, b) => a.size === b.size && [...a].every((x) => b.has(x)),
  });

  private readonly pnl = computed(() => pnlBySymbol(this.openPositions(), this.scopeIds()));

  private readonly rowContext = computed(() => {
    const keys = this.columnKeys();
    const ctx: Omit<RowContext, 'legs' | 'liveAsk'> = { nowMs: this.now() };
    if (keys.has('nextEvent')) ctx.events = this.events();
    if (keys.has('news')) ctx.newsScores = this.newsScores() ?? new Map();
    if (keys.has('pnl')) ctx.pnl = this.pnl();
    return ctx;
  });

  private row(item: WatchItem, sectionId: string, quote: WatchQuote | undefined): WatchRow {
    const sym = item.symbol;
    return rowFor(item, sectionId, quote, this.liveBids()[sym], undefined, this.digitsBySymbol()[sym] ?? 5, {
      ...this.rowContext(),
      legs: this.legs(sym),
      liveAsk: this.alerts.quote(sym)?.ask,
    });
  }

  readonly sections = computed<SectionView[]>(() => {
    const quotes = this.quotes();
    const sort = this.sort();
    const v = this.view();
    if (v.kind === 'flag') {
      const items = flaggedItems(this.store.lists(), v.flag);
      return [
        {
          id: `flag-${v.flag}`,
          name: `Flagged ${v.flag}`,
          collapsed: false,
          rows: sortRows(items.map((it) => this.row(it, '', quotes[it.symbol])), sort),
        },
      ];
    }
    if (v.kind === 'hotlist') {
      const hot = this.hotlist();
      // The engine's ranking is the order; the quotes come with it.
      const rows = (hot?.items ?? []).map((it) =>
        this.row({ symbol: it.symbol, flag: null }, '', quotes[it.symbol] ?? it.quote),
      );
      return [{ id: `hot-${v.hot}`, name: hot?.title ?? 'Hotlist', collapsed: false, rows }];
    }
    const list = this.list();
    if (!list) return [];
    return list.sections.map((s) => ({
      id: s.id,
      name: s.name,
      collapsed: s.collapsed,
      // Sorting is per section, like TradingView: sections keep their order.
      rows: sortRows(
        s.items.map((it) => this.row(it, s.id, quotes[it.symbol])),
        sort,
      ),
    }));
  });

  /** The ranked value per symbol in a hotlist view. */
  readonly hotValues = computed(() => {
    const out = new Map<string, number>();
    for (const it of this.hotlist()?.items ?? []) out.set(it.symbol, it.value);
    return out;
  });

  readonly viewTitle = computed(() => {
    const v = this.view();
    if (v.kind === 'flag') return `Flagged · ${v.flag}`;
    if (v.kind === 'hotlist') return HOTLISTS.find((h) => h.kind === v.hot)?.label ?? 'Hotlist';
    return this.list()?.name ?? 'Watchlist';
  });

  /** Visible order (collapsed sections skipped), for ↑/↓. */
  private readonly order = computed(() =>
    this.sections().flatMap((s) => (s.collapsed ? [] : s.rows.map((r) => r.symbol))),
  );

  readonly addCandidates = computed(() => {
    const have = new Set(listSymbols(this.list()));
    const q = this.addQuery().trim().toUpperCase();
    return this.pairs()
      .filter((p) => p.isActive !== false)
      .map((p) => ({
        symbol: (p.symbol ?? '').toUpperCase(),
        name: `${p.baseCurrency ?? ''} / ${p.quoteCurrency ?? ''}`,
      }))
      .filter((p) => p.symbol && (!q || p.symbol.includes(q) || p.name.toUpperCase().includes(q)))
      .map((p) => ({ ...p, added: have.has(p.symbol) }))
      .slice(0, 60);
  });

  readonly detail = computed(() => {
    const sym = this.current().toUpperCase();
    const pair = this.pairBySymbol().get(sym);
    const q = this.quotes()[sym];
    const row = this.row({ symbol: sym, flag: null }, '', q);
    const legs = this.legs(sym);
    return {
      symbol: sym,
      name: pair ? `${pair.baseCurrency} / ${pair.quoteCurrency}` : sym,
      // From the engine's asset class (SP-11): it said "Forex" for gold and indices alike.
      kind: instrumentKind(pair?.assetClass, sym, legs),
      quote: pair?.quoteCurrency ?? '',
      row,
      high: q?.dayHigh ?? null,
      low: q?.dayLow ?? null,
      open: q?.dayOpen ?? null,
      prevClose: q?.prevClose ?? null,
      marketOpen: q?.marketOpen ?? false,
      tradingDay: q?.tradingDay ?? null,
    };
  });

  constructor() {
    void this.store.load();
    this.alerts.ensureLoaded();
    this.destroyRef.onDestroy(() => {
      this.store.flush();
      if (this.undoTimer) clearTimeout(this.undoTimer);
    });

    // Polling pauses while the tab is hidden and catches up the moment it shows again (SP-11).
    const onVisibility = () => {
      this.hidden.set(document.hidden);
      if (!document.hidden) this.now.set(Date.now());
    };
    document.addEventListener('visibilitychange', onVisibility);
    this.destroyRef.onDestroy(() => document.removeEventListener('visibilitychange', onVisibility));
    const clock = setInterval(() => {
      if (!document.hidden) this.now.set(Date.now());
    }, CLOCK_MS);
    this.destroyRef.onDestroy(() => clearInterval(clock));

    // A list's saved sort applies when the list (or what is on screen) changes.
    effect(() => {
      const v = this.view();
      const settings = this.list()?.settings;
      untracked(() =>
        this.sort.set(v.kind === 'list' ? sortFromSettings(settings) : { key: 'none', dir: 1 }),
      );
    });

    // Tell the page which symbols need live prices.
    effect(() => {
      const syms = [...new Set([...this.symbols(), this.current().toUpperCase()])];
      untracked(() => this.symbolsChange.emit(syms));
    });

    // Day snapshot (plus the columns' extras): on list / column change, every 30s, and on returning to the tab.
    effect((onCleanup) => {
      if (this.hidden()) return;
      const all = [...new Set([...this.symbols(), this.current().toUpperCase()])];
      const needs = this.needs();
      const opts: QuoteOptions = { ranges: needs.has('ranges'), sparkline: needs.has('sparkline') };
      untracked(() => void this.refreshQuotes(all, opts));
      const timer = setInterval(() => void this.refreshQuotes(all, opts), QUOTE_REFRESH_MS);
      onCleanup(() => clearInterval(timer));
    });

    // Hotlist rows: read when shown, every minute while shown.
    effect((onCleanup) => {
      const v = this.view();
      if (v.kind !== 'hotlist' || this.hidden()) return;
      untracked(() => void this.loadHotlist(v.hot));
      const timer = setInterval(() => void this.loadHotlist(v.hot), HOTLIST_REFRESH_MS);
      onCleanup(() => clearInterval(timer));
    });

    // Next high-impact event: one calendar read for every currency on screen.
    effect((onCleanup) => {
      if (!this.needs().has('events') || this.hidden()) return;
      const ccys = this.currencies();
      const load = () =>
        this.calendar
          .upcoming({ currencies: ccys, minImpact: 'High' })
          .subscribe({ next: (rows) => this.events.set(rows ?? []), error: () => this.events.set([]) });
      untracked(load);
      const timer = setInterval(load, CONTEXT_REFRESH_MS);
      onCleanup(() => clearInterval(timer));
    });

    // News pressure per currency (base − quote per row).
    effect((onCleanup) => {
      if (!this.needs().has('news') || this.hidden()) return;
      const ccys = this.currencies();
      const load = () =>
        this.newsIntel.getPressure({ currencies: ccys, topItems: 1 }).subscribe({
          next: (rows) =>
            this.newsScores.set(new Map((rows ?? []).map((r) => [r.currency.toUpperCase(), r.weightedScore]))),
          // The module can be off, or the operator lack the permission: the column stays empty, not wrong.
          error: () => this.newsScores.set(null),
        });
      untracked(load);
      const timer = setInterval(load, CONTEXT_REFRESH_MS);
      onCleanup(() => clearInterval(timer));
    });

    // Open positions for the P&L column: every 30s and on every position event.
    effect((onCleanup) => {
      if (!this.needs().has('positions') || this.hidden()) return;
      untracked(() => void this.loadPositions());
      const timer = setInterval(() => void this.loadPositions(), POSITIONS_REFRESH_MS);
      const sub = this.realtime.on('positionLifecycleEvent').subscribe(() => void this.loadPositions());
      onCleanup(() => {
        clearInterval(timer);
        sub.unsubscribe();
      });
    });

    // Each tick records its direction and the price before it; the Last cell colours the digits that changed.
    effect(() => {
      const bids = this.liveBids();
      untracked(() => {
        const next: Record<string, { dir: 'up' | 'down'; prev: number }> = {};
        for (const [sym, bid] of Object.entries(bids)) {
          const prev = this.lastBids[sym];
          if (prev !== undefined && bid !== prev) next[sym] = { dir: bid > prev ? 'up' : 'down', prev };
        }
        this.lastBids = { ...bids };
        if (Object.keys(next).length) this.tick.update((t) => ({ ...t, ...next }));
      });
    });

    // Open the alert dialog as a true modal once its element exists.
    effect(() => {
      const el = this.alertDialog()?.nativeElement;
      if (el && this.alertFor() && !el.open && typeof el.showModal === 'function') el.showModal();
    });
  }

  /** Every currency leg on screen (for the calendar and news reads), stable for equal sets. */
  private readonly currencies = computed(
    () => {
      const out = new Set<string>();
      for (const s of this.symbols()) {
        const l = this.legs(s);
        if (l) {
          out.add(l.base);
          out.add(l.quote);
        }
      }
      return [...out].sort();
    },
    { equal: (a, b) => a.join() === b.join() },
  );

  private async refreshQuotes(symbols: string[], opts: QuoteOptions): Promise<void> {
    const n = ++this.quoteSeq;
    try {
      const qs = await this.store.quotes(symbols, opts);
      if (n !== this.quoteSeq) return;
      const map: Record<string, WatchQuote> = {};
      for (const q of qs) map[q.symbol.toUpperCase()] = q;
      this.quotes.set(map);
      this.quoteError.set(null);
    } catch (err) {
      if (n !== this.quoteSeq) return;
      // Keep the last quotes on screen; say why they are not updating.
      this.quoteError.set(
        `Quotes are not updating: ${err instanceof Error ? err.message : 'the engine did not answer'}.`,
      );
    }
  }

  private async loadHotlist(kind: HotlistKind): Promise<void> {
    try {
      const hot = await this.store.hotlist(kind);
      if (this.view().kind === 'hotlist') {
        this.hotlist.set(hot);
        this.hotlistError.set(null);
      }
    } catch (err) {
      this.hotlistError.set(err instanceof Error ? err.message : 'The hotlist could not be loaded.');
    }
  }

  private async loadPositions(): Promise<void> {
    try {
      const rows = await firstValueFrom(
        this.positions
          .list({ currentPage: 1, itemCountPerPage: 500, filter: { status: 'Open' } })
          .pipe(map((r) => r?.data?.data ?? [])),
      );
      this.openPositions.set(
        rows.map((p) => ({
          symbol: p.symbol,
          unrealizedPnL: p.unrealizedPnL,
          tradingAccountId: p.tradingAccountId,
          status: p.status,
        })),
      );
    } catch {
      this.openPositions.set([]);
    }
  }

  // ── views ──
  showList(id: number): void {
    this.listMenuOpen.set(false);
    this.view.set({ kind: 'list' });
    if (id !== this.list()?.id) void this.store.activate(id);
  }

  showFlag(flag: WatchFlag): void {
    this.listMenuOpen.set(false);
    this.view.set({ kind: 'flag', flag });
  }

  showHotlist(kind: HotlistKind): void {
    this.listMenuOpen.set(false);
    this.hotlist.set(null);
    this.hotlistError.set(null);
    this.view.set({ kind: 'hotlist', hot: kind });
  }

  // ── list edits ──
  private edit(fn: (l: ChartWatchlist) => ChartWatchlist): void {
    const list = this.list();
    if (list && this.editable()) this.store.update(fn(list));
  }

  pick(symbol: string): void {
    this.selected.emit(symbol);
  }

  add(symbol: string): void {
    const list = this.list();
    if (!list) return;
    this.store.update(addSymbol(list, symbol));
    this.selected.emit(symbol);
  }

  addFirstMatch(): void {
    const hit = this.addCandidates().find((c) => !c.added);
    if (hit) this.add(hit.symbol);
  }

  /** Remove a symbol, keeping where it was for Undo. */
  remove(symbol: string): void {
    const list = this.list();
    if (!list || !this.editable()) return;
    const removed = locate(list, symbol);
    this.store.update(removeSymbol(list, symbol));
    this.rowMenu.set(null);
    if (!removed) return;
    if (this.undoTimer) clearTimeout(this.undoTimer);
    this.undo.set({ listId: list.id, removed });
    this.undoTimer = setTimeout(() => {
      this.undoTimer = null;
      this.undo.set(null);
    }, UNDO_MS);
  }

  undoRemove(): void {
    const u = this.undo();
    if (!u) return;
    const list = this.store.lists().find((l) => l.id === u.listId);
    if (list) this.store.update(restoreSymbol(list, u.removed));
    if (this.undoTimer) clearTimeout(this.undoTimer);
    this.undoTimer = null;
    this.undo.set(null);
    this.selected.emit(u.removed.item.symbol);
  }

  cycleFlag(row: WatchRow, ev: Event): void {
    ev.stopPropagation();
    this.edit((l) => setFlag(l, row.symbol, cycleFlag(row.flag)));
  }

  setFlag(symbol: string, flag: WatchFlag | null): void {
    this.edit((l) => setFlag(l, symbol, flag));
    this.rowMenu.set(null);
  }

  moveTo(symbol: string, sectionId: string): void {
    this.edit((l) => moveSymbol(l, symbol, sectionId, null));
    this.rowMenu.set(null);
  }

  toggleSection(id: string): void {
    this.edit((l) => toggleSection(l, id));
  }

  async newSection(): Promise<void> {
    this.moreMenuOpen.set(false);
    const name = await askName(this.dialogs, {
      title: 'New section',
      label: 'Section name',
      value: 'New section',
      confirmLabel: 'Add',
    });
    if (name !== null) this.edit((l) => addSection(l, name));
  }

  commitSectionName(id: string, name: string): void {
    this.editingSection.set(null);
    this.edit((l) => renameSection(l, id, name));
  }

  deleteSection(id: string): void {
    this.edit((l) => removeSection(l, id));
  }

  // ── columns + sort (saved with the list) ──
  isColumnOn(key: WatchColumnKey): boolean {
    return this.columnKeys().has(key);
  }

  toggleColumn(key: WatchColumnKey): void {
    const list = this.list();
    if (!list) return;
    const columns = toggleColumn(this.columns().map((c) => c.key), key);
    const sort = this.sort();
    // A sort on a column that is no longer shown would order the rows by something invisible.
    const keepSort = sort.key === 'none' || sort.key === 'symbol' || columns.includes(sort.key as WatchColumnKey);
    if (!keepSort) this.sort.set({ key: 'none', dir: 1 });
    this.saveSettings(columns, keepSort ? sort : { key: 'none', dir: 1 });
  }

  resetColumns(): void {
    const list = this.list();
    if (!list) return;
    this.sort.set({ key: 'none', dir: 1 });
    this.store.setSettings(list.id, { columns: resolveColumns(null).map((c) => c.key), sort: null });
  }

  sortBy(key: SortKey): void {
    const next = nextSort(this.sort(), key);
    this.sort.set(next);
    if (this.view().kind === 'list') this.saveSettings(this.columns().map((c) => c.key), next);
  }

  clearSort(): void {
    this.sort.set({ key: 'none', dir: 1 });
    if (this.view().kind === 'list') this.saveSettings(this.columns().map((c) => c.key), this.sort());
    this.moreMenuOpen.set(false);
  }

  private saveSettings(columns: WatchColumnKey[], sort: SortState): void {
    const list = this.list();
    if (!list) return;
    this.store.setSettings(list.id, {
      columns,
      sort: sort.key === 'none' ? null : { key: sort.key, dir: sort.dir },
    });
  }

  sortMark(key: SortKey): string {
    const s = this.sort();
    return s.key !== key ? '' : s.dir === 1 ? '▲' : '▼';
  }

  sparkPoints(values: number[] | null): string {
    return sparklinePoints(values, 54, 18);
  }

  /** Whether a sparkline ended above its start (green) or below (red). */
  sparkUp(values: number[] | null): boolean {
    return !!values && values.length > 1 && values[values.length - 1] >= values[0];
  }

  // ── alert from a row (the alerts vertical's form and service) ──
  openAlert(row: WatchRow): void {
    this.rowMenu.set(null);
    this.alertFor.set({ symbol: row.symbol, digits: row.digits, last: row.last ?? 0 });
  }

  closeAlert(): void {
    const el = this.alertDialog()?.nativeElement;
    if (el?.open) el.close();
    this.alertFor.set(null);
  }

  /** Add a symbol from a flagged list or a hotlist to the open list. */
  addToList(symbol: string): void {
    this.rowMenu.set(null);
    const list = this.list();
    if (list) this.store.update(addSymbol(list, symbol));
  }

  // ── lists ──
  async newList(): Promise<void> {
    this.listMenuOpen.set(false);
    const name = await askName(this.dialogs, {
      title: 'New watchlist',
      label: 'Watchlist name',
      value: 'Watchlist',
      confirmLabel: 'Create',
    });
    if (name !== null) {
      this.view.set({ kind: 'list' });
      await this.store.create(name);
    }
  }

  async copyList(): Promise<void> {
    this.listMenuOpen.set(false);
    const list = this.list();
    if (!list) return;
    const name = await askName(this.dialogs, {
      title: 'Copy watchlist',
      label: 'Name of the copy',
      value: `${list.name} copy`,
      confirmLabel: 'Copy',
    });
    if (name !== null) await this.store.create(name, list);
  }

  async renameList(): Promise<void> {
    this.listMenuOpen.set(false);
    const list = this.list();
    if (!list) return;
    const name = await askName(this.dialogs, {
      title: 'Rename watchlist',
      label: 'Watchlist name',
      value: list.name,
      confirmLabel: 'Rename',
    });
    if (name !== null) await this.store.rename(list.id, name);
  }

  async deleteList(): Promise<void> {
    this.listMenuOpen.set(false);
    const list = this.list();
    if (list && (await confirmDelete(this.dialogs, `the watchlist “${list.name}”`)))
      await this.store.remove(list.id);
  }

  openAdd(ev: Event): void {
    ev.stopPropagation();
    this.view.set({ kind: 'list' });
    this.addOpen.set(!this.addOpen());
    this.addQuery.set('');
    setTimeout(() => this.addInput()?.nativeElement.focus());
  }

  openRowMenu(row: WatchRow, ev: MouseEvent): void {
    ev.preventDefault();
    ev.stopPropagation();
    const box = (this.host.nativeElement as HTMLElement).getBoundingClientRect();
    this.rowMenu.set({ symbol: row.symbol, x: ev.clientX - box.left, y: ev.clientY - box.top });
  }

  rowBySymbol(symbol: string): WatchRow | undefined {
    for (const s of this.sections()) {
      const r = s.rows.find((x) => x.symbol === symbol);
      if (r) return r;
    }
    return undefined;
  }

  closeMenus(): void {
    this.listMenuOpen.set(false);
    this.moreMenuOpen.set(false);
    this.columnsMenuOpen.set(false);
    this.rowMenu.set(null);
  }

  // ── drag and drop ──
  onDragStart(symbol: string, ev: DragEvent): void {
    if (!this.editable()) return;
    this.dragging.set(symbol);
    ev.dataTransfer?.setData('text/plain', symbol);
    if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move';
  }

  onDragOver(sectionId: string, before: string | null, ev: DragEvent): void {
    if (!this.dragging()) return;
    ev.preventDefault();
    const t = this.dropTarget();
    if (t?.sectionId !== sectionId || t.before !== before)
      this.dropTarget.set({ sectionId, before });
  }

  onDrop(ev: DragEvent): void {
    ev.preventDefault();
    const symbol = this.dragging();
    const target = this.dropTarget();
    this.dragging.set(null);
    this.dropTarget.set(null);
    if (!symbol || !target) return;
    // A manual order only means something unsorted.
    this.sort.set({ key: 'none', dir: 1 });
    this.saveSettings(this.columns().map((c) => c.key), this.sort());
    this.edit((l) => moveSymbol(l, symbol, target.sectionId, target.before));
  }

  onDragEnd(): void {
    this.dragging.set(null);
    this.dropTarget.set(null);
  }

  // ── keyboard ──
  onKeydown(ev: KeyboardEvent): void {
    const tag = (ev.target as HTMLElement | null)?.tagName ?? '';
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag)) return;
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z' && this.undo()) {
      ev.preventDefault();
      ev.stopPropagation();
      this.undoRemove();
      return;
    }
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      const next = neighbour(
        this.order(),
        this.current().toUpperCase(),
        ev.key === 'ArrowDown' ? 1 : -1,
      );
      if (next) {
        ev.preventDefault();
        ev.stopPropagation();
        this.selected.emit(next);
        queueMicrotask(() =>
          (this.host.nativeElement as HTMLElement)
            .querySelector(`[data-symbol="${next}"]`)
            ?.scrollIntoView({ block: 'nearest' }),
        );
      }
    } else if ((ev.key === 'Delete' || ev.key === 'Backspace') && this.editable()) {
      const cur = this.current().toUpperCase();
      if (listSymbols(this.list()).includes(cur)) {
        ev.preventDefault();
        ev.stopPropagation();
        const next = neighbour(this.order(), cur, 1) ?? neighbour(this.order(), cur, -1);
        // Undo-able (inline "Undo" and Ctrl/⌘+Z): Backspace used to drop the charted symbol for good.
        this.remove(cur);
        if (next) this.selected.emit(next);
      }
    }
  }

  // ── list/details split ──
  startResize(ev: PointerEvent): void {
    ev.preventDefault();
    const el = this.host.nativeElement as HTMLElement;
    const box = el.getBoundingClientRect();
    const move = (e: PointerEvent) => {
      const f = Math.min(0.85, Math.max(0.2, (e.clientY - box.top) / box.height));
      this.listFraction.set(f);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      this.prefs.setItem(SPLIT_KEY, String(this.listFraction()));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  private loadSplit(): number {
    try {
      const v = Number(localStorage.getItem(SPLIT_KEY));
      return v >= 0.2 && v <= 0.85 ? v : 0.55;
    } catch {
      return 0.55;
    }
  }

  trackRow = (_: number, r: WatchRow) => r.symbol;
}
