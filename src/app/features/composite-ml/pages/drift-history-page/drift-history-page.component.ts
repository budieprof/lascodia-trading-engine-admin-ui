import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { catchError, map, of } from 'rxjs';
import type { EChartsOption } from 'echarts';

import { CompositeMLService } from '@core/services/composite-ml.service';
import type { CatalogueDriftHistoryDto, Timeframe } from '@core/api/api.types';
import { createPolledResource } from '@core/polling/polled-resource';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';

type LookbackDays = 7 | 30 | 90 | 365;

@Component({
  selector: 'app-drift-history-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    DecimalPipe,
    RouterLink,
    PageHeaderComponent,
    ChartCardComponent,
    CardSkeletonComponent,
    ErrorStateComponent,
    EmptyStateComponent,
    RelativeTimePipe,
  ],
  template: `
    <div class="page">
      <app-page-header
        [title]="'CompositeML — Drift History'"
        [subtitle]="
          layerKey()
            ? layerKey() + ' · ' + scopeLabelDisplay()
            : 'No layer key in URL — open from the drift summary'
        "
      >
        <a routerLink="/composite-ml/drift" class="btn btn-secondary">← Drift Summary</a>
      </app-page-header>

      <section class="controls">
        <div class="control-group">
          <span class="control-label">Lookback</span>
          <div class="lookback-pills">
            @for (option of LOOKBACK_OPTIONS; track option) {
              <button
                type="button"
                [class.active]="lookback() === option"
                (click)="lookback.set(option)"
              >
                {{ option }}d
              </button>
            }
          </div>
        </div>
        <span class="hint muted">
          {{ pointCount() }} sample{{ pointCount() === 1 ? '' : 's' }} loaded
        </span>
      </section>

      @if (!layerKey()) {
        <app-empty-state
          title="Pick an entry from the drift summary"
          description="This page renders a time-series for one (layerKey, symbol, timeframe). Navigate from the Drift Summary's History → link."
        />
      } @else if (loading()) {
        <app-card-skeleton [lines]="6" />
      } @else if (resource.error()) {
        <app-error-state
          title="Could not load drift history"
          message="Engine returned an error. The drift monitor worker may not have evaluated this layer-key yet."
          (retry)="resource.refresh()"
        />
      } @else if (points().length === 0) {
        <app-empty-state
          title="No samples in this window"
          description="No drift snapshots recorded for this layer in the selected lookback. Try a larger window."
        />
      } @else {
        <section class="meta-strip">
          <span class="meta">
            Latest observed: <strong>{{ latestPoint()?.observedCount ?? 0 }}</strong> vs threshold
            <strong>{{ latestPoint()?.threshold ?? 0 }}</strong>
          </span>
          @if (latestPoint(); as p) {
            @if (p.isWarm) {
              <span class="warm-pill warm">currently warm</span>
            } @else {
              <span class="warm-pill cold">currently cold</span>
            }
          }
          <span class="meta muted">
            Window: <strong>{{ loaded()?.lookbackDays ?? 0 }} days</strong>
          </span>
          @if (latestPoint(); as p) {
            <span class="meta muted" [title]="p.evaluatedAtUtc | date: 'yyyy-MM-dd HH:mm:ss UTC'">
              Last sample: <strong>{{ p.evaluatedAtUtc | relativeTime }}</strong>
            </span>
          }
        </section>

        <app-chart-card
          title="Observed count vs threshold"
          subtitle="Solid = observed; dashed = required warm threshold"
          [options]="chartOptions()"
          height="320px"
        />

        <section class="card">
          <h3 class="table-title">Recent samples (newest first)</h3>
          <table class="samples-table">
            <thead>
              <tr>
                <th>Evaluated</th>
                <th class="num">Observed</th>
                <th class="num">Threshold</th>
                <th class="num">Δ vs threshold</th>
                <th>Warm</th>
              </tr>
            </thead>
            <tbody>
              @for (p of recentPoints(); track p.evaluatedAtUtc) {
                <tr>
                  <td
                    class="time mono"
                    [title]="p.evaluatedAtUtc | date: 'yyyy-MM-dd HH:mm:ss UTC'"
                  >
                    {{ p.evaluatedAtUtc | relativeTime }}
                  </td>
                  <td class="num mono">{{ p.observedCount | number: '1.0-0' }}</td>
                  <td class="num mono">{{ p.threshold | number: '1.0-0' }}</td>
                  <td
                    class="num mono"
                    [class.positive]="p.observedCount >= p.threshold"
                    [class.negative]="p.observedCount < p.threshold"
                  >
                    {{ p.observedCount - p.threshold > 0 ? '+' : ''
                    }}{{ p.observedCount - p.threshold }}
                  </td>
                  <td>
                    @if (p.isWarm) {
                      <span class="warm-pill warm">warm</span>
                    } @else {
                      <span class="warm-pill cold">cold</span>
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
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
        align-items: center;
        gap: var(--space-4);
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
      .hint {
        font-size: var(--text-xs);
        margin-left: auto;
      }
      .meta-strip {
        display: flex;
        gap: var(--space-4);
        align-items: center;
        flex-wrap: wrap;
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-3) var(--space-4);
      }
      .meta {
        font-size: var(--text-sm);
        color: var(--text-secondary);
      }
      .meta strong {
        color: var(--text-primary);
        font-variant-numeric: tabular-nums;
      }
      .meta.muted {
        color: var(--text-tertiary);
      }
      .meta.muted strong {
        color: var(--text-secondary);
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
      .card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--card-padding);
        box-shadow: var(--shadow-sm);
        overflow-x: auto;
      }
      .table-title {
        margin: 0 0 var(--space-3);
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .samples-table {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-sm);
      }
      .samples-table th,
      .samples-table td {
        padding: 8px 10px;
        text-align: left;
        border-bottom: 1px solid var(--border);
        vertical-align: middle;
      }
      .samples-table th {
        color: var(--text-secondary);
        font-weight: var(--font-medium);
        font-size: var(--text-xs);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .samples-table td.num,
      .samples-table th.num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .mono {
        font-family: var(--font-mono);
      }
      .muted {
        color: var(--text-tertiary);
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
    `,
  ],
})
export class DriftHistoryPageComponent {
  private readonly compositeMl = inject(CompositeMLService);
  private readonly route = inject(ActivatedRoute);

  protected readonly LOOKBACK_OPTIONS: readonly LookbackDays[] = [7, 30, 90, 365] as const;
  protected readonly lookback = signal<LookbackDays>(30);

  // Route query params expressed as signals so the fetcher can read them.
  protected readonly layerKey = toSignal(
    this.route.queryParamMap.pipe(map((qp) => qp.get('layerKey'))),
    { initialValue: null },
  );
  protected readonly symbol = toSignal(
    this.route.queryParamMap.pipe(map((qp) => qp.get('symbol'))),
    { initialValue: null },
  );
  protected readonly timeframe = toSignal(
    this.route.queryParamMap.pipe(map((qp) => qp.get('timeframe') as Timeframe | null)),
    { initialValue: null },
  );

  // Single polled resource that reads layerKey/symbol/timeframe/lookback at
  // fetcher-call time. An effect re-fires resource.refresh() whenever any of
  // those signals changes so the displayed series updates immediately on
  // navigation or lookback toggle. createPolledResource handles the periodic
  // refresh + the visibilityState pause; we don't need to layer rxjs flows.
  protected readonly resource = createPolledResource(
    () => {
      const key = this.layerKey();
      if (!key) return of<CatalogueDriftHistoryDto | null>(null);
      return this.compositeMl
        .getCatalogueDriftHistory({
          layerKey: key,
          symbol: this.symbol(),
          timeframe: this.timeframe(),
          lookbackDays: this.lookback(),
        })
        .pipe(
          map((res) => (res.status ? (res.data ?? null) : null)),
          catchError(() => of<CatalogueDriftHistoryDto | null>(null)),
        );
    },
    { intervalMs: 60_000 },
  );

  constructor() {
    // Re-fetch on any signal change. Reading all four signals subscribes the
    // effect; resource.refresh() fires the fetcher which re-reads them.
    effect(() => {
      this.layerKey();
      this.symbol();
      this.timeframe();
      this.lookback();
      this.resource.refresh();
    });
  }

  protected readonly loaded = computed(() => this.resource.value());
  protected readonly loading = computed(
    () => this.resource.loading() && this.resource.value() === null,
  );

  protected readonly points = computed(() => this.loaded()?.points ?? []);
  protected readonly pointCount = computed(() => this.points().length);
  protected readonly latestPoint = computed(() => {
    const arr = this.points();
    return arr.length > 0 ? arr[arr.length - 1] : null;
  });
  protected readonly recentPoints = computed(() => {
    const arr = this.points();
    return [...arr].slice(-20).reverse();
  });

  protected readonly scopeLabelDisplay = computed(() => {
    const s = this.symbol();
    const tf = this.timeframe();
    if (!s) return 'global';
    if (!tf) return s;
    return `${s} · ${tf}`;
  });

  protected readonly chartOptions = computed<EChartsOption>(() => {
    const arr = this.points();
    const obs = arr.map((p) => [p.evaluatedAtUtc, p.observedCount]);
    const thr = arr.map((p) => [p.evaluatedAtUtc, p.threshold]);
    return {
      grid: { left: 56, right: 24, top: 32, bottom: 36 },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross' },
      },
      legend: { data: ['Observed', 'Threshold'], top: 0, textStyle: { fontSize: 11 } },
      xAxis: {
        type: 'time',
        axisLabel: { fontSize: 10 },
        splitLine: { show: false },
      },
      yAxis: {
        type: 'value',
        axisLabel: { fontSize: 10 },
        splitLine: { lineStyle: { type: 'dashed', opacity: 0.5 } },
      },
      series: [
        {
          name: 'Observed',
          type: 'line',
          data: obs,
          smooth: true,
          showSymbol: false,
          lineStyle: { width: 2, color: '#0071e3' },
          areaStyle: {
            color: {
              type: 'linear',
              x: 0,
              y: 0,
              x2: 0,
              y2: 1,
              colorStops: [
                { offset: 0, color: 'rgba(0, 113, 227, 0.25)' },
                { offset: 1, color: 'rgba(0, 113, 227, 0)' },
              ],
            },
          },
        },
        {
          name: 'Threshold',
          type: 'line',
          data: thr,
          showSymbol: false,
          lineStyle: { width: 1.5, color: '#8e8e93', type: 'dashed' },
        },
      ],
    };
  });
}
