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

import { StrategiesService } from '@core/services/strategies.service';
import type { StrategyRejectionSummaryDto } from '@core/api/api.types';
import { createPolledResource } from '@core/polling/polled-resource';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';

type SortMode = 'count' | 'recent' | 'strategy';

@Component({
  selector: 'app-rejection-summary-page',
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
        title="Strategies — Rejection Summary"
        subtitle="Fleet-wide aggregate of signal-rejection counts grouped by (strategy, stage, reason)"
      >
        <a routerLink="/strategies" class="btn btn-secondary">← Strategies</a>
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
        <div class="control-group">
          <label for="window">Window (days)</label>
          <input
            id="window"
            type="number"
            min="1"
            max="30"
            step="1"
            [ngModel]="windowDays()"
            (ngModelChange)="setWindow($event)"
          />
        </div>
        <div class="control-group">
          <label for="sort">Sort</label>
          <select id="sort" [ngModel]="sortMode()" (ngModelChange)="sortMode.set($event)">
            <option value="count">Highest count</option>
            <option value="recent">Most recent</option>
            <option value="strategy">By strategy id</option>
          </select>
        </div>
        <div class="control-group">
          <label for="search">Symbol</label>
          <input
            id="search"
            type="search"
            placeholder="e.g. EURUSD"
            [ngModel]="symbolFilter()"
            (ngModelChange)="symbolFilter.set($event)"
          />
        </div>
      </section>

      @if (loading()) {
        <app-card-skeleton [lines]="6" />
      } @else if (resource.error()) {
        <app-error-state
          title="Could not load rejection summary"
          message="Engine returned an error. The signal-rejection audit may be paused — check System Health."
          (retry)="resource.refresh()"
        />
      } @else {
        <section class="kpis">
          <app-metric-card
            label="Rows in window"
            [value]="rows().length"
            format="number"
            dotColor="#0071E3"
          />
          <app-metric-card
            label="Total rejections"
            [value]="totalRejections()"
            format="number"
            dotColor="#FF9500"
          />
          <app-metric-card
            label="Distinct strategies"
            [value]="distinctStrategies()"
            format="number"
            dotColor="#0071E3"
          />
          <app-metric-card
            label="Distinct reasons"
            [value]="distinctReasons()"
            format="number"
            dotColor="#AF52DE"
          />
        </section>

        @if (filteredRows().length === 0) {
          <app-empty-state
            title="No rejections in this window"
            description="Either no signals are being generated, no gates are firing, or the filters are too restrictive."
          />
        } @else {
          <section class="card">
            <table class="rejections-table">
              <thead>
                <tr>
                  <th>Strategy</th>
                  <th>Symbol</th>
                  <th>Stage</th>
                  <th>Reason</th>
                  <th class="num">Count</th>
                  <th class="num">Share</th>
                  <th>Latest</th>
                </tr>
              </thead>
              <tbody>
                @for (r of filteredRows(); track rowKey(r)) {
                  <tr>
                    <td>
                      <a [routerLink]="['/strategies', r.strategyId]" class="link mono">
                        #{{ r.strategyId }}
                      </a>
                    </td>
                    <td class="mono">{{ r.symbol }}</td>
                    <td class="mono small">{{ r.stage }}</td>
                    <td class="reason">{{ r.reason }}</td>
                    <td class="num mono">{{ r.count }}</td>
                    <td class="num">
                      <span class="bar-track" [title]="(rowShare(r) * 100 | number: '1.0-1') + '%'">
                        <span class="bar-fill" [style.width.%]="rowShare(r) * 100"></span>
                      </span>
                    </td>
                    <td class="time" [title]="r.latestRejectedAt | date: 'yyyy-MM-dd HH:mm:ss UTC'">
                      {{ r.latestRejectedAt | relativeTime }}
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
        gap: var(--space-4);
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
      .control-group input,
      .control-group select {
        padding: 6px 10px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-sm);
        min-width: 140px;
        font-variant-numeric: tabular-nums;
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
      .rejections-table {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-sm);
      }
      .rejections-table th,
      .rejections-table td {
        padding: 8px 10px;
        text-align: left;
        border-bottom: 1px solid var(--border);
        vertical-align: middle;
      }
      .rejections-table th {
        color: var(--text-secondary);
        font-weight: var(--font-medium);
        font-size: var(--text-xs);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .rejections-table td.num,
      .rejections-table th.num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .mono {
        font-family: var(--font-mono);
      }
      .small {
        font-size: var(--text-xs);
      }
      .reason {
        color: var(--text-secondary);
        max-width: 320px;
        word-break: break-word;
      }
      .link {
        color: var(--accent);
        text-decoration: none;
        font-weight: var(--font-semibold);
      }
      .link:hover {
        text-decoration: underline;
      }
      .time {
        color: var(--text-secondary);
        font-size: var(--text-xs);
      }
      .bar-track {
        display: inline-block;
        width: 80px;
        height: 8px;
        background: var(--bg-primary);
        border-radius: var(--radius-full);
        overflow: hidden;
        vertical-align: middle;
      }
      .bar-fill {
        display: block;
        height: 100%;
        background: #ff9500;
        border-radius: var(--radius-full);
      }
    `,
  ],
})
export class RejectionSummaryPageComponent {
  private readonly strategies = inject(StrategiesService);

  protected readonly windowDays = signal(7);
  protected readonly sortMode = signal<SortMode>('count');
  protected readonly symbolFilter = signal('');

  protected readonly resource = createPolledResource(
    () =>
      this.strategies.getRejectionSummary(this.windowDays() * 24, 100).pipe(
        map((res) => res.data ?? []),
        catchError(() => of<StrategyRejectionSummaryDto[]>([])),
      ),
    { intervalMs: 60_000 },
  );

  constructor() {
    effect(() => {
      this.windowDays();
      this.resource.refresh();
    });
  }

  protected readonly rows = computed(() => this.resource.value() ?? []);
  protected readonly loading = computed(() => this.resource.loading() && this.rows().length === 0);
  protected readonly totalRejections = computed(() => this.rows().reduce((s, r) => s + r.count, 0));
  protected readonly distinctStrategies = computed(
    () => new Set(this.rows().map((r) => r.strategyId)).size,
  );
  protected readonly distinctReasons = computed(
    () => new Set(this.rows().map((r) => `${r.stage}|${r.reason}`)).size,
  );

  protected readonly filteredRows = computed(() => {
    const needle = this.symbolFilter().trim().toUpperCase();
    const filtered = needle
      ? this.rows().filter((r) => (r.symbol ?? '').toUpperCase().includes(needle))
      : this.rows();
    return this.sortRows(filtered);
  });

  protected setWindow(v: number | string): void {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 1 && n <= 30) this.windowDays.set(n);
  }

  protected rowShare(r: StrategyRejectionSummaryDto): number {
    const total = this.totalRejections();
    return total > 0 ? r.count / total : 0;
  }

  protected rowKey(r: StrategyRejectionSummaryDto): string {
    return `${r.strategyId}|${r.stage}|${r.reason}`;
  }

  private sortRows(rows: StrategyRejectionSummaryDto[]): StrategyRejectionSummaryDto[] {
    const mode = this.sortMode();
    const arr = [...rows];
    if (mode === 'recent') {
      arr.sort((a, b) => b.latestRejectedAt.localeCompare(a.latestRejectedAt));
    } else if (mode === 'strategy') {
      arr.sort((a, b) => a.strategyId - b.strategyId || b.count - a.count);
    } else {
      arr.sort((a, b) => b.count - a.count);
    }
    return arr;
  }
}
