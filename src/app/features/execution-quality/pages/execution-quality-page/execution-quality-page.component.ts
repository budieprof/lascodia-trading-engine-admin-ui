import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { catchError, map, Observable, of } from 'rxjs';
import type { ColDef } from 'ag-grid-community';
import type { EChartsOption } from 'echarts';

import { ExecutionQualityService } from '@core/services/execution-quality.service';
import type { ExecutionQualityLogDto, PagedData, PagerRequest } from '@core/api/api.types';
import { createPolledResource } from '@core/polling/polled-resource';

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
          <app-data-table
            [columnDefs]="columnDefs"
            [fetchData]="fetchExecutions"
            [searchable]="true"
          />
        }

        @if (activeTab() === 'analytics') {
          @if (recent().length > 0) {
            <div class="metrics-row">
              <app-metric-card
                label="Recent Executions"
                [value]="recent().length"
                format="number"
              />
              <app-metric-card label="Avg Slippage" [value]="avgSlippage()" format="number" />
              <app-metric-card
                label="Avg Fill Latency (ms)"
                [value]="avgLatency()"
                format="number"
              />
              <app-metric-card label="Partial Fills" [value]="partialCount()" format="number" />
            </div>

            <div class="charts-grid">
              <app-chart-card
                title="Slippage Distribution"
                subtitle="Histogram of slippage in pips across recent fills"
                [options]="slippageHistogram()"
                height="340px"
              />
              <app-chart-card
                title="Fill Latency Distribution"
                subtitle="Submit-to-fill milliseconds"
                [options]="latencyHistogram()"
                height="340px"
              />
            </div>

            <div class="charts-grid">
              <app-chart-card
                title="Slippage vs Latency"
                subtitle="Per-fill scatter"
                [options]="scatterChart()"
                height="340px"
              />
              <app-chart-card
                title="Slippage by Symbol"
                subtitle="Average slippage per symbol (last 200 fills)"
                [options]="slippageBySymbol()"
                height="340px"
              />
            </div>
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
    `,
  ],
})
export class ExecutionQualityPageComponent {
  private readonly service = inject(ExecutionQualityService);

  readonly tabs: TabItem[] = [
    { label: 'Execution Log', value: 'log' },
    { label: 'Analytics', value: 'analytics' },
  ];
  readonly activeTab = signal('log');

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
