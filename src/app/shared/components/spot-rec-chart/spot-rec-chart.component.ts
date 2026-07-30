import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { NgxEchartsDirective } from 'ngx-echarts';
import type { EChartsOption } from 'echarts';
import { catchError, of } from 'rxjs';

import { MarketDataService } from '@core/services/market-data.service';
import { RealtimeService } from '@core/realtime/realtime.service';
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
      <!-- Sensitivity-style legend: one row per rec showing the full
           Entry / SL / TP prices with colour swatches matching the chart
           lines. Rendered as a HEADER above the chart so the spec reads at a
           glance and the chart's x-axis sits flush at the bottom. -->
      <div class="chart-legend" [class.collapsed]="collapsible() && collapsed()">
        @if (collapsible()) {
          <button
            type="button"
            class="legend-collapse"
            [class.is-collapsed]="collapsed()"
            [attr.aria-expanded]="!collapsed()"
            [title]="collapsed() ? 'Expand chart' : 'Collapse chart'"
            (click)="collapsed.set(!collapsed())"
          >
            ▾
          </button>
        }
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
        <!-- Optional host-projected actions (e.g. a Create-signal button),
             pushed to the right of the legend row. -->
        <span class="legend-actions"><ng-content select="[legendActions]"></ng-content></span>
      </div>
      @if (!collapsible() || !collapsed()) {
        <div
          echarts
          [options]="opts"
          [theme]="echartsTheme()"
          [autoResize]="true"
          class="chart-instance"
        ></div>
      }
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
        height: 470px;
        min-height: 470px;
      }
      /* Legend as a header above the chart, separated by a hairline; a single
         horizontal row (asOfUtc + each rec's full spec) that wraps only when
         the container is too narrow. */
      .chart-legend {
        display: flex;
        flex-direction: row;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.35rem 1.1rem;
        font-size: 0.78rem;
        color: var(--text-secondary);
        padding: 0 0 0.65rem;
        margin-bottom: 0.4rem;
        border-bottom: 1px solid var(--border);
      }
      .legend-item {
        display: inline-flex;
        align-items: center;
        gap: 0.4rem;
      }
      /* Host-projected actions sit at the far right of the legend row. Empty
         when nothing is projected (margin-left:auto is harmless then). */
      .legend-actions {
        margin-left: auto;
        display: inline-flex;
        align-items: center;
        gap: 8px;
      }
      /* Accordion-style collapse toggle: a chevron that rotates to a right-
         pointing caret when the chart is collapsed. */
      .legend-collapse {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 26px;
        height: 26px;
        padding: 0;
        border: 1px solid var(--border);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: 1.05rem;
        line-height: 1;
        cursor: pointer;
        border-radius: var(--radius-sm, 4px);
        transition: transform 0.15s ease;
      }
      .legend-collapse:hover {
        color: var(--text-primary);
        background: var(--bg-tertiary, rgba(0, 0, 0, 0.05));
        border-color: var(--accent);
      }
      .legend-collapse.is-collapsed {
        transform: rotate(-90deg);
      }
      /* When collapsed there is no chart beneath — drop the header's separating
         rule + spacing so it reads as a plain compact strip. */
      .chart-legend.collapsed {
        border-bottom: none;
        margin-bottom: 0;
        padding-bottom: 0;
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
  private readonly realtime = inject(RealtimeService);
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
  /** Leading (history) bars shown before `asOfUtc`. Default 48; callers with a
   *  bar-count control (e.g. the conversations chart) override it. */
  readonly historyBars = input<number>(48);
  /** When true, the Entry/SL/TP lines span the FULL chart width and the TP/SL
   *  zones also extend LEFT of the signal-fire line (fainter, "pre-signal").
   *  Default false keeps the post-signal-only envelope other callers rely on. */
  readonly fullWidthLevels = input<boolean>(false);
  /** Optional "filled at" mark-point for signal-detail chart. */
  readonly fillMarker = input<SpotRecChartMarker | null>(null);
  /** Optional "exited at" mark-point for closed-trade chart. */
  readonly exitMarker = input<SpotRecChartMarker | null>(null);
  /** Show an accordion-style collapse toggle on the legend header so the
   *  operator can hide the ~440px chart pane to free up space. Off by default;
   *  the legend (spec + projected actions) stays visible when collapsed. */
  readonly collapsible = input<boolean>(false);
  /** Opt in to a LIVE price stream: the chart joins the symbol's price room over
   *  the realtime hub and overlays a dashed "LIVE" line that updates ~1 Hz, so the
   *  operator can watch price approach the Entry / SL / TP levels. Off by default —
   *  historical/snapshot charts (e.g. the per-rec cards in chat) stay static. */
  readonly live = input<boolean>(false);
  /** Pan/zoom affordances matching the Signal Sensitivity chart: an inside
   *  (wheel + drag) zoom plus a bottom overview slider, and a rich OHLC
   *  crosshair tooltip. On by default so every host reads and behaves like the
   *  sensitivity page; set false for compact/embedded uses that want a static
   *  frame. */
  readonly zoomable = input<boolean>(true);

  /** Whether the chart pane is currently collapsed (only meaningful when
   *  `collapsible` is true). */
  protected readonly collapsed = signal(false);

  /** Latest streamed mid price for the current symbol (null until the first
   *  tick / when `live` is off). Rendered as the dashed LIVE mark-line. */
  readonly livePrice = signal<number | null>(null);
  /** Symbol currently joined to a price room, so we can leave it on switch. */
  private subscribedSymbol: string | null = null;

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
      const hb = this.historyBars();
      // Resolved-signal exit instant (if any) — extends the forward window so
      // the candles run all the way to the TP/SL touch, like the sensitivity chart.
      const exitAt = this.exitMarker()?.time ?? null;
      if (!sym || tf == null || !at) return;
      const key = `${sym}|${tf}|${at}|${ttl ?? '?'}|${hb}|${exitAt ?? '-'}`;
      if (this.lastFetchedKey === key) return;
      this.lastFetchedKey = key;
      this.fetchCandles(sym, tf, at, ttl, hb, exitAt);
    });

    // ── Live price subscription lifecycle ──────────────────────────────────
    // Join the symbol's price room once the shared hub connection is up; leave +
    // rejoin on symbol switch; force a rejoin after a reconnect (server-side group
    // membership is lost on a dropped connection). Re-runs whenever `live`, the
    // symbol, or the connection state changes (all read as signals).
    effect(() => {
      if (!this.live()) return;
      const sym = this.symbol()?.toUpperCase();
      if (!this.realtime.isConnected()) {
        // Not connected yet — kick the (idempotent) connect and clear the marker
        // so a reconnect re-subscribes rather than assuming we're still joined.
        this.subscribedSymbol = null;
        this.realtime.connect();
        return;
      }
      if (!sym || this.subscribedSymbol === sym) return;
      if (this.subscribedSymbol) this.realtime.invoke('UnsubscribePrice', this.subscribedSymbol);
      this.livePrice.set(null);
      this.realtime.invoke('SubscribePrice', sym);
      this.subscribedSymbol = sym;
    });

    // Tick stream — keep only ticks for the symbol we're showing.
    this.realtime
      .on<{ symbol: string; mid: number; bid: number; ask: number }>('priceUpdated')
      .pipe(takeUntilDestroyed())
      .subscribe((p) => {
        if (!this.live() || !p) return;
        if ((p.symbol ?? '').toUpperCase() !== this.symbol()?.toUpperCase()) return;
        const mid = p.mid ?? (p.bid + p.ask) / 2;
        if (typeof mid === 'number' && isFinite(mid)) this.livePrice.set(mid);
      });

    // Leave the price room on teardown so we don't leak group membership.
    inject(DestroyRef).onDestroy(() => {
      if (this.subscribedSymbol) this.realtime.invoke('UnsubscribePrice', this.subscribedSymbol);
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
    historyBars: number,
    exitAt: string | null,
  ): void {
    this.loading.set(true);
    const HISTORY_BARS = Math.max(20, historyBars);
    const tfMs = this.timeframeMinutes(tf) * 60_000;
    const asOfMs = new Date(asOfUtc).getTime();

    // Forward window: the live / unresolved default (a few hours), but once the
    // signal has RESOLVED, extend it so the candles run all the way to the
    // TP/SL touch — the sensitivity chart always keeps the resolving bar in
    // view. A small buffer past the exit stops the verdict bar sitting flush
    // against the right edge.
    let forward = Math.min(40, Math.max(8, ttlBars ?? this.defaultForwardBars(tf)));
    if (exitAt) {
      const exitMs = new Date(exitAt).getTime();
      if (Number.isFinite(exitMs) && exitMs > asOfMs && tfMs > 0) {
        forward = Math.max(forward, Math.ceil((exitMs - asOfMs) / tfMs) + 12);
      }
    }
    // Guard the request size — a stale/far-out exit can't blow past the
    // endpoint's useful span (history + forward capped at 2000 bars).
    forward = Math.min(forward, 1900);
    const itemCount = Math.min(HISTORY_BARS + forward, 2000);
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
    // Live price (opt-in) participates in the y-bounds so the LIVE marker never
    // clips off the top/bottom when price runs past every rec level.
    const livePx = this.livePrice();
    const showLive = this.live() && livePx != null && isFinite(livePx);
    if (showLive) allYs.push(livePx!);
    const yMin = Math.min(...allYs);
    const yMax = Math.max(...allYs);
    const yPad = (yMax - yMin) * 0.15;

    // Levels span from the signal bar to the right edge by default; full-width
    // mode extends them back to the first bar.
    const full = this.fullWidthLevels();
    const lineStart = full ? 0 : signalIdx;
    const flat = (y: number): [number, number][] => [
      [lineStart, y],
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
      const lineW = isPrimary ? 2.5 : 1.5;
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
        // Post-signal (right) zone — full colour + label.
        markAreaData.push([
          {
            yAxis: rec.entryPrice,
            xAxis: signalIdx,
            itemStyle: { color: 'rgba(31, 138, 61, 0.14)' },
            name: 'TP zone',
          },
          { yAxis: rec.takeProfit, xAxis: lastIdx },
        ]);
        // Pre-signal (left) zone — fainter, no label.
        if (full) {
          markAreaData.push([
            { yAxis: rec.entryPrice, xAxis: 0, itemStyle: { color: 'rgba(31, 138, 61, 0.05)' } },
            { yAxis: rec.takeProfit, xAxis: signalIdx },
          ]);
        }
      }
      if (isPrimary && rec.entryPrice != null && rec.stopLoss != null) {
        markAreaData.push([
          {
            yAxis: rec.entryPrice,
            xAxis: signalIdx,
            itemStyle: { color: 'rgba(196, 41, 10, 0.14)' },
            name: 'SL zone',
          },
          { yAxis: rec.stopLoss, xAxis: lastIdx },
        ]);
        if (full) {
          markAreaData.push([
            { yAxis: rec.entryPrice, xAxis: 0, itemStyle: { color: 'rgba(196, 41, 10, 0.05)' } },
            { yAxis: rec.stopLoss, xAxis: signalIdx },
          ]);
        }
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

    // Pan/zoom + overview slider, mirroring the Signal Sensitivity chart. The
    // slider needs vertical room below the x-axis, so the grid drops
    // containLabel and reserves an explicit bottom band when zoomable.
    const zoom = this.zoomable();

    return <EChartsOption>{
      animation: false,
      // Right margin = 110px so the colour-coded endLabel pills have room.
      grid: zoom
        ? { left: 70, right: 110, top: 20, bottom: 64 }
        : { left: 60, right: 110, top: 20, bottom: 40, containLabel: true },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross' },
        // Clean OHLC read on the hovered bar (matches the sensitivity chart)
        // rather than dumping every overlay series' raw value.
        formatter: (params: any) => {
          const arr = Array.isArray(params) ? params : [params];
          const candle = arr.find((p: any) => p.seriesType === 'candlestick');
          const c = candle ? rows[candle.dataIndex] : undefined;
          if (!c) return '';
          const d = new Date(c.timestamp);
          const label = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
          return `<b>${label}</b><br/>O ${fmt(c.open)}<br/>H ${fmt(c.high)}<br/>L ${fmt(c.low)}<br/>C ${fmt(c.close)}`;
        },
      },
      dataZoom: zoom
        ? [
            { type: 'inside', xAxisIndex: 0, startValue: 0, endValue: lastIdx },
            {
              type: 'slider',
              xAxisIndex: 0,
              height: 24,
              bottom: 8,
              startValue: 0,
              endValue: lastIdx,
            },
          ]
        : undefined,
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
              // Live-price line (opt-in) — dashed horizontal marker refreshed ~1 Hz
              // by the priceUpdated stream so price is watchable against the levels.
              ...(showLive
                ? [
                    {
                      yAxis: livePx!,
                      lineStyle: { color: '#0071e3', type: 'dashed', width: 1.5, opacity: 0.95 },
                      label: {
                        show: true,
                        formatter: `LIVE ${fmt(livePx!)}`,
                        position: 'insideEndTop',
                        color: '#ffffff',
                        backgroundColor: '#0071e3',
                        padding: [2, 6],
                        borderRadius: 3,
                        fontWeight: 'bold',
                        fontSize: 10,
                      },
                    },
                  ]
                : []),
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
