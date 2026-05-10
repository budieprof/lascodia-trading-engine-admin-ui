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

import { CompositeMLService } from '@core/services/composite-ml.service';
import type {
  CatalogueDriftSummaryDto,
  CatalogueDriftSummaryRowDto,
  Timeframe,
} from '@core/api/api.types';
import { createPolledResource } from '@core/polling/polled-resource';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';

type WindowDays = 1 | 7 | 30;
type SortMode = 'layer' | 'drop' | 'recent';

const EMPTY_SUMMARY: CatalogueDriftSummaryDto = {
  compareWindowDays: 7,
  queriedAtUtc: '',
  rows: [],
};

@Component({
  selector: 'app-drift-summary-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    DecimalPipe,
    FormsModule,
    RouterLink,
    PageHeaderComponent,
    CardSkeletonComponent,
    ErrorStateComponent,
    EmptyStateComponent,
    RelativeTimePipe,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="CompositeML — Catalogue Drift"
        subtitle="Latest-vs-prior observed counts across catalogue entries; drop alerts flag sharp decay"
      >
        <a routerLink="/composite-ml" class="btn btn-secondary">← Active Policies</a>
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
          <span class="control-label">Window</span>
          <div class="lookback-pills">
            @for (option of WINDOW_OPTIONS; track option) {
              <button
                type="button"
                [class.active]="windowDays() === option"
                (click)="windowDays.set(option)"
              >
                {{ option }}d
              </button>
            }
          </div>
        </div>

        <div class="control-group">
          <span class="control-label">Sort</span>
          <select [ngModel]="sortMode()" (ngModelChange)="sortMode.set($event)">
            <option value="layer">Layer key (A→Z)</option>
            <option value="drop">Drop alerts first</option>
            <option value="recent">Most recently evaluated</option>
          </select>
        </div>

        <div class="control-group">
          <span class="control-label">Symbol</span>
          <input
            type="search"
            placeholder="e.g. EURUSD"
            [ngModel]="symbolFilter()"
            (ngModelChange)="symbolFilter.set($event)"
          />
        </div>

        <span class="result-count">
          {{ filteredRows().length }} of {{ summary().rows.length }} entries
        </span>
      </section>

      @if (loading()) {
        <app-card-skeleton [lines]="8" />
      } @else if (resource.error()) {
        <app-error-state
          title="Could not load drift summary"
          message="Engine returned an error. The catalogue-drift monitor worker may be paused — check System Health."
          (retry)="resource.refresh()"
        />
      } @else {
        <section class="kpi-strip">
          <span class="kpi"
            ><strong>{{ summary().rows.length }}</strong> entries</span
          >
          <span class="kpi" [class.warn]="dropAlertCount() > 0">
            <strong>{{ dropAlertCount() }}</strong> drop alerts
          </span>
          <span class="kpi"
            ><strong>{{ coldCount() }}</strong> cold-start</span
          >
          @if (summary().queriedAtUtc) {
            <span class="kpi muted">
              Queried
              <span [title]="summary().queriedAtUtc | date: 'yyyy-MM-dd HH:mm:ss UTC'">{{
                summary().queriedAtUtc | relativeTime
              }}</span>
            </span>
          }
        </section>

        @if (filteredRows().length === 0) {
          <app-empty-state
            title="No catalogue-drift entries"
            description="No catalogue-drift snapshots match the current filters. Try a larger window or clear the symbol filter."
          />
        } @else {
          <section class="card">
            <table class="drift-table">
              <thead>
                <tr>
                  <th>Layer key</th>
                  <th>Scope</th>
                  <th class="num">Latest / Threshold</th>
                  <th>Warm</th>
                  <th class="num">Prior</th>
                  <th class="num">Δ abs</th>
                  <th class="num">Δ %</th>
                  <th>Alert</th>
                  <th>Latest at</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                @for (row of filteredRows(); track rowKey(row)) {
                  <tr [class.drop-alert]="row.isDropAlert">
                    <td class="mono">{{ row.layerKey }}</td>
                    <td>
                      <span class="scope-pill" [attr.data-tier]="tierOf(row)">
                        {{ scopeLabel(row) }}
                      </span>
                    </td>
                    <td class="num mono">
                      {{ row.latestObservedCount | number: '1.0-0' }}
                      <span class="muted small">/ {{ row.latestThreshold | number: '1.0-0' }}</span>
                    </td>
                    <td>
                      @if (row.latestIsWarm) {
                        <span class="warm-pill warm">warm</span>
                      } @else {
                        <span class="warm-pill cold">cold</span>
                      }
                    </td>
                    <td class="num mono">
                      @if (row.priorObservedCount !== null) {
                        {{ row.priorObservedCount | number: '1.0-0' }}
                      } @else {
                        <span class="muted">—</span>
                      }
                    </td>
                    <td
                      class="num mono"
                      [class.positive]="(row.absoluteDelta ?? 0) > 0"
                      [class.negative]="(row.absoluteDelta ?? 0) < 0"
                    >
                      @if (row.absoluteDelta !== null) {
                        {{ row.absoluteDelta > 0 ? '+' : '' }}{{ row.absoluteDelta }}
                      } @else {
                        <span class="muted">—</span>
                      }
                    </td>
                    <td
                      class="num mono"
                      [class.positive]="(row.relativeDelta ?? 0) > 0"
                      [class.negative]="(row.relativeDelta ?? 0) < 0"
                    >
                      @if (row.relativeDelta !== null) {
                        {{ row.relativeDelta > 0 ? '+' : ''
                        }}{{ row.relativeDelta * 100 | number: '1.0-1' }}%
                      } @else {
                        <span class="muted">—</span>
                      }
                    </td>
                    <td>
                      @if (row.isDropAlert) {
                        <span class="alert-pill">drop alert</span>
                      } @else {
                        <span class="muted small">—</span>
                      }
                    </td>
                    <td
                      class="time"
                      [title]="row.latestEvaluatedAtUtc | date: 'yyyy-MM-dd HH:mm:ss UTC'"
                    >
                      {{ row.latestEvaluatedAtUtc | relativeTime }}
                    </td>
                    <td>
                      <a
                        [routerLink]="['/composite-ml/drift/history']"
                        [queryParams]="historyQueryFor(row)"
                        class="link"
                      >
                        History →
                      </a>
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
        align-items: center;
        gap: var(--space-4);
        flex-wrap: wrap;
      }
      .control-group {
        display: flex;
        align-items: center;
        gap: var(--space-2);
      }
      .control-label {
        font-size: var(--text-sm);
        color: var(--text-secondary);
        font-weight: var(--font-medium);
      }
      .lookback-pills {
        display: inline-flex;
        gap: 4px;
        background: var(--bg-secondary);
        padding: 4px;
        border-radius: var(--radius-md);
      }
      .lookback-pills button {
        background: transparent;
        border: none;
        padding: 6px 14px;
        border-radius: var(--radius-sm);
        font-size: var(--text-sm);
        color: var(--text-secondary);
        cursor: pointer;
        font-weight: var(--font-medium);
      }
      .lookback-pills button.active {
        background: var(--bg-primary);
        color: var(--text-primary);
        box-shadow: var(--shadow-sm);
      }
      .control-group select,
      .control-group input {
        padding: 6px 10px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-sm);
        min-width: 160px;
      }
      .result-count {
        font-size: var(--text-sm);
        color: var(--text-secondary);
        margin-left: auto;
      }
      .kpi-strip {
        display: flex;
        gap: var(--space-4);
        align-items: center;
        flex-wrap: wrap;
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-3) var(--space-4);
      }
      .kpi {
        font-size: var(--text-sm);
        color: var(--text-secondary);
      }
      .kpi strong {
        color: var(--text-primary);
        font-weight: var(--font-semibold);
        font-variant-numeric: tabular-nums;
        margin-right: 4px;
      }
      .kpi.warn {
        color: #c93400;
      }
      .kpi.warn strong {
        color: #c93400;
      }
      .kpi.muted {
        color: var(--text-tertiary);
      }
      .card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--card-padding);
        box-shadow: var(--shadow-sm);
        overflow-x: auto;
      }
      .drift-table {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-sm);
      }
      .drift-table th,
      .drift-table td {
        padding: 8px 10px;
        text-align: left;
        border-bottom: 1px solid var(--border);
        vertical-align: middle;
      }
      .drift-table th {
        color: var(--text-secondary);
        font-weight: var(--font-medium);
        font-size: var(--text-xs);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .drift-table td.num,
      .drift-table th.num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .drift-table tr.drop-alert {
        background: rgba(255, 59, 48, 0.06);
      }
      .drift-table tr.drop-alert td:first-child {
        border-left: 3px solid #d70015;
        padding-left: 8px;
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
      .scope-pill {
        font-size: var(--text-xs);
        padding: 2px 8px;
        border-radius: var(--radius-full);
        font-weight: var(--font-medium);
      }
      .scope-pill[data-tier='global'] {
        background: rgba(0, 113, 227, 0.12);
        color: #0040dd;
      }
      .scope-pill[data-tier='symbol'] {
        background: rgba(52, 199, 89, 0.12);
        color: #248a3d;
      }
      .scope-pill[data-tier='pair'] {
        background: rgba(175, 82, 222, 0.12);
        color: #8e44ad;
      }
      .warm-pill {
        font-size: var(--text-xs);
        padding: 2px 8px;
        border-radius: var(--radius-full);
        font-weight: var(--font-semibold);
      }
      .warm-pill.warm {
        background: rgba(52, 199, 89, 0.12);
        color: #248a3d;
      }
      .warm-pill.cold {
        background: rgba(0, 113, 227, 0.12);
        color: #0040dd;
      }
      .alert-pill {
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        padding: 2px 8px;
        border-radius: var(--radius-full);
        background: rgba(255, 59, 48, 0.12);
        color: #d70015;
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .positive {
        color: #248a3d;
      }
      .negative {
        color: #d70015;
      }
      .time {
        color: var(--text-secondary);
        font-size: var(--text-xs);
      }
      .link {
        font-size: var(--text-xs);
        color: var(--accent);
        text-decoration: none;
        font-weight: var(--font-medium);
      }
      .link:hover {
        text-decoration: underline;
      }
    `,
  ],
})
export class DriftSummaryPageComponent {
  private readonly compositeMl = inject(CompositeMLService);

  protected readonly WINDOW_OPTIONS: readonly WindowDays[] = [1, 7, 30] as const;

  protected readonly windowDays = signal<WindowDays>(7);
  protected readonly symbolFilter = signal('');
  protected readonly sortMode = signal<SortMode>('drop');

  protected readonly resource = createPolledResource(
    () =>
      this.compositeMl.getCatalogueDriftSummary({ compareWindowDays: this.windowDays() }).pipe(
        map((res) => res.data ?? EMPTY_SUMMARY),
        catchError(() => of(EMPTY_SUMMARY)),
      ),
    { intervalMs: 60_000 },
  );

  constructor() {
    effect(() => {
      this.windowDays();
      this.resource.refresh();
    });
  }

  protected readonly summary = computed(() => this.resource.value() ?? EMPTY_SUMMARY);
  protected readonly loading = computed(
    () => this.resource.loading() && this.summary().rows.length === 0,
  );

  protected readonly dropAlertCount = computed(
    () => this.summary().rows.filter((r) => r.isDropAlert).length,
  );
  protected readonly coldCount = computed(
    () => this.summary().rows.filter((r) => !r.latestIsWarm).length,
  );

  protected readonly filteredRows = computed(() => {
    const needle = this.symbolFilter().trim().toUpperCase();
    const filtered = needle
      ? this.summary().rows.filter((r) => (r.symbol ?? '').toUpperCase().includes(needle))
      : this.summary().rows;
    return this.sortRows(filtered);
  });

  protected rowKey(row: CatalogueDriftSummaryRowDto): string {
    return `${row.layerKey}|${row.symbol ?? ''}|${row.timeframe ?? ''}`;
  }

  protected tierOf(row: CatalogueDriftSummaryRowDto): 'global' | 'symbol' | 'pair' {
    if (!row.symbol) return 'global';
    if (!row.timeframe) return 'symbol';
    return 'pair';
  }

  protected scopeLabel(row: CatalogueDriftSummaryRowDto): string {
    if (!row.symbol) return 'global';
    if (!row.timeframe) return row.symbol;
    return `${row.symbol} · ${row.timeframe}`;
  }

  protected historyQueryFor(row: CatalogueDriftSummaryRowDto): Record<string, string> {
    const q: Record<string, string> = { layerKey: row.layerKey };
    if (row.symbol) q['symbol'] = row.symbol;
    if (row.timeframe) q['timeframe'] = String(row.timeframe as Timeframe);
    return q;
  }

  private sortRows(rows: CatalogueDriftSummaryRowDto[]): CatalogueDriftSummaryRowDto[] {
    const mode = this.sortMode();
    const arr = [...rows];
    if (mode === 'layer') {
      arr.sort((a, b) => a.layerKey.localeCompare(b.layerKey));
    } else if (mode === 'recent') {
      arr.sort((a, b) => b.latestEvaluatedAtUtc.localeCompare(a.latestEvaluatedAtUtc));
    } else {
      // 'drop' — alerts first, then by largest negative relativeDelta, then layer.
      arr.sort((a, b) => {
        if (a.isDropAlert !== b.isDropAlert) return a.isDropAlert ? -1 : 1;
        const aRel = a.relativeDelta ?? 0;
        const bRel = b.relativeDelta ?? 0;
        if (aRel !== bRel) return aRel - bRel; // ascending: most-negative first
        return a.layerKey.localeCompare(b.layerKey);
      });
    }
    return arr;
  }
}
