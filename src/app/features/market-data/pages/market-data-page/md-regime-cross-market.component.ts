import { ChangeDetectionStrategy, Component, input, type Signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import type { EChartsOption } from 'echarts';
import type { MarketRegimeSnapshotDto, TradeSignalDto } from '@core/api/api.types';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import type { MarketDataPageComponent } from './market-data-page.component';
import { hasSeries } from './market-data-format';

/** The value type of one of the page's signals, so each input is typed by the computed that feeds it. */
type PageValue<K extends keyof MarketDataPageComponent> =
  MarketDataPageComponent[K] extends Signal<infer V> ? V : never;

/**
 * The chart tab's Regime & Cross-Market panel: the regime snapshot and latest ML prediction for the
 * chart-focused pair, and correlation, spread comparison and tick volatility across watched pairs.
 */
@Component({
  selector: 'app-md-regime-cross-market',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, ChartCardComponent],
  styleUrl: './md-regime-cross-market.component.scss',
  template: `
    <!--
      ═══════════ REGIME & CROSS-MARKET ═══════════
      One panel with the Market Insights chrome: a single frame, a header
      and hairline-divided cells. Regime + ML prediction (5s poll) for the
      chart-focused pair; correlation, spread comparison and tick volatility
      across the watched pairs from the live tick stream.
    -->
    <section class="insights-section">
      <header class="insights-head">
        <h3>Regime &amp; Cross-Market</h3>
        <span class="muted">
          {{ chartSymbol() }} · {{ chartTimeframe() }} · regime and prediction refresh every 5s ·
          spreads and volatility live
        </span>
      </header>

      <div class="insights-grid analytics-grid">
        <!-- Regime ─────────────────────────────────────────────── -->
        <article class="insight-card a-regime">
          <header class="insight-head">
            <span class="insight-title">Regime</span>
            @if (regimeLoading() && !regimeSnapshot()) {
              <span class="muted insight-status">loading…</span>
            } @else if (regimeSnapshot()) {
              <span class="muted insight-status">
                {{ regimeSnapshot()!.detectedAt | date: 'HH:mm:ss' }}
              </span>
            }
          </header>
          @if (regimeSnapshot(); as r) {
            <div
              class="regime-pill"
              [class.trending]="r.regime === 'Trending'"
              [class.ranging]="r.regime === 'Ranging'"
              [class.high-vol]="r.regime === 'HighVolatility'"
              [class.low-vol]="r.regime === 'LowVolatility'"
              [class.crisis]="r.regime === 'Crisis'"
              [class.breakout]="r.regime === 'Breakout'"
            >
              {{ r.regime }}
              <span class="regime-conf">{{ (r.confidence * 100).toFixed(0) }}%</span>
            </div>
            <dl class="regime-stats">
              <div>
                <dt>ADX</dt>
                <dd class="mono" [title]="'Trend strength · >25 = trending'">
                  {{ r.adx.toFixed(2) }}
                </dd>
              </div>
              <div>
                <dt>ATR</dt>
                <dd class="mono" [title]="'Volatility (price units)'">
                  {{ r.atr.toFixed(5) }}
                </dd>
              </div>
              <div>
                <dt>BBW</dt>
                <dd class="mono" [title]="'Bollinger band width · expansion / squeeze'">
                  {{ r.bollingerBandWidth.toFixed(2) }}
                </dd>
              </div>
            </dl>
          } @else {
            <div class="empty-state">
              <span class="muted">No regime snapshot yet.</span>
              <span class="empty-hint">
                RegimeDetectionWorker emits one each cycle — usually appears within a minute.
              </span>
            </div>
          }
        </article>

        <!-- ML Prediction ──────────────────────────────────────── -->
        <article class="insight-card a-pred">
          <header class="insight-head">
            <span class="insight-title">ML Prediction</span>
            @if (predictionLoading() && !latestPredictionSignal()) {
              <span class="muted insight-status">loading…</span>
            } @else if (latestPredictionSignal()) {
              <span class="muted insight-status">
                sig #{{ latestPredictionSignal()!.id }} ·
                {{ latestPredictionSignal()!.generatedAt | date: 'HH:mm:ss' }}
              </span>
            }
          </header>
          @if (latestPredictionSignal(); as s) {
            @if (s.mlPredictedDirection) {
              <div
                class="pred-pill"
                [class.up]="s.mlPredictedDirection === 'Buy'"
                [class.down]="s.mlPredictedDirection === 'Sell'"
              >
                {{ s.mlPredictedDirection === 'Buy' ? '▲' : '▼' }} {{ s.mlPredictedDirection }}
                @if (s.mlConfidenceScore !== null) {
                  <span class="pred-conf"> {{ (s.mlConfidenceScore * 100).toFixed(0) }}% </span>
                }
              </div>
              <dl class="pred-stats">
                @if (s.mlPredictedMagnitude !== null) {
                  <div>
                    <dt>Magnitude</dt>
                    <dd class="mono">{{ s.mlPredictedMagnitude.toFixed(1) }}p</dd>
                  </div>
                }
                <div>
                  <dt>Strategy conf.</dt>
                  <dd class="mono">{{ (s.confidence * 100).toFixed(1) }}%</dd>
                </div>
                <div>
                  <dt>Status</dt>
                  <dd>
                    <span class="status-chip" [class]="'status-' + s.status.toLowerCase()">
                      {{ s.status }}
                    </span>
                  </dd>
                </div>
              </dl>
            } @else {
              <div class="empty-state">
                <span class="muted">Most recent signal had no ML scoring.</span>
                <span class="empty-hint">
                  Strategy emitted signal #{{ s.id }} without an active ML model.
                </span>
              </div>
            }
          } @else {
            <div class="empty-state">
              <span class="muted">No recent trade signal for this pair.</span>
              <span class="empty-hint">
                ML predictions ride along on signals — appears once a strategy fires.
              </span>
            </div>
          }
        </article>

        <!-- Correlation ────────────────────────────────────────── -->
        <article class="insight-card a-corr">
          <header class="insight-head">
            <span class="insight-title">Correlation vs {{ chartSymbol() }}</span>
            <span class="muted insight-status">last 100 ticks</span>
          </header>
          @if (correlations().length > 0) {
            <ul class="corr-list">
              @for (c of correlations(); track c.symbol) {
                <li class="corr-row">
                  <span class="mono corr-symbol">{{ c.symbol }}</span>
                  <span class="corr-bar-wrap">
                    <span
                      class="corr-bar"
                      [class.positive]="c.r > 0"
                      [class.negative]="c.r < 0"
                      [style.width.%]="50 * Math.abs(c.r)"
                      [style.left.%]="c.r >= 0 ? 50 : 50 - 50 * Math.abs(c.r)"
                    ></span>
                    <span class="corr-zero"></span>
                  </span>
                  <span
                    class="mono corr-value"
                    [class.profit]="c.r > 0.3"
                    [class.loss]="c.r < -0.3"
                  >
                    {{ c.r >= 0 ? '+' : '' }}{{ c.r.toFixed(2) }}
                  </span>
                </li>
              }
            </ul>
          } @else {
            <div class="empty-state">
              <span class="muted">Waiting for ticks…</span>
              <span class="empty-hint">
                Need ≥5 ticks per symbol before correlation is meaningful.
              </span>
            </div>
          }
        </article>

        <!-- Spread comparison ─────────────────────────────────── -->
        <article class="insight-card a-spread">
          <header class="insight-head">
            <span class="insight-title">Spread comparison</span>
            <span class="muted insight-status">pips · live</span>
          </header>
          <p class="insight-caption">{{ spreadChartCaption() }}</p>
          @if (hasSeries(spreadChartOptions())) {
            <app-chart-card
              flush
              alt="Live spread per watched FX pair, in pips"
              [options]="spreadChartOptions()"
              [height]="spreadChartHeight()"
            />
          } @else {
            <div class="empty-state">
              <span class="muted">No live spreads yet.</span>
              <span class="empty-hint">Every row is on candle fallback — spreads need a tick.</span>
            </div>
          }
        </article>

        <!-- Tick volatility ───────────────────────────────────── -->
        <article class="insight-card a-vol">
          <header class="insight-head">
            <span class="insight-title">Tick volatility</span>
            <span class="muted insight-status">last 100 ticks</span>
          </header>
          <p class="insight-caption">Average tick-to-tick move in basis points</p>
          @if (hasSeries(volatilityOptions())) {
            <app-chart-card
              flush
              alt="Average tick-to-tick move per watched pair, in basis points"
              [options]="volatilityOptions()"
              height="240px"
            />
          } @else {
            <div class="empty-state">
              <span class="muted">No measurable movement yet.</span>
              <span class="empty-hint">Needs ≥10 ticks per symbol with a non-zero range.</span>
            </div>
          }
        </article>
      </div>
    </section>
  `,
})
export class MdRegimeCrossMarketComponent {
  readonly chartSymbol = input.required<string>();
  readonly chartTimeframe = input.required<string>();
  readonly regimeSnapshot = input.required<MarketRegimeSnapshotDto | null>();
  readonly regimeLoading = input.required<boolean>();
  readonly latestPredictionSignal = input.required<TradeSignalDto | null>();
  readonly predictionLoading = input.required<boolean>();
  readonly correlations = input.required<PageValue<'correlations'>>();
  readonly spreadChartOptions = input.required<EChartsOption>();
  readonly spreadChartHeight = input.required<PageValue<'spreadChartHeight'>>();
  readonly spreadChartCaption = input.required<PageValue<'spreadChartCaption'>>();
  readonly volatilityOptions = input.required<EChartsOption>();

  protected readonly Math = Math;
  protected readonly hasSeries = hasSeries;
}
