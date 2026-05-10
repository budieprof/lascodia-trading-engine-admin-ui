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
import { RouterLink } from '@angular/router';
import { catchError, map, of } from 'rxjs';

import { MLModelsService } from '@core/services/ml-models.service';
import type { MLModelOverfitFlagDto } from '@core/api/api.types';
import { createPolledResource } from '@core/polling/polled-resource';

import { V6OrderBookCardComponent } from '../../components/v6-orderbook-card/v6-orderbook-card.component';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';

@Component({
  selector: 'app-overfit-watchlist-page',
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
    V6OrderBookCardComponent,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="ML — Overfit Watchlist"
        subtitle="Active models whose CV Sharpe is materially worse than live 7-day Sharpe"
      >
        <a routerLink="/ml-models" class="btn btn-secondary">← ML Models</a>
        <button
          type="button"
          class="btn btn-secondary"
          (click)="resource.refresh()"
          [disabled]="resource.loading()"
        >
          Refresh
        </button>
      </app-page-header>

      <app-v6-orderbook-card />

      <section class="controls">
        <div class="control-group">
          <label for="ratio">Ratio threshold</label>
          <input
            id="ratio"
            type="number"
            min="1"
            max="10"
            step="0.5"
            [ngModel]="ratioThreshold()"
            (ngModelChange)="setRatio($event)"
          />
          <span class="hint muted small">CV ÷ live; default 2.0 (live half of CV)</span>
        </div>

        <div class="control-group">
          <label for="minSignals">Min resolved signals</label>
          <input
            id="minSignals"
            type="number"
            min="1"
            max="500"
            step="5"
            [ngModel]="minResolvedSignals()"
            (ngModelChange)="setMinSignals($event)"
          />
          <span class="hint muted small">below this, models aren't eligible to be flagged</span>
        </div>
      </section>

      @if (loading()) {
        <app-card-skeleton [lines]="6" />
      } @else if (resource.error()) {
        <app-error-state
          title="Could not load overfit watchlist"
          message="Engine returned an error fetching the watchlist. Verify the engine is reachable."
          (retry)="resource.refresh()"
        />
      } @else {
        <section class="kpis">
          <app-metric-card
            label="Flagged models"
            [value]="flags().length"
            format="number"
            [dotColor]="flags().length > 0 ? '#FF3B30' : '#34C759'"
          />
          <app-metric-card
            label="Edge-collapse (live ≤ 0)"
            [value]="edgeCollapseCount()"
            format="number"
            [dotColor]="edgeCollapseCount() > 0 ? '#FF3B30' : '#34C759'"
          />
          <app-metric-card
            label="Worst CV ÷ Live ratio"
            [value]="worstRatio()"
            format="number"
            dotColor="#FF9500"
          />
        </section>

        @if (flags().length === 0) {
          <app-empty-state
            title="No overfit flags"
            description="No active models are above the ratio threshold or below live Sharpe = 0. Healthy state."
          />
        } @else {
          <section class="card">
            <table class="watchlist-table">
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Pair</th>
                  <th>Architecture</th>
                  <th>Version</th>
                  <th class="num">CV ÷ Live</th>
                  <th class="num">CV Sharpe</th>
                  <th class="num">Live 7d Sharpe</th>
                  <th class="num">Signals</th>
                  <th>Reason</th>
                  <th>First active</th>
                </tr>
              </thead>
              <tbody>
                @for (flag of flags(); track flag.mlModelId) {
                  <tr [class.edge-collapse]="(flag.liveSharpe7d ?? 0) <= 0">
                    <td>
                      <a [routerLink]="['/ml-models', flag.mlModelId]" class="link mono">
                        #{{ flag.mlModelId }}
                      </a>
                    </td>
                    <td>
                      <span class="mono symbol">{{ flag.symbol }}</span>
                      <span class="muted small"> · {{ flag.timeframe }}</span>
                    </td>
                    <td class="mono small">{{ flag.learnerArchitecture }}</td>
                    <td class="mono small muted">{{ flag.modelVersion ?? '—' }}</td>
                    <td class="num mono">
                      @if (flag.sharpeRatio !== null) {
                        <span class="bad">{{ flag.sharpeRatio | number: '1.0-2' }}×</span>
                      } @else {
                        <span class="muted">—</span>
                      }
                    </td>
                    <td class="num mono">
                      @if (flag.cvSharpe !== null) {
                        {{ flag.cvSharpe | number: '1.0-2' }}
                      } @else {
                        <span class="muted">—</span>
                      }
                    </td>
                    <td class="num mono" [class.bad]="(flag.liveSharpe7d ?? 1) <= 0">
                      @if (flag.liveSharpe7d !== null) {
                        {{ flag.liveSharpe7d | number: '1.0-2' }}
                      } @else {
                        <span class="muted">—</span>
                      }
                    </td>
                    <td class="num mono">{{ flag.resolvedSignals }}</td>
                    <td class="reason">{{ flag.reason }}</td>
                    <td class="time" [title]="flag.firstActiveAt | date: 'yyyy-MM-dd HH:mm UTC'">
                      @if (flag.firstActiveAt) {
                        {{ flag.firstActiveAt | relativeTime }}
                      } @else {
                        <span class="muted">—</span>
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </section>
        }
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
        gap: var(--space-5);
        flex-wrap: wrap;
        align-items: end;
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-3) var(--space-4);
      }
      .control-group {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .control-group label {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        font-weight: var(--font-medium);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .control-group input {
        padding: 6px 10px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-sm);
        max-width: 140px;
        font-variant-numeric: tabular-nums;
      }
      .hint {
        font-size: var(--text-xs);
      }
      .kpis {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
        gap: var(--space-3);
      }
      .card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--card-padding);
        box-shadow: var(--shadow-sm);
        overflow-x: auto;
      }
      .watchlist-table {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-sm);
      }
      .watchlist-table th,
      .watchlist-table td {
        padding: 8px 10px;
        text-align: left;
        border-bottom: 1px solid var(--border);
        vertical-align: middle;
      }
      .watchlist-table th {
        color: var(--text-secondary);
        font-weight: var(--font-medium);
        font-size: var(--text-xs);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .watchlist-table td.num,
      .watchlist-table th.num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .watchlist-table tr.edge-collapse {
        background: rgba(255, 59, 48, 0.05);
      }
      .watchlist-table tr.edge-collapse td:first-child {
        border-left: 3px solid #d70015;
        padding-left: 8px;
      }
      .symbol {
        font-weight: var(--font-semibold);
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
      .bad {
        color: #d70015;
      }
      .reason {
        max-width: 360px;
        color: var(--text-secondary);
        word-break: break-word;
      }
      .time {
        color: var(--text-secondary);
        font-size: var(--text-xs);
      }
      .link {
        color: var(--accent);
        text-decoration: none;
        font-weight: var(--font-semibold);
      }
      .link:hover {
        text-decoration: underline;
      }
    `,
  ],
})
export class OverfitWatchlistPageComponent {
  private readonly ml = inject(MLModelsService);

  protected readonly ratioThreshold = signal(2);
  protected readonly minResolvedSignals = signal(30);

  protected readonly resource = createPolledResource(
    () =>
      this.ml.getOverfitWatchlist(this.ratioThreshold(), this.minResolvedSignals()).pipe(
        map((res) => res.data ?? []),
        catchError(() => of<MLModelOverfitFlagDto[]>([])),
      ),
    { intervalMs: 60_000 },
  );

  constructor() {
    effect(() => {
      this.ratioThreshold();
      this.minResolvedSignals();
      this.resource.refresh();
    });
  }

  protected readonly flags = computed(() => this.resource.value() ?? []);
  protected readonly loading = computed(() => this.resource.loading() && this.flags().length === 0);
  protected readonly edgeCollapseCount = computed(
    () => this.flags().filter((f) => (f.liveSharpe7d ?? 0) <= 0).length,
  );
  protected readonly worstRatio = computed(() => {
    const arr = this.flags();
    if (arr.length === 0) return null;
    let max = 0;
    for (const f of arr) if ((f.sharpeRatio ?? 0) > max) max = f.sharpeRatio ?? 0;
    return max > 0 ? max : null;
  });

  protected setRatio(v: number | string): void {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 1 && n <= 10) this.ratioThreshold.set(n);
  }

  protected setMinSignals(v: number | string): void {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 1 && n <= 500) this.minResolvedSignals.set(n);
  }
}
