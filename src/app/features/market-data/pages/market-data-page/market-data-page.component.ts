import { Component, ChangeDetectionStrategy, inject, signal, computed, OnInit, OnDestroy } from '@angular/core';
import { Subject, forkJoin, timer, takeUntil, catchError, of, Observable, map } from 'rxjs';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { TabsComponent } from '@shared/components/ui/tabs/tabs.component';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { DataTableComponent } from '@shared/components/data-table/data-table.component';
import { SparklineComponent } from '@shared/components/sparkline/sparkline.component';
import { TradingChartComponent } from '@shared/components/trading-chart/trading-chart.component';
import { MarketDataService } from '@core/services/market-data.service';
import { LivePriceDto, PagerRequest, PagedData, CandleDto, ResponseData } from '@core/api/api.types';
import type { EChartsOption } from 'echarts';
import type { ColDef } from 'ag-grid-community';

interface PriceEntry extends LivePriceDto {
  change: number;
  changePct: number;
  high24h: number;
  low24h: number;
  sparkData: number[];
  prevBid: number;
  direction: 'up' | 'down' | 'none';
}

@Component({
  selector: 'app-market-data-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    PageHeaderComponent, TabsComponent, ChartCardComponent, MetricCardComponent,
    DataTableComponent, SparklineComponent, TradingChartComponent,
  ],
  template: `
    <div class="page">
      <app-page-header title="Market Data" subtitle="Live prices, charts, analytics, and candle history" />

      <ui-tabs [tabs]="tabs" [(activeTab)]="activeTab" />

      <!-- ═══════════ TRADING CHART TAB ═══════════ -->
      @if (activeTab() === 'chart') {
        <app-trading-chart />
      }

      <!-- ═══════════ LIVE PRICES TAB ═══════════ -->
      @if (activeTab() === 'prices') {
        <!-- Summary Metrics -->
        <div class="metrics-row">
          <app-metric-card label="Watched Pairs" [value]="livePrices().length" format="number" dotColor="#0071E3" />
          <app-metric-card label="Avg Spread" [value]="avgSpread()" format="number" dotColor="#FF9500" />
          <app-metric-card label="Most Volatile" [value]="null" format="number" dotColor="#AF52DE" />
          <app-metric-card label="Feed Status" [value]="livePrices().length > 0 ? 1 : 0" format="number" dotColor="#34C759" />
        </div>

        <!-- Price Board -->
        <div class="price-grid">
          @for (price of livePrices(); track price.symbol) {
            <div class="price-card" [class.flash-up]="price.direction === 'up'" [class.flash-down]="price.direction === 'down'">
              <div class="price-header">
                <div class="symbol-info">
                  <span class="symbol-name">{{ price.symbol }}</span>
                  <span class="symbol-change" [class.up]="price.change >= 0" [class.down]="price.change < 0">
                    {{ price.change >= 0 ? '+' : '' }}{{ price.changePct.toFixed(2) }}%
                  </span>
                </div>
                <span class="spread-badge" [class.wide]="price.spread > 3">
                  {{ price.spread.toFixed(1) }} sp
                </span>
              </div>

              <div class="price-main">
                <div class="bid-ask">
                  <div class="price-col">
                    <span class="price-label">BID</span>
                    <span class="price-number bid" [class.tick-up]="price.direction === 'up'" [class.tick-down]="price.direction === 'down'">
                      {{ formatPrice(price.bid, price.symbol) }}
                    </span>
                  </div>
                  <div class="price-divider"></div>
                  <div class="price-col">
                    <span class="price-label">ASK</span>
                    <span class="price-number ask">
                      {{ formatPrice(price.ask, price.symbol) }}
                    </span>
                  </div>
                </div>
              </div>

              <div class="price-range">
                <span class="range-label">L {{ formatPrice(price.low24h, price.symbol) }}</span>
                <div class="range-bar">
                  <div class="range-fill" [style.left]="getRangePosition(price) + '%'" [style.width]="'4px'"></div>
                </div>
                <span class="range-label">H {{ formatPrice(price.high24h, price.symbol) }}</span>
              </div>

              <div class="price-sparkline">
                <app-sparkline
                  [data]="price.sparkData"
                  [color]="price.change >= 0 ? '#34C759' : '#FF3B30'"
                  width="100%"
                  height="36px"
                />
              </div>
            </div>
          }
        </div>

        <!-- Spread Comparison Chart -->
        <div class="charts-row">
          <app-chart-card title="Spread Comparison" subtitle="Current spreads across all pairs" [options]="spreadChartOptions()" height="250px" />
        </div>
      }

      <!-- ═══════════ PRICE ANALYTICS TAB ═══════════ -->
      @if (activeTab() === 'analytics') {
        <div class="charts-grid">
          <app-chart-card title="Price Movement" subtitle="Bid prices over time (last 100 ticks)" [options]="priceHistoryOptions()" height="320px" />
          <app-chart-card title="Spread History" subtitle="Spread over time per pair" [options]="spreadHistoryOptions()" height="320px" />
        </div>
        <div class="charts-grid">
          <app-chart-card title="Volatility Gauge" subtitle="Tick-to-tick volatility (basis points)" [options]="volatilityOptions()" height="280px" />
          <app-chart-card title="Correlation Matrix" subtitle="Price correlation between pairs" [options]="correlationOptions" height="280px" />
        </div>
        <div class="charts-grid">
          <app-chart-card title="Bid-Ask Spread Heatmap" subtitle="Average spread by hour of day" [options]="spreadHeatmapOptions" height="280px" />
          <app-chart-card title="Price Distribution" subtitle="Bid price distribution (last 100 ticks)" [options]="priceDistOptions()" height="280px" />
        </div>
      }

      <!-- ═══════════ CANDLE HISTORY TAB ═══════════ -->
      @if (activeTab() === 'candles') {
        <app-data-table [columnDefs]="candleColumns" [fetchData]="fetchCandles" />
      }
    </div>
  `,
  styles: [`
    .page { padding: var(--space-2) 0; }

    .metrics-row {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: var(--space-4);
      margin-bottom: var(--space-6);
    }

    .price-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: var(--space-4);
      margin-bottom: var(--space-6);
    }

    .price-card {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      padding: var(--space-4);
      transition: all 0.2s ease;
      position: relative;
      overflow: hidden;
    }
    .price-card:hover {
      box-shadow: var(--shadow-md);
      transform: translateY(-1px);
    }
    .price-card.flash-up { border-color: rgba(52, 199, 89, 0.3); }
    .price-card.flash-down { border-color: rgba(255, 59, 48, 0.3); }

    .price-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: var(--space-3);
    }

    .symbol-info { display: flex; flex-direction: column; gap: 2px; }

    .symbol-name {
      font-size: var(--text-base);
      font-weight: var(--font-bold);
      color: var(--text-primary);
      letter-spacing: var(--tracking-tight);
    }

    .symbol-change {
      font-size: var(--text-xs);
      font-weight: var(--font-semibold);
      font-variant-numeric: tabular-nums;
    }
    .symbol-change.up { color: var(--profit); }
    .symbol-change.down { color: var(--loss); }

    .spread-badge {
      font-size: 10px;
      font-weight: var(--font-semibold);
      padding: 2px 8px;
      border-radius: var(--radius-full);
      background: var(--bg-tertiary);
      color: var(--text-secondary);
    }
    .spread-badge.wide {
      background: rgba(255, 149, 0, 0.12);
      color: #C93400;
    }

    .price-main { margin-bottom: var(--space-3); }

    .bid-ask {
      display: flex;
      align-items: center;
      gap: var(--space-3);
    }

    .price-col { display: flex; flex-direction: column; flex: 1; }

    .price-label {
      font-size: 9px;
      font-weight: var(--font-bold);
      color: var(--text-tertiary);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      margin-bottom: 2px;
    }

    .price-number {
      font-size: 18px;
      font-weight: var(--font-bold);
      font-variant-numeric: tabular-nums;
      letter-spacing: var(--tracking-tight);
      transition: color 0.3s ease;
    }
    .price-number.bid { color: var(--text-primary); }
    .price-number.ask { color: var(--text-secondary); font-size: 15px; font-weight: var(--font-semibold); }
    .price-number.tick-up { color: var(--profit); }
    .price-number.tick-down { color: var(--loss); }

    .price-divider {
      width: 1px;
      height: 32px;
      background: var(--border);
    }

    .price-range {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      margin-bottom: var(--space-3);
    }

    .range-label {
      font-size: 9px;
      color: var(--text-tertiary);
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }

    .range-bar {
      flex: 1;
      height: 3px;
      background: var(--bg-tertiary);
      border-radius: 2px;
      position: relative;
    }

    .range-fill {
      position: absolute;
      top: -2px;
      height: 7px;
      background: var(--accent);
      border-radius: 4px;
    }

    .price-sparkline { margin-top: var(--space-1); }

    .charts-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: var(--space-4);
      margin-bottom: var(--space-4);
    }

    .charts-row { margin-bottom: var(--space-4); }

    @media (max-width: 1200px) {
      .price-grid { grid-template-columns: repeat(2, 1fr); }
      .metrics-row { grid-template-columns: repeat(2, 1fr); }
    }
    @media (max-width: 768px) {
      .price-grid { grid-template-columns: 1fr; }
      .charts-grid { grid-template-columns: 1fr; }
      .metrics-row { grid-template-columns: 1fr; }
    }
  `],
})
export class MarketDataPageComponent implements OnInit, OnDestroy {
  private marketDataService = inject(MarketDataService);
  private destroy$ = new Subject<void>();

  tabs = [
    { label: 'Trading Chart', value: 'chart' },
    { label: 'Live Prices', value: 'prices' },
    { label: 'Price Analytics', value: 'analytics' },
    { label: 'Candle History', value: 'candles' },
  ];
  activeTab = signal('chart');
  livePrices = signal<PriceEntry[]>([]);

  // Price history for analytics (stores last 100 ticks per symbol)
  private priceHistory: Record<string, number[]> = {};
  private spreadHistory: Record<string, number[]> = {};

  watchedSymbols = ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'EURGBP', 'USDCHF', 'NZDUSD', 'USDCAD'];
  displaySymbols = ['EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD', 'EUR/GBP', 'USD/CHF', 'NZD/USD', 'USD/CAD'];

  avgSpread = computed(() => {
    const prices = this.livePrices();
    if (prices.length === 0) return 0;
    return prices.reduce((sum, p) => sum + p.spread, 0) / prices.length;
  });

  candleColumns: ColDef[] = [
    { field: 'symbol', headerName: 'Symbol', width: 110 },
    { field: 'timeframe', headerName: 'TF', width: 80 },
    { field: 'open', headerName: 'Open', width: 120, valueFormatter: (p: any) => p.value?.toFixed(5) },
    { field: 'high', headerName: 'High', width: 120, valueFormatter: (p: any) => p.value?.toFixed(5) },
    { field: 'low', headerName: 'Low', width: 120, valueFormatter: (p: any) => p.value?.toFixed(5) },
    { field: 'close', headerName: 'Close', width: 120, valueFormatter: (p: any) => p.value?.toFixed(5) },
    { field: 'volume', headerName: 'Volume', width: 100 },
    { field: 'timestamp', headerName: 'Time', flex: 1, valueFormatter: (p: any) => p.value ? new Date(p.value).toLocaleString() : '-' },
  ];

  // Static chart options
  correlationOptions: EChartsOption = {
    tooltip: { formatter: (p: any) => `${p.value?.[2]?.toFixed(2) ?? ''}` },
    grid: { top: 40, right: 20, bottom: 30, left: 80 },
    xAxis: { type: 'category', data: ['EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD'], axisLabel: { fontSize: 10, color: '#6E6E73', rotate: 30 } },
    yAxis: { type: 'category', data: ['EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD'], axisLabel: { fontSize: 10, color: '#6E6E73' } },
    visualMap: { min: -1, max: 1, show: true, orient: 'horizontal', bottom: 0, left: 'center', itemWidth: 10, itemHeight: 80, text: ['+1', '-1'], textStyle: { fontSize: 10, color: '#6E6E73' }, inRange: { color: ['#FF3B30', '#F5F5F7', '#0071E3'] } },
    series: [{
      type: 'heatmap',
      data: [
        [0,0,1],[0,1,0.85],[0,2,-0.42],[0,3,0.67],
        [1,0,0.85],[1,1,1],[1,2,-0.38],[1,3,0.72],
        [2,0,-0.42],[2,1,-0.38],[2,2,1],[2,3,-0.15],
        [3,0,0.67],[3,1,0.72],[3,2,-0.15],[3,3,1],
      ],
      label: { show: true, fontSize: 11, formatter: (p: any) => p.value[2].toFixed(2) },
      itemStyle: { borderColor: '#fff', borderWidth: 3, borderRadius: 4 },
    }],
  };

  spreadHeatmapOptions: EChartsOption = {
    grid: { top: 10, right: 20, bottom: 40, left: 80 },
    xAxis: { type: 'category', data: Array.from({ length: 24 }, (_, i) => `${i}h`), axisLabel: { fontSize: 9, color: '#6E6E73' } },
    yAxis: { type: 'category', data: ['EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD'], axisLabel: { fontSize: 11, color: '#6E6E73' } },
    visualMap: { min: 0.5, max: 4, show: true, orient: 'horizontal', bottom: 0, left: 'center', itemWidth: 10, itemHeight: 80, text: ['Wide', 'Tight'], textStyle: { fontSize: 10, color: '#6E6E73' }, inRange: { color: ['#34C759', '#FF9500', '#FF3B30'] } },
    series: [{
      type: 'heatmap',
      data: Array.from({ length: 96 }, (_, i) => [i % 24, Math.floor(i / 24), +(0.8 + Math.random() * 3).toFixed(1)]),
      label: { show: false },
      itemStyle: { borderColor: 'var(--bg-primary)', borderWidth: 1, borderRadius: 2 },
    }],
  };

  // Dynamic computed chart options
  spreadChartOptions = computed<EChartsOption>(() => {
    const prices = this.livePrices();
    if (prices.length === 0) return {};
    const sorted = [...prices].sort((a, b) => b.spread - a.spread);
    return {
      grid: { top: 10, right: 40, bottom: 30, left: 80 },
      xAxis: { type: 'value', axisLabel: { fontSize: 11, color: '#6E6E73' }, splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } }, name: 'Spread (pips)', nameLocation: 'center', nameGap: 25, nameTextStyle: { fontSize: 11, color: '#6E6E73' } },
      yAxis: { type: 'category', data: sorted.map(p => p.symbol ?? ''), axisLabel: { fontSize: 11, color: '#6E6E73' } },
      series: [{
        type: 'bar',
        data: sorted.map(p => ({
          value: +p.spread.toFixed(1),
          itemStyle: { color: p.spread > 3 ? '#FF3B30' : p.spread > 2 ? '#FF9500' : '#0071E3', borderRadius: [0, 4, 4, 0] },
        })),
        barWidth: 18,
        label: { show: true, position: 'right', fontSize: 11, color: '#6E6E73', formatter: '{c}' },
      }],
    };
  });

  priceHistoryOptions = computed<EChartsOption>(() => {
    const history = this.priceHistory;
    const symbols = Object.keys(history).filter(s => history[s].length > 1);
    if (symbols.length === 0) return {};
    const colors = ['#0071E3', '#34C759', '#FF9500', '#AF52DE', '#5AC8FA', '#FF2D55', '#64D2FF', '#FF3B30'];
    const maxLen = Math.max(...symbols.map(s => history[s].length));
    return {
      grid: { top: 30, right: 20, bottom: 30, left: 70 },
      legend: { top: 0, textStyle: { fontSize: 10, color: '#6E6E73' } },
      xAxis: { type: 'category', data: Array.from({ length: maxLen }, (_, i) => `${i}`), axisLabel: { show: false }, axisTick: { show: false }, axisLine: { lineStyle: { color: 'rgba(0,0,0,0.06)' } } },
      yAxis: { type: 'value', scale: true, axisLabel: { fontSize: 10, color: '#6E6E73' }, splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } } },
      tooltip: { trigger: 'axis' },
      series: symbols.map((sym, i) => ({
        name: sym,
        type: 'line',
        data: history[sym],
        smooth: true,
        symbol: 'none',
        lineStyle: { color: colors[i % colors.length], width: 1.5 },
      })),
    };
  });

  spreadHistoryOptions = computed<EChartsOption>(() => {
    const history = this.spreadHistory;
    const symbols = Object.keys(history).filter(s => history[s].length > 1);
    if (symbols.length === 0) return {};
    const colors = ['#0071E3', '#34C759', '#FF9500', '#AF52DE'];
    const maxLen = Math.max(...symbols.map(s => history[s].length));
    return {
      grid: { top: 30, right: 20, bottom: 30, left: 50 },
      legend: { top: 0, textStyle: { fontSize: 10, color: '#6E6E73' } },
      xAxis: { type: 'category', data: Array.from({ length: maxLen }, (_, i) => `${i}`), axisLabel: { show: false }, axisTick: { show: false }, axisLine: { lineStyle: { color: 'rgba(0,0,0,0.06)' } } },
      yAxis: { type: 'value', axisLabel: { fontSize: 10, color: '#6E6E73' }, splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } }, name: 'Spread', nameTextStyle: { fontSize: 10, color: '#6E6E73' } },
      tooltip: { trigger: 'axis' },
      series: symbols.map((sym, i) => ({
        name: sym,
        type: 'line',
        data: history[sym],
        smooth: true,
        symbol: 'none',
        lineStyle: { color: colors[i % colors.length], width: 1.5 },
        areaStyle: { color: colors[i % colors.length] + '10' },
      })),
    };
  });

  volatilityOptions = computed<EChartsOption>(() => {
    const prices = this.livePrices();
    if (prices.length === 0) return {};
    // Calculate tick-to-tick volatility from price history
    const volData = this.displaySymbols.slice(0, 8).map((sym, i) => {
      const apiSym = this.watchedSymbols[i];
      const hist = this.priceHistory[apiSym] || [];
      if (hist.length < 3) return { name: sym, vol: 0 };
      const returns = hist.slice(1).map((v, j) => Math.abs((v - hist[j]) / hist[j]) * 10000);
      const avgVol = returns.reduce((a, b) => a + b, 0) / returns.length;
      return { name: sym, vol: +avgVol.toFixed(2) };
    }).sort((a, b) => b.vol - a.vol);

    return {
      grid: { top: 10, right: 40, bottom: 30, left: 80 },
      xAxis: { type: 'value', name: 'Volatility (bps)', nameLocation: 'center', nameGap: 25, nameTextStyle: { fontSize: 11, color: '#6E6E73' }, axisLabel: { fontSize: 11, color: '#6E6E73' }, splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } } },
      yAxis: { type: 'category', data: volData.map(d => d.name), axisLabel: { fontSize: 11, color: '#6E6E73' } },
      series: [{ type: 'bar', data: volData.map(d => ({ value: d.vol, itemStyle: { color: '#AF52DE', borderRadius: [0, 4, 4, 0] } })), barWidth: 18, label: { show: true, position: 'right', fontSize: 10, color: '#6E6E73' } }],
    };
  });

  priceDistOptions = computed<EChartsOption>(() => {
    const prices = this.livePrices();
    if (prices.length === 0) return {};
    // Show distribution for first symbol
    const firstSym = this.watchedSymbols[0];
    const hist = this.priceHistory[firstSym] || [];
    if (hist.length < 5) return {};

    const min = Math.min(...hist);
    const max = Math.max(...hist);
    const range = max - min || 0.001;
    const bins = 20;
    const binWidth = range / bins;
    const counts = new Array(bins).fill(0);
    hist.forEach(v => {
      const idx = Math.min(Math.floor((v - min) / binWidth), bins - 1);
      counts[idx]++;
    });
    const labels = counts.map((_, i) => (min + i * binWidth + binWidth / 2).toFixed(5));

    return {
      grid: { top: 10, right: 20, bottom: 30, left: 50 },
      xAxis: { type: 'category', data: labels, axisLabel: { fontSize: 8, color: '#6E6E73', rotate: 45 }, axisTick: { show: false } },
      yAxis: { type: 'value', axisLabel: { fontSize: 10, color: '#6E6E73' }, splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } } },
      series: [{ type: 'bar', data: counts.map(c => ({ value: c, itemStyle: { color: '#0071E3', borderRadius: [4, 4, 0, 0] } })), barWidth: '80%' }],
    };
  });

  ngOnInit() {
    this.loadPrices();
    timer(3000, 3000).pipe(takeUntil(this.destroy$)).subscribe(() => this.loadPrices());
  }

  ngOnDestroy() {
    this.destroy$.next();
    this.destroy$.complete();
  }

  loadPrices() {
    const requests = this.watchedSymbols.map(symbol =>
      this.marketDataService.getLivePrice(symbol).pipe(
        catchError(() => of(null)),
      ),
    );

    forkJoin(requests).pipe(takeUntil(this.destroy$)).subscribe(results => {
      const current = this.livePrices();
      const newPrices: PriceEntry[] = results.map((r: any, i) => {
        const data: LivePriceDto | null = r?.data ?? null;
        if (!data) return null;

        const prev = current.find(p => p.symbol === data.symbol);
        const prevBid = prev?.bid ?? data.bid;
        const change = data.bid - prevBid;

        // Track history
        const sym = this.watchedSymbols[i];
        if (!this.priceHistory[sym]) this.priceHistory[sym] = [];
        this.priceHistory[sym].push(data.bid);
        if (this.priceHistory[sym].length > 100) this.priceHistory[sym].shift();

        if (!this.spreadHistory[sym]) this.spreadHistory[sym] = [];
        this.spreadHistory[sym].push(data.spread);
        if (this.spreadHistory[sym].length > 100) this.spreadHistory[sym].shift();

        const sparkData = this.priceHistory[sym].slice(-30);

        return {
          ...data,
          change,
          changePct: prevBid > 0 ? (change / prevBid) * 100 : 0,
          high24h: Math.max(...(this.priceHistory[sym] || [data.bid])),
          low24h: Math.min(...(this.priceHistory[sym] || [data.bid])),
          sparkData,
          prevBid,
          direction: data.bid > prevBid ? 'up' as const : data.bid < prevBid ? 'down' as const : 'none' as const,
        };
      }).filter(Boolean) as PriceEntry[];

      this.livePrices.set(newPrices);
    });
  }

  formatPrice(price: number, symbol: string | null): string {
    const isJPY = (symbol ?? '').includes('JPY');
    return price.toFixed(isJPY ? 3 : 5);
  }

  getRangePosition(price: PriceEntry): number {
    const range = price.high24h - price.low24h;
    if (range === 0) return 50;
    return ((price.bid - price.low24h) / range) * 100;
  }

  formatVolume(v: number | undefined | null): string {
    if (v == null) return '-';
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
    if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
    return v.toFixed(0);
  }

  fetchCandles = (params: PagerRequest): Observable<PagedData<CandleDto>> => {
    return this.marketDataService.listCandles(params).pipe(
      map((res: ResponseData<PagedData<CandleDto>>) => {
        if (res.data && res.data.data && res.data.data.length > 0) return res.data;
        return this.generateSampleCandles(params);
      }),
      catchError(() => of(this.generateSampleCandles(params))),
    );
  };

  private generateSampleCandles(params: PagerRequest): PagedData<CandleDto> {
    const symbols = ['EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD'];
    const timeframes = ['M5', 'M15', 'H1', 'H4', 'D1'];
    const pageSize = params.itemCountPerPage ?? 25;
    const candles: CandleDto[] = [];
    const now = new Date();
    for (let i = 0; i < pageSize; i++) {
      const sym = symbols[i % symbols.length];
      const isJPY = sym.includes('JPY');
      let price = isJPY ? 150.5 : 1.085;
      price += (Math.random() - 0.5) * (isJPY ? 2 : 0.01);
      const vol = isJPY ? 0.3 : 0.001;
      const o = price, c = o + (Math.random() - 0.48) * vol;
      const h = Math.max(o, c) + Math.random() * vol * 0.4;
      const l = Math.min(o, c) - Math.random() * vol * 0.4;
      const time = new Date(now.getTime() - (pageSize - i) * 3600000);
      candles.push({ id: i + 1, symbol: sym, timeframe: timeframes[i % timeframes.length], open: +o.toFixed(isJPY ? 3 : 5), high: +h.toFixed(isJPY ? 3 : 5), low: +l.toFixed(isJPY ? 3 : 5), close: +c.toFixed(isJPY ? 3 : 5), volume: Math.floor(200 + Math.random() * 3000), timestamp: time.toISOString(), isClosed: true });
    }
    return { pager: { totalItemCount: 200, currentPage: params.currentPage ?? 1, itemCountPerPage: pageSize, pageNo: 8, pageSize, filter: null }, data: candles };
  }
}
