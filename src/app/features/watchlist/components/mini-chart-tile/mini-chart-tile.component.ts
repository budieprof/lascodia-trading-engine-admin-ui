import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  Output,
  computed,
  effect,
  inject,
  input,
  signal,
  OnDestroy,
  OnInit,
} from '@angular/core';
import { Router } from '@angular/router';
import { NgxEchartsDirective } from 'ngx-echarts';
import type { EChartsOption } from 'echarts';
import { Subject, takeUntil, timer, switchMap, catchError, of } from 'rxjs';
import { animate, AnimationTriggerMetadata, style, transition, trigger } from '@angular/animations';

import { MarketDataService } from '@core/services/market-data.service';
import type { CandleDto, LivePriceDto } from '@core/api/api.types';

/**
 * One symbol tile on the watchlist grid. Self-contained: owns its own
 * candle + live-price polling loops, builds its own ECharts options, and
 * persists nothing — the parent passes (symbol, timeframe) as inputs and
 * listens for `remove` / `open` outputs.
 *
 * Lighter than the full chart (no toolbar, no insights, no indicators) so
 * the page can render 10–20 tiles without burning the browser. Each tile
 * polls live prices every 5s and candles every 30s — closed bars churn
 * slow enough that 30s gives a snappy enough feel without flooding the API.
 *
 * Click anywhere on the tile body opens the full chart at this pair via
 * the deep-link hand-off ({@link DEEP_LINK_KEY}); the X button stops
 * propagation and removes the tile instead.
 */
const DEEP_LINK_KEY = 'tradingChart.deepLink.v1';

type TileSize = 'sm' | 'md' | 'lg' | 'xl';

/**
 * Brief "I just changed" flash on the bid / ask / spread numbers. The
 * Angular animation runs `* => *` so it fires every time the bound
 * expression's value changes — exactly when the operator should notice
 * the tick. Easing curve picked to feel like a soft glow rather than a
 * harsh blink.
 */
const PRICE_FLASH_TRIGGER: AnimationTriggerMetadata = trigger('priceFlash', [
  transition('* => *', [
    style({ backgroundColor: 'rgba(255, 255, 255, 0.18)' }),
    animate('420ms cubic-bezier(0.22, 0.61, 0.36, 1)', style({ backgroundColor: 'transparent' })),
  ]),
]);

@Component({
  selector: 'app-mini-chart-tile',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgxEchartsDirective],
  animations: [PRICE_FLASH_TRIGGER],
  template: `
    <article
      class="tile"
      [attr.data-size]="size()"
      (click)="openInChart()"
      role="button"
      tabindex="0"
    >
      <header class="tile-head">
        <div class="tile-id">
          <strong class="symbol">{{ formatSymbolDisplay(symbol()) }}</strong>
          <span class="tf-pill">{{ timeframe() }}</span>
        </div>
        @if (changePct(); as pct) {
          <span class="change" [class.up]="pct > 0" [class.down]="pct < 0">
            {{ pct > 0 ? '+' : '' }}{{ pct.toFixed(2) }}%
          </span>
        }
        <button
          type="button"
          class="tile-remove"
          (click)="onRemoveClick($event)"
          [title]="'Remove ' + symbol() + ' from watchlist'"
          aria-label="Remove from watchlist"
        >
          ×
        </button>
      </header>

      <div class="tile-prices">
        @if (livePrice(); as p) {
          <span class="px-row" [attr.data-side]="'bid'">
            <span class="px-label">Bid</span>
            <span class="px-value-wrap" [@priceFlash]="p.bid">
              <span class="px-value mono px-bid" [attr.data-trend]="bidTrend()">{{
                formatPrice(p.bid)
              }}</span>
              <span
                class="px-trend"
                [attr.data-trend]="bidTrend()"
                [attr.aria-label]="
                  bidTrend() === 'up' ? 'tick up' : bidTrend() === 'down' ? 'tick down' : ''
                "
                >{{ bidTrend() === 'up' ? '▲' : bidTrend() === 'down' ? '▼' : '·' }}</span
              >
            </span>
          </span>
          <span class="px-row" [attr.data-side]="'ask'">
            <span class="px-label">Ask</span>
            <span class="px-value-wrap" [@priceFlash]="p.ask">
              <span class="px-value mono px-ask" [attr.data-trend]="askTrend()">{{
                formatPrice(p.ask)
              }}</span>
              <span
                class="px-trend"
                [attr.data-trend]="askTrend()"
                [attr.aria-label]="
                  askTrend() === 'up' ? 'tick up' : askTrend() === 'down' ? 'tick down' : ''
                "
                >{{ askTrend() === 'up' ? '▲' : askTrend() === 'down' ? '▼' : '·' }}</span
              >
            </span>
          </span>
          <span class="px-row">
            <span class="px-label">Spread</span>
            <span class="px-value-wrap" [@priceFlash]="formatSpreadPips(p)">
              <span class="px-value mono px-spread">{{ formatSpreadPips(p) }}p</span>
            </span>
          </span>
        } @else if (loading() && candles().length === 0) {
          <span class="px-row muted">Loading…</span>
        } @else {
          <span class="px-row muted">No feed</span>
        }
      </div>

      <div class="tile-chart">
        @if (candles().length > 0) {
          <div class="chart-host" echarts [options]="chartOptions()" [autoResize]="true"></div>
        } @else {
          <div class="chart-empty muted">
            {{ loading() ? 'Loading candles…' : 'No candles' }}
          </div>
        }
      </div>

      <footer class="tile-foot">
        <span class="muted small">
          {{ candles().length }} bar{{ candles().length === 1 ? '' : 's' }}
        </span>
        @if (lastBarAgeLabel(); as age) {
          <span class="muted small">· {{ age }}</span>
        }
        <span class="spacer"></span>
        <span class="open-hint muted small">Open ↗</span>
      </footer>
    </article>
  `,
  styles: [
    `
      .tile {
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 10px 12px;
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        cursor: pointer;
        transition:
          border-color 0.12s ease,
          background 0.12s ease,
          box-shadow 0.12s ease;
        min-height: 220px;
      }
      .tile:hover,
      .tile:focus-visible {
        border-color: var(--accent, #0071e3);
        background: var(--bg-elevated, var(--bg-secondary));
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.04);
        outline: none;
      }

      .tile-head {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .tile-id {
        display: inline-flex;
        align-items: baseline;
        gap: 6px;
      }
      .symbol {
        font-size: 14px;
        font-weight: var(--font-bold);
        color: var(--text-primary);
        letter-spacing: 0.02em;
      }
      .tf-pill {
        font-size: 10px;
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-secondary);
        background: var(--bg-tertiary);
        padding: 1px 6px;
        border-radius: var(--radius-full);
      }
      .change {
        margin-left: auto;
        font-size: 12px;
        font-weight: var(--font-semibold);
        color: var(--text-secondary);
        font-variant-numeric: tabular-nums;
      }
      .change.up {
        color: #1d8a3e;
      }
      .change.down {
        color: #c93631;
      }
      .tile-remove {
        appearance: none;
        background: transparent;
        border: none;
        color: var(--text-tertiary);
        font-size: 16px;
        line-height: 1;
        cursor: pointer;
        padding: 2px 6px;
        border-radius: var(--radius-sm);
        margin-left: 4px;
      }
      .tile-remove:hover {
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }

      .tile-prices {
        display: grid;
        grid-template-columns: 1fr 1fr 1fr;
        gap: 4px 8px;
        font-size: 11px;
      }
      .px-row {
        display: inline-flex;
        flex-direction: column;
        gap: 1px;
      }
      .px-label {
        font-size: 9px;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--text-tertiary);
      }
      /* Wrapper sits between label and value so the Angular animation
         trigger has a stable element to flash on every tick — the
         keyframe sweeps a faint highlight across this wrapper instead
         of the value text itself. Padding gives the highlight some
         visible surface area without changing layout. */
      .px-value-wrap {
        display: inline-flex;
        align-items: baseline;
        gap: 4px;
        padding: 1px 4px;
        margin-left: -4px;
        border-radius: var(--radius-sm);
      }
      .px-value {
        font-size: 12px;
        font-variant-numeric: tabular-nums;
        font-weight: var(--font-semibold);
        transition: color 200ms ease;
      }
      /* Direction-coloured prices: green BID base, red ASK base, with
         the trend arrow shifting between a brighter / dimmer hue when
         the value actually moves vs sits flat. Picks up the same
         green/red palette as the chart's BID/ASK lines so a glance at
         the header matches the eye-line on the candles. */
      .px-bid {
        color: #1d8a3e;
      }
      .px-bid[data-trend='up'] {
        color: #1eaa4a;
      }
      .px-bid[data-trend='down'] {
        color: #166e31;
      }
      .px-ask {
        color: #c93631;
      }
      .px-ask[data-trend='up'] {
        color: #e23e38;
      }
      .px-ask[data-trend='down'] {
        color: #a82a26;
      }
      .px-spread {
        color: var(--text-primary);
      }
      .px-trend {
        font-size: 8px;
        line-height: 1;
        transition:
          color 200ms ease,
          opacity 200ms ease;
      }
      .px-trend[data-trend='up'] {
        color: #1d8a3e;
        opacity: 1;
      }
      .px-trend[data-trend='down'] {
        color: #c93631;
        opacity: 1;
      }
      .px-trend[data-trend='flat'] {
        color: var(--text-tertiary);
        opacity: 0.4;
      }

      .tile-chart {
        flex: 1;
        min-height: 90px;
      }
      /* Size presets: chart-host gets taller, candles inherently get wider
         because the parent grid's minmax also scales with size. */
      .tile[data-size='sm'] .chart-host,
      .tile[data-size='sm'] .chart-empty {
        height: 110px;
      }
      .tile[data-size='md'] .chart-host,
      .tile[data-size='md'] .chart-empty {
        height: 160px;
      }
      .tile[data-size='lg'] .chart-host,
      .tile[data-size='lg'] .chart-empty {
        height: 240px;
      }
      .tile[data-size='xl'] .chart-host,
      .tile[data-size='xl'] .chart-empty {
        height: 340px;
      }
      /* Larger tiles get a slightly taller symbol header so the bigger
         chart doesn't dwarf the metadata strip. */
      .tile[data-size='lg'] .symbol,
      .tile[data-size='xl'] .symbol {
        font-size: 15px;
      }
      .tile[data-size='lg'] .px-value,
      .tile[data-size='xl'] .px-value {
        font-size: 13px;
      }
      .chart-host {
        width: 100%;
      }
      .chart-empty {
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 11px;
        border: 1px dashed var(--border);
        border-radius: var(--radius-sm);
      }

      .tile-foot {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .spacer {
        flex: 1;
      }
      .open-hint {
        color: var(--accent, #0071e3);
        font-weight: var(--font-semibold);
      }
      .muted {
        color: var(--text-tertiary);
      }
      .small {
        font-size: 11px;
      }
      .mono {
        font-family: var(--font-mono, ui-monospace, monospace);
      }
    `,
  ],
})
export class MiniChartTileComponent implements OnInit, OnDestroy {
  // Inputs from parent — the (symbol, timeframe) pair this tile watches.
  // Symbol is the raw form ("EURUSD"); display formatting adds the slash.
  readonly symbol = input.required<string>();
  readonly timeframe = input.required<string>();
  /** Wall-density preset chosen on the parent toolbar. Drives the chart
   *  area height (so individual candles get wider) and is reflected as
   *  a `data-size` attribute on the host article for layout-level
   *  tweaks. Default `md` gives ~160 px of chart at the parent's
   *  responsive grid column width. */
  readonly size = input<TileSize>('md');
  /** How many candles to fetch and render. The parent owns the
   *  selector and persists the choice; the tile just re-fetches when
   *  this changes (so a click on the toolbar's Bars group lands data
   *  immediately, not on the next 30 s tick). */
  readonly barCount = input<number>(60);

  @Output() readonly remove = new EventEmitter<void>();

  private readonly marketData = inject(MarketDataService);
  private readonly router = inject(Router);
  private readonly destroy$ = new Subject<void>();

  protected readonly candles = signal<CandleDto[]>([]);
  protected readonly livePrice = signal<LivePriceDto | null>(null);
  protected readonly loading = signal(true);
  /**
   * Previous bid / ask, captured at the START of each live-price tick
   * so we can compute a direction arrow (up / down / flat) for the
   * value. Read by the trend computeds below; updated by the same
   * subscription that sets `livePrice`.
   */
  protected readonly previousBid = signal<number | null>(null);
  protected readonly previousAsk = signal<number | null>(null);

  protected readonly bidTrend = computed<'up' | 'down' | 'flat'>(() => {
    const cur = this.livePrice()?.bid;
    const prev = this.previousBid();
    if (cur == null || prev == null || cur === prev) return 'flat';
    return cur > prev ? 'up' : 'down';
  });

  protected readonly askTrend = computed<'up' | 'down' | 'flat'>(() => {
    const cur = this.livePrice()?.ask;
    const prev = this.previousAsk();
    if (cur == null || prev == null || cur === prev) return 'flat';
    return cur > prev ? 'up' : 'down';
  });

  /**
   * Latest-tick wall-clock so the "x s ago" label refreshes without
   * forcing a full re-render of the chart. Bumped on each successful
   * price/candle poll; templates derive lastBarAgeLabel from this.
   */
  protected readonly lastTickMs = signal<number>(0);

  constructor() {
    // Re-fetch candles whenever the operator changes the bar-count
    // selector on the parent toolbar. Without this, the new count would
    // only land on the NEXT 30 s candle tick — clicking "500 bars" and
    // waiting 28 s for the chart to widen would feel broken.
    effect(() => {
      const n = this.barCount();
      // The first effect-run fires during construction before ngOnInit's
      // timer kicks in; that's fine — both paths funnel into fetchCandles
      // which is idempotent.
      this.fetchCandles(n);
    });
  }

  ngOnInit(): void {
    // Cadences mirror the main Market Data chart's startLivePricePolling
    // pattern (trading-chart.component.ts) so a tile feels exactly as
    // alive as the full chart:
    //   - live price (3 s) — drives the bid/ask + spread chips AND
    //     paints the live tick onto the in-progress (rightmost) candle
    //     via `patchLastCandleWithTick`. The last bar breathes between
    //     server-side candle refreshes.
    //   - candles (60 s)   — periodic re-fetch keeps the patched last
    //     candle honest with the server's bar transitions; without
    //     this the patched bar would drift forever and never roll
    //     into a new one. 60 s is the main chart's value too — low
    //     enough that intra-bar painting stays close to truth, high
    //     enough that we don't flood the API just to redraw history.
    // Initial candle fetch already happens in the constructor's
    // `effect`; the timer below kicks subsequent refreshes.
    timer(0, 3_000)
      .pipe(
        switchMap(() =>
          this.marketData.getLivePrice(this.symbol()).pipe(catchError(() => of(null))),
        ),
        takeUntil(this.destroy$),
      )
      .subscribe((res) => {
        if (res?.status && res.data) {
          // Capture the prior bid/ask BEFORE swapping in the new price
          // so the trend computeds (up / down / flat) reflect this
          // tick's movement, not the next one's.
          const prev = this.livePrice();
          if (prev) {
            this.previousBid.set(prev.bid);
            this.previousAsk.set(prev.ask);
          }
          this.livePrice.set(res.data);
          this.lastTickMs.set(Date.now());
          // Paint the live tick onto the rightmost candle — the same
          // trick the main trading chart uses to keep the chart
          // breathing between candle re-fetches.
          this.patchLastCandleWithTick(res.data.bid);
        }
      });
    timer(60_000, 60_000)
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => this.fetchCandles(this.barCount()));
  }

  /**
   * Update the rightmost candle's high/low/close to reflect a live tick.
   * Mirrors the main trading chart's helper of the same name — direct
   * mutation of `candles()` instead of a separate "liveCandles" computed
   * keeps the chart options graph simple AND lets ECharts diff the
   * series cheaply: only the last data point changes, the rest stay
   * identical.
   *
   * Doesn't try to roll into a new bar on its own — the periodic
   * `fetchCandles` re-fetch above brings fresh server-side bars in.
   * Until then, the current bar simply keeps growing, which matches
   * what an operator expects to see between candle closes.
   */
  private patchLastCandleWithTick(tickPrice: number): void {
    if (!Number.isFinite(tickPrice) || tickPrice <= 0) return;
    const data = this.candles();
    if (data.length === 0) return;
    const last = data[data.length - 1];
    // Skip when the tick is already covered by the existing OHLC range
    // — no visual change, no allocation of a new array.
    if (last.close === tickPrice && last.high >= tickPrice && last.low <= tickPrice) return;
    const updated: CandleDto = {
      ...last,
      close: tickPrice,
      high: Math.max(last.high, tickPrice),
      low: Math.min(last.low, tickPrice),
    };
    this.candles.set([...data.slice(0, -1), updated]);
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  private fetchCandles(n: number): void {
    this.marketData
      .listCandles({
        currentPage: 1,
        itemCountPerPage: n,
        filter: { symbol: this.symbol(), timeframe: this.timeframe() },
      })
      .pipe(
        catchError(() => of(null)),
        takeUntil(this.destroy$),
      )
      .subscribe((res) => {
        this.loading.set(false);
        const data = res?.data?.data ?? [];
        if (data.length > 0) {
          // Engine returns newest-first — ECharts wants oldest-first on
          // the time axis. Reverse once here so the rest of the
          // component can think left-to-right = past-to-future.
          this.candles.set([...data].reverse());
        }
      });
  }

  // ── Derived display state ────────────────────────────────────────

  /**
   * % change since the OPEN of the FIRST candle in the visible window.
   * Reasonable proxy for "how is this pair doing today" without needing
   * a true session anchor — the watchlist is for at-a-glance triage, not
   * compliance reporting.
   */
  protected readonly changePct = computed<number | null>(() => {
    const xs = this.candles();
    if (xs.length === 0) return null;
    const first = xs[0].open;
    if (first === 0) return null;
    const last = this.livePrice()?.bid ?? xs[xs.length - 1].close;
    return ((last - first) / first) * 100;
  });

  protected readonly chartOptions = computed<EChartsOption>(() => {
    // `candles()` is mutated in place by patchLastCandleWithTick on every
    // 3 s live-price tick — the rightmost bar's OHLC updates with the
    // market so the chart breathes between server-side fetches. No
    // separate liveCandles computed needed; ECharts diffs the candle
    // series and only redraws the last data point.
    const xs = this.candles();
    if (xs.length === 0) return {};
    const data = xs.map((c) => [c.open, c.close, c.low, c.high]);
    const labels = xs.map((c) => c.timestamp);

    // Read the live price inside the computed so the chart redraws on
    // every 5 s tick.
    const lp = this.livePrice();
    const dp = this.symbol().includes('JPY') ? 3 : 5;
    const haveLive = !!lp && Number.isFinite(lp.bid) && Number.isFinite(lp.ask);

    // Explicit y-range derived from the candles plus a 5 % padding
    // band on each side. The main trading chart uses this same pattern
    // for a reason: with `scale: true`, ECharts auto-fits the range to
    // include every series — bid/ask lines included — which lets the
    // bid/ask values silently distort the candle scale on every tick.
    // Pinning the range to candle min/max keeps the chart visually
    // stable while still letting the bid/ask lines float to wherever
    // the live price sits inside that band (or slightly outside, when
    // price has moved past the last closed bar's extremes).
    let minPrice = Infinity;
    let maxPrice = -Infinity;
    for (const c of xs) {
      if (c.low < minPrice) minPrice = c.low;
      if (c.high > maxPrice) maxPrice = c.high;
    }
    const padding = (maxPrice - minPrice) * 0.05 || maxPrice * 0.0005;

    // Bid + ask as dedicated FLAT line series — one constant value
    // across every candle index. Same pattern the main trading chart
    // uses (see chartInitOptions there): avoids the ECharts markLine
    // merge-cache bug that pins the first tick's pixel coordinates and
    // never updates them on subsequent ticks, AND lets `endLabel.offset`
    // push the two labels apart vertically by a fixed pixel amount —
    // crucial for FX pairs where bid/ask collapse to one pixel.
    const bidLineData = haveLive ? xs.map(() => lp!.bid) : [];
    const askLineData = haveLive ? xs.map(() => lp!.ask) : [];

    return {
      animation: false,
      // Reserve right-side space for the BID/ASK pill labels so they
      // don't clip against the tile edge.
      grid: { left: 4, right: 64, top: 8, bottom: 4, containLabel: false },
      xAxis: {
        type: 'category',
        data: labels,
        axisLine: { show: false },
        axisLabel: { show: false },
        axisTick: { show: false },
        splitLine: { show: false },
      },
      yAxis: {
        type: 'value',
        // Explicit min/max derived from candles only — the bid/ask
        // line series don't get to widen the y-range.
        min: +(minPrice - padding).toFixed(dp),
        max: +(maxPrice + padding).toFixed(dp),
        axisLine: { show: false },
        axisLabel: { show: false },
        axisTick: { show: false },
        splitLine: {
          show: true,
          lineStyle: {
            color: 'rgba(128, 128, 128, 0.28)',
            type: 'dashed',
            width: 1,
          },
        },
        splitNumber: 4,
      },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross' },
        confine: true,
        textStyle: { fontSize: 10 },
        formatter: (params: unknown) => {
          // Tooltip targets the candlestick only — find the candle
          // payload in the array of hovered series.
          const arr = Array.isArray(params) ? params : [params];
          const cs = arr.find((p) => (p as { seriesType?: string }).seriesType === 'candlestick');
          const v = (cs as { value?: number[] } | undefined)?.value;
          if (!v || v.length < 4) return '';
          // ECharts passes candle values back as [_, open, close, low, high]
          // when the source data was [open, close, low, high]. Read by
          // index from the back so we work regardless of any leading
          // category column ECharts may prepend.
          const open = v[v.length - 4];
          const close = v[v.length - 3];
          const low = v[v.length - 2];
          const high = v[v.length - 1];
          return `O ${open.toFixed(dp)} · H ${high.toFixed(dp)} · L ${low.toFixed(dp)} · C ${close.toFixed(dp)}`;
        },
      },
      series: [
        {
          type: 'candlestick',
          data,
          itemStyle: {
            color: 'rgba(52, 199, 89, 0.85)',
            color0: 'rgba(201, 54, 49, 0.85)',
            borderColor: '#1d8a3e',
            borderColor0: '#c93631',
            borderWidth: 1,
          },
          barWidth: '60%',
        },
        // BID overlay — flat line + pill label. `offset: [0, 12]`
        // pushes the label 12 px DOWN so even when bid/ask render on
        // the same pixel row the bid pill sits beneath the ask pill.
        {
          name: 'Bid',
          type: 'line',
          data: bidLineData,
          symbol: 'none',
          silent: true,
          animation: false,
          smooth: false,
          lineStyle: { color: '#1d8a3e', width: 1, type: 'solid', opacity: 0.9 },
          endLabel: {
            show: haveLive,
            formatter: haveLive ? `BID ${lp!.bid.toFixed(dp)}` : '',
            backgroundColor: '#1d8a3e',
            color: '#fff',
            padding: [2, 6],
            borderRadius: 3,
            fontSize: 9,
            fontWeight: 600,
            offset: [0, 12],
          },
          z: 5,
        },
        // ASK overlay — `offset: [0, -12]` pushes the label 12 px UP
        // so it sits above the bid pill.
        {
          name: 'Ask',
          type: 'line',
          data: askLineData,
          symbol: 'none',
          silent: true,
          animation: false,
          smooth: false,
          lineStyle: { color: '#c93631', width: 1, type: 'solid', opacity: 0.9 },
          endLabel: {
            show: haveLive,
            formatter: haveLive ? `ASK ${lp!.ask.toFixed(dp)}` : '',
            backgroundColor: '#c93631',
            color: '#fff',
            padding: [2, 6],
            borderRadius: 3,
            fontSize: 9,
            fontWeight: 600,
            offset: [0, -12],
          },
          z: 5,
        },
      ],
    };
  });

  protected lastBarAgeLabel(): string | null {
    const xs = this.candles();
    if (xs.length === 0) return null;
    const lastBarTs = xs[xs.length - 1].timestamp;
    const ms = Date.now() - new Date(lastBarTs).getTime();
    if (ms < 0) return null;
    const sec = Math.floor(ms / 1000);
    if (sec < 60) return `${sec}s old`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m old`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h old`;
    const days = Math.floor(hr / 24);
    return `${days}d old`;
  }

  // ── Formatters ───────────────────────────────────────────────────

  /**
   * Insert a "/" between base and quote so the tile header reads "EUR/USD"
   * while internal state stays canonical "EURUSD". Falls back to raw input
   * for non-6-char symbols (futures legs, indices, etc.).
   */
  protected formatSymbolDisplay(s: string): string {
    if (s.length === 6) return `${s.slice(0, 3)}/${s.slice(3)}`;
    return s;
  }

  /**
   * Render a price with the dynamic precision of the symbol. JPY pairs
   * have 3 decimals; non-JPY FX pairs have 5. Default 5.
   */
  protected formatPrice(p: number): string {
    const sym = this.symbol();
    const dp = sym.includes('JPY') ? 3 : 5;
    return p.toFixed(dp);
  }

  /**
   * Convert the raw price-difference spread on the LivePriceDto into
   * pips and format to 1 dp. The engine emits `spread` as a raw decimal
   * (`ask - bid` in price units), so a 2-pip EURUSD spread arrives as
   * 0.00020 and a naive `.toFixed(1)` reads "0.0" — operator-hostile.
   * Computing from `ask - bid` directly is identical math but resilient
   * to any future API change that re-interprets the `spread` field.
   *
   * Pip size: JPY-quoted pairs use 0.01; everything else uses 0.0001.
   */
  protected formatSpreadPips(p: LivePriceDto): string {
    const pip = this.symbol().includes('JPY') ? 0.01 : 0.0001;
    const pips = (p.ask - p.bid) / pip;
    return pips.toFixed(1);
  }

  // ── Interaction ──────────────────────────────────────────────────

  protected onRemoveClick(ev: MouseEvent): void {
    ev.stopPropagation();
    this.remove.emit();
  }

  /**
   * Hand the (symbol, timeframe) off to the full chart page via a one-shot
   * localStorage key the chart consumes + clears in its own ngOnInit.
   * Cleaner than threading query params through every chart consumer.
   *
   * Also flags a one-shot view-transition intent ("slide-left") that
   * `onViewTransitionCreated` in app.config.ts picks up and applies as a
   * horizontal slide — the tile feels like it's sliding off-screen left
   * while the full chart slides in from the right. Default fade-in-up
   * stays in effect for every other navigation.
   */
  openInChart(): void {
    try {
      localStorage.setItem(
        DEEP_LINK_KEY,
        JSON.stringify({ symbol: this.symbol(), timeframe: this.timeframe() }),
      );
      sessionStorage.setItem('lascodia.viewTransition.next', 'slide-left');
    } catch {
      /* best-effort */
    }
    this.router.navigateByUrl('/market-data');
  }
}
