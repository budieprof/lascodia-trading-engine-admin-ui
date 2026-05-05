import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { catchError, map, Observable, of, throttleTime } from 'rxjs';
import type { ColDef } from 'ag-grid-community';
import type { EChartsOption } from 'echarts';

import { ExecutionQualityService } from '@core/services/execution-quality.service';
import type { ExecutionQualityLogDto, PagedData, PagerRequest } from '@core/api/api.types';
import { createPolledResource } from '@core/polling/polled-resource';
import { RealtimeService } from '@core/realtime/realtime.service';

import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { TabsComponent, TabItem } from '@shared/components/ui/tabs/tabs.component';
import { DataTableComponent } from '@shared/components/data-table/data-table.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';

@Component({
  selector: 'app-execution-quality-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    MetricCardComponent,
    ChartCardComponent,
    PageHeaderComponent,
    TabsComponent,
    DataTableComponent,
    EmptyStateComponent,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Execution Quality"
        subtitle="Slippage, fill latency, and TCA from recent executions"
      />

      <ui-tabs [tabs]="tabs" [(activeTab)]="activeTab">
        @if (activeTab() === 'log') {
          <!-- 8-card KPI strip — recent executions roll-ups -->
          <div class="eq-kpis">
            <div class="eq-kpi">
              <span class="kpi-label">Total fills</span>
              <span class="kpi-value">{{ recent().length }}</span>
            </div>
            <div class="eq-kpi">
              <span class="kpi-label">Avg slippage</span>
              <span
                class="kpi-value"
                [class.bad]="avgSlippage() > 1"
                [class.good]="avgSlippage() < 0"
              >
                {{ formatNumber(avgSlippage(), 2) }}p
              </span>
            </div>
            <div class="eq-kpi">
              <span class="kpi-label">Worst slippage</span>
              <span
                class="kpi-value"
                [class.bad]="maxSlippage() > 1"
                [class.good]="maxSlippage() <= 0"
              >
                {{ formatNumber(maxSlippage(), 2) }}p
              </span>
            </div>
            <div class="eq-kpi">
              <span class="kpi-label">Best slippage</span>
              <span class="kpi-value good">{{ formatNumber(minSlippage(), 2) }}p</span>
            </div>
            <div class="eq-kpi">
              <span class="kpi-label">Avg latency</span>
              <span
                class="kpi-value"
                [class.bad]="avgLatency() > 500"
                [class.good]="avgLatency() < 100"
              >
                {{ formatNumber(avgLatency(), 0) }}ms
              </span>
            </div>
            <div class="eq-kpi">
              <span class="kpi-label">P95 latency</span>
              <span class="kpi-value" [class.bad]="p95Latency() > 1000">
                {{ formatNumber(p95Latency(), 0) }}ms
              </span>
            </div>
            <div class="eq-kpi">
              <span class="kpi-label">Partial fills</span>
              <span
                class="kpi-value"
                [class.bad]="partialCount() > 0"
                [class.good]="partialCount() === 0"
              >
                {{ partialCount() }}
              </span>
            </div>
            <div class="eq-kpi">
              <span class="kpi-label">Symbols traded</span>
              <span class="kpi-value">{{ symbolsTraded() }}</span>
            </div>
          </div>

          <section class="eq-board">
            <header class="eq-board-head">
              <h3>Execution log</h3>
              <span class="muted">Server-paged · click any row for raw payload</span>
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
            <!-- 8-card KPI strip — analytics roll-ups -->
            <div class="eq-kpis">
              <div class="eq-kpi">
                <span class="kpi-label">Recent fills</span>
                <span class="kpi-value">{{ recent().length }}</span>
              </div>
              <div class="eq-kpi">
                <span class="kpi-label">Avg slippage</span>
                <span
                  class="kpi-value"
                  [class.bad]="avgSlippage() > 1"
                  [class.good]="avgSlippage() < 0"
                >
                  {{ formatNumber(avgSlippage(), 2) }}p
                </span>
              </div>
              <div class="eq-kpi">
                <span class="kpi-label">P50 slippage</span>
                <span class="kpi-value">{{ formatNumber(p50Slippage(), 2) }}p</span>
              </div>
              <div class="eq-kpi">
                <span class="kpi-label">P95 slippage</span>
                <span class="kpi-value bad">{{ formatNumber(p95Slippage(), 2) }}p</span>
              </div>
              <div class="eq-kpi">
                <span class="kpi-label">Avg latency</span>
                <span
                  class="kpi-value"
                  [class.bad]="avgLatency() > 500"
                  [class.good]="avgLatency() < 100"
                >
                  {{ formatNumber(avgLatency(), 0) }}ms
                </span>
              </div>
              <div class="eq-kpi">
                <span class="kpi-label">P95 latency</span>
                <span class="kpi-value" [class.bad]="p95Latency() > 1000">
                  {{ formatNumber(p95Latency(), 0) }}ms
                </span>
              </div>
              <div class="eq-kpi">
                <span class="kpi-label">Avg fill rate</span>
                <span class="kpi-value">{{ formatNumber(avgFillRate() * 100, 1) }}%</span>
              </div>
              <div class="eq-kpi">
                <span class="kpi-label">Partial %</span>
                <span
                  class="kpi-value"
                  [class.bad]="partialPct() > 10"
                  [class.good]="partialPct() === 0"
                >
                  {{ formatNumber(partialPct(), 1) }}%
                </span>
              </div>
            </div>

            <!-- Existing 2x2 charts -->
            <div class="charts-grid">
              <app-chart-card
                title="Slippage Distribution"
                subtitle="Histogram of slippage in pips across recent fills"
                [options]="slippageHistogram()"
                height="280px"
              />
              <app-chart-card
                title="Fill Latency Distribution"
                subtitle="Submit-to-fill milliseconds"
                [options]="latencyHistogram()"
                height="280px"
              />
            </div>

            <div class="charts-grid">
              <app-chart-card
                title="Slippage vs Latency"
                subtitle="Per-fill scatter — top-right quadrant is the danger zone"
                [options]="scatterChart()"
                height="280px"
              />
              <app-chart-card
                title="Slippage by Symbol"
                subtitle="Average slippage per symbol (last 200 fills)"
                [options]="slippageBySymbol()"
                height="280px"
              />
            </div>

            <!-- 3-col row: by session + fill rate distribution + slippage by strategy -->
            <div class="eq-charts">
              <app-chart-card
                title="Slippage by session"
                subtitle="Asia / London / New York — when does spread bite hardest?"
                [options]="slippageBySession()"
                height="240px"
              />
              <app-chart-card
                title="Latency by session"
                subtitle="Average submit-to-fill ms per trading session"
                [options]="latencyBySession()"
                height="240px"
              />
              <app-chart-card
                title="Fill-rate distribution"
                subtitle="Histogram of order fill ratios"
                [options]="fillRateHistogram()"
                height="240px"
              />
            </div>

            <!-- 2-col tables: per-symbol breakdown + per-session breakdown -->
            <div class="eq-board-row">
              <section class="eq-board">
                <header class="eq-board-head">
                  <h3>Per-symbol breakdown</h3>
                  <span class="muted">Aggregated over the recent 200 fills</span>
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
                          <th class="num">Avg lat (ms)</th>
                          <th class="num">P95 lat</th>
                          <th class="num">Partial %</th>
                        </tr>
                      </thead>
                      <tbody>
                        @for (row of perSymbolBreakdown(); track row.symbol) {
                          <tr>
                            <td class="mono">{{ row.symbol }}</td>
                            <td class="num mono">{{ row.fills }}</td>
                            <td
                              class="num mono"
                              [class.bad]="row.avgSlippage > 1"
                              [class.good]="row.avgSlippage < 0"
                            >
                              {{ row.avgSlippage.toFixed(2) }}p
                            </td>
                            <td class="num mono bad">{{ row.maxSlippage.toFixed(2) }}p</td>
                            <td class="num mono">{{ row.avgLatency.toFixed(0) }}</td>
                            <td class="num mono" [class.bad]="row.p95Latency > 1000">
                              {{ row.p95Latency.toFixed(0) }}
                            </td>
                            <td class="num mono" [class.bad]="row.partialPct > 10">
                              {{ row.partialPct.toFixed(1) }}%
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
                  <span class="muted">Asia / London / New York / off-hours</span>
                </header>
                @if (perSessionBreakdown().length > 0) {
                  <table class="eq-board-table">
                    <thead>
                      <tr>
                        <th>Session</th>
                        <th class="num">Fills</th>
                        <th class="num">Avg slip</th>
                        <th class="num">Avg lat</th>
                        <th class="num">Partial %</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (row of perSessionBreakdown(); track row.session) {
                        <tr>
                          <td class="mono">{{ row.session }}</td>
                          <td class="num mono">{{ row.fills }}</td>
                          <td
                            class="num mono"
                            [class.bad]="row.avgSlippage > 1"
                            [class.good]="row.avgSlippage < 0"
                          >
                            {{ row.avgSlippage.toFixed(2) }}p
                          </td>
                          <td class="num mono">{{ row.avgLatency.toFixed(0) }}ms</td>
                          <td class="num mono" [class.bad]="row.partialPct > 10">
                            {{ row.partialPct.toFixed(1) }}%
                          </td>
                        </tr>
                      }
                    </tbody>
                  </table>
                }
              </section>
            </div>

            <!-- Worst offenders table — fills with the worst tail behavior -->
            <section class="eq-board">
              <header class="eq-board-head">
                <h3>Worst offenders</h3>
                <span class="muted">
                  Top 10 fills by combined badness score (slippage + latency penalties)
                </span>
              </header>
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
                      <td
                        class="num mono"
                        [class.bad]="r.slippagePips > 1"
                        [class.good]="r.slippagePips < 0"
                      >
                        {{ r.slippagePips.toFixed(2) }}p
                      </td>
                      <td class="num mono" [class.bad]="r.submitToFillMs > 1000">
                        {{ r.submitToFillMs }}ms
                      </td>
                      <td class="num mono">{{ (r.fillRate * 100).toFixed(1) }}%</td>
                      <td>
                        <span class="eq-pill" [class.warn]="r.wasPartialFill">
                          {{ r.wasPartialFill ? 'Partial' : 'Full' }}
                        </span>
                      </td>
                      <td class="mono">
                        {{ r.recordedAt ? r.recordedAt.slice(0, 16).replace('T', ' ') : '—' }}
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </section>
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
      .metrics-row {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: var(--space-4);
        margin-bottom: var(--space-6);
      }
      .charts-grid {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: var(--space-4);
        margin-bottom: var(--space-6);
      }
      @media (max-width: 1024px) {
        .charts-grid {
          grid-template-columns: 1fr;
        }
        .metrics-row {
          grid-template-columns: repeat(2, 1fr);
        }
      }

      /* Execution Quality density additions */
      .eq-kpis {
        display: grid;
        grid-template-columns: repeat(8, 1fr);
        gap: var(--space-2);
        margin-bottom: var(--space-3);
      }
      @media (max-width: 1400px) {
        .eq-kpis {
          grid-template-columns: repeat(4, 1fr);
        }
      }
      @media (max-width: 720px) {
        .eq-kpis {
          grid-template-columns: repeat(2, 1fr);
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
      }
      .eq-kpi .kpi-label {
        font-size: 10px;
        font-weight: var(--font-semibold);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .eq-kpi .kpi-value {
        font-size: var(--text-xl);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
        font-variant-numeric: tabular-nums;
      }
      .eq-kpi .kpi-value.good {
        color: var(--profit);
      }
      .eq-kpi .kpi-value.bad {
        color: var(--loss);
      }

      .eq-charts {
        display: grid;
        grid-template-columns: 1fr 1fr 1fr;
        gap: var(--space-3);
        margin-bottom: var(--space-3);
      }
      @media (max-width: 1100px) {
        .eq-charts {
          grid-template-columns: 1fr;
        }
      }

      .eq-board-row {
        display: grid;
        grid-template-columns: 1.6fr 1fr;
        gap: var(--space-3);
        margin-bottom: var(--space-3);
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
      }
      .eq-board-head .muted {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
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
        background: rgba(52, 199, 89, 0.14);
        color: #248a3d;
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
  private readonly realtime = inject(RealtimeService);

  private readonly executionsTable =
    viewChild<DataTableComponent<ExecutionQualityLogDto>>('executionsTable');

  readonly tabs: TabItem[] = [
    { label: 'Execution Log', value: 'log' },
    { label: 'Analytics', value: 'analytics' },
  ];
  readonly activeTab = signal('log');

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
  }

  readonly columnDefs: ColDef<ExecutionQualityLogDto>[] = [
    { headerName: 'Order', field: 'orderId', width: 110 },
    { headerName: 'Symbol', field: 'symbol', width: 110 },
    { headerName: 'Strategy', field: 'strategyId', width: 110 },
    { headerName: 'Session', field: 'session', width: 130 },
    {
      headerName: 'Requested',
      field: 'requestedPrice',
      width: 120,
      valueFormatter: (p) => (p.value as number)?.toFixed(5) ?? '-',
    },
    {
      headerName: 'Filled',
      field: 'filledPrice',
      width: 120,
      valueFormatter: (p) => (p.value as number)?.toFixed(5) ?? '-',
    },
    {
      headerName: 'Slippage (pips)',
      field: 'slippagePips',
      width: 140,
      valueFormatter: (p) => (p.value as number)?.toFixed(2) ?? '-',
      cellStyle: (p) => {
        const v = p.value as number;
        if (v == null) return null;
        if (v > 1) return { color: '#D70015', fontWeight: 600 };
        if (v < -0.5) return { color: '#248A3D', fontWeight: 600 };
        return null;
      },
    },
    { headerName: 'Latency (ms)', field: 'submitToFillMs', width: 130 },
    {
      headerName: 'Fill %',
      field: 'fillRate',
      width: 100,
      valueFormatter: (p) => (p.value != null ? `${((p.value as number) * 100).toFixed(1)}%` : '-'),
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

  private readonly analyticsResource = createPolledResource(
    () =>
      this.service.list({ currentPage: 1, itemCountPerPage: 200 }).pipe(
        map((r) => r.data?.data ?? []),
        catchError(() => of([] as ExecutionQualityLogDto[])),
      ),
    { intervalMs: 60_000 },
  );

  readonly recent = computed(() => this.analyticsResource.value() ?? []);

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

  // ── Extra summary stats ─────────────────────────────────────────────
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
  readonly symbolsTraded = computed(() => {
    const set = new Set<string>();
    for (const r of this.recent()) if (r.symbol) set.add(r.symbol);
    return set.size;
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
      {
        slip: number[];
        lat: number[];
        partials: number;
        fills: number;
      }
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

  // Top 10 fills by combined "badness" — high slippage + high latency.
  // Normalised to the recent window so a small sample doesn't auto-flag fills
  // that are average for the period.
  readonly worstOffenders = computed(() => {
    const rows = this.recent();
    if (rows.length === 0) return [];
    const maxSlip = Math.max(1, Math.max(...rows.map((r) => Math.abs(r.slippagePips))));
    const maxLat = Math.max(1, Math.max(...rows.map((r) => r.submitToFillMs)));
    return [...rows]
      .map((r) => ({
        ...r,
        _score: Math.abs(r.slippagePips) / maxSlip + r.submitToFillMs / maxLat,
      }))
      .sort((a, b) => b._score - a._score)
      .slice(0, 10);
  });

  // ── New charts ──────────────────────────────────────────────────────
  readonly slippageBySession = computed<EChartsOption>(() => {
    const rows = this.perSessionBreakdown();
    if (rows.length === 0) return {};
    return {
      tooltip: { trigger: 'axis' },
      grid: { top: 10, right: 30, bottom: 30, left: 50 },
      xAxis: {
        type: 'category',
        data: rows.map((r) => r.session),
        axisLabel: { fontSize: 10, color: '#6E6E73' },
      },
      yAxis: {
        type: 'value',
        name: 'Pips',
        axisLabel: { fontSize: 10, color: '#6E6E73' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      series: [
        {
          type: 'bar',
          data: rows.map((r) => ({
            value: +r.avgSlippage.toFixed(2),
            itemStyle: {
              color: r.avgSlippage > 1 ? '#FF3B30' : r.avgSlippage < 0 ? '#34C759' : '#0071E3',
              borderRadius: [4, 4, 0, 0],
            },
          })),
          barWidth: '55%',
          label: { show: true, position: 'top', fontSize: 10, color: '#6E6E73' },
        },
      ],
    };
  });

  readonly latencyBySession = computed<EChartsOption>(() => {
    const rows = this.perSessionBreakdown();
    if (rows.length === 0) return {};
    return {
      tooltip: { trigger: 'axis' },
      grid: { top: 10, right: 30, bottom: 30, left: 50 },
      xAxis: {
        type: 'category',
        data: rows.map((r) => r.session),
        axisLabel: { fontSize: 10, color: '#6E6E73' },
      },
      yAxis: {
        type: 'value',
        name: 'ms',
        axisLabel: { fontSize: 10, color: '#6E6E73' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      series: [
        {
          type: 'bar',
          data: rows.map((r) => ({
            value: +r.avgLatency.toFixed(0),
            itemStyle: {
              color: r.avgLatency > 500 ? '#FF3B30' : r.avgLatency < 100 ? '#34C759' : '#5AC8FA',
              borderRadius: [4, 4, 0, 0],
            },
          })),
          barWidth: '55%',
          label: { show: true, position: 'top', fontSize: 10, color: '#6E6E73' },
        },
      ],
    };
  });

  readonly fillRateHistogram = computed<EChartsOption>(() =>
    histogramChart(
      this.recent().map((r) => r.fillRate * 100),
      10,
      'Fill rate (%)',
    ),
  );

  formatNumber(v: number | null | undefined, digits = 2): string {
    if (v == null || !Number.isFinite(v)) return '—';
    return v.toFixed(digits);
  }

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
        return p.value ? `Latency: ${p.value[0]}ms<br/>Slippage: ${p.value[1]}p` : '';
      }) as never,
    },
    xAxis: { type: 'value', name: 'Latency (ms)' },
    yAxis: { type: 'value', name: 'Slippage (pips)' },
    grid: { left: 60, right: 20, bottom: 40, top: 20 },
    series: [
      {
        type: 'scatter',
        symbolSize: 7,
        data: this.recent().map((r) => [r.submitToFillMs, r.slippagePips]),
        itemStyle: { color: '#0071E3' },
      },
    ],
  }));

  readonly slippageBySymbol = computed<EChartsOption>(() => {
    const rows = this.recent();
    const groups = new Map<string, number[]>();
    for (const r of rows) {
      if (!r.symbol) continue;
      const arr = groups.get(r.symbol) ?? [];
      arr.push(r.slippagePips);
      groups.set(r.symbol, arr);
    }
    const sorted = Array.from(groups.entries())
      .map(([s, v]) => ({
        symbol: s,
        avg: v.reduce((a, b) => a + b, 0) / v.length,
      }))
      .sort((a, b) => b.avg - a.avg);
    return {
      tooltip: { trigger: 'axis' },
      grid: { left: 80, right: 20, top: 20, bottom: 40 },
      xAxis: { type: 'value', name: 'Pips' },
      yAxis: { type: 'category', data: sorted.map((d) => d.symbol) },
      series: [
        {
          type: 'bar',
          data: sorted.map((d) => ({
            value: +d.avg.toFixed(2),
            itemStyle: { color: d.avg > 1 ? '#FF3B30' : d.avg < 0 ? '#34C759' : '#0071E3' },
          })),
          barWidth: '65%',
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

function histogramChart(values: number[], bins: number, label: string): EChartsOption {
  if (values.length === 0) {
    return {
      title: {
        text: 'No data',
        left: 'center',
        top: 'center',
        textStyle: { color: '#8E8E93', fontSize: 14, fontWeight: 'normal' as const },
      },
    };
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) {
    return {
      title: {
        text: `All values = ${min.toFixed(2)}`,
        left: 'center',
        top: 'center',
        textStyle: { color: '#8E8E93', fontSize: 14, fontWeight: 'normal' as const },
      },
    };
  }
  const size = (max - min) / bins;
  const counts = new Array<number>(bins).fill(0);
  const labels: string[] = [];
  for (let i = 0; i < bins; i++) {
    labels.push((min + size * i).toFixed(1));
  }
  for (const v of values) {
    let idx = Math.floor((v - min) / size);
    if (idx >= bins) idx = bins - 1;
    if (idx < 0) idx = 0;
    counts[idx]++;
  }
  return {
    tooltip: { trigger: 'axis' },
    grid: { left: 50, right: 20, top: 20, bottom: 50 },
    xAxis: {
      type: 'category',
      data: labels,
      name: label,
      nameLocation: 'middle',
      nameGap: 28,
      axisLabel: { fontSize: 10 },
    },
    yAxis: { type: 'value', name: 'Count' },
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
