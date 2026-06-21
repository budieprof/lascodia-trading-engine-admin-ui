import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { NgxEchartsDirective } from 'ngx-echarts';
import type { EChartsOption } from 'echarts';
import { catchError, of } from 'rxjs';

import { MarketDataService } from '@core/services/market-data.service';
import { ThemeService } from '@core/theme/theme.service';
import { CandleDto, Timeframe } from '@core/api/api.types';

/**
 * One actionable recommendation to overlay on the chart. Entry/SL/TP are
 * rendered as horizontal mark-lines on the y-axis, coloured by the rec's
 * action. Hold recs (entryPrice == null) are dropped silently — the chart
 * still renders the candle structure so the operator can see the bar the
 * LLM looked at, just without an action overlay.
 */
export interface SpotRecChartRec {
  /** Operator-facing label prefix used on the mark-line, e.g. "#1 Buy". */
  label: string;
  action: 'Buy' | 'Sell' | 'Hold';
  entryPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
}

/**
 * Optional marker rendered as a single ECharts mark-point at a specific
 * (timestamp, price). Used for "filled here" / "exited here" annotations on
 * a live-signal chart. Time MUST be an ISO string that lands inside the
 * candle window; off-window markers are silently dropped.
 */
export interface SpotRecChartMarker {
  time: string;
  price: number;
  label: string;
  /** Visual style. 'fill' = blue triangle; 'tp' = green star; 'sl' = red x. */
  kind: 'fill' | 'tp' | 'sl';
}

/**
 * Reusable candle-with-overlay chart for live spot-analysis + trade-signal
 * surfaces. Fetches a candle window straddling `asOfUtc` (HISTORY_BARS
 * leading bars + forward bars from `ttlBars` or a per-timeframe default)
 * and overlays each recommendation's Entry/SL/TP as horizontal mark-lines
 * plus optional fill/exit mark-points.
 *
 * Distinct from `LlmInvocationModalComponent`'s embedded chart in that
 * this one accepts an ARRAY of recommendations and renders all of them at
 * once — the live spot-analysis can emit up to four ranked setups per
 * invocation, all worth visualising.
 */
@Component({
  selector: 'app-spot-rec-chart',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, NgxEchartsDirective],
  template: `
    @if (loading()) {
      <div class="empty small muted">Loading candles…</div>
    } @else if (chartOptions(); as opts) {
      <div
        echarts
        [options]="opts"
        [theme]="echartsTheme()"
        [autoResize]="true"
        class="chart-instance"
      ></div>
      <!-- Sensitivity-style legend: one row per rec showing the full
           Entry / SL / TP prices with colour swatches matching the chart
           lines. Operator can read the spec at a glance without looking
           up the values on the underlying detail panel. -->
      <div class="chart-legend">
        <span class="legend-item legend-item--asof">
          <span class="dot dot--asof"></span> asOfUtc bar
        </span>
        @for (r of overlayRecs(); track r.label) {
          <span class="legend-item">
            <span class="legend-row">
              <span class="legend-row-title">{{ r.label }}</span>
              @if (r.entryPrice !== null) {
                <span class="legend-row-cell">
                  <span class="dot dot--entry"></span>
                  Entry
                  <span class="legend-row-price">{{
                    r.entryPrice | number: pricePrecisionFormat()
                  }}</span>
                </span>
              }
              @if (r.takeProfit !== null) {
                <span class="legend-row-cell">
                  <span class="dot dot--tp"></span>
                  TP
                  <span class="legend-row-price">{{
                    r.takeProfit | number: pricePrecisionFormat()
                  }}</span>
                </span>
              }
              @if (r.stopLoss !== null) {
                <span class="legend-row-cell">
                  <span class="dot dot--sl"></span>
                  SL
                  <span class="legend-row-price">{{
                    r.stopLoss | number: pricePrecisionFormat()
                  }}</span>
                </span>
              }
            </span>
          </span>
        }
        @if (fillMarker(); as fm) {
          <span class="legend-item"><span class="dot dot--fill"></span> {{ fm.label }}</span>
        }
        @if (exitMarker(); as em) {
          <span class="legend-item">
            <span
              class="dot"
              [class.dot--tp]="em.kind === 'tp'"
              [class.dot--sl]="em.kind === 'sl'"
            ></span>
            {{ em.label }}
          </span>
        }
      </div>
    } @else {
      <div class="empty small muted">No candles available for this window.</div>
    }
  `,
  styles: [
    `
      :host {
        display: block;
      }
      /* Chart pane height tuned to match the Signal Sensitivity Analysis
         page (~440px) so the candle structure + endLabel pills + TP / SL
         zones all read clearly. The shared component is used in both
         drawer-style and modal-style hosts, so it picks the max useful
         height for the modal case; drawer hosts get the same height which
         dominates the panel but matches operator expectations. */
      .chart-instance {
        width: 100%;
        height: 440px;
        min-height: 440px;
      }
      /* Legend separated from the chart by a hairline; sits beneath the
         x-axis labels and presents each rec's full spec in one row. */
      .chart-legend {
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
        font-size: 0.78rem;
        color: var(--text-secondary);
        padding: 0.65rem 0 0;
        margin-top: 0.4rem;
        border-top: 1px solid var(--border);
      }
      .legend-item {
        display: inline-flex;
        align-items: center;
        gap: 0.4rem;
      }
      .legend-item--asof {
        margin-right: 0.4rem;
      }
      /* Each rec's row: title + Entry / TP / SL cells side by side. */
      .legend-row {
        display: inline-flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 0.4rem 1.1rem;
      }
      .legend-row-title {
        font-weight: 600;
        color: var(--text-primary);
        margin-right: 0.5rem;
      }
      .legend-row-cell {
        display: inline-flex;
        align-items: center;
        gap: 0.35rem;
      }
      .legend-row-price {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: 0.78rem;
        color: var(--text-primary);
        font-weight: 600;
      }
      .dot {
        width: 9px;
        height: 9px;
        border-radius: 2px;
        background: var(--text-secondary);
      }
      .dot--asof {
        background: rgba(0, 113, 227, 0.5);
      }
      .dot--buy {
        background: #1f8a3d;
      }
      .dot--sell {
        background: #c4290a;
      }
      .dot--fill {
        background: #0071e3;
      }
      .dot--entry {
        background: #000000;
      }
      .dot--tp {
        background: #1f8a3d;
      }
      .dot--sl {
        background: #c4290a;
      }
      .empty {
        padding: 1.5rem;
        text-align: center;
        color: var(--text-secondary);
        font-size: 13px;
      }
      .small {
        font-size: 11px;
      }
      .muted {
        color: var(--text-secondary);
      }
    `,
  ],
})
export class SpotRecChartComponent {
  private readonly marketData = inject(MarketDataService);
  private readonly theme = inject(ThemeService);

  /** Instrument symbol — e.g. "EURUSD". */
  readonly symbol = input.required<string>();
  /** Timeframe — enum int or stringified label ("H1", "D1", etc.). */
  readonly timeframe = input.required<number | string>();
  /** Anchor instant — the chart highlights the bar at-or-before this time. */
  readonly asOfUtc = input.required<string>();
  /** Setups to overlay. Hold recs are filtered out silently. */
  readonly recommendations = input<SpotRecChartRec[]>([]);
  /**
   * Forward bars to display past `asOfUtc`. Falls back to a sensible
   * per-timeframe default (≈ 6h of forward window for TFs ≤ H1).
   */
  readonly ttlBars = input<number | null>(null);
  /** Optional "filled at" mark-point for signal-detail chart. */
  readonly fillMarker = input<SpotRecChartMarker | null>(null);
  /** Optional "exited at" mark-point for closed-trade chart. */
  readonly exitMarker = input<SpotRecChartMarker | null>(null);

  readonly candles = signal<CandleDto[]>([]);
  readonly loading = signal(false);

  /** ECharts theme — flips with the global dark/light toggle. */
  readonly echartsTheme = computed(() => (this.theme.theme() === 'dark' ? 'dark' : 'default'));

  /**
   * Recs that actually contribute an overlay. Hold recs (entryPrice null)
   * are filtered so the legend stays clean.
   */
  readonly overlayRecs = computed(() =>
    this.recommendations().filter(
      (r) =>
        r.action !== 'Hold' && r.entryPrice != null && r.stopLoss != null && r.takeProfit != null,
    ),
  );

  /**
   * Angular `| number: 'X.Y-Z'` format string matching the chart's
   * auto-precision (3dp for JPY-style pairs > 50, 5dp for majors). Lets
   * the legend render prices at the same scale the chart labels use.
   */
  pricePrecisionFormat(): string {
    const sample = this.overlayRecs()[0]?.entryPrice ?? this.candles()[0]?.close ?? 1;
    return sample > 50 ? '1.3-3' : '1.5-5';
  }

  private lastFetchedKey: string | null = null;

  constructor() {
    effect(() => {
      const sym = this.symbol();
      const tf = this.timeframe();
      const at = this.asOfUtc();
      const ttl = this.ttlBars();
      if (!sym || tf == null || !at) return;
      const key = `${sym}|${tf}|${at}|${ttl ?? '?'}`;
      if (this.lastFetchedKey === key) return;
      this.lastFetchedKey = key;
      this.fetchCandles(sym, tf, at, ttl);
    });
  }

  /**
   * Pull HISTORY_BARS leading bars + `forward` trailing bars straddling
   * `asOfUtc`. The market-data list endpoint orders newest-first; we sort
   * ascending here so the x-axis flows left-to-right. Falls back to an
   * empty candles array on error rather than throwing — the empty-state
   * branch in the template tells the operator what happened.
   */
  private fetchCandles(
    symbol: string,
    tf: number | string,
    asOfUtc: string,
    ttlBars: number | null,
  ): void {
    this.loading.set(true);
    const HISTORY_BARS = 48;
    const forward = Math.min(40, Math.max(8, ttlBars ?? this.defaultForwardBars(tf)));
    const itemCount = HISTORY_BARS + forward;
    this.marketData
      .listCandles({
        currentPage: 1,
        itemCountPerPage: itemCount,
        filter: {
          symbol,
          timeframe: tf as Timeframe,
          to: this.shiftIso(asOfUtc, tf, forward),
        },
      })
      .pipe(catchError(() => of(null)))
      .subscribe((res) => {
        this.loading.set(false);
        const rows = res?.status && res.data ? (res.data.data ?? []) : [];
        const ordered = rows
          .slice()
          .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
        this.candles.set(ordered);
      });
  }

  /**
   * ECharts candlestick over the fetched window with full reference-line
   * overlays. Adopts the Signal Sensitivity Analysis page chart pattern:
   *
   *   - Reference levels rendered as TWO-POINT LINE SERIES from the
   *     asOfUtc bar to the chart's right edge.
   *   - Each level carries an `endLabel` coloured pill ("ENTRY", "TP",
   *     "SL") that sits in the right-side margin.
   *   - TP / SL zones shaded between entry and target on the trade-aligned
   *     side, so the operator sees the risk envelope at a glance.
   *   - Vertical signal-fire line marks the asOfUtc bar.
   *   - Mark-points for optional fill / exit overlays (signal-detail page).
   *   - Multi-rec safe: each rec gets its own colour-coded triple. The
   *     #1 rec uses the canonical Entry/TP/SL colours; #2-#4 fade slightly
   *     so the chart stays legible.
   */
  readonly chartOptions = computed<EChartsOption | null>(() => {
    const rows = this.candles();
    const recs = this.overlayRecs();
    const sym = this.symbol();
    const asAt = this.asOfUtc();
    if (rows.length === 0) return null;

    const categories = rows.map((r) => r.timestamp);
    const candleData: [number, number, number, number][] = rows.map((r) => [
      r.open,
      r.close,
      r.low,
      r.high,
    ]);
    const lastIdx = rows.length - 1;

    // Map asOfUtc to the candle index it landed on.
    const asOfMs = new Date(asAt).getTime();
    const candleMs = rows.map((r) => new Date(r.timestamp).getTime());
    const idxAt = (ms: number): number => {
      if (ms <= candleMs[0]) return 0;
      if (ms >= candleMs[candleMs.length - 1]) return candleMs.length - 1;
      let idx = 0;
      for (let i = 0; i < candleMs.length; i++) {
        if (candleMs[i] <= ms) idx = i;
        else break;
      }
      return idx;
    };
    const signalIdx = idxAt(asOfMs);

    // Price precision auto-fit (JPY-style pairs sit > 50, majors < 2).
    const samplePrice = recs[0]?.entryPrice ?? rows[0]?.close ?? 1;
    const pricePrecision = samplePrice > 50 ? 3 : 5;
    const fmt = (n: number) => n.toFixed(pricePrecision);

    // Y-axis bounds with 15% padding — include every rec price.
    const allYs: number[] = [...rows.map((r) => r.low), ...rows.map((r) => r.high)];
    recs.forEach((rec) => {
      if (rec.entryPrice != null) allYs.push(rec.entryPrice);
      if (rec.stopLoss != null) allYs.push(rec.stopLoss);
      if (rec.takeProfit != null) allYs.push(rec.takeProfit);
    });
    const yMin = Math.min(...allYs);
    const yMax = Math.max(...allYs);
    const yPad = (yMax - yMin) * 0.15;

    const flat = (y: number): [number, number][] => [
      [signalIdx, y],
      [lastIdx, y],
    ];

    // Per-rec endLabel offset — when there are multiple recs we stagger
    // labels vertically by 18px so they don't stack on top of each other.
    const lineSeries: any[] = [];
    const markAreaData: any[][] = [];
    recs.forEach((rec, i) => {
      const isPrimary = i === 0;
      const offset: [number, number] = [0, isPrimary ? 0 : 20 * i];
      const labelPad: [number, number] = isPrimary ? [3, 7] : [2, 6];
      const labelFs = isPrimary ? 11 : 10;
      const lineW = isPrimary ? 2 : 1.5;
      const prefix = recs.length > 1 ? `${rec.label} ` : '';

      if (rec.entryPrice != null) {
        lineSeries.push({
          name: `${rec.label} Entry`,
          type: 'line',
          data: flat(rec.entryPrice),
          symbol: 'none',
          lineStyle: { color: '#000000', width: lineW, type: 'solid' },
          tooltip: { show: false },
          z: 10,
          endLabel: {
            show: true,
            offset,
            formatter: `${prefix}ENTRY ${fmt(rec.entryPrice)}`,
            backgroundColor: '#000000',
            color: '#ffffff',
            padding: labelPad,
            borderRadius: 3,
            fontWeight: 'bold',
            fontSize: labelFs,
          },
        });
      }
      if (rec.takeProfit != null) {
        lineSeries.push({
          name: `${rec.label} TP`,
          type: 'line',
          data: flat(rec.takeProfit),
          symbol: 'none',
          lineStyle: { color: '#1f8a3d', width: lineW, type: 'solid' },
          tooltip: { show: false },
          z: 10,
          endLabel: {
            show: true,
            offset,
            formatter: `${prefix}TP ${fmt(rec.takeProfit)}`,
            backgroundColor: '#1f8a3d',
            color: '#ffffff',
            padding: labelPad,
            borderRadius: 3,
            fontWeight: 'bold',
            fontSize: labelFs,
          },
        });
      }
      if (rec.stopLoss != null) {
        lineSeries.push({
          name: `${rec.label} SL`,
          type: 'line',
          data: flat(rec.stopLoss),
          symbol: 'none',
          lineStyle: { color: '#c4290a', width: lineW, type: 'solid' },
          tooltip: { show: false },
          z: 10,
          endLabel: {
            show: true,
            offset,
            formatter: `${prefix}SL ${fmt(rec.stopLoss)}`,
            backgroundColor: '#c4290a',
            color: '#ffffff',
            padding: labelPad,
            borderRadius: 3,
            fontWeight: 'bold',
            fontSize: labelFs,
          },
        });
      }
      // Only the primary rec gets the shaded TP / SL zones — drawing zones
      // for every rec would overlap into mud.
      if (isPrimary && rec.entryPrice != null && rec.takeProfit != null) {
        markAreaData.push([
          {
            yAxis: rec.entryPrice,
            xAxis: signalIdx,
            itemStyle: { color: 'rgba(31, 138, 61, 0.10)' },
            name: 'TP zone',
          },
          { yAxis: rec.takeProfit, xAxis: lastIdx },
        ]);
      }
      if (isPrimary && rec.entryPrice != null && rec.stopLoss != null) {
        markAreaData.push([
          {
            yAxis: rec.entryPrice,
            xAxis: signalIdx,
            itemStyle: { color: 'rgba(196, 41, 10, 0.10)' },
            name: 'SL zone',
          },
          { yAxis: rec.stopLoss, xAxis: lastIdx },
        ]);
      }
    });

    // Optional fill / exit mark-points (signal-detail page).
    const markPoints: any[] = [];
    const fm = this.fillMarker();
    if (fm) {
      const idx = this.indexFor(rows, fm.time);
      if (idx >= 0) {
        markPoints.push({
          name: fm.label,
          coord: [idx, fm.price],
          symbol: 'triangle',
          symbolSize: 12,
          itemStyle: { color: '#0071e3' },
          label: { formatter: fm.label, position: 'top', fontSize: 10 },
        });
      }
    }
    const em = this.exitMarker();
    if (em) {
      const idx = this.indexFor(rows, em.time);
      if (idx >= 0) {
        markPoints.push({
          name: em.label,
          coord: [idx, em.price],
          symbol: em.kind === 'tp' ? 'diamond' : em.kind === 'sl' ? 'pin' : 'circle',
          symbolSize: 14,
          itemStyle: {
            color: em.kind === 'tp' ? '#1f8a3d' : em.kind === 'sl' ? '#c4290a' : '#6e6e73',
          },
          label: { formatter: em.label, position: 'top', fontSize: 10 },
        });
      }
    }

    return <EChartsOption>{
      animation: false,
      // Right margin = 110px so the colour-coded endLabel pills have room.
      grid: { left: 60, right: 110, top: 20, bottom: 40, containLabel: true },
      tooltip: { trigger: 'axis', axisPointer: { type: 'cross' } },
      xAxis: {
        type: 'category',
        data: categories,
        boundaryGap: true,
        axisLabel: {
          hideOverlap: true,
          formatter: (v: string) => {
            const d = new Date(v);
            return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
          },
          fontSize: 10,
        },
        splitLine: { show: false },
      },
      yAxis: {
        type: 'value',
        scale: true,
        min: yMin - yPad,
        max: yMax + yPad,
        axisLabel: { formatter: (val: number) => val.toFixed(pricePrecision) },
        splitLine: { show: true },
      },
      series: [
        {
          name: sym,
          type: 'candlestick',
          data: candleData,
          itemStyle: {
            color: '#1f8a3d',
            color0: '#c4290a',
            borderColor: '#1f8a3d',
            borderColor0: '#c4290a',
          },
          z: 5,
          markArea: markAreaData.length ? { silent: true, z: 0, data: markAreaData } : undefined,
          markPoint: markPoints.length ? { silent: true, data: markPoints } : undefined,
          markLine: {
            symbol: 'none',
            z: 12,
            data: [
              {
                xAxis: signalIdx,
                lineStyle: { color: '#0071e3', type: 'solid', width: 2, opacity: 0.9 },
                label: {
                  show: true,
                  formatter: 'asOfUtc',
                  position: 'insideStartTop',
                  color: '#ffffff',
                  backgroundColor: '#0071e3',
                  padding: [3, 6],
                  borderRadius: 3,
                  fontWeight: 'bold',
                  fontSize: 11,
                },
              },
            ],
          },
        },
        ...lineSeries,
      ],
    };
  });

  /** Locate the rendered x-axis index of the candle whose timestamp lands at-or-before `iso`. */
  private indexFor(rows: CandleDto[], iso: string): number {
    const ms = new Date(iso).getTime();
    let idx = -1;
    for (let i = 0; i < rows.length; i++) {
      if (new Date(rows[i].timestamp).getTime() <= ms) idx = i;
    }
    return idx;
  }

  private shiftIso(iso: string, tf: number | string, bars: number): string {
    const mins = this.timeframeMinutes(tf);
    const d = new Date(iso);
    d.setUTCMinutes(d.getUTCMinutes() + mins * bars);
    return d.toISOString();
  }

  private timeframeMinutes(tf: number | string): number {
    if (typeof tf === 'string') {
      switch (tf) {
        case 'M1':
          return 1;
        case 'M5':
          return 5;
        case 'M15':
          return 15;
        case 'H1':
          return 60;
        case 'H4':
          return 240;
        case 'D1':
          return 1440;
        default:
          return 60;
      }
    }
    const map: Record<number, number> = { 0: 1, 1: 5, 2: 15, 3: 60, 4: 240, 5: 1440 };
    return map[tf] ?? 60;
  }

  private defaultForwardBars(tf: number | string): number {
    const mins = this.timeframeMinutes(tf);
    if (mins <= 60) return Math.max(8, Math.round(360 / mins));
    if (mins <= 240) return 6;
    return 5;
  }
}
