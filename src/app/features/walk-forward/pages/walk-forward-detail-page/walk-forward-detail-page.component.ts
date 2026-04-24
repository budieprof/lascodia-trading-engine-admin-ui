import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { DatePipe, DecimalPipe } from '@angular/common';
import { catchError, map, merge, of, throttleTime } from 'rxjs';

import { WalkForwardService } from '@core/services/walk-forward.service';
import type { WalkForwardRunDto } from '@core/api/api.types';
import { createPolledResource } from '@core/polling/polled-resource';
import { RealtimeService } from '@core/realtime/realtime.service';

import { StatusBadgeComponent } from '@shared/components/status-badge/status-badge.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import type { EChartsOption } from 'echarts';

interface WindowResult {
  index: number;
  inSampleStart?: string;
  inSampleEnd?: string;
  oosStart?: string;
  oosEnd?: string;
  inSampleScore?: number;
  oosScore?: number;
}

@Component({
  selector: 'app-walk-forward-detail-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    DecimalPipe,
    StatusBadgeComponent,
    CardSkeletonComponent,
    ErrorStateComponent,
    ChartCardComponent,
  ],
  template: `
    <div class="page">
      @if (loading()) {
        <app-card-skeleton [lines]="10" />
      } @else if (run()) {
        @if (run(); as r) {
          <div class="title-row">
            <div class="title-left">
              <button type="button" class="btn-back" (click)="goBack()" aria-label="Back">
                &larr;
              </button>
              <h1 class="title">Walk-Forward Run #{{ r.id }}</h1>
              <app-status-badge [status]="r.status" type="run" />
            </div>
          </div>

          <section class="card">
            <header class="card-head"><h3>Run Configuration</h3></header>
            <dl class="grid">
              <div class="item">
                <dt>Strategy</dt>
                <dd>{{ r.strategyId }}</dd>
              </div>
              <div class="item">
                <dt>Symbol</dt>
                <dd>{{ r.symbol ?? '-' }}</dd>
              </div>
              <div class="item">
                <dt>Timeframe</dt>
                <dd>{{ r.timeframe }}</dd>
              </div>
              <div class="item">
                <dt>In-Sample</dt>
                <dd>{{ r.inSampleDays }} d</dd>
              </div>
              <div class="item">
                <dt>OOS</dt>
                <dd>{{ r.outOfSampleDays }} d</dd>
              </div>
              <div class="item">
                <dt>Initial Balance</dt>
                <dd class="mono">{{ r.initialBalance | number: '1.2-2' }}</dd>
              </div>
              <div class="item">
                <dt>From</dt>
                <dd>{{ r.fromDate | date: 'MMM d, yyyy' }}</dd>
              </div>
              <div class="item">
                <dt>To</dt>
                <dd>{{ r.toDate | date: 'MMM d, yyyy' }}</dd>
              </div>
              <div class="item">
                <dt>Started</dt>
                <dd>{{ r.startedAt | date: 'MMM d, HH:mm:ss' }}</dd>
              </div>
              <div class="item">
                <dt>Completed</dt>
                <dd>{{ r.completedAt ? (r.completedAt | date: 'MMM d, HH:mm:ss') : '—' }}</dd>
              </div>
              <div class="item">
                <dt>Avg OOS Score</dt>
                <dd class="mono">
                  {{
                    r.averageOutOfSampleScore !== null
                      ? (r.averageOutOfSampleScore | number: '1.2-2')
                      : '—'
                  }}
                </dd>
              </div>
              <div class="item">
                <dt>Consistency</dt>
                <dd class="mono">
                  {{ r.scoreConsistency !== null ? (r.scoreConsistency | number: '1.2-2') : '—' }}
                </dd>
              </div>
            </dl>
          </section>

          @if (r.errorMessage) {
            <div class="error"><strong>Error:</strong> {{ r.errorMessage }}</div>
          }

          @if (windows().length > 0) {
            <section class="card">
              <header class="card-head"><h3>Window Results</h3></header>
              <table class="windows">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>In-Sample</th>
                    <th>OOS</th>
                    <th class="num">IS Score</th>
                    <th class="num">OOS Score</th>
                  </tr>
                </thead>
                <tbody>
                  @for (w of windows(); track w.index) {
                    <tr>
                      <td>{{ w.index + 1 }}</td>
                      <td>
                        {{ w.inSampleStart | date: 'MMM d' }} –
                        {{ w.inSampleEnd | date: 'MMM d, yyyy' }}
                      </td>
                      <td>
                        {{ w.oosStart | date: 'MMM d' }} – {{ w.oosEnd | date: 'MMM d, yyyy' }}
                      </td>
                      <td class="num mono">
                        {{ w.inSampleScore !== null ? (w.inSampleScore | number: '1.2-2') : '—' }}
                      </td>
                      <td class="num mono">
                        {{ w.oosScore !== null ? (w.oosScore | number: '1.2-2') : '—' }}
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </section>

            <app-chart-card
              title="In-Sample vs OOS Score"
              subtitle="Per-window fit vs out-of-sample performance"
              [options]="chartOptions()"
              height="320px"
            />
          } @else if (r.status === 'Completed') {
            <div class="note">No per-window results available in the response.</div>
          }
        }
      } @else {
        <app-error-state
          title="Walk-forward run not found"
          [message]="errorMessage()"
          retryLabel="Back"
          (retry)="goBack()"
        />
      }
    </div>
  `,
  styles: [
    `
      .page {
        padding: var(--space-2) 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-5);
      }
      .title-row {
        display: flex;
        align-items: center;
        gap: var(--space-4);
      }
      .title-left {
        display: flex;
        align-items: center;
        gap: var(--space-3);
      }
      .btn-back {
        width: 36px;
        height: 36px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-secondary);
        color: var(--text-secondary);
      }
      .btn-back:hover {
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }
      .title {
        font-size: var(--text-xl);
        font-weight: var(--font-semibold);
        margin: 0;
      }
      .card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: hidden;
      }
      .card-head {
        padding: var(--space-4) var(--space-5);
        border-bottom: 1px solid var(--border);
      }
      .card-head h3 {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        margin: 0;
      }
      .item {
        padding: var(--space-3) var(--space-5);
        border-bottom: 1px solid var(--border);
        border-right: 1px solid var(--border);
        display: flex;
        flex-direction: column;
        gap: var(--space-1);
      }
      .item:nth-child(3n) {
        border-right: none;
      }
      .item dt {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        font-weight: var(--font-medium);
        margin: 0;
      }
      .item dd {
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        color: var(--text-primary);
        margin: 0;
      }
      .item dd.mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: var(--text-xs);
      }
      .windows {
        width: 100%;
        border-collapse: collapse;
      }
      .windows th,
      .windows td {
        padding: var(--space-3) var(--space-5);
        text-align: left;
        border-bottom: 1px solid var(--border);
        font-size: var(--text-sm);
      }
      .windows th {
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .windows th.num,
      .windows td.num {
        text-align: right;
      }
      .windows td.mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: var(--text-xs);
      }
      .error {
        padding: var(--space-4) var(--space-5);
        background: rgba(255, 59, 48, 0.06);
        border: 1px solid rgba(255, 59, 48, 0.2);
        border-radius: var(--radius-md);
        color: var(--text-primary);
        font-size: var(--text-sm);
      }
      .note {
        padding: var(--space-4) var(--space-5);
        background: var(--bg-secondary);
        border: 1px dashed var(--border);
        border-radius: var(--radius-md);
        font-size: var(--text-sm);
        color: var(--text-secondary);
      }
      @media (max-width: 768px) {
        .grid {
          grid-template-columns: 1fr;
        }
        .item {
          border-right: none;
        }
      }
    `,
  ],
})
export class WalkForwardDetailPageComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly service = inject(WalkForwardService);
  private readonly realtime = inject(RealtimeService);

  readonly errorMessage = signal<string | null>(null);
  private readonly id = signal<number | null>(null);

  private readonly resource = createPolledResource(
    () => {
      const id = this.id();
      if (!id) return of(null as WalkForwardRunDto | null);
      return this.service.getById(id).pipe(
        map((res) => res.data ?? null),
        catchError(() => of(null as WalkForwardRunDto | null)),
      );
    },
    { intervalMs: 30_000 },
  );

  constructor() {
    // Each finished window inside this run emits `backtestCompleted`; the
    // whole run completion emits `optimizationCompleted`. Push-refresh the
    // detail payload so the status pill, window table, and chart tick live.
    // Throttle at 5s — window completions can land in rapid bursts.
    merge(this.realtime.on('backtestCompleted'), this.realtime.on('optimizationCompleted'))
      .pipe(throttleTime(5_000, undefined, { leading: true, trailing: true }), takeUntilDestroyed())
      .subscribe(() => this.resource.refresh());
  }

  readonly run = computed(() => this.resource.value());
  readonly loading = computed(() => this.resource.loading() && this.resource.value() === null);

  readonly windows = computed<WindowResult[]>(() => {
    const r = this.run();
    if (!r || !r.windowResultsJson) return [];
    try {
      const parsed: unknown = JSON.parse(r.windowResultsJson);
      if (Array.isArray(parsed)) {
        return (parsed as Record<string, unknown>[]).map((raw, i) => ({
          index: i,
          inSampleStart: readString(raw, ['inSampleStart', 'isStart', 'inSampleFrom']),
          inSampleEnd: readString(raw, ['inSampleEnd', 'isEnd', 'inSampleTo']),
          oosStart: readString(raw, ['oosStart', 'outOfSampleStart', 'oosFrom']),
          oosEnd: readString(raw, ['oosEnd', 'outOfSampleEnd', 'oosTo']),
          inSampleScore: readNumber(raw, ['inSampleScore', 'isScore']),
          oosScore: readNumber(raw, ['oosScore', 'outOfSampleScore']),
        }));
      }
    } catch {
      // Fall through; show "no windows" state.
    }
    return [];
  });

  readonly chartOptions = computed<EChartsOption>(() => {
    const windows = this.windows();
    const labels = windows.map((w) => `W${w.index + 1}`);
    const isSeries = windows.map((w) => w.inSampleScore ?? null);
    const oosSeries = windows.map((w) => w.oosScore ?? null);
    return {
      tooltip: { trigger: 'axis' },
      legend: { data: ['In-Sample', 'OOS'], bottom: 0 },
      grid: { left: 50, right: 20, top: 20, bottom: 40 },
      xAxis: { type: 'category', data: labels },
      yAxis: { type: 'value', name: 'Score' },
      series: [
        {
          name: 'In-Sample',
          type: 'bar',
          data: isSeries,
          itemStyle: { color: '#0071E3' },
          barWidth: '35%',
        },
        {
          name: 'OOS',
          type: 'bar',
          data: oosSeries,
          itemStyle: { color: '#34C759' },
          barWidth: '35%',
        },
      ],
    };
  });

  ngOnInit(): void {
    const id = Number(this.route.snapshot.paramMap.get('id'));
    if (!id || Number.isNaN(id)) {
      this.errorMessage.set('Invalid run id');
      return;
    }
    this.id.set(id);
  }

  goBack(): void {
    this.router.navigate(['/walk-forward']);
  }
}

function readString(raw: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = raw[k];
    if (typeof v === 'string') return v;
  }
  return undefined;
}

function readNumber(raw: Record<string, unknown>, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = raw[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return undefined;
}
