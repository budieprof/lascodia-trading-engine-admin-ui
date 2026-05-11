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
import { catchError, map, of } from 'rxjs';

import { MarketDataService } from '@core/services/market-data.service';
import type { OrderBookLevel, OrderBookLevels, OrderBookSnapshotDto } from '@core/api/api.types';
import { createPolledResource } from '@core/polling/polled-resource';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';

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
  ],
  template: `
    <div class="page">
      <app-page-header
        [title]="'Market Data — Order Book' + (symbol() ? ' · ' + symbol() : '')"
        subtitle="Live depth-of-book streamed by the broker via the EA bridge"
      >
        <a routerLink="/market-data" class="btn btn-secondary">← Market Data</a>
        <a [routerLink]="['/market-data/coverage']" class="btn btn-secondary">Candle coverage →</a>
        <button
          type="button"
          class="btn btn-secondary"
          (click)="resource.refresh()"
          [disabled]="resource.loading()"
        >
          Refresh
        </button>
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
        <app-empty-state
          title="Pick a symbol to load"
          description="Enter a currency pair (e.g. EURUSD) and press Load. Streams refresh every 2 seconds while this page is open."
        />
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
      }
    </div>
  `,
  styles: [
    `
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
    `,
  ],
})
export class OrderBookPageComponent {
  private readonly marketData = inject(MarketDataService);
  private readonly route = inject(ActivatedRoute);

  protected readonly symbolInput = signal<string>('');
  protected readonly symbol = signal<string>('');

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
