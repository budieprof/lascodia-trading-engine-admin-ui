import {
  Component, ChangeDetectionStrategy, input, signal, computed, inject,
  OnInit, OnDestroy,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgxEchartsDirective } from 'ngx-echarts';
import type { EChartsOption } from 'echarts';
import { Subject, timer, switchMap, takeUntil, catchError, of } from 'rxjs';
import { MarketDataService } from '@core/services/market-data.service';
import { CandleDto, LivePriceDto } from '@core/api/api.types';

@Component({
  selector: 'app-trading-chart',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgxEchartsDirective, FormsModule],
  template: `
    <div class="trading-chart">
      <!-- Toolbar -->
      <div class="chart-toolbar">
        <div class="toolbar-left">
          <select class="toolbar-select symbol-select" [ngModel]="selectedSymbol()" (ngModelChange)="onSymbolChange($event)">
            @for (s of symbols; track s) {
              <option [value]="s">{{ s }}</option>
            }
          </select>
          <div class="timeframe-pills">
            @for (tf of timeframes; track tf.value) {
              <button
                class="tf-pill"
                [class.active]="selectedTimeframe() === tf.value"
                (click)="onTimeframeChange(tf.value)"
              >{{ tf.label }}</button>
            }
          </div>
        </div>
        <div class="toolbar-right">
          @if (livePrice()) {
            <div class="live-price-display">
              <span class="live-label">Live</span>
              <span class="live-dot"></span>
              <span class="live-bid" [class.up]="priceDirection() === 'up'" [class.down]="priceDirection() === 'down'">
                {{ livePrice()!.bid.toFixed(pricePrecision()) }}
              </span>
              <span class="live-separator">/</span>
              <span class="live-ask">{{ livePrice()!.ask.toFixed(pricePrecision()) }}</span>
              <span class="live-spread">{{ livePrice()!.spread.toFixed(1) }} sp</span>
            </div>
          }
          <div class="chart-toggles">
            <button class="toggle-btn" [class.active]="showMA()" (click)="toggleOverlay('ma')" title="Moving Averages">MA</button>
            <button class="toggle-btn" [class.active]="showVolume()" (click)="toggleOverlay('vol')" title="Volume">Vol</button>
            <button class="toggle-btn" [class.active]="showBollinger()" (click)="toggleOverlay('bb')" title="Bollinger Bands">BB</button>
          </div>
        </div>
      </div>

      <!-- Chart -->
      <div class="chart-container">
        @if (loading()) {
          <div class="chart-skeleton">
            <div class="shimmer"></div>
          </div>
        } @else {
          <div
            echarts
            [options]="chartInitOptions"
            [merge]="chartMerge()"
            [autoResize]="true"
            class="echart-instance"
          ></div>
        }
      </div>

      <!-- Info Bar -->
      <div class="chart-info-bar">
        @if (latestCandle(); as c) {
          <div class="info-item">
            <span class="info-label">O</span>
            <span class="info-value">{{ c.open.toFixed(pricePrecision()) }}</span>
          </div>
          <div class="info-item">
            <span class="info-label">H</span>
            <span class="info-value high">{{ c.high.toFixed(pricePrecision()) }}</span>
          </div>
          <div class="info-item">
            <span class="info-label">L</span>
            <span class="info-value low">{{ c.low.toFixed(pricePrecision()) }}</span>
          </div>
          <div class="info-item">
            <span class="info-label">C</span>
            <span class="info-value" [class.up]="c.close >= c.open" [class.down]="c.close < c.open">
              {{ c.close.toFixed(pricePrecision()) }}
            </span>
          </div>
          <div class="info-item">
            <span class="info-label">Vol</span>
            <span class="info-value">{{ formatVolume(c.volume) }}</span>
          </div>
        }
        <div class="info-item candle-count">
          <span class="info-value muted">{{ candles().length }} candles</span>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .trading-chart {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      overflow: hidden;
    }

    .chart-toolbar {
      display: flex; align-items: center; justify-content: space-between;
      padding: var(--space-3) var(--space-4); border-bottom: 1px solid var(--border);
      gap: var(--space-4); flex-wrap: wrap;
    }
    .toolbar-left, .toolbar-right { display: flex; align-items: center; gap: var(--space-3); }

    .toolbar-select {
      height: 32px; padding: 0 var(--space-3); border: 1px solid var(--border);
      border-radius: var(--radius-sm); background: var(--bg-primary); color: var(--text-primary);
      font-size: var(--text-sm); font-weight: var(--font-semibold); font-family: inherit;
      cursor: pointer; outline: none;
    }
    .toolbar-select:focus { border-color: var(--accent); }
    .symbol-select { min-width: 110px; }

    .timeframe-pills {
      display: flex; gap: 2px; background: var(--bg-tertiary);
      border-radius: var(--radius-sm); padding: 2px;
    }
    .tf-pill {
      height: 28px; padding: 0 var(--space-3); border: none; border-radius: 6px;
      background: transparent; color: var(--text-secondary); font-size: var(--text-xs);
      font-weight: var(--font-medium); font-family: inherit; cursor: pointer;
      transition: all 0.15s ease;
    }
    .tf-pill:hover { color: var(--text-primary); }
    .tf-pill.active {
      background: var(--bg-primary); color: var(--text-primary);
      box-shadow: 0 1px 3px rgba(0,0,0,0.08);
    }

    .live-price-display {
      display: flex; align-items: center; gap: var(--space-2);
      padding: 4px var(--space-3); background: var(--bg-primary);
      border: 1px solid var(--border); border-radius: var(--radius-sm);
      font-variant-numeric: tabular-nums;
    }
    .live-label { font-size: 9px; font-weight: var(--font-semibold); text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-tertiary); }
    .live-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--profit); animation: pulse 2s infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
    .live-bid { font-size: var(--text-sm); font-weight: var(--font-semibold); color: var(--text-primary); transition: color 0.3s ease; }
    .live-bid.up { color: var(--profit); }
    .live-bid.down { color: var(--loss); }
    .live-separator { color: var(--text-tertiary); font-size: 11px; }
    .live-ask { font-size: var(--text-sm); color: var(--text-secondary); }
    .live-spread { font-size: 10px; color: var(--text-tertiary); padding: 1px 6px; background: var(--bg-tertiary); border-radius: 4px; }

    .chart-toggles { display: flex; gap: 2px; }
    .toggle-btn {
      height: 28px; padding: 0 var(--space-2); border: 1px solid var(--border);
      border-radius: var(--radius-sm); background: transparent; color: var(--text-tertiary);
      font-size: 10px; font-weight: var(--font-semibold); font-family: inherit;
      cursor: pointer; transition: all 0.15s ease;
    }
    .toggle-btn:hover { color: var(--text-secondary); }
    .toggle-btn.active { background: rgba(0,113,227,0.1); color: var(--accent); border-color: var(--accent); }

    .chart-container { position: relative; height: 500px; }
    .echart-instance { width: 100%; height: 100%; }

    .chart-skeleton {
      width: 100%; height: 100%; background: var(--bg-tertiary);
      position: relative; overflow: hidden;
    }
    .shimmer {
      position: absolute; inset: 0;
      background: linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.15) 50%, transparent 100%);
      animation: shimmer 1.5s infinite;
    }
    @keyframes shimmer { 0% { transform: translateX(-100%); } 100% { transform: translateX(100%); } }

    .chart-info-bar {
      display: flex; align-items: center; gap: var(--space-5);
      padding: var(--space-2) var(--space-4); border-top: 1px solid var(--border);
      font-variant-numeric: tabular-nums;
    }
    .info-item { display: flex; align-items: center; gap: var(--space-1); }
    .info-label { font-size: 10px; font-weight: var(--font-semibold); color: var(--text-tertiary); text-transform: uppercase; }
    .info-value { font-size: var(--text-sm); color: var(--text-primary); font-weight: var(--font-medium); }
    .info-value.high { color: var(--profit); }
    .info-value.low { color: var(--loss); }
    .info-value.up { color: var(--profit); }
    .info-value.down { color: var(--loss); }
    .info-value.muted { color: var(--text-tertiary); font-size: var(--text-xs); }
    .candle-count { margin-left: auto; }

    @media (max-width: 768px) {
      .chart-toolbar { flex-direction: column; align-items: stretch; }
      .chart-container { height: 400px; }
    }
  `],
})
export class TradingChartComponent implements OnInit, OnDestroy {
  private marketData = inject(MarketDataService);
  private destroy$ = new Subject<void>();

  symbols = ['EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD', 'EUR/GBP', 'USD/CHF', 'NZD/USD', 'USD/CAD'];
  timeframes = [
    { label: '1m', value: 'M1' },
    { label: '5m', value: 'M5' },
    { label: '15m', value: 'M15' },
    { label: '1H', value: 'H1' },
    { label: '4H', value: 'H4' },
    { label: '1D', value: 'D1' },
  ];

  selectedSymbol = signal('EUR/USD');
  selectedTimeframe = signal('H1');
  loading = signal(true);
  candles = signal<CandleDto[]>([]);
  livePrice = signal<LivePriceDto | null>(null);
  previousBid = signal<number>(0);
  showMA = signal(true);
  showVolume = signal(true);
  showBollinger = signal(false);

  priceDirection = computed(() => {
    const current = this.livePrice()?.bid ?? 0;
    const prev = this.previousBid();
    if (current > prev) return 'up';
    if (current < prev) return 'down';
    return 'none';
  });

  pricePrecision = computed(() => this.selectedSymbol().includes('JPY') ? 3 : 5);

  latestCandle = computed(() => {
    const c = this.candles();
    return c.length > 0 ? c[c.length - 1] : null;
  });

  // Initial empty chart structure
  chartInitOptions: EChartsOption = {
    animation: false,
    tooltip: {
      trigger: 'axis',
      axisPointer: {
        type: 'cross',
        crossStyle: { color: '#6E6E73', width: 0.5, type: 'dashed' },
        lineStyle: { color: '#6E6E73', width: 0.5, type: 'dashed' },
        label: { backgroundColor: '#1D1D1F', fontSize: 10, borderRadius: 4, padding: [4, 8] },
      },
      backgroundColor: 'rgba(255,255,255,0.92)',
      borderColor: 'rgba(0,0,0,0.06)',
      borderRadius: 10,
      padding: [8, 12],
      textStyle: { fontSize: 12, color: '#1D1D1F' },
      extraCssText: 'backdrop-filter:blur(20px);box-shadow:0 4px 12px rgba(0,0,0,0.08);',
    },
    grid: [
      { left: 60, right: 60, top: 30, height: '58%' },
      { left: 60, right: 60, bottom: 30, height: '15%' },
    ],
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    xAxis: [
      { type: 'category', data: [], gridIndex: 0, axisLine: { lineStyle: { color: 'rgba(0,0,0,0.06)' } }, axisLabel: { fontSize: 10, color: '#6E6E73' }, axisTick: { show: false }, boundaryGap: true },
      { type: 'category', data: [], gridIndex: 1, axisLine: { lineStyle: { color: 'rgba(0,0,0,0.06)' } }, axisLabel: { show: false }, axisTick: { show: false } },
    ],
    yAxis: [
      { type: 'value', scale: true, gridIndex: 0, splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } }, axisLabel: { fontSize: 10, color: '#6E6E73' }, position: 'right' },
      { type: 'value', gridIndex: 1, splitLine: { show: false }, axisLabel: { show: false }, axisLine: { show: false } },
    ],
    dataZoom: [
      { type: 'inside', xAxisIndex: [0, 1], start: 0, end: 100 },
      { type: 'slider', xAxisIndex: [0, 1], bottom: 5, height: 16, borderColor: 'rgba(0,0,0,0.06)', backgroundColor: 'rgba(0,0,0,0.02)', fillerColor: 'rgba(0,113,227,0.08)', handleStyle: { color: '#0071E3' }, textStyle: { fontSize: 9, color: '#6E6E73' } },
    ],
    series: [
      { name: 'Price', type: 'candlestick', data: [], xAxisIndex: 0, yAxisIndex: 0, itemStyle: { color: '#34C759', color0: '#FF3B30', borderColor: '#34C759', borderColor0: '#FF3B30', borderWidth: 1 } },
      { name: 'MA20', type: 'line', data: [], smooth: true, symbol: 'none', lineStyle: { color: '#FF9500', width: 1.2 }, xAxisIndex: 0, yAxisIndex: 0 },
      { name: 'MA50', type: 'line', data: [], smooth: true, symbol: 'none', lineStyle: { color: '#AF52DE', width: 1.2 }, xAxisIndex: 0, yAxisIndex: 0 },
      { name: 'BB Upper', type: 'line', data: [], smooth: true, symbol: 'none', lineStyle: { color: '#5AC8FA', width: 0.8, opacity: 0.5 }, xAxisIndex: 0, yAxisIndex: 0 },
      { name: 'BB Lower', type: 'line', data: [], smooth: true, symbol: 'none', lineStyle: { color: '#5AC8FA', width: 0.8, opacity: 0.5 }, areaStyle: { color: 'rgba(90,200,250,0.04)' }, xAxisIndex: 0, yAxisIndex: 0 },
      { name: 'Volume', type: 'bar', data: [], xAxisIndex: 1, yAxisIndex: 1, barWidth: '60%' },
    ],
  };

  chartMerge = signal<EChartsOption>({});

  ngOnInit() {
    this.loadCandles();
    this.startLivePricePolling();
  }

  ngOnDestroy() {
    this.destroy$.next();
    this.destroy$.complete();
  }

  onSymbolChange(symbol: string) {
    this.selectedSymbol.set(symbol);
    this.loading.set(true);
    this.loadCandles();
  }

  onTimeframeChange(tf: string) {
    this.selectedTimeframe.set(tf);
    this.loading.set(true);
    this.loadCandles();
  }

  toggleOverlay(type: 'ma' | 'vol' | 'bb') {
    if (type === 'ma') this.showMA.set(!this.showMA());
    else if (type === 'vol') this.showVolume.set(!this.showVolume());
    else this.showBollinger.set(!this.showBollinger());
    this.buildChartMerge();
  }

  private loadCandles() {
    const sym = this.selectedSymbol().replace(/\//g, '');
    const tf = this.selectedTimeframe();

    this.marketData
      .listCandles({ currentPage: 1, itemCountPerPage: 200, filter: { symbol: sym, timeframe: tf } })
      .pipe(
        catchError(() => of(null)),
        takeUntil(this.destroy$),
      )
      .subscribe((res: any) => {
        let data: CandleDto[] = res?.data?.data ?? [];

        // If backend returns no candles, generate sample data
        if (data.length === 0) {
          data = this.generateSampleCandles();
        }

        this.candles.set(data);
        this.loading.set(false);
        this.buildChartMerge();
      });
  }

  private startLivePricePolling() {
    timer(0, 3000)
      .pipe(
        switchMap(() =>
          this.marketData.getLivePrice(this.selectedSymbol()).pipe(catchError(() => of(null))),
        ),
        takeUntil(this.destroy$),
      )
      .subscribe((res: any) => {
        const price: LivePriceDto | null = res?.data ?? null;
        if (price?.bid) {
          this.previousBid.set(this.livePrice()?.bid ?? 0);
          this.livePrice.set(price);
        }
      });
  }

  private buildChartMerge() {
    const data = this.candles();
    if (data.length === 0) return;

    const dates = data.map(c => this.formatDate(c.timestamp));
    const ohlc = data.map(c => [c.open, c.close, c.low, c.high]);
    const closes = data.map(c => c.close);
    const volumes = data.map(c => ({
      value: c.volume,
      itemStyle: { color: c.close >= c.open ? 'rgba(52,199,89,0.35)' : 'rgba(255,59,48,0.35)' },
    }));

    const ma20 = this.showMA() ? this.calcMA(closes, 20) : [];
    const ma50 = this.showMA() ? this.calcMA(closes, 50) : [];

    let bbUpper: (number | null)[] = [];
    let bbLower: (number | null)[] = [];
    if (this.showBollinger()) {
      const bb = this.calcBollinger(closes, 20, 2);
      bbUpper = bb.upper;
      bbLower = bb.lower;
    }

    // Calculate Y-axis range
    const allPrices = data.flatMap(c => [c.open, c.high, c.low, c.close]);
    const minPrice = Math.min(...allPrices);
    const maxPrice = Math.max(...allPrices);
    const range = maxPrice - minPrice;
    const padding = range > 0 ? range * 0.15 : minPrice * 0.002;

    // Show last 80 candles by default
    const zoomStart = Math.max(0, ((data.length - 80) / data.length) * 100);

    this.chartMerge.set({
      xAxis: [
        { data: dates },
        { data: dates },
      ],
      yAxis: [
        {
          min: +(minPrice - padding).toFixed(this.pricePrecision()),
          max: +(maxPrice + padding).toFixed(this.pricePrecision()),
          axisLabel: { formatter: (v: number) => v.toFixed(this.pricePrecision()) },
        },
        {},
      ],
      dataZoom: [
        { start: zoomStart, end: 100 },
        { start: zoomStart, end: 100 },
      ],
      series: [
        { data: ohlc },
        { data: ma20 },
        { data: ma50 },
        { data: bbUpper },
        { data: bbLower },
        { data: this.showVolume() ? volumes : [] },
      ],
    });
  }

  private calcMA(data: number[], period: number): (number | null)[] {
    return data.map((_, i) => {
      if (i < period - 1) return null;
      const slice = data.slice(i - period + 1, i + 1);
      return slice.reduce((a, b) => a + b, 0) / period;
    });
  }

  private calcBollinger(data: number[], period: number, stdDev: number) {
    const middle = this.calcMA(data, period);
    const upper: (number | null)[] = [];
    const lower: (number | null)[] = [];
    for (let i = 0; i < data.length; i++) {
      if (i < period - 1 || middle[i] === null) {
        upper.push(null);
        lower.push(null);
      } else {
        const slice = data.slice(i - period + 1, i + 1);
        const mean = middle[i]!;
        const variance = slice.reduce((sum, v) => sum + (v - mean) ** 2, 0) / period;
        const sd = Math.sqrt(variance);
        upper.push(mean + stdDev * sd);
        lower.push(mean - stdDev * sd);
      }
    }
    return { upper, lower, middle };
  }

  private formatDate(timestamp: string): string {
    const d = new Date(timestamp);
    const tf = this.selectedTimeframe();
    if (tf === 'D1') return `${d.getMonth() + 1}/${d.getDate()}`;
    if (tf === 'H4' || tf === 'H1') return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:00`;
    return `${d.getHours()}:${d.getMinutes().toString().padStart(2, '0')}`;
  }

  formatVolume(v: number | undefined | null): string {
    if (v == null) return '-';
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
    if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
    return v.toFixed(0);
  }

  private generateSampleCandles(): CandleDto[] {
    const candles: CandleDto[] = [];
    const symbol = this.selectedSymbol();
    const isJPY = symbol.includes('JPY');
    let price = isJPY ? 150.500 : 1.08500;
    const volatility = isJPY ? 0.2 : 0.0008;
    const now = new Date();
    const tfMinutes: Record<string, number> = { M1: 1, M5: 5, M15: 15, H1: 60, H4: 240, D1: 1440 };
    const interval = tfMinutes[this.selectedTimeframe()] ?? 60;

    for (let i = 199; i >= 0; i--) {
      const time = new Date(now.getTime() - i * interval * 60000);
      const change = (Math.random() - 0.48) * volatility;
      const open = price;
      const close = price + change;
      const high = Math.max(open, close) + Math.random() * volatility * 0.5;
      const low = Math.min(open, close) - Math.random() * volatility * 0.5;
      const volume = Math.floor(500 + Math.random() * 2000);
      price = close;

      candles.push({
        id: 200 - i,
        symbol,
        timeframe: this.selectedTimeframe(),
        open: +open.toFixed(isJPY ? 3 : 5),
        high: +high.toFixed(isJPY ? 3 : 5),
        low: +low.toFixed(isJPY ? 3 : 5),
        close: +close.toFixed(isJPY ? 3 : 5),
        volume,
        timestamp: time.toISOString(),
        isClosed: i > 0,
      });
    }
    return candles;
  }
}
