import {
  Component,
  ChangeDetectionStrategy,
  inject,
  signal,
  computed,
  OnInit,
  OnDestroy,
  ViewChild,
} from '@angular/core';
import { map, Observable } from 'rxjs';
import type { ColDef } from 'ag-grid-community';
import type { EChartsOption } from 'echarts';

import { PositionsService } from '@core/services/positions.service';
import type { PositionDto, PagedData, PagerRequest } from '@core/api/api.types';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { DataTableComponent } from '@shared/components/data-table/data-table.component';
import { StatusBadgeComponent } from '@shared/components/status-badge/status-badge.component';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import { TabsComponent, TabItem } from '@shared/components/ui/tabs/tabs.component';
import { CurrencyFormatPipe } from '@shared/pipes/currency-format.pipe';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';

@Component({
  selector: 'app-positions-page',
  standalone: true,
  imports: [
    PageHeaderComponent,
    MetricCardComponent,
    DataTableComponent,
    ChartCardComponent,
    TabsComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <app-page-header
        title="Positions"
        subtitle="Monitor open and closed trading positions"
      />

      <!-- Summary Strip -->
      <div class="metrics-strip">
        <app-metric-card
          label="Total Unrealized P&L"
          [value]="totalUnrealizedPnL()"
          format="currency"
          [colorByValue]="true"
        />
        <app-metric-card
          label="Open Position Count"
          [value]="openPositionCount()"
          format="number"
        />
        <app-metric-card
          label="Total Lots"
          [value]="totalLots()"
          format="number"
        />
      </div>

      <!-- Tabs -->
      <ui-tabs [tabs]="tabs" [(activeTab)]="activeTab">
        @switch (activeTab()) {
          @case ('open') {
            <app-data-table
              #openTable
              [columnDefs]="openColumnDefs"
              [fetchData]="fetchOpenPositions"
              [searchable]="true"
            />
          }
          @case ('closed') {
            <app-data-table
              [columnDefs]="closedColumnDefs"
              [fetchData]="fetchClosedPositions"
              [searchable]="true"
            />
          }
          @case ('analytics') {
            <div class="charts-grid">
              <app-chart-card
                title="P&L Distribution"
                subtitle="Histogram of realized P&L across closed positions"
                [options]="pnlDistributionChart()"
                [loading]="analyticsLoading()"
                height="300px"
              />
              <app-chart-card
                title="Win/Loss by Symbol"
                subtitle="Green wins vs red losses per instrument"
                [options]="winLossBySymbolChart()"
                [loading]="analyticsLoading()"
                height="300px"
              />
              <app-chart-card
                title="Hold Duration vs P&L"
                subtitle="Scatter of duration (hours) against P&L"
                [options]="holdDurationVsPnlChart()"
                [loading]="analyticsLoading()"
                height="300px"
              />
              <app-chart-card
                title="Cumulative P&L"
                subtitle="Running total of realized P&L over time"
                [options]="cumulativePnlChart()"
                [loading]="analyticsLoading()"
                height="300px"
              />
              <app-chart-card
                title="P&L by Session"
                subtitle="Performance grouped by trading session"
                [options]="pnlBySessionChart()"
                [loading]="analyticsLoading()"
                height="300px"
              />
              <app-chart-card
                title="R-Multiple Distribution"
                subtitle="Distribution of risk-reward multiples"
                [options]="rMultipleChart()"
                [loading]="analyticsLoading()"
                height="300px"
              />
            </div>
          }
        }
      </ui-tabs>
    </div>
  `,
  styles: [`
    .page {
      padding: var(--space-2) 0;
    }

    .metrics-strip {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: var(--space-4);
      margin-bottom: var(--space-6);
    }

    .charts-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: var(--space-4);
    }

    @media (max-width: 1024px) {
      .metrics-strip {
        grid-template-columns: 1fr;
      }
      .charts-grid {
        grid-template-columns: 1fr;
      }
    }
  `],
})
export class PositionsPageComponent implements OnInit, OnDestroy {
  private readonly positionsService = inject(PositionsService);
  private readonly currencyPipe = new CurrencyFormatPipe();
  private readonly relativeTimePipe = new RelativeTimePipe();
  private pollingInterval: ReturnType<typeof setInterval> | null = null;

  @ViewChild('openTable') openTable?: DataTableComponent<PositionDto>;

  // ── State ──
  readonly activeTab = signal('open');
  readonly openPositions = signal<PositionDto[]>([]);
  readonly closedPositions = signal<PositionDto[]>([]);
  readonly analyticsLoading = signal(true);

  // ── Tabs ──
  readonly tabs: TabItem[] = [
    { label: 'Open', value: 'open' },
    { label: 'Closed', value: 'closed' },
    { label: 'Analytics', value: 'analytics' },
  ];

  // ── Computed Metrics ──
  readonly totalUnrealizedPnL = computed(() =>
    this.openPositions().reduce((sum, p) => sum + p.unrealizedPnL, 0)
  );

  readonly openPositionCount = computed(() => this.openPositions().length);

  readonly totalLots = computed(() =>
    this.openPositions().reduce((sum, p) => sum + p.openLots, 0)
  );

  // ── Column Definitions ──
  readonly openColumnDefs: ColDef<PositionDto>[] = [
    { field: 'symbol', headerName: 'Symbol', minWidth: 110 },
    {
      field: 'direction',
      headerName: 'Direction',
      minWidth: 110,
      cellRenderer: (params: any) => {
        if (!params.value) return '';
        const isLong = params.value === 'Long';
        const color = isLong ? '#34C759' : '#FF3B30';
        const arrow = isLong ? '&#9650;' : '&#9660;';
        return `<span style="color:${color};font-weight:600">${arrow} ${params.value}</span>`;
      },
    },
    {
      field: 'averageEntryPrice',
      headerName: 'Entry Price',
      minWidth: 120,
      valueFormatter: (p: any) => this.currencyPipe.transform(p.value),
    },
    {
      field: 'currentPrice',
      headerName: 'Current Price',
      minWidth: 120,
      valueFormatter: (p: any) => this.currencyPipe.transform(p.value),
    },
    { field: 'openLots', headerName: 'Lots', minWidth: 80 },
    {
      field: 'unrealizedPnL',
      headerName: 'Unrealized P&L',
      minWidth: 140,
      cellRenderer: (params: any) => {
        if (params.value == null) return '-';
        const color = params.value >= 0 ? '#34C759' : '#FF3B30';
        const formatted = this.currencyPipe.transform(params.value);
        return `<span style="color:${color};font-weight:600">${formatted}</span>`;
      },
    },
    {
      field: 'stopLoss',
      headerName: 'SL',
      minWidth: 100,
      valueFormatter: (p: any) => p.value != null ? p.value.toFixed(5) : '-',
    },
    {
      field: 'takeProfit',
      headerName: 'TP',
      minWidth: 100,
      valueFormatter: (p: any) => p.value != null ? p.value.toFixed(5) : '-',
    },
    {
      field: 'openedAt',
      headerName: 'Duration',
      minWidth: 130,
      valueFormatter: (p: any) => this.relativeTimePipe.transform(p.value),
    },
    {
      field: 'status',
      headerName: 'Status',
      minWidth: 100,
      cellRenderer: (params: any) => {
        if (!params.value) return '';
        const variant = params.value === 'Open' ? 'info' : params.value === 'Closing' ? 'warning' : 'neutral';
        const colors: Record<string, { bg: string; color: string }> = {
          info: { bg: 'rgba(0,113,227,0.12)', color: '#0040DD' },
          warning: { bg: 'rgba(255,149,0,0.12)', color: '#C93400' },
          neutral: { bg: 'rgba(142,142,147,0.12)', color: '#636366' },
        };
        const s = colors[variant];
        return `<span style="display:inline-flex;align-items:center;padding:2px 10px;border-radius:9999px;font-size:12px;font-weight:600;background:${s.bg};color:${s.color}">${params.value}</span>`;
      },
    },
  ];

  readonly closedColumnDefs: ColDef<PositionDto>[] = [
    { field: 'symbol', headerName: 'Symbol', minWidth: 110 },
    {
      field: 'direction',
      headerName: 'Direction',
      minWidth: 110,
      cellRenderer: (params: any) => {
        if (!params.value) return '';
        const isLong = params.value === 'Long';
        const color = isLong ? '#34C759' : '#FF3B30';
        const arrow = isLong ? '&#9650;' : '&#9660;';
        return `<span style="color:${color};font-weight:600">${arrow} ${params.value}</span>`;
      },
    },
    {
      field: 'averageEntryPrice',
      headerName: 'Entry Price',
      minWidth: 120,
      valueFormatter: (p: any) => this.currencyPipe.transform(p.value),
    },
    {
      field: 'currentPrice',
      headerName: 'Exit Price',
      minWidth: 120,
      valueFormatter: (p: any) => this.currencyPipe.transform(p.value),
    },
    { field: 'openLots', headerName: 'Lots', minWidth: 80 },
    {
      field: 'realizedPnL',
      headerName: 'Realized P&L',
      minWidth: 140,
      cellRenderer: (params: any) => {
        if (params.value == null) return '-';
        const color = params.value >= 0 ? '#34C759' : '#FF3B30';
        const formatted = this.currencyPipe.transform(params.value);
        return `<span style="color:${color};font-weight:600">${formatted}</span>`;
      },
    },
    {
      headerName: 'Hold Duration',
      minWidth: 140,
      valueGetter: (params: any) => {
        const data = params.data as PositionDto;
        if (!data?.openedAt || !data?.closedAt) return '-';
        const ms = new Date(data.closedAt).getTime() - new Date(data.openedAt).getTime();
        const hours = Math.floor(ms / 3600000);
        const minutes = Math.floor((ms % 3600000) / 60000);
        if (hours > 24) {
          const days = Math.floor(hours / 24);
          return `${days}d ${hours % 24}h`;
        }
        return `${hours}h ${minutes}m`;
      },
    },
    {
      field: 'status',
      headerName: 'Status',
      minWidth: 100,
      cellRenderer: (params: any) => {
        if (!params.value) return '';
        const colors = { bg: 'rgba(142,142,147,0.12)', color: '#636366' };
        return `<span style="display:inline-flex;align-items:center;padding:2px 10px;border-radius:9999px;font-size:12px;font-weight:600;background:${colors.bg};color:${colors.color}">${params.value}</span>`;
      },
    },
  ];

  // ── Data Fetchers ──
  readonly fetchOpenPositions = (params: PagerRequest): Observable<PagedData<PositionDto>> => {
    return this.positionsService.list(params).pipe(
      map((response) => {
        const pagedData = response.data!;
        const openOnly = pagedData.data.filter((p) => p.status === 'Open' || p.status === 'Closing');
        this.openPositions.set(openOnly);
        return { ...pagedData, data: openOnly };
      })
    );
  };

  readonly fetchClosedPositions = (params: PagerRequest): Observable<PagedData<PositionDto>> => {
    return this.positionsService.list(params).pipe(
      map((response) => {
        const pagedData = response.data!;
        const closedOnly = pagedData.data.filter((p) => p.status === 'Closed');
        this.closedPositions.set(closedOnly);
        return { ...pagedData, data: closedOnly };
      })
    );
  };

  // ── Analytics Charts (computed from closed positions) ──

  readonly pnlDistributionChart = computed<EChartsOption>(() => {
    const positions = this.closedPositions();
    const pnls = positions.map((p) => p.realizedPnL);
    if (pnls.length === 0) return this.emptyChartOption('No data');

    const min = Math.min(...pnls);
    const max = Math.max(...pnls);
    const binCount = 12;
    const binSize = (max - min) / binCount || 1;
    const bins = Array(binCount).fill(0);
    const binLabels: string[] = [];

    for (let i = 0; i < binCount; i++) {
      const lo = min + i * binSize;
      binLabels.push(`$${lo.toFixed(0)}`);
    }

    pnls.forEach((v) => {
      let idx = Math.floor((v - min) / binSize);
      if (idx >= binCount) idx = binCount - 1;
      if (idx < 0) idx = 0;
      bins[idx]++;
    });

    const colors = binLabels.map((_, i) => {
      const midVal = min + (i + 0.5) * binSize;
      return midVal >= 0 ? '#34C759' : '#FF3B30';
    });

    return {
      tooltip: { trigger: 'axis' },
      xAxis: { type: 'category', data: binLabels, axisLabel: { fontSize: 10 } },
      yAxis: { type: 'value', name: 'Count' },
      series: [{
        type: 'bar',
        data: bins.map((val, i) => ({ value: val, itemStyle: { color: colors[i] } })),
        barWidth: '80%',
      }],
      grid: { left: 50, right: 20, bottom: 40, top: 20 },
    };
  });

  readonly winLossBySymbolChart = computed<EChartsOption>(() => {
    const positions = this.closedPositions();
    if (positions.length === 0) return this.emptyChartOption('No data');

    const symbolMap = new Map<string, { wins: number; losses: number }>();
    positions.forEach((p) => {
      const sym = p.symbol ?? 'Unknown';
      if (!symbolMap.has(sym)) symbolMap.set(sym, { wins: 0, losses: 0 });
      const entry = symbolMap.get(sym)!;
      if (p.realizedPnL >= 0) entry.wins++;
      else entry.losses++;
    });

    const symbols = Array.from(symbolMap.keys());
    const wins = symbols.map((s) => symbolMap.get(s)!.wins);
    const losses = symbols.map((s) => -symbolMap.get(s)!.losses);

    return {
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      xAxis: { type: 'value' },
      yAxis: { type: 'category', data: symbols },
      series: [
        { name: 'Wins', type: 'bar', stack: 'total', data: wins, itemStyle: { color: '#34C759' } },
        { name: 'Losses', type: 'bar', stack: 'total', data: losses, itemStyle: { color: '#FF3B30' } },
      ],
      grid: { left: 80, right: 20, bottom: 20, top: 20 },
    };
  });

  readonly holdDurationVsPnlChart = computed<EChartsOption>(() => {
    const positions = this.closedPositions();
    if (positions.length === 0) return this.emptyChartOption('No data');

    const data = positions
      .filter((p) => p.openedAt && p.closedAt)
      .map((p) => {
        const hours = (new Date(p.closedAt!).getTime() - new Date(p.openedAt).getTime()) / 3600000;
        return [parseFloat(hours.toFixed(1)), parseFloat(p.realizedPnL.toFixed(2))];
      });

    return {
      tooltip: {
        trigger: 'item',
        formatter: (params: any) => `Duration: ${params.value[0]}h<br/>P&L: $${params.value[1]}`,
      },
      xAxis: { type: 'value', name: 'Duration (hours)', nameLocation: 'middle', nameGap: 30 },
      yAxis: { type: 'value', name: 'P&L ($)' },
      series: [{
        type: 'scatter',
        data,
        symbolSize: 8,
        itemStyle: {
          color: (params: any) => params.value[1] >= 0 ? '#34C759' : '#FF3B30',
        },
      }],
      grid: { left: 60, right: 20, bottom: 50, top: 20 },
    };
  });

  readonly cumulativePnlChart = computed<EChartsOption>(() => {
    const positions = this.closedPositions();
    if (positions.length === 0) return this.emptyChartOption('No data');

    const sorted = [...positions]
      .filter((p) => p.closedAt)
      .sort((a, b) => new Date(a.closedAt!).getTime() - new Date(b.closedAt!).getTime());

    let cumulative = 0;
    const dates: string[] = [];
    const values: number[] = [];

    sorted.forEach((p) => {
      cumulative += p.realizedPnL;
      dates.push(new Date(p.closedAt!).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
      values.push(parseFloat(cumulative.toFixed(2)));
    });

    const lastVal = values[values.length - 1] ?? 0;
    const lineColor = lastVal >= 0 ? '#34C759' : '#FF3B30';

    return {
      tooltip: { trigger: 'axis' },
      xAxis: { type: 'category', data: dates, axisLabel: { fontSize: 10, rotate: 30 } },
      yAxis: { type: 'value', name: 'Cumulative P&L ($)' },
      series: [{
        type: 'line',
        data: values,
        smooth: true,
        lineStyle: { color: lineColor, width: 2 },
        itemStyle: { color: lineColor },
        areaStyle: {
          color: {
            type: 'linear',
            x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: lastVal >= 0 ? 'rgba(52,199,89,0.3)' : 'rgba(255,59,48,0.3)' },
              { offset: 1, color: 'rgba(0,0,0,0)' },
            ],
          } as any,
        },
      }],
      grid: { left: 60, right: 20, bottom: 50, top: 20 },
    };
  });

  readonly pnlBySessionChart = computed<EChartsOption>(() => {
    const positions = this.closedPositions();
    if (positions.length === 0) return this.emptyChartOption('No data');

    const sessions = ['Asian', 'London', 'New York', 'Overlap'];
    const sessionData: Record<string, { total: number; count: number }> = {};
    sessions.forEach((s) => (sessionData[s] = { total: 0, count: 0 }));

    positions.forEach((p) => {
      const hour = new Date(p.openedAt).getUTCHours();
      let session: string;
      if (hour >= 0 && hour < 8) session = 'Asian';
      else if (hour >= 8 && hour < 13) session = 'London';
      else if (hour >= 13 && hour < 17) session = 'New York';
      else session = 'Overlap';
      sessionData[session].total += p.realizedPnL;
      sessionData[session].count++;
    });

    const totals = sessions.map((s) => parseFloat(sessionData[s].total.toFixed(2)));
    const counts = sessions.map((s) => sessionData[s].count);

    return {
      tooltip: {
        trigger: 'axis',
        formatter: (params: any) => {
          const idx = params[0]?.dataIndex ?? 0;
          return `${sessions[idx]}<br/>P&L: $${totals[idx]}<br/>Trades: ${counts[idx]}`;
        },
      },
      xAxis: { type: 'category', data: sessions },
      yAxis: { type: 'value', name: 'P&L ($)' },
      series: [{
        type: 'bar',
        data: totals.map((v) => ({
          value: v,
          itemStyle: { color: v >= 0 ? '#34C759' : '#FF3B30' },
        })),
        barWidth: '50%',
      }],
      grid: { left: 60, right: 20, bottom: 40, top: 20 },
    };
  });

  readonly rMultipleChart = computed<EChartsOption>(() => {
    const positions = this.closedPositions();
    if (positions.length === 0) return this.emptyChartOption('No data');

    // Simulate R-multiples: P&L / risk (using SL distance as proxy for risk)
    const rValues = positions
      .filter((p) => p.stopLoss != null)
      .map((p) => {
        const risk = Math.abs(p.averageEntryPrice - p.stopLoss!) * p.openLots;
        if (risk === 0) return 0;
        return parseFloat((p.realizedPnL / risk).toFixed(2));
      });

    if (rValues.length === 0) return this.emptyChartOption('No SL data for R-calc');

    const min = Math.min(...rValues);
    const max = Math.max(...rValues);
    const binCount = 10;
    const binSize = (max - min) / binCount || 1;
    const bins = Array(binCount).fill(0);
    const labels: string[] = [];

    for (let i = 0; i < binCount; i++) {
      const lo = min + i * binSize;
      labels.push(`${lo.toFixed(1)}R`);
    }

    rValues.forEach((v) => {
      let idx = Math.floor((v - min) / binSize);
      if (idx >= binCount) idx = binCount - 1;
      if (idx < 0) idx = 0;
      bins[idx]++;
    });

    return {
      tooltip: { trigger: 'axis' },
      xAxis: { type: 'category', data: labels, axisLabel: { fontSize: 10 } },
      yAxis: { type: 'value', name: 'Count' },
      series: [{
        type: 'bar',
        data: bins.map((val, i) => {
          const midVal = min + (i + 0.5) * binSize;
          return { value: val, itemStyle: { color: midVal >= 0 ? '#34C759' : '#FF3B30' } };
        }),
        barWidth: '80%',
      }],
      grid: { left: 50, right: 20, bottom: 40, top: 20 },
    };
  });

  // ── Lifecycle ──

  ngOnInit(): void {
    this.loadSummaryData();

    // 15s polling for live open position updates
    this.pollingInterval = setInterval(() => {
      if (this.activeTab() === 'open' && this.openTable) {
        this.openTable.loadData();
      }
      this.loadSummaryData();
    }, 15000);
  }

  ngOnDestroy(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
  }

  // ── Helpers ──

  private loadSummaryData(): void {
    this.positionsService
      .list({ currentPage: 1, itemCountPerPage: 500 })
      .pipe(
        map((r) => r.data?.data ?? [])
      )
      .subscribe((positions) => {
        const open = positions.filter((p) => p.status === 'Open' || p.status === 'Closing');
        const closed = positions.filter((p) => p.status === 'Closed');
        this.openPositions.set(open);
        this.closedPositions.set(closed);
        this.analyticsLoading.set(false);
      });
  }

  private emptyChartOption(text: string): EChartsOption {
    return {
      title: {
        text,
        left: 'center',
        top: 'center',
        textStyle: { color: '#8E8E93', fontSize: 14, fontWeight: 'normal' as const },
      },
    };
  }
}
