import {
  Component,
  ChangeDetectionStrategy,
  inject,
  signal,
  computed,
  effect,
  OnInit,
  OnDestroy,
} from '@angular/core';
import {
  Subject,
  forkJoin,
  from,
  timer,
  takeUntil,
  catchError,
  of,
  Observable,
  map,
  concatMap,
  first,
  switchMap,
  finalize,
} from 'rxjs';
import { DatePipe } from '@angular/common';
import { NgxEchartsDirective } from 'ngx-echarts';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { TabsComponent } from '@shared/components/ui/tabs/tabs.component';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { DataTableComponent } from '@shared/components/data-table/data-table.component';
import { SparklineComponent } from '@shared/components/sparkline/sparkline.component';
import { TradingChartComponent } from '@shared/components/trading-chart/trading-chart.component';
import { MarketDataService } from '@core/services/market-data.service';
import { MarketRegimeService } from '@core/services/market-regime.service';
import { TradeSignalsService } from '@core/services/trade-signals.service';
import { PositionsService } from '@core/services/positions.service';
import { AccountScopeService } from '@core/scope/account-scope.service';
import { CurrencyPairsService } from '@core/services/currency-pairs.service';
import {
  LivePriceDto,
  PagerRequest,
  PagedData,
  CandleDto,
  ResponseData,
  MarketRegimeSnapshotDto,
  TradeSignalDto,
  PositionDto,
  OrderBookSnapshotDto,
  OrderBookLevels,
} from '@core/api/api.types';
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
  // True when the entry was synthesized from the latest candle (no live tick
  // available). Spread is meaningless in that case, so spread KPIs/charts
  // exclude these entries.
  fromCandle: boolean;
}

@Component({
  selector: 'app-market-data-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    NgxEchartsDirective,
    PageHeaderComponent,
    TabsComponent,
    ChartCardComponent,
    MetricCardComponent,
    DataTableComponent,
    SparklineComponent,
    TradingChartComponent,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Market Data"
        subtitle="Live prices, charts, analytics, and candle history"
      />

      <ui-tabs [tabs]="tabs" [(activeTab)]="activeTab" />

      <!-- ═══════════ TRADING CHART TAB ═══════════ -->
      @if (activeTab() === 'chart') {
        <!--
          Stale-feed banner — rendered ABOVE the market-overview grid so
          it spans the full width. Previously it sat inside the 2-col
          overview grid and ate one of its cells, distorting the
          layout when the warning fired.
        -->
        @if (isStaleFeed()) {
          <div class="stale-feed-banner" role="status" aria-live="polite">
            <span class="stale-feed-icon" aria-hidden="true">⚠</span>
            <span class="stale-feed-text">
              Feed stale — last live tick {{ formatAge(feedAgeSec()) }} ago
              @if (lastLiveTickLabel(); as t) {
                ({{ t }} UTC)
              }
              . Showing candle-fallback prices; spread KPIs reflect last-known live values. Depth of
              book and candle panels are fed separately and may be fresher.
            </span>
          </div>
        }

        <!-- Market overview strip: sessions + global market KPIs -->
        <div class="market-overview">
          <div class="sessions-card">
            <div class="sessions-head">
              <span class="muted">Trading sessions</span>
              <span class="session-time mono">{{ utcClockLabel() }} UTC</span>
            </div>
            <!-- One lane per session. The four windows overlap (Sydney/Tokyo
                 00–07, London/New York 13–17), so on a single track the bars
                 stacked and their labels overprinted ("Sydneyyo"). Labels sit
                 in a fixed gutter and never on a bar. -->
            <div class="sessions-track">
              @for (lane of sessionLanes(); track lane.label) {
                <div class="session-lane" [class.active]="lane.active">
                  <span class="lane-label">{{ lane.label }}</span>
                  <div class="lane-track">
                    @for (seg of lane.segments; track $index) {
                      <div
                        class="session-bar"
                        [class.active]="lane.active"
                        [style.left.%]="seg.startPct"
                        [style.width.%]="seg.widthPct"
                        [attr.data-session]="lane.label"
                        [title]="lane.label + ' · ' + lane.range"
                      ></div>
                    }
                    <div class="now-marker" [style.left.%]="nowMarkerPct()"></div>
                  </div>
                </div>
              }
            </div>
            <div class="sessions-active">
              @for (s of activeSessions(); track s) {
                <span class="session-pill">{{ s }}</span>
              }
              @if (activeSessions().length === 0) {
                <span class="muted">No active session</span>
              }
            </div>
          </div>

          <div class="overview-kpis">
            <app-metric-card
              label="Watched pairs"
              [value]="livePrices().length"
              format="number"
              dotColor="#0071E3"
            />
            <app-metric-card
              label="Median spread"
              [value]="medianSpread()"
              format="number"
              dotColor="#FF9500"
            />
            <app-metric-card
              label="Tightest"
              [value]="tightestSpread()"
              format="number"
              dotColor="#34C759"
            />
            <app-metric-card
              label="Widest"
              [value]="widestSpread()"
              format="number"
              dotColor="#FF3B30"
            />
            <app-metric-card
              label="Up / Down"
              [value]="upPairsCount()"
              format="number"
              [dotColor]="upPairsCount() >= downPairsCount() ? '#34C759' : '#FF3B30'"
            />
            <!-- Local tile: the shared card only takes a number, and
                 "93,551" seconds is unreadable — this renders "1d 2h". -->
            <div class="kpi-tile">
              <div class="kpi-tile-head">
                <span
                  class="dot"
                  [style.background]="
                    feedAgeSec() !== null && feedAgeSec()! > 60 ? '#FF3B30' : '#34C759'
                  "
                ></span>
                <span class="kpi-tile-label">Feed age</span>
              </div>
              <div class="kpi-tile-value">{{ formatAge(feedAgeSec()) }}</div>
              @if (lastLiveTickLabel(); as t) {
                <div class="kpi-tile-sub">last tick {{ t }} UTC</div>
              }
            </div>
          </div>
        </div>

        <app-trading-chart
          [positions]="chartOpenPositions()"
          (symbolChange)="chartSymbol.set($event)"
          (timeframeChange)="chartTimeframe.set($event)"
          (candlesChange)="chartCandles.set($event)"
          (slTpModified)="loadInsights()"
        />

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
                  <span class="empty-hint">
                    Switch to a higher timeframe or wait for more bars.
                  </span>
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
                  {{
                    v.expansion === 'expanding' ? '⤢' : v.expansion === 'contracting' ? '⤡' : '→'
                  }}
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
                  Nearest: <strong>{{ l.nearestLabel }}</strong> ·
                  {{ l.nearestDistPips.toFixed(1) }}p
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
                      <span class="mono vp-price">{{
                        formatPrice(row.priceMid, chartSymbol())
                      }}</span>
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
                        <span class="mono depth-price">{{
                          formatPrice(a.price, chartSymbol())
                        }}</span>
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
                        <span class="mono depth-price">{{
                          formatPrice(b.price, chartSymbol())
                        }}</span>
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
                        <td
                          class="num mono"
                          [class.profit]="r.delta > 0"
                          [class.loss]="r.delta < 0"
                        >
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

        <!-- Watch ribbon — compact snapshot of every watched symbol. Renders
             8 cards even with no feed; missing symbols show "—" placeholders
             rather than the whole row collapsing into a blank gap. -->
        <div class="watch-ribbon">
          @for (card of ribbonCards(); track card.symbol) {
            <div
              class="watch-card"
              [class.flash-up]="card.live?.direction === 'up'"
              [class.flash-down]="card.live?.direction === 'down'"
              [class.empty]="!card.live"
            >
              <div class="watch-head">
                <span class="watch-symbol">{{ card.symbol }}</span>
                @if (card.live) {
                  <span
                    class="watch-change"
                    [class.up]="card.live.change > 0"
                    [class.down]="card.live.change < 0"
                  >
                    {{ card.live.change >= 0 ? '+' : '' }}{{ card.live.changePct.toFixed(2) }}%
                  </span>
                } @else {
                  <span class="watch-change muted">—</span>
                }
              </div>
              <div
                class="watch-price mono"
                [class.up]="card.live?.direction === 'up'"
                [class.down]="card.live?.direction === 'down'"
              >
                @if (card.live) {
                  {{ formatPrice(card.live.bid, card.symbol) }}
                } @else {
                  <span class="muted">—</span>
                }
              </div>
              <div class="watch-meta">
                <span class="watch-spread">
                  @if (card.live && !card.live.fromCandle) {
                    {{ card.live.spread.toFixed(1) }} sp
                  } @else if (card.live?.fromCandle) {
                    candle close
                  } @else {
                    no feed
                  }
                </span>
                <span class="watch-spark">
                  @if (card.live && sparkHasMovement(card.live.sparkData)) {
                    <app-sparkline
                      [data]="card.live.sparkData"
                      [color]="sparkColor(card.live.change)"
                      width="100%"
                      height="22px"
                    />
                  } @else if (card.live) {
                    <span class="watch-spark-empty">no bars yet</span>
                  }
                </span>
              </div>
            </div>
          }
        </div>

        <!-- Top movers + recent ticks side-by-side under the ribbon. Always
             rendered; empty states explain why the table is bare. -->
        <div class="movers-row">
          <section class="movers">
            <header class="movers-head">
              <h3>Top movers</h3>
              <span class="muted">Sorted by 24h change %</span>
            </header>
            @if (topMovers().length > 0) {
              <table class="movers-table">
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th class="num">Bid</th>
                    <th class="num">Change %</th>
                    <th class="num">24h range</th>
                    <th class="num">Spread</th>
                  </tr>
                </thead>
                <tbody>
                  @for (p of topMovers(); track p.symbol) {
                    <tr>
                      <td class="mono">{{ p.symbol }}</td>
                      <td class="num mono">{{ formatPrice(p.bid, p.symbol) }}</td>
                      <td
                        class="num mono"
                        [class.profit]="p.changePct > 0"
                        [class.loss]="p.changePct < 0"
                      >
                        {{ p.changePct >= 0 ? '+' : '' }}{{ p.changePct.toFixed(2) }}%
                      </td>
                      <td class="num mono">
                        <!-- A candle-fallback row carries one close for both
                             ends of its "range"; that is not a range. -->
                        @if (!p.fromCandle && p.high24h > p.low24h) {
                          {{ formatPrice(p.low24h, p.symbol) }}–{{
                            formatPrice(p.high24h, p.symbol)
                          }}
                        } @else {
                          <span class="muted">—</span>
                        }
                      </td>
                      <td class="num mono" [class.loss]="p.spread > 3">
                        @if (!p.fromCandle) {
                          {{ p.spread.toFixed(1) }}
                        } @else {
                          <span class="muted">—</span>
                        }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            } @else {
              <div class="empty-state">
                @if (livePrices().length === 0) {
                  <span class="muted">Waiting for live price feed…</span>
                  <span class="empty-hint">Movers populate once the EA pushes a tick.</span>
                } @else {
                  <span class="muted">No pair has moved this session.</span>
                  <span class="empty-hint">Every watched pair is flat since the first poll.</span>
                }
              </div>
            }
          </section>

          <section class="recent-ticks">
            <header class="movers-head">
              <h3>Recent ticks</h3>
              <span class="muted">Last update per symbol</span>
            </header>
            @if (recentTicks().length > 0) {
              <ul class="ticks-list">
                @for (p of recentTicks(); track p.symbol) {
                  <li
                    class="tick-item"
                    [class.up]="p.direction === 'up'"
                    [class.down]="p.direction === 'down'"
                  >
                    <span class="mono tick-symbol">{{ p.symbol }}</span>
                    <span class="mono tick-bid">{{ formatPrice(p.bid, p.symbol) }}</span>
                    <span class="tick-arrow">
                      @if (p.direction === 'up') {
                        ▲
                      } @else if (p.direction === 'down') {
                        ▼
                      } @else {
                        ·
                      }
                    </span>
                    <span class="muted tick-time">{{ p.timestamp | date: 'HH:mm:ss' }}</span>
                  </li>
                }
              </ul>
            } @else {
              <div class="empty-state">
                <span class="muted">No ticks yet.</span>
              </div>
            }
          </section>
        </div>

        <!-- Symbol matrix: per-pair quick stats that always render, even
             without a live feed. Pulls from cached priceHistory when
             available, falls back to neutral placeholders otherwise. -->
        <section class="symbol-matrix">
          <header class="movers-head">
            <h3>Symbol matrix</h3>
            <span class="muted">Live snapshot · history grows as ticks arrive</span>
          </header>
          <div class="matrix-scroll">
            <table class="movers-table">
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th class="num">Bid</th>
                  <th class="num">Ask</th>
                  <th class="num">Spread</th>
                  <th class="num">High</th>
                  <th class="num">Low</th>
                  <th class="num">Range (pips)</th>
                  <th class="num">Δ %</th>
                  <th>Trend</th>
                </tr>
              </thead>
              <tbody>
                @for (row of symbolMatrix(); track row.symbol) {
                  <tr>
                    <td class="mono">{{ row.symbol }}</td>
                    <td class="num mono">
                      @if (row.live) {
                        {{ formatPrice(row.live.bid, row.symbol) }}
                      } @else {
                        <span class="muted">—</span>
                      }
                    </td>
                    <!-- Ask / high / low are dashes on a candle-fallback row:
                         the fallback copies one close into all of them, so
                         "bid = ask, high = low" was the fallback, not the
                         market. -->
                    <td class="num mono">
                      @if (row.live && !row.live.fromCandle) {
                        {{ formatPrice(row.live.ask, row.symbol) }}
                      } @else {
                        <span class="muted">—</span>
                      }
                    </td>
                    <td class="num mono" [class.loss]="row.live && row.live.spread > 3">
                      @if (row.live && !row.live.fromCandle) {
                        {{ row.live.spread.toFixed(1) }}
                      } @else {
                        <span class="muted">—</span>
                      }
                    </td>
                    <td class="num mono">
                      @if (row.live && !row.live.fromCandle) {
                        {{ formatPrice(row.live.high24h, row.symbol) }}
                      } @else {
                        <span class="muted">—</span>
                      }
                    </td>
                    <td class="num mono">
                      @if (row.live && !row.live.fromCandle) {
                        {{ formatPrice(row.live.low24h, row.symbol) }}
                      } @else {
                        <span class="muted">—</span>
                      }
                    </td>
                    <td class="num mono">
                      @if (row.rangePips !== null) {
                        {{ row.rangePips.toFixed(1) }}
                      } @else {
                        <span class="muted">—</span>
                      }
                    </td>
                    <td
                      class="num mono"
                      [class.profit]="row.live && row.live.changePct > 0"
                      [class.loss]="row.live && row.live.changePct < 0"
                    >
                      @if (row.live) {
                        {{ row.live.changePct >= 0 ? '+' : '' }}{{ row.live.changePct.toFixed(2) }}%
                      } @else {
                        <span class="muted">—</span>
                      }
                    </td>
                    <td>
                      @if (sparkHasMovement(row.spark)) {
                        <app-sparkline
                          [data]="row.spark"
                          [color]="sparkColor(row.live?.changePct ?? 0)"
                          width="120px"
                          height="20px"
                        />
                      } @else {
                        <span class="muted">—</span>
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </section>

        <!-- Single analytics row: regime / ML prediction / correlation
             (relocated from the Market Insights section above) sharing one row
             with the spread & volatility charts. The three insight panels get
             standalone card chrome here via .analytics-row > .insight-card. -->
        <div class="analytics-row">
          <!-- Regime ─────────────────────────────────────────────── -->
          <article class="insight-card">
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
          <article class="insight-card">
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
          <article class="insight-card insight-correlation">
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

          <!-- Spread comparison + volatility — same row as the insight panels.
               Reuse computeds defined for the analytics tab; when there's no
               data they short-circuit to {} which renders an empty card. -->
          @if (hasSeries(spreadChartOptions())) {
            <app-chart-card
              title="Spread comparison"
              [subtitle]="spreadChartCaption()"
              [options]="spreadChartOptions()"
              height="240px"
            />
          } @else {
            <article class="chart-empty-card">
              <h3 class="chart-title">Spread comparison</h3>
              <p class="chart-subtitle">{{ spreadChartCaption() }}</p>
              <div class="chart-empty-body" [style.height.px]="240">
                <span class="muted">No live spreads yet.</span>
                <span class="empty-hint"
                  >Every row is on candle fallback — spreads need a tick.</span
                >
              </div>
            </article>
          }
          @if (hasSeries(volatilityOptions())) {
            <app-chart-card
              title="Volatility (last 100 ticks)"
              subtitle="Average tick-to-tick move in basis points"
              [options]="volatilityOptions()"
              height="240px"
            />
          } @else {
            <article class="chart-empty-card">
              <h3 class="chart-title">Volatility (last 100 ticks)</h3>
              <p class="chart-subtitle">Average tick-to-tick move in basis points</p>
              <div class="chart-empty-body" [style.height.px]="240">
                <span class="muted">No measurable movement yet.</span>
                <span class="empty-hint">Needs ≥10 ticks per symbol with a non-zero range.</span>
              </div>
            </article>
          }
        </div>
      }

      <!-- ═══════════ LIVE PRICES TAB ═══════════ -->
      @if (activeTab() === 'prices') {
        <!-- 8-card KPI strip — counts, spread extremes, movement, activity. -->
        <div class="kpi-strip">
          <app-metric-card
            label="Watched Pairs"
            [value]="livePrices().length"
            format="number"
            dotColor="#0071E3"
          />
          <app-metric-card
            label="Live feed"
            [value]="liveCount()"
            format="number"
            dotColor="#34C759"
          />
          <app-metric-card
            label="On candle"
            [value]="candleCount()"
            format="number"
            [dotColor]="candleCount() > 0 ? '#FF9500' : '#34C759'"
          />
          <app-metric-card
            label="Median spread"
            [value]="medianSpread()"
            format="number"
            dotColor="#FF9500"
          />
          <app-metric-card
            label="Tightest"
            [value]="tightestSpread()"
            format="number"
            dotColor="#34C759"
          />
          <app-metric-card
            label="Widest"
            [value]="widestSpread()"
            format="number"
            dotColor="#FF3B30"
          />
          <app-metric-card
            label="Up / Down"
            [value]="upPairsCount()"
            [delta]="upPairsCount() - downPairsCount()"
            format="number"
            [dotColor]="upPairsCount() >= downPairsCount() ? '#34C759' : '#FF3B30'"
          />
          <app-metric-card
            label="Tick changes"
            [value]="tickActivity()"
            format="number"
            dotColor="#AF52DE"
          />
        </div>

        <!-- Dense price board — 8 cards with bid/ask/mid, range bar, range
             in pips, sparkline, source pill, last-update stamp. -->
        <div class="price-grid">
          @for (price of livePrices(); track price.symbol) {
            <div
              class="price-card"
              [class.flash-up]="price.direction === 'up'"
              [class.flash-down]="price.direction === 'down'"
            >
              <div class="price-header">
                <div class="symbol-info">
                  <span class="symbol-name">{{ price.symbol }}</span>
                  <span
                    class="symbol-change"
                    [class.up]="price.change > 0"
                    [class.down]="price.change < 0"
                  >
                    {{ price.change >= 0 ? '+' : '' }}{{ price.changePct.toFixed(2) }}%
                  </span>
                </div>
                <!-- Spread only when it is a real one; the card's source pill
                     in the footer is the single "candle" marker. -->
                @if (!price.fromCandle) {
                  <span class="spread-badge" [class.wide]="price.spread > 3">
                    {{ price.spread.toFixed(1) }} sp
                  </span>
                }
              </div>

              <div class="price-main">
                <div class="bid-ask">
                  <div class="price-col">
                    <span class="price-label">BID</span>
                    <span
                      class="price-number bid"
                      [class.tick-up]="price.direction === 'up'"
                      [class.tick-down]="price.direction === 'down'"
                    >
                      {{ formatPrice(price.bid, price.symbol) }}
                    </span>
                  </div>
                  <div class="price-mid">
                    <span class="mid-label">MID</span>
                    <span class="mid-value">
                      {{ formatPrice((price.bid + price.ask) / 2, price.symbol) }}
                    </span>
                  </div>
                  <div class="price-col right">
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
                  <div
                    class="range-fill"
                    [style.left]="getRangePosition(price) + '%'"
                    [style.width]="'4px'"
                  ></div>
                </div>
                <span class="range-label">H {{ formatPrice(price.high24h, price.symbol) }}</span>
              </div>

              <div class="price-sparkline">
                @if (sparkHasMovement(price.sparkData)) {
                  <app-sparkline
                    [data]="price.sparkData"
                    [color]="sparkColor(price.change)"
                    width="100%"
                    height="36px"
                  />
                } @else {
                  <div class="sparkline-empty">
                    {{ price.sparkData.length > 1 ? 'no movement yet' : 'collecting ticks…' }}
                  </div>
                }
              </div>

              <div class="price-foot">
                <span class="foot-pill" [class.candle]="price.fromCandle">
                  {{ price.fromCandle ? 'CANDLE' : 'LIVE' }}
                </span>
                <span class="foot-stat"> Range {{ rangeInPips(price).toFixed(1) }} pips </span>
                <span class="foot-time">
                  {{ price.timestamp | date: 'HH:mm:ss' }}
                </span>
              </div>
            </div>
          }
        </div>

        <!-- Spread board — full width. A 23-row table beside a 280px chart
             left the chart floating above 1,400px of empty column. -->
        <div class="board-row">
          <section class="spread-board">
            <header class="board-head">
              <h3>Spread board</h3>
              <span class="muted">Sorted tightest first</span>
            </header>
            <table class="board-table">
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th class="num">Bid</th>
                  <th class="num">Ask</th>
                  <th class="num">Mid</th>
                  <th class="num">Spread</th>
                  <th class="num">Range pips</th>
                  <th>Source</th>
                </tr>
              </thead>
              <tbody>
                @for (p of spreadBoard(); track p.symbol) {
                  <tr>
                    <td class="mono">{{ p.symbol }}</td>
                    <td class="num mono">{{ formatPrice(p.bid, p.symbol) }}</td>
                    <td class="num mono">{{ formatPrice(p.ask, p.symbol) }}</td>
                    <td class="num mono">{{ formatPrice((p.bid + p.ask) / 2, p.symbol) }}</td>
                    <td class="num mono" [class.loss]="p.spread > 3">
                      @if (!p.fromCandle) {
                        {{ p.spread.toFixed(1) }}
                      } @else {
                        <span class="muted">—</span>
                      }
                    </td>
                    <td class="num mono">{{ rangeInPips(p).toFixed(1) }}</td>
                    <td>
                      <span class="src-pill" [class.candle]="p.fromCandle">
                        {{ p.fromCandle ? 'CANDLE' : 'LIVE' }}
                      </span>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </section>
        </div>

        <!-- Currency strength + Spread comparison + Activity feed on one row.
             Currency strength lives only on this tab now — it was duplicated
             on Price Analytics with the same (often all-zero) data. -->
        <div class="charts-row three-col">
          @if (!currencyStrengthAllFlat()) {
            <app-chart-card
              title="Currency strength"
              subtitle="Aggregate Δ% across each currency's pairs (positive = base appreciating)"
              [options]="currencyStrengthOptions()"
              height="280px"
            />
          } @else {
            <article class="chart-empty-card">
              <h3 class="chart-title">Currency strength</h3>
              <p class="chart-subtitle">Aggregate Δ% across each currency's pairs</p>
              <div class="chart-empty-body" [style.height.px]="280">
                <span class="muted">All currencies flat.</span>
                <span class="empty-hint">No watched pair has moved since the first poll.</span>
              </div>
            </article>
          }

          @if (hasSeries(spreadChartOptions())) {
            <app-chart-card
              title="Spread comparison"
              [subtitle]="spreadChartCaption()"
              [options]="spreadChartOptions()"
              height="280px"
            />
          } @else {
            <article class="chart-empty-card">
              <h3 class="chart-title">Spread comparison</h3>
              <p class="chart-subtitle">{{ spreadChartCaption() }}</p>
              <div class="chart-empty-body" [style.height.px]="280">
                <span class="muted">No live spreads yet.</span>
                <span class="empty-hint"
                  >Every row is on candle fallback — spreads need a tick.</span
                >
              </div>
            </article>
          }

          <section class="activity-feed">
            <header class="board-head">
              <h3>Activity feed</h3>
              <span class="muted">Most recent direction change per symbol</span>
            </header>
            @if (activityFeed().length > 0) {
              <ul class="feed-list">
                @for (ev of activityFeed(); track $index) {
                  <li
                    class="feed-item"
                    [class.up]="ev.direction === 'up'"
                    [class.down]="ev.direction === 'down'"
                  >
                    <span class="feed-time mono">{{ ev.time | date: 'HH:mm:ss' }}</span>
                    <span class="feed-symbol mono">{{ ev.symbol }}</span>
                    <span class="feed-arrow">
                      {{ ev.direction === 'up' ? '▲' : ev.direction === 'down' ? '▼' : '·' }}
                    </span>
                    <span class="feed-price mono">{{ ev.price }}</span>
                    <span class="feed-delta mono">
                      {{ ev.delta >= 0 ? '+' : '' }}{{ ev.delta.toFixed(1) }}p
                    </span>
                  </li>
                }
              </ul>
            } @else {
              <div class="empty-state">
                <span class="muted">No direction changes recorded yet.</span>
                <span class="empty-hint">Each polling cycle adds entries here.</span>
              </div>
            }
          </section>
        </div>
      }

      <!-- ═══════════ PRICE ANALYTICS TAB ═══════════ -->
      @if (activeTab() === 'analytics') {
        <!-- 8-card KPI strip — analytics roll-ups -->
        <div class="kpi-strip">
          <app-metric-card
            label="Symbols tracked"
            [value]="livePrices().length"
            format="number"
            dotColor="#0071E3"
          />
          <app-metric-card
            label="Data points"
            [value]="analyticsKpis().dataPoints"
            format="number"
            dotColor="#5AC8FA"
          />
          <app-metric-card
            label="Avg volatility (bps)"
            [value]="analyticsKpis().avgVolatility"
            format="number"
            dotColor="#AF52DE"
          />
          <app-metric-card
            label="Max volatility (bps)"
            [value]="analyticsKpis().maxVolatility"
            format="number"
            dotColor="#FF3B30"
          />
          <app-metric-card
            label="Avg range (pips)"
            [value]="analyticsKpis().avgRange"
            format="number"
            dotColor="#FF9500"
          />
          <app-metric-card
            label="Max range (pips)"
            [value]="analyticsKpis().maxRange"
            format="number"
            dotColor="#FF2D55"
          />
          <app-metric-card
            label="Strong + corr (≥ .70)"
            [value]="analyticsKpis().strongPos"
            format="number"
            dotColor="#34C759"
          />
          <app-metric-card
            label="Strong − corr (≤ −.70)"
            [value]="analyticsKpis().strongNeg"
            format="number"
            dotColor="#FF3B30"
          />
        </div>

        <!-- Every chart on this tab short-circuits to {} until its series has
             real movement; a bare titled 320px box read as a broken chart, so
             each one carries a one-line empty state that says what it needs. -->
        <div class="charts-grid">
          @if (hasSeries(priceHistoryOptions())) {
            <app-chart-card
              title="Price Movement"
              subtitle="% change from first observed bid, per pair (last 100 ticks)"
              [options]="priceHistoryOptions()"
              height="320px"
            />
          } @else {
            <article class="chart-empty-card">
              <h3 class="chart-title">Price Movement</h3>
              <p class="chart-subtitle">% change from first observed bid, per pair</p>
              <div class="chart-empty-body" [style.height.px]="320">
                <span class="muted">No pair has moved yet.</span>
                <span class="empty-hint"
                  >Lines appear once a symbol has ≥10 ticks with a range.</span
                >
              </div>
            </article>
          }
          @if (hasSeries(spreadHistoryOptions())) {
            <app-chart-card
              title="Spread History"
              subtitle="Spread over time per pair (live-only)"
              [options]="spreadHistoryOptions()"
              height="320px"
            />
          } @else {
            <article class="chart-empty-card">
              <h3 class="chart-title">Spread History</h3>
              <p class="chart-subtitle">Spread over time per pair (live-only)</p>
              <div class="chart-empty-body" [style.height.px]="320">
                <span class="muted">No live spread samples yet.</span>
                <span class="empty-hint"
                  >Candle-fallback rows carry no spread; needs live ticks.</span
                >
              </div>
            </article>
          }
        </div>
        <div class="charts-grid">
          @if (hasSeries(volatilityOptions())) {
            <app-chart-card
              title="Volatility Gauge"
              subtitle="Tick-to-tick volatility (basis points)"
              [options]="volatilityOptions()"
              height="280px"
            />
          } @else {
            <article class="chart-empty-card">
              <h3 class="chart-title">Volatility Gauge</h3>
              <p class="chart-subtitle">Tick-to-tick volatility (basis points)</p>
              <div class="chart-empty-body" [style.height.px]="280">
                <span class="muted">No measurable movement yet.</span>
                <span class="empty-hint">Needs ≥10 ticks per symbol with a non-zero range.</span>
              </div>
            </article>
          }
          @if (hasCorrelationData()) {
            <app-chart-card
              title="Correlation Matrix"
              subtitle="Pearson r across rolling priceHistory windows · live data"
              [options]="correlationOptions()"
              height="280px"
            />
          } @else {
            <article class="chart-empty-card">
              <h3 class="chart-title">Correlation Matrix</h3>
              <p class="chart-subtitle">Pearson r across rolling priceHistory windows</p>
              <div class="chart-empty-body" [style.height.px]="280">
                <span class="muted">Not enough movement to correlate.</span>
                <span class="empty-hint"
                  >r is undefined at zero variance; needs ≥10 shared moving ticks.</span
                >
              </div>
            </article>
          }
        </div>
        <div class="charts-grid one">
          @if (spreadHeatmapOptions(); as heatmap) {
            <app-chart-card
              title="Bid-Ask Spread Heatmap"
              [subtitle]="spreadHeatmapCaption()"
              [options]="heatmap"
              height="280px"
            />
          } @else {
            <article class="chart-empty-card">
              <h3 class="chart-title">Bid-Ask Spread Heatmap</h3>
              <p class="chart-subtitle">{{ spreadHeatmapCaption() }}</p>
              <div class="chart-empty-body" [style.height.px]="200">
                <span class="muted">No live spread samples yet this session.</span>
                <span class="empty-hint">Fills in as ticks arrive, one cell per UTC hour.</span>
              </div>
            </article>
          }
        </div>
        <div class="charts-grid">
          @if (hasSeries(priceDistOptions())) {
            <app-chart-card
              title="Price Distribution"
              [subtitle]="
                'Bid price distribution (last 100 ticks)' +
                (priceDistSymbol() ? ' · ' + priceDistSymbol() : '')
              "
              [options]="priceDistOptions()"
              height="280px"
            />
          } @else {
            <article class="chart-empty-card">
              <h3 class="chart-title">Price Distribution</h3>
              <p class="chart-subtitle">Bid price distribution (last 100 ticks)</p>
              <div class="chart-empty-body" [style.height.px]="280">
                <span class="muted">No pair has moved yet.</span>
                <span class="empty-hint"
                  >A flat series is a single bar — shown once a range exists.</span
                >
              </div>
            </article>
          }
          <!-- Range vs Volatility scatter — out-of-shape pair detector. -->
          @if (hasSeries(rangeVsVolatilityOptions())) {
            <app-chart-card
              title="Range vs Volatility"
              subtitle="One dot per symbol · color = today's direction"
              [options]="rangeVsVolatilityOptions()"
              height="280px"
            />
          } @else {
            <article class="chart-empty-card">
              <h3 class="chart-title">Range vs Volatility</h3>
              <p class="chart-subtitle">One dot per symbol · color = today's direction</p>
              <div class="chart-empty-body" [style.height.px]="280">
                <span class="muted">No symbol has a defined range yet.</span>
                <span class="empty-hint">Dots appear once a pair has moved.</span>
              </div>
            </article>
          }
        </div>

        <!-- Per-symbol statistics table — comprehensive end-of-tab summary. -->
        <section class="stats-table-card">
          <header class="board-head">
            <h3>Per-symbol statistics</h3>
            <span class="muted">Computed from rolling priceHistory window</span>
          </header>
          <table class="board-table">
            <thead>
              <tr>
                <th>Symbol</th>
                <th class="num">Points</th>
                <th class="num">Current</th>
                <th class="num">Mean</th>
                <th class="num">Std dev</th>
                <th class="num">Min</th>
                <th class="num">Max</th>
                <th class="num">Range (pips)</th>
                <th class="num">Vol (bps)</th>
                <th class="num">Z-score</th>
                <th class="num">Δ %</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              @for (s of perSymbolStats(); track s.symbol) {
                <tr>
                  <td class="mono">{{ s.symbol }}</td>
                  <td class="num mono">{{ s.points }}</td>
                  <td class="num mono">{{ formatPriceOrDash(s.current, s.symbol) }}</td>
                  <td class="num mono">{{ formatPriceOrDash(s.mean, s.symbol) }}</td>
                  <td class="num mono">{{ fixedOrDash(s.stdDev, 6) }}</td>
                  <td class="num mono">{{ formatPriceOrDash(s.min, s.symbol) }}</td>
                  <td class="num mono">{{ formatPriceOrDash(s.max, s.symbol) }}</td>
                  <td class="num mono">{{ fixedOrDash(s.rangePips, 1) }}</td>
                  <td class="num mono">{{ fixedOrDash(s.volatility, 2) }}</td>
                  <td
                    class="num mono"
                    [class.profit]="s.zScore !== null && s.zScore > 1"
                    [class.loss]="s.zScore !== null && s.zScore < -1"
                  >
                    {{ fixedOrDash(s.zScore, 2) }}
                  </td>
                  <td
                    class="num mono"
                    [class.profit]="s.changePct > 0"
                    [class.loss]="s.changePct < 0"
                  >
                    {{ s.changePct >= 0 ? '+' : '' }}{{ s.changePct.toFixed(3) }}%
                  </td>
                  <td>
                    <span class="src-pill" [class.candle]="s.fromCandle">
                      {{ s.fromCandle ? 'CANDLE' : 'LIVE' }}
                    </span>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </section>
      }

      <!-- ═══════════ CANDLE HISTORY TAB ═══════════ -->
      @if (activeTab() === 'candles') {
        <!-- 8-card KPI strip — derived from a 200-candle analytics sample -->
        <div class="kpi-strip">
          <app-metric-card
            label="Candles in sample"
            [value]="candleAnalytics().total"
            format="number"
            dotColor="#0071E3"
          />
          <app-metric-card
            label="Symbols"
            [value]="candleAnalytics().symbolCount"
            format="number"
            dotColor="#5AC8FA"
          />
          <app-metric-card
            label="Timeframes"
            [value]="candleAnalytics().timeframeCount"
            format="number"
            dotColor="#AF52DE"
          />
          <app-metric-card
            label="Bullish %"
            [value]="candleAnalytics().bullPct"
            format="percent"
            [dotColor]="candleAnalytics().bullPct >= 50 ? '#34C759' : '#FF3B30'"
          />
          <app-metric-card
            label="Avg range (pips)"
            [value]="candleAnalytics().avgRangePips"
            format="number"
            dotColor="#FF9500"
          />
          <app-metric-card
            label="Max range (pips)"
            [value]="candleAnalytics().maxRangePips"
            format="number"
            dotColor="#FF2D55"
          />
          <app-metric-card
            label="Avg volume"
            [value]="candleAnalytics().avgVolume"
            format="number"
            dotColor="#34C759"
          />
          <app-metric-card
            label="Total volume"
            [value]="candleAnalytics().totalVolume"
            format="number"
            dotColor="#0071E3"
          />
        </div>

        <!-- 3-col chart row: bull/bear donut, range histogram, volume by symbol -->
        <div class="charts-grid three">
          <app-chart-card
            title="Bull vs Bear"
            subtitle="Direction distribution across the sample"
            [options]="bullBearDonutOptions()"
            height="260px"
          />
          <app-chart-card
            title="Range distribution"
            subtitle="Histogram of high–low range in pips"
            [options]="rangeHistogramOptions()"
            height="260px"
          />
          <app-chart-card
            title="Volume by symbol"
            subtitle="Total candle volume across the sample"
            [options]="volumeBySymbolOptions()"
            height="260px"
          />
        </div>

        <!-- Per-symbol + per-timeframe summary tables side-by-side -->
        <div class="summary-row">
          <section class="summary-card">
            <header class="board-head">
              <h3>Per-symbol breakdown</h3>
              <span class="muted">Aggregated over the sample</span>
            </header>
            <table class="board-table">
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th class="num">Candles</th>
                  <th class="num">Bull %</th>
                  <th class="num">Avg range (pips)</th>
                  <th class="num">Max range (pips)</th>
                  <th class="num">Total volume</th>
                  <th class="num">Net Δ %</th>
                </tr>
              </thead>
              <tbody>
                @for (row of perSymbolCandleStats(); track row.symbol) {
                  <tr>
                    <td class="mono">{{ row.symbol }}</td>
                    <td class="num mono">{{ row.candles }}</td>
                    <td
                      class="num mono"
                      [class.profit]="row.bullPct >= 60"
                      [class.loss]="row.bullPct <= 40"
                    >
                      {{ row.bullPct.toFixed(0) }}%
                    </td>
                    <td class="num mono">{{ row.avgRangePips.toFixed(1) }}</td>
                    <td class="num mono">{{ row.maxRangePips.toFixed(1) }}</td>
                    <td class="num mono">{{ formatVolume(row.totalVolume) }}</td>
                    <td
                      class="num mono"
                      [class.profit]="row.netChangePct > 0"
                      [class.loss]="row.netChangePct < 0"
                    >
                      {{ row.netChangePct >= 0 ? '+' : '' }}{{ row.netChangePct.toFixed(2) }}%
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </section>

          <section class="summary-card">
            <header class="board-head">
              <h3>Per-timeframe breakdown</h3>
              <span class="muted">Activity per chart resolution</span>
            </header>
            <table class="board-table">
              <thead>
                <tr>
                  <th>TF</th>
                  <th class="num">Candles</th>
                  <th class="num">Bull %</th>
                  <th class="num">Avg range (pips)</th>
                  <th class="num">Avg volume</th>
                </tr>
              </thead>
              <tbody>
                @for (row of perTimeframeCandleStats(); track row.timeframe) {
                  <tr>
                    <td class="mono">{{ row.timeframe }}</td>
                    <td class="num mono">{{ row.candles }}</td>
                    <td
                      class="num mono"
                      [class.profit]="row.bullPct >= 60"
                      [class.loss]="row.bullPct <= 40"
                    >
                      {{ row.bullPct.toFixed(0) }}%
                    </td>
                    <td class="num mono">{{ row.avgRangePips.toFixed(1) }}</td>
                    <td class="num mono">{{ formatVolume(row.avgVolume) }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </section>
        </div>

        <!-- Notable candles + main table -->
        <div class="notable-row">
          <section class="summary-card">
            <header class="board-head">
              <h3>Top movers in sample</h3>
              <span class="muted">Largest body % per direction</span>
            </header>
            <table class="board-table">
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>TF</th>
                  <th class="num">Open</th>
                  <th class="num">Close</th>
                  <th class="num">Δ pips</th>
                  <th class="num">Body %</th>
                  <th>Time</th>
                </tr>
              </thead>
              <tbody>
                @for (c of notableCandles(); track c.id) {
                  <tr>
                    <td class="mono">{{ c.symbol }}</td>
                    <td class="mono">{{ c.timeframe }}</td>
                    <td class="num mono">{{ formatPrice(c.open, c.symbol) }}</td>
                    <td class="num mono">{{ formatPrice(c.close, c.symbol) }}</td>
                    <td
                      class="num mono"
                      [class.profit]="c.deltaPips > 0"
                      [class.loss]="c.deltaPips < 0"
                    >
                      {{ c.deltaPips >= 0 ? '+' : '' }}{{ c.deltaPips.toFixed(1) }}
                    </td>
                    <td
                      class="num mono"
                      [class.profit]="c.bodyPct > 0"
                      [class.loss]="c.bodyPct < 0"
                    >
                      {{ c.bodyPct >= 0 ? '+' : '' }}{{ c.bodyPct.toFixed(2) }}%
                    </td>
                    <td class="mono">{{ formatUtcMinute(c.timestamp) }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </section>
        </div>

        <!-- Existing paged candle data-table — full historical browser. -->
        <!-- Generated bars used to fill this table silently whenever the
             endpoint came back empty — random prices with hour-spaced stamps
             read as real history. They are opt-in now and labelled. -->
        @if (showSampleCandles()) {
          <div class="sample-banner warn" role="status">
            <span>
              <b>Sample data.</b> These bars are randomly generated for layout checks — not market
              history. Prices, times and volumes are invented.
            </span>
            <button type="button" class="link-btn" (click)="toggleSampleCandles()">
              Back to engine data
            </button>
          </div>
        } @else if (candleSourceEmpty()) {
          <div class="sample-banner" role="status">
            <span>
              The engine returned no candles for this query (<code>/market-data/candle/list</code>).
              Check the EA candle backfill or widen the filter.
            </span>
            <button type="button" class="link-btn" (click)="toggleSampleCandles()">
              Show sample data
            </button>
          </div>
        }
        <section class="data-table-card">
          <header class="board-head">
            <h3>All candles</h3>
            <span class="muted">
              {{
                showSampleCandles()
                  ? 'Sample data — not market history'
                  : 'Browse the complete OHLCV history'
              }}
            </span>
          </header>
          <app-data-table [columnDefs]="candleColumns" [fetchData]="fetchCandles" />
        </section>
      }
    </div>
  `,
  styleUrl: './market-data-page.component.scss',
})
export class MarketDataPageComponent implements OnInit, OnDestroy {
  /** Expose `Math` for use in the template (correlation bar widths). */
  protected readonly Math = Math;

  private marketDataService = inject(MarketDataService);
  private regimeService = inject(MarketRegimeService);
  private tradeSignalsService = inject(TradeSignalsService);
  private positionsService = inject(PositionsService);
  private accountScope = inject(AccountScopeService);
  private currencyPairsService = inject(CurrencyPairsService);
  private destroy$ = new Subject<void>();

  // ── Market Insights state (chart-focused symbol/timeframe) ───────────
  /**
   * Symbol the embedded trading chart is currently focused on (slash form,
   * e.g. "EUR/USD"). Mirrored from the chart's `symbolChange` output so
   * the Insights row follows whichever instrument the operator is reading.
   */
  readonly chartSymbol = signal<string>('EUR/USD');
  /** Timeframe selected on the embedded chart (M1/M5/M15/H1/H4/D1). */
  readonly chartTimeframe = signal<string>('H1');

  /** Latest regime snapshot for (chartSymbol, chartTimeframe). */
  readonly regimeSnapshot = signal<MarketRegimeSnapshotDto | null>(null);
  readonly regimeLoading = signal<boolean>(false);

  /**
   * Most recent trade signal for the chart-focused (symbol, timeframe). The
   * signal carries the ML scoring fields (`mlPredictedDirection`,
   * `mlConfidenceScore`, `mlPredictedMagnitude`) that we surface as the
   * "latest prediction". Null until the first fetch completes — there's
   * no dedicated `/ml-prediction-log/latest` endpoint yet, so we piggy-back
   * on TradeSignalDto which is the only place the engine exposes these
   * fields read-side.
   */
  readonly latestPredictionSignal = signal<TradeSignalDto | null>(null);
  readonly predictionLoading = signal<boolean>(false);

  /**
   * Open positions for the chart-focused symbol — overlaid on the chart
   * as entry / SL / TP horizontal lines. Refreshed on the same 5s
   * cadence as regime / prediction. Filtered server-side by symbol +
   * Status=Open so we only ship live positions to the chart.
   */
  readonly chartOpenPositions = signal<PositionDto[]>([]);
  readonly positionsLoading = signal<boolean>(false);

  /** Latest depth-of-book snapshot for the chart-focused symbol (drives the
   *  Depth-of-book card). Null until the EA streams a MarketBook frame. */
  readonly latestOrderBook = signal<OrderBookSnapshotDto | null>(null);

  /** Recent order book snapshots (newest first, capped at 120 server-side)
   *  for the chart-focused symbol — drives the liquidity heatmap. */
  readonly recentOrderBooks = signal<OrderBookSnapshotDto[]>([]);

  /**
   * Pearson correlation between the chart-focused symbol's tick returns and
   * each of the other watched pairs over the rolling 100-tick history. Range
   * [-1, 1]. Computed live in the UI from `priceHistory`; no engine call
   * needed since we already cache returns per symbol for analytics.
   */
  readonly correlations = computed<{ symbol: string; r: number }[]>(() => {
    // Bind to livePrices so the value updates as new ticks arrive.
    this.livePrices();
    const focusSlash = this.chartSymbol();
    const focusJoined = focusSlash.replace(/\//g, '');
    const focusHist = this.priceHistory[focusJoined] ?? [];
    if (focusHist.length < 5) return [];
    const focusReturns = this.toReturns(focusHist);
    const out: { symbol: string; r: number }[] = [];
    for (let i = 0; i < this.watchedSymbols().length; i++) {
      const apiSym = this.watchedSymbols()[i];
      const dispSym = this.displaySymbols()[i];
      if (apiSym === focusJoined) continue;
      // Exotics (USD/NGN, USD/CNH) have flat/dead price history → r ≈ 0, which
      // is meaningless noise in the correlation panel. Skip them.
      if (this.isExoticPair(dispSym)) continue;
      const hist = this.priceHistory[apiSym] ?? [];
      if (hist.length < 5) continue;
      const rets = this.toReturns(hist);
      // Align to the shorter of the two return series.
      const n = Math.min(focusReturns.length, rets.length);
      if (n < 5) continue;
      const a = focusReturns.slice(-n);
      const b = rets.slice(-n);
      out.push({ symbol: dispSym, r: this.pearson(a, b) });
    }
    return out.sort((x, y) => y.r - x.r);
  });

  /** Convert a price history array to a percent-return series. */
  private toReturns(hist: number[]): number[] {
    const out: number[] = [];
    for (let i = 1; i < hist.length; i++) {
      const prev = hist[i - 1];
      if (prev === 0) continue;
      out.push((hist[i] - prev) / prev);
    }
    return out;
  }

  /** Pearson correlation coefficient. Both arrays must be the same length. */
  private pearson(a: number[], b: number[]): number {
    const n = a.length;
    if (n === 0) return 0;
    let sumA = 0,
      sumB = 0;
    for (let i = 0; i < n; i++) {
      sumA += a[i];
      sumB += b[i];
    }
    const meanA = sumA / n;
    const meanB = sumB / n;
    let num = 0,
      denA = 0,
      denB = 0;
    for (let i = 0; i < n; i++) {
      const da = a[i] - meanA;
      const db = b[i] - meanB;
      num += da * db;
      denA += da * da;
      denB += db * db;
    }
    const den = Math.sqrt(denA * denB);
    return den === 0 ? 0 : num / den;
  }

  // ── Price action analytics (computed from chart's candle stream) ─────
  /**
   * Mirror of the embedded chart's candle series. Captured via the chart's
   * `candlesChange` output so we can compute RSI / MACD / ATR / pivots
   * without a second round-trip for the same data.
   */
  readonly chartCandles = signal<CandleDto[]>([]);

  /** Exponential moving average for a price series. */
  private ema(values: number[], period: number): number[] {
    if (values.length === 0) return [];
    const k = 2 / (period + 1);
    const out: number[] = [values[0]];
    for (let i = 1; i < values.length; i++) {
      out.push(values[i] * k + out[i - 1] * (1 - k));
    }
    return out;
  }

  /** Wilder-smoothed RSI(period). Returns the latest value, or null if too short. */
  private rsi(values: number[], period = 14): number | null {
    if (values.length <= period) return null;
    let avgGain = 0;
    let avgLoss = 0;
    for (let i = 1; i <= period; i++) {
      const d = values[i] - values[i - 1];
      if (d >= 0) avgGain += d;
      else avgLoss -= d;
    }
    avgGain /= period;
    avgLoss /= period;
    for (let i = period + 1; i < values.length; i++) {
      const d = values[i] - values[i - 1];
      const gain = d > 0 ? d : 0;
      const loss = d < 0 ? -d : 0;
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
    }
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
  }

  /** Wilder ATR(period) over OHLC candles. Returns the latest value. */
  private atr(candles: CandleDto[], period = 14): number | null {
    if (candles.length <= period) return null;
    const trs: number[] = [];
    for (let i = 1; i < candles.length; i++) {
      const c = candles[i];
      const p = candles[i - 1];
      trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
    }
    let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < trs.length; i++) {
      atr = (atr * (period - 1) + trs[i]) / period;
    }
    return atr;
  }

  /** Latest MACD line + signal + histogram. */
  private macd(values: number[]): { line: number; signal: number; hist: number } | null {
    if (values.length < 35) return null;
    const fast = this.ema(values, 12);
    const slow = this.ema(values, 26);
    const macdLine = fast.map((v, i) => v - slow[i]);
    const signal = this.ema(macdLine.slice(25), 9);
    const lastLine = macdLine[macdLine.length - 1];
    const lastSignal = signal[signal.length - 1];
    return { line: lastLine, signal: lastSignal, hist: lastLine - lastSignal };
  }

  /** Pip factor for the focused symbol (JPY pairs = 100, others = 10000). */
  private pipFactor(symbolSlash: string): number {
    return symbolSlash.toUpperCase().includes('JPY') ? 100 : 10000;
  }

  /**
   * Trend stance for the focused symbol — EMA20 vs EMA50, slope, and
   * % distance of the last close from the 20-EMA. Slope is computed on
   * the last 5 EMA20 points, normalized to pips per bar.
   */
  readonly trendStats = computed<{
    ema20: number;
    ema50: number;
    bias: 'bullish' | 'bearish' | 'flat';
    distancePct: number;
    slopePipsPerBar: number;
  } | null>(() => {
    const candles = this.chartCandles();
    if (candles.length < 50) return null;
    const closes = candles.map((c) => c.close);
    const ema20Series = this.ema(closes, 20);
    const ema50Series = this.ema(closes, 50);
    const ema20 = ema20Series[ema20Series.length - 1];
    const ema50 = ema50Series[ema50Series.length - 1];
    const lastClose = closes[closes.length - 1];
    const distancePct = ((lastClose - ema20) / ema20) * 100;
    const tail = ema20Series.slice(-5);
    const slope = tail.length >= 2 ? (tail[tail.length - 1] - tail[0]) / (tail.length - 1) : 0;
    const slopePipsPerBar = slope * this.pipFactor(this.chartSymbol());
    let bias: 'bullish' | 'bearish' | 'flat' = 'flat';
    if (ema20 > ema50 && lastClose > ema20) bias = 'bullish';
    else if (ema20 < ema50 && lastClose < ema20) bias = 'bearish';
    return { ema20, ema50, bias, distancePct, slopePipsPerBar };
  });

  /** Streak of consecutive same-direction closes (positive = bullish). */
  readonly closeStreak = computed<number>(() => {
    const candles = this.chartCandles();
    if (candles.length < 2) return 0;
    let streak = 0;
    const dir = candles[candles.length - 1].close >= candles[candles.length - 2].close ? 1 : -1;
    for (let i = candles.length - 1; i > 0; i--) {
      const c = candles[i];
      const p = candles[i - 1];
      const d = c.close >= p.close ? 1 : -1;
      if (d !== dir) break;
      streak++;
    }
    return streak * dir;
  });

  /** Latest RSI/MACD readings + a coarse momentum verdict. */
  readonly momentumStats = computed<{
    rsi: number;
    rsiZone: 'oversold' | 'neutral' | 'overbought';
    macdLine: number;
    macdSignal: number;
    macdHist: number;
    macdState: 'bullish-cross' | 'bearish-cross' | 'bullish' | 'bearish' | 'flat';
  } | null>(() => {
    const candles = this.chartCandles();
    if (candles.length < 35) return null;
    const closes = candles.map((c) => c.close);
    const rsi = this.rsi(closes, 14);
    const macd = this.macd(closes);
    if (rsi === null || !macd) return null;
    const rsiZone = rsi < 30 ? 'oversold' : rsi > 70 ? 'overbought' : 'neutral';
    let macdState: 'bullish-cross' | 'bearish-cross' | 'bullish' | 'bearish' | 'flat' = 'flat';
    if (Math.abs(macd.hist) < 1e-9) macdState = 'flat';
    else if (
      macd.hist > 0 &&
      macd.line > macd.signal &&
      Math.abs(macd.line - macd.signal) < Math.abs(macd.line) * 0.05
    ) {
      macdState = 'bullish-cross';
    } else if (
      macd.hist < 0 &&
      macd.line < macd.signal &&
      Math.abs(macd.line - macd.signal) < Math.abs(macd.line) * 0.05
    ) {
      macdState = 'bearish-cross';
    } else {
      macdState = macd.hist > 0 ? 'bullish' : 'bearish';
    }
    return {
      rsi,
      rsiZone,
      macdLine: macd.line,
      macdSignal: macd.signal,
      macdHist: macd.hist,
      macdState,
    };
  });

  /** ATR + ATR percentile vs the last 50 bars + realized-range stats. */
  readonly volatilityStats = computed<{
    atrPips: number;
    atrPercentile: number;
    rangePipsLastBar: number;
    rangePipsAvg20: number;
    expansion: 'expanding' | 'contracting' | 'stable';
  } | null>(() => {
    const candles = this.chartCandles();
    if (candles.length < 30) return null;
    const pip = this.pipFactor(this.chartSymbol());
    const atrLatest = this.atr(candles, 14);
    if (atrLatest === null) return null;
    // Rolling ATR series for percentile ranking.
    const atrSeries: number[] = [];
    for (let end = 15; end <= candles.length; end++) {
      const sub = candles.slice(0, end);
      const v = this.atr(sub, 14);
      if (v !== null) atrSeries.push(v);
    }
    const sortedAtr = [...atrSeries].sort((a, b) => a - b);
    const rank = sortedAtr.findIndex((v) => v >= atrLatest);
    const atrPercentile = rank < 0 ? 100 : (rank / Math.max(sortedAtr.length - 1, 1)) * 100;
    const last20 = candles.slice(-20);
    const rangePipsAvg20 =
      (last20.reduce((acc, c) => acc + (c.high - c.low), 0) / last20.length) * pip;
    const lastBar = candles[candles.length - 1];
    const rangePipsLastBar = (lastBar.high - lastBar.low) * pip;
    let expansion: 'expanding' | 'contracting' | 'stable' = 'stable';
    if (rangePipsLastBar > rangePipsAvg20 * 1.3) expansion = 'expanding';
    else if (rangePipsLastBar < rangePipsAvg20 * 0.7) expansion = 'contracting';
    return {
      atrPips: atrLatest * pip,
      atrPercentile,
      rangePipsLastBar,
      rangePipsAvg20,
      expansion,
    };
  });

  /**
   * Classic floor-trader pivot levels from the *previous* completed candle
   * plus the current bar's position within today's range and distances to
   * the rolling 20-bar high / low.
   */
  readonly levelStats = computed<{
    pivot: number;
    r1: number;
    s1: number;
    r2: number;
    s2: number;
    nearestLabel: 'R2' | 'R1' | 'P' | 'S1' | 'S2';
    nearestDistPips: number;
    rangePosPct: number;
    distFromHigh20Pips: number;
    distFromLow20Pips: number;
  } | null>(() => {
    const candles = this.chartCandles();
    if (candles.length < 21) return null;
    const pip = this.pipFactor(this.chartSymbol());
    const prev = candles[candles.length - 2];
    const last = candles[candles.length - 1];
    const pivot = (prev.high + prev.low + prev.close) / 3;
    const r1 = 2 * pivot - prev.low;
    const s1 = 2 * pivot - prev.high;
    const r2 = pivot + (prev.high - prev.low);
    const s2 = pivot - (prev.high - prev.low);
    const distances: { label: 'R2' | 'R1' | 'P' | 'S1' | 'S2'; v: number }[] = [
      { label: 'R2', v: Math.abs(last.close - r2) },
      { label: 'R1', v: Math.abs(last.close - r1) },
      { label: 'P', v: Math.abs(last.close - pivot) },
      { label: 'S1', v: Math.abs(last.close - s1) },
      { label: 'S2', v: Math.abs(last.close - s2) },
    ];
    distances.sort((a, b) => a.v - b.v);
    const nearest = distances[0];
    const todayRange = last.high - last.low;
    const rangePosPct = todayRange === 0 ? 50 : ((last.close - last.low) / todayRange) * 100;
    const last20 = candles.slice(-20);
    const high20 = Math.max(...last20.map((c) => c.high));
    const low20 = Math.min(...last20.map((c) => c.low));
    return {
      pivot,
      r1,
      s1,
      r2,
      s2,
      nearestLabel: nearest.label,
      nearestDistPips: nearest.v * pip,
      rangePosPct,
      distFromHigh20Pips: (high20 - last.close) * pip,
      distFromLow20Pips: (last.close - low20) * pip,
    };
  });

  // ── Advanced market analysis (VWAP / VolProfile / Depth / Footprint / Heatmap) ──

  /**
   * Cumulative session VWAP from the chart's candle stream + 1σ price-distance
   * bands. VWAP = Σ(typical × vol) / Σ(vol) where typical = (H+L+C)/3. The
   * band is one weighted standard deviation of typical price away from VWAP.
   */
  readonly vwapStats = computed<{
    vwap: number;
    upperBand: number;
    lowerBand: number;
    distancePips: number;
    bandwidthPips: number;
    barsIncluded: number;
    position: 'above' | 'below' | 'at';
  } | null>(() => {
    const candles = this.chartCandles();
    if (candles.length < 10) return null;
    const pip = this.pipFactor(this.chartSymbol());
    let cumPV = 0;
    let cumV = 0;
    let cumP2V = 0;
    let bars = 0;
    for (const c of candles) {
      const v = c.volume ?? 0;
      if (v <= 0) continue;
      const tp = (c.high + c.low + c.close) / 3;
      cumPV += tp * v;
      cumV += v;
      cumP2V += tp * tp * v;
      bars++;
    }
    if (cumV === 0 || bars < 5) return null;
    const vwap = cumPV / cumV;
    const variance = Math.max(0, cumP2V / cumV - vwap * vwap);
    const sigma = Math.sqrt(variance);
    const lastClose = candles[candles.length - 1].close;
    const distancePips = (lastClose - vwap) * pip;
    const upperBand = vwap + sigma;
    const lowerBand = vwap - sigma;
    const position: 'above' | 'below' | 'at' =
      Math.abs(distancePips) < 0.2 ? 'at' : distancePips > 0 ? 'above' : 'below';
    return {
      vwap,
      upperBand,
      lowerBand,
      distancePips,
      bandwidthPips: (upperBand - lowerBand) * pip,
      barsIncluded: bars,
      position,
    };
  });

  /**
   * Volume distributed across price bins from the candle stream — each
   * candle's volume is spread uniformly over its OHLC range. The bin with
   * the highest accumulated volume is the Point of Control (POC). Value
   * Area (VA70) is the contiguous bin span around POC that captures 70%
   * of total volume.
   */
  readonly volumeProfile = computed<{
    bins: {
      idx: number;
      priceMid: number;
      volume: number;
      pct: number;
      isPoc: boolean;
      inVa: boolean;
    }[];
    poc: number;
    vaLow: number;
    vaHigh: number;
  } | null>(() => {
    const candles = this.chartCandles();
    if (candles.length < 10) return null;
    const withVol = candles.filter((c) => (c.volume ?? 0) > 0);
    if (withVol.length < 5) return null;
    let lo = Infinity;
    let hi = -Infinity;
    for (const c of withVol) {
      if (c.low < lo) lo = c.low;
      if (c.high > hi) hi = c.high;
    }
    if (!isFinite(lo) || !isFinite(hi) || hi <= lo) return null;
    const BIN_COUNT = 24;
    const step = (hi - lo) / BIN_COUNT;
    const buckets = new Array<number>(BIN_COUNT).fill(0);
    for (const c of withVol) {
      const v = c.volume ?? 0;
      const startBin = Math.max(0, Math.floor((c.low - lo) / step));
      const endBin = Math.min(BIN_COUNT - 1, Math.floor((c.high - lo) / step));
      const span = Math.max(1, endBin - startBin + 1);
      const per = v / span;
      for (let i = startBin; i <= endBin; i++) buckets[i] += per;
    }
    const totalVol = buckets.reduce((a, b) => a + b, 0);
    if (totalVol === 0) return null;
    let pocIdx = 0;
    for (let i = 1; i < BIN_COUNT; i++) if (buckets[i] > buckets[pocIdx]) pocIdx = i;
    // VA70: expand symmetrically from POC, picking whichever neighbour is
    // larger, until cumulative volume crosses 70% of total.
    let vaLowIdx = pocIdx;
    let vaHighIdx = pocIdx;
    let vaVol = buckets[pocIdx];
    const target = totalVol * 0.7;
    while (vaVol < target && (vaLowIdx > 0 || vaHighIdx < BIN_COUNT - 1)) {
      const left = vaLowIdx > 0 ? buckets[vaLowIdx - 1] : -1;
      const right = vaHighIdx < BIN_COUNT - 1 ? buckets[vaHighIdx + 1] : -1;
      if (left >= right) {
        vaLowIdx--;
        vaVol += left;
      } else {
        vaHighIdx++;
        vaVol += right;
      }
    }
    const maxVol = buckets[pocIdx];
    // Render top-down so highest prices sit at top of the histogram.
    const bins = [];
    for (let i = BIN_COUNT - 1; i >= 0; i--) {
      const priceMid = lo + step * (i + 0.5);
      bins.push({
        idx: i,
        priceMid,
        volume: buckets[i],
        pct: maxVol > 0 ? (buckets[i] / maxVol) * 100 : 0,
        isPoc: i === pocIdx,
        inVa: i >= vaLowIdx && i <= vaHighIdx,
      });
    }
    return {
      bins,
      poc: lo + step * (pocIdx + 0.5),
      vaLow: lo + step * vaLowIdx,
      vaHigh: lo + step * (vaHighIdx + 1),
    };
  });

  /**
   * Bid/ask ladder from the latest order book snapshot. Parses the upper-
   * case `{P,V}` levels payload, sorts asks ascending and bids descending
   * around the mid price, and computes a bid-vs-ask volume imbalance.
   */
  readonly depthLadder = computed<{
    bids: { price: number; volume: number; pct: number }[];
    asks: { price: number; volume: number; pct: number }[];
    mid: number;
    spreadPips: number;
    imbalance: number;
  } | null>(() => {
    const ob = this.latestOrderBook();
    if (!ob) return null;
    let parsed: OrderBookLevels | null = null;
    if (ob.levelsJson) {
      try {
        parsed = JSON.parse(ob.levelsJson) as OrderBookLevels;
      } catch {
        parsed = null;
      }
    }
    let bids: { price: number; volume: number }[] = [];
    let asks: { price: number; volume: number }[] = [];
    if (parsed && Array.isArray(parsed.bids) && Array.isArray(parsed.asks)) {
      bids = parsed.bids.map((l) => ({ price: l.P, volume: l.V }));
      asks = parsed.asks.map((l) => ({ price: l.P, volume: l.V }));
    }
    // Always fall back to TOB so the ladder shows at least the spread when
    // the broker doesn't expose deeper levels.
    if (bids.length === 0 && ob.bidPrice > 0) {
      bids = [{ price: ob.bidPrice, volume: ob.bidVolume || 0 }];
    }
    if (asks.length === 0 && ob.askPrice > 0) {
      asks = [{ price: ob.askPrice, volume: ob.askVolume || 0 }];
    }
    if (bids.length === 0 || asks.length === 0) return null;
    bids.sort((a, b) => b.price - a.price);
    asks.sort((a, b) => a.price - b.price);
    const topBids = bids.slice(0, 7);
    const topAsks = asks.slice(0, 7).reverse(); // farthest ask at top, closest just above mid
    const maxVol = Math.max(...topBids.map((b) => b.volume), ...topAsks.map((a) => a.volume), 1);
    const bidsOut = topBids.map((b) => ({
      ...b,
      pct: (b.volume / maxVol) * 100,
    }));
    const asksOut = topAsks.map((a) => ({
      ...a,
      pct: (a.volume / maxVol) * 100,
    }));
    const mid = (topBids[0].price + topAsks[topAsks.length - 1].price) / 2;
    const pip = this.pipFactor(this.chartSymbol());
    const spreadPips = (topAsks[topAsks.length - 1].price - topBids[0].price) * pip;
    const totalBidVol = bids.reduce((acc, b) => acc + b.volume, 0);
    const totalAskVol = asks.reduce((acc, a) => acc + a.volume, 0);
    const denom = totalBidVol + totalAskVol;
    const imbalance = denom > 0 ? (totalBidVol - totalAskVol) / denom : 0;
    return { bids: bidsOut, asks: asksOut, mid, spreadPips, imbalance };
  });

  /**
   * Estimated buy/sell volume per bar from OHLCV (no aggressor-tagged tick
   * stream is captured at this depth, so this is a heuristic — labelled
   * "estimated" in the UI). Buy ≈ (close − low)/(high − low) × volume.
   */
  readonly footprintRows = computed<
    | {
        idx: number;
        label: string;
        buy: number;
        sell: number;
        delta: number;
        cumDelta: number;
      }[]
    | null
  >(() => {
    const candles = this.chartCandles();
    if (candles.length < 5) return null;
    const tail = candles.slice(-12);
    const rows: {
      idx: number;
      label: string;
      buy: number;
      sell: number;
      delta: number;
      cumDelta: number;
    }[] = [];
    let cum = 0;
    tail.forEach((c, i) => {
      const v = c.volume ?? 0;
      const range = c.high - c.low;
      let buyShare = 0.5;
      if (range > 0) buyShare = (c.close - c.low) / range;
      const buy = v * buyShare;
      const sell = v * (1 - buyShare);
      const delta = buy - sell;
      cum += delta;
      const ts = new Date(c.timestamp);
      const label = `${ts.getUTCHours().toString().padStart(2, '0')}:${ts.getUTCMinutes().toString().padStart(2, '0')}`;
      rows.push({ idx: i, label, buy, sell, delta, cumDelta: cum });
    });
    // Newest first.
    return rows.reverse();
  });

  /**
   * 2D liquidity heatmap from the recent order book stream — x = capture
   * time, y = price bin (relative to current mid), z = total volume at
   * that level in that snapshot. Renders nothing if the stream is too
   * short to convey movement.
   */
  readonly liquidityHeatmapOptions = computed<EChartsOption | null>(() => {
    const snaps = this.recentOrderBooks();
    if (snaps.length < 5) return null;
    // Snaps come newest-first; flip so x ascends with time.
    const ordered = [...snaps].reverse();
    const allLevels: { t: number; price: number; vol: number }[] = [];
    let priceLo = Infinity;
    let priceHi = -Infinity;
    ordered.forEach((s, t) => {
      let parsed: OrderBookLevels | null = null;
      if (s.levelsJson) {
        try {
          parsed = JSON.parse(s.levelsJson) as OrderBookLevels;
        } catch {
          parsed = null;
        }
      }
      const levels: { price: number; volume: number }[] = [];
      if (parsed && Array.isArray(parsed.bids) && Array.isArray(parsed.asks)) {
        for (const l of parsed.bids) levels.push({ price: l.P, volume: l.V });
        for (const l of parsed.asks) levels.push({ price: l.P, volume: l.V });
      } else {
        if (s.bidPrice > 0) levels.push({ price: s.bidPrice, volume: s.bidVolume || 0 });
        if (s.askPrice > 0) levels.push({ price: s.askPrice, volume: s.askVolume || 0 });
      }
      for (const lv of levels) {
        if (lv.price < priceLo) priceLo = lv.price;
        if (lv.price > priceHi) priceHi = lv.price;
        allLevels.push({ t, price: lv.price, vol: lv.volume });
      }
    });
    if (!isFinite(priceLo) || !isFinite(priceHi) || priceHi <= priceLo) return null;
    const PRICE_BINS = 18;
    const step = (priceHi - priceLo) / PRICE_BINS;
    const grid: number[][] = [];
    for (const p of allLevels) {
      const yBin = Math.min(PRICE_BINS - 1, Math.max(0, Math.floor((p.price - priceLo) / step)));
      grid.push([p.t, yBin, p.vol]);
    }
    const yLabels: string[] = [];
    const isJpy = this.chartSymbol().toUpperCase().includes('JPY');
    const digits = isJpy ? 3 : 5;
    for (let i = 0; i < PRICE_BINS; i++) {
      yLabels.push((priceLo + step * (i + 0.5)).toFixed(digits));
    }
    const xLabels = ordered.map((s) => {
      const d = new Date(s.capturedAt);
      return `${d.getUTCHours().toString().padStart(2, '0')}:${d.getUTCMinutes().toString().padStart(2, '0')}:${d.getUTCSeconds().toString().padStart(2, '0')}`;
    });
    let maxVol = 0;
    for (const cell of grid) if (cell[2] > maxVol) maxVol = cell[2];
    return {
      tooltip: {
        position: 'top',
        formatter: (p: any) => {
          const x = xLabels[p.value[0]] ?? '';
          const y = yLabels[p.value[1]] ?? '';
          return `${x} · ${y}<br/>vol ${this.formatVolume(p.value[2])}`;
        },
      },
      grid: { top: 6, bottom: 28, left: 60, right: 6 },
      xAxis: {
        type: 'category',
        data: xLabels,
        // Let ECharts thin the HH:mm:ss labels to what fits; a fixed interval
        // computed for six labels overprinted them in a 260px card.
        axisLabel: { fontSize: 9, color: '#888', hideOverlap: true },
        splitArea: { show: false },
      },
      yAxis: {
        type: 'category',
        data: yLabels,
        axisLabel: { fontSize: 9, color: '#888', interval: 2 },
        splitArea: { show: false },
      },
      visualMap: {
        min: 0,
        max: maxVol || 1,
        calculable: false,
        show: false,
        inRange: {
          color: ['#0d1b2a', '#1b4965', '#5fa8d3', '#cae9ff', '#ffd166', '#ef476f'],
        },
      },
      series: [
        {
          type: 'heatmap',
          data: grid,
          progressive: 1000,
          emphasis: { itemStyle: { borderColor: '#fff', borderWidth: 1 } },
        },
      ],
    } as EChartsOption;
  });

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
  // Timeframe the spark buffers were last seeded from. The seed re-runs
  // whenever the chart's selected timeframe changes so the watch-card /
  // matrix sparklines stay aligned with what the operator is looking at
  // on the main chart. Guards against redundant re-seeds for the same TF.
  private lastSeededTf: string | null = null;

  // Spark series, DECOUPLED from priceHistory. priceHistory accumulates a
  // live bid every 3s poll (it feeds correlation / range / volatility
  // analytics that genuinely want tick granularity). Binding the sparkline
  // to that made it churn every 3s — far faster than the selected
  // timeframe. sparkSeries instead holds only timeframe-aligned candle
  // closes: seeded on TF change, and extended by exactly one point each
  // time a candle of the selected timeframe closes. Static between closes.
  private sparkSeries: Record<string, number[]> = {};
  /** Guards against overlapping seed passes once the 3s retry is in play. */
  private sparkSeedInFlight = false;
  // Candle-boundary index (floor(now / tfMs)) at the last close check.
  // Reset to null on TF change so the baseline re-establishes for the new
  // period without a spurious immediate re-seed.
  private lastSparkBoundary: number | null = null;
  // Minutes per timeframe — mirrors the chart's own grid. Used to detect
  // when a candle of the selected timeframe has closed.
  private static readonly TF_MINUTES: Record<string, number> = {
    M1: 1,
    M5: 5,
    M15: 15,
    M30: 30,
    H1: 60,
    H4: 240,
    D1: 1440,
  };

  // Append-only buffer for the Live Prices "Activity feed". Holds the last
  // 200 direction-change events across all symbols. Without this, the feed
  // would flicker empty whenever the latest poll happened to have no
  // movement — every PriceEntry's `direction` resets to 'none' on a poll
  // where the bid didn't change, so a snapshot-based feed shows nothing
  // between ticks. The buffer accumulates events so the panel stays
  // populated through quiet windows.
  private activityBuffer = signal<
    {
      time: Date;
      symbol: string;
      direction: 'up' | 'down';
      price: string;
      delta: number;
    }[]
  >([]);
  // Last spread observed from a real (non-candle) tick per symbol. Used as
  // the fallback for the Avg/Tightest/Widest KPIs and the spread-comparison
  // chart when the live tick feed has gone stale (EA stopped pushing) — gives
  // operators "best-known-truth" instead of a row of `-`.
  private lastLiveSpread: Record<string, number> = {};

  // Per-symbol, per-UTC-hour running mean of the live spread, accumulated
  // from real ticks this session. Replaces the Math.random() "sample data"
  // heatmap that used to sit on the analytics tab as if it were live.
  private hourlySpread: Record<string, { sum: number; count: number }[]> = {};
  private readonly hourlySpreadRev = signal(0);

  // The candle endpoint can return nothing (fresh DB, filter mismatch). A
  // locally generated sample used to fill the table silently — random
  // prices with hour-spaced timestamps presented as market history. It is
  // now opt-in and prominently labelled when shown.
  readonly showSampleCandles = signal(false);
  readonly candleSourceEmpty = signal(false);

  // Watched-pair catalogue is driven by the CurrencyPair API — fetched once
  // at OnInit and used as the source-of-truth for every spread / strength /
  // depth board on the page. A hardcoded majors list (the previous shape)
  // silently dropped any pair registered later (AUDNZD / EURJPY / GBPJPY etc.).
  // Defaults to the historical majors so the page still renders during the
  // initial fetch and survives an API miss.
  watchedSymbols = signal<string[]>([
    'EURUSD',
    'GBPUSD',
    'USDJPY',
    'AUDUSD',
    'EURGBP',
    'USDCHF',
    'NZDUSD',
    'USDCAD',
  ]);
  /** Display variant (slash-formatted) of {@link watchedSymbols}. Same length and order. */
  displaySymbols = computed(() => this.watchedSymbols().map((s) => this.formatPairSymbol(s)));

  /** Insert a slash between the base and quote currencies (`EURUSD` → `EUR/USD`). */
  private formatPairSymbol(symbol: string): string {
    return symbol.length === 6 ? `${symbol.slice(0, 3)}/${symbol.slice(3)}` : symbol;
  }

  /**
   * Pull every active currency pair from the API and replace the watched-pair
   * signal. Page size is generous because the catalogue is bounded (~10-30
   * pairs in practice); failure is non-fatal — the seed defaults stay live
   * and the boards keep working.
   */
  private loadWatchedPairs(): void {
    this.currencyPairsService
      .list({ currentPage: 1, itemCountPerPage: 500 })
      .pipe(
        catchError(() => of(null)),
        takeUntil(this.destroy$),
      )
      .subscribe((res) => {
        if (!res?.status || !res.data?.data) return;
        const symbols = res.data.data
          .filter((p) => p.isActive && !!p.symbol)
          .map((p) => p.symbol!.toUpperCase())
          .sort();
        if (symbols.length === 0) return;
        // Detect new pairs (catalogue grew vs the seeded defaults) so we
        // can backfill their spark histories. Without this, freshly-added
        // pairs would have empty sparklines until tick noise accumulated
        // — see the AUDNZD bug where the watch card stayed flat because
        // the constructor's seed effect fired BEFORE this async fetch
        // landed and so missed every pair beyond the original 8 majors.
        const previous = new Set(this.watchedSymbols());
        this.watchedSymbols.set(symbols);
        const isNew = symbols.some((s) => !previous.has(s));
        const tf = this.chartTimeframe();
        if (isNew && tf) this.seedSparkHistory(tf);
      });
  }

  // Spread-bearing entries only — candle-fallback rows have a synthetic
  // spread of 0 that would distort averages and flatten min/max readings.
  private liveOnly = computed(() => this.livePrices().filter((p) => !p.fromCandle));

  liveCount = computed(() => this.liveOnly().length);
  candleCount = computed(() => this.livePrices().length - this.liveCount());

  // Rolling tick-changes counter — per symbol counts adjacent priceHistory
  // entries that actually differ. Captures real movement (a stuck feed shows
  // 0; an active feed shows hundreds). Bounded by the 100-entry history cap
  // per symbol = ~5 minutes of polling.
  tickActivity = computed(() => {
    // Bind to livePrices so the computed re-runs on every poll.
    this.livePrices();
    let total = 0;
    for (const sym of this.watchedSymbols()) {
      const hist = this.priceHistory[sym] ?? [];
      for (let i = 1; i < hist.length; i++) {
        if (hist[i] !== hist[i - 1]) total++;
      }
    }
    return total;
  });

  // Spread-board: live entries first (sorted tightest → widest), candle
  // fallback rows pinned to the bottom so a glance lands on real spreads.
  spreadBoard = computed(() =>
    [...this.livePrices()].sort((a, b) => {
      if (a.fromCandle !== b.fromCandle) return a.fromCandle ? 1 : -1;
      return a.spread - b.spread;
    }),
  );

  // Currency-strength index: for each major currency, average the Δ% of all
  // watched pairs that contain it. When the currency is the BASE in a pair
  // (e.g. EUR in EUR/USD) the pair's Δ% contributes positively; when it's
  // the QUOTE (e.g. USD in EUR/USD) the contribution is inverted. Sorted
  // strongest → weakest so an operator can spot which currency is driving
  // the day at a glance.
  currencyStrength = computed(() => {
    const buckets: Record<string, { sum: number; count: number }> = {
      USD: { sum: 0, count: 0 },
      EUR: { sum: 0, count: 0 },
      GBP: { sum: 0, count: 0 },
      JPY: { sum: 0, count: 0 },
      AUD: { sum: 0, count: 0 },
      CHF: { sum: 0, count: 0 },
      NZD: { sum: 0, count: 0 },
      CAD: { sum: 0, count: 0 },
    };
    for (const p of this.livePrices()) {
      const sym = p.symbol ?? '';
      const parts = sym.split('/');
      if (parts.length !== 2) continue;
      const [base, quote] = parts;
      if (buckets[base]) {
        buckets[base].sum += p.changePct;
        buckets[base].count++;
      }
      if (buckets[quote]) {
        buckets[quote].sum -= p.changePct;
        buckets[quote].count++;
      }
    }
    return Object.entries(buckets)
      .map(([currency, b]) => ({
        currency,
        strength: b.count > 0 ? b.sum / b.count : 0,
      }))
      .sort((a, b) => b.strength - a.strength);
  });

  currencyStrengthOptions = computed<EChartsOption>(() => {
    const data = this.currencyStrength();
    // Render flat-grey bars even when every strength is 0 (quiet market) so
    // the panel stays visible. Returning {} here used to make the whole
    // card disappear intermittently whenever changePct hit 0 across the
    // board — operators read that as "panel broken", not "no movement".
    return {
      grid: { top: 10, right: 50, bottom: 30, left: 50 },
      xAxis: {
        type: 'value',
        axisLabel: {
          fontSize: 10,
          color: '#6E6E73',
          formatter: (v: number) => v.toFixed(2) + '%',
        },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      yAxis: {
        type: 'category',
        data: data.map((d) => d.currency),
        axisLabel: { fontSize: 11, color: '#6E6E73', fontWeight: 600 },
      },
      series: [
        {
          type: 'bar',
          data: data.map((d) => ({
            value: +d.strength.toFixed(3),
            itemStyle: {
              color: d.strength > 0 ? '#34C759' : d.strength < 0 ? '#FF3B30' : '#8E8E93',
              borderRadius: d.strength >= 0 ? [0, 4, 4, 0] : [4, 0, 0, 4],
            },
          })),
          barWidth: 16,
          label: {
            show: true,
            position: 'right',
            fontSize: 10,
            color: '#6E6E73',
            formatter: (p: any) => (p.value > 0 ? '+' : '') + Number(p.value).toFixed(2) + '%',
          },
        },
      ],
    };
  });

  // Activity feed: latest 12 direction-change events from the rolling
  // activityBuffer. Reading from the buffer (rather than the current
  // livePrices snapshot) keeps the panel populated through polls where no
  // symbol moved — `direction` is only set on the single poll where a bid
  // actually changed, so a snapshot-based feed flickered empty in quiet
  // windows.
  activityFeed = computed(() => this.activityBuffer().slice(0, 12));

  rangeInPips(p: PriceEntry): number {
    return (p.high24h - p.low24h) * this.pipFactorFor(p.symbol);
  }

  /** Every currency bucket at exactly zero — the chart would be eight grey stubs. */
  currencyStrengthAllFlat = computed(() => this.currencyStrength().every((d) => d.strength === 0));

  // ── Candle History tab — analytics over a 200-candle sample ────────
  // Lazy-loaded the first time the user opens this tab (or when invalidated
  // by `loadCandleAnalytics()`). Keeping it separate from the paged data
  // table means we get stable cross-page aggregations even when the user
  // browses to page 5 of the table.
  candleAnalyticsSample = signal<CandleDto[]>([]);
  private candleAnalyticsLoaded = false;

  candleAnalytics = computed(() => {
    const candles = this.candleAnalyticsSample();
    if (candles.length === 0) {
      return {
        total: 0,
        symbolCount: 0,
        timeframeCount: 0,
        bullPct: 0,
        bearPct: 0,
        avgRangePips: 0,
        maxRangePips: 0,
        avgVolume: 0,
        totalVolume: 0,
      };
    }
    const symbols = new Set<string>();
    const timeframes = new Set<string>();
    let bullCount = 0;
    let bearCount = 0;
    let totalRangePips = 0;
    let maxRangePips = 0;
    let totalVolume = 0;
    for (const c of candles) {
      if (c.symbol) symbols.add(c.symbol);
      if (c.timeframe) timeframes.add(c.timeframe);
      if (c.close > c.open) bullCount++;
      else if (c.close < c.open) bearCount++;
      const isJPY = (c.symbol ?? '').includes('JPY');
      const pipFactor = isJPY ? 100 : 10000;
      const rangePips = (c.high - c.low) * pipFactor;
      totalRangePips += rangePips;
      if (rangePips > maxRangePips) maxRangePips = rangePips;
      totalVolume += c.volume ?? 0;
    }
    return {
      total: candles.length,
      symbolCount: symbols.size,
      timeframeCount: timeframes.size,
      bullPct: (bullCount / candles.length) * 100,
      bearPct: (bearCount / candles.length) * 100,
      avgRangePips: +(totalRangePips / candles.length).toFixed(1),
      maxRangePips: +maxRangePips.toFixed(1),
      avgVolume: Math.round(totalVolume / candles.length),
      totalVolume,
    };
  });

  bullBearDonutOptions = computed<EChartsOption>(() => {
    const a = this.candleAnalytics();
    if (a.total === 0) return {};
    const dojiPct = Math.max(0, 100 - a.bullPct - a.bearPct);
    return {
      tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
      legend: { bottom: 0, textStyle: { fontSize: 10, color: '#6E6E73' } },
      series: [
        {
          type: 'pie',
          radius: ['45%', '70%'],
          center: ['50%', '45%'],
          avoidLabelOverlap: true,
          label: { show: false },
          data: [
            { value: +a.bullPct.toFixed(1), name: 'Bullish', itemStyle: { color: '#34C759' } },
            { value: +a.bearPct.toFixed(1), name: 'Bearish', itemStyle: { color: '#FF3B30' } },
            { value: +dojiPct.toFixed(1), name: 'Doji', itemStyle: { color: '#8E8E93' } },
          ],
        },
      ],
    };
  });

  rangeHistogramOptions = computed<EChartsOption>(() => {
    const candles = this.candleAnalyticsSample();
    if (candles.length === 0) return {};
    const ranges = candles.map((c) => {
      const isJPY = (c.symbol ?? '').includes('JPY');
      const pipFactor = isJPY ? 100 : 10000;
      return (c.high - c.low) * pipFactor;
    });
    const max = Math.max(...ranges);
    const bins = 16;
    const width = max > 0 ? max / bins : 1;
    const counts = new Array(bins).fill(0);
    ranges.forEach((r) => {
      const idx = Math.min(Math.floor(r / width), bins - 1);
      counts[idx]++;
    });
    return {
      grid: { top: 10, right: 20, bottom: 30, left: 40 },
      tooltip: {
        trigger: 'axis',
        formatter: (p: any) => `${p[0].name} pips<br/>${p[0].value} candles`,
      },
      xAxis: {
        type: 'category',
        // Bin ranges ("0–5"), not "0+" — the rotated "+" glyph read as an
        // asterisk at 9px and the labels overprinted each other.
        data: counts.map((_, i) => `${(i * width).toFixed(0)}–${((i + 1) * width).toFixed(0)}`),
        axisLabel: { fontSize: 9, color: '#6E6E73', hideOverlap: true },
        axisTick: { show: false },
      },
      yAxis: {
        type: 'value',
        axisLabel: { fontSize: 10, color: '#6E6E73' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      series: [
        {
          type: 'bar',
          data: counts.map((c) => ({
            value: c,
            itemStyle: { color: '#FF9500', borderRadius: [4, 4, 0, 0] },
          })),
          barWidth: '80%',
        },
      ],
    };
  });

  volumeBySymbolOptions = computed<EChartsOption>(() => {
    const map: Record<string, number> = {};
    for (const c of this.candleAnalyticsSample()) {
      const key = c.symbol ?? '';
      map[key] = (map[key] ?? 0) + (c.volume ?? 0);
    }
    const entries = Object.entries(map).sort((a, b) => b[1] - a[1]);
    if (entries.length === 0) return {};
    return {
      grid: { top: 10, right: 56, bottom: 30, left: 80 },
      xAxis: {
        type: 'value',
        axisLabel: {
          fontSize: 10,
          color: '#6E6E73',
          hideOverlap: true,
          formatter: (v: number) => this.formatVolume(v),
        },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      yAxis: {
        type: 'category',
        data: entries.map(([s]) => s),
        axisLabel: { fontSize: 11, color: '#6E6E73' },
      },
      series: [
        {
          type: 'bar',
          data: entries.map(([, v]) => ({
            value: v,
            itemStyle: { color: '#0071E3', borderRadius: [0, 4, 4, 0] },
          })),
          barWidth: 14,
          label: {
            show: true,
            position: 'right',
            fontSize: 9,
            color: '#6E6E73',
            formatter: (p: any) => this.formatVolume(p.value),
          },
        },
      ],
    };
  });

  perSymbolCandleStats = computed(() => {
    const groups: Record<
      string,
      {
        candles: CandleDto[];
      }
    > = {};
    for (const c of this.candleAnalyticsSample()) {
      const key = c.symbol ?? '';
      if (!groups[key]) groups[key] = { candles: [] };
      groups[key].candles.push(c);
    }
    return Object.entries(groups)
      .map(([symbol, { candles }]) => {
        const isJPY = symbol.includes('JPY');
        const pipFactor = isJPY ? 100 : 10000;
        let bull = 0;
        let totalRange = 0;
        let maxRange = 0;
        let totalVolume = 0;
        for (const c of candles) {
          if (c.close > c.open) bull++;
          const r = (c.high - c.low) * pipFactor;
          totalRange += r;
          if (r > maxRange) maxRange = r;
          totalVolume += c.volume ?? 0;
        }
        const sorted = [...candles].sort(
          (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
        );
        const first = sorted[0];
        const last = sorted[sorted.length - 1];
        const netChangePct = first.open > 0 ? ((last.close - first.open) / first.open) * 100 : 0;
        return {
          symbol,
          candles: candles.length,
          bullPct: (bull / candles.length) * 100,
          avgRangePips: totalRange / candles.length,
          maxRangePips: maxRange,
          totalVolume,
          netChangePct,
        };
      })
      .sort((a, b) => b.candles - a.candles);
  });

  perTimeframeCandleStats = computed(() => {
    const groups: Record<string, CandleDto[]> = {};
    for (const c of this.candleAnalyticsSample()) {
      const key = c.timeframe ?? '';
      if (!groups[key]) groups[key] = [];
      groups[key].push(c);
    }
    // Stable canonical timeframe order.
    const order = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1', 'W1', 'MN'];
    return Object.entries(groups)
      .map(([timeframe, candles]) => {
        let bull = 0;
        let totalRange = 0;
        let totalVolume = 0;
        for (const c of candles) {
          const isJPY = (c.symbol ?? '').includes('JPY');
          const pipFactor = isJPY ? 100 : 10000;
          if (c.close > c.open) bull++;
          totalRange += (c.high - c.low) * pipFactor;
          totalVolume += c.volume ?? 0;
        }
        return {
          timeframe,
          candles: candles.length,
          bullPct: (bull / candles.length) * 100,
          avgRangePips: totalRange / candles.length,
          avgVolume: totalVolume / candles.length,
        };
      })
      .sort((a, b) => order.indexOf(a.timeframe) - order.indexOf(b.timeframe));
  });

  // Top 8 most-significant candles by absolute body %, alternating bull/bear.
  notableCandles = computed(() => {
    return this.candleAnalyticsSample()
      .map((c) => {
        const isJPY = (c.symbol ?? '').includes('JPY');
        const pipFactor = isJPY ? 100 : 10000;
        const deltaPips = (c.close - c.open) * pipFactor;
        const bodyPct = c.open > 0 ? ((c.close - c.open) / c.open) * 100 : 0;
        return { ...c, deltaPips, bodyPct };
      })
      .sort((a, b) => Math.abs(b.bodyPct) - Math.abs(a.bodyPct))
      .slice(0, 8);
  });

  private loadCandleAnalytics() {
    if (this.candleAnalyticsLoaded) return;
    this.candleAnalyticsLoaded = true;
    this.marketDataService
      .listCandles({ currentPage: 1, itemCountPerPage: 200, filter: null })
      .pipe(
        catchError(() => of(null)),
        takeUntil(this.destroy$),
      )
      .subscribe((res: any) => {
        const data: CandleDto[] = res?.data?.data ?? [];
        if (data.length > 0) {
          this.candleSourceEmpty.set(false);
          this.candleAnalyticsSample.set(data);
        } else {
          // Nothing (or 4xx) from /market-data/candle/list. Only the explicit
          // sample toggle substitutes generated bars — and then the tab
          // carries a "sample data" banner so nobody reads them as history.
          this.candleSourceEmpty.set(true);
          this.candleAnalyticsSample.set(
            this.showSampleCandles()
              ? this.generateSampleCandles({ currentPage: 1, itemCountPerPage: 200, filter: null })
                  .data
              : [],
          );
        }
      });
  }

  /// Returns spread values to compute KPIs from. Prefers live ticks; when
  /// the EA tick stream is stale and every current row is a candle-fallback
  /// (synthetic 0 spread), falls back to {@link lastLiveSpread} so operators
  /// see best-known-truth instead of `-` across the row. Bind to livePrices
  /// so the computed re-runs on every poll.
  private spreadsForKpis = computed(() => {
    this.livePrices(); // re-run trigger
    const live = this.liveOnly();
    if (live.length > 0) return live.map((p) => p.spread);
    return Object.values(this.lastLiveSpread);
  });

  // Median, not mean, so a single exotic pair (e.g. USD/NGN at ~22,000 pips)
  // can't drag the headline spread into the thousands. The median tracks the
  // typical major-pair spread (~1 pip) regardless of how wild the outliers
  // are; Tightest/Widest below still surface the true min/max extremes.
  medianSpread = computed(() => {
    const spreads = this.spreadsForKpis();
    if (spreads.length === 0) return null;
    const sorted = [...spreads].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
    return +median.toFixed(1);
  });

  // ── Trading-chart tab — surrounding context computeds ────────────
  tightestSpread = computed(() => {
    const spreads = this.spreadsForKpis();
    if (spreads.length === 0) return null;
    return +Math.min(...spreads).toFixed(1);
  });
  widestSpread = computed(() => {
    const spreads = this.spreadsForKpis();
    if (spreads.length === 0) return null;
    return +Math.max(...spreads).toFixed(1);
  });
  upPairsCount = computed(() => this.livePrices().filter((p) => p.changePct > 0).length);
  downPairsCount = computed(() => this.livePrices().filter((p) => p.changePct < 0).length);

  // Stale-feed indicator. Compares the freshest LivePriceDto.timestamp against
  // wall-clock now. > 60s usually means the EA stopped pushing ticks.
  feedAgeSec = computed(() => {
    const prices = this.livePrices();
    if (prices.length === 0) return null;
    const newest = Math.max(...prices.map((p) => new Date(p.timestamp).getTime()));
    return Math.max(0, Math.floor((Date.now() - newest) / 1000));
  });

  /// True when feedAge > 60s OR every current row is a candle-fallback.
  /// Drives the banner above the KPIs that explains why spread metrics are
  /// showing last-known instead of live values.
  isStaleFeed = computed(() => {
    const age = this.feedAgeSec();
    if (age !== null && age > 60) return true;
    // Also stale when there are price rows but none of them are live ticks.
    const all = this.livePrices();
    return all.length > 0 && this.liveOnly().length === 0;
  });

  // Top 6 absolute movers (gainers + losers mixed) for the table below the
  // ribbon — operators want to spot symbols breaking out without scanning
  // every card.
  topMovers = computed(() => {
    // Only pairs that have moved: six rows of "+0.00%" is not a movers table.
    return this.livePrices()
      .filter((p) => p.changePct !== 0)
      .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct))
      .slice(0, 6);
  });

  // Most-recently-ticked symbols (latest LivePriceDto.timestamp first), so the
  // operator can see which feed is most active right now.
  recentTicks = computed(() => {
    return [...this.livePrices()]
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, 8);
  });

  // Watch ribbon: keep all watched symbols, ordered alphabetically for stable
  // visual scanning rather than reordering on every tick.
  watchRibbonPrices = computed(() =>
    [...this.livePrices()].sort((a, b) => (a.symbol ?? '').localeCompare(b.symbol ?? '')),
  );

  // Always-on ribbon: emits 8 cards (one per displaySymbol) regardless of
  // feed state. The optional `live` field is null when no LivePriceDto has
  // arrived, so the template can degrade to placeholders without collapsing
  // the layout.
  ribbonCards = computed<{ symbol: string; live: PriceEntry | null }[]>(() => {
    const live = this.livePrices();
    return this.displaySymbols().map((sym) => ({
      symbol: sym,
      live: live.find((p) => p.symbol === sym) ?? null,
    }));
  });

  // Per-symbol matrix row. `rangePips` is derived from priceHistory so we
  // get richer info even when a single tick has been received (the live DTO's
  // own high/low collapses to one point on first arrival).
  symbolMatrix = computed<
    { symbol: string; live: PriceEntry | null; spark: number[]; rangePips: number | null }[]
  >(() => {
    const live = this.livePrices();
    return this.displaySymbols().map((sym, i) => {
      const apiSym = this.watchedSymbols()[i];
      // rangePips stays on the live-tick buffer (it's a live range read);
      // the spark uses the timeframe-aligned series so it doesn't churn.
      const hist = this.priceHistory[apiSym] ?? [];
      // Candle closes only — no tick-buffer fallback, for the same reason as the
      // watch ribbon: a quiet pair's tick slice draws a flat line that reads as
      // real, unmoving history. rangePips below still uses `hist`; that one IS a
      // live-tick read and is labelled as such.
      const sparkHist = this.sparkSeries[apiSym] ?? [];
      const liveEntry = live.find((p) => p.symbol === sym) ?? null;
      const pipFactor = this.pipFactorFor(sym);
      const rangePips =
        hist.length > 1 ? +((Math.max(...hist) - Math.min(...hist)) * pipFactor).toFixed(1) : null;
      return {
        symbol: sym,
        live: liveEntry,
        spark: sparkHist.slice(-30),
        rangePips,
      };
    });
  });

  // Auto-ticking clock signal so the sessions track + UTC label refresh
  // without us threading a new RxJS subscription.
  private readonly nowMs = signal(Date.now());

  utcClockLabel = computed(() => {
    const d = new Date(this.nowMs());
    const h = String(d.getUTCHours()).padStart(2, '0');
    const m = String(d.getUTCMinutes()).padStart(2, '0');
    return `${h}:${m}`;
  });

  nowMarkerPct = computed(() => {
    const d = new Date(this.nowMs());
    const totalMin = d.getUTCHours() * 60 + d.getUTCMinutes();
    return (totalMin / (24 * 60)) * 100;
  });

  // Standard FX session windows in UTC (DST-naive — close enough at a glance):
  //   Sydney 22-07 · Tokyo 00-09 · London 08-17 · New York 13-22.
  private readonly sessionDefs: { label: string; start: number; end: number }[] = [
    { label: 'Sydney', start: 22, end: 7 }, // wraps midnight
    { label: 'Tokyo', start: 0, end: 9 },
    { label: 'London', start: 8, end: 17 },
    { label: 'New York', start: 13, end: 22 },
  ];

  sessionTrack = computed(() => {
    const now = new Date(this.nowMs());
    const utcHourFrac = now.getUTCHours() + now.getUTCMinutes() / 60;
    const segments: {
      label: string;
      startPct: number;
      widthPct: number;
      active: boolean;
      range: string;
      showLabel: boolean;
    }[] = [];

    for (const s of this.sessionDefs) {
      const wraps = s.end <= s.start;
      const range = `${String(s.start).padStart(2, '0')}:00–${String(s.end).padStart(2, '0')}:00 UTC`;
      const isActive = wraps
        ? utcHourFrac >= s.start || utcHourFrac < s.end
        : utcHourFrac >= s.start && utcHourFrac < s.end;

      if (!wraps) {
        const widthPct = ((s.end - s.start) / 24) * 100;
        segments.push({
          label: s.label,
          startPct: (s.start / 24) * 100,
          widthPct,
          active: isActive,
          range,
          showLabel: widthPct > 9, // hide label when bar is too narrow to fit it
        });
      } else {
        // Two visual segments: tail of the previous day (start → 24h) and
        // head of the new day (0 → end). Label goes on the wider segment so
        // we don't render the same word twice in the bar.
        const tailWidth = ((24 - s.start) / 24) * 100;
        const headWidth = (s.end / 24) * 100;
        const labelOnTail = tailWidth >= headWidth;
        segments.push({
          label: s.label,
          startPct: (s.start / 24) * 100,
          widthPct: tailWidth,
          active: isActive,
          range,
          showLabel: labelOnTail && tailWidth > 9,
        });
        segments.push({
          label: s.label,
          startPct: 0,
          widthPct: headWidth,
          active: isActive,
          range,
          showLabel: !labelOnTail && headWidth > 9,
        });
      }
    }
    return segments;
  });

  /** Session segments grouped per session, one lane each (see the template note). */
  sessionLanes = computed(() => {
    const lanes = new Map<
      string,
      {
        label: string;
        active: boolean;
        range: string;
        segments: { startPct: number; widthPct: number }[];
      }
    >();
    for (const s of this.sessionTrack()) {
      const lane = lanes.get(s.label) ?? {
        label: s.label,
        active: s.active,
        range: s.range,
        segments: [],
      };
      lane.segments.push({ startPct: s.startPct, widthPct: s.widthPct });
      lanes.set(s.label, lane);
    }
    return [...lanes.values()];
  });

  activeSessions = computed(() => {
    // De-duplicate so a wrapping session that surfaced as two segments only
    // shows up once in the active-pill row.
    const seen = new Set<string>();
    const out: string[] = [];
    for (const s of this.sessionTrack()) {
      if (s.active && !seen.has(s.label)) {
        seen.add(s.label);
        out.push(s.label);
      }
    }
    return out;
  });

  // Prices take the row's own symbol precision (JPY 3dp, majors 5dp) and the
  // timestamp uses the same yyyy-MM-dd HH:mm formatter as the rest of the
  // tab — the previous toLocaleString() printed "9/4/2026, 10:49:13 PM" next
  // to a "02/09 21:49" table above it.
  candleColumns: ColDef[] = [
    { field: 'symbol', headerName: 'Symbol', width: 110 },
    { field: 'timeframe', headerName: 'TF', width: 80 },
    {
      field: 'open',
      headerName: 'Open',
      width: 120,
      cellClass: 'ag-right-aligned-cell',
      valueFormatter: (p: any) =>
        p.value == null ? '—' : this.formatPrice(p.value, p.data?.symbol ?? null),
    },
    {
      field: 'high',
      headerName: 'High',
      width: 120,
      cellClass: 'ag-right-aligned-cell',
      valueFormatter: (p: any) =>
        p.value == null ? '—' : this.formatPrice(p.value, p.data?.symbol ?? null),
    },
    {
      field: 'low',
      headerName: 'Low',
      width: 120,
      cellClass: 'ag-right-aligned-cell',
      valueFormatter: (p: any) =>
        p.value == null ? '—' : this.formatPrice(p.value, p.data?.symbol ?? null),
    },
    {
      field: 'close',
      headerName: 'Close',
      width: 120,
      cellClass: 'ag-right-aligned-cell',
      valueFormatter: (p: any) =>
        p.value == null ? '—' : this.formatPrice(p.value, p.data?.symbol ?? null),
    },
    {
      field: 'volume',
      headerName: 'Volume',
      width: 110,
      cellClass: 'ag-right-aligned-cell',
      valueFormatter: (p: any) => (p.value == null ? '—' : this.formatVolume(p.value)),
    },
    {
      field: 'timestamp',
      headerName: 'Time (UTC)',
      flex: 1,
      valueFormatter: (p: any) => this.formatUtcMinute(p.value),
    },
  ];

  /** yyyy-MM-dd HH:mm in UTC — the one timestamp format on the candle tab. */
  formatUtcMinute(iso: string | null | undefined): string {
    if (!iso) return '—';
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return '—';
    const pad = (n: number) => n.toString().padStart(2, '0');
    return (
      `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
      `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
    );
  }

  /**
   * Minimum shared samples before a correlation / z-score is quoted. With a
   * handful of near-identical polls the Pearson denominator is a rounding
   * residue and every cell reads ±1.00 — the matrix of "perfect" correlations
   * the analytics tab used to show above a table of 0.000000 std-devs.
   */
  private static readonly MIN_STAT_POINTS = 10;

  /** Series whose std-dev is under a tenth of a pip has not moved; treat as flat. */
  private hasMovement(hist: number[], symbol: string | null): boolean {
    if (hist.length < MarketDataPageComponent.MIN_STAT_POINTS) return false;
    const mean = hist.reduce((a, b) => a + b, 0) / hist.length;
    const variance = hist.reduce((a, b) => a + (b - mean) ** 2, 0) / hist.length;
    return Math.sqrt(variance) * this.pipFactorFor(symbol) >= 0.1;
  }

  // Pearson correlation across the rolling priceHistory windows for every
  // pair of watched symbols. Cells without enough data or without movement
  // are null (rendered blank) rather than 0 or a spurious ±1. The matrix is
  // consumed by the chart and the KPI strip.
  private corrMatrix = computed<(number | null)[][]>(() => {
    this.livePrices(); // re-run on each poll
    const apiSyms = this.watchedSymbols();
    const n = apiSyms.length;
    const matrix: (number | null)[][] = [];
    for (let i = 0; i < n; i++) {
      matrix[i] = [];
      for (let j = 0; j < n; j++) {
        if (i === j) {
          matrix[i][j] = 1;
          continue;
        }
        const a = this.priceHistory[apiSyms[i]] ?? [];
        const b = this.priceHistory[apiSyms[j]] ?? [];
        const len = Math.min(a.length, b.length);
        if (len < MarketDataPageComponent.MIN_STAT_POINTS) {
          matrix[i][j] = null;
          continue;
        }
        const aSlice = a.slice(-len);
        const bSlice = b.slice(-len);
        if (!this.hasMovement(aSlice, apiSyms[i]) || !this.hasMovement(bSlice, apiSyms[j])) {
          matrix[i][j] = null;
          continue;
        }
        const meanA = aSlice.reduce((x, y) => x + y, 0) / len;
        const meanB = bSlice.reduce((x, y) => x + y, 0) / len;
        let num = 0;
        let denA = 0;
        let denB = 0;
        for (let k = 0; k < len; k++) {
          const da = aSlice[k] - meanA;
          const db = bSlice[k] - meanB;
          num += da * db;
          denA += da * da;
          denB += db * db;
        }
        const den = Math.sqrt(denA * denB);
        matrix[i][j] = den === 0 ? null : +(num / den).toFixed(3);
      }
    }
    return matrix;
  });

  /** True once at least one off-diagonal correlation is defined. */
  hasCorrelationData = computed(() =>
    this.corrMatrix().some((row, i) => row.some((v, j) => i !== j && v !== null)),
  );

  correlationOptions = computed<EChartsOption>(() => {
    const matrix = this.corrMatrix();
    const symbols = this.displaySymbols();
    const data: [number, number, number][] = [];
    for (let i = 0; i < symbols.length; i++) {
      for (let j = 0; j < symbols.length; j++) {
        const v = matrix[i]?.[j];
        if (v !== null && v !== undefined) data.push([j, i, v]);
      }
    }
    // Cell labels only fit up to ~8×8; beyond that they overprint each other
    // and the colour plus tooltip carry the value.
    const dense = symbols.length > 8;
    return {
      tooltip: {
        formatter: (p: any) =>
          `${symbols[p.value[1]]} ↔ ${symbols[p.value[0]]}<br/>r = ${p.value[2].toFixed(2)}`,
      },
      grid: { top: 10, right: 20, bottom: 70, left: 80 },
      xAxis: {
        type: 'category',
        data: symbols,
        axisLabel: { fontSize: 9.5, color: '#6E6E73', rotate: 40, hideOverlap: true },
      },
      yAxis: {
        type: 'category',
        data: symbols,
        axisLabel: { fontSize: 9.5, color: '#6E6E73' },
      },
      visualMap: {
        min: -1,
        max: 1,
        show: true,
        orient: 'horizontal',
        bottom: 0,
        left: 'center',
        itemWidth: 10,
        itemHeight: 80,
        text: ['+1', '-1'],
        textStyle: { fontSize: 10, color: '#6E6E73' },
        inRange: { color: ['#FF3B30', '#F5F5F7', '#0071E3'] },
      },
      series: [
        {
          type: 'heatmap',
          data,
          label: {
            show: !dense,
            fontSize: 9,
            formatter: (p: any) => p.value[2].toFixed(2),
          },
          itemStyle: { borderWidth: dense ? 1 : 2, borderRadius: dense ? 1 : 3 },
        },
      ],
    };
  });

  // Per-symbol price-history statistics: mean, std-dev, range in pips,
  // tick-to-tick volatility, current Z-score. Drives the analytics-tab
  // stats table and a few of the KPI tiles.
  /**
   * Per-symbol rolling statistics. Every derived figure is null until the
   * series has enough points AND real movement — a two-point history with a
   * 1e-7 std-dev used to print "0.000000" beside a z-score of ±1.00, which is
   * arithmetic, not information. The table renders null as "—" and the KPI
   * tiles skip it, so the two agree.
   */
  perSymbolStats = computed(() => {
    this.livePrices(); // re-run on each poll
    return this.displaySymbols().map((sym, i) => {
      const apiSym = this.watchedSymbols()[i];
      const hist = this.priceHistory[apiSym] ?? [];
      const live = this.livePrices().find((p) => p.symbol === sym);
      const pipFactor = this.pipFactorFor(sym);
      const current = live?.bid ?? (hist.length > 0 ? hist[hist.length - 1] : null);
      const base = {
        symbol: sym,
        points: hist.length,
        current,
        changePct: live?.changePct ?? 0,
        direction: live?.direction ?? 'none',
        fromCandle: live?.fromCandle ?? false,
      };

      if (!this.hasMovement(hist, sym)) {
        return {
          ...base,
          mean: null as number | null,
          stdDev: null as number | null,
          min: null as number | null,
          max: null as number | null,
          rangePips: null as number | null,
          volatility: null as number | null,
          zScore: null as number | null,
        };
      }

      const mean = hist.reduce((a, b) => a + b, 0) / hist.length;
      const variance = hist.reduce((a, b) => a + (b - mean) ** 2, 0) / hist.length;
      const stdDev = Math.sqrt(variance);
      const min = Math.min(...hist);
      const max = Math.max(...hist);
      const rangePips = (max - min) * pipFactor;

      const returns = hist.slice(1).map((v, j) => Math.abs((v - hist[j]) / hist[j]) * 10000);
      const volatility = returns.reduce((a, b) => a + b, 0) / returns.length;
      const zScore = current !== null && stdDev > 0 ? (current - mean) / stdDev : null;

      return { ...base, mean, stdDev, min, max, rangePips, volatility, zScore };
    });
  });

  // Analytics-tab KPI roll-ups derived from perSymbolStats + corrMatrix.
  analyticsKpis = computed(() => {
    const stats = this.perSymbolStats();
    const matrix = this.corrMatrix();
    const dataPoints = stats.reduce((sum, s) => sum + s.points, 0);
    const vols = stats.map((s) => s.volatility).filter((v): v is number => v !== null && v > 0);
    const ranges = stats.map((s) => s.rangePips).filter((r): r is number => r !== null && r > 0);
    const avgVolatility = vols.length > 0 ? vols.reduce((a, b) => a + b, 0) / vols.length : null;
    const maxVolatility = vols.length > 0 ? Math.max(...vols) : null;
    const avgRange = ranges.length > 0 ? ranges.reduce((a, b) => a + b, 0) / ranges.length : null;
    const maxRange = ranges.length > 0 ? Math.max(...ranges) : null;

    let strongPos = 0;
    let strongNeg = 0;
    for (let i = 0; i < matrix.length; i++) {
      for (let j = i + 1; j < matrix.length; j++) {
        const r = matrix[i]?.[j];
        if (r === null || r === undefined) continue;
        if (r >= 0.7) strongPos++;
        if (r <= -0.7) strongNeg++;
      }
    }
    return {
      dataPoints,
      avgVolatility,
      maxVolatility,
      avgRange,
      maxRange,
      strongPos,
      strongNeg,
    };
  });

  // Scatter: range (pips) vs tick volatility (bps). One point per symbol.
  // Lets an operator spot out-of-shape pairs at a glance — e.g. a quiet pair
  // suddenly producing wide range or a normally choppy pair that's locked up.
  rangeVsVolatilityOptions = computed<EChartsOption>(() => {
    // Only symbols with a defined range AND volatility — a dot at the origin
    // for every flat series is a label pile-up over the 0 tick, not a chart.
    const stats = this.perSymbolStats().filter(
      (s): s is typeof s & { rangePips: number; volatility: number } =>
        s.rangePips !== null && s.volatility !== null && s.rangePips > 0,
    );
    if (stats.length === 0) return {};
    return {
      grid: { top: 30, right: 30, bottom: 40, left: 60 },
      xAxis: {
        type: 'value',
        name: 'Range (pips)',
        nameLocation: 'center',
        nameGap: 25,
        nameTextStyle: { fontSize: 11, color: '#6E6E73' },
        axisLabel: { fontSize: 10, color: '#6E6E73' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      yAxis: {
        type: 'value',
        name: 'Volatility (bps)',
        nameLocation: 'center',
        nameGap: 40,
        nameTextStyle: { fontSize: 11, color: '#6E6E73' },
        axisLabel: { fontSize: 10, color: '#6E6E73' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      tooltip: {
        formatter: (p: any) =>
          `${p.value[2]}<br/>Range: ${p.value[0].toFixed(1)} pips<br/>Vol: ${p.value[1].toFixed(2)} bps`,
      },
      series: [
        {
          type: 'scatter',
          symbolSize: 18,
          data: stats.map((s) => ({
            value: [+s.rangePips.toFixed(1), +s.volatility.toFixed(2), s.symbol],
            itemStyle: {
              color:
                s.changePct > 0
                  ? 'rgba(52,199,89,0.85)'
                  : s.changePct < 0
                    ? 'rgba(255,59,48,0.85)'
                    : 'rgba(142,142,147,0.7)',
              borderColor: '#fff',
              borderWidth: 1.5,
            },
          })),
          label: {
            show: true,
            position: 'top',
            fontSize: 9,
            color: '#6E6E73',
            formatter: (p: any) => p.value[2],
          },
        },
      ],
    };
  });

  /**
   * Average live spread per UTC hour, per major pair, from ticks seen this
   * session. Cells with no observation are left blank rather than invented.
   * Null when nothing has been observed yet so the card shows an empty state.
   */
  spreadHeatmapOptions = computed<EChartsOption | null>(() => {
    this.hourlySpreadRev();
    const rows: { symbol: string; cells: (number | null)[] }[] = [];
    let maxSpread = 0;
    let minSpread = Infinity;
    let observed = 0;
    for (const apiSym of this.watchedSymbols()) {
      const agg = this.hourlySpread[apiSym];
      if (!agg) continue;
      const display = this.formatPairSymbol(apiSym);
      if (this.isExoticPair(display)) continue; // 20,000-pip exotics flatten the scale
      const cells = agg.map((h) => {
        if (h.count === 0) return null;
        const v = +(h.sum / h.count).toFixed(2);
        observed++;
        if (v > maxSpread) maxSpread = v;
        if (v < minSpread) minSpread = v;
        return v;
      });
      rows.push({ symbol: display, cells });
    }
    if (observed === 0) return null;
    const data: [number, number, number][] = [];
    rows.forEach((r, y) =>
      r.cells.forEach((v, x) => {
        if (v !== null) data.push([x, y, v]);
      }),
    );
    return {
      tooltip: {
        formatter: (p: any) =>
          `${rows[p.value[1]].symbol} · ${String(p.value[0]).padStart(2, '0')}:00 UTC<br/>avg spread ${p.value[2].toFixed(2)} pips`,
      },
      grid: { top: 10, right: 20, bottom: 44, left: 80 },
      xAxis: {
        type: 'category',
        data: Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, '0')}h`),
        axisLabel: { fontSize: 9, color: '#6E6E73', hideOverlap: true },
      },
      yAxis: {
        type: 'category',
        data: rows.map((r) => r.symbol),
        axisLabel: { fontSize: 11, color: '#6E6E73' },
      },
      visualMap: {
        min: Math.max(0, minSpread),
        max: Math.max(maxSpread, minSpread + 0.1),
        show: true,
        orient: 'horizontal',
        bottom: 0,
        left: 'center',
        itemWidth: 10,
        itemHeight: 80,
        text: ['Wide', 'Tight'],
        textStyle: { fontSize: 10, color: '#6E6E73' },
        inRange: { color: ['#34C759', '#FF9500', '#FF3B30'] },
      },
      series: [
        {
          type: 'heatmap',
          data,
          label: { show: false },
          itemStyle: { borderWidth: 1, borderRadius: 2 },
        },
      ],
    };
  });

  /** Hours observed so far for the spread heatmap caption. */
  spreadHeatmapCaption = computed(() => {
    this.hourlySpreadRev();
    const hours = new Set<number>();
    for (const agg of Object.values(this.hourlySpread)) {
      agg.forEach((h, i) => {
        if (h.count > 0) hours.add(i);
      });
    }
    return `Average live spread by UTC hour · ${hours.size} of 24 hours observed this session`;
  });

  // The eight FX majors. A pair with a leg outside this set is "exotic"
  // (USD/NGN, USD/CNH) — those carry huge spreads and flat/dead price history,
  // so they distort the spread chart's linear scale and add noise (r ≈ 0) to
  // the correlation panel. Excluded from both. See {@link isExoticPair}.
  private static readonly MAJOR_CURRENCIES = new Set([
    'USD',
    'EUR',
    'GBP',
    'JPY',
    'AUD',
    'CHF',
    'NZD',
    'CAD',
  ]);

  /// True when either leg of a pair is a non-major currency. Accepts both the
  /// slashed ("USD/NGN") and joined ("USDNGN") symbol forms.
  private isExoticPair(symbol: string): boolean {
    const cleaned = (symbol ?? '').replace('/', '');
    if (cleaned.length !== 6) return false; // unknown format — don't exclude
    const majors = MarketDataPageComponent.MAJOR_CURRENCIES;
    return !majors.has(cleaned.slice(0, 3)) || !majors.has(cleaned.slice(3, 6));
  }

  /// Splits the spread series into chart-able majors and excluded exotics.
  /// Prefers live ticks; when the feed is stale and every current row is a
  /// candle-fallback (synthetic 0 spread), falls back to the per-symbol
  /// last-known live spread so the chart shows operators the best-known
  /// values instead of an empty panel.
  private spreadChartData = computed(() => {
    this.livePrices(); // re-run trigger
    const prices = this.liveOnly();
    let series: { symbol: string; spread: number }[];
    if (prices.length > 0) {
      series = prices.map((p) => ({ symbol: p.symbol ?? '', spread: p.spread }));
    } else if (Object.keys(this.lastLiveSpread).length > 0) {
      series = Object.entries(this.lastLiveSpread).map(([apiSym, spread]) => {
        const idx = this.watchedSymbols().indexOf(apiSym);
        return { symbol: idx >= 0 ? this.displaySymbols()[idx] : apiSym, spread };
      });
    } else {
      series = [];
    }
    return {
      included: series.filter((s) => !this.isExoticPair(s.symbol)),
      excluded: series.filter((s) => this.isExoticPair(s.symbol)),
    };
  });

  /// Caption for the Spread comparison card — notes any exotic pairs dropped
  /// from the chart so the exclusion is visible, not silent.
  spreadChartCaption = computed(() => {
    const excluded = this.spreadChartData().excluded;
    const base = 'Live-only spreads across watched pairs';
    if (excluded.length === 0) return base;
    const names = excluded.map((e) => e.symbol).join(', ');
    return `${base} · excludes ${excluded.length} exotic (${names})`;
  });

  // Dynamic computed chart options
  spreadChartOptions = computed<EChartsOption>(() => {
    const series = this.spreadChartData().included;
    if (series.length === 0) return {};
    const sorted = [...series].sort((a, b) => b.spread - a.spread);
    return {
      grid: { top: 10, right: 40, bottom: 30, left: 80 },
      xAxis: {
        type: 'value',
        axisLabel: { fontSize: 11, color: '#6E6E73' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
        name: 'Spread (pips)',
        nameLocation: 'center',
        nameGap: 25,
        nameTextStyle: { fontSize: 11, color: '#6E6E73' },
      },
      yAxis: {
        type: 'category',
        data: sorted.map((p) => p.symbol ?? ''),
        axisLabel: { fontSize: 11, color: '#6E6E73' },
      },
      series: [
        {
          type: 'bar',
          data: sorted.map((p) => ({
            value: +p.spread.toFixed(1),
            itemStyle: {
              color: p.spread > 3 ? '#FF3B30' : p.spread > 2 ? '#FF9500' : '#0071E3',
              borderRadius: [0, 4, 4, 0],
            },
          })),
          // Bars auto-size to fit the chart's vertical space (no fixed pixel
          // width — that made the bars touch and the labels overlap as soon
          // as the watched-pair count grew past 8). The category gap reserves
          // 50% of each slot as whitespace so bars stay visually distinct
          // regardless of pair count, and barMaxWidth caps the per-bar
          // thickness so a 3-pair filter doesn't render comically wide.
          barCategoryGap: '50%',
          barMaxWidth: 20,
          label: {
            show: true,
            position: 'right',
            fontSize: 11,
            color: '#6E6E73',
            formatter: '{c}',
          },
        },
      ],
    };
  });

  /**
   * Price movement, rebased to % change from each series' first point. Raw
   * bids share one axis only within a currency family: with XAU/USD at 4,434
   * and USD/NGN at 1,320 on the same scale, twenty-one FX lines were a flat
   * stripe at zero. Symbols that have not moved are dropped from the plot.
   */
  priceHistoryOptions = computed<EChartsOption>(() => {
    this.livePrices();
    const history = this.priceHistory;
    const symbols = Object.keys(history).filter((s) => this.hasMovement(history[s], s));
    if (symbols.length === 0) return {};
    const colors = [
      '#0071E3',
      '#34C759',
      '#FF9500',
      '#AF52DE',
      '#5AC8FA',
      '#FF2D55',
      '#64D2FF',
      '#FF3B30',
    ];
    const maxLen = Math.max(...symbols.map((s) => history[s].length));
    return {
      // Scrollable legend pinned above the plot, with grid.top reserved for
      // it, so four rows of series names no longer draw over the lines.
      grid: { top: 44, right: 20, bottom: 30, left: 56 },
      legend: {
        type: 'scroll',
        top: 0,
        textStyle: { fontSize: 10, color: '#6E6E73' },
      },
      xAxis: {
        type: 'category',
        data: Array.from({ length: maxLen }, (_, i) => `${i}`),
        axisLabel: { show: false },
        axisTick: { show: false },
        axisLine: { lineStyle: { color: 'rgba(0,0,0,0.06)' } },
      },
      yAxis: {
        type: 'value',
        scale: true,
        axisLabel: {
          fontSize: 10,
          color: '#6E6E73',
          formatter: (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`,
        },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      tooltip: {
        trigger: 'axis',
        valueFormatter: (v: unknown) =>
          typeof v === 'number' ? `${v >= 0 ? '+' : ''}${v.toFixed(3)}%` : '—',
      },
      series: symbols.map((sym, i) => {
        const base = history[sym][0];
        return {
          name: this.formatPairSymbol(sym),
          type: 'line',
          data: history[sym].map((v) => +(((v - base) / base) * 100).toFixed(4)),
          smooth: true,
          symbol: 'none',
          lineStyle: { color: colors[i % colors.length], width: 1.5 },
        };
      }),
    };
  });

  spreadHistoryOptions = computed<EChartsOption>(() => {
    const history = this.spreadHistory;
    const symbols = Object.keys(history).filter((s) => history[s].length > 1);
    if (symbols.length === 0) return {};
    const colors = ['#0071E3', '#34C759', '#FF9500', '#AF52DE'];
    const maxLen = Math.max(...symbols.map((s) => history[s].length));
    return {
      grid: { top: 30, right: 20, bottom: 30, left: 50 },
      legend: { top: 0, textStyle: { fontSize: 10, color: '#6E6E73' } },
      xAxis: {
        type: 'category',
        data: Array.from({ length: maxLen }, (_, i) => `${i}`),
        axisLabel: { show: false },
        axisTick: { show: false },
        axisLine: { lineStyle: { color: 'rgba(0,0,0,0.06)' } },
      },
      yAxis: {
        type: 'value',
        axisLabel: { fontSize: 10, color: '#6E6E73' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
        name: 'Spread',
        nameTextStyle: { fontSize: 10, color: '#6E6E73' },
      },
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
    // Only symbols with a measured volatility. Zero-height bars each carried
    // a "0" value label at the same x, which stacked into the garbled glyph
    // cluster above the axis title.
    const volData = this.perSymbolStats()
      .filter((s): s is typeof s & { volatility: number } => s.volatility !== null)
      .map((s) => ({ name: s.symbol, vol: +s.volatility.toFixed(2) }))
      .filter((d) => d.vol > 0)
      .sort((a, b) => b.vol - a.vol)
      .slice(0, 12);
    if (volData.length === 0) return {};

    return {
      grid: { top: 10, right: 40, bottom: 30, left: 80 },
      xAxis: {
        type: 'value',
        name: 'Volatility (bps)',
        nameLocation: 'center',
        nameGap: 25,
        nameTextStyle: { fontSize: 11, color: '#6E6E73' },
        axisLabel: { fontSize: 11, color: '#6E6E73' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      yAxis: {
        type: 'category',
        data: volData.map((d) => d.name),
        axisLabel: { fontSize: 11, color: '#6E6E73' },
      },
      series: [
        {
          type: 'bar',
          data: volData.map((d) => ({
            value: d.vol,
            itemStyle: { color: '#AF52DE', borderRadius: [0, 4, 4, 0] },
          })),
          // Same auto-size + 50% gap shape as the spread chart for visual
          // consistency and to survive the same pair-count growth case.
          barCategoryGap: '50%',
          barMaxWidth: 20,
          label: { show: true, position: 'right', fontSize: 10, color: '#6E6E73' },
        },
      ],
    };
  });

  /** Which symbol the price-distribution histogram describes (for its caption). */
  priceDistSymbol = computed(() => {
    this.livePrices();
    const sym = this.watchedSymbols().find((s) => this.hasMovement(this.priceHistory[s] ?? [], s));
    return sym ? this.formatPairSymbol(sym) : null;
  });

  priceDistOptions = computed<EChartsOption>(() => {
    this.livePrices();
    // First symbol that has actually moved: a flat series is one bar with
    // twenty identical rotated labels, which is what the tab used to show.
    const sym = this.watchedSymbols().find((s) => this.hasMovement(this.priceHistory[s] ?? [], s));
    if (!sym) return {};
    const hist = this.priceHistory[sym];

    const min = Math.min(...hist);
    const max = Math.max(...hist);
    const range = max - min;
    const bins = Math.min(12, Math.max(4, Math.floor(hist.length / 5)));
    const binWidth = range / bins;
    const counts = new Array(bins).fill(0);
    hist.forEach((v) => {
      const idx = Math.min(Math.floor((v - min) / binWidth), bins - 1);
      counts[idx]++;
    });
    const labels = counts.map((_, i) => this.formatPrice(min + i * binWidth + binWidth / 2, sym));

    return {
      grid: { top: 10, right: 20, bottom: 30, left: 50 },
      tooltip: { trigger: 'axis', formatter: (p: any) => `${p[0].name}<br/>${p[0].value} ticks` },
      xAxis: {
        type: 'category',
        data: labels,
        axisLabel: { fontSize: 9, color: '#6E6E73', hideOverlap: true },
        axisTick: { show: false },
      },
      yAxis: {
        type: 'value',
        axisLabel: { fontSize: 10, color: '#6E6E73' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      series: [
        {
          type: 'bar',
          data: counts.map((c) => ({
            value: c,
            itemStyle: { color: '#0071E3', borderRadius: [4, 4, 0, 0] },
          })),
          barWidth: '80%',
        },
      ],
    };
  });

  constructor() {
    // Lazy-load the candle analytics sample the first time the user lands on
    // the Candle History tab. Loading on every page mount would cost a 200-
    // candle round-trip even for users who never open this tab.
    effect(() => {
      if (this.activeTab() === 'candles') this.loadCandleAnalytics();
    });

    // Refresh Market Insights immediately when the operator switches
    // symbol/timeframe on the chart — don't make them wait up to 5s for
    // the timer-based poller to catch up.
    effect(() => {
      this.chartSymbol();
      this.chartTimeframe();
      // Switching account must move the position overlay at once, not on the next 5s
      // poll. Read the KEY, never accountIds() — that array's identity is rebuilt by the
      // scope service's 30s account refresh, which would re-trigger this effect forever.
      this.accountScope.accountIdsKey();
      this.loadInsights();
    });

    // Re-seed the spark buffers whenever the chart's selected timeframe
    // changes so the watch-card / matrix sparklines always depict the same
    // timeframe the operator is looking at on the main chart. This effect
    // also fires on initial settle (chart emits its persisted/default TF),
    // which is what performs the first seed — so ngOnInit no longer needs
    // an explicit call. The lastSeededTf guard collapses redundant fires.
    effect(() => {
      const tf = this.chartTimeframe();
      if (tf && tf !== this.lastSeededTf) {
        this.lastSeededTf = tf;
        // New period length — re-baseline the close detector so the next
        // poll doesn't immediately re-seed on top of this one.
        this.lastSparkBoundary = null;
        this.seedSparkHistory(tf);
      }
    });
  }

  /**
   * Re-seeds the spark series only when a candle of the currently-selected
   * timeframe has closed since the last check. Called on the existing 3s
   * poll cadence (no extra timer). Between closes the spark is untouched,
   * so it advances at the timeframe's pace rather than every poll — which
   * is what makes it "aligned to the selected timeframe."
   */
  private maybeRefreshSparkOnClose(): void {
    const tf = this.chartTimeframe();
    if (!tf) return;
    const tfMin = MarketDataPageComponent.TF_MINUTES[tf] ?? 60;
    const tfMs = tfMin * 60_000;
    const boundary = Math.floor(Date.now() / tfMs);
    if (this.lastSparkBoundary === null) {
      // First observation (or just after a TF switch) — set the baseline
      // and wait for the NEXT close before refreshing.
      this.lastSparkBoundary = boundary;
      return;
    }
    if (boundary > this.lastSparkBoundary) {
      this.lastSparkBoundary = boundary;
      this.seedSparkHistory(tf);
      return;
    }

    // Retry only the symbols that still have no candle history. Without this a
    // symbol whose seed request missed — the catalogue grew mid-flight, the
    // engine was briefly slow, that pair's candles had not been ingested yet —
    // stayed on the tick fallback until the NEXT candle close, a full hour on
    // H1. That is what a permanently flat watch-card sparkline looks like.
    const missing = this.watchedSymbols().filter((sym) => !this.sparkSeries[sym]);
    if (missing.length > 0) this.seedSparkHistory(tf, missing);
  }

  ngOnInit() {
    // Load the active currency-pair catalogue from the API and update the
    // watched-pair signal so every dependent computed (spreads / strength /
    // depth / symbol matrix) reshapes around the live registered set. Falls
    // back to the seed defaults if the API misses — the page still works,
    // just on the majors-only subset.
    this.loadWatchedPairs();

    // Spark seeding is driven by the chartTimeframe effect in the
    // constructor (it fires on initial settle and on every TF change), so
    // there's no explicit seed call here — that would double-seed and
    // could race the effect on the initial timeframe.
    this.loadPrices();
    timer(3000, 3000)
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => {
        this.loadPrices();
        // Cheap local check on the same cadence — re-seeds the spark series
        // only when a candle of the selected timeframe has actually closed,
        // so the sparkline advances at the timeframe's pace, not per poll.
        this.maybeRefreshSparkOnClose();
      });

    // Wall-clock signal for the sessions track + feed-age. 30s cadence is
    // enough — the now-marker on the sessions bar moves at 1px every ~10
    // minutes at typical card widths, finer ticks are pure overhead.
    timer(0, 30_000)
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => this.nowMs.set(Date.now()));

    // Market Insights cadence: 5s. Pulls the latest regime snapshot and the
    // most recent trade signal (which carries ML scoring fields) for the
    // chart-focused (symbol, timeframe). Slower than tick polling because
    // regime/predictions don't move per-tick; faster than minute-cadence
    // so the panel feels live.
    timer(0, 5000)
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => this.loadInsights());
  }

  ngOnDestroy() {
    this.destroy$.next();
    this.destroy$.complete();
  }

  /**
   * Seed every watched symbol's spark buffer from real recent candle closes
   * at `preferredTf` — the timeframe currently selected on the main chart —
   * so the watch-card / matrix sparklines depict the same timeframe the
   * operator is analysing. Re-run whenever the chart timeframe changes.
   *
   * The chosen TF is tried first per symbol; the remaining timeframes are a
   * defensive fallback in case this engine instance didn't ingest the
   * selected one for some pair. The chain is SEQUENTIAL and stops at the
   * first TF that returns data (`first(...)` unsubscribes upstream), so the
   * common case is exactly one light request per symbol.
   */
  private seedSparkHistory(preferredTf: string, only?: readonly string[]): void {
    const FALLBACK = ['M15', 'H1', 'H4', 'M5', 'D1'];
    const TF_PRIORITY = [preferredTf, ...FALLBACK.filter((t) => t !== preferredTf)];
    const BARS = 60;
    const targets = only ?? this.watchedSymbols();
    if (targets.length === 0) return;
    // One seed pass at a time. The retry below runs on the 3s poll, and without
    // this a slow pass would stack a fresh forkJoin over every symbol each tick.
    if (this.sparkSeedInFlight) return;
    this.sparkSeedInFlight = true;

    const seedOne = (sym: string) =>
      from(TF_PRIORITY).pipe(
        concatMap((tf) =>
          this.marketDataService
            .listCandles({
              currentPage: 1,
              itemCountPerPage: BARS,
              filter: { symbol: sym, timeframe: tf },
            })
            .pipe(
              map((res) => res?.data?.data ?? []),
              catchError(() => of([] as CandleDto[])),
            ),
        ),
        // First TF (in priority order) that came back with usable data;
        // default [] if every TF was empty so the stream still completes.
        first((rows) => rows.length >= 2, [] as CandleDto[]),
        map((candles) => ({ sym, candles })),
      );

    forkJoin(targets.map(seedOne))
      .pipe(
        finalize(() => (this.sparkSeedInFlight = false)),
        takeUntil(this.destroy$),
      )
      .subscribe((results) => {
        let seeded = 0;
        for (const { sym, candles } of results) {
          if (candles.length < 2) continue;
          // listCandles returns DESC (newest first) — reverse to chronological.
          const closes = candles
            .map((c) => c.close)
            .filter((v) => Number.isFinite(v) && v > 0)
            .reverse();
          if (closes.length < 2) continue;
          // Write the dedicated spark series, NOT priceHistory. Replace
          // wholesale: closes from a previous timeframe must not bleed into
          // the new one, and the spark must reflect exactly the selected
          // timeframe's candle closes — nothing tick-grained.
          this.sparkSeries[sym] = closes.slice(-60);
          seeded++;
        }
        if (seeded === 0 && !only) {
          console.warn(
            '[market-data] spark seed got no candles for any watched symbol — ' +
              'watch-card sparklines will stay empty until a later retry lands.',
          );
        }
        // Repaint the cards now that the buffers carry real structure,
        // instead of waiting up to 3s for the next poll tick.
        this.loadPrices();
      });
  }

  loadPrices() {
    // Two-stage fetch: try the live-tick cache first, fall back to the most
    // recent M5 candle when the cache returns nothing for a symbol. The
    // candle-derived entry is flagged so spread KPIs / charts can exclude it
    // (a synthetic spread of 0 would otherwise distort the average).
    // The display symbol is derived from the request's own symbol, never
    // looked up by index inside the async callback. The watched-pair
    // catalogue is replaced when the CurrencyPair fetch lands, so a poll
    // that was in flight across that swap resolved `displaySymbols()[i]`
    // against the NEW list and stamped USD/JPY's 156.2 quote onto the
    // AUD/USD row — which is where the "−1,555,274.9 pip" activity-feed
    // entries came from.
    const requests = this.watchedSymbols().map((symbol) => {
      const displaySymbol = this.formatPairSymbol(symbol);
      return this.marketDataService.getLivePrice(symbol).pipe(
        catchError(() => of(null as any)),
        switchMap((res: any) => {
          const live = res?.data;
          if (live?.bid > 0 && live?.ask > 0) {
            // Normalise to the slashed display format so downstream
            // lookups (watch ribbon / symbol matrix) match displaySymbols.
            // The engine returns the API symbol ("EURUSD") which would
            // otherwise miss the displaySymbols-keyed `find` calls.
            return of({
              symbol,
              displaySymbol,
              data: { ...(live as LivePriceDto), symbol: displaySymbol },
              fromCandle: false,
            });
          }
          return this.marketDataService.getLatestCandle(symbol, 'M5').pipe(
            catchError(() => of(null as any)),
            map((cRes: any) => {
              const candle = cRes?.data;
              if (!candle?.close) return null;
              return {
                symbol,
                displaySymbol,
                data: {
                  symbol: displaySymbol,
                  bid: candle.close,
                  ask: candle.close,
                  spread: 0,
                  timestamp: candle.timestamp,
                } as LivePriceDto,
                fromCandle: true,
              };
            }),
          );
        }),
      );
    });

    forkJoin(requests)
      .pipe(takeUntil(this.destroy$))
      .subscribe((results) => {
        const current = this.livePrices();
        const newPrices: PriceEntry[] = results
          .map((r) => {
            if (!r) return null;
            const { symbol: sym, data, fromCandle } = r;

            const prev = current.find((p) => p.symbol === data.symbol);
            // A source switch (candle-fallback ↔ live tick) is not a price
            // move: compare only like with like, otherwise the M5 close vs
            // the next live bid logs a phantom direction change.
            const comparable = prev && prev.fromCandle === fromCandle;
            const prevBid = comparable ? prev.bid : data.bid;
            const change = data.bid - prevBid;

            // Engine returns spread in raw price units (ask - bid); operators
            // expect FX spread in pips. Convert at the source so every
            // downstream consumer (KPIs / chart / matrix / ribbon badges)
            // gets the pip value without each having to know the pipFactor.
            const pipFactor = this.pipFactorFor(sym);
            const spreadPips = +(data.spread * pipFactor).toFixed(1);

            if (!this.priceHistory[sym]) this.priceHistory[sym] = [];
            this.priceHistory[sym].push(data.bid);
            if (this.priceHistory[sym].length > 100) this.priceHistory[sym].shift();

            // Don't pollute spreadHistory with synthetic 0-spread entries;
            // they'd flatline the spread-history line for any down feed.
            if (!fromCandle) {
              if (!this.spreadHistory[sym]) this.spreadHistory[sym] = [];
              this.spreadHistory[sym].push(spreadPips);
              if (this.spreadHistory[sym].length > 100) this.spreadHistory[sym].shift();
              // Stash so the spread KPIs / comparison chart have a fallback
              // when the EA tick stream goes stale and every row is a candle.
              this.lastLiveSpread[sym] = spreadPips;
              // Accumulate the by-hour average that feeds the spread heatmap.
              // Only real ticks count — a candle-fallback row has no spread.
              const hour = new Date(data.timestamp).getUTCHours();
              if (Number.isFinite(hour)) {
                const row = (this.hourlySpread[sym] ??= Array.from({ length: 24 }, () => ({
                  sum: 0,
                  count: 0,
                })));
                row[hour].sum += spreadPips;
                row[hour].count++;
              }
            }

            // Timeframe-aligned candle closes — NOT the live-tick buffer. Stays put
            // between candle closes so the spark doesn't churn every poll.
            //
            // There is deliberately NO tick-buffer fallback. It used to slice the last
            // 30 live bids in here, which on a quiet pair is thirty near-identical
            // numbers — a flat line that is indistinguishable from real candle history
            // and reads as "this pair has not moved in 60 bars". An empty series draws
            // nothing and the card says so, which is honest; the retry above fills it
            // within a poll or two.
            const sparkData = this.sparkSeries[sym] ?? [];

            return {
              ...data,
              spread: spreadPips,
              change,
              changePct: prevBid > 0 ? (change / prevBid) * 100 : 0,
              high24h: Math.max(...(this.priceHistory[sym] || [data.bid])),
              low24h: Math.min(...(this.priceHistory[sym] || [data.bid])),
              sparkData,
              prevBid,
              direction:
                data.bid > prevBid
                  ? ('up' as const)
                  : data.bid < prevBid
                    ? ('down' as const)
                    : ('none' as const),
              fromCandle,
            };
          })
          .filter(Boolean) as PriceEntry[];

        this.livePrices.set(newPrices);
        this.hourlySpreadRev.update((n) => n + 1);

        // Capture direction-change events into the rolling activity buffer
        // (separate from livePrices so the feed survives quiet polls).
        const newEvents: {
          time: Date;
          symbol: string;
          direction: 'up' | 'down';
          price: string;
          delta: number;
        }[] = [];
        for (const p of newPrices) {
          if (p.direction !== 'up' && p.direction !== 'down') continue;
          const pipFactor = this.pipFactorFor(p.symbol);
          newEvents.push({
            time: new Date(p.timestamp),
            symbol: p.symbol ?? '',
            direction: p.direction,
            price: this.formatPrice(p.bid, p.symbol),
            delta: p.change * pipFactor,
          });
        }
        if (newEvents.length > 0) {
          newEvents.sort((a, b) => b.time.getTime() - a.time.getTime());
          this.activityBuffer.update((buf) => [...newEvents, ...buf].slice(0, 200));
        }
      });
  }

  /**
   * Pull the latest regime snapshot + most-recent trade signal for the
   * chart-focused (symbol, timeframe). Called on a 5s timer and immediately
   * when the operator switches symbols/timeframes on the chart.
   *
   * Engine notes:
   *  - Regime: `GET /market-regime/latest?symbol=&timeframe=` returns a
   *    `MarketRegimeSnapshotDto` (regime label + ADX/ATR/BBW + confidence).
   *  - Predictions: there's no `/ml-prediction-log/latest` yet, so we
   *    paginate trade signals filtered by Search=symbol and read the most
   *    recent row's ML scoring fields. Signals are persisted in
   *    `GeneratedAt DESC` order, so page 1 row 0 is the most recent.
   */
  loadInsights(): void {
    const symSlash = this.chartSymbol();
    if (!symSlash) return;
    const symJoined = symSlash.replace(/\//g, '');
    const tf = this.chartTimeframe();

    this.regimeLoading.set(true);
    this.regimeService
      .getLatest(symJoined, tf)
      .pipe(
        catchError(() => of(null)),
        takeUntil(this.destroy$),
      )
      .subscribe((res) => {
        this.regimeLoading.set(false);
        this.regimeSnapshot.set(res?.data ?? null);
      });

    this.predictionLoading.set(true);
    this.tradeSignalsService
      .list({
        currentPage: 1,
        itemCountPerPage: 1,
        filter: { search: symJoined },
      })
      .pipe(
        catchError(() => of(null)),
        takeUntil(this.destroy$),
      )
      .subscribe((res) => {
        this.predictionLoading.set(false);
        const rows = res?.data?.data ?? [];
        this.latestPredictionSignal.set(rows.length > 0 ? rows[0] : null);
      });

    // Open positions for the chart overlay. Filter server-side by
    // (symbol, Status=Open). Page size 50 is well above any realistic
    // concurrent-position count for one pair — the engine's GetPaged
    // handler maxes out at one open position per (StrategyId, Symbol)
    // for risk-checked flows, so 50 is a generous upper bound.
    // Scoped to the account picker in the header. The overlay draws an entry, an SL and a
    // TP line per position, and the chart's P&L badge sums them — unscoped, an operator
    // looking at one account saw the whole fleet's lines on their chart and a P&L total
    // that could not be reconciled against any account they had selected.
    //
    // An empty scope means "no live accounts", NOT "every account" (see
    // AccountScopeService.accountIds) — so clear the overlay rather than falling back to
    // fleet-wide, which is the failure mode being fixed here.
    const scopedIds = this.accountScope.accountIds();
    if (scopedIds.length === 0) {
      this.positionsLoading.set(false);
      this.chartOpenPositions.set([]);
    } else {
      this.positionsLoading.set(true);
      this.positionsService
        .list({
          currentPage: 1,
          itemCountPerPage: 50,
          filter: {
            symbol: symJoined,
            status: 'Open',
            tradingAccountIds: Array.from(scopedIds),
          },
        })
        .pipe(
          catchError(() => of(null)),
          takeUntil(this.destroy$),
        )
        .subscribe((res) => {
          this.positionsLoading.set(false);
          const rows = res?.data?.data ?? [];
          this.chartOpenPositions.set(rows);
        });
    }

    // Depth-of-book + recent snapshots for the advanced analysis cards.
    // -14 means the EA hasn't streamed a MarketBook frame for this pair
    // yet (or the broker doesn't expose one); we just keep the existing
    // value so the card stays empty rather than flickering.
    this.marketDataService
      .getLatestOrderBook(symJoined)
      .pipe(
        catchError(() => of(null)),
        takeUntil(this.destroy$),
      )
      .subscribe((res) => {
        this.latestOrderBook.set(res?.data ?? null);
      });

    this.marketDataService
      .getRecentOrderBooks(symJoined, 120)
      .pipe(
        catchError(() => of(null)),
        takeUntil(this.destroy$),
      )
      .subscribe((res) => {
        this.recentOrderBooks.set(res?.data ?? []);
      });
  }

  /**
   * Quote-precision by instrument. Five decimals is the FX-major convention;
   * JPY crosses quote to three; metals and large-figure exotics (XAU/USD at
   * 4,434, USD/NGN at 1,320) quote to two — printing those to five decimals
   * produced "4434.12000", which overflowed every price cell it sat in.
   */
  formatPrice(price: number, symbol: string | null): string {
    return price.toFixed(this.decimalsFor(symbol, price));
  }

  /**
   * Per-symbol statistics are `null` for a pair whose history has not moved
   * (a dead feed, or a session that has only just started). Those cells
   * render "—" rather than a fabricated 0.000000.
   */
  formatPriceOrDash(price: number | null, symbol: string | null): string {
    return price === null ? '—' : this.formatPrice(price, symbol);
  }

  fixedOrDash(value: number | null, digits: number): string {
    return value === null ? '—' : value.toFixed(digits);
  }

  private decimalsFor(symbol: string | null, price?: number): number {
    const s = (symbol ?? '').toUpperCase();
    if (s.includes('XAU')) return 2;
    if (s.includes('XAG')) return 3;
    if (s.includes('JPY')) return 3;
    if (price !== undefined && Math.abs(price) >= 1000) return 2;
    return 5;
  }

  /**
   * Price units per pip. One definition for the whole page — the same
   * `isJPY ? 100 : 10000` guess was repeated in a dozen places and was wrong
   * for metals, where a pip is 0.1 (XAU) / 0.01 (XAG).
   */
  private pipFactorFor(symbol: string | null): number {
    const s = (symbol ?? '').toUpperCase();
    if (s.includes('XAU')) return 10;
    if (s.includes('XAG')) return 100;
    if (s.includes('JPY')) return 100;
    return 10000;
  }

  /** "93,551 s" is unreadable; render feed / snapshot ages as 1d 2h, 5m 12s, 40s. */
  formatAge(totalSec: number | null): string {
    if (totalSec === null || !Number.isFinite(totalSec)) return '—';
    const s = Math.max(0, Math.floor(totalSec));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ${m % 60}m`;
    const d = Math.floor(h / 24);
    return `${d}d ${h % 24}h`;
  }

  /** Seconds since an ISO timestamp, against the 30 s wall-clock signal. */
  ageSecOf(iso: string | null | undefined): number | null {
    if (!iso) return null;
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return null;
    return Math.max(0, Math.floor((this.nowMs() - t) / 1000));
  }

  /** "HH:mm:ss" UTC of the freshest live tick — the stale banner and feed-age tile cite it. */
  lastLiveTickLabel = computed(() => {
    const prices = this.livePrices();
    if (prices.length === 0) return null;
    const newest = Math.max(...prices.map((p) => new Date(p.timestamp).getTime()));
    if (!Number.isFinite(newest)) return null;
    const d = new Date(newest);
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  });

  /**
   * Whether a chart option object carries anything to draw. The computeds on
   * this page return `{}` for "nothing yet"; the template swaps in a titled
   * empty state instead of handing ECharts an empty canvas.
   */
  hasSeries(opts: EChartsOption): boolean {
    const s = (opts as { series?: unknown }).series;
    return Array.isArray(s) ? s.length > 0 : s != null;
  }

  /** A sparkline of identical values is a flat line that says "moving" — draw only real movement. */
  sparkHasMovement(data: number[]): boolean {
    return data.length > 1 && Math.max(...data) > Math.min(...data);
  }

  /** Colour only for a sign; zero is neutral, never green. */
  sparkColor(change: number): string {
    return change > 0 ? '#34C759' : change < 0 ? '#FF3B30' : '#8E8E93';
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
    if (this.showSampleCandles()) return of(this.generateSampleCandles(params));
    const empty: PagedData<CandleDto> = {
      pager: {
        totalItemCount: 0,
        currentPage: params.currentPage ?? 1,
        itemCountPerPage: params.itemCountPerPage ?? 25,
        pageNo: 0,
        pageSize: params.itemCountPerPage ?? 25,
        filter: null,
      },
      data: [],
    };
    return this.marketDataService.listCandles(params).pipe(
      map((res: ResponseData<PagedData<CandleDto>>) => {
        const rows = res.data?.data ?? [];
        this.candleSourceEmpty.set(rows.length === 0);
        return rows.length > 0 ? res.data! : empty;
      }),
      catchError(() => {
        this.candleSourceEmpty.set(true);
        return of(empty);
      }),
    );
  };

  /** Flip the sample-data toggle and rebuild both the analytics sample and the table. */
  toggleSampleCandles(): void {
    this.showSampleCandles.update((v) => !v);
    this.candleAnalyticsLoaded = false;
    this.candleAnalyticsSample.set([]);
    this.loadCandleAnalytics();
    // The data table re-fetches when its fetchData input identity changes.
    this.fetchCandles = this.fetchCandles.bind(this);
  }

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
      const o = price,
        c = o + (Math.random() - 0.48) * vol;
      const h = Math.max(o, c) + Math.random() * vol * 0.4;
      const l = Math.min(o, c) - Math.random() * vol * 0.4;
      const time = new Date(now.getTime() - (pageSize - i) * 3600000);
      candles.push({
        id: i + 1,
        symbol: sym,
        timeframe: timeframes[i % timeframes.length],
        open: +o.toFixed(isJPY ? 3 : 5),
        high: +h.toFixed(isJPY ? 3 : 5),
        low: +l.toFixed(isJPY ? 3 : 5),
        close: +c.toFixed(isJPY ? 3 : 5),
        volume: Math.floor(200 + Math.random() * 3000),
        timestamp: time.toISOString(),
        isClosed: true,
      });
    }
    return {
      pager: {
        totalItemCount: 200,
        currentPage: params.currentPage ?? 1,
        itemCountPerPage: pageSize,
        // Page count must follow the page size the table asked for — a fixed
        // 8 with a 25-row page printed "1–25 of 200" over a three-page pager.
        pageNo: Math.ceil(200 / pageSize),
        pageSize,
        filter: null,
      },
      data: candles,
    };
  }
}
