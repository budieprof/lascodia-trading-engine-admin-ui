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
  timer,
  takeUntil,
  catchError,
  of,
  Observable,
  map,
  switchMap,
} from 'rxjs';
import { DatePipe } from '@angular/common';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { TabsComponent } from '@shared/components/ui/tabs/tabs.component';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { DataTableComponent } from '@shared/components/data-table/data-table.component';
import { SparklineComponent } from '@shared/components/sparkline/sparkline.component';
import { TradingChartComponent } from '@shared/components/trading-chart/trading-chart.component';
import { MarketDataService } from '@core/services/market-data.service';
import {
  LivePriceDto,
  PagerRequest,
  PagedData,
  CandleDto,
  ResponseData,
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
        <!-- Market overview strip: sessions + global market KPIs -->
        <div class="market-overview">
          <div class="sessions-card">
            <div class="sessions-head">
              <span class="muted">Trading sessions</span>
              <span class="session-time mono">{{ utcClockLabel() }} UTC</span>
            </div>
            <div class="sessions-track">
              @for (s of sessionTrack(); track $index) {
                <div
                  class="session-bar"
                  [class.active]="s.active"
                  [style.left.%]="s.startPct"
                  [style.width.%]="s.widthPct"
                  [attr.data-session]="s.label"
                  [title]="s.label + ' · ' + s.range"
                >
                  @if (s.showLabel) {
                    <span>{{ s.label }}</span>
                  }
                </div>
              }
              <div class="now-marker" [style.left.%]="nowMarkerPct()"></div>
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

          @if (isStaleFeed()) {
            <div class="stale-feed-banner" role="status" aria-live="polite">
              <span class="stale-feed-icon" aria-hidden="true">⚠</span>
              <span>
                Feed stale — last live tick {{ feedAgeSec() }}s ago. Showing candle-fallback prices;
                spread KPIs reflect last-known live values.
              </span>
            </div>
          }
          <div class="overview-kpis">
            <app-metric-card
              label="Watched pairs"
              [value]="livePrices().length"
              format="number"
              dotColor="#0071E3"
            />
            <app-metric-card
              label="Avg spread"
              [value]="avgSpread()"
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
            <app-metric-card
              label="Feed age (s)"
              [value]="feedAgeSec()"
              format="number"
              [dotColor]="feedAgeSec() !== null && feedAgeSec()! > 60 ? '#FF3B30' : '#34C759'"
            />
          </div>
        </div>

        <app-trading-chart />

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
                    [class.up]="card.live.change >= 0"
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
                  @if (card.live && card.live.sparkData.length > 1) {
                    <app-sparkline
                      [data]="card.live.sparkData"
                      [color]="card.live.change >= 0 ? '#34C759' : '#FF3B30'"
                      width="100%"
                      height="22px"
                    />
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
                        {{ formatPrice(p.low24h, p.symbol) }}–{{ formatPrice(p.high24h, p.symbol) }}
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
                <span class="muted">Waiting for live price feed…</span>
                <span class="empty-hint">Movers populate once the EA pushes a tick.</span>
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
                  <td class="num mono">
                    @if (row.live) {
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
                    @if (row.live) {
                      {{ formatPrice(row.live.high24h, row.symbol) }}
                    } @else {
                      <span class="muted">—</span>
                    }
                  </td>
                  <td class="num mono">
                    @if (row.live) {
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
                    @if (row.spark.length > 1) {
                      <app-sparkline
                        [data]="row.spark"
                        [color]="row.live && row.live.changePct >= 0 ? '#34C759' : '#FF3B30'"
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
        </section>

        <!-- Always-on analytics row: spread comparison + volatility radar.
             Both reuse computeds defined for the analytics tab — when there's
             no data they short-circuit to {} which renders an empty card. -->
        <div class="chart-row">
          <app-chart-card
            title="Spread comparison"
            subtitle="Live spreads across watched pairs"
            [options]="spreadChartOptions()"
            height="240px"
          />
          <app-chart-card
            title="Volatility (last 100 ticks)"
            subtitle="Average tick-to-tick move in basis points"
            [options]="volatilityOptions()"
            height="240px"
          />
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
            label="Avg spread"
            [value]="avgSpread()"
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
                    [class.up]="price.change >= 0"
                    [class.down]="price.change < 0"
                  >
                    {{ price.change >= 0 ? '+' : '' }}{{ price.changePct.toFixed(2) }}%
                  </span>
                </div>
                @if (!price.fromCandle) {
                  <span class="spread-badge" [class.wide]="price.spread > 3">
                    {{ price.spread.toFixed(1) }} sp
                  </span>
                } @else {
                  <span class="spread-badge candle">candle</span>
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
                @if (price.sparkData.length > 1) {
                  <app-sparkline
                    [data]="price.sparkData"
                    [color]="price.change >= 0 ? '#34C759' : '#FF3B30'"
                    width="100%"
                    height="36px"
                  />
                } @else {
                  <div class="sparkline-empty">collecting ticks…</div>
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

        <!-- Currency strength + Spread board (compact table) -->
        <div class="strength-row">
          <app-chart-card
            title="Currency strength"
            subtitle="Aggregate Δ% across each currency's pairs (positive = base appreciating)"
            [options]="currencyStrengthOptions()"
            height="280px"
          />

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

        <!-- Spread comparison chart + Activity feed (live tick log). -->
        <div class="charts-row two-col">
          <app-chart-card
            title="Spread comparison"
            subtitle="Live-only spreads (excludes candle-fallback rows)"
            [options]="spreadChartOptions()"
            height="280px"
          />

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

        <div class="charts-grid">
          <app-chart-card
            title="Price Movement"
            subtitle="Bid prices over time (last 100 ticks)"
            [options]="priceHistoryOptions()"
            height="320px"
          />
          <app-chart-card
            title="Spread History"
            subtitle="Spread over time per pair (live-only)"
            [options]="spreadHistoryOptions()"
            height="320px"
          />
        </div>
        <div class="charts-grid">
          <app-chart-card
            title="Volatility Gauge"
            subtitle="Tick-to-tick volatility (basis points)"
            [options]="volatilityOptions()"
            height="280px"
          />
          <app-chart-card
            title="Correlation Matrix"
            subtitle="Pearson r across rolling priceHistory windows · live data"
            [options]="correlationOptions()"
            height="280px"
          />
        </div>
        <div class="charts-grid">
          <app-chart-card
            title="Bid-Ask Spread Heatmap"
            subtitle="Average spread by hour of day · sample data"
            [options]="spreadHeatmapOptions"
            height="280px"
          />
          <app-chart-card
            title="Price Distribution"
            subtitle="Bid price distribution (last 100 ticks)"
            [options]="priceDistOptions()"
            height="280px"
          />
        </div>

        <!-- Range vs Volatility scatter — out-of-shape pair detector. -->
        <div class="charts-grid">
          <app-chart-card
            title="Range vs Volatility"
            subtitle="One dot per symbol · color = today's direction"
            [options]="rangeVsVolatilityOptions()"
            height="320px"
          />
          <app-chart-card
            title="Currency Strength"
            subtitle="Aggregate Δ% across each currency's pairs"
            [options]="currencyStrengthOptions()"
            height="320px"
          />
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
                  <td class="num mono">{{ formatPrice(s.current, s.symbol) }}</td>
                  <td class="num mono">{{ formatPrice(s.mean, s.symbol) }}</td>
                  <td class="num mono">{{ s.stdDev.toFixed(6) }}</td>
                  <td class="num mono">{{ formatPrice(s.min, s.symbol) }}</td>
                  <td class="num mono">{{ formatPrice(s.max, s.symbol) }}</td>
                  <td class="num mono">{{ s.rangePips.toFixed(1) }}</td>
                  <td class="num mono">{{ s.volatility.toFixed(2) }}</td>
                  <td class="num mono" [class.profit]="s.zScore > 1" [class.loss]="s.zScore < -1">
                    {{ s.zScore.toFixed(2) }}
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
                    <td class="num mono">
                      {{ c.open.toFixed((c.symbol ?? '').includes('JPY') ? 3 : 5) }}
                    </td>
                    <td class="num mono">
                      {{ c.close.toFixed((c.symbol ?? '').includes('JPY') ? 3 : 5) }}
                    </td>
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
                    <td class="mono">{{ c.timestamp | date: 'dd/MM HH:mm' }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </section>
        </div>

        <!-- Existing paged candle data-table — full historical browser. -->
        <section class="data-table-card">
          <header class="board-head">
            <h3>All candles</h3>
            <span class="muted">Browse the complete OHLCV history</span>
          </header>
          <app-data-table [columnDefs]="candleColumns" [fetchData]="fetchCandles" />
        </section>
      }
    </div>
  `,
  styles: [
    `
      .page {
        padding: var(--space-2) 0;
      }

      .metrics-row {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: var(--space-4);
        margin-bottom: var(--space-6);
      }

      .kpi-strip {
        display: grid;
        grid-template-columns: repeat(8, 1fr);
        gap: var(--space-2);
        margin-bottom: var(--space-4);
      }
      @media (max-width: 1400px) {
        .kpi-strip {
          grid-template-columns: repeat(4, 1fr);
        }
      }
      @media (max-width: 720px) {
        .kpi-strip {
          grid-template-columns: repeat(2, 1fr);
        }
      }

      .price-mid {
        display: flex;
        flex-direction: column;
        align-items: center;
        padding: 0 var(--space-2);
        border-left: 1px solid var(--border);
        border-right: 1px solid var(--border);
      }
      .mid-label {
        font-size: 9px;
        font-weight: var(--font-bold);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.08em;
        margin-bottom: 2px;
      }
      .mid-value {
        font-size: 13px;
        font-weight: var(--font-semibold);
        color: var(--text-secondary);
        font-variant-numeric: tabular-nums;
      }
      .price-col.right {
        align-items: flex-end;
      }
      .spread-badge.candle {
        background: rgba(255, 149, 0, 0.12);
        color: #c93400;
      }
      .sparkline-empty {
        height: 36px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 10px;
        color: var(--text-tertiary);
        background: var(--bg-tertiary);
        border-radius: 3px;
      }
      .price-foot {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-2);
        margin-top: var(--space-2);
        padding-top: var(--space-2);
        border-top: 1px solid var(--border);
        font-size: 10px;
        color: var(--text-tertiary);
        font-variant-numeric: tabular-nums;
      }
      .foot-pill {
        padding: 1px 6px;
        border-radius: 3px;
        font-size: 9px;
        font-weight: var(--font-bold);
        letter-spacing: 0.06em;
        background: rgba(52, 199, 89, 0.12);
        color: #248a3d;
      }
      .foot-pill.candle {
        background: rgba(255, 149, 0, 0.14);
        color: #c93400;
      }
      .foot-stat {
        flex: 1;
        text-align: center;
        font-weight: var(--font-medium);
      }
      .foot-time {
        font-family: 'SF Mono', 'Fira Code', monospace;
      }

      /* Strength row: currency strength chart + spread board side-by-side */
      .strength-row {
        display: grid;
        grid-template-columns: 1fr 1.4fr;
        gap: var(--space-3);
        margin-bottom: var(--space-4);
      }
      @media (max-width: 1100px) {
        .strength-row {
          grid-template-columns: 1fr;
        }
      }

      .spread-board,
      .activity-feed {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: hidden;
        display: flex;
        flex-direction: column;
      }
      .board-head {
        display: flex;
        align-items: baseline;
        gap: var(--space-3);
        padding: var(--space-3) var(--space-4);
        border-bottom: 1px solid var(--border);
      }
      .board-head h3 {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      .board-head .muted {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
      }
      .board-table {
        width: 100%;
        border-collapse: collapse;
      }
      .board-table th,
      .board-table td {
        padding: 8px var(--space-3);
        text-align: left;
        border-bottom: 1px solid var(--border);
        font-size: var(--text-xs);
      }
      .board-table tbody tr:last-child td {
        border-bottom: none;
      }
      .board-table th {
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        font-size: 10.5px;
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .board-table th.num,
      .board-table td.num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .board-table .loss {
        color: var(--loss);
      }
      .src-pill {
        padding: 2px 6px;
        border-radius: 3px;
        font-size: 9px;
        font-weight: var(--font-bold);
        letter-spacing: 0.06em;
        background: rgba(52, 199, 89, 0.12);
        color: #248a3d;
      }
      .src-pill.candle {
        background: rgba(255, 149, 0, 0.14);
        color: #c93400;
      }

      .stats-table-card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: hidden;
        margin-top: var(--space-3);
      }
      .stats-table-card .board-table .profit {
        color: var(--profit);
      }
      .stats-table-card .board-table .loss {
        color: var(--loss);
      }

      /* Candle History tab — denser layout */
      .charts-grid.three {
        grid-template-columns: repeat(3, 1fr);
        margin-bottom: var(--space-4);
      }
      @media (max-width: 1100px) {
        .charts-grid.three {
          grid-template-columns: 1fr;
        }
      }

      .summary-row,
      .notable-row {
        display: grid;
        grid-template-columns: 1.4fr 1fr;
        gap: var(--space-3);
        margin-bottom: var(--space-4);
      }
      .notable-row {
        grid-template-columns: 1fr;
      }
      @media (max-width: 1100px) {
        .summary-row {
          grid-template-columns: 1fr;
        }
      }

      .summary-card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: hidden;
      }
      .summary-card .board-table .profit {
        color: var(--profit);
      }
      .summary-card .board-table .loss {
        color: var(--loss);
      }

      .data-table-card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: hidden;
      }
      .data-table-card .board-head {
        margin-bottom: 0;
      }

      /* Two-col charts row for spread chart + activity feed */
      .charts-row.two-col {
        display: grid;
        grid-template-columns: 1.1fr 1fr;
        gap: var(--space-3);
      }
      @media (max-width: 1100px) {
        .charts-row.two-col {
          grid-template-columns: 1fr;
        }
      }

      /* Activity feed list */
      .feed-list {
        list-style: none;
        margin: 0;
        padding: 0;
        max-height: 280px;
        overflow-y: auto;
      }
      .feed-item {
        display: grid;
        grid-template-columns: 70px 70px 14px 1fr 60px;
        align-items: center;
        gap: var(--space-2);
        padding: 6px var(--space-4);
        border-bottom: 1px solid var(--border);
        font-size: var(--text-xs);
      }
      .feed-item:last-child {
        border-bottom: none;
      }
      .feed-time {
        color: var(--text-tertiary);
      }
      .feed-symbol {
        font-weight: var(--font-semibold);
      }
      .feed-arrow {
        text-align: center;
        font-size: 10px;
        color: var(--text-tertiary);
      }
      .feed-item.up .feed-arrow,
      .feed-item.up .feed-delta {
        color: var(--profit);
      }
      .feed-item.down .feed-arrow,
      .feed-item.down .feed-delta {
        color: var(--loss);
      }
      .feed-price {
        text-align: right;
      }
      .feed-delta {
        text-align: right;
        font-weight: var(--font-semibold);
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
      .price-card.flash-up {
        border-color: rgba(52, 199, 89, 0.3);
      }
      .price-card.flash-down {
        border-color: rgba(255, 59, 48, 0.3);
      }

      .price-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        margin-bottom: var(--space-3);
      }

      .symbol-info {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

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
      .symbol-change.up {
        color: var(--profit);
      }
      .symbol-change.down {
        color: var(--loss);
      }

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
        color: #c93400;
      }

      .price-main {
        margin-bottom: var(--space-3);
      }

      .bid-ask {
        display: flex;
        align-items: center;
        gap: var(--space-3);
      }

      .price-col {
        display: flex;
        flex-direction: column;
        flex: 1;
      }

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
      .price-number.bid {
        color: var(--text-primary);
      }
      .price-number.ask {
        color: var(--text-secondary);
        font-size: 15px;
        font-weight: var(--font-semibold);
      }
      .price-number.tick-up {
        color: var(--profit);
      }
      .price-number.tick-down {
        color: var(--loss);
      }

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

      .price-sparkline {
        margin-top: var(--space-1);
      }

      .charts-grid {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: var(--space-4);
        margin-bottom: var(--space-4);
      }

      .charts-row {
        margin-bottom: var(--space-4);
      }

      /* Trading-chart tab market overview */
      .market-overview {
        display: grid;
        grid-template-columns: 1fr 1.5fr;
        gap: var(--space-3);
        margin-bottom: var(--space-3);
      }
      @media (max-width: 1200px) {
        .market-overview {
          grid-template-columns: 1fr;
        }
      }
      .sessions-card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-3) var(--space-4);
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
      }
      .sessions-head {
        display: flex;
        justify-content: space-between;
        font-size: var(--text-xs);
      }
      .session-time {
        color: var(--text-secondary);
        font-weight: var(--font-semibold);
      }
      .sessions-track {
        position: relative;
        height: 32px;
        background: var(--bg-tertiary);
        border-radius: var(--radius-sm);
        /* Clip any session bar that overshoots; defensive against rounding /
         * wrap-segment edge cases so the bars never bleed into the KPI grid. */
        overflow: hidden;
      }
      .session-bar {
        position: absolute;
        top: 4px;
        height: 24px;
        border-radius: var(--radius-sm);
        background: rgba(142, 142, 147, 0.18);
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 10px;
        font-weight: var(--font-medium);
        color: var(--text-tertiary);
        opacity: 0.7;
        overflow: hidden;
        /* Prevent labels from forcing a segment to grow beyond its width — a
         * bar narrower than the label simply hides it (handled by showLabel). */
        white-space: nowrap;
        text-overflow: clip;
        box-sizing: border-box;
      }
      .session-bar.active {
        opacity: 1;
        font-weight: var(--font-semibold);
      }
      .session-bar[data-session='Sydney'].active {
        background: rgba(175, 82, 222, 0.2);
        color: #8a2be2;
      }
      .session-bar[data-session='Tokyo'].active {
        background: rgba(255, 59, 48, 0.18);
        color: #d70015;
      }
      .session-bar[data-session='London'].active {
        background: rgba(0, 113, 227, 0.18);
        color: var(--accent);
      }
      .session-bar[data-session='New York'].active {
        background: rgba(52, 199, 89, 0.18);
        color: #248a3d;
      }
      .now-marker {
        position: absolute;
        top: 0;
        bottom: 0;
        width: 2px;
        background: var(--text-primary);
        z-index: 2;
      }
      .sessions-active {
        display: flex;
        gap: var(--space-2);
        flex-wrap: wrap;
      }
      .session-pill {
        padding: 2px 10px;
        border-radius: var(--radius-full);
        background: var(--bg-tertiary);
        color: var(--text-primary);
        font-size: 10px;
        font-weight: var(--font-semibold);
      }

      .overview-kpis {
        display: grid;
        grid-template-columns: repeat(6, 1fr);
        gap: var(--space-2);
      }
      @media (max-width: 1200px) {
        .overview-kpis {
          grid-template-columns: repeat(3, 1fr);
        }
      }
      .stale-feed-banner {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 12px;
        margin-bottom: var(--space-2);
        background: rgba(255, 149, 0, 0.08);
        border: 1px solid rgba(255, 149, 0, 0.25);
        border-radius: 6px;
        color: #c93400;
        font-size: 12px;
      }
      .stale-feed-icon {
        font-size: 14px;
      }

      /* Watch ribbon */
      .watch-ribbon {
        display: grid;
        grid-template-columns: repeat(8, 1fr);
        gap: var(--space-2);
        margin-top: var(--space-3);
      }
      @media (max-width: 1400px) {
        .watch-ribbon {
          grid-template-columns: repeat(4, 1fr);
        }
      }
      @media (max-width: 720px) {
        .watch-ribbon {
          grid-template-columns: repeat(2, 1fr);
        }
      }
      .watch-card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        padding: var(--space-2) var(--space-3);
        transition: border-color 0.2s ease;
      }
      .watch-card.flash-up {
        border-color: rgba(52, 199, 89, 0.3);
      }
      .watch-card.flash-down {
        border-color: rgba(255, 59, 48, 0.3);
      }
      .watch-card.empty {
        opacity: 0.55;
      }
      .watch-head {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        margin-bottom: 2px;
      }
      .watch-symbol {
        font-size: 11px;
        font-weight: var(--font-bold);
        color: var(--text-primary);
      }
      .watch-change {
        font-size: 10px;
        font-weight: var(--font-semibold);
        font-variant-numeric: tabular-nums;
      }
      .watch-change.up {
        color: var(--profit);
      }
      .watch-change.down {
        color: var(--loss);
      }
      .watch-price {
        font-size: 14px;
        font-weight: var(--font-bold);
        color: var(--text-primary);
        margin-bottom: 2px;
        transition: color 0.3s ease;
      }
      .watch-price.up {
        color: var(--profit);
      }
      .watch-price.down {
        color: var(--loss);
      }
      .watch-meta {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: var(--space-1);
      }
      .watch-spread {
        font-size: 9px;
        color: var(--text-tertiary);
      }
      .watch-spark {
        flex: 1;
      }

      /* Movers + recent ticks row */
      .movers-row {
        display: grid;
        grid-template-columns: 2fr 1fr;
        gap: var(--space-3);
        margin-top: var(--space-3);
      }
      @media (max-width: 1200px) {
        .movers-row {
          grid-template-columns: 1fr;
        }
      }
      .movers,
      .recent-ticks {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: hidden;
      }
      .movers-head {
        display: flex;
        align-items: baseline;
        gap: var(--space-3);
        padding: var(--space-3) var(--space-4);
        border-bottom: 1px solid var(--border);
      }
      .movers-head h3 {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      .movers-head .muted {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
      }
      .movers-table {
        width: 100%;
        border-collapse: collapse;
      }
      .movers-table th,
      .movers-table td {
        padding: var(--space-2) var(--space-4);
        text-align: left;
        border-bottom: 1px solid var(--border);
        font-size: var(--text-xs);
      }
      .movers-table tbody tr:last-child td {
        border-bottom: none;
      }
      .movers-table th {
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        font-size: 10.5px;
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .movers-table th.num,
      .movers-table td.num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .movers-table td.mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
      }
      .movers-table .profit {
        color: var(--profit);
      }
      .movers-table .loss {
        color: var(--loss);
      }
      .ticks-list {
        list-style: none;
        margin: 0;
        padding: 0;
        max-height: 280px;
        overflow-y: auto;
      }
      .tick-item {
        display: grid;
        grid-template-columns: 70px 1fr 14px auto;
        align-items: center;
        gap: var(--space-2);
        padding: 6px var(--space-4);
        border-bottom: 1px solid var(--border);
        font-size: var(--text-xs);
      }
      .tick-item:last-child {
        border-bottom: none;
      }
      .tick-symbol {
        font-weight: var(--font-semibold);
      }
      .tick-bid {
        text-align: right;
      }
      .tick-arrow {
        text-align: center;
        font-size: 10px;
        color: var(--text-tertiary);
      }
      .tick-item.up .tick-arrow {
        color: var(--profit);
      }
      .tick-item.down .tick-arrow {
        color: var(--loss);
      }
      .tick-time {
        font-size: 10.5px;
      }
      .muted {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
      }
      .mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
      }

      .empty-state {
        padding: var(--space-6) var(--space-4);
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: var(--space-1);
        text-align: center;
      }
      .empty-hint {
        font-size: 10.5px;
        color: var(--text-tertiary);
      }

      .symbol-matrix {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: hidden;
        margin-top: var(--space-3);
      }
      .symbol-matrix .movers-table th,
      .symbol-matrix .movers-table td {
        padding: 8px var(--space-3);
      }

      .chart-row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--space-3);
        margin-top: var(--space-3);
      }
      @media (max-width: 1100px) {
        .chart-row {
          grid-template-columns: 1fr;
        }
      }

      @media (max-width: 1200px) {
        .price-grid {
          grid-template-columns: repeat(2, 1fr);
        }
        .metrics-row {
          grid-template-columns: repeat(2, 1fr);
        }
      }
      @media (max-width: 768px) {
        .price-grid {
          grid-template-columns: 1fr;
        }
        .charts-grid {
          grid-template-columns: 1fr;
        }
        .metrics-row {
          grid-template-columns: 1fr;
        }
      }
    `,
  ],
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
  // Last spread observed from a real (non-candle) tick per symbol. Used as
  // the fallback for the Avg/Tightest/Widest KPIs and the spread-comparison
  // chart when the live tick feed has gone stale (EA stopped pushing) — gives
  // operators "best-known-truth" instead of a row of `-`.
  private lastLiveSpread: Record<string, number> = {};

  watchedSymbols = ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'EURGBP', 'USDCHF', 'NZDUSD', 'USDCAD'];
  displaySymbols = [
    'EUR/USD',
    'GBP/USD',
    'USD/JPY',
    'AUD/USD',
    'EUR/GBP',
    'USD/CHF',
    'NZD/USD',
    'USD/CAD',
  ];

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
    for (const sym of this.watchedSymbols) {
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
    if (data.every((d) => d.strength === 0)) return {};
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

  // Activity feed: collect direction changes across symbols, latest first.
  // Re-derived from the current livePrices snapshot since priceHistory is
  // append-only — we compare the last vs second-to-last entry per symbol to
  // build a stable, deduped feed.
  activityFeed = computed<
    {
      time: Date;
      symbol: string;
      direction: 'up' | 'down' | 'none';
      price: string;
      delta: number;
    }[]
  >(() => {
    const events: {
      time: Date;
      symbol: string;
      direction: 'up' | 'down' | 'none';
      price: string;
      delta: number;
    }[] = [];
    for (const p of this.livePrices()) {
      if (p.direction === 'none') continue;
      const isJPY = (p.symbol ?? '').includes('JPY');
      const pipFactor = isJPY ? 100 : 10000;
      const deltaPips = p.change * pipFactor;
      events.push({
        time: new Date(p.timestamp),
        symbol: p.symbol ?? '',
        direction: p.direction,
        price: this.formatPrice(p.bid, p.symbol),
        delta: deltaPips,
      });
    }
    return events.sort((a, b) => b.time.getTime() - a.time.getTime()).slice(0, 12);
  });

  rangeInPips(p: PriceEntry): number {
    const isJPY = (p.symbol ?? '').includes('JPY');
    const pipFactor = isJPY ? 100 : 10000;
    return (p.high24h - p.low24h) * pipFactor;
  }

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
      xAxis: {
        type: 'category',
        data: counts.map((_, i) => `${(i * width).toFixed(0)}+`),
        axisLabel: { fontSize: 9, color: '#6E6E73', rotate: 30 },
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
      grid: { top: 10, right: 30, bottom: 30, left: 80 },
      xAxis: {
        type: 'value',
        axisLabel: { fontSize: 10, color: '#6E6E73' },
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
          this.candleAnalyticsSample.set(data);
        } else {
          // Backend returned nothing (or 4xx) — populate with the same
          // generator the data table uses so the analytics tab still has
          // something to render in dev.
          this.candleAnalyticsSample.set(
            this.generateSampleCandles({ currentPage: 1, itemCountPerPage: 200, filter: null })
              .data,
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

  avgSpread = computed(() => {
    const spreads = this.spreadsForKpis();
    if (spreads.length === 0) return null;
    return spreads.reduce((sum, s) => sum + s, 0) / spreads.length;
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
    return [...this.livePrices()]
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
    return this.displaySymbols.map((sym) => ({
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
    return this.displaySymbols.map((sym, i) => {
      const apiSym = this.watchedSymbols[i];
      const hist = this.priceHistory[apiSym] ?? [];
      const liveEntry = live.find((p) => p.symbol === sym) ?? null;
      const isJPY = sym.includes('JPY');
      const pipFactor = isJPY ? 100 : 10000;
      const rangePips =
        hist.length > 1 ? +((Math.max(...hist) - Math.min(...hist)) * pipFactor).toFixed(1) : null;
      return {
        symbol: sym,
        live: liveEntry,
        spark: hist.slice(-30),
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

  candleColumns: ColDef[] = [
    { field: 'symbol', headerName: 'Symbol', width: 110 },
    { field: 'timeframe', headerName: 'TF', width: 80 },
    {
      field: 'open',
      headerName: 'Open',
      width: 120,
      valueFormatter: (p: any) => p.value?.toFixed(5),
    },
    {
      field: 'high',
      headerName: 'High',
      width: 120,
      valueFormatter: (p: any) => p.value?.toFixed(5),
    },
    {
      field: 'low',
      headerName: 'Low',
      width: 120,
      valueFormatter: (p: any) => p.value?.toFixed(5),
    },
    {
      field: 'close',
      headerName: 'Close',
      width: 120,
      valueFormatter: (p: any) => p.value?.toFixed(5),
    },
    { field: 'volume', headerName: 'Volume', width: 100 },
    {
      field: 'timestamp',
      headerName: 'Time',
      flex: 1,
      valueFormatter: (p: any) => (p.value ? new Date(p.value).toLocaleString() : '-'),
    },
  ];

  // Pearson correlation across the rolling priceHistory windows for every
  // pair of watched symbols. Returns the 8×8 matrix; cells without enough
  // data (< 5 shared points) read 0 so the heatmap renders cleanly during a
  // cold start. The matrix is later consumed by the chart and the KPI strip.
  private corrMatrix = computed<number[][]>(() => {
    this.livePrices(); // re-run on each poll
    const apiSyms = this.watchedSymbols;
    const n = apiSyms.length;
    const matrix: number[][] = [];
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
        if (len < 5) {
          matrix[i][j] = 0;
          continue;
        }
        const aSlice = a.slice(-len);
        const bSlice = b.slice(-len);
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
        matrix[i][j] = den === 0 ? 0 : +(num / den).toFixed(3);
      }
    }
    return matrix;
  });

  correlationOptions = computed<EChartsOption>(() => {
    const matrix = this.corrMatrix();
    const symbols = this.displaySymbols;
    const data: [number, number, number][] = [];
    for (let i = 0; i < symbols.length; i++) {
      for (let j = 0; j < symbols.length; j++) {
        data.push([j, i, matrix[i]?.[j] ?? 0]);
      }
    }
    return {
      tooltip: {
        formatter: (p: any) =>
          `${symbols[p.value[1]]} ↔ ${symbols[p.value[0]]}<br/>r = ${p.value[2].toFixed(2)}`,
      },
      grid: { top: 30, right: 20, bottom: 40, left: 80 },
      xAxis: {
        type: 'category',
        data: symbols,
        axisLabel: { fontSize: 9.5, color: '#6E6E73', rotate: 30 },
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
          label: { show: true, fontSize: 9, formatter: (p: any) => p.value[2].toFixed(2) },
          itemStyle: { borderColor: '#fff', borderWidth: 2, borderRadius: 3 },
        },
      ],
    };
  });

  // Per-symbol price-history statistics: mean, std-dev, range in pips,
  // tick-to-tick volatility, current Z-score. Drives the analytics-tab
  // stats table and a few of the KPI tiles.
  perSymbolStats = computed(() => {
    this.livePrices(); // re-run on each poll
    return this.displaySymbols.map((sym, i) => {
      const apiSym = this.watchedSymbols[i];
      const hist = this.priceHistory[apiSym] ?? [];
      const live = this.livePrices().find((p) => p.symbol === sym);
      const isJPY = sym.includes('JPY');
      const pipFactor = isJPY ? 100 : 10000;

      if (hist.length < 2) {
        return {
          symbol: sym,
          points: hist.length,
          mean: 0,
          stdDev: 0,
          min: 0,
          max: 0,
          rangePips: 0,
          volatility: 0,
          current: live?.bid ?? 0,
          zScore: 0,
          changePct: live?.changePct ?? 0,
          direction: live?.direction ?? 'none',
          fromCandle: live?.fromCandle ?? false,
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

      const current = live?.bid ?? hist[hist.length - 1];
      const zScore = stdDev > 0 ? (current - mean) / stdDev : 0;

      return {
        symbol: sym,
        points: hist.length,
        mean,
        stdDev,
        min,
        max,
        rangePips,
        volatility,
        current,
        zScore,
        changePct: live?.changePct ?? 0,
        direction: live?.direction ?? 'none',
        fromCandle: live?.fromCandle ?? false,
      };
    });
  });

  // Analytics-tab KPI roll-ups derived from perSymbolStats + corrMatrix.
  analyticsKpis = computed(() => {
    const stats = this.perSymbolStats();
    const matrix = this.corrMatrix();
    const dataPoints = stats.reduce((sum, s) => sum + s.points, 0);
    const vols = stats.map((s) => s.volatility).filter((v) => v > 0);
    const ranges = stats.map((s) => s.rangePips).filter((r) => r > 0);
    const avgVolatility = vols.length > 0 ? vols.reduce((a, b) => a + b, 0) / vols.length : null;
    const maxVolatility = vols.length > 0 ? Math.max(...vols) : null;
    const avgRange = ranges.length > 0 ? ranges.reduce((a, b) => a + b, 0) / ranges.length : null;
    const maxRange = ranges.length > 0 ? Math.max(...ranges) : null;

    let strongPos = 0;
    let strongNeg = 0;
    for (let i = 0; i < matrix.length; i++) {
      for (let j = i + 1; j < matrix.length; j++) {
        const r = matrix[i]?.[j] ?? 0;
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
    const stats = this.perSymbolStats().filter((s) => s.points >= 2);
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

  spreadHeatmapOptions: EChartsOption = {
    grid: { top: 10, right: 20, bottom: 40, left: 80 },
    xAxis: {
      type: 'category',
      data: Array.from({ length: 24 }, (_, i) => `${i}h`),
      axisLabel: { fontSize: 9, color: '#6E6E73' },
    },
    yAxis: {
      type: 'category',
      data: ['EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD'],
      axisLabel: { fontSize: 11, color: '#6E6E73' },
    },
    visualMap: {
      min: 0.5,
      max: 4,
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
        data: Array.from({ length: 96 }, (_, i) => [
          i % 24,
          Math.floor(i / 24),
          +(0.8 + Math.random() * 3).toFixed(1),
        ]),
        label: { show: false },
        itemStyle: { borderColor: 'var(--bg-primary)', borderWidth: 1, borderRadius: 2 },
      },
    ],
  };

  // Dynamic computed chart options
  spreadChartOptions = computed<EChartsOption>(() => {
    // Prefer live ticks. When the feed is stale and every current row is a
    // candle-fallback (synthetic 0 spread), fall back to the per-symbol
    // last-known live spread so the chart shows operators the best-known
    // values instead of an empty panel.
    this.livePrices(); // re-run trigger
    const prices = this.liveOnly();
    let series: { symbol: string; spread: number }[];
    if (prices.length > 0) {
      series = prices.map((p) => ({ symbol: p.symbol ?? '', spread: p.spread }));
    } else if (Object.keys(this.lastLiveSpread).length > 0) {
      series = Object.entries(this.lastLiveSpread).map(([apiSym, spread], i) => {
        const idx = this.watchedSymbols.indexOf(apiSym);
        return { symbol: idx >= 0 ? this.displaySymbols[idx] : apiSym, spread };
      });
    } else {
      return {};
    }
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
          barWidth: 18,
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

  priceHistoryOptions = computed<EChartsOption>(() => {
    const history = this.priceHistory;
    const symbols = Object.keys(history).filter((s) => history[s].length > 1);
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
      grid: { top: 30, right: 20, bottom: 30, left: 70 },
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
        scale: true,
        axisLabel: { fontSize: 10, color: '#6E6E73' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
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
    const prices = this.livePrices();
    if (prices.length === 0) return {};
    // Calculate tick-to-tick volatility from price history
    const volData = this.displaySymbols
      .slice(0, 8)
      .map((sym, i) => {
        const apiSym = this.watchedSymbols[i];
        const hist = this.priceHistory[apiSym] || [];
        if (hist.length < 3) return { name: sym, vol: 0 };
        const returns = hist.slice(1).map((v, j) => Math.abs((v - hist[j]) / hist[j]) * 10000);
        const avgVol = returns.reduce((a, b) => a + b, 0) / returns.length;
        return { name: sym, vol: +avgVol.toFixed(2) };
      })
      .sort((a, b) => b.vol - a.vol);

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
          barWidth: 18,
          label: { show: true, position: 'right', fontSize: 10, color: '#6E6E73' },
        },
      ],
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
    hist.forEach((v) => {
      const idx = Math.min(Math.floor((v - min) / binWidth), bins - 1);
      counts[idx]++;
    });
    const labels = counts.map((_, i) => (min + i * binWidth + binWidth / 2).toFixed(5));

    return {
      grid: { top: 10, right: 20, bottom: 30, left: 50 },
      xAxis: {
        type: 'category',
        data: labels,
        axisLabel: { fontSize: 8, color: '#6E6E73', rotate: 45 },
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
  }

  ngOnInit() {
    this.loadPrices();
    timer(3000, 3000)
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => this.loadPrices());

    // Wall-clock signal for the sessions track + feed-age. 30s cadence is
    // enough — the now-marker on the sessions bar moves at 1px every ~10
    // minutes at typical card widths, finer ticks are pure overhead.
    timer(0, 30_000)
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => this.nowMs.set(Date.now()));
  }

  ngOnDestroy() {
    this.destroy$.next();
    this.destroy$.complete();
  }

  loadPrices() {
    // Two-stage fetch: try the live-tick cache first, fall back to the most
    // recent M5 candle when the cache returns nothing for a symbol. The
    // candle-derived entry is flagged so spread KPIs / charts can exclude it
    // (a synthetic spread of 0 would otherwise distort the average).
    const requests = this.watchedSymbols.map((symbol, i) =>
      this.marketDataService.getLivePrice(symbol).pipe(
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
              displaySymbol: this.displaySymbols[i],
              data: { ...(live as LivePriceDto), symbol: this.displaySymbols[i] },
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
                displaySymbol: this.displaySymbols[i],
                data: {
                  symbol: this.displaySymbols[i],
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
      ),
    );

    forkJoin(requests)
      .pipe(takeUntil(this.destroy$))
      .subscribe((results) => {
        const current = this.livePrices();
        const newPrices: PriceEntry[] = results
          .map((r) => {
            if (!r) return null;
            const { symbol: sym, data, fromCandle } = r;

            const prev = current.find((p) => p.symbol === data.symbol);
            const prevBid = prev?.bid ?? data.bid;
            const change = data.bid - prevBid;

            // Engine returns spread in raw price units (ask - bid); operators
            // expect FX spread in pips. Convert at the source so every
            // downstream consumer (KPIs / chart / matrix / ribbon badges)
            // gets the pip value without each having to know the pipFactor.
            const isJPY = (data.symbol ?? sym).includes('JPY');
            const pipFactor = isJPY ? 100 : 10000;
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
            }

            const sparkData = this.priceHistory[sym].slice(-30);

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
        pageNo: 8,
        pageSize,
        filter: null,
      },
      data: candles,
    };
  }
}
