import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChildren,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { map } from 'rxjs';

import { CurrencyPairsService } from '@core/services/currency-pairs.service';
import { NotificationService } from '@core/notifications/notification.service';
import { PositionsService } from '@core/services/positions.service';
import { OrdersService } from '@core/services/orders.service';
import { AccountScopeService } from '@core/scope/account-scope.service';
import { RealtimeService } from '@core/realtime/realtime.service';
import { createPolledResource } from '@core/polling/polled-resource';
import type { CurrencyPairDto, LivePriceDto, PositionDto, OrderDto } from '@core/api/api.types';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { WatchlistService } from '@features/chart-analysis/watchlist/watchlist.service';
import {
  addSymbol,
  listSymbols,
  locate,
  newSectionId,
  removeSymbol,
  restoreSymbol,
  type ChartWatchlist,
  type RemovedItem,
} from '@features/chart-analysis/watchlist/watchlist.model';

import {
  MiniChartTileComponent,
  type TileLoadError,
} from '../../components/mini-chart-tile/mini-chart-tile.component';
import { SpotAnalysisModalComponent } from '@shared/components/spot-analysis-modal/spot-analysis-modal.component';
import {
  LEGACY_WALL_KEY,
  applyTick,
  canonicalSymbol,
  readLegacyWall,
  seedFromSnapshot,
  type PriceTick,
} from './watchlist-wall';

/**
 * Multi-symbol watchlist wall — one mini-chart tile per symbol of a watchlist, so the operator can scan many pairs at
 * a glance; clicking a tile opens the full chart at that pair.
 *
 * <ul>
 *   <li>The symbols are the ENGINE's watchlists — the same lists as the chart workstation's watchlist panel (pick
 *       one), or every active pair. Until 2026-10-09 this page kept its own browser-only list; a wall saved that
 *       way is offered for import once (SP-I6).</li>
 *   <li>Prices are PUSHED: one SignalR price room per symbol (`priceUpdated`, ~1 Hz), seeded by a single
 *       watchlist-quotes read. Every tile used to poll `live-price` every 3 seconds.</li>
 *   <li>Timeframe, tile size, bar count and overlays are per-viewer conveniences kept in the browser.</li>
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

/** Which symbols the wall shows: an engine watchlist by id, or every active pair. */
type WallSource = number | 'all';

const SOURCE_STORAGE_KEY = 'tradingChart.watchlist.source.v1';
const LEGACY_DISMISSED_KEY = 'tradingChart.watchlist.v1.importDismissed';
const SIZE_STORAGE_KEY = 'tradingChart.watchlist.size.v1';
const BARS_STORAGE_KEY = 'tradingChart.watchlist.bars.v1';
const TF_STORAGE_KEY = 'tradingChart.watchlist.timeframe.v1';
const SHOW_POSITIONS_STORAGE_KEY = 'tradingChart.watchlist.showPositions.v1';
const SHOW_ORDERS_STORAGE_KEY = 'tradingChart.watchlist.showOrders.v1';
const OVERLAY_ACCOUNT_STORAGE_KEY = 'tradingChart.watchlist.overlayAccount.v1';
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
/** The day snapshot that seeds the tiles' quotes before (and between) pushes. */
const SNAPSHOT_REFRESH_MS = 60_000;
const UNDO_MS = 8_000;

@Component({
  selector: 'app-watchlist-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, PageHeaderComponent, MiniChartTileComponent, SpotAnalysisModalComponent],
  template: `
    <div class="page">
      <app-page-header
        title="Watchlist"
        subtitle="Mini-charts for every symbol of a watchlist — the same lists as the chart's watchlist panel. Click a tile to open the full chart."
      >
        <label class="source-pick">
          <span class="tf-label">Showing</span>
          <select
            class="acct-select source-select"
            (change)="setSource($any($event.target).value)"
            aria-label="Which watchlist the wall shows"
            data-testid="wall-source"
          >
            @for (l of store.lists(); track l.id) {
              <option [value]="l.id" [selected]="source() === l.id">
                {{ l.name }}{{ l.isActive ? ' (chart)' : '' }}
              </option>
            }
            <option value="all" [selected]="source() === 'all'">All active pairs</option>
          </select>
        </label>
      </app-page-header>

      @if (legacyWall().length > 0) {
        <div class="info-banner" role="status">
          <span>
            This browser has a wall of <strong>{{ legacyWall().length }}</strong> symbols saved by the old
            page. The wall now shows your engine watchlists.
          </span>
          <button type="button" class="btn-ghost" (click)="importLegacyWall()">
            Import as a watchlist
          </button>
          <button type="button" class="btn-ghost" (click)="dismissLegacyWall()">Dismiss</button>
        </div>
      }

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
          <select
            class="acct-select"
            [value]="overlayAccountStr()"
            (change)="setOverlayAccount($any($event.target).value)"
            title="Which account's positions / orders to overlay"
            aria-label="Overlay account scope"
          >
            <option value="all" [selected]="overlayAccount() === 'all'">All accounts</option>
            @for (a of overlayAccounts(); track a.id) {
              <option [value]="a.id" [selected]="overlayAccount() === a.id">
                {{ a.accountName || a.accountId || 'Account ' + a.id }}
              </option>
            }
          </select>
        </div>
        <div class="add-wrap">
          <input
            #addInput
            type="text"
            class="add-input"
            [placeholder]="
              sourceList()
                ? 'Add a symbol to ' + sourceList()!.name + ' (e.g. EURUSD)…'
                : 'Pick a watchlist above to add symbols'
            "
            [disabled]="!sourceList()"
            [ngModel]="addDraft()"
            (ngModelChange)="addDraft.set($event)"
            (keydown.enter)="addFromInput()"
            list="watchlist-symbols"
            aria-label="Add symbol to the watchlist"
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
            title="Add this symbol to the watchlist (it shows on the chart's watchlist panel too)"
          >
            Add
          </button>
        </div>
        <span class="muted small grid-meta">
          {{ entries().length }} tile{{ entries().length === 1 ? '' : 's' }}
        </span>
      </section>

      @if (undo(); as u) {
        <div class="info-banner" role="status">
          <span>Removed {{ u.removed.item.symbol }} from {{ u.listName }}.</span>
          <button type="button" class="btn-ghost" (click)="undoRemove()">Undo</button>
        </div>
      }

      <!-- One inline notice for every tile whose candle fetch failed; the
           tiles themselves carry the per-symbol error and a Retry. -->
      @if (failedTiles().size > 0) {
        <div class="load-banner" role="status">
          <span>
            <strong>{{ failedTiles().size }} of {{ entries().length }}</strong> tiles could not load
            {{ globalTimeframe() }} candles — {{ lastFailureReason() }}.
          </span>
          <button type="button" class="btn-ghost" (click)="retryFailed()">
            Retry failed tiles
          </button>
        </div>
      }

      <!-- ── Grid / empty state ──────────────────────────────────── -->
      @if (!store.loaded()) {
        <section class="empty" role="status">
          <h3>Loading watchlists…</h3>
        </section>
      } @else if (entries().length === 0) {
        <section class="empty" role="status">
          @if (store.error(); as err) {
            <h3>Watchlists are unavailable</h3>
            <p class="muted">{{ err }}</p>
          } @else {
            <h3>{{ sourceList()?.name ?? 'This list' }} is empty</h3>
            <p class="muted">
              Add a symbol above, or show
              <button type="button" class="link-btn" (click)="setSource('all')">every active pair</button>.
            </p>
            @if (sourceList() && suggestionSymbols().length > 0) {
              <div class="empty-suggest">
                <span class="muted small">Quick add:</span>
                @for (s of suggestionSymbols(); track s) {
                  <button type="button" class="chip" (click)="addSymbolToList(s)" [title]="'Add ' + s">
                    + {{ s }}
                  </button>
                }
              </div>
            }
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
              [quote]="quotes()[e.symbol] ?? null"
              [positions]="scopedPositions()"
              [orders]="scopedOrders()"
              [showPositions]="showPositions()"
              [showOrders]="showOrders()"
              (remove)="removeEntry(e)"
              (analyze)="openAnalysis(e)"
              (loadError)="onTileLoadError($event)"
              (loadOk)="onTileLoadOk(e)"
            />
          }
        </section>
      }
    </div>

    @if (analysisTarget(); as t) {
      <app-spot-analysis-modal
        [symbol]="t.symbol"
        [timeframe]="t.timeframe"
        (closed)="closeAnalysis()"
      />
    }
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
      .acct-select {
        height: 28px;
        margin-left: 4px;
        padding: 0 6px;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: 12px;
        max-width: 160px;
        cursor: pointer;
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

      .load-banner {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-3);
        padding: var(--space-2) var(--space-3);
        border: 1px solid rgba(255, 59, 48, 0.35);
        background: rgba(255, 59, 48, 0.06);
        border-radius: var(--radius-md);
        font-size: var(--text-sm);
        color: var(--text-primary);
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

      .source-pick {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .source-select {
        max-width: 240px;
      }
      .info-banner {
        display: flex;
        align-items: center;
        gap: var(--space-3);
        padding: var(--space-2) var(--space-3);
        border: 1px solid var(--border);
        background: var(--bg-secondary);
        border-radius: var(--radius-md);
        font-size: var(--text-sm);
        color: var(--text-primary);
      }
      .info-banner span {
        flex: 1;
      }
    `,
  ],
})
export class WatchlistPageComponent implements OnInit {
  protected readonly store = inject(WatchlistService);
  private readonly pairsService = inject(CurrencyPairsService);
  private readonly notifications = inject(NotificationService);
  private readonly positionsService = inject(PositionsService);
  private readonly ordersService = inject(OrdersService);
  private readonly accountScope = inject(AccountScopeService);
  private readonly realtime = inject(RealtimeService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly tiles = viewChildren(MiniChartTileComponent);

  // ── Candle-load failures ───────────────────────────────────────────
  // Every tile fetches its own candles, so one engine outage used to raise
  // one red toast per tile (23 for a full wall) on top of the tiles saying
  // "No candles" as if the market were simply quiet. The tile now shows its
  // own error + Retry; here the failures fold into one banner and one toast.
  protected readonly failedTiles = signal<Set<string>>(new Set());
  protected readonly lastFailureReason = signal<string>('');
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private aggregatedToastId: number | null = null;

  protected onTileLoadError(e: TileLoadError): void {
    // Tiles fetch candles with `silent: true`, so no interceptor toast
    // exists to withdraw; the page raises the single aggregated one below.
    this.lastFailureReason.set(e.reason.toLowerCase());
    this.failedTiles.update((s) => new Set(s).add(this.entryKey(e)));
    // Tiles fail within the same tick or two; coalesce into one toast.
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.toastTimer = null;
      this.dismissAggregatedToast();
      const n = this.failedTiles().size;
      if (n === 0) return;
      this.notifications.error(
        `${n} watchlist tile${n === 1 ? '' : 's'} could not load ${this.globalTimeframe()} candles — ${this.lastFailureReason()}.`,
      );
      const latest = this.notifications.toasts().at(-1);
      this.aggregatedToastId = latest?.id ?? null;
    }, 400);
  }

  protected onTileLoadOk(e: WatchlistEntry): void {
    const key = this.entryKey(e);
    if (!this.failedTiles().has(key)) return;
    this.failedTiles.update((s) => {
      const next = new Set(s);
      next.delete(key);
      return next;
    });
  }

  protected retryFailed(): void {
    for (const t of this.tiles()) if (t.hasError()) t.retry();
  }

  private entryKey(e: { symbol: string; timeframe: string }): string {
    return `${e.symbol}|${e.timeframe}`;
  }

  private clearLoadFailures(): void {
    if (this.toastTimer) {
      clearTimeout(this.toastTimer);
      this.toastTimer = null;
    }
    this.dismissAggregatedToast();
    this.failedTiles.set(new Set());
  }

  private dismissAggregatedToast(): void {
    if (this.aggregatedToastId !== null) {
      this.notifications.dismiss(this.aggregatedToastId);
      this.aggregatedToastId = null;
    }
  }

  /** Chart-overlay toggles — show open positions / pending orders on every
   *  tile. Persisted so the operator's choice survives reloads. */
  protected readonly showPositions = signal<boolean>(false);
  protected readonly showOrders = signal<boolean>(false);
  /** Which account's positions/orders to overlay — a numeric account id, or
   *  `'all'` for every account. Persisted. */
  protected readonly overlayAccount = signal<number | 'all'>('all');
  /** Accounts offered in the overlay scope picker. */
  protected readonly overlayAccounts = this.accountScope.accounts;

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
  // Overlay data scoped to the chosen account (or all). Tiles receive these.
  protected readonly scopedPositions = computed<PositionDto[]>(() => {
    const acct = this.overlayAccount();
    const xs = this.openPositions();
    return acct === 'all' ? xs : xs.filter((p) => p.tradingAccountId === acct);
  });
  protected readonly scopedOrders = computed<OrderDto[]>(() => {
    const acct = this.overlayAccount();
    const xs = this.pendingOrders();
    return acct === 'all' ? xs : xs.filter((o) => o.tradingAccountId === acct);
  });

  protected readonly timeframeOptions = TF_OPTIONS;
  protected readonly sizeOptions = SIZE_OPTIONS;
  protected readonly barCountOptions = BAR_COUNT_OPTIONS;

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
   *  own key so changing bars doesn't churn anything else. */
  protected readonly barCount = signal<number>(60);

  /** The source the operator picked (persisted); null until they pick — then the chart's active list. */
  private readonly pickedSource = signal<WallSource | null>(null);
  /** What the wall shows: the picked list while it exists, else the active list, else every active pair. */
  protected readonly source = computed<WallSource>(() => {
    const picked = this.pickedSource();
    const lists = this.store.lists();
    if (picked === 'all') return 'all';
    if (picked !== null && lists.some((l) => l.id === picked)) return picked;
    return this.store.active()?.id ?? 'all';
  });
  protected readonly sourceList = computed<ChartWatchlist | null>(() => {
    const s = this.source();
    return s === 'all' ? null : (this.store.lists().find((l) => l.id === s) ?? null);
  });

  protected readonly catalogueSymbols = computed<readonly string[]>(() =>
    this.catalogue()
      .map((p) => canonicalSymbol(p.symbol))
      .filter((s) => s.length > 0)
      .sort(),
  );

  protected readonly entries = computed<WatchlistEntry[]>(() => {
    const tf = this.globalTimeframe();
    const symbols = this.source() === 'all' ? this.catalogueSymbols() : listSymbols(this.sourceList());
    return symbols.map((symbol) => ({ symbol, timeframe: tf }));
  });

  /** The wall's symbols, stable for an equal set (drives the price rooms and the snapshot). */
  private readonly wallSymbols = computed(() => this.entries().map((e) => e.symbol), {
    equal: (a, b) => a.length === b.length && a.every((s, i) => s === b[i]),
  });

  /**
   * The first 6 catalogue symbols that aren't already on the list —
   * fuel for the empty-state "Quick add" chips.
   */
  protected readonly suggestionSymbols = computed<readonly string[]>(() => {
    const have = new Set(this.entries().map((e) => e.symbol));
    return this.catalogueSymbols()
      .filter((s) => !have.has(s))
      .slice(0, 6);
  });

  protected readonly canAdd = computed(() => {
    const draft = canonicalSymbol(this.addDraft());
    return !!this.sourceList() && draft.length > 0 && !this.entries().some((e) => e.symbol === draft);
  });

  /** Live quotes per symbol: pushed ticks, seeded by the day snapshot. */
  protected readonly quotes = signal<Readonly<Record<string, LivePriceDto>>>({});
  /** Symbols whose price room this page has joined. */
  private readonly joined = new Set<string>();

  /** The old browser-only wall, offered for import once. */
  protected readonly legacyWall = signal<string[]>([]);
  /** The last tile removed from a list, for Undo. */
  protected readonly undo = signal<{ listId: number; listName: string; removed: RemovedItem } | null>(null);
  private undoTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.destroyRef.onDestroy(() => {
      this.clearLoadFailures();
      if (this.undoTimer) clearTimeout(this.undoTimer);
      for (const symbol of this.joined) void this.realtime.leave(`price:${symbol}`, 'UnsubscribePrice', symbol);
      this.joined.clear();
      this.store.flush();
    });

    // Price rooms follow the wall: join the new symbols, leave the dropped ones.
    effect(() => {
      const wanted = new Set(this.wallSymbols());
      untracked(() => this.syncPriceRooms(wanted));
    });
    this.realtime
      .on<PriceTick>('priceUpdated')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((tick) => {
        const symbol = canonicalSymbol(tick?.symbol);
        if (!this.joined.has(symbol)) return;
        this.quotes.update((q) => applyTick(q, tick, new Date().toISOString()));
      });

    // One snapshot read seeds every tile (and covers a symbol whose stream is quiet); refreshed each minute.
    effect((onCleanup) => {
      const symbols = this.wallSymbols();
      if (!symbols.length) return;
      const seed = () => {
        if (document.hidden) return;
        this.store
          .quotes(symbols)
          .then((snap) => this.quotes.update((q) => seedFromSnapshot(q, snap)))
          .catch(() => undefined); // the tiles say "No live quote"; candles still load
      };
      untracked(seed);
      const timer = setInterval(seed, SNAPSHOT_REFRESH_MS);
      onCleanup(() => clearInterval(timer));
    });

    // Per-viewer conveniences, each under its own key.
    effect(() => this.persist(SIZE_STORAGE_KEY, this.tileSize()));
    effect(() => this.persist(BARS_STORAGE_KEY, String(this.barCount())));
    effect(() => this.persist(TF_STORAGE_KEY, this.globalTimeframe()));
    effect(() => this.persist(SHOW_POSITIONS_STORAGE_KEY, this.showPositions() ? '1' : '0'));
    effect(() => this.persist(SHOW_ORDERS_STORAGE_KEY, this.showOrders() ? '1' : '0'));
    effect(() => this.persist(OVERLAY_ACCOUNT_STORAGE_KEY, String(this.overlayAccount())));
  }

  ngOnInit(): void {
    void this.store.load();
    this.hydratePrefs();
    this.loadCatalogue();
  }

  private persist(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* localStorage full / blocked — best-effort */
    }
  }

  private read(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  private hydratePrefs(): void {
    const size = this.read(SIZE_STORAGE_KEY);
    if (size === 'sm' || size === 'md' || size === 'lg' || size === 'xl') this.tileSize.set(size);
    const bars = Number(this.read(BARS_STORAGE_KEY));
    // Snap to a preset rather than trusting whatever number was stored.
    if (BAR_COUNT_OPTIONS.includes(bars)) this.barCount.set(bars);
    const tf = this.read(TF_STORAGE_KEY);
    if (tf && TF_OPTIONS.includes(tf)) this.globalTimeframe.set(tf);
    if (this.read(SHOW_POSITIONS_STORAGE_KEY) === '1') this.showPositions.set(true);
    if (this.read(SHOW_ORDERS_STORAGE_KEY) === '1') this.showOrders.set(true);
    const acct = this.read(OVERLAY_ACCOUNT_STORAGE_KEY);
    if (acct && acct !== 'all' && Number.isFinite(Number(acct))) this.overlayAccount.set(Number(acct));
    const src = this.read(SOURCE_STORAGE_KEY);
    if (src === 'all') this.pickedSource.set('all');
    else if (src && Number.isFinite(Number(src))) this.pickedSource.set(Number(src));
    // The old page's own wall: offer it once, unless already imported or dismissed.
    if (this.read(LEGACY_DISMISSED_KEY) !== '1') this.legacyWall.set(readLegacyWall(this.read(LEGACY_WALL_KEY)));
  }

  private loadCatalogue(): void {
    this.pairsService
      .list({ currentPage: 1, itemCountPerPage: 400 })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => this.catalogue.set((res?.data?.data ?? []).filter((p) => p.isActive)),
        // The catalogue only feeds the datalist and "All active pairs"; lists still work without it.
        error: () => this.catalogue.set([]),
      });
  }

  // ── Price rooms ────────────────────────────────────────────────────

  private syncPriceRooms(wanted: Set<string>): void {
    for (const symbol of [...this.joined]) {
      if (wanted.has(symbol)) continue;
      this.joined.delete(symbol);
      void this.realtime.leave(`price:${symbol}`, 'UnsubscribePrice', symbol);
    }
    for (const symbol of wanted) {
      if (this.joined.has(symbol)) continue;
      this.joined.add(symbol);
      // `join`, not `invoke`: recorded and re-applied after a reconnect, and applied once the hub is up.
      void this.realtime.join(`price:${symbol}`, 'SubscribePrice', symbol);
    }
  }

  // ── Source + legacy wall ───────────────────────────────────────────

  protected setSource(value: string): void {
    const next: WallSource = value === 'all' ? 'all' : Number(value);
    this.clearLoadFailures();
    this.pickedSource.set(next);
    this.persist(SOURCE_STORAGE_KEY, String(next));
  }

  protected async importLegacyWall(): Promise<void> {
    const symbols = this.legacyWall();
    if (!symbols.length) return;
    const template: ChartWatchlist = {
      id: 0,
      name: 'Wall',
      isActive: false,
      sortOrder: 0,
      sections: [
        {
          id: newSectionId(),
          name: 'Symbols',
          collapsed: false,
          items: symbols.map((symbol) => ({ symbol, flag: null })),
        },
      ],
    };
    // Not made the chart's active list: importing the old wall must not change what the chart's watchlist shows.
    const created = await this.store.create('Wall (imported)', template, { activate: false });
    if (!created) {
      this.notifications.error(this.store.error() ?? 'The wall could not be imported.');
      return;
    }
    this.setSource(String(created.id));
    this.dismissLegacyWall();
    this.notifications.success(`Imported ${symbols.length} symbols into the watchlist "${created.name}".`);
  }

  protected dismissLegacyWall(): void {
    this.legacyWall.set([]);
    this.persist(LEGACY_DISMISSED_KEY, '1');
  }

  // ── Toolbar ────────────────────────────────────────────────────────

  togglePositions(): void {
    this.showPositions.set(!this.showPositions());
  }
  toggleOrders(): void {
    this.showOrders.set(!this.showOrders());
  }

  /** String form of the overlay-account scope for the <select> value binding. */
  protected overlayAccountStr(): string {
    return String(this.overlayAccount());
  }
  setOverlayAccount(value: string): void {
    this.overlayAccount.set(value === 'all' ? 'all' : Number(value));
  }

  protected setTileSize(size: TileSize): void {
    if (this.tileSize() !== size) this.tileSize.set(size);
  }

  protected setBarCount(n: number): void {
    if (this.barCount() !== n) this.barCount.set(n);
  }

  /** Pixel min-width currently in effect, for the grid's `minmax(<X>px, 1fr)` template. */
  protected currentSizeMinPx(): number {
    const cur = this.tileSize();
    return SIZE_OPTIONS.find((o) => o.value === cur)?.minPx ?? 320;
  }

  protected setGlobalTimeframe(tf: string): void {
    if (this.globalTimeframe() === tf) return;
    // Failures belong to the timeframe they happened on; the tiles re-key and re-fetch.
    this.clearLoadFailures();
    this.globalTimeframe.set(tf);
  }

  // ── Add / remove (edits the engine list) ───────────────────────────

  protected addFromInput(): void {
    const sym = canonicalSymbol(this.addDraft());
    if (!sym) return;
    this.addSymbolToList(sym);
    this.addDraft.set('');
  }

  protected addSymbolToList(symbol: string): void {
    const list = this.sourceList();
    const sym = canonicalSymbol(symbol);
    if (!list || !sym) return;
    if (listSymbols(list).includes(sym)) {
      this.notifications.info(`${sym} is already on ${list.name}.`);
      return;
    }
    if (this.catalogueSymbols().length > 0 && !this.catalogueSymbols().includes(sym)) {
      // Allowed: the catalogue may not have picked the symbol up yet; its tile will say there is no feed.
      this.notifications.info(`${sym} isn't in the active currency-pair catalogue — its tile may show no prices.`);
    }
    this.store.update(addSymbol(list, sym));
  }

  protected removeEntry(target: WatchlistEntry): void {
    const list = this.sourceList();
    if (!list) {
      this.notifications.info('"All active pairs" is not a list — pick a watchlist to remove symbols from it.');
      return;
    }
    const removed = locate(list, target.symbol);
    if (!removed) return;
    this.store.update(removeSymbol(list, target.symbol));
    this.onTileLoadOk(target);
    if (this.undoTimer) clearTimeout(this.undoTimer);
    this.undo.set({ listId: list.id, listName: list.name, removed });
    this.undoTimer = setTimeout(() => {
      this.undoTimer = null;
      this.undo.set(null);
    }, UNDO_MS);
  }

  protected undoRemove(): void {
    const u = this.undo();
    if (!u) return;
    const list = this.store.lists().find((l) => l.id === u.listId);
    if (list) this.store.update(restoreSymbol(list, u.removed));
    if (this.undoTimer) clearTimeout(this.undoTimer);
    this.undoTimer = null;
    this.undo.set(null);
  }

  // ── Analysis modal ─────────────────────────────────────────────────

  /** The tile whose LLM analysis modal is open, or null. */
  protected readonly analysisTarget = signal<WatchlistEntry | null>(null);

  protected openAnalysis(target: WatchlistEntry): void {
    this.analysisTarget.set(target);
  }

  protected closeAnalysis(): void {
    const t = this.analysisTarget();
    this.analysisTarget.set(null);
    // The modal's chart leaves its symbol's price room when it closes (one connection, no reference counting), which
    // would silently stop this tile's prices: join it again.
    if (t && this.joined.has(t.symbol)) void this.realtime.join(`price:${t.symbol}`, 'SubscribePrice', t.symbol);
  }
}
