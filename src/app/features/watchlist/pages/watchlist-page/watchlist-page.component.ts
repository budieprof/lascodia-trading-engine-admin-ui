import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { map } from 'rxjs';

import { CurrencyPairsService } from '@core/services/currency-pairs.service';
import { NotificationService } from '@core/notifications/notification.service';
import { PositionsService } from '@core/services/positions.service';
import { OrdersService } from '@core/services/orders.service';
import { createPolledResource } from '@core/polling/polled-resource';
import type { CurrencyPairDto, PositionDto, OrderDto } from '@core/api/api.types';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';

import { MiniChartTileComponent } from '../../components/mini-chart-tile/mini-chart-tile.component';

/**
 * Multi-symbol watchlist — a single page that renders one mini-chart tile
 * per watched (symbol, timeframe) so the operator can scan many pairs at
 * a glance without paging through the single chart for each one. Each
 * tile owns its own candle + live-price polling; clicking a tile drops
 * the operator into the full chart at that pair via a deep-link hand-off.
 *
 * <ul>
 *   <li>State is BROWSER-ONLY (localStorage). No engine config writes —
 *       SpotAnalysisWorker:Pairs (the live-analysis watch list) is a
 *       separate concept and stays managed via the chart toolbar's Live
 *       toggle.</li>
 *   <li>Timeframe is GLOBAL across the grid — the same TF applies to every
 *       tile. The single-chart page is the place for cross-TF scans.</li>
 *   <li>Add UX is a single text input with chip-add on Enter (or click).
 *       Validated against the engine's CurrencyPair catalogue so a typo
 *       lands on a "symbol not registered" hint rather than silently
 *       adding a tile that will never receive data.</li>
 * </ul>
 */
interface WatchlistEntry {
  symbol: string;
  timeframe: string;
}

/**
 * Wall density: each preset controls both the responsive grid's minimum
 * tile width AND the chart-area height inside the tile. Together that
 * makes the candles get wider AND taller — bigger candles, fewer per
 * row. Persisted separately from the entries list so changing size
 * doesn't churn the watchlist payload.
 */
type TileSize = 'sm' | 'md' | 'lg' | 'xl';

const STORAGE_KEY = 'tradingChart.watchlist.v1';
const SIZE_STORAGE_KEY = 'tradingChart.watchlist.size.v1';
const BARS_STORAGE_KEY = 'tradingChart.watchlist.bars.v1';
const SHOW_POSITIONS_STORAGE_KEY = 'tradingChart.watchlist.showPositions.v1';
const SHOW_ORDERS_STORAGE_KEY = 'tradingChart.watchlist.showOrders.v1';
const TF_OPTIONS: ReadonlyArray<string> = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1', 'W1'];
const SIZE_OPTIONS: ReadonlyArray<{ value: TileSize; label: string; minPx: number }> = [
  { value: 'sm', label: 'S', minPx: 320 },
  { value: 'md', label: 'M', minPx: 420 },
  { value: 'lg', label: 'L', minPx: 560 },
  { value: 'xl', label: 'XL', minPx: 720 },
];
/** Bar-count presets for the candles each tile fetches. 60 is the
 *  original default; 500 covers ~6 weeks of M5 / ~10 weeks of H1 /
 *  multi-year D1 — enough to scan structural context without paginating. */
const BAR_COUNT_OPTIONS: ReadonlyArray<number> = [60, 120, 240, 500];

@Component({
  selector: 'app-watchlist-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, PageHeaderComponent, MiniChartTileComponent],
  template: `
    <div class="page">
      <app-page-header
        title="Watchlist"
        subtitle="Mini-charts for every symbol you're watching. Click a tile to open the full chart."
      >
        @if (catalogueSymbols().length > 0) {
          <button
            type="button"
            class="btn-ghost"
            (click)="resetToAllPairs()"
            [title]="
              'Replace the watchlist with every active currency pair (' +
              catalogueSymbols().length +
              ')'
            "
          >
            Reset to all pairs
          </button>
        }
        @if (entries().length > 0) {
          <button type="button" class="btn-ghost" (click)="clearAll()" title="Remove all tiles">
            Clear all
          </button>
        }
      </app-page-header>

      <!-- ── Toolbar: timeframe + size + add-symbol ──────────────── -->
      <section class="toolbar" aria-label="Watchlist controls">
        <div class="tf-group" role="tablist" aria-label="Timeframe">
          <span class="tf-label">Timeframe</span>
          @for (tf of timeframeOptions; track tf) {
            <button
              type="button"
              role="tab"
              class="tf-btn"
              [class.active]="globalTimeframe() === tf"
              [attr.aria-selected]="globalTimeframe() === tf"
              (click)="setGlobalTimeframe(tf)"
            >
              {{ tf }}
            </button>
          }
        </div>
        <div class="tf-group" role="tablist" aria-label="Tile size">
          <span class="tf-label">Size</span>
          @for (s of sizeOptions; track s.value) {
            <button
              type="button"
              role="tab"
              class="tf-btn"
              [class.active]="tileSize() === s.value"
              [attr.aria-selected]="tileSize() === s.value"
              (click)="setTileSize(s.value)"
              [title]="
                'Min tile width ' +
                s.minPx +
                ' px — ' +
                (s.value === 'sm'
                  ? 'compact wall, many tiles'
                  : s.value === 'md'
                    ? 'comfortable default'
                    : s.value === 'lg'
                      ? 'large candles, ~3 columns'
                      : 'extra-large candles, ~2 columns')
              "
            >
              {{ s.label }}
            </button>
          }
        </div>
        <div class="tf-group" role="tablist" aria-label="Candles per tile">
          <span class="tf-label">Bars</span>
          @for (n of barCountOptions; track n) {
            <button
              type="button"
              role="tab"
              class="tf-btn"
              [class.active]="barCount() === n"
              [attr.aria-selected]="barCount() === n"
              (click)="setBarCount(n)"
              [title]="'Fetch and render ' + n + ' candles per tile'"
            >
              {{ n }}
            </button>
          }
        </div>
        <div class="tf-group" role="group" aria-label="Chart overlays">
          <span class="tf-label">Overlays</span>
          <button
            type="button"
            class="tf-btn"
            [class.active]="showPositions()"
            [attr.aria-pressed]="showPositions()"
            (click)="togglePositions()"
            title="Show open-position entry / SL / TP lines on each tile"
          >
            Positions
          </button>
          <button
            type="button"
            class="tf-btn"
            [class.active]="showOrders()"
            [attr.aria-pressed]="showOrders()"
            (click)="toggleOrders()"
            title="Show pending-order price / SL / TP lines on each tile"
          >
            Orders
          </button>
        </div>
        <div class="add-wrap">
          <input
            #addInput
            type="text"
            class="add-input"
            placeholder="Add symbol (e.g. EURUSD or EUR/USD)…"
            [ngModel]="addDraft()"
            (ngModelChange)="addDraft.set($event)"
            (keydown.enter)="addFromInput()"
            list="watchlist-symbols"
            aria-label="Add symbol to watchlist"
          />
          <datalist id="watchlist-symbols">
            @for (s of catalogueSymbols(); track s) {
              <option [value]="s"></option>
            }
          </datalist>
          <button
            type="button"
            class="add-btn"
            [disabled]="!canAdd()"
            (click)="addFromInput()"
            title="Add this symbol to the watchlist at the selected timeframe"
          >
            Add
          </button>
        </div>
        <span class="muted small grid-meta">
          {{ entries().length }} tile{{ entries().length === 1 ? '' : 's' }}
        </span>
      </section>

      <!-- ── Grid / empty state ──────────────────────────────────── -->
      @if (seeding()) {
        <section class="empty" role="status">
          <h3>Loading symbols…</h3>
          <p class="muted">
            Seeding the watchlist with every active currency pair from the engine catalogue.
          </p>
        </section>
      } @else if (entries().length === 0) {
        <section class="empty" role="status">
          <h3>No symbols on the watchlist yet</h3>
          <p class="muted">
            Add a symbol above to start watching, or
            @if (catalogueSymbols().length > 0) {
              <button type="button" class="link-btn" (click)="resetToAllPairs()">
                load every active pair
              </button>
              .
            } @else {
              wait for the currency-pair catalogue to load.
            }
            Tiles refresh every few seconds — clicking one opens the full chart on the Market Data
            page.
          </p>
          @if (catalogueSymbols().length > 0) {
            <div class="empty-suggest">
              <span class="muted small">Quick add:</span>
              @for (s of suggestionSymbols(); track s) {
                <button
                  type="button"
                  class="chip"
                  (click)="addEntry(s, globalTimeframe())"
                  [title]="'Add ' + s + ' at ' + globalTimeframe()"
                >
                  + {{ s }}
                </button>
              }
            </div>
          }
        </section>
      } @else {
        <section class="grid" [style.--tile-min-width.px]="currentSizeMinPx()">
          @for (e of entries(); track e.symbol + '|' + e.timeframe) {
            <app-mini-chart-tile
              [symbol]="e.symbol"
              [timeframe]="e.timeframe"
              [size]="tileSize()"
              [barCount]="barCount()"
              [positions]="openPositions()"
              [orders]="pendingOrders()"
              [showPositions]="showPositions()"
              [showOrders]="showOrders()"
              (remove)="removeEntry(e)"
            />
          }
        </section>
      }
    </div>
  `,
  styles: [
    `
      .page {
        padding: var(--space-2) 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }

      .btn-ghost {
        appearance: none;
        background: transparent;
        border: 1px solid var(--border);
        color: var(--text-secondary);
        font-family: inherit;
        font-size: 12px;
        font-weight: var(--font-semibold);
        padding: 5px 12px;
        border-radius: var(--radius-sm);
        cursor: pointer;
      }
      .btn-ghost:hover {
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }

      /* ── Toolbar ─────────────────────────────────────────────── */
      .toolbar {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-3);
        align-items: center;
        padding: var(--space-2) var(--space-3);
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
      }
      .tf-group {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        flex-wrap: wrap;
      }
      .tf-label {
        font-size: 10px;
        font-weight: var(--font-semibold);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        margin-right: 4px;
      }
      .tf-btn {
        appearance: none;
        background: var(--bg-primary);
        border: 1px solid var(--border);
        color: var(--text-secondary);
        font-family: inherit;
        font-size: 11px;
        font-weight: var(--font-semibold);
        padding: 4px 10px;
        border-radius: var(--radius-sm);
        cursor: pointer;
      }
      .tf-btn:hover {
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }
      .tf-btn.active {
        background: var(--accent, #0071e3);
        border-color: var(--accent, #0071e3);
        color: white;
      }

      .add-wrap {
        display: inline-flex;
        gap: 4px;
        align-items: center;
        flex: 1 1 280px;
        min-width: 260px;
      }
      .add-input {
        flex: 1;
        height: 30px;
        padding: 0 10px;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: 12px;
        outline: none;
      }
      .add-input:focus {
        border-color: var(--accent, #0071e3);
      }
      .add-btn {
        appearance: none;
        height: 30px;
        padding: 0 14px;
        background: var(--accent, #0071e3);
        color: white;
        border: none;
        border-radius: var(--radius-sm);
        font-size: 12px;
        font-weight: var(--font-semibold);
        cursor: pointer;
      }
      .add-btn:disabled {
        background: var(--bg-tertiary);
        color: var(--text-tertiary);
        cursor: not-allowed;
      }
      .grid-meta {
        margin-left: auto;
      }

      /* ── Grid ───────────────────────────────────────────────── */
      .grid {
        display: grid;
        /* --tile-min-width is bound from the toolbar's size selector;
           320 px fallback matches the old "compact" default for the
           initial render frame before the binding settles. */
        grid-template-columns: repeat(auto-fit, minmax(var(--tile-min-width, 320px), 1fr));
        gap: var(--space-3);
      }

      /* ── Empty state ────────────────────────────────────────── */
      .empty {
        padding: var(--space-5) var(--space-4);
        text-align: center;
        background: var(--bg-secondary);
        border: 1px dashed var(--border);
        border-radius: var(--radius-md);
      }
      .empty h3 {
        margin: 0 0 8px 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .empty p {
        margin: 0 auto 16px auto;
        max-width: 520px;
        font-size: var(--text-sm);
      }
      .empty-suggest {
        display: inline-flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px;
        justify-content: center;
      }
      .chip {
        appearance: none;
        background: var(--bg-primary);
        border: 1px solid var(--border);
        color: var(--text-primary);
        font-family: var(--font-mono, monospace);
        font-size: 12px;
        padding: 3px 10px;
        border-radius: var(--radius-full);
        cursor: pointer;
      }
      .chip:hover {
        background: var(--bg-tertiary);
        border-color: var(--accent, #0071e3);
      }
      .link-btn {
        appearance: none;
        background: transparent;
        border: none;
        color: var(--accent, #0071e3);
        font-family: inherit;
        font-size: inherit;
        font-weight: var(--font-semibold);
        padding: 0;
        cursor: pointer;
      }
      .link-btn:hover {
        text-decoration: underline;
      }

      .muted {
        color: var(--text-tertiary);
      }
      .small {
        font-size: 11px;
      }
    `,
  ],
})
export class WatchlistPageComponent implements OnInit {
  private readonly pairsService = inject(CurrencyPairsService);
  private readonly notifications = inject(NotificationService);
  private readonly positionsService = inject(PositionsService);
  private readonly ordersService = inject(OrdersService);

  /** Chart-overlay toggles — show open positions / pending orders on every
   *  tile. Persisted so the operator's choice survives reloads. */
  protected readonly showPositions = signal<boolean>(false);
  protected readonly showOrders = signal<boolean>(false);

  // Poll positions/orders every 15s from page load (cheap — two requests) so
  // the data is already in hand the instant the operator flips a toggle. The
  // toggles gate only the *display* (tile-side), not the fetch.
  private readonly positionsRes = createPolledResource(
    () =>
      this.positionsService
        .list({ currentPage: 1, itemCountPerPage: 200, filter: { status: 'Open' } })
        .pipe(map((r) => r?.data?.data ?? [])),
    { intervalMs: 15000 },
  );
  // Orders fetched unfiltered (the working-status set spans Pending/Submitted/
  // PartialFill and the filter takes a single status); the tile filters them.
  private readonly ordersRes = createPolledResource(
    () =>
      this.ordersService
        .list({ currentPage: 1, itemCountPerPage: 200, filter: null })
        .pipe(map((r) => r?.data?.data ?? [])),
    { intervalMs: 15000 },
  );
  protected readonly openPositions = computed<PositionDto[]>(() => this.positionsRes.value() ?? []);
  protected readonly pendingOrders = computed<OrderDto[]>(() => this.ordersRes.value() ?? []);

  protected readonly timeframeOptions = TF_OPTIONS;
  protected readonly sizeOptions = SIZE_OPTIONS;
  protected readonly barCountOptions = BAR_COUNT_OPTIONS;

  protected readonly entries = signal<WatchlistEntry[]>([]);
  protected readonly globalTimeframe = signal<string>('H1');
  protected readonly addDraft = signal<string>('');
  protected readonly catalogue = signal<readonly CurrencyPairDto[]>([]);
  /** Wall-density preset. Default `md` gives a comfortable ~160 px
   *  chart at the default grid column width. Persisted so the operator
   *  doesn't keep re-setting it. */
  protected readonly tileSize = signal<TileSize>('md');
  /** Number of candles each tile pulls. 60 is enough for an at-a-
   *  glance trend read; 240 / 500 lets the operator scan deeper
   *  structural context without leaving the wall. Persisted under its
   *  own key so changing bars doesn't churn the entries blob. */
  protected readonly barCount = signal<number>(60);
  /** True while we're waiting for the catalogue to arrive so we can seed
   *  the first-ever-visit watchlist. The empty-state UI substitutes a
   *  "Loading symbols…" message during this window so the operator
   *  doesn't briefly see an "empty" CTA before tiles populate. */
  protected readonly seeding = signal(false);

  protected readonly catalogueSymbols = computed<readonly string[]>(() =>
    this.catalogue()
      .map((p) => this.canonicaliseSymbol(p.symbol ?? ''))
      .filter((s) => s.length > 0)
      .sort(),
  );

  /**
   * The first 6 catalogue symbols that aren't already on the watchlist —
   * fuel for the empty-state "Quick add" chips. Avoid suggesting things
   * the operator already has so the chips stay actionable.
   */
  protected readonly suggestionSymbols = computed<readonly string[]>(() => {
    const have = new Set(this.entries().map((e) => e.symbol));
    return this.catalogueSymbols()
      .filter((s) => !have.has(s))
      .slice(0, 6);
  });

  protected readonly canAdd = computed(() => {
    const draft = this.canonicaliseSymbol(this.addDraft());
    if (draft.length === 0) return false;
    const have = this.entries().some(
      (e) => e.symbol === draft && e.timeframe === this.globalTimeframe(),
    );
    return !have;
  });

  constructor() {
    // Persist on every change. effect() runs once on construction with
    // the default empty entries; gating on `hydrationComplete` keeps it
    // from blowing away the saved state on init OR blanking the storage
    // key while we're waiting for the catalogue-seeded first-visit state.
    effect(() => {
      const xs = this.entries();
      if (!this.hydrationComplete()) return;
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(xs));
      } catch {
        /* localStorage full / blocked — best-effort */
      }
    });
    // Tile-size has no async dependencies, so we persist it unconditionally
    // on change. Stored under a separate key so resizing doesn't churn the
    // (much larger) entries blob.
    effect(() => {
      const size = this.tileSize();
      try {
        localStorage.setItem(SIZE_STORAGE_KEY, size);
      } catch {
        /* best-effort */
      }
    });
    // Bar count: same pattern — separate key, unconditional persist.
    effect(() => {
      const n = this.barCount();
      try {
        localStorage.setItem(BARS_STORAGE_KEY, String(n));
      } catch {
        /* best-effort */
      }
    });
    // Overlay toggles — persist each under its own key.
    effect(() => {
      const on = this.showPositions();
      try {
        localStorage.setItem(SHOW_POSITIONS_STORAGE_KEY, on ? '1' : '0');
      } catch {
        /* best-effort */
      }
    });
    effect(() => {
      const on = this.showOrders();
      try {
        localStorage.setItem(SHOW_ORDERS_STORAGE_KEY, on ? '1' : '0');
      } catch {
        /* best-effort */
      }
    });
  }

  togglePositions(): void {
    this.showPositions.set(!this.showPositions());
  }
  toggleOrders(): void {
    this.showOrders.set(!this.showOrders());
  }

  /**
   * True once `entries` is in its final post-load state — either:
   *   - the localStorage key existed and we restored its contents, OR
   *   - the catalogue arrived and we seeded the first-visit watchlist
   *     with every active currency pair.
   * The persistence effect refuses to write until this is true so a
   * slow catalogue load doesn't clobber the key with an empty array
   * mid-hydrate.
   */
  private readonly hydrationComplete = signal(false);
  /** True while we still need to seed from the catalogue (raw === null
   *  on the first-ever visit, or the saved payload was malformed). */
  private needsSeeding = false;

  ngOnInit(): void {
    this.hydrateFromStorage();
    this.hydrateTileSize();
    this.hydrateBarCount();
    this.hydrateOverlayToggles();
    this.loadCatalogue();
  }

  private hydrateOverlayToggles(): void {
    try {
      if (localStorage.getItem(SHOW_POSITIONS_STORAGE_KEY) === '1') this.showPositions.set(true);
      if (localStorage.getItem(SHOW_ORDERS_STORAGE_KEY) === '1') this.showOrders.set(true);
    } catch {
      /* localStorage blocked — leave defaults (off) */
    }
  }

  private hydrateTileSize(): void {
    try {
      const raw = localStorage.getItem(SIZE_STORAGE_KEY);
      if (raw === 'sm' || raw === 'md' || raw === 'lg' || raw === 'xl') {
        this.tileSize.set(raw);
      }
    } catch {
      /* best-effort — leave at default */
    }
  }

  private hydrateBarCount(): void {
    try {
      const raw = localStorage.getItem(BARS_STORAGE_KEY);
      const parsed = raw !== null ? Number(raw) : NaN;
      // Snap to the nearest valid preset rather than trusting whatever
      // arbitrary number was previously stored — a future preset-list
      // tweak shouldn't leave operators stuck with an off-menu value.
      if (Number.isFinite(parsed) && BAR_COUNT_OPTIONS.includes(parsed)) {
        this.barCount.set(parsed);
      }
    } catch {
      /* best-effort — leave at default */
    }
  }

  protected setTileSize(size: TileSize): void {
    if (this.tileSize() === size) return;
    this.tileSize.set(size);
  }

  protected setBarCount(n: number): void {
    if (this.barCount() === n) return;
    this.barCount.set(n);
  }

  /**
   * Pixel min-width currently in effect, used to derive the grid's
   * `repeat(auto-fit, minmax(<X>px, 1fr))` template via a CSS custom
   * property. Keeps the size→layout mapping in one place.
   */
  protected currentSizeMinPx(): number {
    const cur = this.tileSize();
    return SIZE_OPTIONS.find((o) => o.value === cur)?.minPx ?? 320;
  }

  private hydrateFromStorage(): void {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch {
      /* localStorage blocked — treat as first visit */
    }
    if (raw === null) {
      // First-ever visit on this browser. Defer hydration completion
      // until the catalogue arrives — we'll seed entries with every
      // active currency pair so the operator sees a populated grid
      // out of the box (matches the "show all by default" intent).
      this.needsSeeding = true;
      this.seeding.set(true);
      return;
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        const valid: WatchlistEntry[] = [];
        for (const item of parsed) {
          const sym = this.canonicaliseSymbol((item as { symbol?: unknown }).symbol as string);
          const tf = String((item as { timeframe?: unknown }).timeframe ?? '');
          if (sym.length > 0 && tf.length > 0) valid.push({ symbol: sym, timeframe: tf });
        }
        this.entries.set(valid);
      }
      this.hydrationComplete.set(true);
    } catch {
      // Malformed payload — discard and treat as first visit so the
      // operator gets a sensible default rather than a stuck-empty page.
      this.needsSeeding = true;
      this.seeding.set(true);
    }
  }

  private loadCatalogue(): void {
    this.pairsService.list({ currentPage: 1, itemCountPerPage: 200 }).subscribe({
      next: (res) => {
        const xs = (res?.data?.data ?? []).filter((p) => p.isActive);
        this.catalogue.set(xs);
        if (this.needsSeeding) {
          this.seedFromCatalogue();
          this.needsSeeding = false;
          this.seeding.set(false);
          this.hydrationComplete.set(true);
        }
      },
      error: () => {
        // Catalogue failed — let the operator start with an empty
        // watchlist they can populate manually rather than blocking.
        if (this.needsSeeding) {
          this.needsSeeding = false;
          this.seeding.set(false);
          this.hydrationComplete.set(true);
        }
      },
    });
  }

  /**
   * Populate `entries` with every active currency pair at the current
   * timeframe. Used for the first-visit seed AND for the
   * "Reset to all pairs" button — the operator can wipe their curated
   * list and snap back to the full grid without clearing localStorage
   * by hand.
   */
  private seedFromCatalogue(): void {
    const tf = this.globalTimeframe();
    const xs = this.catalogueSymbols().map((s) => ({ symbol: s, timeframe: tf }));
    this.entries.set(xs);
  }

  protected resetToAllPairs(): void {
    if (this.catalogueSymbols().length === 0) {
      this.notifications.info('Currency-pair catalogue is empty — nothing to reset to.');
      return;
    }
    if (
      this.entries().length > 0 &&
      !confirm(
        `Replace the current watchlist (${this.entries().length} tile(s)) with ` +
          `every active currency pair (${this.catalogueSymbols().length})?`,
      )
    ) {
      return;
    }
    this.seedFromCatalogue();
  }

  // ── Add / remove ──────────────────────────────────────────────────

  protected addFromInput(): void {
    const sym = this.canonicaliseSymbol(this.addDraft());
    if (!sym) return;
    this.addEntry(sym, this.globalTimeframe());
    this.addDraft.set('');
  }

  protected addEntry(symbol: string, timeframe: string): void {
    const sym = this.canonicaliseSymbol(symbol);
    if (!sym) return;
    const exists = this.entries().some((e) => e.symbol === sym && e.timeframe === timeframe);
    if (exists) {
      this.notifications.info(`${sym} ${timeframe} is already on the watchlist.`);
      return;
    }
    if (this.catalogueSymbols().length > 0 && !this.catalogueSymbols().includes(sym)) {
      // Hard-warn but allow — operator may be adding a symbol the catalogue
      // hasn't picked up yet; live price will surface the gap.
      this.notifications.info(
        `${sym} isn't in the active currency-pair catalogue — tiles may show "No feed".`,
      );
    }
    this.entries.update((xs) => [...xs, { symbol: sym, timeframe }]);
  }

  protected removeEntry(target: WatchlistEntry): void {
    this.entries.update((xs) =>
      xs.filter((e) => !(e.symbol === target.symbol && e.timeframe === target.timeframe)),
    );
  }

  protected clearAll(): void {
    if (this.entries().length === 0) return;
    if (!confirm('Remove all symbols from the watchlist?')) return;
    this.entries.set([]);
  }

  protected setGlobalTimeframe(tf: string): void {
    if (this.globalTimeframe() === tf) return;
    this.globalTimeframe.set(tf);
    // Re-key every existing entry to the new TF. Drops any duplicates
    // that would arise from mixed-TF watchlists collapsing to one TF.
    this.entries.update((xs) => {
      const seen = new Set<string>();
      const out: WatchlistEntry[] = [];
      for (const e of xs) {
        const next = { symbol: e.symbol, timeframe: tf };
        const key = `${next.symbol}|${next.timeframe}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(next);
      }
      return out;
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────

  /**
   * Normalise a symbol into canonical engine form: uppercase, no separators.
   * "eur/usd" → "EURUSD"; "GBP-JPY" → "GBPJPY". The watchlist stores and
   * keys on this canonical form so equal-but-differently-typed entries
   * don't double up; tiles render with a "/" inserted at display time.
   */
  private canonicaliseSymbol(s: string | null | undefined): string {
    if (!s) return '';
    return s.toUpperCase().replace(/[^A-Z0-9]/g, '');
  }
}
