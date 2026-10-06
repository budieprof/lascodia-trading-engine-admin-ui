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
import type { CurrencyPairDto } from '@core/api/api.types';
import type { Ohlc } from '../indicators/math';
import { ChartIconComponent } from '../icons/chart-icon.component';
import { PerformanceTilesComponent } from '../panels/performance-tiles.component';
import { SeasonalsComponent } from '../panels/seasonals.component';
import { TechnicalsGaugeComponent } from '../panels/technicals-gauge.component';
import { WatchlistService } from './watchlist.service';
import {
  FLAGS,
  addSection,
  addSymbol,
  cycleFlag,
  listSymbols,
  moveSymbol,
  neighbour,
  nextSort,
  removeSection,
  removeSymbol,
  renameSection,
  rowFor,
  setFlag,
  sortRows,
  splitPrice,
  toggleSection,
  type ChartWatchlist,
  type SortKey,
  type SortState,
  type WatchFlag,
  type WatchQuote,
  type WatchRow,
} from './watchlist.model';
import { ChartPrefsService } from '../workspace/chart-prefs.service';

const QUOTE_REFRESH_MS = 30_000;
const FLASH_MS = 700;
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

/**
 * TradingView-style watchlist dock: named lists, collapsible sections,
 * Symbol / Last / Chg / Chg% columns with header sorting, live ticks with an
 * up/down flash, colour flags, drag-to-reorder, ↑/↓ to walk the chart through
 * the list, and the selected symbol's details underneath.
 */
@Component({
  selector: 'app-watchlist-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DecimalPipe,
    ChartIconComponent,
    PerformanceTilesComponent,
    SeasonalsComponent,
    TechnicalsGaugeComponent,
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

  readonly quotes = signal<Record<string, WatchQuote>>({});
  readonly sort = signal<SortState>({ key: 'none', dir: 1 });
  readonly flash = signal<Record<string, 'up' | 'down'>>({});
  readonly listMenuOpen = signal(false);
  readonly moreMenuOpen = signal(false);
  readonly addOpen = signal(false);
  readonly addQuery = signal('');
  readonly rowMenu = signal<{ symbol: string; x: number; y: number } | null>(null);
  readonly editingSection = signal<string | null>(null);
  readonly dragging = signal<string | null>(null);
  readonly dropTarget = signal<{ sectionId: string; before: string | null } | null>(null);
  /** Fraction of the panel height the list takes; the rest is details. */
  readonly listFraction = signal(this.loadSplit());

  private readonly addInput = viewChild<ElementRef<HTMLInputElement>>('addInput');
  private lastBids: Record<string, number> = {};
  private flashTimers = new Map<string, ReturnType<typeof setTimeout>>();

  readonly list = computed(() => this.store.active());
  readonly symbols = computed(() => listSymbols(this.list()));

  private readonly digitsBySymbol = computed(() => {
    const out: Record<string, number> = {};
    for (const p of this.pairs())
      out[(p.symbol ?? '').toUpperCase()] = Math.trunc(p.decimalPlaces) || 5;
    return out;
  });

  readonly sections = computed<SectionView[]>(() => {
    const list = this.list();
    if (!list) return [];
    const quotes = this.quotes();
    const bids = this.liveBids();
    const digits = this.digitsBySymbol();
    const sort = this.sort();
    return list.sections.map((s) => ({
      id: s.id,
      name: s.name,
      collapsed: s.collapsed,
      // Sorting is per section, like TradingView: sections keep their order.
      rows: sortRows(
        s.items.map((it) =>
          rowFor(it, s.id, quotes[it.symbol], bids[it.symbol], undefined, digits[it.symbol] ?? 5),
        ),
        sort,
      ),
    }));
  });

  /** Visible order (collapsed sections skipped), for ↑/↓. */
  private readonly order = computed(() =>
    this.sections().flatMap((s) => (s.collapsed ? [] : s.rows.map((r) => r.symbol))),
  );

  readonly addCandidates = computed(() => {
    const have = new Set(this.symbols());
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
    const pair = this.pairs().find((p) => (p.symbol ?? '').toUpperCase() === sym);
    const q = this.quotes()[sym];
    const row = rowFor(
      { symbol: sym, flag: null },
      '',
      q,
      this.liveBids()[sym],
      undefined,
      this.digitsBySymbol()[sym] ?? 5,
    );
    return {
      symbol: sym,
      name: pair ? `${pair.baseCurrency} / ${pair.quoteCurrency}` : sym,
      quote: pair?.quoteCurrency ?? '',
      row,
      high: q?.dayHigh ?? null,
      low: q?.dayLow ?? null,
      open: q?.dayOpen ?? null,
      prevClose: q?.prevClose ?? null,
      marketOpen: q?.marketOpen ?? false,
    };
  });

  constructor() {
    void this.store.load();
    inject(DestroyRef).onDestroy(() => {
      this.store.flush();
      for (const t of this.flashTimers.values()) clearTimeout(t);
    });

    // Tell the page which symbols need live prices.
    effect(() => {
      const syms = [...new Set([...this.symbols(), this.current().toUpperCase()])];
      untracked(() => this.symbolsChange.emit(syms));
    });

    // Daily-change snapshot: on list change and every 30s.
    effect((onCleanup) => {
      const syms = this.symbols();
      const cur = this.current().toUpperCase();
      const all = [...new Set([...syms, cur])];
      const refresh = () =>
        this.store
          .quotes(all)
          .then((qs) => {
            const map: Record<string, WatchQuote> = {};
            for (const q of qs) map[q.symbol.toUpperCase()] = q;
            this.quotes.set(map);
          })
          .catch(() => undefined);
      void refresh();
      const timer = setInterval(refresh, QUOTE_REFRESH_MS);
      onCleanup(() => clearInterval(timer));
    });

    // Up/down flash on every tick, like TradingView's cell highlight.
    effect(() => {
      const bids = this.liveBids();
      untracked(() => {
        const next: Record<string, 'up' | 'down'> = {};
        for (const [sym, bid] of Object.entries(bids)) {
          const prev = this.lastBids[sym];
          if (prev !== undefined && bid !== prev) next[sym] = bid > prev ? 'up' : 'down';
        }
        this.lastBids = { ...bids };
        if (!Object.keys(next).length) return;
        this.flash.update((f) => ({ ...f, ...next }));
        for (const sym of Object.keys(next)) {
          const t = this.flashTimers.get(sym);
          if (t) clearTimeout(t);
          this.flashTimers.set(
            sym,
            setTimeout(() => {
              this.flashTimers.delete(sym);
              this.flash.update((f) => {
                const { [sym]: _, ...rest } = f;
                return rest;
              });
            }, FLASH_MS),
          );
        }
      });
    });
  }

  // ── list edits ──
  private edit(fn: (l: ChartWatchlist) => ChartWatchlist): void {
    const list = this.list();
    if (list) this.store.update(fn(list));
  }

  pick(symbol: string): void {
    this.selected.emit(symbol);
  }

  add(symbol: string): void {
    this.edit((l) => addSymbol(l, symbol));
    this.selected.emit(symbol);
  }

  addFirstMatch(): void {
    const hit = this.addCandidates().find((c) => !c.added);
    if (hit) this.add(hit.symbol);
  }

  remove(symbol: string): void {
    this.edit((l) => removeSymbol(l, symbol));
    this.rowMenu.set(null);
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

  newSection(): void {
    const name = prompt('Section name', 'New section');
    if (name !== null) this.edit((l) => addSection(l, name));
    this.moreMenuOpen.set(false);
  }

  commitSectionName(id: string, name: string): void {
    this.editingSection.set(null);
    this.edit((l) => renameSection(l, id, name));
  }

  deleteSection(id: string): void {
    this.edit((l) => removeSection(l, id));
  }

  sortBy(key: SortKey): void {
    this.sort.update((s) => nextSort(s, key));
  }

  sortMark(key: SortKey): string {
    const s = this.sort();
    return s.key !== key ? '' : s.dir === 1 ? '▲' : '▼';
  }

  // ── lists ──
  async newList(): Promise<void> {
    this.listMenuOpen.set(false);
    const name = prompt('New watchlist name', 'Watchlist');
    if (name?.trim()) await this.store.create(name.trim());
  }

  async copyList(): Promise<void> {
    this.listMenuOpen.set(false);
    const list = this.list();
    const name = list && prompt('Name of the copy', `${list.name} copy`);
    if (list && name?.trim()) await this.store.create(name.trim(), list);
  }

  async renameList(): Promise<void> {
    this.listMenuOpen.set(false);
    const list = this.list();
    const name = list && prompt('Rename watchlist', list.name);
    if (list && name?.trim()) await this.store.rename(list.id, name);
  }

  async deleteList(): Promise<void> {
    this.listMenuOpen.set(false);
    const list = this.list();
    if (list && confirm(`Delete the watchlist "${list.name}"?`)) await this.store.remove(list.id);
  }

  async switchList(id: number): Promise<void> {
    this.listMenuOpen.set(false);
    await this.store.activate(id);
  }

  openAdd(ev: Event): void {
    ev.stopPropagation();
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

  closeMenus(): void {
    this.listMenuOpen.set(false);
    this.moreMenuOpen.set(false);
    this.rowMenu.set(null);
  }

  // ── drag and drop ──
  onDragStart(symbol: string, ev: DragEvent): void {
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
    } else if (ev.key === 'Delete' || ev.key === 'Backspace') {
      const cur = this.current().toUpperCase();
      if (this.symbols().includes(cur)) {
        ev.preventDefault();
        ev.stopPropagation();
        const next = neighbour(this.order(), cur, 1) ?? neighbour(this.order(), cur, -1);
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
