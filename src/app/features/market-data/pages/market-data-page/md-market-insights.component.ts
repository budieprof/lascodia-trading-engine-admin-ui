import { ChangeDetectionStrategy, Component, input, type Signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { NgxEchartsDirective } from 'ngx-echarts';
import type { EChartsOption } from 'echarts';
import type { OrderBookSnapshotDto } from '@core/api/api.types';
import type { MarketDataPageComponent } from './market-data-page.component';
import { formatVolume } from './market-data-format';

/** The value type of one of the page's signals, so each input is typed by the computed that feeds it. */
type PageValue<K extends keyof MarketDataPageComponent> =
  MarketDataPageComponent[K] extends Signal<infer V> ? V : never;

/**
 * The chart tab's Market Insights panel for the chart-focused symbol and timeframe: price action
 * (trend, momentum, volatility, levels) and order flow (VWAP, volume profile, depth of book,
 * footprint, liquidity heatmap). Every value is computed by the page; this renders it.
 */
@Component({
  selector: 'app-md-market-insights',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, NgxEchartsDirective],
  styleUrl: './md-market-insights.component.scss',
  template: `
    <!--
      ═══════════ MARKET INSIGHTS ═══════════
      Continuous live analysis + prediction for the chart-focused
      (symbol, timeframe). Polls every 5s.
        - Regime card     RegimeDetectionWorker snapshot
                          (label + confidence + ADX/ATR/BBW)
        - Prediction      most recent TradeSignal ML scoring fields
                          (direction, confidence, magnitude in pips)
        - Correlation     Pearson r vs each watched pair from the
                          rolling 100-tick price history (UI-side, no
                          extra round-trip)
    -->
    <section class="insights-section">
      <header class="insights-head">
        <h3>Market Insights</h3>
        <span class="muted">
          {{ chartSymbol() }} · {{ chartTimeframe() }} · refreshes every 5s
        </span>
      </header>

      <!--
        Price action row — 4 cards computed UI-side from the chart's
        candle stream (no extra round-trip). Updates whenever the
        chart re-fetches candles.
      -->
      <div class="insights-grid pa-grid">
        <!-- Trend ─────────────────────────────────────────────── -->
        <article class="insight-card">
          <header class="insight-head">
            <span class="insight-title">Trend</span>
            <span class="muted insight-status">EMA20 / EMA50</span>
          </header>
          @if (trendStats(); as t) {
            <div
              class="bias-pill"
              [class.bullish]="t.bias === 'bullish'"
              [class.bearish]="t.bias === 'bearish'"
              [class.flat]="t.bias === 'flat'"
            >
              {{ t.bias === 'bullish' ? '▲' : t.bias === 'bearish' ? '▼' : '→' }}
              {{ t.bias }}
            </div>
            <dl class="dense-stats">
              <div>
                <dt>EMA20</dt>
                <dd class="mono">{{ formatPrice(t.ema20, chartSymbol()) }}</dd>
              </div>
              <div>
                <dt>EMA50</dt>
                <dd class="mono">{{ formatPrice(t.ema50, chartSymbol()) }}</dd>
              </div>
              <div>
                <dt>Δ from EMA20</dt>
                <dd
                  class="mono"
                  [class.profit]="t.distancePct > 0"
                  [class.loss]="t.distancePct < 0"
                >
                  {{ t.distancePct >= 0 ? '+' : '' }}{{ t.distancePct.toFixed(2) }}%
                </dd>
              </div>
              <div>
                <dt>Slope (pips/bar)</dt>
                <dd
                  class="mono"
                  [class.profit]="t.slopePipsPerBar > 0"
                  [class.loss]="t.slopePipsPerBar < 0"
                >
                  {{ t.slopePipsPerBar >= 0 ? '+' : '' }}{{ t.slopePipsPerBar.toFixed(1) }}
                </dd>
              </div>
              <div>
                <dt>Streak</dt>
                <dd
                  class="mono"
                  [class.profit]="closeStreak() > 0"
                  [class.loss]="closeStreak() < 0"
                >
                  {{ closeStreak() >= 0 ? '↑' : '↓' }}
                  {{ Math.abs(closeStreak()) }} bars
                </dd>
              </div>
            </dl>
          } @else {
            <div class="empty-state">
              <span class="muted">Need ≥50 candles for EMAs.</span>
              <span class="empty-hint"> Switch to a higher timeframe or wait for more bars. </span>
            </div>
          }
        </article>

        <!-- Momentum ─────────────────────────────────────────── -->
        <article class="insight-card">
          <header class="insight-head">
            <span class="insight-title">Momentum</span>
            <span class="muted insight-status">RSI(14) · MACD(12,26,9)</span>
          </header>
          @if (momentumStats(); as m) {
            <div class="momentum-pills">
              <span
                class="momentum-pill"
                [class.profit]="m.rsiZone === 'oversold'"
                [class.loss]="m.rsiZone === 'overbought'"
              >
                RSI {{ m.rsi.toFixed(1) }}
                <span class="momentum-sub">{{ m.rsiZone }}</span>
              </span>
              <span
                class="momentum-pill"
                [class.profit]="m.macdState === 'bullish' || m.macdState === 'bullish-cross'"
                [class.loss]="m.macdState === 'bearish' || m.macdState === 'bearish-cross'"
              >
                MACD {{ m.macdHist >= 0 ? '+' : '' }}{{ m.macdHist.toFixed(5) }}
                <span class="momentum-sub">{{ m.macdState }}</span>
              </span>
            </div>
            <dl class="dense-stats">
              <div>
                <dt>MACD line</dt>
                <dd class="mono">{{ m.macdLine.toFixed(5) }}</dd>
              </div>
              <div>
                <dt>Signal</dt>
                <dd class="mono">{{ m.macdSignal.toFixed(5) }}</dd>
              </div>
              <div>
                <dt>RSI gauge</dt>
                <dd>
                  <div class="rsi-gauge">
                    <span class="rsi-band oversold"></span>
                    <span class="rsi-band overbought"></span>
                    <span class="rsi-needle" [style.left.%]="m.rsi"></span>
                  </div>
                </dd>
              </div>
            </dl>
          } @else {
            <div class="empty-state">
              <span class="muted">Need ≥35 candles.</span>
              <span class="empty-hint"> RSI and MACD warm up after a few dozen bars. </span>
            </div>
          }
        </article>

        <!-- Volatility ───────────────────────────────────────── -->
        <article class="insight-card">
          <header class="insight-head">
            <span class="insight-title">Volatility</span>
            <span class="muted insight-status">ATR(14) · 20-bar range</span>
          </header>
          @if (volatilityStats(); as v) {
            <div
              class="bias-pill"
              [class.expanding]="v.expansion === 'expanding'"
              [class.contracting]="v.expansion === 'contracting'"
              [class.flat]="v.expansion === 'stable'"
            >
              {{ v.expansion === 'expanding' ? '⤢' : v.expansion === 'contracting' ? '⤡' : '→' }}
              {{ v.expansion }}
            </div>
            <dl class="dense-stats">
              <div>
                <dt>ATR (pips)</dt>
                <dd class="mono">{{ v.atrPips.toFixed(1) }}</dd>
              </div>
              <div>
                <dt>ATR percentile</dt>
                <dd class="mono">{{ v.atrPercentile.toFixed(0) }}%</dd>
              </div>
              <div>
                <dt>Last bar range</dt>
                <dd class="mono">{{ v.rangePipsLastBar.toFixed(1) }}p</dd>
              </div>
              <div>
                <dt>20-bar avg range</dt>
                <dd class="mono">{{ v.rangePipsAvg20.toFixed(1) }}p</dd>
              </div>
              <div class="span-2">
                <dt>ATR percentile bar</dt>
                <dd>
                  <div class="percentile-bar">
                    <span
                      class="percentile-fill"
                      [class.high]="v.atrPercentile > 75"
                      [class.low]="v.atrPercentile < 25"
                      [style.width.%]="v.atrPercentile"
                    ></span>
                  </div>
                </dd>
              </div>
            </dl>
          } @else {
            <div class="empty-state">
              <span class="muted">Need ≥30 candles for ATR percentile.</span>
              <span class="empty-hint"> Try a longer-history timeframe. </span>
            </div>
          }
        </article>

        <!-- Levels & Pivots ──────────────────────────────────── -->
        <article class="insight-card">
          <header class="insight-head">
            <span class="insight-title">Levels</span>
            <span class="muted insight-status">Floor pivots · 20-bar HL</span>
          </header>
          @if (levelStats(); as l) {
            <div class="bias-pill flat">
              Nearest: <strong>{{ l.nearestLabel }}</strong> · {{ l.nearestDistPips.toFixed(1) }}p
            </div>
            <dl class="dense-stats">
              <div>
                <dt>R2</dt>
                <dd class="mono">{{ formatPrice(l.r2, chartSymbol()) }}</dd>
              </div>
              <div>
                <dt>R1</dt>
                <dd class="mono">{{ formatPrice(l.r1, chartSymbol()) }}</dd>
              </div>
              <div>
                <dt>Pivot</dt>
                <dd class="mono">{{ formatPrice(l.pivot, chartSymbol()) }}</dd>
              </div>
              <div>
                <dt>S1</dt>
                <dd class="mono">{{ formatPrice(l.s1, chartSymbol()) }}</dd>
              </div>
              <div>
                <dt>S2</dt>
                <dd class="mono">{{ formatPrice(l.s2, chartSymbol()) }}</dd>
              </div>
              <div>
                <dt>20-bar high Δ</dt>
                <dd class="mono">−{{ l.distFromHigh20Pips.toFixed(1) }}p</dd>
              </div>
              <div>
                <dt>20-bar low Δ</dt>
                <dd class="mono">+{{ l.distFromLow20Pips.toFixed(1) }}p</dd>
              </div>
              <div>
                <dt>Bar range pos</dt>
                <dd>
                  <div class="percentile-bar">
                    <span class="percentile-fill" [style.width.%]="l.rangePosPct"></span>
                  </div>
                </dd>
              </div>
            </dl>
          } @else {
            <div class="empty-state">
              <span class="muted">Need ≥21 candles for pivots.</span>
              <span class="empty-hint"> Pivots derive from the prior completed candle. </span>
            </div>
          }
        </article>
      </div>

      <!--
        Advanced market analysis row — VWAP, Volume Profile, Depth of
        book, Footprint (estimated), Liquidity Heatmap. The first two
        and the footprint compute UI-side from chartCandles. Depth and
        heatmap fetch /market-data/order-book/* on the same 5s cadence.
      -->
      <div class="insights-grid adv-grid">
        <!-- VWAP ──────────────────────────────────────────────── -->
        <article class="insight-card">
          <header class="insight-head">
            <span class="insight-title">VWAP</span>
            <span class="muted insight-status">session · cum. typical × vol</span>
          </header>
          @if (vwapStats(); as v) {
            <div
              class="bias-pill"
              [class.bullish]="v.position === 'above'"
              [class.bearish]="v.position === 'below'"
              [class.flat]="v.position === 'at'"
            >
              {{ v.position === 'above' ? '▲' : v.position === 'below' ? '▼' : '→' }}
              price {{ v.position }} VWAP
            </div>
            <dl class="dense-stats">
              <div>
                <dt>VWAP</dt>
                <dd class="mono">{{ formatPrice(v.vwap, chartSymbol()) }}</dd>
              </div>
              <div>
                <dt>Δ from VWAP</dt>
                <dd
                  class="mono"
                  [class.profit]="v.distancePips > 0"
                  [class.loss]="v.distancePips < 0"
                >
                  {{ v.distancePips >= 0 ? '+' : '' }}{{ v.distancePips.toFixed(1) }}p
                </dd>
              </div>
              <div>
                <dt>+1σ band</dt>
                <dd class="mono">{{ formatPrice(v.upperBand, chartSymbol()) }}</dd>
              </div>
              <div>
                <dt>−1σ band</dt>
                <dd class="mono">{{ formatPrice(v.lowerBand, chartSymbol()) }}</dd>
              </div>
              <div>
                <dt>Bandwidth</dt>
                <dd class="mono">{{ v.bandwidthPips.toFixed(1) }}p</dd>
              </div>
              <div>
                <dt>Bars in</dt>
                <dd class="mono">{{ v.barsIncluded }}</dd>
              </div>
            </dl>
          } @else {
            <div class="empty-state">
              <span class="muted">Need ≥10 candles with volume.</span>
              <span class="empty-hint">VWAP needs cumulative volume to be meaningful.</span>
            </div>
          }
        </article>

        <!-- Volume Profile ───────────────────────────────────── -->
        <article class="insight-card insight-volprofile">
          <header class="insight-head">
            <span class="insight-title">Volume Profile</span>
            <span class="muted insight-status">distribution · POC · VA70</span>
          </header>
          @if (volumeProfile(); as vp) {
            <div class="vp-meta">
              <span class="vp-poc-chip">
                POC <span class="mono">{{ formatPrice(vp.poc, chartSymbol()) }}</span>
              </span>
              <span class="muted"
                >VA70 {{ formatPrice(vp.vaLow, chartSymbol()) }} –
                {{ formatPrice(vp.vaHigh, chartSymbol()) }}</span
              >
            </div>
            <ul class="vp-rows">
              @for (row of vp.bins; track row.idx) {
                <li class="vp-row" [class.poc]="row.isPoc" [class.in-va]="row.inVa">
                  <span class="mono vp-price">{{ formatPrice(row.priceMid, chartSymbol()) }}</span>
                  <span class="vp-bar-wrap">
                    <span class="vp-bar" [style.width.%]="row.pct"></span>
                  </span>
                  <span class="mono vp-vol">{{ formatVolume(row.volume) }}</span>
                </li>
              }
            </ul>
          } @else {
            <div class="empty-state">
              <span class="muted">Need ≥10 candles with volume.</span>
              <span class="empty-hint"
                >Volume profile distributes each candle's volume across its OHLC range.</span
              >
            </div>
          }
        </article>

        <!-- Depth of book ────────────────────────────────────── -->
        <article class="insight-card insight-depth">
          <header class="insight-head">
            <span class="insight-title">Depth of book</span>
            @if (latestOrderBook(); as ob) {
              <span class="muted insight-status">
                {{ ob.capturedAt | date: 'HH:mm:ss' }}
              </span>
            } @else {
              <span class="muted insight-status">—</span>
            }
          </header>
          @if (depthLadder(); as d) {
            <div class="depth-summary">
              <span class="depth-spread mono"> spread {{ d.spreadPips.toFixed(1) }}p </span>
              <span
                class="depth-imb mono"
                [class.profit]="d.imbalance > 0"
                [class.loss]="d.imbalance < 0"
              >
                imb {{ d.imbalance >= 0 ? '+' : '' }}{{ (d.imbalance * 100).toFixed(0) }}%
              </span>
            </div>
            <div class="depth-ladder">
              <div class="depth-side asks">
                @for (a of d.asks; track a.price) {
                  <div class="depth-row ask">
                    <span class="mono depth-price">{{ formatPrice(a.price, chartSymbol()) }}</span>
                    <span class="depth-bar-wrap">
                      <span class="depth-bar ask" [style.width.%]="a.pct"></span>
                    </span>
                    <span class="mono depth-vol">{{ formatVolume(a.volume) }}</span>
                  </div>
                }
              </div>
              <div class="depth-mid">
                <span class="mono">{{ formatPrice(d.mid, chartSymbol()) }}</span>
                <span class="muted">mid</span>
              </div>
              <div class="depth-side bids">
                @for (b of d.bids; track b.price) {
                  <div class="depth-row bid">
                    <span class="mono depth-price">{{ formatPrice(b.price, chartSymbol()) }}</span>
                    <span class="depth-bar-wrap">
                      <span class="depth-bar bid" [style.width.%]="b.pct"></span>
                    </span>
                    <span class="mono depth-vol">{{ formatVolume(b.volume) }}</span>
                  </div>
                }
              </div>
            </div>
          } @else {
            <div class="empty-state">
              <span class="muted">No depth-of-book snapshot yet.</span>
              <span class="empty-hint">
                The EA streams MarketBook frames on every tick — appears once a frame lands.
              </span>
            </div>
          }
        </article>

        <!-- Footprint (estimated) ───────────────────────────── -->
        <article class="insight-card insight-footprint">
          <header class="insight-head">
            <span class="insight-title">
              Footprint
              <span class="estimated-tag">estimated</span>
            </span>
            <span class="muted insight-status">last 12 bars · OHLCV-derived</span>
          </header>
          @if (footprintRows(); as fr) {
            <div class="fp-legend muted">
              Buy/Sell split derived from close-position within bar range. True aggressor-tagged
              ticks aren't captured at this depth.
            </div>
            <table class="fp-table">
              <thead>
                <tr>
                  <th>Bar</th>
                  <th class="num">Buy</th>
                  <th class="num">Sell</th>
                  <th class="num">Δ</th>
                  <th class="num">CΔ</th>
                </tr>
              </thead>
              <tbody>
                @for (r of fr; track r.idx) {
                  <tr>
                    <td class="mono">{{ r.label }}</td>
                    <td class="num mono profit">{{ formatVolume(r.buy) }}</td>
                    <td class="num mono loss">{{ formatVolume(r.sell) }}</td>
                    <td class="num mono" [class.profit]="r.delta > 0" [class.loss]="r.delta < 0">
                      {{ r.delta >= 0 ? '+' : '' }}{{ formatVolume(Math.abs(r.delta)) }}
                    </td>
                    <td
                      class="num mono"
                      [class.profit]="r.cumDelta > 0"
                      [class.loss]="r.cumDelta < 0"
                    >
                      {{ r.cumDelta >= 0 ? '+' : '' }}{{ formatVolume(Math.abs(r.cumDelta)) }}
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          } @else {
            <div class="empty-state">
              <span class="muted">Need candles with volume to estimate footprint.</span>
            </div>
          }
        </article>

        <!-- Liquidity Heatmap ───────────────────────────────── -->
        <article class="insight-card insight-heatmap">
          <header class="insight-head">
            <span class="insight-title">Liquidity Heatmap</span>
            @if (recentOrderBooks().length > 0) {
              <span class="muted insight-status">
                last {{ recentOrderBooks().length }} snapshots
              </span>
            } @else {
              <span class="muted insight-status">—</span>
            }
          </header>
          @if (liquidityHeatmapOptions(); as opts) {
            <div echarts [options]="opts" [autoResize]="true" class="heatmap-chart"></div>
          } @else {
            <div class="empty-state">
              <span class="muted">Waiting for order book snapshots.</span>
              <span class="empty-hint"> Need ≥5 snapshots to render a heat surface. </span>
            </div>
          }
        </article>
      </div>
    </section>
  `,
})
export class MdMarketInsightsComponent {
  readonly chartSymbol = input.required<string>();
  readonly chartTimeframe = input.required<string>();
  readonly trendStats = input.required<PageValue<'trendStats'>>();
  readonly closeStreak = input.required<number>();
  readonly momentumStats = input.required<PageValue<'momentumStats'>>();
  readonly volatilityStats = input.required<PageValue<'volatilityStats'>>();
  readonly levelStats = input.required<PageValue<'levelStats'>>();
  readonly vwapStats = input.required<PageValue<'vwapStats'>>();
  readonly volumeProfile = input.required<PageValue<'volumeProfile'>>();
  readonly latestOrderBook = input.required<OrderBookSnapshotDto | null>();
  readonly depthLadder = input.required<PageValue<'depthLadder'>>();
  readonly footprintRows = input.required<PageValue<'footprintRows'>>();
  readonly recentOrderBooks = input.required<readonly OrderBookSnapshotDto[]>();
  readonly liquidityHeatmapOptions = input.required<EChartsOption | null>();
  /** The page's price formatter (its per-symbol digits come from the instrument catalogue). */
  readonly formatPriceFn = input.required<(price: number, symbol: string | null) => string>();

  protected readonly Math = Math;
  protected readonly formatVolume = formatVolume;

  protected formatPrice(price: number, symbol: string | null): string {
    return this.formatPriceFn()(price, symbol);
  }
}
