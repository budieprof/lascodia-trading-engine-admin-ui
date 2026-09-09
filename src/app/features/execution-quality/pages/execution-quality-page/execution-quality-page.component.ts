import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { DecimalPipe, formatDate } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { catchError, map, Observable, of, throttleTime } from 'rxjs';
import type { ColDef } from 'ag-grid-community';
import type { EChartsOption } from 'echarts';

import { ExecutionQualityService } from '@core/services/execution-quality.service';
import { StrategiesService } from '@core/services/strategies.service';
import type { ExecutionQualityLogDto, PagedData, PagerRequest } from '@core/api/api.types';
import { createPolledResource } from '@core/polling/polled-resource';
import { RealtimeService } from '@core/realtime/realtime.service';

import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { TabsComponent, TabItem } from '@shared/components/ui/tabs/tabs.component';
import { DataTableComponent } from '@shared/components/data-table/data-table.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';

/** Every roll-up on this page is computed over this many most-recent fills. */
const SAMPLE_SIZE = 200;

/** One date/time format for the page. */
const DATE_FMT = 'd MMM yyyy, HH:mm';

/** Slippage beyond this many pips against us is flagged. */
const BAD_SLIPPAGE_PIPS = 1;
/** Latency thresholds (ms) — only applied when latency is actually recorded. */
const BAD_LATENCY_MS = 500;
const GOOD_LATENCY_MS = 100;
const BAD_P95_LATENCY_MS = 1000;

type Tone = 'good' | 'bad' | 'warn' | '';

function formatStamp(iso: string | null | undefined): string {
  return iso ? formatDate(iso, DATE_FMT, 'en-US') : '—';
}

/** Zero (and negative zero) is neutral; only a genuine sign earns a colour. */
function slipTone(pips: number | null | undefined): Tone {
  if (pips == null || !Number.isFinite(pips) || pips === 0) return '';
  if (pips > BAD_SLIPPAGE_PIPS) return 'bad';
  if (pips < 0) return 'good';
  return '';
}

/** `(-0).toFixed(2)` prints "-0.00"; normalise before printing. */
function fmtPips(v: number | null | undefined, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const n = Math.abs(v) < 0.5 * Math.pow(10, -digits) ? 0 : v;
  return `${n.toFixed(digits)}p`;
}

function fmtMs(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${Math.round(v).toLocaleString('en-US')} ms`;
}

@Component({
  selector: 'app-execution-quality-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DecimalPipe,
    ChartCardComponent,
    PageHeaderComponent,
    TabsComponent,
    DataTableComponent,
    EmptyStateComponent,
    ErrorStateComponent,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Execution Quality"
        subtitle="Slippage, fill latency, and TCA from recent executions"
      />

      <ui-tabs [tabs]="tabs" [(activeTab)]="activeTab">
        @if (activeTab() === 'log') {
          <p class="sample-note">{{ sampleLabel() }}</p>

          <!-- Six tiles, all computed over the sample — the labels say so. -->
          <div class="eq-kpis">
            <div class="eq-kpi">
              <span class="kpi-label">Fills in sample</span>
              <span class="kpi-value">{{ recent().length | number }}</span>
              @if (logTotal() !== null) {
                <span class="kpi-sub">of {{ logTotal() | number }} logged</span>
              }
            </div>
            <div class="eq-kpi">
              <span class="kpi-label">Avg slippage</span>
              <span class="kpi-value" [class]="'kpi-value ' + slipTone(avgSlippage())">
                {{ fmtPips(avgSlippage()) }}
              </span>
            </div>
            <div class="eq-kpi">
              <span class="kpi-label">Worst slippage</span>
              <span class="kpi-value" [class]="'kpi-value ' + slipTone(maxSlippage())">
                {{ fmtPips(maxSlippage()) }}
              </span>
            </div>
            <div class="eq-kpi">
              <span class="kpi-label">Best slippage</span>
              <span class="kpi-value" [class]="'kpi-value ' + slipTone(minSlippage())">
                {{ fmtPips(minSlippage()) }}
              </span>
              <span class="kpi-sub">negative = price improvement</span>
            </div>
            <div class="eq-kpi">
              <span class="kpi-label">Partial fills</span>
              <span class="kpi-value" [class.warn]="partialCount() > 0">
                {{ partialCount() | number }}
              </span>
            </div>
            <div class="eq-kpi">
              <span class="kpi-label">Avg latency</span>
              @if (latencyRecorded()) {
                <span class="kpi-value" [class]="'kpi-value ' + latencyTone(avgLatency())">
                  {{ fmtMs(avgLatency()) }}
                </span>
                <span class="kpi-sub">P95 {{ fmtMs(p95Latency()) }}</span>
              } @else {
                <span class="kpi-value muted-value">not recorded</span>
                <span class="kpi-sub">submit-to-fill is 0 on every fill</span>
              }
            </div>
          </div>

          <section class="eq-board">
            <header class="eq-board-head">
              <h3>Execution log</h3>
              <span class="muted">Server-paged · every recorded fill</span>
            </header>
            <app-data-table
              #executionsTable
              [columnDefs]="columnDefs"
              [fetchData]="fetchExecutions"
              [searchable]="true"
            />
          </section>
        }

        @if (activeTab() === 'analytics') {
          @if (recent().length > 0) {
            <p class="sample-note">{{ sampleLabel() }}</p>

            <!-- Anomalies first: fill rate and slippage tails lead, then the rest. -->
            <div class="eq-kpis">
              <div class="eq-kpi">
                <span class="kpi-label">Avg fill rate</span>
                <span class="kpi-value" [class]="'kpi-value ' + fillRateTone(avgFillRate())">
                  {{ avgFillRate() * 100 | number: '1.1-1' }}%
                </span>
                @if (avgFillRate() > 1.0005) {
                  <span class="kpi-sub bad">above 100% — filled &gt; requested volume</span>
                }
              </div>
              <div class="eq-kpi">
                <span class="kpi-label">Avg slippage</span>
                <span class="kpi-value" [class]="'kpi-value ' + slipTone(avgSlippage())">
                  {{ fmtPips(avgSlippage()) }}
                </span>
              </div>
              <div class="eq-kpi">
                <span class="kpi-label">P50 slippage</span>
                <span class="kpi-value" [class]="'kpi-value ' + slipTone(p50Slippage())">
                  {{ fmtPips(p50Slippage()) }}
                </span>
              </div>
              <div class="eq-kpi">
                <span class="kpi-label">P95 slippage</span>
                <span class="kpi-value" [class]="'kpi-value ' + slipTone(p95Slippage())">
                  {{ fmtPips(p95Slippage()) }}
                </span>
              </div>
              <div class="eq-kpi">
                <span class="kpi-label">Partial fills</span>
                <span class="kpi-value" [class.warn]="partialPct() > 0">
                  {{ partialPct() | number: '1.1-1' }}%
                </span>
                <span class="kpi-sub"
                  >{{ partialCount() | number }} of {{ recent().length | number }}</span
                >
              </div>
              <div class="eq-kpi">
                <span class="kpi-label">Avg latency</span>
                @if (latencyRecorded()) {
                  <span class="kpi-value" [class]="'kpi-value ' + latencyTone(avgLatency())">
                    {{ fmtMs(avgLatency()) }}
                  </span>
                  <span class="kpi-sub">P95 {{ fmtMs(p95Latency()) }}</span>
                } @else {
                  <span class="kpi-value muted-value">not recorded</span>
                  <span class="kpi-sub">submit-to-fill is 0 on every fill</span>
                }
              </div>
            </div>

            <div class="charts-grid">
              <app-chart-card
                title="Slippage distribution"
                [subtitle]="'Pips per fill, latest ' + recent().length + ' fills'"
                [options]="slippageHistogram()"
                height="280px"
              />
              <app-chart-card
                title="Fill-rate distribution"
                [subtitle]="'Filled ÷ requested volume, latest ' + recent().length + ' fills'"
                [options]="fillRateHistogram()"
                height="280px"
              />
            </div>

            @if (latencyRecorded()) {
              <div class="charts-grid">
                <app-chart-card
                  title="Fill latency distribution"
                  subtitle="Submit-to-fill milliseconds"
                  [options]="latencyHistogram()"
                  height="280px"
                />
                <app-chart-card
                  title="Slippage vs latency"
                  subtitle="Per-fill scatter — top-right quadrant is the danger zone"
                  [options]="scatterChart()"
                  height="280px"
                />
              </div>
            } @else {
              <p class="note-card">
                Fill latency is not recorded — <code>submitToFillMs</code> is 0 on all
                {{ recent().length | number }} fills in the sample, so the latency distribution,
                latency-by-session and slippage-vs-latency views are hidden rather than drawn as
                zero.
              </p>
            }

            <div class="charts-grid">
              <app-chart-card
                title="Slippage by symbol"
                [subtitle]="'Average pips per symbol, latest ' + recent().length + ' fills'"
                [options]="slippageBySymbol()"
                [height]="symbolChartHeight()"
              />
              <app-chart-card
                title="Slippage by session"
                [subtitle]="sessionChartSubtitle()"
                [options]="slippageBySession()"
                height="280px"
              />
            </div>

            @if (latencyRecorded()) {
              <div class="charts-grid">
                <app-chart-card
                  title="Latency by session"
                  subtitle="Average submit-to-fill ms per trading session"
                  [options]="latencyBySession()"
                  height="240px"
                />
              </div>
            }

            <!-- 2-col tables: per-symbol breakdown + per-session breakdown -->
            <div class="eq-board-row">
              <section class="eq-board">
                <header class="eq-board-head">
                  <h3>Per-symbol breakdown</h3>
                  <span class="muted">Latest {{ recent().length | number }} fills</span>
                </header>
                @if (perSymbolBreakdown().length > 0) {
                  <div class="eq-scroll">
                    <table class="eq-board-table sticky-head">
                      <thead>
                        <tr>
                          <th>Symbol</th>
                          <th class="num">Fills</th>
                          <th class="num">Avg slip</th>
                          <th class="num">Worst slip</th>
                          <th class="num">Avg latency</th>
                          <th class="num">P95 latency</th>
                          <th class="num">Partial</th>
                        </tr>
                      </thead>
                      <tbody>
                        @for (row of perSymbolBreakdown(); track row.symbol) {
                          <tr>
                            <td class="mono">{{ row.symbol }}</td>
                            <td class="num mono">{{ row.fills | number }}</td>
                            <td class="num mono" [class]="'num mono ' + slipTone(row.avgSlippage)">
                              {{ fmtPips(row.avgSlippage) }}
                            </td>
                            <td class="num mono" [class]="'num mono ' + slipTone(row.maxSlippage)">
                              {{ fmtPips(row.maxSlippage) }}
                            </td>
                            <td
                              class="num mono"
                              [class]="'num mono ' + latencyTone(row.avgLatency)"
                            >
                              {{ latencyRecorded() ? fmtMs(row.avgLatency) : '—' }}
                            </td>
                            <td
                              class="num mono"
                              [class.bad]="latencyRecorded() && row.p95Latency > badP95Latency"
                            >
                              {{ latencyRecorded() ? fmtMs(row.p95Latency) : '—' }}
                            </td>
                            <td class="num mono" [class.warn]="row.partialPct > 0">
                              {{ row.partialPct | number: '1.1-1' }}%
                            </td>
                          </tr>
                        }
                      </tbody>
                    </table>
                  </div>
                }
              </section>

              <section class="eq-board">
                <header class="eq-board-head">
                  <h3>Per-session breakdown</h3>
                  <span class="muted">As tagged by the engine</span>
                </header>
                @if (perSessionBreakdown().length > 0) {
                  <table class="eq-board-table">
                    <thead>
                      <tr>
                        <th>Session</th>
                        <th class="num">Fills</th>
                        <th class="num">Avg slip</th>
                        <th class="num">Avg latency</th>
                        <th class="num">Partial</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (row of perSessionBreakdown(); track row.session) {
                        <tr>
                          <td class="mono">{{ row.session }}</td>
                          <td class="num mono">{{ row.fills | number }}</td>
                          <td class="num mono" [class]="'num mono ' + slipTone(row.avgSlippage)">
                            {{ fmtPips(row.avgSlippage) }}
                          </td>
                          <td class="num mono" [class]="'num mono ' + latencyTone(row.avgLatency)">
                            {{ latencyRecorded() ? fmtMs(row.avgLatency) : '—' }}
                          </td>
                          <td class="num mono" [class.warn]="row.partialPct > 0">
                            {{ row.partialPct | number: '1.1-1' }}%
                          </td>
                        </tr>
                      }
                    </tbody>
                  </table>
                  @if (perSessionBreakdown().length === 1) {
                    <p class="board-note">
                      Every fill in the sample is tagged
                      <strong>{{ perSessionBreakdown()[0].session }}</strong> — including fills
                      timestamped outside that session. The engine's session classification is being
                      repaired; nothing here is reclassified client-side.
                    </p>
                  }
                }
              </section>
            </div>

            <!-- Worst offenders — fills with the worst adverse tail behaviour -->
            <section class="eq-board">
              <header class="eq-board-head">
                <h3>Worst offenders</h3>
                <span class="muted">
                  Top 10 fills by adverse slippage{{ latencyRecorded() ? ' and latency' : '' }}
                  — price improvement never counts against a fill
                </span>
              </header>
              @if (worstOffenders().length > 0) {
                <table class="eq-board-table">
                  <thead>
                    <tr>
                      <th>Order</th>
                      <th>Symbol</th>
                      <th>Session</th>
                      <th class="num">Slippage</th>
                      <th class="num">Latency</th>
                      <th class="num">Fill rate</th>
                      <th>Partial</th>
                      <th>Recorded</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (r of worstOffenders(); track r.id) {
                      <tr>
                        <td class="mono">#{{ r.orderId }}</td>
                        <td class="mono">{{ r.symbol }}</td>
                        <td class="mono">{{ r.session }}</td>
                        <td class="num mono" [class]="'num mono ' + slipTone(r.slippagePips)">
                          {{ fmtPips(r.slippagePips) }}
                        </td>
                        <td class="num mono" [class]="'num mono ' + latencyTone(r.submitToFillMs)">
                          {{ latencyRecorded() ? fmtMs(r.submitToFillMs) : '—' }}
                        </td>
                        <td class="num mono" [class]="'num mono ' + fillRateTone(r.fillRate)">
                          {{ r.fillRate * 100 | number: '1.1-1' }}%
                        </td>
                        <td>
                          <span class="eq-pill" [class.warn]="r.wasPartialFill">
                            {{ r.wasPartialFill ? 'Partial' : 'Full' }}
                          </span>
                        </td>
                        <td class="mono">{{ formatStamp(r.recordedAt) }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              } @else {
                <p class="board-note good">
                  No adverse fills in the sample — every fill was at or better than the requested
                  price.
                </p>
              }
            </section>
          } @else if (analyticsError()) {
            <app-error-state
              title="Could not load execution-quality analytics"
              message="Engine returned an error from /execution-quality/list. Nothing here is a real zero until it answers."
              (retry)="analyticsResource.refresh()"
            />
          } @else {
            <app-empty-state
              title="No execution quality data yet"
              description="Analytics populate once the engine records execution-quality log entries."
            />
          }
        }
      </ui-tabs>
    </div>
  `,
  styles: [
    `
      .page {
        padding: var(--space-2) 0;
      }
      .sample-note {
        margin: 0 0 var(--space-3);
        font-size: var(--text-xs);
        color: var(--text-tertiary);
      }
      .charts-grid {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: var(--space-4);
        margin-bottom: var(--space-4);
        align-items: start;
      }
      @media (max-width: 1024px) {
        .charts-grid {
          grid-template-columns: 1fr;
        }
      }

      .eq-kpis {
        display: grid;
        grid-template-columns: repeat(6, minmax(0, 1fr));
        gap: var(--space-3);
        margin-bottom: var(--space-4);
        align-items: start;
      }
      @media (max-width: 1400px) {
        .eq-kpis {
          grid-template-columns: repeat(3, minmax(0, 1fr));
        }
      }
      @media (max-width: 720px) {
        .eq-kpis {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
      }
      .eq-kpi {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-3) var(--space-4);
        display: flex;
        flex-direction: column;
        gap: 4px;
        min-height: 84px;
      }
      .eq-kpi .kpi-label {
        font-size: 10px;
        font-weight: var(--font-semibold);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .eq-kpi .kpi-value {
        font-size: var(--text-xl);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }
      .eq-kpi .kpi-value.muted-value {
        color: var(--text-tertiary);
        font-size: var(--text-base);
        font-weight: var(--font-medium);
      }
      .eq-kpi .kpi-sub {
        font-size: 10.5px;
        color: var(--text-tertiary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .eq-kpi .kpi-sub.bad {
        color: var(--loss);
      }
      .eq-kpi .kpi-value.good {
        color: var(--profit);
      }
      .eq-kpi .kpi-value.bad {
        color: var(--loss);
      }
      .eq-kpi .kpi-value.warn {
        color: var(--warning);
      }

      .note-card {
        margin: 0 0 var(--space-4);
        padding: var(--space-3) var(--space-4);
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        font-size: var(--text-xs);
        color: var(--text-secondary);
        line-height: 1.5;
      }
      .note-card code {
        font-size: 10.5px;
      }

      .eq-board-row {
        display: grid;
        grid-template-columns: 1.6fr 1fr;
        gap: var(--space-3);
        margin-bottom: var(--space-3);
        align-items: start;
      }
      @media (max-width: 1100px) {
        .eq-board-row {
          grid-template-columns: 1fr;
        }
      }

      .eq-board {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: hidden;
        margin-bottom: var(--space-3);
      }
      .eq-board-head {
        display: flex;
        align-items: baseline;
        gap: var(--space-3);
        padding: var(--space-3) var(--space-4);
        border-bottom: 1px solid var(--border);
      }
      .eq-board-head h3 {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
        white-space: nowrap;
      }
      .eq-board-head .muted {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
      }
      .board-note {
        margin: 0;
        padding: var(--space-3) var(--space-4);
        border-top: 1px solid var(--border);
        font-size: var(--text-xs);
        color: var(--text-secondary);
        line-height: 1.5;
      }
      .board-note.good {
        border-top: none;
        color: var(--profit);
      }
      .eq-board-table {
        width: 100%;
        border-collapse: collapse;
      }
      .eq-board-table th,
      .eq-board-table td {
        padding: 8px var(--space-3);
        text-align: left;
        border-bottom: 1px solid var(--border);
        font-size: var(--text-xs);
      }
      .eq-board-table tbody tr:last-child td {
        border-bottom: none;
      }
      .eq-board-table th {
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        font-size: 10.5px;
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .eq-board-table th.num,
      .eq-board-table td.num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .eq-board-table .mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
      }
      .eq-board-table .good {
        color: var(--profit);
      }
      .eq-board-table .bad {
        color: var(--loss);
      }
      .eq-board-table .warn {
        color: var(--warning);
      }
      .eq-scroll {
        max-height: 360px;
        overflow-y: auto;
      }
      .eq-board-table.sticky-head thead th {
        position: sticky;
        top: 0;
        z-index: 1;
      }
      .eq-pill {
        display: inline-flex;
        padding: 2px 8px;
        border-radius: var(--radius-full);
        font-size: 10.5px;
        font-weight: var(--font-semibold);
        background: var(--bg-tertiary);
        color: var(--text-secondary);
      }
      .eq-pill.warn {
        background: rgba(255, 149, 0, 0.14);
        color: #c93400;
      }
      .muted {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
      }
    `,
  ],
})
export class ExecutionQualityPageComponent {
  private readonly service = inject(ExecutionQualityService);
  private readonly strategiesService = inject(StrategiesService);
  private readonly realtime = inject(RealtimeService);

  private readonly executionsTable =
    viewChild<DataTableComponent<ExecutionQualityLogDto>>('executionsTable');

  readonly tabs: TabItem[] = [
    { label: 'Execution Log', value: 'log' },
    { label: 'Analytics', value: 'analytics' },
  ];
  readonly activeTab = signal('log');

  readonly badP95Latency = BAD_P95_LATENCY_MS;
  readonly fmtPips = fmtPips;
  readonly fmtMs = fmtMs;
  readonly slipTone = slipTone;
  readonly formatStamp = formatStamp;

  constructor() {
    // Each `orderFilled` push produces a new execution-quality log row on the
    // backend, so refresh both the paginated log table and the analytics
    // aggregate. Throttled at 3s — faster than the other pages because fills
    // are the primary signal here and operators will be watching for tail
    // latency / slippage spikes in near-real-time.
    this.realtime
      .on('orderFilled')
      .pipe(throttleTime(3_000, undefined, { leading: true, trailing: true }), takeUntilDestroyed())
      .subscribe(() => {
        this.executionsTable()?.loadData();
        this.analyticsResource.refresh();
      });

    // The log row carries only a strategy id; the name is what an operator
    // recognises. One fetch, kept for the life of the page.
    this.strategiesService
      .list({ currentPage: 1, itemCountPerPage: 500 })
      .pipe(
        map((r) => r.data?.data ?? []),
        catchError(() => of([])),
        takeUntilDestroyed(),
      )
      .subscribe((list) => {
        const names = new Map<number, string>();
        for (const s of list) if (s.name) names.set(s.id, s.name);
        this.strategyNames.set(names);
        // Column formatters read the map at render time; repaint rows that
        // arrived before it did.
        this.executionsTable()?.loadData();
      });
  }

  private readonly strategyNames = signal(new Map<number, string>());

  readonly columnDefs: ColDef<ExecutionQualityLogDto>[] = [
    {
      headerName: 'Recorded',
      field: 'recordedAt',
      width: 170,
      valueFormatter: (p) => formatStamp(p.value as string),
    },
    { headerName: 'Order', field: 'orderId', width: 100 },
    { headerName: 'Symbol', field: 'symbol', width: 110 },
    {
      headerName: 'Strategy',
      field: 'strategyId',
      width: 160,
      valueFormatter: (p) => {
        const id = p.value as number | null;
        if (id == null) return '—';
        return this.strategyNames().get(id) ?? `#${id}`;
      },
    },
    { headerName: 'Session', field: 'session', width: 120 },
    {
      headerName: 'Requested',
      field: 'requestedPrice',
      width: 120,
      valueFormatter: (p) => (p.value as number)?.toFixed(5) ?? '—',
    },
    {
      headerName: 'Filled',
      field: 'filledPrice',
      width: 120,
      valueFormatter: (p) => (p.value as number)?.toFixed(5) ?? '—',
    },
    {
      headerName: 'Slippage',
      field: 'slippagePips',
      width: 120,
      valueFormatter: (p) => fmtPips(p.value as number),
      cellStyle: (p) => {
        const tone = slipTone(p.value as number);
        if (tone === 'bad') return { color: '#D70015', fontWeight: 600 };
        if (tone === 'good') return { color: '#248A3D', fontWeight: 600 };
        return null;
      },
    },
    {
      headerName: 'Latency',
      field: 'submitToFillMs',
      width: 120,
      // A 0 here is an unrecorded measurement, not an instant fill.
      valueFormatter: (p) => ((p.value as number) > 0 ? fmtMs(p.value as number) : '—'),
    },
    {
      headerName: 'Fill %',
      field: 'fillRate',
      width: 100,
      valueFormatter: (p) => (p.value != null ? `${((p.value as number) * 100).toFixed(1)}%` : '—'),
      cellStyle: (p) => {
        const v = p.value as number | null;
        // Above 100 % is a corrupt filled/requested pair, flagged not hidden.
        if (v != null && (v > 1.0005 || v < 0.95)) return { color: '#D70015', fontWeight: 600 };
        return null;
      },
    },
    {
      headerName: 'Partial',
      field: 'wasPartialFill',
      width: 100,
      cellRenderer: (p: { value: unknown }) => (p.value ? 'Yes' : 'No'),
    },
  ];

  readonly fetchExecutions = (
    params: PagerRequest,
  ): Observable<PagedData<ExecutionQualityLogDto>> =>
    this.service.list(params).pipe(map((r) => r.data ?? { pager: emptyPager(), data: [] }));

  /** Total rows the server holds, read off the table so the sample can be sized against it. */
  readonly logTotal = computed<number | null>(() => {
    const table = this.executionsTable();
    if (!table) return null;
    const total = table.totalItems();
    return total > 0 ? total : null;
  });

  // No catchError: a failed fetch must reach `.error()` and render as an
  // error state, not as an empty sample that reads like "no fills".
  protected readonly analyticsResource = createPolledResource(
    () =>
      this.service
        .list({ currentPage: 1, itemCountPerPage: SAMPLE_SIZE })
        .pipe(map((r) => r.data?.data ?? [])),
    {
      // Push-driven: the interval is only a fallback for a missed
      // push or a reconnect gap.
      intervalMs: 120_000,
      refreshOn: ['orderFilled', 'positionClosed'],
    },
  );

  readonly recent = computed(() => this.analyticsResource.value() ?? []);
  readonly analyticsError = computed(
    () => this.analyticsResource.error() !== null && this.analyticsResource.value() === null,
  );

  readonly sampleLabel = computed(() => {
    const n = this.recent().length;
    const total = this.logTotal();
    const base = `Roll-ups below cover the latest ${n.toLocaleString('en-US')} fills`;
    return total !== null && total > n
      ? `${base} of ${total.toLocaleString('en-US')} logged — not the whole history.`
      : `${base}.`;
  });

  /**
   * Latency telemetry is absent when every row reports 0 ms. Averaging those
   * zeros and painting them green claimed instant fills; instead every latency
   * figure says "not recorded" and the latency charts stay off the page.
   */
  readonly latencyRecorded = computed(() => this.recent().some((r) => r.submitToFillMs > 0));

  latencyTone(ms: number | null | undefined): Tone {
    if (!this.latencyRecorded() || ms == null || !Number.isFinite(ms) || ms <= 0) return '';
    if (ms > BAD_LATENCY_MS) return 'bad';
    if (ms < GOOD_LATENCY_MS) return 'good';
    return '';
  }

  /** Threshold-based: 100 % is the norm; either side of it is a problem. */
  fillRateTone(rate: number | null | undefined): Tone {
    if (rate == null || !Number.isFinite(rate)) return '';
    if (rate > 1.0005) return 'bad';
    if (rate < 0.95) return 'bad';
    if (rate < 0.995) return 'warn';
    return '';
  }

  readonly avgSlippage = computed(() => {
    const rows = this.recent();
    if (rows.length === 0) return 0;
    return rows.reduce((s, r) => s + r.slippagePips, 0) / rows.length;
  });

  readonly avgLatency = computed(() => {
    const rows = this.recent();
    if (rows.length === 0) return 0;
    return rows.reduce((s, r) => s + r.submitToFillMs, 0) / rows.length;
  });

  readonly partialCount = computed(() => this.recent().filter((r) => r.wasPartialFill).length);

  readonly maxSlippage = computed(() => {
    const rows = this.recent();
    if (rows.length === 0) return 0;
    return Math.max(...rows.map((r) => r.slippagePips));
  });
  readonly minSlippage = computed(() => {
    const rows = this.recent();
    if (rows.length === 0) return 0;
    return Math.min(...rows.map((r) => r.slippagePips));
  });
  readonly p50Slippage = computed(() =>
    percentile(
      this.recent().map((r) => r.slippagePips),
      50,
    ),
  );
  readonly p95Slippage = computed(() =>
    percentile(
      this.recent().map((r) => r.slippagePips),
      95,
    ),
  );
  readonly p95Latency = computed(() =>
    percentile(
      this.recent().map((r) => r.submitToFillMs),
      95,
    ),
  );
  readonly avgFillRate = computed(() => {
    const rows = this.recent();
    if (rows.length === 0) return 0;
    return rows.reduce((s, r) => s + r.fillRate, 0) / rows.length;
  });
  readonly partialPct = computed(() => {
    const rows = this.recent();
    if (rows.length === 0) return 0;
    return (rows.filter((r) => r.wasPartialFill).length / rows.length) * 100;
  });

  // ── Per-symbol breakdown ────────────────────────────────────────────
  readonly perSymbolBreakdown = computed(() => {
    type Row = {
      symbol: string;
      fills: number;
      avgSlippage: number;
      maxSlippage: number;
      avgLatency: number;
      p95Latency: number;
      partialPct: number;
    };
    const groups: Record<
      string,
      { slip: number[]; lat: number[]; partials: number; fills: number }
    > = {};
    for (const r of this.recent()) {
      const k = r.symbol ?? 'unknown';
      if (!groups[k]) groups[k] = { slip: [], lat: [], partials: 0, fills: 0 };
      const g = groups[k];
      g.fills++;
      g.slip.push(r.slippagePips);
      g.lat.push(r.submitToFillMs);
      if (r.wasPartialFill) g.partials++;
    }
    const out: Row[] = [];
    for (const [symbol, g] of Object.entries(groups)) {
      out.push({
        symbol,
        fills: g.fills,
        avgSlippage: g.slip.reduce((a, b) => a + b, 0) / g.slip.length,
        maxSlippage: Math.max(...g.slip),
        avgLatency: g.lat.reduce((a, b) => a + b, 0) / g.lat.length,
        p95Latency: percentile(g.lat, 95),
        partialPct: (g.partials / g.fills) * 100,
      });
    }
    return out.sort((a, b) => b.fills - a.fills);
  });

  // ── Per-session breakdown ───────────────────────────────────────────
  readonly perSessionBreakdown = computed(() => {
    type Row = {
      session: string;
      fills: number;
      avgSlippage: number;
      avgLatency: number;
      partialPct: number;
    };
    const groups: Record<
      string,
      { slip: number[]; lat: number[]; partials: number; fills: number }
    > = {};
    for (const r of this.recent()) {
      const k = String(r.session ?? 'Off-hours');
      if (!groups[k]) groups[k] = { slip: [], lat: [], partials: 0, fills: 0 };
      const g = groups[k];
      g.fills++;
      g.slip.push(r.slippagePips);
      g.lat.push(r.submitToFillMs);
      if (r.wasPartialFill) g.partials++;
    }
    const out: Row[] = [];
    for (const [session, g] of Object.entries(groups)) {
      out.push({
        session,
        fills: g.fills,
        avgSlippage: g.slip.reduce((a, b) => a + b, 0) / g.slip.length,
        avgLatency: g.lat.reduce((a, b) => a + b, 0) / g.lat.length,
        partialPct: (g.partials / g.fills) * 100,
      });
    }
    return out.sort((a, b) => b.fills - a.fills);
  });

  readonly sessionChartSubtitle = computed(() => {
    const rows = this.perSessionBreakdown();
    if (rows.length === 1) return `Every fill in the sample is tagged ${rows[0].session}`;
    return 'Average pips per trading session, as tagged by the engine';
  });

  /**
   * Top 10 fills by adverse behaviour. Only slippage AGAINST the order counts:
   * a −0.70 pip fill is a price improvement and used to rank #1 "worst" because
   * the score took |slippage|. Latency joins the score only when it is recorded.
   */
  readonly worstOffenders = computed(() => {
    const rows = this.recent();
    if (rows.length === 0) return [];
    const withLatency = this.latencyRecorded();
    const maxAdverse = Math.max(...rows.map((r) => Math.max(0, r.slippagePips)));
    const maxLat = Math.max(1, Math.max(...rows.map((r) => r.submitToFillMs)));
    return rows
      .map((r) => {
        const adverse = Math.max(0, r.slippagePips);
        const slipScore = maxAdverse > 0 ? adverse / maxAdverse : 0;
        const latScore = withLatency ? r.submitToFillMs / maxLat : 0;
        return { ...r, _score: slipScore + latScore };
      })
      .filter((r) => r._score > 0)
      .sort((a, b) => b._score - a._score)
      .slice(0, 10);
  });

  // ── Charts ──────────────────────────────────────────────────────────
  private sessionBar(
    values: { session: string; value: number }[],
    unit: 'pips' | 'ms',
  ): EChartsOption {
    if (values.length === 0) return emptyChart('No fills in the sample');
    const allZero = values.every((v) => v.value === 0);
    return {
      tooltip: {
        trigger: 'axis',
        valueFormatter: (v) => (unit === 'pips' ? fmtPips(Number(v)) : fmtMs(Number(v))),
      },
      grid: { top: 28, right: 16, bottom: 32, left: 56 },
      xAxis: {
        type: 'category',
        data: values.map((r) => r.session),
        axisLabel: { fontSize: 10 },
      },
      yAxis: {
        type: 'value',
        name: unit === 'pips' ? 'Pips' : 'ms',
        nameTextStyle: { fontSize: 10, align: 'right' },
        nameGap: 10,
        // A lone zero bar should not conjure a 0–1 axis.
        max: allZero ? 1 : undefined,
        axisLabel: { fontSize: 10 },
      },
      series: [
        {
          type: 'bar',
          data: values.map((r) => ({
            value: +r.value.toFixed(unit === 'pips' ? 2 : 0),
            itemStyle: {
              color:
                unit === 'pips'
                  ? r.value > BAD_SLIPPAGE_PIPS
                    ? '#FF3B30'
                    : r.value < 0
                      ? '#34C759'
                      : '#0071E3'
                  : r.value > BAD_LATENCY_MS
                    ? '#FF3B30'
                    : '#5AC8FA',
              borderRadius: [4, 4, 0, 0],
            },
          })),
          barMaxWidth: 48,
          label: {
            show: true,
            position: 'top',
            fontSize: 10,
            formatter: ((p: { value: number }) =>
              unit === 'pips' ? fmtPips(p.value) : fmtMs(p.value)) as never,
          },
        },
      ],
    };
  }

  readonly slippageBySession = computed<EChartsOption>(() =>
    this.sessionBar(
      this.perSessionBreakdown().map((r) => ({ session: r.session, value: r.avgSlippage })),
      'pips',
    ),
  );

  readonly latencyBySession = computed<EChartsOption>(() =>
    this.sessionBar(
      this.perSessionBreakdown().map((r) => ({ session: r.session, value: r.avgLatency })),
      'ms',
    ),
  );

  readonly fillRateHistogram = computed<EChartsOption>(() =>
    histogramChart(
      this.recent().map((r) => r.fillRate * 100),
      10,
      'Fill rate (%)',
    ),
  );

  readonly slippageHistogram = computed<EChartsOption>(() =>
    histogramChart(
      this.recent().map((r) => r.slippagePips),
      16,
      'Slippage (pips)',
    ),
  );
  readonly latencyHistogram = computed<EChartsOption>(() =>
    histogramChart(
      this.recent().map((r) => r.submitToFillMs),
      16,
      'Latency (ms)',
    ),
  );

  readonly scatterChart = computed<EChartsOption>(() => ({
    tooltip: {
      trigger: 'item',
      formatter: ((params: unknown) => {
        const p = params as { value?: [number, number] };
        return p.value ? `Latency: ${fmtMs(p.value[0])}<br/>Slippage: ${fmtPips(p.value[1])}` : '';
      }) as never,
    },
    xAxis: {
      type: 'value',
      name: 'Latency (ms)',
      nameLocation: 'middle',
      nameGap: 26,
      nameTextStyle: { fontSize: 10 },
      axisLabel: { fontSize: 10 },
    },
    yAxis: {
      type: 'value',
      name: 'Slippage (pips)',
      nameTextStyle: { fontSize: 10, align: 'left' },
      nameGap: 10,
      axisLabel: { fontSize: 10 },
    },
    grid: { left: 56, right: 20, bottom: 44, top: 32 },
    series: [
      {
        type: 'scatter',
        symbolSize: 7,
        data: this.recent().map((r) => [r.submitToFillMs, r.slippagePips]),
        itemStyle: { color: '#0071E3' },
      },
    ],
  }));

  private readonly symbolRows = computed(() => {
    const groups = new Map<string, number[]>();
    for (const r of this.recent()) {
      if (!r.symbol) continue;
      const arr = groups.get(r.symbol) ?? [];
      arr.push(r.slippagePips);
      groups.set(r.symbol, arr);
    }
    return Array.from(groups.entries())
      .map(([s, v]) => ({ symbol: s, avg: v.reduce((a, b) => a + b, 0) / v.length }))
      .sort((a, b) => b.avg - a.avg);
  });

  /** Enough vertical room for one readable bar per symbol. */
  readonly symbolChartHeight = computed(
    () => `${Math.max(280, 60 + 22 * this.symbolRows().length)}px`,
  );

  readonly slippageBySymbol = computed<EChartsOption>(() => {
    const sorted = this.symbolRows();
    if (sorted.length === 0) return emptyChart('No fills in the sample');
    return {
      tooltip: { trigger: 'axis', valueFormatter: (v) => fmtPips(Number(v)) },
      grid: { left: 80, right: 24, top: 12, bottom: 40 },
      xAxis: {
        type: 'value',
        name: 'Avg slippage (pips)',
        nameLocation: 'middle',
        nameGap: 24,
        nameTextStyle: { fontSize: 10 },
        axisLabel: { fontSize: 10 },
      },
      yAxis: {
        type: 'category',
        inverse: true,
        data: sorted.map((d) => d.symbol),
        axisLabel: { fontSize: 10 },
      },
      series: [
        {
          type: 'bar',
          data: sorted.map((d) => ({
            value: +d.avg.toFixed(2),
            itemStyle: {
              color: d.avg > BAD_SLIPPAGE_PIPS ? '#FF3B30' : d.avg < 0 ? '#34C759' : '#0071E3',
            },
          })),
          barMaxWidth: 16,
        },
      ],
    };
  });
}

function percentile(values: number[], pct: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((pct / 100) * sorted.length));
  return sorted[idx];
}

function emptyPager() {
  return {
    totalItemCount: 0,
    filter: null,
    currentPage: 1,
    itemCountPerPage: 25,
    pageNo: 1,
    pageSize: 25,
  };
}

function emptyChart(text: string): EChartsOption {
  return {
    title: {
      text,
      left: 'center',
      top: 'center',
      textStyle: { color: '#8E8E93', fontSize: 12, fontWeight: 'normal' as const },
    },
  };
}

/** Bucket boundary label — `(-0.04).toFixed(1)` would print "-0.0". */
function tickLabel(v: number): string {
  const rounded = Number(v.toFixed(1));
  return (Object.is(rounded, -0) ? 0 : rounded).toFixed(1);
}

function histogramChart(values: number[], bins: number, label: string): EChartsOption {
  if (values.length === 0) return emptyChart('No fills in the sample');
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) {
    return emptyChart(`Every fill in the sample is ${tickLabel(min)} — nothing to distribute`);
  }
  const size = (max - min) / bins;
  const counts = new Array<number>(bins).fill(0);
  const labels: string[] = [];
  for (let i = 0; i < bins; i++) {
    labels.push(tickLabel(min + size * i));
  }
  for (const v of values) {
    let idx = Math.floor((v - min) / size);
    if (idx >= bins) idx = bins - 1;
    if (idx < 0) idx = 0;
    counts[idx]++;
  }
  return {
    tooltip: { trigger: 'axis' },
    grid: { left: 50, right: 20, top: 32, bottom: 50 },
    xAxis: {
      type: 'category',
      data: labels,
      name: label,
      nameLocation: 'middle',
      nameGap: 28,
      nameTextStyle: { fontSize: 10 },
      axisLabel: { fontSize: 10, hideOverlap: true },
    },
    yAxis: {
      type: 'value',
      name: 'Fills',
      nameTextStyle: { fontSize: 10, align: 'left' },
      nameGap: 10,
      minInterval: 1,
      axisLabel: { fontSize: 10 },
    },
    series: [
      {
        type: 'bar',
        data: counts,
        itemStyle: { color: '#0071E3' },
        barWidth: '90%',
      },
    ],
  };
}
