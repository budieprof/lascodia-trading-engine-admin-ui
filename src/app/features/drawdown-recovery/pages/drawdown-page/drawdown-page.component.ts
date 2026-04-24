import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { catchError, map, of } from 'rxjs';
import type { EChartsOption } from 'echarts';
import type { ColDef } from 'ag-grid-community';

import { DrawdownRecoveryService } from '@core/services/drawdown-recovery.service';
import type { DrawdownSnapshotDto, RecoveryMode } from '@core/api/api.types';
import { createPolledResource } from '@core/polling/polled-resource';
import {
  ChartAnnotationsService,
  type ChartAnnotationDto,
} from '@core/annotations/chart-annotations.service';
import { FeatureFlagsService } from '@core/feature-flags/feature-flags.service';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { GaugeComponent } from '@shared/components/gauge/gauge.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
import { TabsComponent, TabItem } from '@shared/components/ui/tabs/tabs.component';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import { DataTableComponent } from '@shared/components/data-table/data-table.component';

const MODE_LABEL: Record<RecoveryMode, string> = {
  Normal: 'Normal',
  Reduced: 'Reduced',
  Halted: 'Halted',
};

const MODE_COLOR: Record<RecoveryMode, string> = {
  Normal: '#34C759',
  Reduced: '#FF9500',
  Halted: '#FF3B30',
};

@Component({
  selector: 'app-drawdown-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    PageHeaderComponent,
    GaugeComponent,
    CardSkeletonComponent,
    EmptyStateComponent,
    TabsComponent,
    ChartCardComponent,
    DataTableComponent,
    DatePipe,
    DecimalPipe,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Drawdown Recovery"
        subtitle="Real-time drawdown and recovery-mode monitoring"
      />

      <ui-tabs [tabs]="tabs" [(activeTab)]="activeTab" />

      @if (activeTab() === 'live') {
        @if (loading()) {
          <app-card-skeleton [lines]="6" />
        } @else if (snapshot()) {
          @if (snapshot(); as s) {
            <div class="hero-section">
              <div class="hero-gauge">
                <app-gauge
                  [value]="s.drawdownPct"
                  [min]="0"
                  [max]="25"
                  label="Current Drawdown"
                  size="200px"
                  [thresholds]="thresholds"
                />
              </div>
              <div class="hero-info">
                <div class="recovery-badge-row">
                  <span class="recovery-label">Recovery Mode</span>
                  <span class="recovery-badge" [class]="s.recoveryMode.toLowerCase()">
                    {{ modeLabel(s.recoveryMode) }}
                  </span>
                </div>
                <div class="equity-comparison">
                  <div class="equity-item">
                    <span class="equity-label">Peak Equity</span>
                    <span class="equity-value peak">{{ s.peakEquity | number: '1.2-2' }}</span>
                  </div>
                  <div class="equity-divider"><span aria-hidden="true">↓</span></div>
                  <div class="equity-item">
                    <span class="equity-label">Current Equity</span>
                    <span class="equity-value">{{ s.currentEquity | number: '1.2-2' }}</span>
                  </div>
                  <div class="equity-item delta">
                    <span class="equity-label">Drawdown Amount</span>
                    <span class="equity-value loss">{{ drawdownAmount() | number: '1.2-2' }}</span>
                  </div>
                </div>
                <div class="meta-row">
                  <span class="muted">Recorded:</span>
                  <span>{{ s.recordedAt | date: 'MMM d, yyyy HH:mm:ss' }}</span>
                </div>
              </div>
            </div>
          }
        } @else {
          <app-empty-state
            title="No drawdown data available"
            description="The engine has not yet recorded a drawdown snapshot."
          />
        }
      } @else {
        <div class="history-toolbar">
          <h3 class="muted small">Drawdown history with operator notes</h3>
          @if (annotationsEnabled()) {
            <button
              type="button"
              class="btn btn-secondary btn-sm"
              (click)="openCreateAnnotation()"
              [disabled]="creatingAnnotation()"
            >
              + Add note
            </button>
          }
        </div>

        <app-chart-card
          title="Drawdown over time"
          subtitle="Most recent {{ historyChartCount() }} snapshots, oldest first"
          [options]="historyChart()"
          height="320px"
          [loading]="historyLoading()"
        />
        <app-data-table
          [columnDefs]="historyColumns"
          [fetchData]="fetchHistoryPage"
          stateKey="drawdown-history"
        />

        @if (annotationDrawerOpen()) {
          <div
            class="annot-overlay"
            role="presentation"
            tabindex="-1"
            (click)="closeAnnotationDrawer()"
            (keydown.escape)="closeAnnotationDrawer()"
          >
            <form
              class="annot-dialog"
              role="dialog"
              aria-modal="true"
              aria-label="Add drawdown note"
              tabindex="-1"
              (click)="$event.stopPropagation()"
              (keydown)="$event.stopPropagation()"
              (ngSubmit)="submitAnnotation()"
            >
              <h4>Add note</h4>
              <label class="field">
                <span class="lbl">When (UTC)</span>
                <input type="datetime-local" [(ngModel)]="annotWhen" name="when" required />
              </label>
              <label class="field">
                <span class="lbl">Note</span>
                <textarea
                  [(ngModel)]="annotBody"
                  name="body"
                  rows="4"
                  maxlength="500"
                  placeholder="What happened here?"
                  required
                ></textarea>
              </label>
              <div class="annot-actions">
                <button type="button" class="btn btn-ghost" (click)="closeAnnotationDrawer()">
                  Cancel
                </button>
                <button
                  type="submit"
                  class="btn btn-primary"
                  [disabled]="creatingAnnotation() || !annotBody.trim()"
                >
                  {{ creatingAnnotation() ? 'Saving…' : 'Save' }}
                </button>
              </div>
            </form>
          </div>
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
        gap: var(--space-5);
      }
      .hero-section {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: var(--space-8);
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-6);
        box-shadow: var(--shadow-sm);
        align-items: center;
      }
      .hero-gauge {
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .hero-info {
        display: flex;
        flex-direction: column;
        gap: var(--space-5);
      }
      .recovery-badge-row {
        display: flex;
        align-items: center;
        gap: var(--space-3);
      }
      .recovery-label {
        font-size: var(--text-sm);
        color: var(--text-secondary);
        font-weight: var(--font-medium);
      }
      .recovery-badge {
        display: inline-flex;
        align-items: center;
        padding: var(--space-2) var(--space-4);
        border-radius: var(--radius-full);
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .recovery-badge.normal {
        background: rgba(52, 199, 89, 0.12);
        color: #248a3d;
      }
      .recovery-badge.reduced {
        background: rgba(255, 149, 0, 0.12);
        color: #c93400;
      }
      .recovery-badge.halted {
        background: rgba(255, 59, 48, 0.12);
        color: #d70015;
      }
      .equity-comparison {
        display: flex;
        align-items: center;
        gap: var(--space-6);
        flex-wrap: wrap;
      }
      .equity-item {
        display: flex;
        flex-direction: column;
        gap: var(--space-1);
      }
      .equity-item.delta {
        margin-left: var(--space-4);
        padding-left: var(--space-4);
        border-left: 1px solid var(--border);
      }
      .equity-label {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        font-weight: var(--font-medium);
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      .equity-value {
        font-size: var(--text-xl);
        font-weight: var(--font-semibold);
        font-variant-numeric: tabular-nums;
        color: var(--text-primary);
      }
      .equity-value.peak {
        color: var(--text-secondary);
      }
      .equity-value.loss {
        color: var(--loss);
      }
      .equity-divider {
        display: flex;
        align-items: center;
        color: var(--text-tertiary);
        font-size: 20px;
      }
      .meta-row {
        display: flex;
        gap: var(--space-2);
        font-size: var(--text-xs);
        color: var(--text-tertiary);
      }
      .muted {
        color: var(--text-tertiary);
      }
      @media (max-width: 1024px) {
        .hero-section {
          grid-template-columns: 1fr;
        }
      }

      /* ── History-tab toolbar + annotation dialog ───────────────────── */
      .history-toolbar {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: var(--space-3);
      }
      .small {
        font-size: var(--text-xs);
      }
      .btn {
        padding: 6px 14px;
        border-radius: var(--radius-full);
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        border: 1px solid transparent;
        cursor: pointer;
        font-family: inherit;
      }
      .btn-sm {
        padding: 4px 12px;
        font-size: var(--text-xs);
      }
      .btn-primary {
        background: var(--accent);
        color: white;
      }
      .btn-primary:disabled {
        opacity: 0.5;
      }
      .btn-secondary {
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }
      .btn-ghost {
        background: transparent;
        color: var(--text-secondary);
        border-color: var(--border);
      }
      .annot-overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.4);
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1000;
      }
      .annot-dialog {
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-lg);
        box-shadow: var(--shadow-lg);
        padding: var(--space-5) var(--space-6);
        width: 100%;
        max-width: 440px;
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
      }
      .annot-dialog h4 {
        margin: 0;
        font-size: var(--text-lg);
        font-weight: var(--font-semibold);
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: var(--space-1);
      }
      .lbl {
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .field input,
      .field textarea {
        padding: 8px 10px;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-secondary);
        color: var(--text-primary);
        font-size: var(--text-sm);
        font-family: inherit;
        resize: vertical;
      }
      .annot-actions {
        display: flex;
        justify-content: flex-end;
        gap: var(--space-2);
      }
    `,
  ],
})
export class DrawdownPageComponent {
  private readonly service = inject(DrawdownRecoveryService);
  private readonly annotationsService = inject(ChartAnnotationsService);
  private readonly flags = inject(FeatureFlagsService);

  /**
   * Chart annotations are gated behind `chart-annotations` so ops can stage
   * rollout per-role or per-percentage via `runtime-config.json`. When off,
   * existing notes still render in the chart (read path) but the authoring
   * affordance is hidden.
   */
  readonly annotationsEnabled = this.flags.watch('chart-annotations');

  readonly tabs: TabItem[] = [
    { label: 'Live', value: 'live' },
    { label: 'History', value: 'history' },
  ];
  readonly activeTab = signal('live');

  readonly thresholds = [
    { value: 5, color: '#34C759' },
    { value: 10, color: '#FF9500' },
    { value: 25, color: '#FF3B30' },
  ];

  private readonly resource = createPolledResource(
    () =>
      this.service.getLatest().pipe(
        map((r) => r.data),
        catchError(() => of(null as DrawdownSnapshotDto | null)),
      ),
    { intervalMs: 15_000 },
  );

  readonly snapshot = computed(() => this.resource.value());
  readonly loading = computed(() => this.resource.loading() && this.resource.value() === null);
  readonly drawdownAmount = computed(() => {
    const s = this.snapshot();
    if (!s) return 0;
    return s.currentEquity - s.peakEquity;
  });

  // ── History tab ──────────────────────────────────────────────────────────
  readonly historySeries = signal<DrawdownSnapshotDto[]>([]);
  readonly historyLoading = signal(false);
  readonly historyChartCount = computed(() => this.historySeries().length);
  readonly annotations = signal<ChartAnnotationDto[]>([]);

  // ── Annotation editor state ───────────────────────────────────────────
  readonly annotationDrawerOpen = signal(false);
  readonly creatingAnnotation = signal(false);
  /** ngModel-bound. `datetime-local` yields `YYYY-MM-DDTHH:mm` (no TZ). */
  annotWhen = '';
  annotBody = '';

  readonly historyChart = computed<EChartsOption>(() => {
    const series = this.historySeries();
    if (series.length === 0) return {};
    return {
      grid: { left: 56, right: 24, top: 24, bottom: 36 },
      tooltip: { trigger: 'axis' },
      legend: { data: ['Drawdown %', 'Equity'] },
      xAxis: {
        type: 'time',
        axisLabel: { color: 'var(--text-secondary)' },
      },
      yAxis: [
        { type: 'value', name: 'DD %', position: 'left', axisLabel: { formatter: '{value}%' } },
        { type: 'value', name: 'Equity', position: 'right' },
      ],
      series: [
        {
          name: 'Drawdown %',
          type: 'line',
          yAxisIndex: 0,
          smooth: true,
          showSymbol: false,
          data: series.map((s) => [s.recordedAt, s.drawdownPct]),
          lineStyle: { width: 2, color: '#FF9500' },
          areaStyle: { color: 'rgba(255, 149, 0, 0.12)' },
          markPoint: {
            symbol: 'circle',
            symbolSize: 8,
            data: series
              .filter((s) => s.recoveryMode !== 'Normal')
              .map((s) => ({
                name: s.recoveryMode,
                value: s.drawdownPct,
                xAxis: s.recordedAt,
                yAxis: s.drawdownPct,
                itemStyle: { color: MODE_COLOR[s.recoveryMode] },
              })),
          },
        },
        {
          name: 'Equity',
          type: 'line',
          yAxisIndex: 1,
          smooth: true,
          showSymbol: false,
          data: series.map((s) => [s.recordedAt, s.currentEquity]),
          lineStyle: { width: 2, color: '#0A84FF' },
        },
        // Operator-authored annotations overlaid as a scatter series, pinned
        // to a fixed y-height (0) on the drawdown axis so they read as
        // "things that happened at this timestamp." Tooltip formatter shows
        // the body; escaping keeps malicious bodies out of the DOM.
        {
          name: 'Notes',
          type: 'scatter',
          yAxisIndex: 0,
          symbol: 'pin',
          symbolSize: 22,
          itemStyle: { color: '#0A84FF' },
          data: this.annotations().map((a) => ({
            name: 'Note',
            value: [a.annotatedAt, 0],
            // ECharts passes a value param; we render only the body (escaped).
            tooltip: { formatter: `<strong>Note</strong><br/>${escapeHtml(a.body)}` },
          })),
          emphasis: { scale: true },
        },
      ],
    };
  });

  readonly historyColumns: ColDef<DrawdownSnapshotDto>[] = [
    {
      headerName: 'Recorded',
      field: 'recordedAt',
      width: 200,
      valueFormatter: (p) => new Date(p.value as string).toLocaleString(),
    },
    {
      headerName: 'Mode',
      field: 'recoveryMode',
      width: 120,
      cellRenderer: (p: { value: RecoveryMode }) => {
        const color = MODE_COLOR[p.value];
        return `<span style="color: ${color}; font-weight: 600;">${MODE_LABEL[p.value] ?? p.value}</span>`;
      },
    },
    {
      headerName: 'Drawdown %',
      field: 'drawdownPct',
      width: 140,
      type: 'numericColumn',
      valueFormatter: (p) => (p.value as number)?.toFixed(2) + '%',
    },
    {
      headerName: 'Current Equity',
      field: 'currentEquity',
      width: 160,
      type: 'numericColumn',
      valueFormatter: (p) =>
        (p.value as number)?.toLocaleString(undefined, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }),
    },
    {
      headerName: 'Peak Equity',
      field: 'peakEquity',
      width: 160,
      type: 'numericColumn',
      valueFormatter: (p) =>
        (p.value as number)?.toLocaleString(undefined, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }),
    },
  ];

  readonly fetchHistoryPage = (params: {
    currentPage?: number;
    itemCountPerPage?: number;
    filter?: any;
  }) => {
    this.historyLoading.set(true);
    return this.service
      .listHistory({
        currentPage: params.currentPage,
        itemCountPerPage: params.itemCountPerPage,
        filter: params.filter,
      })
      .pipe(
        map((res) => {
          const empty = {
            pager: {
              totalItemCount: 0,
              filter: null,
              currentPage: 1,
              itemCountPerPage: 25,
              pageNo: 1,
              pageSize: 25,
            },
            data: [] as DrawdownSnapshotDto[],
          };
          const page = res.data ?? empty;
          // Chart wants oldest-first; engine returns newest-first.
          this.historySeries.set([...page.data].reverse());
          this.historyLoading.set(false);
          // Fire-and-forget — the chart re-renders on annotation arrival,
          // and a failed annotation load shouldn't break the table page.
          this.loadAnnotationsForSeries(page.data);
          return page;
        }),
        catchError(() => {
          this.historySeries.set([]);
          this.historyLoading.set(false);
          return of({
            pager: {
              totalItemCount: 0,
              filter: null,
              currentPage: 1,
              itemCountPerPage: 25,
              pageNo: 1,
              pageSize: 25,
            },
            data: [] as DrawdownSnapshotDto[],
          });
        }),
      );
  };

  modeLabel(mode: RecoveryMode): string {
    return MODE_LABEL[mode] ?? String(mode);
  }

  // ── Annotation editor ────────────────────────────────────────────────

  openCreateAnnotation(): void {
    // Default to "now" so the common case (just happened) is a single click.
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    this.annotWhen = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
    this.annotBody = '';
    this.annotationDrawerOpen.set(true);
  }

  closeAnnotationDrawer(): void {
    if (this.creatingAnnotation()) return; // don't close mid-save
    this.annotationDrawerOpen.set(false);
  }

  submitAnnotation(): void {
    const body = this.annotBody.trim();
    if (!body || !this.annotWhen) return;
    // `datetime-local` value is local time; convert to UTC ISO before posting.
    const annotatedAt = new Date(this.annotWhen).toISOString();
    this.creatingAnnotation.set(true);
    this.annotationsService
      .create({ target: 'drawdown', annotatedAt, body })
      .pipe(catchError(() => of(null)))
      .subscribe((res) => {
        this.creatingAnnotation.set(false);
        if (res?.status) {
          // Refresh against the current window so the new note shows up.
          this.loadAnnotationsForSeries(this.historySeries());
          this.annotationDrawerOpen.set(false);
        }
      });
  }

  /**
   * Fetches chart annotations covering the loaded series's time range and
   * stashes them on `this.annotations`. Network + parse errors leave the
   * annotation layer empty rather than bubble up.
   */
  private loadAnnotationsForSeries(series: DrawdownSnapshotDto[]): void {
    if (series.length === 0) {
      this.annotations.set([]);
      return;
    }
    const earliest = series.reduce(
      (min, s) => (new Date(s.recordedAt) < new Date(min) ? s.recordedAt : min),
      series[0].recordedAt,
    );
    const latest = series.reduce(
      (max, s) => (new Date(s.recordedAt) > new Date(max) ? s.recordedAt : max),
      series[0].recordedAt,
    );

    this.annotationsService
      .list('drawdown', {
        currentPage: 1,
        itemCountPerPage: 100,
        filter: { from: earliest, to: latest },
      })
      .pipe(catchError(() => of(null)))
      .subscribe((res) => {
        this.annotations.set(res?.data?.data ?? []);
      });
  }
}

/** Minimal HTML escape — ECharts renders tooltip strings as raw HTML. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
