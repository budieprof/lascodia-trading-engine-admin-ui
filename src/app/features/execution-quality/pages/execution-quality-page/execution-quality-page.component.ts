import { Component, ChangeDetectionStrategy, signal } from '@angular/core';
import { Observable, of } from 'rxjs';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { TabsComponent, TabItem } from '@shared/components/ui/tabs/tabs.component';
import { DataTableComponent } from '@shared/components/data-table/data-table.component';
import type { ColDef } from 'ag-grid-community';
import type { PagedData, PagerRequest } from '@core/api/api.types';
import type { EChartsOption } from 'echarts';

interface ExecutionRow {
  orderId: string;
  symbol: string;
  requestedPrice: number;
  filledPrice: number;
  slippagePips: number;
  latencyMs: number;
  session: string;
  strategy: string;
}

const SAMPLE_EXECUTIONS: ExecutionRow[] = [
  { orderId: 'ORD-10241', symbol: 'EUR/USD', requestedPrice: 1.08452, filledPrice: 1.08455, slippagePips: 0.3, latencyMs: 32, session: 'London', strategy: 'Momentum Alpha' },
  { orderId: 'ORD-10242', symbol: 'GBP/USD', requestedPrice: 1.26810, filledPrice: 1.26824, slippagePips: 1.4, latencyMs: 67, session: 'New York', strategy: 'Breakout Pro' },
  { orderId: 'ORD-10243', symbol: 'USD/JPY', requestedPrice: 149.320, filledPrice: 149.318, slippagePips: 0.2, latencyMs: 28, session: 'Asian', strategy: 'Mean Reversion' },
  { orderId: 'ORD-10244', symbol: 'AUD/USD', requestedPrice: 0.65420, filledPrice: 0.65432, slippagePips: 1.2, latencyMs: 54, session: 'London', strategy: 'Momentum Alpha' },
  { orderId: 'ORD-10245', symbol: 'EUR/USD', requestedPrice: 1.08510, filledPrice: 1.08512, slippagePips: 0.2, latencyMs: 31, session: 'London/NY Overlap', strategy: 'Mean Reversion' },
  { orderId: 'ORD-10246', symbol: 'GBP/USD', requestedPrice: 1.26790, filledPrice: 1.26795, slippagePips: 0.5, latencyMs: 42, session: 'New York', strategy: 'Momentum Alpha' },
  { orderId: 'ORD-10247', symbol: 'USD/JPY', requestedPrice: 149.450, filledPrice: 149.465, slippagePips: 1.5, latencyMs: 89, session: 'Asian', strategy: 'Breakout Pro' },
  { orderId: 'ORD-10248', symbol: 'EUR/USD', requestedPrice: 1.08380, filledPrice: 1.08382, slippagePips: 0.2, latencyMs: 25, session: 'London', strategy: 'Mean Reversion' },
  { orderId: 'ORD-10249', symbol: 'AUD/USD', requestedPrice: 0.65510, filledPrice: 0.65518, slippagePips: 0.8, latencyMs: 47, session: 'New York', strategy: 'Breakout Pro' },
  { orderId: 'ORD-10250', symbol: 'GBP/USD', requestedPrice: 1.26850, filledPrice: 1.26852, slippagePips: 0.2, latencyMs: 29, session: 'London/NY Overlap', strategy: 'Momentum Alpha' },
];

@Component({
  selector: 'app-execution-quality-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MetricCardComponent, ChartCardComponent, PageHeaderComponent, TabsComponent, DataTableComponent],
  template: `
    <div class="page">
      <app-page-header title="Execution Quality" subtitle="Fill analysis, slippage tracking, and latency monitoring" />

      <ui-tabs [tabs]="tabs" [(activeTab)]="activeTab">
        @if (activeTab() === 'log') {
          <app-data-table
            [columnDefs]="columnDefs"
            [fetchData]="fetchExecutions"
            [searchable]="true"
          />
        }

        @if (activeTab() === 'analytics') {
          <div class="metrics-row">
            <app-metric-card label="Avg Slippage" [value]="0.3" format="number" dotColor="#FF9500" />
            <app-metric-card label="Median Latency" [value]="45" format="number" dotColor="#5AC8FA" />
            <app-metric-card label="Price Improvement Rate" [value]="23" format="percent" dotColor="#34C759" />
            <app-metric-card label="Total Executions" [value]="1247" format="number" dotColor="#0071E3" />
          </div>

          <div class="charts-grid">
            <app-chart-card
              title="Slippage Over Time"
              subtitle="Average slippage with P5/P95 band"
              [options]="slippageTimeOptions"
              height="320px"
            />
            <app-chart-card
              title="Slippage by Symbol"
              subtitle="Average slippage per currency pair (pips)"
              [options]="slippageSymbolOptions"
              height="320px"
            />
          </div>

          <div class="charts-grid">
            <app-chart-card
              title="Fill Latency by Session"
              subtitle="Average and P95 latency (ms)"
              [options]="latencySessionOptions"
              height="320px"
            />
            <app-chart-card
              title="Slippage Distribution"
              subtitle="Frequency of slippage values across all fills"
              [options]="slippageDistOptions"
              height="320px"
            />
          </div>
        }
      </ui-tabs>
    </div>
  `,
  styles: [`
    .page { padding: var(--space-2) 0; }
    .metrics-row {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
      gap: var(--space-4);
      margin-bottom: var(--space-6);
    }
    .charts-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: var(--space-4);
      margin-bottom: var(--space-4);
    }
  `],
})
export class ExecutionQualityPageComponent {
  tabs: TabItem[] = [
    { label: 'Execution Log', value: 'log' },
    { label: 'Quality Analytics', value: 'analytics' },
  ];
  activeTab = signal('log');

  columnDefs: ColDef[] = [
    { headerName: 'Order ID', field: 'orderId', width: 120 },
    { headerName: 'Symbol', field: 'symbol', width: 100 },
    { headerName: 'Requested Price', field: 'requestedPrice', width: 130, valueFormatter: (p: any) => p.value?.toFixed(5) },
    { headerName: 'Filled Price', field: 'filledPrice', width: 120, valueFormatter: (p: any) => p.value?.toFixed(5) },
    {
      headerName: 'Slippage (pips)', field: 'slippagePips', width: 130,
      cellStyle: ((p: any) => p.value > 1 ? { color: '#FF3B30', fontWeight: 600 } : { color: '#1D1D1F' }) as any,
    },
    { headerName: 'Latency (ms)', field: 'latencyMs', width: 110 },
    { headerName: 'Session', field: 'session', width: 130 },
    { headerName: 'Strategy', field: 'strategy', width: 150 },
  ];

  fetchExecutions = (params: PagerRequest): Observable<PagedData<ExecutionRow>> => {
    const start = ((params.currentPage || 1) - 1) * (params.itemCountPerPage || 25);
    const page = SAMPLE_EXECUTIONS.slice(start, start + (params.itemCountPerPage || 25));
    return of({
      data: page,
      pager: { currentPage: params.currentPage || 1, pageNo: 1, itemCountPerPage: params.itemCountPerPage || 25, totalItemCount: SAMPLE_EXECUTIONS.length, filter: params.filter ?? null, pageSize: params.itemCountPerPage || 25 },
    });
  };

  slippageTimeOptions: EChartsOption = {
    tooltip: { trigger: 'axis' },
    grid: { left: 50, right: 20, top: 20, bottom: 30 },
    xAxis: {
      type: 'category',
      data: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
      axisLine: { lineStyle: { color: '#E5E5EA' } },
      axisLabel: { color: '#8E8E93' },
    },
    yAxis: {
      type: 'value',
      name: 'pips',
      axisLabel: { color: '#8E8E93' },
      splitLine: { lineStyle: { color: '#F2F2F7' } },
    },
    series: [
      {
        name: 'P95',
        type: 'line',
        data: [1.8, 2.1, 1.5, 1.9, 2.4, 1.7, 2.0, 1.6, 2.2, 1.8],
        lineStyle: { opacity: 0 },
        areaStyle: { color: 'rgba(255, 149, 0, 0.15)' },
        stack: 'band',
        symbol: 'none',
      },
      {
        name: 'Avg Slippage',
        type: 'line',
        data: [0.3, 0.5, 0.2, 0.4, 0.6, 0.3, 0.4, 0.2, 0.5, 0.3],
        lineStyle: { width: 2, color: '#FF9500' },
        itemStyle: { color: '#FF9500' },
        smooth: true,
      },
      {
        name: 'P5',
        type: 'line',
        data: [0.0, 0.1, 0.0, 0.0, 0.1, 0.0, 0.1, 0.0, 0.0, 0.1],
        lineStyle: { opacity: 0 },
        areaStyle: { color: 'rgba(255, 149, 0, 0.15)' },
        stack: 'band',
        symbol: 'none',
      },
    ],
  };

  slippageSymbolOptions: EChartsOption = {
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    grid: { left: 90, right: 40, top: 10, bottom: 20 },
    xAxis: {
      type: 'value',
      axisLabel: { color: '#8E8E93' },
      splitLine: { lineStyle: { color: '#F2F2F7' } },
    },
    yAxis: {
      type: 'category',
      data: ['EUR/USD', 'AUD/USD', 'USD/JPY', 'GBP/USD', 'USD/CHF'],
      axisLine: { lineStyle: { color: '#E5E5EA' } },
      axisLabel: { color: '#8E8E93' },
    },
    series: [{
      type: 'bar',
      data: [
        { value: 0.2, itemStyle: { color: '#34C759' } },
        { value: 0.4, itemStyle: { color: '#34C759' } },
        { value: 0.6, itemStyle: { color: '#FF9500' } },
        { value: 0.9, itemStyle: { color: '#FF9500' } },
        { value: 1.3, itemStyle: { color: '#FF3B30' } },
      ],
      barWidth: 18,
      label: { show: true, position: 'right', formatter: '{c} pips', color: '#1D1D1F', fontSize: 11 },
    }],
  };

  latencySessionOptions: EChartsOption = {
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    legend: { data: ['Average', 'P95'], bottom: 0 },
    grid: { left: 60, right: 20, top: 20, bottom: 40 },
    xAxis: {
      type: 'category',
      data: ['London', 'New York', 'Asian', 'London/NY Overlap'],
      axisLine: { lineStyle: { color: '#E5E5EA' } },
      axisLabel: { color: '#8E8E93' },
    },
    yAxis: {
      type: 'value',
      name: 'ms',
      axisLabel: { color: '#8E8E93' },
      splitLine: { lineStyle: { color: '#F2F2F7' } },
    },
    series: [
      { name: 'Average', type: 'bar', data: [38, 45, 52, 35], itemStyle: { color: '#0071E3' } },
      { name: 'P95', type: 'bar', data: [82, 98, 124, 71], itemStyle: { color: '#5856D6' } },
    ],
  };

  slippageDistOptions: EChartsOption = {
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    grid: { left: 50, right: 20, top: 20, bottom: 30 },
    xAxis: {
      type: 'category',
      data: ['0.0-0.2', '0.2-0.4', '0.4-0.6', '0.6-0.8', '0.8-1.0', '1.0-1.2', '1.2-1.5', '1.5-2.0', '>2.0'],
      axisLine: { lineStyle: { color: '#E5E5EA' } },
      axisLabel: { color: '#8E8E93', fontSize: 10, rotate: 30 },
    },
    yAxis: {
      type: 'value',
      name: 'Count',
      axisLabel: { color: '#8E8E93' },
      splitLine: { lineStyle: { color: '#F2F2F7' } },
    },
    series: [{
      type: 'bar',
      data: [
        { value: 312, itemStyle: { color: '#34C759' } },
        { value: 287, itemStyle: { color: '#34C759' } },
        { value: 198, itemStyle: { color: '#5AC8FA' } },
        { value: 142, itemStyle: { color: '#5AC8FA' } },
        { value: 108, itemStyle: { color: '#FF9500' } },
        { value: 84, itemStyle: { color: '#FF9500' } },
        { value: 62, itemStyle: { color: '#FF3B30' } },
        { value: 38, itemStyle: { color: '#FF3B30' } },
        { value: 16, itemStyle: { color: '#FF3B30' } },
      ],
      barWidth: '60%',
    }],
  };
}
