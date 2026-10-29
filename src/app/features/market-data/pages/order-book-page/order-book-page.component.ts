import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { catchError, forkJoin, map, of, switchMap } from 'rxjs';

import { ApiService } from '@core/api/api.service';
import type { ResponseData } from '@core/api/api.types';
import {
  activeSymbols,
  boardRow,
  defaultBook,
  sortBoard,
  type BookBoardRow,
  type CandleWatermark,
} from './order-book-board.logic';

import { MarketDataService } from '@core/services/market-data.service';
import type { OrderBookLevel, OrderBookLevels, OrderBookSnapshotDto } from '@core/api/api.types';
import { createPolledResource } from '@core/polling/polled-resource';

import { OrderBookHeatmapComponent } from '../../components/order-book-heatmap/order-book-heatmap.component';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';
import { RefreshButtonComponent } from '@shared/components/refresh-button/refresh-button.component';

interface DepthLevel {
  side: 'bid' | 'ask';
  price: number;
  volume: number;
  cumulativeVolume: number;
  /** 0..1 — share of total cumulative on this side. Drives the depth bar width. */
  pct: number;
}

@Component({
  selector: 'app-order-book-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    DecimalPipe,
    FormsModule,
    RouterLink,
    PageHeaderComponent,
    MetricCardComponent,
    CardSkeletonComponent,
    ErrorStateComponent,
    EmptyStateComponent,
    RelativeTimePipe,
    OrderBookHeatmapComponent,
    RefreshButtonComponent,
  ],
  template: `
    <div class="page">
      <app-page-header
        [title]="'Market Data — Order Book' + (symbol() ? ' · ' + symbol() : '')"
        subtitle="Live depth-of-book streamed by the broker via the EA bridge"
      >
        <a routerLink="/market-data" class="btn btn-secondary">← Market Data</a>
        <a [routerLink]="['/market-data/coverage']" class="btn btn-secondary">Candle coverage →</a>
        <!-- Only once a book streams (before that the form's Load is the action). Bound to
             loading(), true only before the first answer, the old button showed nothing. -->
        @if (symbol()) {
          <app-refresh-button [refreshing]="resource.refreshing()" (refresh)="resource.refresh()" />
        }
      </app-page-header>

      <section class="controls">
        <label class="field">
          <span>Symbol</span>
          <input
            type="search"
            placeholder="e.g. EURUSD"
            [ngModel]="symbolInput()"
            (ngModelChange)="symbolInput.set($event.toUpperCase())"
            (keydown.enter)="applySymbol()"
          />
        </label>
        <button
          type="button"
          class="btn btn-primary"
          (click)="applySymbol()"
          [disabled]="!symbolInput().trim()"
        >
          Load
        </button>
        <span class="hint muted small">
          Top-of-book + up to 20 levels each side (when broker exposes depth)
        </span>
      </section>

      @if (!symbol()) {
        @if (boardLoading()) {
          <app-card-skeleton [lines]="4" />
        } @else {
          <app-empty-state
            title="No broker book is streaming right now"
            description="None of the symbols the EAs stream has a depth snapshot from the last 5 minutes (the forex market may be closed). Pick any symbol below or type one to see its last recorded book."
          />
        }
      } @else if (loading()) {
        <app-card-skeleton [lines]="8" />
      } @else if (resource.error()) {
        <app-error-state
          title="Could not load order book"
          message="Engine returned an error. The EA for this symbol may be offline — check EA Instances."
          (retry)="resource.refresh()"
        />
      } @else if (!snapshot()) {
        <app-empty-state
          title="No order book for this symbol"
          description="No depth snapshot has been recorded for this symbol yet."
        />
      } @else {
        <section class="kpis">
          <app-metric-card
            label="Bid"
            [value]="snapshot()!.bidPrice"
            format="number"
            dotColor="#34C759"
          />
          <app-metric-card
            label="Ask"
            [value]="snapshot()!.askPrice"
            format="number"
            dotColor="#FF3B30"
          />
          <app-metric-card label="Mid" [value]="midPrice()" format="number" dotColor="#0071E3" />
          <app-metric-card
            label="Spread (points)"
            [value]="snapshot()!.spreadPoints"
            format="number"
            [dotColor]="snapshot()!.spreadPoints > 50 ? '#FF9500' : '#34C759'"
          />
        </section>

        <section class="ladder-wrap">
          <header class="ladder-head">
            <h3>Depth ladder</h3>
            <span class="muted small">
              {{ bidLevels().length }} bid · {{ askLevels().length }} ask
              @if (snapshot()!.capturedAt) {
                · captured
                <span [title]="snapshot()!.capturedAt | date: 'yyyy-MM-dd HH:mm:ss.SSS UTC'">
                  {{ snapshot()!.capturedAt | relativeTime }}
                </span>
              }
            </span>
          </header>

          @if (askLevels().length === 0 && bidLevels().length === 0) {
            <p class="muted small">
              Broker did not stream depth beyond top-of-book; only bid/ask shown above.
            </p>
          } @else {
            <div class="ladder">
              <table class="side asks">
                <thead>
                  <tr>
                    <th class="num">Volume</th>
                    <th class="num">Cum</th>
                    <th class="num">Ask</th>
                  </tr>
                </thead>
                <tbody>
                  @for (lvl of askLevels(); track lvl.price; let i = $index) {
                    <tr class="ask-row">
                      <td class="num mono">
                        <span class="bar bar-ask" [style.width.%]="lvl.pct * 100"></span>
                        <span class="bar-val">{{ lvl.volume | number: '1.0-2' }}</span>
                      </td>
                      <td class="num mono muted">
                        {{ lvl.cumulativeVolume | number: '1.0-2' }}
                      </td>
                      <td class="num mono price">{{ lvl.price | number: '1.0-5' }}</td>
                    </tr>
                  }
                </tbody>
              </table>

              <table class="side bids">
                <thead>
                  <tr>
                    <th class="num">Bid</th>
                    <th class="num">Cum</th>
                    <th class="num">Volume</th>
                  </tr>
                </thead>
                <tbody>
                  @for (lvl of bidLevels(); track lvl.price) {
                    <tr class="bid-row">
                      <td class="num mono price">{{ lvl.price | number: '1.0-5' }}</td>
                      <td class="num mono muted">
                        {{ lvl.cumulativeVolume | number: '1.0-2' }}
                      </td>
                      <td class="num mono">
                        <span class="bar-val">{{ lvl.volume | number: '1.0-2' }}</span>
                        <span class="bar bar-bid" [style.width.%]="lvl.pct * 100"></span>
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        </section>

        <section class="heatmap-section">
          <header class="heatmap-head">
            <h3>Recent depth — liquidity heatmap</h3>
            <button type="button" class="toggle" (click)="showHeatmap.set(!showHeatmap())">
              {{ showHeatmap() ? 'Hide heatmap' : 'Show heatmap (fetch 60 recent snapshots)' }}
            </button>
          </header>
          @if (showHeatmap()) {
            <app-order-book-heatmap [symbol]="symbol()" [limit]="60" />
          }
        </section>
      }

      <section class="board">
        <header class="board-head">
          <h3>Books by symbol</h3>
          <span class="muted small">
            Latest depth snapshot per symbol the EAs stream (checked when the page opened)
            @if (board().length) {
              · {{ streamingCount() }} of {{ board().length }} updated in the last 5 minutes
            }
          </span>
          <button type="button" class="toggle" (click)="loadBoard()">Re-check</button>
        </header>
        @if (board().length) {
          <div class="board-wrap">
            <table class="board-table">
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th class="num">Bid</th>
                  <th class="num">Ask</th>
                  <th class="num" title="Ask minus bid, in price units">Spread</th>
                  <th class="num" title="Levels each side beyond top of book">Depth</th>
                  <th>Captured</th>
                  <th>EA instance</th>
                </tr>
              </thead>
              <tbody>
                @for (r of board(); track r.symbol) {
                  <tr [class.current]="r.symbol === symbol()">
                    <td>
                      <button type="button" class="link" (click)="pick(r.symbol)">{{ r.symbol }}</button>
                    </td>
                    @if (r.snapshot; as b) {
                      <td class="num mono">{{ b.bidPrice | number: '1.0-5' }}</td>
                      <td class="num mono">{{ b.askPrice | number: '1.0-5' }}</td>
                      <td class="num mono">{{ b.askPrice - b.bidPrice | number: '1.0-5' }}</td>
                      <td class="num">{{ r.depth || 'top only' }}</td>
                      <td [class.stale]="(r.ageSeconds ?? 0) > 300">{{ b.capturedAt | relativeTime }}</td>
                      <td class="muted small">{{ b.instanceId }}</td>
                    } @else {
                      <td colspan="6" class="muted small">
                        {{ r.symbol.includes('-') ? 'exchange-traded (crypto) — no broker book; its depth is on the chart’s order-flow views' : 'no depth snapshot recorded — the broker streams no DOM for it' }}
                      </td>
                    }
                  </tr>
                }
              </tbody>
            </table>
          </div>
        } @else if (!boardLoading()) {
          <p class="muted small">No symbol has streamed one-minute candles in the last 3 days, so there is no book to list.</p>
        }
      </section>
    </div>
  `,
  styles: [
    `
      .board {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-3) var(--space-4);
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
      }
      .board-head {
        display: flex;
        flex-wrap: wrap;
        align-items: baseline;
        gap: var(--space-3);
      }
      .board-head h3 {
        margin: 0;
        font-size: var(--text-sm);
      }
      .board-wrap {
        overflow-x: auto;
      }
      .board-table {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-sm);
      }
      .board-table th,
      .board-table td {
        text-align: left;
        padding: 6px 10px;
        border-bottom: 1px solid var(--border);
      }
      .board-table th {
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .board-table .num {
        text-align: right;
      }
      .board-table tr.current td {
        background: var(--bg-tertiary);
      }
      .board-table .stale {
        color: var(--text-tertiary, var(--text-secondary));
      }
      .link {
        background: none;
        border: none;
        padding: 0;
        color: var(--accent);
        font-family: var(--font-mono);
        cursor: pointer;
      }
      .page {
        padding: var(--space-2) 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
      }
      .controls {
        display: flex;
        gap: var(--space-3);
        align-items: end;
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-3) var(--space-4);
        flex-wrap: wrap;
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .field span {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        font-weight: var(--font-medium);
      }
      .field input {
        padding: 8px 12px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-sm);
        min-width: 200px;
        text-transform: uppercase;
        font-family: var(--font-mono);
      }
      /* The typed symbol is upper-cased; the hint is not ("E.G. EURUSD"). */
      .field input::placeholder {
        text-transform: none;
      }
      /* The header's "← Market Data" / "… →" / Refresh: without a local rule .btn-secondary is
         only the global press feedback, so they rendered as bare text beside the title. */
      .btn-secondary {
        display: inline-flex;
        align-items: center;
        padding: 6px 12px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-secondary);
        color: var(--text-primary);
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        text-decoration: none;
        cursor: pointer;
      }
      .btn-secondary:hover:not(:disabled) {
        background: var(--bg-tertiary);
      }
      .btn-secondary:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .btn-primary {
        padding: 8px 18px;
        border-radius: var(--radius-sm);
        background: var(--accent);
        color: #fff;
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        border: none;
        cursor: pointer;
      }
      .btn-primary:disabled {
        background: var(--bg-tertiary, #d1d1d6);
        cursor: not-allowed;
      }
      .hint {
        align-self: center;
        margin-left: auto;
      }
      .kpis {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: var(--space-3);
      }
      .ladder-wrap {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--card-padding);
        box-shadow: var(--shadow-sm);
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .ladder-head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
      }
      .ladder-head h3 {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .ladder {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--space-2);
      }
      .side {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-sm);
      }
      .side th {
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        padding: 4px 8px;
        border-bottom: 1px solid var(--border);
      }
      .side td {
        padding: 4px 8px;
        font-variant-numeric: tabular-nums;
        position: relative;
        border-bottom: 1px solid rgba(0, 0, 0, 0.05);
      }
      .side td.num,
      .side th.num {
        text-align: right;
      }
      .mono {
        font-family: var(--font-mono);
      }
      .muted {
        color: var(--text-tertiary);
      }
      .small {
        font-size: var(--text-xs);
      }
      .price {
        font-weight: var(--font-semibold);
      }
      .asks .ask-row .price {
        color: #d70015;
      }
      .bids .bid-row .price {
        color: #248a3d;
      }
      .bar {
        position: absolute;
        top: 2px;
        bottom: 2px;
        border-radius: 2px;
        opacity: 0.18;
        z-index: 0;
      }
      .bar-ask {
        background: #ff3b30;
        right: 0;
      }
      .bar-bid {
        background: #34c759;
        left: 0;
      }
      .bar-val {
        position: relative;
        z-index: 1;
      }
      .heatmap-section {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--card-padding);
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .heatmap-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      .heatmap-head h3 {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .toggle {
        background: var(--bg-primary);
        border: 1px solid var(--border);
        color: var(--accent);
        padding: 6px 14px;
        border-radius: var(--radius-sm);
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        cursor: pointer;
      }
      .toggle:hover {
        background: var(--accent);
        color: #fff;
      }
    `,
  ],
})
export class OrderBookPageComponent {
  private readonly marketData = inject(MarketDataService);
  private readonly route = inject(ActivatedRoute);

  protected readonly symbolInput = signal<string>('');
  protected readonly symbol = signal<string>('');
  protected readonly showHeatmap = signal<boolean>(false);
  private readonly api = inject(ApiService);
  protected readonly board = signal<BookBoardRow[]>([]);
  protected readonly boardLoading = signal(true);
  protected readonly streamingCount = computed(
    () => this.board().filter((r) => r.ageSeconds !== null && r.ageSeconds <= 300).length,
  );

  // Hydrate symbol from query param so deep-links work.
  private readonly _qpSymbol = toSignal(
    this.route.queryParamMap.pipe(map((qp) => (qp.get('symbol') ?? '').toUpperCase())),
    { initialValue: '' },
  );

  protected readonly resource = createPolledResource(
    () => {
      const s = this.symbol();
      if (!s) return of<OrderBookSnapshotDto | null>(null);
      return this.marketData.getLatestOrderBook(s).pipe(
        map((res) => (res.status ? (res.data ?? null) : null)),
        catchError(() => of<OrderBookSnapshotDto | null>(null)),
      );
    },
    { intervalMs: 2000 },
  );

  constructor() {
    effect(() => {
      const qp = this._qpSymbol();
      if (qp && !this.symbol()) {
        this.symbolInput.set(qp);
        this.symbol.set(qp);
        this.resource.refresh();
      }
    });
    effect(() => {
      this.symbol();
      this.resource.refresh();
    });
    this.loadBoard();
  }

  /** One pass over the symbols the EAs stream: each one's latest book (no polling — Re-check repeats it). */
  protected loadBoard(): void {
    this.boardLoading.set(true);
    this.api
      .get<ResponseData<CandleWatermark[]>>('/market-data/candle/watermarks', { silent: true })
      .pipe(
        map((res) => activeSymbols(res?.data ?? [], Date.now())),
        switchMap((symbols) =>
          symbols.length
            ? forkJoin(
                symbols.map((sym) =>
                  this.marketData.getLatestOrderBook(sym).pipe(
                    map((res) => boardRow(sym, res?.status ? (res.data ?? null) : null, Date.now())),
                    catchError(() => of(boardRow(sym, null, Date.now()))),
                  ),
                ),
              )
            : of([] as BookBoardRow[]),
        ),
        catchError(() => of([] as BookBoardRow[])),
      )
      .subscribe((rows) => {
        const sorted = sortBoard(rows);
        this.board.set(sorted);
        this.boardLoading.set(false);
        if (!this.symbol() && !this._qpSymbol()) {
          const pick = defaultBook(sorted);
          if (pick) this.pick(pick);
        }
      });
  }

  protected pick(sym: string): void {
    this.symbolInput.set(sym);
    this.symbol.set(sym);
  }

  protected readonly snapshot = computed(() => this.resource.value());
  protected readonly loading = computed(() => this.resource.loading() && this.snapshot() === null);

  protected readonly midPrice = computed(() => {
    const s = this.snapshot();
    if (!s) return null;
    return (s.bidPrice + s.askPrice) / 2;
  });

  protected readonly askLevels = computed<DepthLevel[]>(() => {
    const s = this.snapshot();
    if (!s) return [];
    const parsed = parseLevels(s.levelsJson);
    if (!parsed) return [];
    return buildSide(parsed.asks, 'ask', /* ascending price */ true);
  });

  protected readonly bidLevels = computed<DepthLevel[]>(() => {
    const s = this.snapshot();
    if (!s) return [];
    const parsed = parseLevels(s.levelsJson);
    if (!parsed) return [];
    return buildSide(parsed.bids, 'bid', /* descending price */ false);
  });

  protected applySymbol(): void {
    const s = this.symbolInput().trim().toUpperCase();
    if (s) this.symbol.set(s);
  }
}

function parseLevels(levelsJson: string | null): OrderBookLevels | null {
  if (!levelsJson) return null;
  try {
    const parsed = JSON.parse(levelsJson) as OrderBookLevels;
    if (!parsed || !Array.isArray(parsed.bids) || !Array.isArray(parsed.asks)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function buildSide(
  levels: OrderBookLevel[],
  side: 'bid' | 'ask',
  ascendingPrice: boolean,
): DepthLevel[] {
  if (levels.length === 0) return [];
  const sorted = [...levels].sort((a, b) => (ascendingPrice ? a.P - b.P : b.P - a.P));
  const total = sorted.reduce((s, l) => s + l.V, 0);
  const out: DepthLevel[] = [];
  let cum = 0;
  for (const lvl of sorted) {
    cum += lvl.V;
    out.push({
      side,
      price: lvl.P,
      volume: lvl.V,
      cumulativeVolume: cum,
      pct: total > 0 ? cum / total : 0,
    });
  }
  return out;
}
