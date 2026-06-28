import {
  Component,
  ChangeDetectionStrategy,
  DestroyRef,
  inject,
  signal,
  computed,
  OnInit,
  OnDestroy,
  ViewChild,
  effect,
} from '@angular/core';
import { Router } from '@angular/router';
import { catchError, map, merge, Observable, of, throttleTime } from 'rxjs';
import type { ColDef } from 'ag-grid-community';
import type { EChartsOption } from 'echarts';

import { MarketDataService } from '@core/services/market-data.service';
import { PositionsService } from '@core/services/positions.service';
import { RealtimeService } from '@core/realtime/realtime.service';
import { NotificationService } from '@core/notifications/notification.service';
import { AccountScopeService } from '@core/scope/account-scope.service';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { PositionDto, PagedData, PagerRequest } from '@core/api/api.types';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { DataTableComponent } from '@shared/components/data-table/data-table.component';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import { TabsComponent, TabItem } from '@shared/components/ui/tabs/tabs.component';
import { StatusPillCellComponent } from '@shared/components/data-table/cell-renderers/status-pill-cell.component';
import { DirectionCellComponent } from '@shared/components/data-table/cell-renderers/direction-cell.component';
import { CurrencyFormatPipe } from '@shared/pipes/currency-format.pipe';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';
import {
  EATradeChartModalComponent,
  type TradeChartSelection,
} from '@features/ea-instances/components/ea-trade-chart-modal/ea-trade-chart-modal.component';

@Component({
  selector: 'app-positions-page',
  standalone: true,
  imports: [
    PageHeaderComponent,
    MetricCardComponent,
    DataTableComponent,
    ChartCardComponent,
    TabsComponent,
    EATradeChartModalComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <app-page-header title="Positions" subtitle="Monitor open and closed trading positions" />

      <!-- Account scope picker — operator wanted explicit per-account
           switching on this page (the global header dropdown also works,
           but having it inline saves the cross-page hunt). Pills mirror
           AccountScopeService directly, so picking one here propagates to
           every other page that respects the global scope. The "All real"
           pill aggregates across every live REAL account; per-account
           pills filter to one account exactly. Only shown when at least 2
           live REAL accounts exist — single-account fleets have nothing
           to switch between. -->
      @if (accountPills().length >= 2) {
        <nav class="account-pills" aria-label="Filter by trading account">
          <button
            type="button"
            class="acct-pill"
            [class.active]="accountScope.isAggregateReal()"
            (click)="selectAccountScope(aggregateRealScope)"
            title="Aggregate across every live real account"
          >
            All real
            <span class="acct-count">{{ accountPills().length }}</span>
          </button>
          @for (a of accountPills(); track a.id) {
            <button
              type="button"
              class="acct-pill"
              [class.active]="accountScope.selected() === a.id"
              (click)="selectAccountScope(a.id)"
              [title]="a.brokerName ? a.brokerName + ' · ' + a.accountId : ''"
            >
              {{ a.label }}
            </button>
          }
        </nav>
      }

      <!-- Summary strip — 8 dense tiles (recent window) -->
      <div class="metrics-strip">
        <app-metric-card
          label="Unrealized P&L"
          [value]="totalUnrealizedPnL()"
          format="currency"
          [colorByValue]="true"
        />
        <app-metric-card
          label="Today realized"
          [value]="realizedToday()"
          format="currency"
          [colorByValue]="true"
        />
        <app-metric-card
          label="Open positions"
          [value]="openPositionCount()"
          format="number"
          dotColor="#0071E3"
        />
        <app-metric-card
          label="Total lots"
          [value]="totalLots()"
          format="number"
          dotColor="#5AC8FA"
        />
        <app-metric-card
          label="Long / Short"
          [value]="longShortRatioPct()"
          format="percent"
          dotColor="#34C759"
        />
        <app-metric-card
          label="Win rate"
          [value]="winRatePct()"
          format="percent"
          dotColor="#34C759"
        />
        <app-metric-card
          label="Profit factor"
          [value]="profitFactor()"
          format="number"
          dotColor="#AF52DE"
        />
        <app-metric-card
          label="Avg hold (h)"
          [value]="avgHoldHours()"
          format="number"
          dotColor="#FF9500"
        />
      </div>

      <!-- Tabs -->
      <ui-tabs [tabs]="tabs" [(activeTab)]="activeTab">
        @switch (activeTab()) {
          @case ('open') {
            <!-- Quick-glance distribution above the table -->
            @if (openPositionCount() > 0) {
              <div class="open-insights">
                <app-chart-card
                  title="Exposure by symbol"
                  subtitle="Open lots, sorted"
                  [options]="exposureBySymbolChart()"
                  height="180px"
                />
                <app-chart-card
                  title="Long vs Short"
                  subtitle="By open lots and unrealized P&L"
                  [options]="longShortChart()"
                  height="180px"
                />
              </div>
            }
            <app-data-table
              #openTable
              [columnDefs]="openColumnDefs"
              [fetchData]="fetchOpenPositions"
              [searchable]="true"
              (rowClick)="onRowClick($event)"
            />
          }
          @case ('closed') {
            <!-- Closed-tab quick stats — 6 dense tiles -->
            <div class="closed-stats">
              <app-metric-card
                label="Closed (window)"
                [value]="closedPositions().length"
                format="number"
                dotColor="#0071E3"
              />
              <app-metric-card
                label="Total realized"
                [value]="closedTotalRealized()"
                format="currency"
                [colorByValue]="true"
              />
              <app-metric-card
                label="Avg win"
                [value]="closedAvgWin()"
                format="currency"
                dotColor="#34C759"
              />
              <app-metric-card
                label="Avg loss"
                [value]="closedAvgLoss()"
                format="currency"
                dotColor="#FF3B30"
              />
              <app-metric-card
                label="Biggest win"
                [value]="closedBestTrade()"
                format="currency"
                dotColor="#34C759"
              />
              <app-metric-card
                label="Biggest loss"
                [value]="closedWorstTrade()"
                format="currency"
                dotColor="#FF3B30"
              />
              <app-metric-card
                label="Expectancy / trade"
                [value]="closedExpectancy()"
                format="currency"
                [colorByValue]="true"
              />
              <app-metric-card
                label="Largest streak"
                [value]="closedLargestStreak()"
                format="number"
                [dotColor]="closedLargestStreakIsWins() ? '#34C759' : '#FF3B30'"
              />
            </div>

            <!-- Cumulative P&L equity curve. 260px gives both the curve
                 and the dense daily date labels (one tick per trade) the
                 room ECharts needs once containLabel:true reserves space
                 for them inside the card. -->
            <app-chart-card
              title="Cumulative realized P&L"
              [subtitle]="cumulativeSparklineSubtitle()"
              [options]="cumulativeSparklineChart()"
              height="260px"
            />

            <!-- Filter chips -->
            <div class="filter-row">
              <div class="chip-group" role="tablist" aria-label="Filter closed positions">
                <button
                  type="button"
                  role="tab"
                  class="chip"
                  [class.active]="closedFilter() === 'all'"
                  (click)="closedFilter.set('all')"
                >
                  All <span class="chip-count">{{ closedPositions().length }}</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  class="chip win"
                  [class.active]="closedFilter() === 'wins'"
                  (click)="closedFilter.set('wins')"
                >
                  Wins <span class="chip-count">{{ closedWinsCount() }}</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  class="chip loss"
                  [class.active]="closedFilter() === 'losses'"
                  (click)="closedFilter.set('losses')"
                >
                  Losses <span class="chip-count">{{ closedLossesCount() }}</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  class="chip"
                  [class.active]="closedFilter() === 'today'"
                  (click)="closedFilter.set('today')"
                >
                  Today <span class="chip-count">{{ closedTodayCount() }}</span>
                </button>
              </div>
            </div>
            <app-data-table
              #closedTable
              [columnDefs]="closedColumnDefs"
              [fetchData]="fetchClosedPositions"
              [searchable]="true"
              (rowClick)="onRowClick($event)"
            />

            <!-- Per-symbol breakdown table -->
            @if (closedPerSymbol().length > 0) {
              <section class="per-symbol">
                <header class="per-symbol-head">
                  <h3>Per-Symbol Breakdown</h3>
                  <span class="muted">Closed window · top 12 by trade count</span>
                </header>
                <table class="stats-table">
                  <thead>
                    <tr>
                      <th>Symbol</th>
                      <th class="num">Trades</th>
                      <th class="num">Wins / Losses</th>
                      <th class="num">Win %</th>
                      <th class="num">Net P&L</th>
                      <th class="num">Avg P&L</th>
                      <th class="num">Best</th>
                      <th class="num">Worst</th>
                      <th class="num">Avg hold</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (s of closedPerSymbol(); track s.symbol) {
                      <tr>
                        <td class="mono">{{ s.symbol }}</td>
                        <td class="num mono">{{ s.trades }}</td>
                        <td class="num">
                          <span class="profit">{{ s.wins }}</span>
                          <span class="muted"> / </span>
                          <span class="loss">{{ s.losses }}</span>
                        </td>
                        <td
                          class="num mono"
                          [class.profit]="s.winRatePct >= 60"
                          [class.loss]="s.winRatePct < 40"
                        >
                          {{ s.winRatePct.toFixed(0) }}%
                        </td>
                        <td
                          class="num mono"
                          [class.profit]="s.netPnL > 0"
                          [class.loss]="s.netPnL < 0"
                        >
                          {{ s.netPnL >= 0 ? '+' : '' }}{{ s.netPnL.toFixed(2) }}
                        </td>
                        <td
                          class="num mono"
                          [class.profit]="s.avgPnL > 0"
                          [class.loss]="s.avgPnL < 0"
                        >
                          {{ s.avgPnL >= 0 ? '+' : '' }}{{ s.avgPnL.toFixed(2) }}
                        </td>
                        <td class="num mono profit">+{{ s.best.toFixed(2) }}</td>
                        <td class="num mono loss">{{ s.worst.toFixed(2) }}</td>
                        <td class="num mono">{{ s.avgHoldLabel }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </section>
            }
          }
          @case ('analytics') {
            <!-- Analytics KPI strip (deeper stats than the page-wide strip) -->
            <div class="analytics-kpis">
              <app-metric-card
                label="Sharpe-like ratio"
                [value]="sharpeLikeRatio()"
                format="number"
                dotColor="#0071E3"
              />
              <app-metric-card
                label="Std dev of trade P&L"
                [value]="closedStdDev()"
                format="currency"
                dotColor="#5856D6"
              />
              <app-metric-card
                label="Max drawdown"
                [value]="maxDrawdownAmount()"
                format="currency"
                dotColor="#FF3B30"
              />
              <app-metric-card
                label="Long P&L"
                [value]="longClosedPnL()"
                format="currency"
                [colorByValue]="true"
              />
              <app-metric-card
                label="Short P&L"
                [value]="shortClosedPnL()"
                format="currency"
                [colorByValue]="true"
              />
              <app-metric-card
                label="Best day"
                [value]="bestDayPnL()"
                format="currency"
                dotColor="#34C759"
              />
              <app-metric-card
                label="Worst day"
                [value]="worstDayPnL()"
                format="currency"
                dotColor="#FF3B30"
              />
              <app-metric-card
                label="Trading days"
                [value]="tradingDaysCount()"
                format="number"
                dotColor="#8E8E93"
              />
            </div>

            <!-- Equity curve + drawdown — full width, stacked for visual comparison -->
            <div class="equity-row">
              <app-chart-card
                title="Equity curve"
                subtitle="Cumulative realized P&L with high-water mark"
                [options]="equityCurveChart()"
                [loading]="analyticsLoading()"
                height="220px"
              />
              <app-chart-card
                title="Drawdown"
                subtitle="Distance below high-water mark"
                [options]="drawdownChart()"
                [loading]="analyticsLoading()"
                height="220px"
              />
            </div>

            <!-- 4-column compact analytics grid -->
            <div class="analytics-grid">
              <app-chart-card
                title="P&L Distribution"
                subtitle="Histogram of trade outcomes"
                [options]="pnlDistributionChart()"
                [loading]="analyticsLoading()"
                height="220px"
              />
              <app-chart-card
                title="Net P&L by Symbol"
                subtitle="Sum of realized P&L per instrument"
                [options]="netPnlBySymbolChart()"
                [loading]="analyticsLoading()"
                height="220px"
              />
              <app-chart-card
                title="Win/Loss by Symbol"
                subtitle="Green wins vs red losses per instrument"
                [options]="winLossBySymbolChart()"
                [loading]="analyticsLoading()"
                height="220px"
              />
              <app-chart-card
                title="Long vs Short"
                subtitle="P&L and trade-count comparison"
                [options]="longShortPerformanceChart()"
                [loading]="analyticsLoading()"
                height="220px"
              />
              <app-chart-card
                title="Hold Duration vs P&L"
                subtitle="Scatter of hours against trade P&L"
                [options]="holdDurationVsPnlChart()"
                [loading]="analyticsLoading()"
                height="220px"
              />
              <app-chart-card
                title="P&L by Session"
                subtitle="Performance grouped by trading session"
                [options]="pnlBySessionChart()"
                [loading]="analyticsLoading()"
                height="220px"
              />
              <app-chart-card
                title="P&L by Day of Week"
                subtitle="Realized P&L bucketed Mon–Sun"
                [options]="pnlByDayOfWeekChart()"
                [loading]="analyticsLoading()"
                height="220px"
              />
              <app-chart-card
                title="R-Multiple Distribution"
                subtitle="Distribution of risk-reward multiples"
                [options]="rMultipleChart()"
                [loading]="analyticsLoading()"
                height="220px"
              />
            </div>

            <!-- Detailed per-symbol stats with profit factor + expectancy -->
            @if (analyticsPerSymbol().length > 0) {
              <section class="per-symbol">
                <header class="per-symbol-head">
                  <h3>Per-Symbol Detailed Breakdown</h3>
                  <span class="muted">
                    Closed window · sorted by net P&L · profit factor &amp; expectancy
                  </span>
                </header>
                <table class="stats-table">
                  <thead>
                    <tr>
                      <th>Symbol</th>
                      <th class="num">Trades</th>
                      <th class="num">Win %</th>
                      <th class="num">Net P&L</th>
                      <th class="num">Avg win</th>
                      <th class="num">Avg loss</th>
                      <th class="num">Profit factor</th>
                      <th class="num">Expectancy</th>
                      <th class="num">Max DD</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (s of analyticsPerSymbol(); track s.symbol) {
                      <tr>
                        <td class="mono">{{ s.symbol }}</td>
                        <td class="num mono">{{ s.trades }}</td>
                        <td
                          class="num mono"
                          [class.profit]="s.winRatePct >= 60"
                          [class.loss]="s.winRatePct < 40"
                        >
                          {{ s.winRatePct.toFixed(0) }}%
                        </td>
                        <td
                          class="num mono"
                          [class.profit]="s.netPnL > 0"
                          [class.loss]="s.netPnL < 0"
                        >
                          {{ s.netPnL >= 0 ? '+' : '' }}{{ s.netPnL.toFixed(2) }}
                        </td>
                        <td class="num mono profit">
                          {{ s.avgWin !== null ? '+' + s.avgWin.toFixed(2) : '—' }}
                        </td>
                        <td class="num mono loss">
                          {{ s.avgLoss !== null ? s.avgLoss.toFixed(2) : '—' }}
                        </td>
                        <td
                          class="num mono"
                          [class.profit]="s.profitFactor !== null && s.profitFactor >= 1.5"
                          [class.loss]="s.profitFactor !== null && s.profitFactor < 1"
                        >
                          {{ s.profitFactor !== null ? s.profitFactor.toFixed(2) : '—' }}
                        </td>
                        <td
                          class="num mono"
                          [class.profit]="s.expectancy > 0"
                          [class.loss]="s.expectancy < 0"
                        >
                          {{ s.expectancy >= 0 ? '+' : '' }}{{ s.expectancy.toFixed(2) }}
                        </td>
                        <td class="num mono loss">{{ s.maxDD.toFixed(2) }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </section>
            }
          }
        }
      </ui-tabs>

      <!-- Detail drawer -->
      @if (selectedDetail(); as p) {
        <div class="drawer-backdrop" (click)="selectedDetail.set(null)">
          <aside class="drawer" (click)="$event.stopPropagation()" aria-label="Position details">
            <header class="drawer-head">
              <div>
                <h3>Position #{{ p.id }}</h3>
                <span class="muted">
                  {{ p.symbol }} · {{ p.direction }} · {{ p.status }}
                  @if (p.isPaper) {
                    · paper
                  }
                </span>
              </div>
              <div class="drawer-head-actions">
                <!-- Same chart modal used by the EA detail page; renders the
                     position's entry/SL/TP against the bar history. -->
                <button
                  type="button"
                  class="btn-chart"
                  (click)="openChartFor(p)"
                  title="Visualise this position on a candle chart"
                >
                  View chart
                </button>
                <button class="btn-close" (click)="selectedDetail.set(null)" aria-label="Close">
                  ×
                </button>
              </div>
            </header>

            <section class="drawer-section">
              <h4>Pricing</h4>
              <dl class="drawer-grid">
                <div>
                  <dt>Entry</dt>
                  <dd class="mono">{{ p.averageEntryPrice.toFixed(5) }}</dd>
                </div>
                <div>
                  <dt>{{ p.status === 'Closed' ? 'Exit' : 'Current' }}</dt>
                  <dd class="mono">
                    {{ p.currentPrice !== null ? p.currentPrice.toFixed(5) : '—' }}
                  </dd>
                </div>
                <div>
                  <dt>Stop loss</dt>
                  <dd class="mono">
                    {{ p.stopLoss !== null ? p.stopLoss.toFixed(5) : '—' }}
                  </dd>
                </div>
                <div>
                  <dt>Take profit</dt>
                  <dd class="mono">
                    {{ p.takeProfit !== null ? p.takeProfit.toFixed(5) : '—' }}
                  </dd>
                </div>
                <div>
                  <dt>Trailing</dt>
                  <dd class="mono">
                    {{ p.trailingStopLevel !== null ? p.trailingStopLevel.toFixed(5) : '—' }}
                  </dd>
                </div>
                <div>
                  <dt>Lots</dt>
                  <dd class="mono">{{ p.openLots.toFixed(2) }}</dd>
                </div>
              </dl>
            </section>

            <section class="drawer-section">
              <h4>Performance</h4>
              <dl class="drawer-grid">
                <div>
                  <dt>Unrealized P&L</dt>
                  <dd
                    class="mono"
                    [class.profit]="p.unrealizedPnL > 0"
                    [class.loss]="p.unrealizedPnL < 0"
                  >
                    {{ p.unrealizedPnL >= 0 ? '+' : '' }}{{ p.unrealizedPnL.toFixed(2) }}
                  </dd>
                </div>
                <div>
                  <dt>Realized P&L</dt>
                  <dd
                    class="mono"
                    [class.profit]="p.realizedPnL > 0"
                    [class.loss]="p.realizedPnL < 0"
                  >
                    {{ p.realizedPnL >= 0 ? '+' : '' }}{{ p.realizedPnL.toFixed(2) }}
                  </dd>
                </div>
                <div>
                  <dt>P&L %</dt>
                  <dd
                    class="mono"
                    [class.profit]="pnlPctValue(p) !== null && pnlPctValue(p)! > 0"
                    [class.loss]="pnlPctValue(p) !== null && pnlPctValue(p)! < 0"
                  >
                    {{ pnlPctLabel(p) }}
                  </dd>
                </div>
                <div>
                  <dt>R-multiple</dt>
                  <dd
                    class="mono"
                    [class.profit]="rMultipleValue(p) !== null && rMultipleValue(p)! > 0"
                    [class.loss]="rMultipleValue(p) !== null && rMultipleValue(p)! < 0"
                  >
                    {{ rMultipleLabel(p) }}
                  </dd>
                </div>
                <div>
                  <dt>To SL</dt>
                  <dd class="mono">{{ pipsToSlLabel(p) }}</dd>
                </div>
                <div>
                  <dt>To TP</dt>
                  <dd class="mono">{{ pipsToTpLabel(p) }}</dd>
                </div>
              </dl>
            </section>

            <section class="drawer-section">
              <h4>Lifecycle</h4>
              <dl class="drawer-grid">
                <div>
                  <dt>Broker id</dt>
                  <dd class="mono">{{ p.brokerPositionId ?? '—' }}</dd>
                </div>
                <div>
                  <dt>Mode</dt>
                  <dd>{{ p.isPaper ? 'Paper' : 'Live' }}</dd>
                </div>
                <div>
                  <dt>Opened</dt>
                  <dd>{{ formatTs(p.openedAt) }}</dd>
                </div>
                <div>
                  <dt>Closed</dt>
                  <dd>{{ p.closedAt ? formatTs(p.closedAt) : '—' }}</dd>
                </div>
                <div>
                  <dt>Hold duration</dt>
                  <dd>{{ holdDurationLabel(p) }}</dd>
                </div>
              </dl>
            </section>

            <footer class="drawer-actions">
              <button type="button" class="btn btn-link" (click)="goToDetail(p)">
                Open detail page →
              </button>
            </footer>
          </aside>
        </div>
      }

      <!-- Shared trade-chart modal: closed-row clicks open it directly; the
           open-position drawer also has a "View chart" button that triggers
           the same modal. action=null suppresses the destructive footer
           that the EA panel uses for Close/Cancel actions. -->
      <app-ea-trade-chart-modal
        [selection]="chartSelection()"
        [open]="chartOpen()"
        (openChange)="chartOpen.set($event)"
      />
    </div>
  `,
  styles: [
    `
      .page {
        padding: var(--space-2) 0;
      }

      .metrics-strip {
        display: grid;
        grid-template-columns: repeat(8, 1fr);
        gap: var(--space-3);
        margin-bottom: var(--space-4);
      }
      @media (max-width: 1400px) {
        .metrics-strip {
          grid-template-columns: repeat(4, 1fr);
        }
      }
      @media (max-width: 720px) {
        .metrics-strip {
          grid-template-columns: repeat(2, 1fr);
        }
      }

      .open-insights {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--space-4);
        margin-bottom: var(--space-3);
      }
      @media (max-width: 1200px) {
        .open-insights {
          grid-template-columns: 1fr;
        }
      }

      .closed-stats {
        display: grid;
        grid-template-columns: repeat(8, 1fr);
        gap: var(--space-3);
        margin-bottom: var(--space-3);
      }
      @media (max-width: 1400px) {
        .closed-stats {
          grid-template-columns: repeat(4, 1fr);
        }
      }
      @media (max-width: 720px) {
        .closed-stats {
          grid-template-columns: repeat(2, 1fr);
        }
      }

      .per-symbol {
        margin-top: var(--space-4);
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: hidden;
      }
      .per-symbol-head {
        display: flex;
        align-items: baseline;
        gap: var(--space-3);
        padding: var(--space-3) var(--space-5);
        border-bottom: 1px solid var(--border);
      }
      .per-symbol-head h3 {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      .per-symbol-head .muted {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
      }
      .stats-table {
        width: 100%;
        border-collapse: collapse;
      }
      .stats-table th,
      .stats-table td {
        padding: var(--space-2) var(--space-4);
        text-align: left;
        border-bottom: 1px solid var(--border);
        font-size: var(--text-xs);
      }
      .stats-table tbody tr:last-child td {
        border-bottom: none;
      }
      .stats-table th {
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        font-size: 10.5px;
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .stats-table th.num,
      .stats-table td.num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .stats-table td.mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
      }
      .stats-table .profit {
        color: var(--profit);
      }
      .stats-table .loss {
        color: var(--loss);
      }

      .charts-grid {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: var(--space-4);
      }
      @media (max-width: 1024px) {
        .charts-grid {
          grid-template-columns: 1fr;
        }
      }

      .analytics-kpis {
        display: grid;
        grid-template-columns: repeat(8, 1fr);
        gap: var(--space-3);
        margin-bottom: var(--space-3);
      }
      @media (max-width: 1400px) {
        .analytics-kpis {
          grid-template-columns: repeat(4, 1fr);
        }
      }
      @media (max-width: 720px) {
        .analytics-kpis {
          grid-template-columns: repeat(2, 1fr);
        }
      }

      .equity-row {
        display: grid;
        grid-template-columns: 2fr 1fr;
        gap: var(--space-3);
        margin-bottom: var(--space-3);
      }
      @media (max-width: 1200px) {
        .equity-row {
          grid-template-columns: 1fr;
        }
      }

      .analytics-grid {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: var(--space-3);
        margin-bottom: var(--space-4);
      }
      @media (max-width: 1400px) {
        .analytics-grid {
          grid-template-columns: repeat(2, 1fr);
        }
      }
      @media (max-width: 720px) {
        .analytics-grid {
          grid-template-columns: 1fr;
        }
      }

      /* Account scope pills — quick per-account filter above the KPI strip. */
      .account-pills {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-2);
        margin: var(--space-3) 0;
        padding: 4px;
        background: var(--bg-tertiary);
        border-radius: var(--radius-full);
        width: fit-content;
      }
      .acct-pill {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        height: 30px;
        padding: 0 14px;
        border: none;
        background: transparent;
        color: var(--text-secondary);
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        border-radius: var(--radius-full);
        cursor: pointer;
        font-family: inherit;
        transition:
          background 0.12s ease,
          color 0.12s ease;
      }
      .acct-pill:hover {
        color: var(--text-primary);
      }
      .acct-pill.active {
        background: var(--bg-secondary);
        color: var(--accent);
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
      }
      .acct-count {
        font-size: 10.5px;
        padding: 1px 6px;
        background: rgba(0, 113, 227, 0.16);
        color: var(--accent);
        border-radius: var(--radius-full);
        font-weight: var(--font-semibold);
      }
      .acct-pill.active .acct-count {
        background: var(--accent);
        color: #fff;
      }

      /* Closed-tab filter chips */
      .filter-row {
        display: flex;
        gap: var(--space-3);
        align-items: center;
        flex-wrap: wrap;
        /* Push down off the cumulative P&L card above — without this the
           date labels (now padded by containLabel:true) sit right against
           the chip row. */
        margin-top: var(--space-4);
        margin-bottom: var(--space-3);
      }
      .chip-group {
        display: inline-flex;
        gap: 2px;
        padding: 3px;
        background: var(--bg-tertiary);
        border-radius: var(--radius-full);
      }
      .chip {
        height: 28px;
        padding: 0 12px;
        border: none;
        background: transparent;
        color: var(--text-secondary);
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
        font-family: inherit;
        border-radius: var(--radius-full);
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .chip:hover:not(.active) {
        color: var(--text-primary);
      }
      .chip.active {
        background: var(--bg-secondary);
        color: var(--text-primary);
        box-shadow: var(--shadow-sm);
      }
      .chip.active.win {
        color: #248a3d;
      }
      .chip.active.loss {
        color: #d70015;
      }
      .chip-count {
        background: var(--bg-tertiary);
        color: var(--text-tertiary);
        padding: 1px 7px;
        border-radius: var(--radius-full);
        font-size: 10px;
        font-variant-numeric: tabular-nums;
      }

      /* Detail drawer */
      .drawer-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.35);
        z-index: 100;
        display: flex;
        justify-content: flex-end;
      }
      .drawer {
        width: 100%;
        max-width: 460px;
        background: var(--bg-secondary);
        border-left: 1px solid var(--border);
        box-shadow: -8px 0 24px rgba(0, 0, 0, 0.12);
        display: flex;
        flex-direction: column;
        overflow-y: auto;
      }
      .drawer-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: var(--space-4) var(--space-5);
        border-bottom: 1px solid var(--border);
      }
      .drawer-head h3 {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .drawer-head .muted {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
      }
      .btn-close {
        background: transparent;
        border: none;
        font-size: 22px;
        cursor: pointer;
        color: var(--text-tertiary);
      }
      .drawer-head-actions {
        display: flex;
        align-items: center;
        gap: var(--space-2);
      }
      .btn-chart {
        height: 28px;
        padding: 0 12px;
        border-radius: var(--radius-sm);
        background: transparent;
        border: 1px solid var(--border);
        color: var(--accent);
        font-size: 12px;
        font-weight: var(--font-semibold);
        cursor: pointer;
        font-family: inherit;
      }
      .btn-chart:hover {
        background: rgba(0, 113, 227, 0.08);
        border-color: var(--accent);
      }
      .drawer-section {
        padding: var(--space-3) var(--space-5);
        border-bottom: 1px solid var(--border);
      }
      .drawer-section h4 {
        margin: 0 0 var(--space-2);
        font-size: var(--text-xs);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-tertiary);
        font-weight: var(--font-semibold);
      }
      .drawer-grid {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: var(--space-2) var(--space-3);
        margin: 0;
      }
      .drawer-grid dt {
        font-size: 10.5px;
        color: var(--text-tertiary);
        margin: 0;
      }
      .drawer-grid dd {
        margin: 2px 0 0;
        font-size: var(--text-sm);
        color: var(--text-primary);
      }
      .drawer-grid dd.mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: var(--text-xs);
      }
      .drawer-grid dd.profit {
        color: var(--profit);
      }
      .drawer-grid dd.loss {
        color: var(--loss);
      }
      .drawer-actions {
        padding: var(--space-4) var(--space-5);
        display: flex;
        gap: var(--space-2);
      }
      .drawer-actions .btn {
        flex: 1;
        height: 36px;
        border: none;
        border-radius: var(--radius-full);
        cursor: pointer;
        font-weight: var(--font-medium);
      }
      .btn-secondary {
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }
      .btn-link {
        background: transparent;
        color: var(--accent);
        text-decoration: none;
        text-align: center;
        line-height: 36px;
      }
    `,
  ],
})
export class PositionsPageComponent implements OnInit, OnDestroy {
  private readonly positionsService = inject(PositionsService);
  private readonly marketData = inject(MarketDataService);
  protected readonly accountScope = inject(AccountScopeService);
  private readonly router = inject(Router);
  private readonly realtime = inject(RealtimeService);
  private readonly notifications = inject(NotificationService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly currencyPipe = new CurrencyFormatPipe();
  private readonly relativeTimePipe = new RelativeTimePipe();
  private pollingInterval: ReturnType<typeof setInterval> | null = null;

  /**
   * Live REAL accounts surfaced as pills above the metrics strip. Each
   * carries a short display label (`accountName` if present, else the
   * broker login id) so the pill is operator-readable without forcing
   * UI-side concatenation in the template. Paper accounts are excluded
   * to match the global scope's `__all_real__` semantics — the operator
   * who wants paper data flips the global header dropdown.
   */
  readonly accountPills = computed(() =>
    this.accountScope.liveRealAccounts().map((a) => ({
      id: a.id,
      label: a.accountName?.trim() || a.accountId || `#${a.id}`,
      accountId: a.accountId,
      brokerName: a.brokerName,
    })),
  );

  /** Sentinel exposed to the template so the "All real" pill doesn't have
   *  to repeat the magic string and stay in sync with the service. */
  readonly aggregateRealScope = AccountScopeService.SCOPE_AGGREGATE_REAL;

  /** Forward the on-page pill click into the global AccountScopeService. */
  selectAccountScope(next: number | string): void {
    this.accountScope.select(next);
  }

  /** Position id currently being closed, so we can disable the row's button mid-flight. */
  readonly closingId = signal<number | null>(null);

  /**
   * Send a manual close request to the engine for the given position.
   * Engine updates the position record AND queues an EA command for MT5
   * to flatten the trade. We use the engine-tracked `currentPrice` as the
   * close price — it's the most recent broker-side bid/ask the engine
   * has on file. Falls back to `averageEntryPrice` only if currentPrice
   * is missing (which would indicate a stale position record).
   */
  requestClose(p: PositionDto): void {
    if (!p?.id || p.status !== 'Open') return;
    if (this.closingId() !== null) return; // a close is already in flight
    const closePrice = p.currentPrice ?? p.averageEntryPrice;
    if (!Number.isFinite(closePrice) || closePrice <= 0) {
      this.notifications.error('No current price available for this position.');
      return;
    }
    const dirLabel = p.direction === 'Long' ? 'Long' : 'Short';
    const ok = window.confirm(
      `Close ${dirLabel} ${p.openLots} ${p.symbol ?? ''} @ ${Number(closePrice).toFixed(5)} ` +
        `(unrealized ${p.unrealizedPnL >= 0 ? '+' : ''}${Number(p.unrealizedPnL).toFixed(2)})?\n\n` +
        `The engine will queue an EA command to flatten this trade on MT5.`,
    );
    if (!ok) return;

    this.closingId.set(p.id);
    this.positionsService
      .close(p.id, closePrice)
      .pipe(
        catchError((err) => {
          const msg = (err?.error?.message as string | undefined) ?? err?.message ?? String(err);
          this.notifications.error(`Close failed: ${msg}`);
          this.closingId.set(null);
          return of(null);
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((res) => {
        this.closingId.set(null);
        if (res?.status) {
          this.notifications.success(`Close requested for #${p.id}. EA command queued for MT5.`);
          // Trigger an immediate refresh; the realtime channel will also push
          // when the EA acknowledges and the engine closes the position.
          this.openTable?.loadData();
        } else if (res) {
          this.notifications.error(res.message ?? 'Close refused.');
        }
      });
  }

  constructor() {
    // Refresh positions whenever the engine pushes open/close events so the
    // UI reflects broker-confirmed state without waiting on the 15s poll.
    // Throttle 2s — bursts of fills on a single position get batched.
    merge(this.realtime.on('positionOpened'), this.realtime.on('positionClosed'))
      .pipe(throttleTime(2_000, undefined, { leading: true, trailing: true }), takeUntilDestroyed())
      .subscribe(() => {
        this.openTable?.loadData();
        this.loadSummaryData();
      });

    // Re-fetch the closed table whenever the chip filter changes so the
    // visible page reflects the new bucket. Filtering itself happens
    // client-side inside fetchClosedPositions; this just kicks the reload.
    effect(() => {
      this.closedFilter();
      if (this.activeTab() === 'closed') {
        this.closedTable?.loadData();
      }
    });

    // Re-fetch both tables (and the summary) whenever the operator
    // flips the global account-scope dropdown.  Reads the signal
    // inside the effect to register the dependency.
    effect(() => {
      this.accountScope.accountIds();
      this.openTable?.loadData();
      this.closedTable?.loadData();
      this.loadSummaryData();
    });
  }

  @ViewChild('closedTable') closedTable?: DataTableComponent<PositionDto>;

  goToDetail(row: PositionDto): void {
    if (row?.id != null) this.router.navigate(['/positions', row.id]);
  }

  @ViewChild('openTable') openTable?: DataTableComponent<PositionDto>;

  // ── State ──
  readonly activeTab = signal('open');
  readonly openPositions = signal<PositionDto[]>([]);
  readonly closedPositions = signal<PositionDto[]>([]);
  readonly analyticsLoading = signal(true);

  // ── Tabs ──
  readonly tabs: TabItem[] = [
    { label: 'Open', value: 'open' },
    { label: 'Closed', value: 'closed' },
    { label: 'Analytics', value: 'analytics' },
  ];

  // ── Computed metrics ───────────────────────────────────────────────
  readonly totalUnrealizedPnL = computed(() =>
    this.openPositions().reduce((sum, p) => sum + p.unrealizedPnL, 0),
  );

  readonly openPositionCount = computed(() => this.openPositions().length);

  readonly totalLots = computed(() => this.openPositions().reduce((sum, p) => sum + p.openLots, 0));

  // % of open *lots* that are long. Useful at a glance — "70%" tells the
  // operator the book is 70% long, 30% short by exposure (not just count).
  readonly longShortRatioPct = computed(() => {
    const open = this.openPositions();
    if (open.length === 0) return null;
    const longLots = open.filter((p) => p.direction === 'Long').reduce((s, p) => s + p.openLots, 0);
    const total = this.totalLots();
    return total === 0 ? null : (longLots / total) * 100;
  });

  // Realized P&L for positions closed today (operator-local timezone).
  readonly realizedToday = computed(() => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return this.closedPositions()
      .filter((p) => p.closedAt && new Date(p.closedAt).getTime() >= start.getTime())
      .reduce((s, p) => s + p.realizedPnL, 0);
  });

  // Win rate over the closed-positions window. Null when no closed trades
  // yet so the metric card shows "—" instead of "0%" which would imply a
  // catastrophic 0% win rate rather than "no data".
  readonly winRatePct = computed(() => {
    const closed = this.closedPositions();
    if (closed.length === 0) return null;
    const wins = closed.filter((p) => p.realizedPnL > 0).length;
    return (wins / closed.length) * 100;
  });

  // Sum(wins) / Sum(|losses|). >1 means net profitable. Capped at 99 when
  // there are no losses so the card stays readable.
  readonly profitFactor = computed(() => {
    const closed = this.closedPositions();
    if (closed.length === 0) return null;
    const grossWin = closed.filter((p) => p.realizedPnL > 0).reduce((s, p) => s + p.realizedPnL, 0);
    const grossLoss = Math.abs(
      closed.filter((p) => p.realizedPnL < 0).reduce((s, p) => s + p.realizedPnL, 0),
    );
    if (grossLoss === 0) return grossWin > 0 ? 99 : null;
    return +(grossWin / grossLoss).toFixed(2);
  });

  // Mean hold duration in hours across closed positions. Useful for sanity-
  // checking strategy hold times against backtest expectations.
  readonly avgHoldHours = computed(() => {
    const closed = this.closedPositions().filter((p) => p.openedAt && p.closedAt);
    if (closed.length === 0) return null;
    const sum = closed.reduce((acc, p) => {
      const ms = new Date(p.closedAt!).getTime() - new Date(p.openedAt).getTime();
      return acc + Math.max(0, ms);
    }, 0);
    return +(sum / closed.length / 3_600_000).toFixed(1);
  });

  // ── Column definitions ────────────────────────────────────────────
  readonly openColumnDefs: ColDef<PositionDto>[] = [
    { field: 'symbol', headerName: 'Symbol', width: 90 },
    {
      field: 'direction',
      headerName: 'Dir',
      width: 80,
      cellRenderer: DirectionCellComponent,
    },
    {
      field: 'averageEntryPrice',
      headerName: 'Entry',
      width: 100,
      cellClass: 'mono',
      valueFormatter: (p: any) => (p.value != null ? Number(p.value).toFixed(5) : '—'),
    },
    {
      field: 'currentPrice',
      headerName: 'Current',
      width: 100,
      cellClass: 'mono',
      valueFormatter: (p: any) => (p.value != null ? Number(p.value).toFixed(5) : '—'),
    },
    {
      field: 'openLots',
      headerName: 'Lots',
      width: 70,
      cellClass: 'mono',
      valueFormatter: (p: any) => (p.value != null ? Number(p.value).toFixed(2) : '—'),
    },
    {
      field: 'unrealizedPnL',
      headerName: 'Unrealized',
      width: 110,
      cellRenderer: (params: any) => {
        if (params.value == null) return '-';
        const color = params.value >= 0 ? '#34C759' : '#FF3B30';
        const sign = params.value >= 0 ? '+' : '';
        return `<span style="color:${color};font-weight:600;font-family:'SF Mono',monospace;font-size:12px">${sign}${Number(params.value).toFixed(2)}</span>`;
      },
    },
    {
      headerName: 'P&L %',
      colId: 'pnlPct',
      width: 80,
      cellClass: 'mono',
      valueGetter: (p: any) => pnlPct(p.data as PositionDto),
      cellRenderer: (params: any) => {
        const v = params.value as number | null;
        if (v === null) return '<span style="color:#8E8E93">—</span>';
        const color = v >= 0 ? '#34C759' : '#FF3B30';
        const sign = v >= 0 ? '+' : '';
        return `<span style="color:${color};font-weight:600;font-family:'SF Mono',monospace;font-size:12px">${sign}${v.toFixed(2)}%</span>`;
      },
    },
    {
      headerName: 'R',
      colId: 'rMultiple',
      width: 70,
      cellClass: 'mono',
      valueGetter: (p: any) => rMultiple(p.data as PositionDto),
      cellRenderer: (params: any) => {
        const v = params.value as number | null;
        if (v === null) return '<span style="color:#8E8E93">—</span>';
        const color = v >= 0 ? '#34C759' : '#FF3B30';
        const sign = v >= 0 ? '+' : '';
        return `<span style="color:${color};font-weight:600;font-family:'SF Mono',monospace;font-size:12px">${sign}${v.toFixed(2)}R</span>`;
      },
    },
    {
      field: 'stopLoss',
      headerName: 'SL',
      width: 95,
      cellClass: 'mono',
      valueFormatter: (p: any) => (p.value != null ? Number(p.value).toFixed(5) : '—'),
    },
    {
      headerName: 'To SL',
      colId: 'pipsToSl',
      width: 75,
      cellClass: 'mono',
      valueGetter: (p: any) => pipsToSl(p.data as PositionDto),
      valueFormatter: (p: any) => (p.value !== null ? `${(p.value as number).toFixed(1)}p` : '—'),
    },
    {
      field: 'takeProfit',
      headerName: 'TP',
      width: 95,
      cellClass: 'mono',
      valueFormatter: (p: any) => (p.value != null ? Number(p.value).toFixed(5) : '—'),
    },
    {
      headerName: 'To TP',
      colId: 'pipsToTp',
      width: 75,
      cellClass: 'mono',
      valueGetter: (p: any) => pipsToTp(p.data as PositionDto),
      valueFormatter: (p: any) => (p.value !== null ? `${(p.value as number).toFixed(1)}p` : '—'),
    },
    {
      field: 'openedAt',
      headerName: 'Opened',
      width: 110,
      valueFormatter: (p: any) => this.relativeTimePipe.transform(p.value),
    },
    {
      field: 'status',
      headerName: 'Status',
      width: 95,
      cellRenderer: StatusPillCellComponent,
      cellRendererParams: { label: 'Position status' },
    },
    {
      headerName: 'Actions',
      colId: 'actions',
      width: 110,
      sortable: false,
      cellRenderer: (params: any) => {
        const pos = params.data as PositionDto | undefined;
        if (!pos || pos.status !== 'Open') return '';
        const isClosing = this.closingId() === pos.id;
        const disabled = isClosing || this.closingId() !== null;
        const bg = disabled ? 'rgba(142,142,147,0.18)' : 'rgba(255,59,48,0.14)';
        const color = disabled ? '#8E8E93' : '#D70015';
        const label = isClosing ? 'Closing…' : 'Close';
        return `<button data-action="close" ${disabled ? 'disabled' : ''} style="height:24px;padding:0 12px;border:none;border-radius:999px;font-size:11px;font-weight:600;cursor:${disabled ? 'not-allowed' : 'pointer'};background:${bg};color:${color}">${label}</button>`;
      },
      onCellClicked: (p: any) => {
        const target = p.event?.target as HTMLElement | undefined;
        const action = target?.getAttribute('data-action');
        if (action === 'close' && p.data) {
          this.requestClose(p.data as PositionDto);
        }
      },
    },
  ];

  readonly closedColumnDefs: ColDef<PositionDto>[] = [
    {
      headerName: 'W/L',
      colId: 'wl',
      width: 70,
      valueGetter: (p: any) => (p.data as PositionDto).realizedPnL,
      cellRenderer: (params: any) => {
        const v = params.value as number;
        const isWin = v > 0;
        const isFlat = v === 0;
        const bg = isWin
          ? 'rgba(52,199,89,0.12)'
          : isFlat
            ? 'rgba(142,142,147,0.12)'
            : 'rgba(255,59,48,0.12)';
        const color = isWin ? '#248A3D' : isFlat ? '#636366' : '#D70015';
        const label = isWin ? 'Win' : isFlat ? 'Flat' : 'Loss';
        return `<span style="background:${bg};color:${color};padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600">${label}</span>`;
      },
    },
    { field: 'symbol', headerName: 'Symbol', width: 90 },
    {
      field: 'direction',
      headerName: 'Dir',
      width: 80,
      cellRenderer: DirectionCellComponent,
    },
    {
      field: 'averageEntryPrice',
      headerName: 'Entry',
      width: 100,
      cellClass: 'mono',
      valueFormatter: (p: any) => (p.value != null ? Number(p.value).toFixed(5) : '—'),
    },
    {
      field: 'currentPrice',
      headerName: 'Exit',
      width: 100,
      cellClass: 'mono',
      valueFormatter: (p: any) => (p.value != null ? Number(p.value).toFixed(5) : '—'),
    },
    {
      field: 'openLots',
      headerName: 'Lots',
      width: 70,
      cellClass: 'mono',
      valueFormatter: (p: any) => (p.value != null ? Number(p.value).toFixed(2) : '—'),
    },
    {
      field: 'realizedPnL',
      headerName: 'Realized',
      width: 110,
      cellRenderer: (params: any) => {
        if (params.value == null) return '-';
        const color = params.value >= 0 ? '#34C759' : '#FF3B30';
        const sign = params.value >= 0 ? '+' : '';
        return `<span style="color:${color};font-weight:600;font-family:'SF Mono',monospace;font-size:12px">${sign}${Number(params.value).toFixed(2)}</span>`;
      },
    },
    {
      headerName: 'R',
      colId: 'rMultipleClosed',
      width: 70,
      cellClass: 'mono',
      valueGetter: (p: any) => rMultipleClosed(p.data as PositionDto),
      cellRenderer: (params: any) => {
        const v = params.value as number | null;
        if (v === null) return '<span style="color:#8E8E93">—</span>';
        const color = v >= 0 ? '#34C759' : '#FF3B30';
        const sign = v >= 0 ? '+' : '';
        return `<span style="color:${color};font-weight:600;font-family:'SF Mono',monospace;font-size:12px">${sign}${v.toFixed(2)}R</span>`;
      },
    },
    {
      headerName: 'Hold',
      colId: 'hold',
      width: 100,
      valueGetter: (params: any) => {
        const d = params.data as PositionDto;
        if (!d?.openedAt || !d?.closedAt) return '—';
        const ms = new Date(d.closedAt).getTime() - new Date(d.openedAt).getTime();
        const hours = Math.floor(ms / 3600000);
        const minutes = Math.floor((ms % 3600000) / 60000);
        if (hours > 24) {
          const days = Math.floor(hours / 24);
          return `${days}d ${hours % 24}h`;
        }
        return `${hours}h ${minutes}m`;
      },
    },
    {
      field: 'openedAt',
      headerName: 'Opened',
      width: 105,
      valueFormatter: (p: any) => this.relativeTimePipe.transform(p.value),
    },
    {
      field: 'closedAt',
      headerName: 'Closed',
      width: 105,
      valueFormatter: (p: any) => (p.value ? this.relativeTimePipe.transform(p.value) : '—'),
    },
  ];

  // ── Selection / drawer / filters ──────────────────────────────────
  readonly selectedDetail = signal<PositionDto | null>(null);
  readonly closedFilter = signal<'all' | 'wins' | 'losses' | 'today'>('all');

  readonly closedWinsCount = computed(
    () => this.closedPositions().filter((p) => p.realizedPnL > 0).length,
  );
  readonly closedLossesCount = computed(
    () => this.closedPositions().filter((p) => p.realizedPnL < 0).length,
  );
  readonly closedTodayCount = computed(() => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return this.closedPositions().filter(
      (p) => p.closedAt && new Date(p.closedAt).getTime() >= start.getTime(),
    ).length;
  });

  onRowClick(p: PositionDto): void {
    // Closed positions → open the chart modal directly so the operator sees
    // entry / SL / TP / exit visualised against the bar history (matches
    // the EA detail page behaviour). The side drawer's pricing fields are
    // strictly a subset of what the chart shows.
    // Open positions → keep the existing drawer (rich live state: trailing
    // SL, broker ticket, lifecycle, etc. — none of which the chart shows).
    if (p.status === 'Closed') {
      this.openChartFor(p);
      return;
    }
    this.selectedDetail.set(p);
  }

  // ── Click-to-chart for closed positions ────────────────────────────────
  // Mirrors the EA Positions panel's `openChart`: builds a TradeChartSelection
  // from a PositionDto, then asynchronously fetches signal→order timing so
  // the chart can show the signal-to-fill latency once it lands. Closed
  // positions surface exitPrice + exitTime; the action footer is null
  // because there's nothing destructive left to do.
  readonly chartSelection = signal<TradeChartSelection | null>(null);
  readonly chartOpen = signal(false);
  private selectedChartPositionId: number | null = null;

  openChartFor(p: PositionDto): void {
    if (!p.symbol) return;
    const isClosed = p.status === 'Closed';
    this.selectedChartPositionId = p.id;
    this.chartSelection.set({
      title: `Position #${p.id} · ${p.symbol} · ${p.direction}`,
      symbol: p.symbol,
      direction: p.direction === 'Long' ? 'Buy' : 'Sell',
      referencePrice: p.averageEntryPrice,
      referenceTime: p.openedAt,
      referenceLabel: 'ENTRY',
      stopLoss: p.stopLoss,
      takeProfit: p.takeProfit,
      // Closed: `currentPrice` carries the exit fill price (same convention
      // the drawer uses); open: `currentPrice` is the live tick.
      currentPrice: isClosed ? null : p.currentPrice,
      // Closed positions have no meaningful "now" — the trade is done. Open
      // positions get patched once the account-aware live-price fetch lands.
      currentAsk: null,
      exitPrice: isClosed ? p.currentPrice : null,
      exitTime: isClosed ? p.closedAt : null,
      action: null,
    });
    this.chartOpen.set(true);

    // Account-aware live bid/ask for open positions — draws the BID + ASK
    // pair using this broker's current spread.  Skipped for closed positions
    // (the chart is a post-mortem, not a live view).
    if (!isClosed) {
      this.marketData
        .getAccountLivePrice(p.tradingAccountId, p.symbol)
        .pipe(catchError(() => of(null)))
        .subscribe((res) => {
          if (!res?.status || !res.data) return;
          if (this.selectedChartPositionId !== p.id) return;
          const cur = this.chartSelection();
          if (!cur) return;
          const bid = res.data.bid ?? cur.currentPrice;
          const ask =
            bid !== null && res.data.perAccountSpread !== null
              ? bid + res.data.perAccountSpread
              : res.data.ask;
          this.chartSelection.set({
            ...cur,
            currentPrice: bid,
            currentAsk: ask,
          });
        });
    }

    // Patch the selection with signal→order timing once the service responds.
    // Wrapped in a try/catch via `catchError` so a timing-endpoint failure
    // (uncommon) doesn't tear down the chart — the latency badge just stays
    // hidden in that case.
    this.positionsService
      .getTiming(p.id)
      .pipe(catchError(() => of(null)))
      .subscribe((res) => {
        if (!res?.status || !res.data) return;
        if (this.selectedChartPositionId !== p.id) return; // operator moved on
        const cur = this.chartSelection();
        if (!cur) return;
        this.chartSelection.set({
          ...cur,
          signalAt: res.data.signalGeneratedAt ?? res.data.signalTriggeredAt,
          orderPlacedAt: res.data.orderPlacedAt,
        });
      });
  }

  // ── Drawer template helpers ──────────────────────────────────────
  pnlPctValue(p: PositionDto): number | null {
    return pnlPct(p);
  }
  pnlPctLabel(p: PositionDto): string {
    const v = pnlPct(p);
    if (v === null) return '—';
    const sign = v >= 0 ? '+' : '';
    return `${sign}${v.toFixed(2)}%`;
  }
  rMultipleValue(p: PositionDto): number | null {
    return p.status === 'Closed' ? rMultipleClosed(p) : rMultiple(p);
  }
  rMultipleLabel(p: PositionDto): string {
    const v = this.rMultipleValue(p);
    if (v === null) return '—';
    const sign = v >= 0 ? '+' : '';
    return `${sign}${v.toFixed(2)}R`;
  }
  pipsToSlLabel(p: PositionDto): string {
    const v = pipsToSl(p);
    return v !== null ? `${v.toFixed(1)}p` : '—';
  }
  pipsToTpLabel(p: PositionDto): string {
    const v = pipsToTp(p);
    return v !== null ? `${v.toFixed(1)}p` : '—';
  }
  formatTs(iso: string): string {
    try {
      return new Date(iso).toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return iso;
    }
  }
  holdDurationLabel(p: PositionDto): string {
    if (!p.openedAt) return '—';
    const end = p.closedAt ? new Date(p.closedAt).getTime() : Date.now();
    const ms = end - new Date(p.openedAt).getTime();
    if (ms < 0) return '—';
    if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
    if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
    if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h`;
    return `${(ms / 86_400_000).toFixed(1)}d`;
  }

  // ── Closed-tab quick stats ───────────────────────────────────────
  readonly closedTotalRealized = computed(() =>
    this.closedPositions().reduce((s, p) => s + p.realizedPnL, 0),
  );

  readonly closedAvgWin = computed(() => {
    const wins = this.closedPositions().filter((p) => p.realizedPnL > 0);
    if (wins.length === 0) return null;
    return wins.reduce((s, p) => s + p.realizedPnL, 0) / wins.length;
  });

  readonly closedAvgLoss = computed(() => {
    const losses = this.closedPositions().filter((p) => p.realizedPnL < 0);
    if (losses.length === 0) return null;
    return losses.reduce((s, p) => s + p.realizedPnL, 0) / losses.length;
  });

  readonly closedBestTrade = computed(() => {
    const positives = this.closedPositions()
      .map((p) => p.realizedPnL)
      .filter((v) => v > 0);
    return positives.length > 0 ? Math.max(...positives) : null;
  });

  readonly closedWorstTrade = computed(() => {
    const negatives = this.closedPositions()
      .map((p) => p.realizedPnL)
      .filter((v) => v < 0);
    return negatives.length > 0 ? Math.min(...negatives) : null;
  });

  // Expectancy: average P&L per trade. > 0 means the system is net profitable
  // even with a sub-50% win rate (asymmetric reward/risk).
  readonly closedExpectancy = computed(() => {
    const closed = this.closedPositions();
    if (closed.length === 0) return null;
    return closed.reduce((s, p) => s + p.realizedPnL, 0) / closed.length;
  });

  // Largest run of consecutive same-sign trades. Tells the operator whether
  // the strategy is streaky — useful for sizing decisions.
  private readonly largestStreakInfo = computed(() => {
    const closed = [...this.closedPositions()]
      .filter((p) => p.closedAt)
      .sort((a, b) => (a.closedAt ?? '').localeCompare(b.closedAt ?? ''));
    if (closed.length === 0) return { length: 0, isWins: true };
    let bestLen = 0,
      bestSign: 'win' | 'loss' = 'win',
      curLen = 0,
      curSign: 'win' | 'loss' | 'flat' = 'flat';
    for (const p of closed) {
      const sign: 'win' | 'loss' | 'flat' =
        p.realizedPnL > 0 ? 'win' : p.realizedPnL < 0 ? 'loss' : 'flat';
      if (sign === 'flat') {
        curLen = 0;
        curSign = 'flat';
        continue;
      }
      if (sign === curSign) {
        curLen++;
      } else {
        curLen = 1;
        curSign = sign;
      }
      if (curLen > bestLen) {
        bestLen = curLen;
        bestSign = curSign;
      }
    }
    return { length: bestLen, isWins: bestSign === 'win' };
  });
  readonly closedLargestStreak = computed(() => this.largestStreakInfo().length || null);
  readonly closedLargestStreakIsWins = computed(() => this.largestStreakInfo().isWins);

  // ── Analytics-tab KPIs ───────────────────────────────────────────

  readonly closedStdDev = computed(() => {
    const closed = this.closedPositions();
    if (closed.length < 2) return null;
    const mean = closed.reduce((s, p) => s + p.realizedPnL, 0) / closed.length;
    const variance =
      closed.reduce((s, p) => s + (p.realizedPnL - mean) ** 2, 0) / (closed.length - 1);
    return Math.sqrt(variance);
  });

  /**
   * Per-trade Sharpe-like ratio: mean(P&L) / stddev(P&L). Not annualized — this
   * is a unitless ratio comparing average reward to volatility of trade
   * outcomes. Useful for cross-strategy comparison; for portfolio-level
   * Sharpe, use the strategy analytics page.
   */
  readonly sharpeLikeRatio = computed(() => {
    const std = this.closedStdDev();
    if (std === null || std === 0) return null;
    const mean = this.closedExpectancy();
    return mean === null ? null : +(mean / std).toFixed(2);
  });

  /**
   * Maximum peak-to-trough drawdown of the cumulative P&L curve. Returned
   * as an absolute (positive) currency amount — biggest cumulative loss
   * from any prior high.
   */
  private readonly drawdownSeries = computed(() => {
    const closed = [...this.closedPositions()]
      .filter((p) => p.closedAt)
      .sort((a, b) => (a.closedAt ?? '').localeCompare(b.closedAt ?? ''));
    let cum = 0;
    let peak = 0;
    let maxDD = 0;
    const cumulative: number[] = [];
    const peakSeries: number[] = [];
    const drawdownSeries: number[] = [];
    const xs: string[] = [];
    for (const p of closed) {
      cum += p.realizedPnL;
      if (cum > peak) peak = cum;
      const dd = peak - cum;
      if (dd > maxDD) maxDD = dd;
      cumulative.push(+cum.toFixed(2));
      peakSeries.push(+peak.toFixed(2));
      drawdownSeries.push(+(-dd).toFixed(2));
      xs.push((p.closedAt ?? '').slice(5, 16).replace('T', ' '));
    }
    return { xs, cumulative, peakSeries, drawdownSeries, maxDD };
  });

  readonly maxDrawdownAmount = computed(() => {
    const dd = this.drawdownSeries().maxDD;
    return dd === 0 ? null : -dd;
  });

  readonly longClosedPnL = computed(() =>
    this.closedPositions()
      .filter((p) => p.direction === 'Long')
      .reduce((s, p) => s + p.realizedPnL, 0),
  );
  readonly shortClosedPnL = computed(() =>
    this.closedPositions()
      .filter((p) => p.direction === 'Short')
      .reduce((s, p) => s + p.realizedPnL, 0),
  );

  // Per-day P&L: bucket closed positions by their closedAt date, sum P&L.
  // Drives Best day / Worst day / Trading days KPIs and the day-of-week chart.
  private readonly dailyPnLs = computed(() => {
    const map = new Map<string, number>();
    for (const p of this.closedPositions()) {
      if (!p.closedAt) continue;
      const day = p.closedAt.slice(0, 10);
      map.set(day, (map.get(day) ?? 0) + p.realizedPnL);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  });

  readonly bestDayPnL = computed(() => {
    const days = this.dailyPnLs();
    if (days.length === 0) return null;
    return Math.max(...days.map(([, v]) => v));
  });

  readonly worstDayPnL = computed(() => {
    const days = this.dailyPnLs();
    if (days.length === 0) return null;
    return Math.min(...days.map(([, v]) => v));
  });

  readonly tradingDaysCount = computed(() => this.dailyPnLs().length || null);

  // ── Analytics-tab charts ─────────────────────────────────────────

  readonly equityCurveChart = computed<EChartsOption>(() => {
    const { xs, cumulative, peakSeries } = this.drawdownSeries();
    if (xs.length === 0) return this.emptyChartOption('No closed trades');
    const last = cumulative[cumulative.length - 1] ?? 0;
    const lineColor = last >= 0 ? '#34C759' : '#FF3B30';
    return {
      tooltip: { trigger: 'axis' },
      legend: { bottom: 0, textStyle: { fontSize: 10 } },
      grid: { top: 8, right: 16, bottom: 32, left: 50 },
      xAxis: {
        type: 'category',
        data: xs,
        axisLabel: { fontSize: 9, color: '#8E8E93', hideOverlap: true },
      },
      yAxis: { type: 'value', axisLabel: { fontSize: 9, color: '#8E8E93' } },
      series: [
        {
          name: 'Equity',
          type: 'line',
          smooth: true,
          symbol: 'none',
          data: cumulative,
          lineStyle: { color: lineColor, width: 2 },
          areaStyle: {
            color: {
              type: 'linear',
              x: 0,
              y: 0,
              x2: 0,
              y2: 1,
              colorStops: [
                { offset: 0, color: hexAlpha(lineColor, 0.25) },
                { offset: 1, color: hexAlpha(lineColor, 0.0) },
              ],
            } as any,
          },
        },
        {
          name: 'High-water',
          type: 'line',
          step: 'end' as const,
          symbol: 'none',
          data: peakSeries,
          lineStyle: { color: '#8E8E93', width: 1, type: 'dashed' },
        },
      ],
    };
  });

  readonly drawdownChart = computed<EChartsOption>(() => {
    const { xs, drawdownSeries: dd } = this.drawdownSeries();
    if (xs.length === 0) return this.emptyChartOption('No closed trades');
    return {
      tooltip: { trigger: 'axis' },
      grid: { top: 8, right: 12, bottom: 32, left: 44 },
      xAxis: {
        type: 'category',
        data: xs,
        axisLabel: { fontSize: 9, color: '#8E8E93', hideOverlap: true },
      },
      yAxis: { type: 'value', axisLabel: { fontSize: 9, color: '#8E8E93' } },
      series: [
        {
          type: 'line',
          smooth: true,
          symbol: 'none',
          data: dd,
          lineStyle: { color: '#FF3B30', width: 1.5 },
          areaStyle: {
            color: {
              type: 'linear',
              x: 0,
              y: 0,
              x2: 0,
              y2: 1,
              colorStops: [
                { offset: 0, color: 'rgba(255,59,48,0.05)' },
                { offset: 1, color: 'rgba(255,59,48,0.3)' },
              ],
            } as any,
          },
        },
      ],
    };
  });

  readonly netPnlBySymbolChart = computed<EChartsOption>(() => {
    const map = new Map<string, number>();
    for (const p of this.closedPositions()) {
      if (!p.symbol) continue;
      map.set(p.symbol, (map.get(p.symbol) ?? 0) + p.realizedPnL);
    }
    const sorted = Array.from(map.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
    if (sorted.length === 0) return this.emptyChartOption('No closed trades');
    return {
      tooltip: { trigger: 'axis' },
      grid: { top: 8, right: 16, bottom: 24, left: 70 },
      xAxis: { type: 'value', axisLabel: { fontSize: 9, color: '#8E8E93' } },
      yAxis: {
        type: 'category',
        data: sorted.map(([s]) => s).reverse(),
        axisLabel: { fontSize: 10, color: '#8E8E93' },
      },
      series: [
        {
          type: 'bar',
          data: sorted
            .map(([, v]) => ({
              value: +v.toFixed(2),
              itemStyle: { color: v >= 0 ? '#34C759' : '#FF3B30' },
            }))
            .reverse(),
          barMaxWidth: 18,
        },
      ],
    };
  });

  readonly longShortPerformanceChart = computed<EChartsOption>(() => {
    const closed = this.closedPositions();
    if (closed.length === 0) return this.emptyChartOption('No closed trades');
    const longTrades = closed.filter((p) => p.direction === 'Long');
    const shortTrades = closed.filter((p) => p.direction === 'Short');
    const longPnl = longTrades.reduce((s, p) => s + p.realizedPnL, 0);
    const shortPnl = shortTrades.reduce((s, p) => s + p.realizedPnL, 0);
    return {
      tooltip: { trigger: 'axis' },
      legend: { bottom: 0, textStyle: { fontSize: 10 } },
      grid: { top: 8, right: 16, bottom: 28, left: 70 },
      xAxis: { type: 'value', axisLabel: { fontSize: 9, color: '#8E8E93' } },
      yAxis: {
        type: 'category',
        data: ['Trades', 'Net P&L'],
        axisLabel: { fontSize: 10, color: '#8E8E93' },
      },
      series: [
        {
          name: 'Long',
          type: 'bar',
          stack: 'g',
          itemStyle: { color: '#34C759' },
          data: [longTrades.length, +longPnl.toFixed(2)],
          barMaxWidth: 20,
        },
        {
          name: 'Short',
          type: 'bar',
          stack: 'g',
          itemStyle: { color: '#FF3B30' },
          data: [shortTrades.length, +shortPnl.toFixed(2)],
          barMaxWidth: 20,
        },
      ],
    };
  });

  readonly pnlByDayOfWeekChart = computed<EChartsOption>(() => {
    const labels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const buckets = new Array(7).fill(0) as number[];
    const counts = new Array(7).fill(0) as number[];
    for (const p of this.closedPositions()) {
      if (!p.closedAt) continue;
      const dow = new Date(p.closedAt).getDay(); // 0=Sun..6=Sat
      const idx = (dow + 6) % 7; // shift so Mon=0
      buckets[idx] = (buckets[idx] ?? 0) + p.realizedPnL;
      counts[idx] = (counts[idx] ?? 0) + 1;
    }
    if (buckets.every((v) => v === 0) && counts.every((v) => v === 0)) {
      return this.emptyChartOption('No closed trades');
    }
    return {
      tooltip: {
        trigger: 'axis',
        formatter: (params: any) => {
          const idx = params[0]?.dataIndex ?? 0;
          return `${labels[idx]}<br/>P&L: ${(buckets[idx] ?? 0).toFixed(2)}<br/>Trades: ${counts[idx] ?? 0}`;
        },
      },
      grid: { top: 12, right: 12, bottom: 24, left: 40 },
      xAxis: { type: 'category', data: labels, axisLabel: { fontSize: 10, color: '#8E8E93' } },
      yAxis: { type: 'value', axisLabel: { fontSize: 9, color: '#8E8E93' } },
      series: [
        {
          type: 'bar',
          data: buckets.map((v) => ({
            value: +v.toFixed(2),
            itemStyle: {
              color: v >= 0 ? '#34C759' : '#FF3B30',
              borderRadius: [3, 3, 0, 0] as [number, number, number, number],
            },
          })),
          barMaxWidth: 30,
        },
      ],
    };
  });

  // ── Analytics-tab detailed per-symbol breakdown ─────────────────
  readonly analyticsPerSymbol = computed(() => {
    const map = new Map<string, { symbol: string; pnls: number[] }>();
    for (const p of this.closedPositions()) {
      if (!p.symbol) continue;
      let s = map.get(p.symbol);
      if (!s) {
        s = { symbol: p.symbol, pnls: [] };
        map.set(p.symbol, s);
      }
      s.pnls.push(p.realizedPnL);
    }
    return Array.from(map.values())
      .map((s) => {
        const wins = s.pnls.filter((v) => v > 0);
        const losses = s.pnls.filter((v) => v < 0);
        const grossWin = wins.reduce((a, b) => a + b, 0);
        const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
        const netPnL = s.pnls.reduce((a, b) => a + b, 0);
        // Per-symbol drawdown: walk the trade sequence, track peak/trough.
        let cum = 0;
        let peak = 0;
        let maxDD = 0;
        for (const v of s.pnls) {
          cum += v;
          if (cum > peak) peak = cum;
          const dd = peak - cum;
          if (dd > maxDD) maxDD = dd;
        }
        return {
          symbol: s.symbol,
          trades: s.pnls.length,
          wins: wins.length,
          losses: losses.length,
          winRatePct: s.pnls.length > 0 ? (wins.length / s.pnls.length) * 100 : 0,
          netPnL,
          avgWin: wins.length > 0 ? grossWin / wins.length : null,
          avgLoss: losses.length > 0 ? -grossLoss / losses.length : null,
          profitFactor:
            grossLoss === 0 ? (grossWin > 0 ? 99 : null) : +(grossWin / grossLoss).toFixed(2),
          expectancy: s.pnls.length > 0 ? netPnL / s.pnls.length : 0,
          maxDD: -maxDD,
        };
      })
      .sort((a, b) => b.netPnL - a.netPnL)
      .slice(0, 12);
  });

  // ── Closed-tab cumulative sparkline ──────────────────────────────
  readonly cumulativeSparklineSubtitle = computed(() => {
    const closed = [...this.closedPositions()]
      .filter((p) => p.closedAt)
      .sort((a, b) => (a.closedAt ?? '').localeCompare(b.closedAt ?? ''));
    const n = closed.length;
    if (n === 0) return 'No closed trades in window';

    // Walk the equity curve to derive headline stats — peak, max drawdown,
    // ending P&L. Cheaper to compute here once than to thread shared state
    // out of the chart computed.
    let cum = 0;
    let peak = 0;
    let maxDrawdown = 0;
    for (const p of closed) {
      cum += p.realizedPnL;
      if (cum > peak) peak = cum;
      const dd = peak - cum;
      if (dd > maxDrawdown) maxDrawdown = dd;
    }
    const sign = (v: number) => (v >= 0 ? '+' : '');
    return `${n} trades · ending ${sign(cum)}${cum.toFixed(2)} · peak ${peak.toFixed(2)} · max DD -${maxDrawdown.toFixed(2)}`;
  });

  readonly cumulativeSparklineChart = computed<EChartsOption>(() => {
    const closed = [...this.closedPositions()]
      .filter((p) => p.closedAt)
      .sort((a, b) => (a.closedAt ?? '').localeCompare(b.closedAt ?? ''));
    if (closed.length === 0) return this.emptyChartOption('No closed trades');

    // Build the cumulative series + a running high-water-mark series so
    // drawdown from peak is visible at a glance. Stepped, not smooth —
    // equity moves in discrete trade-sized jumps, and `smooth: true` on a
    // sharp drawdown produces an ugly curved overshoot that looked like
    // a rendering bug.
    let cum = 0;
    let peak = 0;
    const xLabels: string[] = [];
    const cumValues: number[] = [];
    const peakValues: number[] = [];
    const tooltipMeta: {
      idx: number;
      closedAt: string;
      symbol: string | null;
      realized: number;
    }[] = [];
    // Show each date only on the FIRST trade of that calendar day. Every
    // subsequent trade on the same day gets an empty label, which ECharts
    // simply renders as an unlabelled tick — far more readable than 194
    // overlapping "2026-06-18" stamps fighting for space. The tooltip
    // still carries the full timestamp for every individual trade.
    let lastDayLabel: string | null = null;
    closed.forEach((p, idx) => {
      cum += p.realizedPnL;
      if (cum > peak) peak = cum;
      cumValues.push(+cum.toFixed(2));
      peakValues.push(+peak.toFixed(2));
      const day = p.closedAt!.slice(0, 10);
      xLabels.push(day === lastDayLabel ? '' : day);
      lastDayLabel = day;
      tooltipMeta.push({
        idx: idx + 1,
        closedAt: p.closedAt!.replace('T', ' ').slice(0, 19),
        symbol: p.symbol,
        realized: p.realizedPnL,
      });
    });
    const last = cumValues[cumValues.length - 1] ?? 0;
    const lineColor = last >= 0 ? '#34C759' : '#FF3B30';

    const opt: EChartsOption = {
      animation: false,
      // Show cum + peak rows together in the tooltip; format the header
      // with the trade index + symbol so a single hover answers "which
      // trade was that?" without cross-referencing the table.
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'line', lineStyle: { color: '#0071e3', width: 1, type: 'dashed' } },
        formatter: (params: any) => {
          const idx = Array.isArray(params) ? params[0]?.dataIndex : params?.dataIndex;
          const meta = tooltipMeta[idx];
          if (!meta) return '';
          const sign = (v: number) => (v >= 0 ? '+' : '');
          const sym = meta.symbol ?? '—';
          return [
            `<div style="font-weight:600;margin-bottom:4px">Trade #${meta.idx} · ${sym}</div>`,
            `<div style="color:#8e8e93;font-size:11px">${meta.closedAt}</div>`,
            `<div style="margin-top:6px">Realized: <strong style="color:${meta.realized >= 0 ? '#15803d' : '#b91c1c'}">${sign(meta.realized)}${meta.realized.toFixed(2)}</strong></div>`,
            `<div>Cumulative: <strong>${sign(cumValues[idx])}${cumValues[idx].toFixed(2)}</strong></div>`,
            `<div style="color:#8e8e93">Peak: ${peakValues[idx].toFixed(2)} · DD ${(cumValues[idx] - peakValues[idx]).toFixed(2)}</div>`,
          ].join('');
        },
      },
      // `containLabel: true` tells ECharts to reserve space for the axis
      // labels INSIDE the chart bounds — without it the date labels render
      // past the configured `bottom`, spilling out of the chart-card's
      // 220px height and overlapping the filter row below. The numeric
      // padding is now treated as minimum padding; ECharts grows the
      // bottom band as needed for the dense date labels.
      grid: { top: 16, right: 24, bottom: 24, left: 12, containLabel: true },
      xAxis: {
        type: 'category',
        data: xLabels,
        boundaryGap: false,
        axisLabel: { fontSize: 10, color: '#8E8E93', hideOverlap: true },
        axisLine: { lineStyle: { color: 'rgba(0,0,0,0.08)' } },
        axisTick: { show: false },
      },
      yAxis: {
        type: 'value',
        axisLabel: {
          fontSize: 10,
          color: '#8E8E93',
          formatter: (v: number) =>
            Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(0),
        },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.05)' } },
      },
      series: [
        // Running peak — thin gray dashed reference so drawdown depth from
        // peak is immediately legible. Drawn FIRST so the equity line
        // paints over it where they coincide.
        {
          name: 'Peak',
          type: 'line',
          step: 'end',
          symbol: 'none',
          data: peakValues,
          lineStyle: { color: '#8E8E93', width: 1, type: 'dashed', opacity: 0.6 },
          z: 1,
        } as any,
        // Cumulative equity — stepped to honestly show per-trade jumps.
        {
          name: 'Cumulative',
          type: 'line',
          step: 'end',
          symbol: 'none',
          data: cumValues,
          lineStyle: { color: lineColor, width: 2 },
          areaStyle: {
            color: {
              type: 'linear',
              x: 0,
              y: 0,
              x2: 0,
              y2: 1,
              colorStops: [
                { offset: 0, color: hexAlpha(lineColor, 0.22) },
                { offset: 1, color: hexAlpha(lineColor, 0) },
              ],
            } as any,
          },
          // Zero baseline + max-drawdown marker. yAxis: 0 anchors the
          // operator's mental model regardless of the y-range; the
          // drawdown markPoint pin-points the trough on the curve.
          markLine: {
            silent: true,
            symbol: 'none',
            lineStyle: { color: '#8E8E93', width: 0.8, type: 'dashed', opacity: 0.7 },
            data: [{ yAxis: 0, label: { show: false } } as any],
          },
          markPoint: {
            symbol: 'circle',
            symbolSize: 8,
            data: [
              {
                type: 'min' as const,
                itemStyle: { color: '#FF3B30', borderColor: '#fff', borderWidth: 1.5 },
                label: { show: false },
              },
            ],
          },
          z: 2,
        } as any,
      ],
    };
    return opt;
  });

  // ── Per-symbol breakdown (closed window) ─────────────────────────
  readonly closedPerSymbol = computed(() => {
    const map = new Map<
      string,
      {
        symbol: string;
        trades: number;
        wins: number;
        losses: number;
        pnls: number[];
        holdsMs: number[];
      }
    >();
    for (const p of this.closedPositions()) {
      if (!p.symbol) continue;
      let s = map.get(p.symbol);
      if (!s) {
        s = { symbol: p.symbol, trades: 0, wins: 0, losses: 0, pnls: [], holdsMs: [] };
        map.set(p.symbol, s);
      }
      s.trades++;
      if (p.realizedPnL > 0) s.wins++;
      else if (p.realizedPnL < 0) s.losses++;
      s.pnls.push(p.realizedPnL);
      if (p.openedAt && p.closedAt) {
        const ms = new Date(p.closedAt).getTime() - new Date(p.openedAt).getTime();
        if (ms >= 0) s.holdsMs.push(ms);
      }
    }
    return Array.from(map.values())
      .map((s) => {
        const netPnL = s.pnls.reduce((a, b) => a + b, 0);
        const avgPnL = s.pnls.length > 0 ? netPnL / s.pnls.length : 0;
        const best = s.pnls.length > 0 ? Math.max(...s.pnls) : 0;
        const worst = s.pnls.length > 0 ? Math.min(...s.pnls) : 0;
        const avgHoldMs =
          s.holdsMs.length > 0 ? s.holdsMs.reduce((a, b) => a + b, 0) / s.holdsMs.length : 0;
        return {
          symbol: s.symbol,
          trades: s.trades,
          wins: s.wins,
          losses: s.losses,
          winRatePct: s.trades > 0 ? (s.wins / s.trades) * 100 : 0,
          netPnL,
          avgPnL,
          best,
          worst,
          avgHoldLabel: formatHoldMs(avgHoldMs),
        };
      })
      .sort((a, b) => b.trades - a.trades)
      .slice(0, 12);
  });

  // ── Open-tab insights charts ─────────────────────────────────────
  readonly exposureBySymbolChart = computed<EChartsOption>(() => {
    const open = this.openPositions();
    if (open.length === 0) return this.emptyChartOption('No open positions');
    const map = new Map<string, number>();
    for (const p of open) {
      if (!p.symbol) continue;
      map.set(p.symbol, (map.get(p.symbol) ?? 0) + p.openLots);
    }
    const sorted = Array.from(map.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);
    return {
      tooltip: { trigger: 'axis' },
      grid: { top: 4, right: 16, bottom: 24, left: 70 },
      xAxis: { type: 'value', minInterval: 0.01, axisLabel: { fontSize: 9, color: '#8E8E93' } },
      yAxis: {
        type: 'category',
        data: sorted.map(([s]) => s).reverse(),
        axisLabel: { fontSize: 10, color: '#8E8E93' },
      },
      series: [
        {
          type: 'bar',
          data: sorted.map(([, v]) => +v.toFixed(2)).reverse(),
          itemStyle: { color: '#0071E3', borderRadius: [0, 3, 3, 0] },
          barMaxWidth: 18,
        },
      ],
    };
  });

  readonly longShortChart = computed<EChartsOption>(() => {
    const open = this.openPositions();
    if (open.length === 0) return this.emptyChartOption('No open positions');
    let longLots = 0,
      shortLots = 0,
      longPnl = 0,
      shortPnl = 0;
    for (const p of open) {
      if (p.direction === 'Long') {
        longLots += p.openLots;
        longPnl += p.unrealizedPnL;
      } else {
        shortLots += p.openLots;
        shortPnl += p.unrealizedPnL;
      }
    }
    return {
      tooltip: { trigger: 'axis' },
      legend: { bottom: 0, textStyle: { fontSize: 10 } },
      grid: { top: 4, right: 16, bottom: 28, left: 70 },
      xAxis: { type: 'value', axisLabel: { fontSize: 9, color: '#8E8E93' } },
      yAxis: {
        type: 'category',
        data: ['Lots', 'Unrealized $'],
        axisLabel: { fontSize: 10, color: '#8E8E93' },
      },
      series: [
        {
          name: 'Long',
          type: 'bar',
          stack: 'group',
          itemStyle: { color: '#34C759' },
          data: [+longLots.toFixed(2), +longPnl.toFixed(2)],
          barMaxWidth: 18,
        },
        {
          name: 'Short',
          type: 'bar',
          stack: 'group',
          itemStyle: { color: '#FF3B30' },
          data: [+shortLots.toFixed(2), +shortPnl.toFixed(2)],
          barMaxWidth: 18,
        },
      ],
    };
  });

  // ── Data fetchers ────────────────────────────────────────────────
  //
  // Both list fetchers drop the global account-scope's tradingAccountIds
  // onto the request filter so PositionQueryFilter narrows server-side.
  // Decorating in one helper keeps the open / closed paths consistent
  // and makes future scope semantics (e.g. include-paper toggle) a
  // one-line change.
  private scoped(params: PagerRequest): PagerRequest {
    const scopedIds = this.accountScope.accountIds();
    if (scopedIds.length === 0) return params;
    const filter = {
      ...((params.filter as object | null) ?? {}),
      tradingAccountIds: Array.from(scopedIds),
    };
    return { ...params, filter };
  }

  readonly fetchOpenPositions = (params: PagerRequest): Observable<PagedData<PositionDto>> => {
    return this.positionsService.list(this.scoped(params)).pipe(
      map((response) => {
        const pagedData = response.data!;
        const openOnly = pagedData.data.filter(
          (p) => p.status === 'Open' || p.status === 'Closing',
        );
        this.openPositions.set(openOnly);
        return { ...pagedData, data: openOnly };
      }),
    );
  };

  readonly fetchClosedPositions = (params: PagerRequest): Observable<PagedData<PositionDto>> => {
    return this.positionsService.list(this.scoped(params)).pipe(
      map((response) => {
        const pagedData = response.data!;
        const closedOnly = pagedData.data.filter((p) => p.status === 'Closed');
        this.closedPositions.set(closedOnly);
        // Apply the chip filter client-side. Server-side support would need a
        // bool/today filter on PagerRequestWithFilterType<PositionQueryFilter>.
        const f = this.closedFilter();
        let view = closedOnly;
        if (f === 'wins') view = view.filter((p) => p.realizedPnL > 0);
        else if (f === 'losses') view = view.filter((p) => p.realizedPnL < 0);
        else if (f === 'today') {
          const start = new Date();
          start.setHours(0, 0, 0, 0);
          view = view.filter(
            (p) => p.closedAt && new Date(p.closedAt).getTime() >= start.getTime(),
          );
        }
        return { ...pagedData, data: view };
      }),
    );
  };

  // ── Analytics Charts (computed from closed positions) ──

  readonly pnlDistributionChart = computed<EChartsOption>(() => {
    const positions = this.closedPositions();
    const pnls = positions.map((p) => p.realizedPnL);
    if (pnls.length === 0) return this.emptyChartOption('No data');

    const min = Math.min(...pnls);
    const max = Math.max(...pnls);
    const binCount = 12;
    const binSize = (max - min) / binCount || 1;
    const bins = Array(binCount).fill(0);
    const binLabels: string[] = [];

    for (let i = 0; i < binCount; i++) {
      const lo = min + i * binSize;
      binLabels.push(`$${lo.toFixed(0)}`);
    }

    pnls.forEach((v) => {
      let idx = Math.floor((v - min) / binSize);
      if (idx >= binCount) idx = binCount - 1;
      if (idx < 0) idx = 0;
      bins[idx]++;
    });

    const colors = binLabels.map((_, i) => {
      const midVal = min + (i + 0.5) * binSize;
      return midVal >= 0 ? '#34C759' : '#FF3B30';
    });

    return {
      tooltip: { trigger: 'axis' },
      xAxis: { type: 'category', data: binLabels, axisLabel: { fontSize: 10 } },
      yAxis: { type: 'value', name: 'Count' },
      series: [
        {
          type: 'bar',
          data: bins.map((val, i) => ({ value: val, itemStyle: { color: colors[i] } })),
          barWidth: '80%',
        },
      ],
      grid: { left: 50, right: 20, bottom: 40, top: 20 },
    };
  });

  readonly winLossBySymbolChart = computed<EChartsOption>(() => {
    const positions = this.closedPositions();
    if (positions.length === 0) return this.emptyChartOption('No data');

    const symbolMap = new Map<string, { wins: number; losses: number }>();
    positions.forEach((p) => {
      const sym = p.symbol ?? 'Unknown';
      if (!symbolMap.has(sym)) symbolMap.set(sym, { wins: 0, losses: 0 });
      const entry = symbolMap.get(sym)!;
      if (p.realizedPnL >= 0) entry.wins++;
      else entry.losses++;
    });

    const symbols = Array.from(symbolMap.keys());
    const wins = symbols.map((s) => symbolMap.get(s)!.wins);
    const losses = symbols.map((s) => -symbolMap.get(s)!.losses);

    return {
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      xAxis: { type: 'value' },
      yAxis: { type: 'category', data: symbols },
      series: [
        { name: 'Wins', type: 'bar', stack: 'total', data: wins, itemStyle: { color: '#34C759' } },
        {
          name: 'Losses',
          type: 'bar',
          stack: 'total',
          data: losses,
          itemStyle: { color: '#FF3B30' },
        },
      ],
      grid: { left: 80, right: 20, bottom: 20, top: 20 },
    };
  });

  readonly holdDurationVsPnlChart = computed<EChartsOption>(() => {
    const positions = this.closedPositions();
    if (positions.length === 0) return this.emptyChartOption('No data');

    const data = positions
      .filter((p) => p.openedAt && p.closedAt)
      .map((p) => {
        const hours = (new Date(p.closedAt!).getTime() - new Date(p.openedAt).getTime()) / 3600000;
        return [parseFloat(hours.toFixed(1)), parseFloat(p.realizedPnL.toFixed(2))];
      });

    return {
      tooltip: {
        trigger: 'item',
        formatter: (params: any) => `Duration: ${params.value[0]}h<br/>P&L: $${params.value[1]}`,
      },
      xAxis: { type: 'value', name: 'Duration (hours)', nameLocation: 'middle', nameGap: 30 },
      yAxis: { type: 'value', name: 'P&L ($)' },
      series: [
        {
          type: 'scatter',
          data,
          symbolSize: 8,
          itemStyle: {
            color: (params: any) => (params.value[1] >= 0 ? '#34C759' : '#FF3B30'),
          },
        },
      ],
      grid: { left: 60, right: 20, bottom: 50, top: 20 },
    };
  });

  readonly cumulativePnlChart = computed<EChartsOption>(() => {
    const positions = this.closedPositions();
    if (positions.length === 0) return this.emptyChartOption('No data');

    const sorted = [...positions]
      .filter((p) => p.closedAt)
      .sort((a, b) => new Date(a.closedAt!).getTime() - new Date(b.closedAt!).getTime());

    let cumulative = 0;
    const dates: string[] = [];
    const values: number[] = [];

    sorted.forEach((p) => {
      cumulative += p.realizedPnL;
      dates.push(
        new Date(p.closedAt!).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      );
      values.push(parseFloat(cumulative.toFixed(2)));
    });

    const lastVal = values[values.length - 1] ?? 0;
    const lineColor = lastVal >= 0 ? '#34C759' : '#FF3B30';

    return {
      tooltip: { trigger: 'axis' },
      xAxis: { type: 'category', data: dates, axisLabel: { fontSize: 10, rotate: 30 } },
      yAxis: { type: 'value', name: 'Cumulative P&L ($)' },
      series: [
        {
          type: 'line',
          data: values,
          smooth: true,
          lineStyle: { color: lineColor, width: 2 },
          itemStyle: { color: lineColor },
          areaStyle: {
            color: {
              type: 'linear',
              x: 0,
              y: 0,
              x2: 0,
              y2: 1,
              colorStops: [
                { offset: 0, color: lastVal >= 0 ? 'rgba(52,199,89,0.3)' : 'rgba(255,59,48,0.3)' },
                { offset: 1, color: 'rgba(0,0,0,0)' },
              ],
            } as any,
          },
        },
      ],
      grid: { left: 60, right: 20, bottom: 50, top: 20 },
    };
  });

  readonly pnlBySessionChart = computed<EChartsOption>(() => {
    const positions = this.closedPositions();
    if (positions.length === 0) return this.emptyChartOption('No data');

    const sessions = ['Asian', 'London', 'New York', 'Overlap'];
    const sessionData: Record<string, { total: number; count: number }> = {};
    sessions.forEach((s) => (sessionData[s] = { total: 0, count: 0 }));

    positions.forEach((p) => {
      const hour = new Date(p.openedAt).getUTCHours();
      let session: string;
      if (hour >= 0 && hour < 8) session = 'Asian';
      else if (hour >= 8 && hour < 13) session = 'London';
      else if (hour >= 13 && hour < 17) session = 'New York';
      else session = 'Overlap';
      sessionData[session].total += p.realizedPnL;
      sessionData[session].count++;
    });

    const totals = sessions.map((s) => parseFloat(sessionData[s].total.toFixed(2)));
    const counts = sessions.map((s) => sessionData[s].count);

    return {
      tooltip: {
        trigger: 'axis',
        formatter: (params: any) => {
          const idx = params[0]?.dataIndex ?? 0;
          return `${sessions[idx]}<br/>P&L: $${totals[idx]}<br/>Trades: ${counts[idx]}`;
        },
      },
      xAxis: { type: 'category', data: sessions },
      yAxis: { type: 'value', name: 'P&L ($)' },
      series: [
        {
          type: 'bar',
          data: totals.map((v) => ({
            value: v,
            itemStyle: { color: v >= 0 ? '#34C759' : '#FF3B30' },
          })),
          barWidth: '50%',
        },
      ],
      grid: { left: 60, right: 20, bottom: 40, top: 20 },
    };
  });

  readonly rMultipleChart = computed<EChartsOption>(() => {
    const positions = this.closedPositions();
    if (positions.length === 0) return this.emptyChartOption('No data');

    // Simulate R-multiples: P&L / risk (using SL distance as proxy for risk)
    const rValues = positions
      .filter((p) => p.stopLoss != null)
      .map((p) => {
        const risk = Math.abs(p.averageEntryPrice - p.stopLoss!) * p.openLots;
        if (risk === 0) return 0;
        return parseFloat((p.realizedPnL / risk).toFixed(2));
      });

    if (rValues.length === 0) return this.emptyChartOption('No SL data for R-calc');

    const min = Math.min(...rValues);
    const max = Math.max(...rValues);
    const binCount = 10;
    const binSize = (max - min) / binCount || 1;
    const bins = Array(binCount).fill(0);
    const labels: string[] = [];

    for (let i = 0; i < binCount; i++) {
      const lo = min + i * binSize;
      labels.push(`${lo.toFixed(1)}R`);
    }

    rValues.forEach((v) => {
      let idx = Math.floor((v - min) / binSize);
      if (idx >= binCount) idx = binCount - 1;
      if (idx < 0) idx = 0;
      bins[idx]++;
    });

    return {
      tooltip: { trigger: 'axis' },
      xAxis: { type: 'category', data: labels, axisLabel: { fontSize: 10 } },
      yAxis: { type: 'value', name: 'Count' },
      series: [
        {
          type: 'bar',
          data: bins.map((val, i) => {
            const midVal = min + (i + 0.5) * binSize;
            return { value: val, itemStyle: { color: midVal >= 0 ? '#34C759' : '#FF3B30' } };
          }),
          barWidth: '80%',
        },
      ],
      grid: { left: 50, right: 20, bottom: 40, top: 20 },
    };
  });

  // ── Lifecycle ──

  ngOnInit(): void {
    this.loadSummaryData();

    // 15s polling for live open position updates
    this.pollingInterval = setInterval(() => {
      if (this.activeTab() === 'open' && this.openTable) {
        this.openTable.loadData();
      }
      this.loadSummaryData();
    }, 15000);
  }

  ngOnDestroy(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
  }

  // ── Helpers ──

  private loadSummaryData(): void {
    // Analytics summary uses the same scoping as the live tables so
    // every figure on the page tells the same story.  The filter map
    // is the engine-side PositionQueryFilter — passing
    // tradingAccountIds restricts to the scope.
    const scopedIds = this.accountScope.accountIds();
    const filter = scopedIds.length > 0 ? { tradingAccountIds: Array.from(scopedIds) } : null;
    this.positionsService
      .list({ currentPage: 1, itemCountPerPage: 500, filter })
      .pipe(map((r) => r.data?.data ?? []))
      .subscribe((positions) => {
        const open = positions.filter((p) => p.status === 'Open' || p.status === 'Closing');
        const closed = positions.filter((p) => p.status === 'Closed');
        this.openPositions.set(open);
        this.closedPositions.set(closed);
        this.analyticsLoading.set(false);
      });
  }

  private emptyChartOption(text: string): EChartsOption {
    return {
      title: {
        text,
        left: 'center',
        top: 'center',
        textStyle: { color: '#8E8E93', fontSize: 14, fontWeight: 'normal' as const },
      },
    };
  }
}

// ── Module-level pure helpers ───────────────────────────────────────
// Pulled out of the class so AG Grid valueGetters can call them without
// binding `this`.

function pipSizeFor(symbol: string | null): number {
  if (!symbol) return 0.0001;
  return symbol.toUpperCase().includes('JPY') ? 0.01 : 0.0001;
}

/**
 * P&L as a percentage of notional entry value. Uses unrealizedPnL for open
 * positions and realizedPnL for closed. Null when entry × lots is zero
 * (data corruption / missing fields).
 */
function pnlPct(p: PositionDto | null | undefined): number | null {
  if (!p || p.currentPrice === null || p.averageEntryPrice === 0) return null;
  // Return on notional, direction-aware. Mathematically equals
  // unrealizedPnL / notional, but derived from the price move so it needs no
  // contract size or FX conversion (both cancel) — staying correct for JPY and
  // cross pairs where the raw P&L isn't in the account currency.
  const move =
    p.direction === 'Long'
      ? p.currentPrice - p.averageEntryPrice
      : p.averageEntryPrice - p.currentPrice;
  return (move / p.averageEntryPrice) * 100;
}

/**
 * R-multiple for an open position: (currentPrice − entry) / (entry − stopLoss),
 * direction-aware. Null when SL is not set or risk is zero.
 */
function rMultiple(p: PositionDto | null | undefined): number | null {
  if (!p || p.stopLoss === null || p.currentPrice === null) return null;
  const risk = Math.abs(p.averageEntryPrice - p.stopLoss);
  if (risk === 0) return null;
  const moveDir =
    p.direction === 'Long'
      ? p.currentPrice - p.averageEntryPrice
      : p.averageEntryPrice - p.currentPrice;
  return moveDir / risk;
}

/**
 * R-multiple for a closed position: realizedPnL / (initial risk). Initial
 * risk = |entry − SL| × lots × pip-value approximation. We approximate
 * pip-value with `lots` since absolute pip value depends on broker contract
 * size; treating realized P&L's denominator as `risk × lots` keeps the
 * relative R-shape correct.
 */
function rMultipleClosed(p: PositionDto | null | undefined): number | null {
  if (!p || p.stopLoss === null) return null;
  const risk = Math.abs(p.averageEntryPrice - p.stopLoss) * p.openLots;
  if (risk === 0) return null;
  return p.realizedPnL / risk;
}

/**
 * Distance from the current price to the stop-loss in pips. Direction-aware:
 * positive = price has room to fall toward SL (long) or rise toward SL (short).
 * Negative would mean price has already crossed the SL — usually impossible
 * because the broker would have closed the position, but we surface it
 * honestly rather than absoluting it away.
 */
function pipsToSl(p: PositionDto | null | undefined): number | null {
  if (!p || p.stopLoss === null || p.currentPrice === null) return null;
  const pip = pipSizeFor(p.symbol);
  if (pip === 0) return null;
  const delta = p.direction === 'Long' ? p.currentPrice - p.stopLoss : p.stopLoss - p.currentPrice;
  return delta / pip;
}

function pipsToTp(p: PositionDto | null | undefined): number | null {
  if (!p || p.takeProfit === null || p.currentPrice === null) return null;
  const pip = pipSizeFor(p.symbol);
  if (pip === 0) return null;
  const delta =
    p.direction === 'Long' ? p.takeProfit - p.currentPrice : p.currentPrice - p.takeProfit;
  return delta / pip;
}

function hexAlpha(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function formatHoldMs(ms: number): string {
  if (ms <= 0) return '—';
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  return `${(ms / 86_400_000).toFixed(1)}d`;
}
