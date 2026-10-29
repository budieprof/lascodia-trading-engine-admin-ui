import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { catchError, map, of } from 'rxjs';
import type { EChartsOption } from 'echarts';

import {
  PerformanceService,
  type AccountPerformanceOverviewDto,
} from '@core/services/performance.service';
import { StrategiesService } from '@core/services/strategies.service';
import { TradingAccountsService } from '@core/services/trading-accounts.service';
import { WorkersService } from '@core/services/workers.service';
import type { StrategyDto, TradingAccountDto, WorkerHealthDto } from '@core/api/api.types';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import {
  FeatureStateComponent,
  type FeatureRequirement,
} from '@shared/components/feedback/feature-state.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import {
  FactTilesComponent,
  type FactTile,
} from '@features/strategies/components/fact-tiles/fact-tiles.component';
import { ago, count, day, fractionPct, money } from '@features/strategies/util/figures';
import {
  accountTotals,
  extremeDays,
  growthOf100,
  meaningfulSlices,
} from '../pages/performance-page/account-performance.logic';

/**
 * Engine sentinel strategies (`SentinelStrategyRegistry.KnownNames`). Only used when the engine has not
 * answered `performance/accounts` yet — its `coverage.activeSentinelIds` is the authority.
 */
const SENTINEL_NAMES = ['LLM Spot Analysis', 'Synthetic Analyser', 'Manual Trades'];

/**
 * What the Performance page shows while no strategy has a health snapshot: why the per-strategy board is
 * empty (with the real state of what feeds it) and the account performance the engine DOES record every day
 * (`AccountPerformanceAttribution`, via `GET performance/accounts`). `view` picks the Overview or the
 * Attribution tab's content.
 */
@Component({
  selector: 'app-account-performance-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    ChartCardComponent,
    FeatureStateComponent,
    CardSkeletonComponent,
    FactTilesComponent,
  ],
  template: `
    @if (view() === 'overview') {
      <app-feature-state
        kind="waiting"
        title="Per-strategy scores: nothing to score right now"
        switchKey="StrategyHealth:Enabled"
        summary="The strategy leaderboard ranks the health snapshots StrategyHealthWorker writes every 60 s for each Active strategy with closed trades. It deliberately skips sentinel strategies (LLM Spot Analysis, Synthetic Analyser, Manual Trades): their trades belong to the analyser or to you, not to a strategy, so scoring them could auto-pause the path every live signal takes."
        [detail]="coverageDetail()"
        [requirements]="requirements()"
        [links]="[
          { label: 'Strategies', route: '/strategies' },
          { label: 'Worker health', route: '/worker-health' },
          { label: 'Paper track record', route: '/paper-trading' },
        ]"
      />
    }

    <section class="block">
      <header class="block-head">
        <div>
          <h3>
            {{ view() === 'overview' ? 'Account performance' : 'Where the P&L came from' }}
            <span class="sub"
              >last {{ days() }} days · from the daily attribution the engine records per
              account</span
            >
          </h3>
        </div>
        <div class="window" role="group" aria-label="Window">
          @for (d of windows; track d) {
            <button type="button" [class.on]="days() === d" (click)="setDays(d)">{{ d }} d</button>
          }
        </div>
      </header>

      @if (loading()) {
        <app-card-skeleton [lines]="5" />
      } @else if (overview(); as o) {
        @if (o.accounts.length === 0) {
          <p class="muted">
            No account has a daily attribution row in the last {{ days() }} days.
            PerformanceAttributionWorker writes one per account after each trading day closes.
          </p>
        } @else if (view() === 'overview') {
          <app-fact-tiles [tiles]="overviewTiles()" />
          <div class="grid2">
            <app-chart-card
              title="Growth of 100, per account"
              subtitle="Each day's return compounded — accounts of any size share one axis"
              [options]="growthChart()"
              height="300px"
            />
            <app-chart-card
              title="Daily P&amp;L across accounts"
              subtitle="Change in end-of-day equity, summed over accounts"
              [options]="dailyPnlChart()"
              height="300px"
            />
          </div>
          <div class="table-card">
            <table class="table">
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Type</th>
                  <th class="num">Equity now</th>
                  <th
                    class="num"
                    title="End equity − start equity (deposits and withdrawals included)"
                  >
                    Change
                  </th>
                  <th class="num" title="Daily returns compounded">Return</th>
                  <th class="num">Realised</th>
                  <th class="num">Costs</th>
                  <th class="num">Trades</th>
                  <th class="num">Win rate</th>
                  <th class="num" title="Rolling 30-day Sharpe on the last day">Sharpe 30d</th>
                  <th>Last day</th>
                </tr>
              </thead>
              <tbody>
                @for (a of o.accounts; track a.tradingAccountId) {
                  <tr>
                    <td>
                      <a [routerLink]="['/trading-accounts', a.tradingAccountId]">{{
                        a.accountName || '#' + a.tradingAccountId
                      }}</a>
                      <span class="muted small"> · {{ a.brokerName }} {{ a.accountLogin }}</span>
                      @if (!a.isActive) {
                        <span class="tag">inactive</span>
                      }
                      @if (a.unreportedDays) {
                        <span
                          class="tag warn"
                          title="Rows with no end-of-day equity (the account was not reporting) are left out of equity and return"
                          >{{ a.unreportedDays }} day(s) unreported</span
                        >
                      }
                    </td>
                    <td>{{ a.isPaper ? 'Paper' : a.accountType }}</td>
                    <td class="num">{{ money(a.endEquity, a.currency) }}</td>
                    <td
                      class="num"
                      [class.profit]="a.equityChange > 0"
                      [class.loss]="a.equityChange < 0"
                    >
                      {{ money(a.equityChange, a.currency, true) }}
                    </td>
                    <td
                      class="num"
                      [class.profit]="a.compoundedReturn > 0"
                      [class.loss]="a.compoundedReturn < 0"
                    >
                      {{ pct(a.compoundedReturn) }}
                    </td>
                    <td class="num">{{ money(a.realizedPnl, a.currency, true) }}</td>
                    <td class="num">{{ money(a.executionCosts, a.currency) }}</td>
                    <td class="num">{{ count(a.trades) }}</td>
                    <td class="num">{{ a.winRate === null ? '—' : pct(a.winRate, 1, false) }}</td>
                    <td class="num">{{ a.sharpeRatio30d.toFixed(2) }}</td>
                    <td>{{ day(a.lastDate) }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        } @else {
          <app-fact-tiles [tiles]="attributionTiles()" />
          <div class="grid2">
            <div class="table-card">
              <h4>By strategy</h4>
              @if (strategySlices().length) {
                <table class="table">
                  <thead>
                    <tr>
                      <th>Strategy</th>
                      <th class="num">Net P&amp;L</th>
                      <th class="num">Realised</th>
                      <th class="num">Costs</th>
                      <th class="num">Trades</th>
                      <th class="num">Wins</th>
                      <th class="num">Accounts</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (s of strategySlices(); track s.key) {
                      <tr>
                        <td>
                          @if (s.strategyId) {
                            <a [routerLink]="['/strategies', s.strategyId]">{{ s.label }}</a>
                            <span class="muted small"> #{{ s.strategyId }}</span>
                          } @else {
                            {{ s.label }}
                          }
                        </td>
                        <td class="num" [class.profit]="s.pnl > 0" [class.loss]="s.pnl < 0">
                          {{ money(s.pnl, null, true) }}
                        </td>
                        <td class="num">{{ money(s.realizedPnl, null, true) }}</td>
                        <td class="num">{{ money(s.executionCosts, null) }}</td>
                        <td class="num">{{ count(s.trades) }}</td>
                        <td class="num">{{ count(s.wins) }}</td>
                        <td class="num">{{ s.accounts }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              } @else {
                <p class="muted pad">No strategy closed a trade or paid a cost in the window.</p>
              }
            </div>
            <div class="table-card">
              <h4>By symbol</h4>
              @if (symbolSlices().length) {
                <table class="table">
                  <thead>
                    <tr>
                      <th>Symbol</th>
                      <th class="num">Net P&amp;L</th>
                      <th class="num">Costs</th>
                      <th class="num">Trades</th>
                      <th class="num">Wins</th>
                      <th class="num">Accounts</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (s of symbolSlices(); track s.key) {
                      <tr>
                        <td>{{ s.label }}</td>
                        <td class="num" [class.profit]="s.pnl > 0" [class.loss]="s.pnl < 0">
                          {{ money(s.pnl, null, true) }}
                        </td>
                        <td class="num">{{ money(s.executionCosts, null) }}</td>
                        <td class="num">{{ count(s.trades) }}</td>
                        <td class="num">{{ count(s.wins) }}</td>
                        <td class="num">{{ s.accounts }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              } @else {
                <p class="muted pad">No symbol closed a trade or paid a cost in the window.</p>
              }
            </div>
          </div>
          @if (strategySlices().length) {
            <app-chart-card
              title="Net P&amp;L by strategy"
              subtitle="Realised P&amp;L minus execution costs, summed over accounts"
              [options]="strategyChart()"
              [height]="strategyChartHeight()"
            />
          }
          <p class="muted small">
            Money is summed across accounts in each account's own currency
            {{
              totals().currency
                ? '(all ' + totals().currency + ')'
                : '(mixed currencies — read per account)'
            }}. Each day's slice is written by PerformanceAttributionWorker from the positions that
            closed that day.
          </p>
        }
      } @else {
        <!-- The engine has not answered performance/accounts (older build, or no accounts.read): show the
             accounts as they stand right now from the trading-accounts list. -->
        <p class="muted">
          Daily history is not available from this engine build yet — showing each account as it
          stands now.
        </p>
        @if (liveAccounts().length) {
          <app-fact-tiles [tiles]="liveTiles()" />
          <div class="table-card">
            <table class="table">
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Type</th>
                  <th class="num">Balance</th>
                  <th class="num">Equity</th>
                  <th class="num">Floating P&amp;L</th>
                  <th>Synced</th>
                </tr>
              </thead>
              <tbody>
                @for (a of liveAccounts(); track a.id) {
                  <tr>
                    <td>
                      <a [routerLink]="['/trading-accounts', a.id]">{{
                        a.accountName || '#' + a.id
                      }}</a>
                    </td>
                    <td>{{ a.isPaper ? 'Paper' : a.accountType }}</td>
                    <td class="num">{{ money(a.balance, a.currency) }}</td>
                    <td class="num">{{ money(a.equity, a.currency) }}</td>
                    <td class="num" [class.profit]="a.profit > 0" [class.loss]="a.profit < 0">
                      {{ money(a.profit, a.currency, true) }}
                    </td>
                    <td>{{ ago(a.lastSyncedAt) }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        } @else {
          <p class="muted">No trading account is visible to this session.</p>
        }
      }
    </section>
  `,
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
      }
      .block {
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .block-head {
        display: flex;
        justify-content: space-between;
        align-items: flex-end;
        gap: var(--space-3);
        flex-wrap: wrap;
      }
      h3 {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      h4 {
        margin: 0;
        padding: var(--space-3) var(--space-4);
        font-size: var(--text-sm);
        border-bottom: 1px solid var(--border);
      }
      .sub {
        font-weight: normal;
        color: var(--text-tertiary);
        font-size: var(--text-xs);
        margin-left: var(--space-2);
      }
      .window {
        display: inline-flex;
        border: 1px solid var(--border);
        border-radius: var(--radius-full);
        overflow: hidden;
      }
      .window button {
        border: 0;
        background: transparent;
        padding: 4px 12px;
        font-size: var(--text-xs);
        color: var(--text-secondary);
        cursor: pointer;
      }
      .window button.on {
        background: var(--accent);
        color: var(--accent-contrast, #fff);
      }
      .grid2 {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--space-3);
        align-items: start;
      }
      @media (max-width: 1100px) {
        .grid2 {
          grid-template-columns: 1fr;
        }
      }
      .table-card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow-x: auto;
      }
      .table {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-sm);
      }
      .table th,
      .table td {
        padding: 8px 12px;
        text-align: left;
        border-bottom: 1px solid var(--border);
        white-space: nowrap;
      }
      .table th {
        font-size: var(--text-xs);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-tertiary);
        background: var(--bg-tertiary);
      }
      .num {
        text-align: right !important;
        font-variant-numeric: tabular-nums;
      }
      .profit {
        color: var(--profit);
      }
      .loss {
        color: var(--loss);
      }
      .muted {
        color: var(--text-tertiary);
        font-size: var(--text-sm);
        margin: 0;
      }
      .small {
        font-size: var(--text-xs);
      }
      .pad {
        padding: var(--space-3) var(--space-4);
      }
      .tag {
        margin-left: 6px;
        padding: 1px 8px;
        border-radius: var(--radius-full);
        background: var(--bg-tertiary);
        color: var(--text-tertiary);
        font-size: var(--text-xs);
      }
      .tag.warn {
        color: var(--warning);
      }
      a {
        color: var(--accent);
        text-decoration: none;
      }
    `,
  ],
})
export class AccountPerformancePanelComponent {
  private readonly performance = inject(PerformanceService);
  private readonly strategies = inject(StrategiesService);
  private readonly accounts = inject(TradingAccountsService);
  private readonly workers = inject(WorkersService);

  readonly view = input<'overview' | 'attribution'>('overview');
  protected readonly windows = [7, 30, 90];
  protected readonly days = signal(30);
  protected readonly loading = signal(true);
  protected readonly overview = signal<AccountPerformanceOverviewDto | null>(null);
  protected readonly activeStrategies = signal<StrategyDto[] | null>(null);
  protected readonly liveAccounts = signal<TradingAccountDto[]>([]);
  protected readonly healthWorker = signal<WorkerHealthDto | null | undefined>(undefined);

  protected readonly money = money;
  protected readonly count = count;
  protected readonly day = day;
  protected readonly ago = ago;
  protected pct(v: number | null, digits = 2, signed = true): string {
    return fractionPct(v, digits, signed);
  }

  constructor() {
    this.load();
    this.strategies
      .list({ currentPage: 1, itemCountPerPage: 50, filter: { status: 'Active' } })
      .pipe(
        map((r) => r?.data?.data ?? []),
        catchError(() => of(null)),
      )
      .subscribe((rows) => this.activeStrategies.set(rows));
    this.workers
      .list()
      .pipe(catchError(() => of(null)))
      .subscribe((rows) =>
        this.healthWorker.set(
          rows ? (rows.find((w) => w.workerName === 'StrategyHealthWorker') ?? null) : null,
        ),
      );
    this.accounts
      .list({ currentPage: 1, itemCountPerPage: 100, filter: null })
      .pipe(
        map((r) => r?.data?.data ?? []),
        catchError(() => of([] as TradingAccountDto[])),
      )
      .subscribe((rows) => this.liveAccounts.set(rows.filter((a) => a.isActive)));
  }

  protected setDays(d: number): void {
    if (d === this.days()) return;
    this.days.set(d);
    this.load();
  }

  private load(): void {
    this.loading.set(true);
    this.performance
      .getAccounts(this.days())
      .pipe(
        map((r) => (r?.status && r.data ? r.data : null)),
        catchError(() => of(null)),
      )
      .subscribe((o) => {
        this.overview.set(o);
        this.loading.set(false);
      });
  }

  // ── Why the leaderboard is empty ────────────────────────────────────────
  private readonly sentinelIds = computed(() => {
    const fromEngine = this.overview()?.coverage.activeSentinelIds;
    if (fromEngine) return new Set(fromEngine);
    return new Set(
      (this.activeStrategies() ?? [])
        .filter((s) => SENTINEL_NAMES.includes(s.name ?? ''))
        .map((s) => s.id),
    );
  });

  protected readonly requirements = computed<FeatureRequirement[]>(() => {
    const w = this.healthWorker();
    const active = this.activeStrategies();
    const sentinels = this.sentinelIds();
    const scored = active ? active.filter((s) => !sentinels.has(s.id)) : null;
    const activeNames = (active ?? []).map((s) => `${s.name} (#${s.id})`).join(', ');
    const last = this.overview()?.coverage.lastSnapshotAtUtc ?? null;
    return [
      {
        label: 'StrategyHealthWorker is running',
        ok: w === undefined ? null : w === null ? null : w.status !== 'Failed' && w.isRunning,
        detail:
          w === undefined
            ? 'checking…'
            : w === null
              ? 'not reported by this engine process'
              : `last cycle ${ago(w.lastSuccessAt)}, every ${w.configuredIntervalSeconds || 60} s`,
        route: '/worker-health',
      },
      {
        label: 'An Active strategy that is not a sentinel',
        ok: scored === null ? null : scored.length > 0,
        detail:
          active === null
            ? 'could not list strategies'
            : active.length === 0
              ? 'no strategy is Active'
              : scored!.length === 0
                ? `${active.length} Active, all sentinels: ${activeNames}`
                : `${scored!.length} scored: ${scored!.map((s) => s.name).join(', ')}`,
        route: '/strategies',
        query: { status: 'Active' },
      },
      {
        label: 'Health snapshots on record',
        ok: this.overview() ? last !== null : null,
        detail: this.overview()
          ? last
            ? `newest written ${day(last)} (${ago(last)}) — for strategies since retired`
            : 'none written yet'
          : null,
      },
    ];
  });

  protected readonly coverageDetail = computed(() => {
    const active = this.activeStrategies();
    if (!active) return null;
    const sentinels = this.sentinelIds();
    if (active.length > 0 && active.every((s) => sentinels.has(s.id)))
      return 'Every Active strategy today is a sentinel, so the board stays empty until a rule or script strategy is activated and closes trades. Live trading is still measured — per account, below.';
    return null;
  });

  // ── Account figures ─────────────────────────────────────────────────────
  protected readonly totals = computed(() => accountTotals(this.overview()?.accounts ?? []));

  protected readonly overviewTiles = computed<FactTile[]>(() => {
    const t = this.totals();
    const ccy = t.currency;
    const { best, worst } = extremeDays(this.overview()?.accounts ?? []);
    return [
      {
        label: 'Accounts',
        value: count(t.accounts),
        caption: `${t.activeAccounts} active · with a daily row in the window`,
        route: '/trading-accounts',
      },
      {
        label: 'Equity now',
        value: ccy ? money(t.endEquity, ccy) : 'mixed',
        caption: ccy ? 'sum of last end-of-day equity' : 'accounts use different currencies',
      },
      {
        label: `Change, ${this.days()} d`,
        value: ccy ? money(t.equityChange, ccy, true) : '—',
        caption: `${fractionPct(t.weightedReturn)} equity-weighted return`,
        tone: t.equityChange > 0 ? 'good' : t.equityChange < 0 ? 'bad' : null,
        title: 'End equity − start equity; deposits and withdrawals are included',
      },
      {
        label: 'Realised P&L',
        value: ccy ? money(t.realizedPnl, ccy, true) : '—',
        caption: `${count(t.trades)} closed trades · win rate ${t.winRate === null ? '—' : fractionPct(t.winRate, 1, false)}`,
        tone: t.realizedPnl > 0 ? 'good' : t.realizedPnl < 0 ? 'bad' : null,
      },
      {
        label: 'Execution costs',
        value: ccy ? money(t.executionCosts, ccy) : '—',
        caption: 'commission, spread and slippage booked',
      },
      {
        label: 'Best day',
        value: best ? fractionPct(best.ret, 2) : '—',
        caption:
          best && worst
            ? `${best.account}, ${day(best.date)} · worst ${fractionPct(worst.ret, 2)} (${worst.account}, ${day(worst.date)})`
            : null,
      },
    ];
  });

  protected readonly strategySlices = computed(() =>
    meaningfulSlices(this.overview()?.strategies ?? []),
  );
  protected readonly symbolSlices = computed(() =>
    meaningfulSlices(this.overview()?.symbols ?? []),
  );

  protected readonly attributionTiles = computed<FactTile[]>(() => {
    const s = this.strategySlices();
    const net = s.reduce((a, x) => a + x.pnl, 0);
    const costs = s.reduce((a, x) => a + x.executionCosts, 0);
    const trades = s.reduce((a, x) => a + x.trades, 0);
    const top = [...s].sort((a, b) => b.pnl - a.pnl)[0];
    return [
      {
        label: 'Strategies contributing',
        value: count(s.length),
        caption: `in the last ${this.days()} days`,
      },
      {
        label: 'Net P&L attributed',
        value: money(net, this.totals().currency, true),
        tone: net > 0 ? 'good' : net < 0 ? 'bad' : null,
        caption: 'realised minus costs',
      },
      {
        label: 'Costs attributed',
        value: money(costs, this.totals().currency),
        caption: `${count(trades)} closed trades`,
      },
      {
        label: 'Symbols traded',
        value: count(this.symbolSlices().length),
        caption:
          this.symbolSlices()
            .map((x) => x.label)
            .slice(0, 4)
            .join(', ') || null,
      },
      {
        label: 'Largest contributor',
        value: top ? top.label : '—',
        caption: top ? money(top.pnl, this.totals().currency, true) : null,
        route: top?.strategyId ? `/strategies/${top.strategyId}` : null,
      },
    ];
  });

  protected readonly liveTiles = computed<FactTile[]>(() => {
    const rows = this.liveAccounts();
    const ccys = new Set(rows.map((a) => a.currency ?? 'USD'));
    const ccy = ccys.size === 1 ? [...ccys][0] : null;
    const sum = (f: (a: TradingAccountDto) => number) => rows.reduce((s, a) => s + (f(a) || 0), 0);
    return [
      { label: 'Active accounts', value: count(rows.length), route: '/trading-accounts' },
      {
        label: 'Balance',
        value: ccy
          ? money(
              sum((a) => a.balance),
              ccy,
            )
          : 'mixed',
      },
      {
        label: 'Equity',
        value: ccy
          ? money(
              sum((a) => a.equity),
              ccy,
            )
          : 'mixed',
      },
      {
        label: 'Floating P&L',
        value: ccy
          ? money(
              sum((a) => a.profit),
              ccy,
              true,
            )
          : 'mixed',
        caption: 'open positions, as last synced',
      },
    ];
  });

  // ── Charts ──────────────────────────────────────────────────────────────
  protected readonly growthChart = computed<EChartsOption>(() => {
    const accounts = this.overview()?.accounts ?? [];
    return {
      tooltip: { trigger: 'axis' },
      legend: { type: 'scroll', bottom: 0, textStyle: { fontSize: 10 } },
      grid: { left: 48, right: 16, top: 16, bottom: 48 },
      xAxis: { type: 'time' },
      yAxis: { type: 'value', scale: true, name: 'Index', nameGap: 10 },
      series: accounts.map((a) => ({
        name: a.accountName || `#${a.tradingAccountId}`,
        type: 'line',
        showSymbol: false,
        data: growthOf100(a),
      })),
    };
  });

  protected readonly dailyPnlChart = computed<EChartsOption>(() => {
    const byDate = new Map<string, number>();
    for (const a of this.overview()?.accounts ?? [])
      for (const d of a.daily)
        byDate.set(d.date, (byDate.get(d.date) ?? 0) + (d.endEquity - d.startEquity));
    const points = [...byDate.entries()].sort(([x], [y]) => x.localeCompare(y));
    return {
      tooltip: {
        trigger: 'axis',
        valueFormatter: (v) => money(Number(v), this.totals().currency, true),
      },
      grid: { left: 64, right: 16, top: 16, bottom: 32 },
      xAxis: { type: 'time' },
      yAxis: { type: 'value', name: 'P&L', nameGap: 10 },
      series: [
        {
          type: 'bar',
          barMaxWidth: 14,
          data: points.map(([d, v]) => ({
            value: [d, Math.round(v * 100) / 100],
            itemStyle: { color: v >= 0 ? '#34C759' : '#FF3B30' },
          })),
        },
      ],
    };
  });

  protected readonly strategyChartHeight = computed(
    () => `${Math.min(480, Math.max(200, 60 + this.strategySlices().length * 26))}px`,
  );

  protected readonly strategyChart = computed<EChartsOption>(() => {
    const s = [...this.strategySlices()].sort((a, b) => b.pnl - a.pnl);
    return {
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      grid: { left: 140, right: 24, top: 8, bottom: 32 },
      xAxis: { type: 'value' },
      yAxis: {
        type: 'category',
        inverse: true,
        data: s.map((x) => x.label),
        axisLabel: { fontSize: 10, width: 130, overflow: 'truncate' },
      },
      series: [
        {
          type: 'bar',
          barMaxWidth: 18,
          data: s.map((x) => ({
            value: Math.round(x.pnl * 100) / 100,
            itemStyle: { color: x.pnl >= 0 ? '#34C759' : '#FF3B30' },
          })),
        },
      ],
    };
  });
}
