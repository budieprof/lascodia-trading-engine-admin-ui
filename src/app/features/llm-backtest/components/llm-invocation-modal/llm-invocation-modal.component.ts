import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { NgxEchartsDirective } from 'ngx-echarts';
import type { EChartsOption } from 'echarts';
import { catchError, of } from 'rxjs';

import { LlmService } from '@core/services/llm.service';
import { MarketDataService } from '@core/services/market-data.service';
import { ThemeService } from '@core/theme/theme.service';
import { CandleDto, LlmInvocationDetailDto, Timeframe } from '@core/api/api.types';
import { MarketAnalysisRecommendation } from '@core/services/llm-backtest.service';

/**
 * Modal payload — opened by the per-point drill-down rows on the LLM
 * backtest detail page. Carries the linked LlmInvocation id plus a bit of
 * cell context (asOfUtc / symbol / timeframe) so the header can render
 * without a separate detail fetch.
 */
export interface LlmInvocationModalContext {
  invocationId: number;
  symbol: string;
  timeframe: number | string;
  asOfUtc: string;
  /**
   * Optional first viable recommendation for this point — when set, the
   * chart pane renders Entry / SL / TP horizontal mark-lines. On Hold-only
   * points (the common case for the wave-1+wave-2-hardened prompt), the
   * caller passes null and the chart shows only the candle structure.
   */
  recommendation?: MarketAnalysisRecommendation | null;
  /**
   * Optional bars-forward window to display past asOfUtc — matches the
   * walker's TTL on the run. Falls back to a sensible per-timeframe default
   * when not provided.
   */
  ttlBars?: number | null;
}

/**
 * Modal showing the raw LLM invocation request + response for a single
 * backtest point. Fetches /llm/invocations/{id} lazily on open and renders:
 *   - Metadata strip (provider, model, purpose, tokens, latency, cost,
 *     outcome, prompt hash)
 *   - Request block — full system + user prompt as preformatted monospace
 *     text, with a "copy" button.
 *   - Response block — same treatment for the raw LLM response.
 * Each block is independently collapsible and supports word-wrap toggle so
 * operators can read long prompts inline without horizontal scrolling.
 */
@Component({
  selector: 'app-llm-invocation-modal',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, NgxEchartsDirective],
  template: `
    @if (ctx(); as c) {
      <div class="scrim" (click)="closed.emit()">
        <div class="card" (click)="$event.stopPropagation()">
          <header class="card-head">
            <div class="head-titles">
              <h2>
                LLM Invocation
                <span class="muted">#{{ c.invocationId }}</span>
              </h2>
              <div class="sub muted">
                {{ c.symbol }} · {{ tfLabel(c.timeframe) }} · asOfUtc
                {{ c.asOfUtc | date: 'yyyy-MM-dd HH:mm' : 'UTC' }} UTC
              </div>
            </div>
            <button type="button" class="close" (click)="closed.emit()" aria-label="Close">
              ×
            </button>
          </header>

          @if (loading()) {
            <div class="empty">Loading invocation…</div>
          } @else if (!detail()) {
            <div class="empty error">
              {{ errorMessage() ?? 'No invocation data available for this point.' }}
            </div>
          } @else if (detail(); as d) {
            <!-- Metadata strip -->
            <div class="meta-strip">
              <div class="meta-cell">
                <span class="meta-key">Provider</span><span>{{ d.provider }}</span>
              </div>
              <div class="meta-cell">
                <span class="meta-key">Model</span><span class="mono">{{ d.model }}</span>
              </div>
              <div class="meta-cell">
                <span class="meta-key">Purpose</span><span class="mono small">{{ d.purpose }}</span>
              </div>
              <div class="meta-cell">
                <span class="meta-key">Outcome</span
                ><span class="outcome-chip">{{ d.outcome }}</span>
              </div>
              <div class="meta-cell">
                <span class="meta-key">Tokens in</span><span>{{ d.tokensInput | number }}</span>
              </div>
              <div class="meta-cell">
                <span class="meta-key">Tokens out</span><span>{{ d.tokensOutput | number }}</span>
              </div>
              <div class="meta-cell">
                <span class="meta-key">Latency</span><span>{{ d.latencyMs | number }} ms</span>
              </div>
              <div class="meta-cell">
                <span class="meta-key">Cost</span
                ><span>{{ d.costUsd | currency: 'USD' : 'symbol' : '1.4-6' }}</span>
              </div>
              <div class="meta-cell">
                <span class="meta-key">Invoked at</span
                ><span>{{ d.invokedAt | date: 'yyyy-MM-dd HH:mm:ss' : 'UTC' }} UTC</span>
              </div>
              <div class="meta-cell meta-cell--wide" [title]="d.promptHash">
                <span class="meta-key">Prompt hash</span>
                <span class="mono small">{{ d.promptHash?.slice(0, 16) }}…</span>
              </div>
            </div>

            @if (d.errorMessage) {
              <div class="error-banner"><strong>Error:</strong> {{ d.errorMessage }}</div>
            }

            <!-- Scroll body — wraps every section below the sticky chrome
                 so long content (Request prompt, Response, large JSON
                 blocks) scrolls inside the modal instead of being clipped
                 at the card's 92vh cap. -->
            <div class="scroll-body">
              <!-- Candle chart pane — visualises the bar the LLM was asked
                 about plus a few bars forward, so the operator can compare
                 the market structure with the analyst brief. When the cell
                 has a viable recommendation, the chart overlays Entry/SL/TP
                 mark-lines. The asOfUtc bar is highlighted with a soft band. -->
              <section class="chart-pane">
                <header class="block-head">
                  <button
                    type="button"
                    class="block-toggle"
                    (click)="chartExpanded.set(!chartExpanded())"
                  >
                    <span class="caret" [class.caret--open]="chartExpanded()">▸</span>
                    <h3>Candle chart — what the LLM saw</h3>
                  </button>
                  <div class="block-actions">
                    @if (chartExpanded()) {
                      <span class="muted small">
                        {{ candles().length }} bars · asOfUtc highlighted
                        @if (ctx()?.recommendation) {
                          · entry/SL/TP overlaid
                        }
                      </span>
                    }
                  </div>
                </header>
                @if (chartExpanded()) {
                  @if (chartLoading()) {
                    <div class="empty small muted">Loading candles…</div>
                  } @else if (chartOptions(); as opts) {
                    <div
                      echarts
                      [options]="opts"
                      [theme]="echartsTheme()"
                      [autoResize]="true"
                      class="chart-instance"
                    ></div>
                    <div class="chart-legend">
                      <span class="legend-item"
                        ><span class="dot dot--asof"></span> asOfUtc bar</span
                      >
                      @if (ctx()?.recommendation?.entryPrice !== null) {
                        <span class="legend-item"><span class="dot dot--entry"></span> Entry</span>
                      }
                      @if (ctx()?.recommendation?.takeProfit !== null) {
                        <span class="legend-item"
                          ><span class="dot dot--tp"></span> Take-profit</span
                        >
                      }
                      @if (ctx()?.recommendation?.stopLoss !== null) {
                        <span class="legend-item"><span class="dot dot--sl"></span> Stop-loss</span>
                      }
                    </div>
                  } @else {
                    <div class="empty small muted">No candles available for this window.</div>
                  }
                }
              </section>

              <!-- Request block -->
              <section class="block">
                <header class="block-head">
                  <button
                    type="button"
                    class="block-toggle"
                    (click)="reqExpanded.set(!reqExpanded())"
                  >
                    <span class="caret" [class.caret--open]="reqExpanded()">▸</span>
                    <h3>Request — full prompt</h3>
                  </button>
                  <div class="block-actions">
                    @if (reqExpanded()) {
                      <span class="muted small">{{ reqByteLabel() }}</span>
                      <button type="button" class="btn-mini" (click)="wrapReq.set(!wrapReq())">
                        {{ wrapReq() ? 'no-wrap' : 'wrap' }}
                      </button>
                      <button type="button" class="btn-mini" (click)="copy(d.requestBody)">
                        copy
                      </button>
                    }
                  </div>
                </header>
                @if (reqExpanded()) {
                  @if (d.requestBody) {
                    @if (splitRequest(d.requestBody); as parts) {
                      @if (parts.system) {
                        <div class="prompt-section">
                          <div class="prompt-section-title">System prompt</div>
                          <pre class="prompt-body" [class.wrap]="wrapReq()">{{ parts.system }}</pre>
                        </div>
                      }
                      <div class="prompt-section">
                        <div class="prompt-section-title">User prompt</div>
                        <pre class="prompt-body" [class.wrap]="wrapReq()">{{ parts.user }}</pre>
                      </div>
                    }
                  } @else {
                    <div class="empty muted small">No request body recorded.</div>
                  }
                }
              </section>

              <!-- Response block -->
              <section class="block">
                <header class="block-head">
                  <button
                    type="button"
                    class="block-toggle"
                    (click)="resExpanded.set(!resExpanded())"
                  >
                    <span class="caret" [class.caret--open]="resExpanded()">▸</span>
                    <h3>Response — LLM output</h3>
                  </button>
                  <div class="block-actions">
                    @if (resExpanded()) {
                      <span class="muted small">{{ resByteLabel() }}</span>
                      <button type="button" class="btn-mini" (click)="wrapRes.set(!wrapRes())">
                        {{ wrapRes() ? 'no-wrap' : 'wrap' }}
                      </button>
                      <button type="button" class="btn-mini" (click)="copy(d.responseBody)">
                        copy
                      </button>
                    }
                  </div>
                </header>
                @if (resExpanded()) {
                  @if (d.responseBody) {
                    @if (splitResponse(d.responseBody); as parts) {
                      @if (parts.prose) {
                        <div class="prompt-section">
                          <div class="prompt-section-title">Analyst brief (prose)</div>
                          <pre class="prompt-body" [class.wrap]="wrapRes()">{{ parts.prose }}</pre>
                        </div>
                      }
                      @if (parts.recommendations) {
                        <div class="prompt-section">
                          <div class="prompt-section-title">
                            Recommendations JSON
                            @if (recsPreview(parts.recommendations); as rp) {
                              <span class="muted small">— {{ rp }}</span>
                            }
                          </div>
                          <pre class="prompt-body prompt-body--json" [class.wrap]="wrapRes()">{{
                            parts.recommendations
                          }}</pre>
                        </div>
                      }
                      @if (parts.exit) {
                        <div class="prompt-section">
                          <div class="prompt-section-title">Exit instructions JSON</div>
                          <pre class="prompt-body prompt-body--json" [class.wrap]="wrapRes()">{{
                            parts.exit
                          }}</pre>
                        </div>
                      }
                    }
                  } @else {
                    <div class="empty muted small">No response body recorded.</div>
                  }
                }
              </section>
            </div>
            <!-- /.scroll-body -->
          }
        </div>
      </div>
    }
  `,
  styles: [
    `
      :host {
        font-size: 13px;
        /*
         * display:contents removes the component host from the layout flow.
         * Without this, the host element renders as a default inline-block
         * in whatever position the parent template mounted it, and any
         * ancestor that creates a containing block (transform/filter/
         * backdrop-filter/contain) can trap our position:fixed descendants.
         * With it, the .scrim becomes the layout root and centers on the
         * true viewport.
         */
        display: contents;
      }
      .scrim {
        position: fixed;
        top: 0;
        right: 0;
        bottom: 0;
        left: 0;
        background: rgba(0, 0, 0, 0.65);
        backdrop-filter: blur(2px);
        -webkit-backdrop-filter: blur(2px);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1100;
        padding: 1rem;
        animation: scrimIn 0.12s ease-out;
      }
      @keyframes scrimIn {
        from {
          opacity: 0;
        }
        to {
          opacity: 1;
        }
      }
      .card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        width: min(1100px, 96vw);
        max-height: 92vh;
        display: flex;
        flex-direction: column;
        /* Card chrome (header + meta-strip) stays put while body scrolls.
           min-height:0 lets the flex children collapse so the scroll-body
           region can claim the leftover space (without it the cards
           intrinsic-content height blows past the 92vh cap and the
           Recommendations JSON section gets clipped). */
        overflow: hidden;
        min-height: 0;
      }
      /* Sticky chrome  header + meta-strip do not scroll. */
      .card > .card-head,
      .card > .meta-strip,
      .card > .error-banner {
        flex-shrink: 0;
      }
      /* Everything below the chrome scrolls inside one container. */
      .scroll-body {
        flex: 1 1 auto;
        overflow-y: auto;
        min-height: 0;
      }
      .card-head {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        padding: 0.75rem 1rem;
        border-bottom: 1px solid var(--border);
      }
      .head-titles h2 {
        margin: 0;
        font-size: 16px;
        font-weight: 600;
      }
      .head-titles .sub {
        font-size: 12px;
        margin-top: 0.15rem;
      }
      .close {
        background: transparent;
        border: 0;
        color: var(--text-primary);
        font-size: 22px;
        cursor: pointer;
        line-height: 1;
        padding: 0 0.4rem;
      }
      .muted {
        color: var(--text-secondary);
      }
      .small {
        font-size: 11px;
      }
      .mono {
        font-family: ui-monospace, SFMono-Regular, monospace;
      }

      .empty {
        padding: 1.5rem;
        text-align: center;
        color: var(--text-secondary);
        font-size: 13px;
      }
      .empty.error {
        color: #c4290a;
      }
      .error-banner {
        margin: 0.5rem 1rem;
        padding: 0.5rem 0.75rem;
        background: rgba(196, 41, 10, 0.12);
        border: 1px solid rgba(196, 41, 10, 0.4);
        border-radius: var(--radius-sm);
        color: #c4290a;
        font-size: 12px;
      }

      .meta-strip {
        display: flex;
        flex-wrap: wrap;
        gap: 0.4rem 1rem;
        padding: 0.65rem 1rem;
        background: var(--bg-primary);
        border-bottom: 1px solid var(--border);
        font-size: 12px;
      }
      .meta-cell {
        display: flex;
        flex-direction: column;
        line-height: 1.15;
        min-width: 80px;
      }
      .meta-cell--wide {
        min-width: 160px;
      }
      .meta-key {
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-secondary);
        font-weight: 600;
      }
      .outcome-chip {
        display: inline-block;
        padding: 0.05rem 0.4rem;
        border-radius: 3px;
        font-size: 11px;
        font-weight: 600;
        background: rgba(31, 138, 61, 0.18);
        color: #1f8a3d;
      }

      .block {
        border-bottom: 1px solid var(--border);
      }
      .block:last-of-type {
        border-bottom: 0;
      }
      .block-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 0.5rem 1rem;
        background: var(--bg-secondary);
      }
      .block-toggle {
        display: flex;
        align-items: center;
        gap: 0.4rem;
        background: transparent;
        border: 0;
        cursor: pointer;
        color: var(--text-primary);
        padding: 0;
      }
      .block-toggle h3 {
        margin: 0;
        font-size: 13px;
        font-weight: 600;
      }
      .caret {
        display: inline-block;
        transition: transform 0.15s ease;
        font-size: 12px;
        color: var(--text-secondary);
      }
      .caret--open {
        transform: rotate(90deg);
      }
      .block-actions {
        display: flex;
        align-items: center;
        gap: 0.5rem;
      }
      .btn-mini {
        background: transparent;
        color: var(--text-secondary);
        border: 1px solid var(--border);
        border-radius: 3px;
        padding: 0.1rem 0.4rem;
        font-size: 11px;
        cursor: pointer;
      }
      .btn-mini:hover {
        background: var(--bg-secondary);
        color: var(--text-primary);
      }

      .prompt-section {
        padding: 0 1rem 0.5rem;
      }
      .prompt-section-title {
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-secondary);
        font-weight: 700;
        padding: 0.4rem 0 0.25rem;
      }
      .prompt-body {
        margin: 0;
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        padding: 0.6rem 0.75rem;
        font-family: ui-monospace, SFMono-Regular, monospace;
        font-size: 12px;
        line-height: 1.45;
        max-height: 360px;
        overflow: auto;
        white-space: pre;
      }
      .prompt-body.wrap {
        white-space: pre-wrap;
        word-break: break-word;
      }
      .prompt-body--json {
        color: #1f8a3d;
      }

      /* Candle-chart pane */
      .chart-pane {
        border-bottom: 1px solid var(--border);
      }
      .chart-instance {
        height: 320px;
        margin: 0 1rem;
        padding-bottom: 0.5rem;
      }
      .chart-legend {
        display: flex;
        flex-wrap: wrap;
        gap: 0.85rem;
        font-size: 11px;
        opacity: 0.85;
        padding: 0 1rem 0.65rem;
      }
      .legend-item {
        display: inline-flex;
        align-items: center;
        gap: 0.3rem;
      }
      .dot {
        display: inline-block;
        width: 14px;
        height: 3px;
        border-radius: 1px;
      }
      .dot--entry {
        background: #6e6e73;
      }
      .dot--tp {
        background: #1f8a3d;
      }
      .dot--sl {
        background: #c4290a;
      }
      .dot--asof {
        background: rgba(0, 113, 227, 0.45);
        width: 10px;
        height: 10px;
        border-radius: 2px;
      }
    `,
  ],
})
export class LlmInvocationModalComponent {
  /** Setting to a non-null payload opens the modal and triggers the detail fetch. */
  ctx = input<LlmInvocationModalContext | null>(null);
  closed = output<void>();

  private readonly llm = inject(LlmService);
  private readonly marketData = inject(MarketDataService);
  private readonly themeService = inject(ThemeService);

  readonly loading = signal(false);
  readonly errorMessage = signal<string | null>(null);
  readonly detail = signal<LlmInvocationDetailDto | null>(null);

  readonly reqExpanded = signal(true);
  readonly resExpanded = signal(true);
  readonly chartExpanded = signal(true);
  readonly wrapReq = signal(true);
  readonly wrapRes = signal(true);

  readonly candles = signal<CandleDto[]>([]);
  readonly chartLoading = signal(false);

  readonly reqByteLabel = computed(() => this.byteLabel(this.detail()?.requestBody));
  readonly resByteLabel = computed(() => this.byteLabel(this.detail()?.responseBody));

  readonly echartsTheme = computed(() =>
    this.themeService.theme() === 'dark' ? 'lascodia-dark' : 'lascodia-light',
  );

  private lastFetchedInvocation: number | null = null;
  private lastFetchedCandlesKey: string | null = null;

  constructor() {
    effect(() => {
      const c = this.ctx();
      if (!c) {
        this.detail.set(null);
        this.errorMessage.set(null);
        this.candles.set([]);
        this.lastFetchedInvocation = null;
        this.lastFetchedCandlesKey = null;
        return;
      }
      // Invocation detail — fetched once per invocationId.
      if (this.lastFetchedInvocation !== c.invocationId) {
        this.lastFetchedInvocation = c.invocationId;
        this.fetch(c.invocationId);
      }
      // Candle window — fetched once per (symbol, timeframe, asOfUtc, ttlBars).
      const candleKey = `${c.symbol}|${c.timeframe}|${c.asOfUtc}|${c.ttlBars ?? '?'}`;
      if (this.lastFetchedCandlesKey !== candleKey) {
        this.lastFetchedCandlesKey = candleKey;
        this.fetchCandles(c);
      }
    });
  }

  /**
   * Pull a candle window straddling asOfUtc — HISTORY_BARS leading bars +
   * forward bars equal to the run's TTL (or a per-timeframe default when
   * the caller didn't pass one). The market-data list endpoint orders
   * newest-first; we sort ascending here so the x-axis flows left-to-right.
   */
  private fetchCandles(c: LlmInvocationModalContext): void {
    this.chartLoading.set(true);
    const HISTORY_BARS = 48;
    const forward = Math.min(40, Math.max(8, c.ttlBars ?? this.defaultForwardBars(c.timeframe)));
    const itemCount = HISTORY_BARS + forward;
    this.marketData
      .listCandles({
        currentPage: 1,
        itemCountPerPage: itemCount,
        filter: {
          symbol: c.symbol,
          timeframe: c.timeframe as Timeframe,
          to: this.shiftIso(c.asOfUtc, c.timeframe, forward),
        },
      })
      .pipe(catchError(() => of(null)))
      .subscribe((res) => {
        this.chartLoading.set(false);
        const rows = res?.status && res.data ? (res.data.data ?? []) : [];
        const ordered = rows
          .slice()
          .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
        this.candles.set(ordered);
      });
  }

  /**
   * ECharts candlestick over the fetched window with full reference-line
   * overlays for the attached recommendation. Adopts the Signal Sensitivity
   * Analysis page's chart pattern (2026-06-20 operator-driven refactor):
   *
   *   - Reference levels rendered as TWO-POINT LINE SERIES from the asOfUtc
   *     bar to the chart's right edge (instead of markLine that spans the
   *     full chart), so the line only appears AFTER the LLM analysed the
   *     bar — the visual matches "the analyst saw this bar, then drew these
   *     levels forward into time".
   *   - Each level carries an `endLabel` — a coloured pill ("ENTRY 184.78",
   *     "TP 183.95", "SL 185.30") that sits in the right-side margin where
   *     ECharts has dedicated space, replacing the earlier markLine label
   *     that clipped at the plot edge.
   *   - TP zone and SL zone shaded between entry and target as soft fills,
   *     so the operator sees the risk envelope at a glance.
   *   - The asOfUtc bar is marked by a vertical "Signal fired" line.
   *   - Y-axis bounds with 15% padding so reference lines that sit outside
   *     the candle OHLC range still render with margin.
   *   - Category x-axis (not time) so weekend gaps collapse cleanly.
   */
  readonly chartOptions = computed<EChartsOption | null>(() => {
    const c = this.ctx();
    const rows = this.candles();
    if (!c || rows.length === 0) return null;

    const rec = c.recommendation;
    const categories = rows.map((r) => r.timestamp);
    const candleData: [number, number, number, number][] = rows.map((r) => [
      r.open,
      r.close,
      r.low,
      r.high,
    ]);
    const lastIdx = rows.length - 1;

    // Map asOfUtc to the candle index it landed on (most recent bar
    // at-or-before the prompt instant). Falls back to bounds.
    const asOfMs = new Date(c.asOfUtc).getTime();
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

    // Price precision auto-fit: JPY-style pairs sit > 50 numerically so use
    // 3dp; major FX pairs are <2 so use 5dp. Matches the sensitivity page.
    const samplePrice = rec?.entryPrice ?? rows[0]?.close ?? 1;
    const pricePrecision = samplePrice > 50 ? 3 : 5;
    const fmt = (n: number) => n.toFixed(pricePrecision);

    // Y-axis bounds — include every reference price with 15% padding so
    // SL / TP that sit outside the candle OHLC range still render visibly.
    const lows = rows.map((r) => r.low);
    const highs = rows.map((r) => r.high);
    const allYs = [...lows, ...highs];
    if (rec?.entryPrice != null) allYs.push(rec.entryPrice);
    if (rec?.stopLoss != null) allYs.push(rec.stopLoss);
    if (rec?.takeProfit != null) allYs.push(rec.takeProfit);
    const yMin = Math.min(...allYs);
    const yMax = Math.max(...allYs);
    const yPad = (yMax - yMin) * 0.15;

    // Two-point line going from the signal bar to the right edge, so the
    // reference level visually starts at the LLM bar and projects forward.
    const flat = (y: number): [number, number][] => [
      [signalIdx, y],
      [lastIdx, y],
    ];

    const lineSeries: any[] = [];
    if (rec?.entryPrice != null) {
      lineSeries.push({
        name: 'Entry',
        type: 'line',
        data: flat(rec.entryPrice),
        symbol: 'none',
        lineStyle: { color: '#000000', width: 2, type: 'solid' },
        tooltip: { show: false },
        z: 10,
        endLabel: {
          show: true,
          formatter: `ENTRY ${fmt(rec.entryPrice)}`,
          backgroundColor: '#000000',
          color: '#ffffff',
          padding: [3, 7],
          borderRadius: 3,
          fontWeight: 'bold',
          fontSize: 11,
        },
      });
    }
    if (rec?.takeProfit != null) {
      lineSeries.push({
        name: 'TP',
        type: 'line',
        data: flat(rec.takeProfit),
        symbol: 'none',
        lineStyle: { color: '#1f8a3d', width: 2, type: 'solid' },
        tooltip: { show: false },
        z: 10,
        endLabel: {
          show: true,
          formatter: `TP ${fmt(rec.takeProfit)}`,
          backgroundColor: '#1f8a3d',
          color: '#ffffff',
          padding: [3, 7],
          borderRadius: 3,
          fontWeight: 'bold',
          fontSize: 11,
        },
      });
    }
    if (rec?.stopLoss != null) {
      lineSeries.push({
        name: 'SL',
        type: 'line',
        data: flat(rec.stopLoss),
        symbol: 'none',
        lineStyle: { color: '#c4290a', width: 2, type: 'solid' },
        tooltip: { show: false },
        z: 10,
        endLabel: {
          show: true,
          formatter: `SL ${fmt(rec.stopLoss)}`,
          backgroundColor: '#c4290a',
          color: '#ffffff',
          padding: [3, 7],
          borderRadius: 3,
          fontWeight: 'bold',
          fontSize: 11,
        },
      });
    }

    // TP / SL zone bands — soft fills between entry and target on the
    // SAME side as the trade direction, so the risk envelope is visible.
    const markAreaData: any[][] = [];
    if (rec?.entryPrice != null && rec?.takeProfit != null) {
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
    if (rec?.entryPrice != null && rec?.stopLoss != null) {
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

    return <EChartsOption>{
      animation: false,
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
          name: c.symbol,
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
    // Integer enum: M1=0, M5=1, M15=2, H1=3, H4=4, D1=5
    const map: Record<number, number> = { 0: 1, 1: 5, 2: 15, 3: 60, 4: 240, 5: 1440 };
    return map[tf] ?? 60;
  }

  /** Sensible TTL fallback when the caller didn't pass an explicit ttlBars. */
  private defaultForwardBars(tf: number | string): number {
    const mins = this.timeframeMinutes(tf);
    // ~6h of forward window for any timeframe ≤ H1; smaller for H4/D1.
    if (mins <= 60) return Math.max(8, Math.round(360 / mins));
    if (mins <= 240) return 6;
    return 5;
  }

  private fetch(id: number): void {
    this.loading.set(true);
    this.errorMessage.set(null);
    this.detail.set(null);
    this.llm
      .invocationDetail(id)
      .pipe(catchError(() => of(null)))
      .subscribe((res) => {
        this.loading.set(false);
        if (res?.status && res.data) {
          this.detail.set(res.data);
        } else {
          this.errorMessage.set(res?.message ?? 'Failed to load invocation.');
        }
      });
  }

  /**
   * Split the combined RequestBody (server stores it as
   * `"<systemPrompt>\n<userPrompt>"`) into the two halves so the modal can
   * present them under named headers. If the system half isn't recognisable
   * (e.g. the live path packaged it differently), we fall through and show
   * the whole blob under "User prompt".
   */
  splitRequest(raw: string): { system?: string; user: string } {
    if (!raw) return { user: '' };
    // Find the first paragraph break — the system prompt is a single (long)
    // line in the engine's current AnalyzeMarketCommand. If we don't find a
    // good split point, show as one body.
    const split = raw.indexOf('\n\n');
    if (split <= 0 || split > 60_000) return { user: raw };
    return {
      system: raw.slice(0, split).trim(),
      user: raw.slice(split + 2).trim(),
    };
  }

  /**
   * Pull the structured `<<<RECOMMENDATIONS_JSON>>>` and
   * `<<<EXIT_INSTRUCTIONS_JSON>>>` blocks out of the response so they can be
   * presented under their own headers (and given a JSON-coloured pre block).
   * Falls back to a single "prose" body when neither delimiter is found.
   */
  splitResponse(raw: string): { prose?: string; recommendations?: string; exit?: string } {
    if (!raw) return {};
    const recOpen = '<<<RECOMMENDATIONS_JSON>>>';
    const recClose = '<<<END_RECOMMENDATIONS>>>';
    const exitOpen = '<<<EXIT_INSTRUCTIONS_JSON>>>';
    const exitClose = '<<<END_EXIT_INSTRUCTIONS>>>';

    const recStart = raw.indexOf(recOpen);
    const recEnd = raw.indexOf(recClose);
    const exitStart = raw.indexOf(exitOpen);
    const exitEnd = raw.indexOf(exitClose);

    if (recStart < 0 && exitStart < 0) return { prose: raw.trim() };

    const proseEnd = Math.min(...[recStart, exitStart].filter((i) => i >= 0).map((i) => i));
    const prose = proseEnd > 0 ? raw.slice(0, proseEnd).trim() : undefined;

    const recommendations =
      recStart >= 0 && recEnd > recStart
        ? this.tryPrettyJson(raw.slice(recStart + recOpen.length, recEnd).trim())
        : undefined;

    const exit =
      exitStart >= 0 && exitEnd > exitStart
        ? this.tryPrettyJson(raw.slice(exitStart + exitOpen.length, exitEnd).trim())
        : undefined;

    return { prose, recommendations, exit };
  }

  /**
   * Compact summary of the recommendations array — e.g.
   * "1 rec · Hold (confidence 0.45)" or "2 recs · Buy 0.65 / Sell 0.55".
   * Helps the operator scan a long modal at a glance.
   */
  recsPreview(json: string): string | null {
    try {
      const arr = JSON.parse(json);
      if (!Array.isArray(arr) || arr.length === 0) return null;
      const parts = arr.slice(0, 3).map((r: any) => {
        const action = r?.action ?? r?.Action ?? '?';
        const conf = r?.confidence ?? r?.Confidence;
        return conf != null ? `${action} ${(+conf).toFixed(2)}` : String(action);
      });
      const extra = arr.length > 3 ? ` +${arr.length - 3}` : '';
      return `${arr.length} rec(s) · ${parts.join(' / ')}${extra}`;
    } catch {
      return null;
    }
  }

  private tryPrettyJson(raw: string): string {
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      return raw;
    }
  }

  private byteLabel(s?: string | null): string {
    if (!s) return '0 chars';
    return `${s.length.toLocaleString()} chars`;
  }

  copy(text?: string | null): void {
    if (!text) return;
    navigator.clipboard?.writeText(text).catch(() => undefined);
  }

  tfLabel(tf: number | string): string {
    if (typeof tf === 'string') return tf;
    const map: Record<number, string> = {
      0: 'M1',
      1: 'M5',
      2: 'M15',
      3: 'H1',
      4: 'H4',
      5: 'D1',
      6: 'W1',
      7: 'MN',
    };
    return map[tf] ?? `TF${tf}`;
  }
}
