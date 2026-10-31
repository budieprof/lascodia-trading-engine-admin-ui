import {
  Component,
  ChangeDetectionStrategy,
  inject,
  signal,
  computed,
  viewChild,
  OnInit,
} from '@angular/core';
import type { ColDef } from 'ag-grid-community';
import type { EChartsOption } from 'echarts';
import { DatePipe, formatDate } from '@angular/common';
import { Router } from '@angular/router';
import { map } from 'rxjs';

import { TradingAccountsService } from '@core/services/trading-accounts.service';
import { NotificationService } from '@core/notifications/notification.service';
import type { TradingAccountDto, PagedData, PagerRequest } from '@core/api/api.types';

import { DataTableComponent } from '@shared/components/data-table/data-table.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { CurrencyFormatPipe } from '@shared/pipes/currency-format.pipe';

/**
 * Where an account's money actually lives. `isPaper` alone is not enough:
 * a broker demo (`accountType === 'Demo'`) is not paper, but it is not
 * live money either, and the fleet's simulator accounts were wearing a red
 * LIVE badge because of exactly that gap.
 */
type AccountEnvironment = 'Live' | 'Demo' | 'Paper';

@Component({
  selector: 'app-accounts-page',
  standalone: true,
  imports: [
    DataTableComponent,
    PageHeaderComponent,
    ConfirmDialogComponent,
    ChartCardComponent,
    ErrorStateComponent,
    MetricCardComponent,
    DatePipe,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <!-- The primary "+ Add Account" button only toasted "coming soon". Accounts
           are created when an EA registers against a broker login, so the page
           says that instead of offering a dead primary action. -->
      <app-page-header
        title="Trading Accounts"
        subtitle="Broker trading accounts — each one registers itself when an EA attaches to its broker login; activate, sync and size them here"
      />

      @if (loadError()) {
        <app-error-state
          title="Could not load trading accounts"
          [message]="loadError()"
          (retry)="loadAnalyticsSample()"
        />
      }

      <!-- 8-tile KPI strip — fleet roll-ups across all accounts. Shared metric-card
           tiles; tile()/money() render "—" while the fleet is unavailable. -->
      <div class="kpi-strip">
        <app-metric-card
          label="Accounts"
          [displayValue]="'' + tile(stats().total)"
          dotColor="#0071E3"
          [caption]="countsCaption()"
        />
        <app-metric-card
          label="Active"
          [displayValue]="'' + tile(stats().active)"
          [dotColor]="stats().active > 0 ? '#34C759' : '#8E8E93'"
          [caption]="'of ' + stats().total + ' registered'"
        />
        <app-metric-card
          label="Live (real)"
          [displayValue]="'' + tile(stats().live)"
          [dotColor]="stats().live > 0 ? '#FF9500' : undefined"
          caption="real-money broker accounts"
        />
        <app-metric-card
          label="Demo · Paper"
          [displayValue]="tile(stats().demo) + ' · ' + tile(stats().paper)"
          caption="no real money at risk"
        />
        <!--
          Money tiles sum ACTIVE accounts only. An inactive account's balance,
          margin and floating P&L are the last snapshot before it stopped
          syncing (Raw Spread #25: Sep 6, $35k margin "in use"), so summing
          them reported +$530 unrealized on a fleet with no open position.
        -->
        <app-metric-card
          label="Total balance · active"
          [displayValue]="money(stats().totalBalance, primaryCurrency())"
          dotColor="#0071E3"
          [caption]="activeCaption()"
        />
        <app-metric-card
          label="Total equity · active"
          [displayValue]="money(stats().totalEquity, primaryCurrency())"
          dotColor="#34C759"
          [caption]="activeCaption()"
        />
        <app-metric-card
          label="Margin used · active"
          [displayValue]="money(stats().marginUsed, primaryCurrency())"
          [dotColor]="marginPct() > 50 ? '#FF3B30' : '#FF9500'"
          [caption]="marginPct().toFixed(1) + '% of active equity'"
        />
        <app-metric-card
          label="Unrealized P&L · active"
          [value]="stats().unrealizedPnL"
          [displayValue]="pnlLabel()"
          [colorByValue]="true"
          [dotColor]="stats().unrealizedPnL < 0 ? '#FF3B30' : '#34C759'"
          caption="equity − balance on open positions"
        />
      </div>

      <!-- Active accounts: full snapshot cards, richest first. -->
      @if (activeAccounts().length > 0) {
        <section class="acct-section">
          <header class="section-head">
            <h3>Active accounts</h3>
            <span class="count-chip">{{ activeAccounts().length }}</span>
            <span class="muted">synced by an attached EA — money tiles above sum these</span>
          </header>
          <div class="account-grid">
            @for (a of activeAccounts(); track a.id) {
              <article class="acct-card" [attr.data-env]="environmentOf(a)">
                <header class="acct-head">
                  <span class="acct-name" [title]="a.accountName ?? ''">{{
                    a.accountName ?? '—'
                  }}</span>
                  <div class="acct-pills">
                    <span
                      class="acct-pill"
                      [class.live]="environmentOf(a) === 'Live'"
                      [class.demo]="environmentOf(a) === 'Demo'"
                      [title]="environmentTitle(a)"
                    >
                      {{ environmentOf(a) }}
                    </span>
                  </div>
                </header>
                <div class="acct-equity">
                  <span class="acct-equity-label">Equity</span>
                  <span class="mono">{{ formatCurrency(a.equity, a.currency ?? 'USD') }}</span>
                </div>
                <dl class="acct-rows">
                  <div class="acct-row">
                    <dt>Balance</dt>
                    <dd class="mono">{{ formatCurrency(a.balance, a.currency ?? 'USD') }}</dd>
                  </div>
                  <div class="acct-row">
                    <dt>Margin used</dt>
                    <dd class="mono">{{ formatCurrency(a.marginUsed, a.currency ?? 'USD') }}</dd>
                  </div>
                  <div class="acct-row">
                    <dt>Free margin</dt>
                    <dd class="mono">
                      {{ formatCurrency(a.marginAvailable, a.currency ?? 'USD') }}
                    </dd>
                  </div>
                  <div class="acct-row">
                    <dt>Margin level</dt>
                    <dd class="mono">{{ marginLevelLabel(a) }}</dd>
                  </div>
                </dl>
                <footer class="acct-foot">
                  <span class="acct-foot-label" [title]="a.brokerName ?? ''">
                    <i class="dot on"></i>{{ a.brokerName ?? '—' }}
                  </span>
                  <span class="acct-foot-time">
                    Synced {{ a.lastSyncedAt ? (a.lastSyncedAt | date: 'MMM d, HH:mm') : '—' }}
                  </span>
                </footer>
              </article>
            }
          </div>
        </section>
      }

      <!-- Inactive accounts: one compact line each. Their figures are the last
           snapshot before syncing stopped, so they stay visible but quiet. -->
      @if (inactiveAccounts().length > 0) {
        <section class="acct-section quiet">
          <header class="section-head">
            <button
              type="button"
              class="disclosure"
              (click)="showInactive.set(!showInactive())"
              [attr.aria-expanded]="showInactive()"
            >
              <span class="chev" [class.open]="showInactive()">›</span>
              <h3>Inactive accounts</h3>
              <span class="count-chip">{{ inactiveAccounts().length }}</span>
            </button>
            <span class="muted">last snapshot before syncing stopped · not in the totals</span>
          </header>
          @if (showInactive()) {
            <div class="mini-grid">
              @for (a of inactiveAccounts(); track a.id) {
                <article class="mini-card">
                  <div class="mini-top">
                    <span class="mini-name" [title]="a.accountName ?? ''">{{
                      a.accountName ?? '—'
                    }}</span>
                    <span
                      class="acct-pill"
                      [class.live]="environmentOf(a) === 'Live'"
                      [class.demo]="environmentOf(a) === 'Demo'"
                      [title]="environmentTitle(a)"
                      >{{ environmentOf(a) }}</span
                    >
                  </div>
                  <div class="mini-bottom">
                    <span class="mono mini-eq" [class.zero]="a.equity === 0">{{
                      formatCurrency(a.equity, a.currency ?? 'USD')
                    }}</span>
                    <span class="mini-meta" [title]="a.brokerName ?? ''">
                      #{{ a.id }} · {{ a.brokerName ?? '—' }} ·
                      {{ a.lastSyncedAt ? (a.lastSyncedAt | date: 'MMM d') : '—' }}
                    </span>
                  </div>
                </article>
              }
            </div>
          }
        </section>
      }

      <!-- Charts row: balance/equity bars + the account-mix panel. The mix used
           to be two donuts with empty centres; stacked bars with counts say the
           same thing in a third of the ink. -->
      <div class="charts-row">
        <app-chart-card
          title="Balance vs equity by account"
          subtitle="Top 10 by balance — equity diverges when positions are open"
          [options]="balanceEquityOptions()"
          height="260px"
        />
        <section class="panel mix-panel">
          <header class="panel-head">
            <h3>Account mix</h3>
            <p>Activation status, and where each account's money lives</p>
          </header>
          @if (stats().total > 0) {
            <div class="mix-body">
              <div class="mix-headline">
                <span class="mix-big">{{ stats().total }}</span>
                <span class="mix-big-label">accounts</span>
              </div>
              @for (g of mixGroups(); track g.title) {
                <div class="mix-group">
                  <div class="mix-group-title">{{ g.title }}</div>
                  <div class="mix-stack" role="img" [attr.aria-label]="g.title">
                    @for (b of g.buckets; track b.name) {
                      @if (b.value > 0) {
                        <span
                          [style.width.%]="share(b.value)"
                          [style.background]="b.color"
                          [title]="b.name + ': ' + b.value"
                        ></span>
                      }
                    }
                  </div>
                  <ul class="mix-rows">
                    @for (b of g.buckets; track b.name) {
                      <li [class.dim]="b.value === 0">
                        <span class="mix-dot" [style.background]="b.color"></span>
                        <span class="mix-name">{{ b.name }}</span>
                        <span class="mix-count">{{ b.value }}</span>
                        <span class="mix-pct">{{ share(b.value).toFixed(0) }}%</span>
                      </li>
                    }
                  </ul>
                </div>
              }
            </div>
          } @else {
            <p class="panel-empty">{{ loadError() ? '—' : 'No accounts loaded yet.' }}</p>
          }
        </section>
      </div>

      <!-- 2-col row: per-broker breakdown + per-currency breakdown -->
      <div class="breakdown-row">
        <section class="board">
          <header class="section-head">
            <h3>Per-broker breakdown</h3>
            <span class="muted">Aggregated by broker name · includes inactive snapshots</span>
          </header>
          @if (perBrokerBreakdown().length > 0) {
            <div class="board-scroll">
              <table class="board-table">
                <thead>
                  <tr>
                    <th>Broker</th>
                    <th class="num">Accounts</th>
                    <th class="active-col">Active</th>
                    <th class="num">Balance</th>
                    <th class="num">Equity</th>
                    <th class="num">Margin used</th>
                  </tr>
                </thead>
                <tbody>
                  @for (b of perBrokerBreakdown(); track b.brokerName) {
                    <tr>
                      <td class="strong">{{ b.brokerName }}</td>
                      <td class="num">{{ b.count }}</td>
                      <td class="active-col">
                        <span class="active-cell">
                          <span class="track"
                            ><i [style.width.%]="b.count > 0 ? (b.active / b.count) * 100 : 0"></i
                          ></span>
                          <span class="num" [class.zero]="b.active === 0"
                            >{{ b.active }} / {{ b.count }}</span
                          >
                        </span>
                      </td>
                      <td class="num" [class.zero]="b.balance === 0">
                        {{ formatCurrency(b.balance, primaryCurrency()) }}
                      </td>
                      <td class="num" [class.zero]="b.equity === 0">
                        {{ formatCurrency(b.equity, primaryCurrency()) }}
                      </td>
                      <td class="num" [class.zero]="b.marginUsed === 0">
                        {{ formatCurrency(b.marginUsed, primaryCurrency()) }}
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          } @else {
            <p class="empty-msg">{{ loadError() ? '—' : 'No accounts loaded yet.' }}</p>
          }
        </section>

        <section class="board">
          <header class="section-head">
            <h3>Per-currency breakdown</h3>
            <span class="muted">Grouped by account currency</span>
          </header>
          @if (perCurrencyBreakdown().length > 0) {
            <div class="board-scroll">
              <table class="board-table">
                <thead>
                  <tr>
                    <th>Currency</th>
                    <th class="num">Accounts</th>
                    <th class="num">Balance</th>
                    <th class="num">Equity</th>
                    <th class="num">Margin used</th>
                  </tr>
                </thead>
                <tbody>
                  @for (c of perCurrencyBreakdown(); track c.currency) {
                    <tr>
                      <td class="strong mono">{{ c.currency }}</td>
                      <td class="num">{{ c.count }}</td>
                      <td class="num">{{ formatCurrency(c.balance, c.currency) }}</td>
                      <td class="num">{{ formatCurrency(c.equity, c.currency) }}</td>
                      <td class="num">{{ formatCurrency(c.marginUsed, c.currency) }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          } @else {
            <p class="empty-msg">{{ loadError() ? '—' : 'No accounts loaded yet.' }}</p>
          }
        </section>
      </div>

      <div class="acct-grid-table">
        <app-data-table
          [columnDefs]="columns"
          [fetchData]="fetchData"
          (rowClick)="goToDetail($event)"
        />
      </div>

      <app-confirm-dialog
        [open]="showDeleteDialog()"
        title="Delete Account"
        [message]="
          'Are you sure you want to delete account ' + (selectedAccount()?.accountName ?? '') + '?'
        "
        confirmLabel="Delete"
        confirmVariant="destructive"
        [loading]="processing()"
        (confirm)="confirmDelete()"
        (cancelled)="showDeleteDialog.set(false)"
      />
    </div>
  `,
  styleUrl: './accounts-page.component.scss',
})
export class AccountsPageComponent implements OnInit {
  private readonly accountsService = inject(TradingAccountsService);
  private readonly notifications = inject(NotificationService);
  private readonly router = inject(Router);
  private readonly currencyPipe = new CurrencyFormatPipe();

  goToDetail(account: TradingAccountDto): void {
    if (account?.id != null) this.router.navigate(['/trading-accounts', account.id]);
  }
  private readonly dataTable = viewChild(DataTableComponent);

  processing = signal(false);
  showDeleteDialog = signal(false);
  selectedAccount = signal<TradingAccountDto | null>(null);

  // Fleet-wide sample for analytics roll-ups (KPI strip + charts +
  // breakdown tables + account snapshot cards). Loaded once on mount;
  // refreshed after every successful activate / sync / delete action.
  allAccounts = signal<TradingAccountDto[]>([]);
  /** Set when the fleet fetch failed; tiles then show "—" instead of zeros. */
  loadError = signal<string | null>(null);
  /** Inactive accounts render as a collapsed compact list; the header toggles it. */
  showInactive = signal(false);

  /** Active accounts get the full snapshot cards, richest first. */
  activeAccounts = computed(() =>
    this.allAccounts()
      .filter((a) => a.isActive)
      .sort((a, b) => (b.equity ?? 0) - (a.equity ?? 0)),
  );
  inactiveAccounts = computed(() =>
    this.allAccounts()
      .filter((a) => !a.isActive)
      .sort((a, b) => (b.equity ?? 0) - (a.equity ?? 0)),
  );

  formatCurrency(value: number, currency: string): string {
    return this.currencyPipe.transform(value, currency || 'USD') ?? '—';
  }

  /** Tile value, or "—" while the fleet is unavailable (a 0 would be a lie). */
  tile(value: number): string | number {
    return this.loadError() && this.allAccounts().length === 0 ? '—' : value;
  }

  money(value: number, currency: string): string {
    return this.loadError() && this.allAccounts().length === 0
      ? '—'
      : this.formatCurrency(value, currency);
  }

  environmentOf(a: TradingAccountDto): AccountEnvironment {
    if (a.isPaper) return 'Paper';
    return a.accountType === 'Real' ? 'Live' : 'Demo';
  }

  environmentTitle(a: TradingAccountDto): string {
    switch (this.environmentOf(a)) {
      case 'Live':
        return 'Real-money broker account';
      case 'Demo':
        return `Real broker, ${a.accountType.toLowerCase()} account — no real money`;
      default:
        return 'Paper account — simulated fills inside the engine';
    }
  }

  // Most-common currency across the fleet — used as the display currency on
  // the cross-account KPI cards (sums of mixed currencies are a lie, but
  // showing them in the dominant currency is the least-bad summary).
  primaryCurrency = computed(() => {
    const counts: Record<string, number> = {};
    for (const a of this.allAccounts()) {
      const c = a.currency ?? 'USD';
      counts[c] = (counts[c] ?? 0) + 1;
    }
    let best = 'USD';
    let max = 0;
    for (const [c, n] of Object.entries(counts)) {
      if (n > max) {
        max = n;
        best = c;
      }
    }
    return best;
  });

  stats = computed(() => {
    const all = this.allAccounts();
    let active = 0;
    let live = 0;
    let demo = 0;
    let paper = 0;
    let totalBalance = 0;
    let totalEquity = 0;
    let marginUsed = 0;
    for (const a of all) {
      if (a.isActive) active++;
      switch (this.environmentOf(a)) {
        case 'Paper':
          paper++;
          break;
        case 'Demo':
          demo++;
          break;
        default:
          live++;
      }
      // Money from active accounts only — see the KPI strip comment.
      if (!a.isActive) continue;
      totalBalance += a.balance ?? 0;
      totalEquity += a.equity ?? 0;
      marginUsed += a.marginUsed ?? 0;
    }
    return {
      total: all.length,
      active,
      live,
      demo,
      paper,
      totalBalance,
      totalEquity,
      marginUsed,
      unrealizedPnL: totalEquity - totalBalance,
    };
  });

  countsCaption = computed(() => {
    const s = this.stats();
    return `${s.active} active · ${s.total - s.active} inactive`;
  });

  /** Caption on the money tiles: what the sum covers (and what it leaves out). */
  activeCaption = computed(() => {
    const s = this.stats();
    const off = s.total - s.active;
    return off > 0
      ? `${s.active} active · ${off} inactive excluded`
      : `${s.active} active accounts`;
  });

  marginPct = computed(() => {
    const s = this.stats();
    return s.totalEquity > 0 ? (s.marginUsed / s.totalEquity) * 100 : 0;
  });

  pnlLabel = computed(() => {
    if (this.loadError() && this.allAccounts().length === 0) return '—';
    const v = this.stats().unrealizedPnL;
    return (v > 0 ? '+' : '') + this.formatCurrency(v, this.primaryCurrency());
  });

  envSplit = computed(() => {
    const s = this.stats();
    const buckets = [
      { name: 'Live', value: s.live, color: '#FF9500' },
      { name: 'Demo', value: s.demo, color: '#8E8E93' },
      { name: 'Paper', value: s.paper, color: '#0071E3' },
    ];
    return { buckets, nonZero: buckets.filter((b) => b.value > 0).length };
  });

  activeSplit = computed(() => {
    const s = this.stats();
    const buckets = [
      { name: 'Active', value: s.active, color: '#34C759' },
      { name: 'Inactive', value: s.total - s.active, color: '#8E8E93' },
    ];
    return { buckets, nonZero: buckets.filter((b) => b.value > 0).length };
  });

  balanceEquityOptions = computed<EChartsOption>(() => {
    const top = [...this.allAccounts()]
      .filter((a) => (a.balance ?? 0) > 0 || (a.equity ?? 0) > 0)
      .sort((a, b) => (b.balance ?? 0) - (a.balance ?? 0))
      .slice(0, 10);
    if (top.length === 0) return {};
    return {
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      legend: { top: 0, textStyle: { fontSize: 10, color: '#6E6E73' } },
      grid: { top: 30, right: 30, bottom: 30, left: 110 },
      xAxis: {
        type: 'value',
        axisLabel: { fontSize: 10, color: '#6E6E73' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      yAxis: {
        type: 'category',
        data: top.map((a) => a.accountName ?? `#${a.id}`).reverse(),
        axisLabel: { fontSize: 10, color: '#6E6E73' },
      },
      series: [
        {
          name: 'Balance',
          type: 'bar',
          data: top.map((a) => a.balance ?? 0).reverse(),
          itemStyle: { color: '#0071E3', borderRadius: [0, 4, 4, 0] },
          barWidth: 9,
          barGap: '20%',
        },
        {
          name: 'Equity',
          type: 'bar',
          data: top.map((a) => a.equity ?? 0).reverse(),
          itemStyle: { color: '#34C759', borderRadius: [0, 4, 4, 0] },
          barWidth: 9,
        },
      ],
    };
  });

  /** The two composition splits drawn as stacked bars in the "Account mix" panel. */
  mixGroups = computed(() => [
    { title: 'Status', buckets: this.activeSplit().buckets },
    { title: 'Environment', buckets: this.envSplit().buckets },
  ]);

  /** Percentage of all accounts (0 when the fleet is empty). */
  share(value: number): number {
    const total = this.stats().total;
    return total > 0 ? (value / total) * 100 : 0;
  }

  perBrokerBreakdown = computed(() => {
    const groups: Record<
      string,
      { count: number; active: number; balance: number; equity: number; marginUsed: number }
    > = {};
    for (const a of this.allAccounts()) {
      const k = a.brokerName ?? '—';
      if (!groups[k]) groups[k] = { count: 0, active: 0, balance: 0, equity: 0, marginUsed: 0 };
      groups[k].count++;
      if (a.isActive) groups[k].active++;
      groups[k].balance += a.balance ?? 0;
      groups[k].equity += a.equity ?? 0;
      groups[k].marginUsed += a.marginUsed ?? 0;
    }
    return Object.entries(groups)
      .map(([brokerName, g]) => ({ brokerName, ...g }))
      .sort((a, b) => b.equity - a.equity);
  });

  perCurrencyBreakdown = computed(() => {
    const groups: Record<
      string,
      { count: number; balance: number; equity: number; marginUsed: number }
    > = {};
    for (const a of this.allAccounts()) {
      const k = a.currency ?? 'USD';
      if (!groups[k]) groups[k] = { count: 0, balance: 0, equity: 0, marginUsed: 0 };
      groups[k].count++;
      groups[k].balance += a.balance ?? 0;
      groups[k].equity += a.equity ?? 0;
      groups[k].marginUsed += a.marginUsed ?? 0;
    }
    return Object.entries(groups)
      .map(([currency, g]) => ({ currency, ...g }))
      .sort((a, b) => b.equity - a.equity);
  });

  marginLevelLabel(a: TradingAccountDto): string {
    if (!a.marginUsed || a.marginUsed === 0) return '∞';
    return `${((a.equity / a.marginUsed) * 100).toFixed(0)}%`;
  }

  private readonly moneyFormatter = (params: { value: number; data?: TradingAccountDto }) =>
    this.currencyPipe.transform(params.value, params.data?.currency ?? 'USD');

  // Column widths are sized to the widest real value ("$937,634.28") so money
  // never clips, and every header fits on one line at its width. The minimums
  // add up to less than the 1440px content column, so sizeColumnsToFit never
  // has to scroll the grid: broker + environment ride in the Account cell and
  // the status column carries only its pill.
  private readonly moneyCol = (w: number, extra: Partial<ColDef<TradingAccountDto>> = {}) =>
    ({
      width: w,
      minWidth: w,
      type: 'rightAligned',
      valueFormatter: this.moneyFormatter,
      // The theme makes .ag-cell a flex row, so text-align alone never moves the value.
      cellStyle: { fontVariantNumeric: 'tabular-nums', justifyContent: 'flex-end' },
      ...extra,
    }) as ColDef<TradingAccountDto>;

  columns: ColDef<TradingAccountDto>[] = [
    {
      headerName: 'ID',
      field: 'id',
      width: 56,
      minWidth: 56,
      sortable: true,
      cellStyle: { color: 'var(--text-tertiary)', fontVariantNumeric: 'tabular-nums' },
    },
    {
      headerName: 'Account',
      field: 'accountName',
      flex: 1,
      minWidth: 180,
      // Name on the first line, environment tag + broker underneath — the old
      // separate Broker column truncated "Exness Technologies Ltd" at 160px.
      cellRenderer: (p: { data?: TradingAccountDto }) => {
        const a = p.data;
        if (!a) return '';
        const env = this.environmentOf(a);
        const tone =
          env === 'Live'
            ? 'background:rgba(255,149,0,0.14);color:#C93400'
            : env === 'Paper'
              ? 'background:rgba(0,113,227,0.12);color:#0040DD'
              : 'background:rgba(142,142,147,0.14);color:#636366';
        const name = esc(a.accountName ?? '—');
        const broker = esc(a.brokerName ?? '—');
        return `<div style="display:flex;flex-direction:column;justify-content:center;height:100%;width:100%;overflow:hidden;line-height:1.3;min-width:0">
          <span title="${name}" style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${name}</span>
          <span style="display:flex;align-items:center;gap:5px;min-width:0;font-size:11px;color:var(--text-tertiary)">
            <span title="${esc(this.environmentTitle(a))}" style="${tone};flex-shrink:0;padding:0 5px;border-radius:4px;font-size:9px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;line-height:14px">${env}</span>
            <span title="${broker}" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${broker}</span>
          </span>
        </div>`;
      },
    },
    {
      headerName: 'Ccy',
      headerTooltip: 'Account currency',
      field: 'currency',
      width: 64,
      minWidth: 64,
      cellStyle: { color: 'var(--text-secondary)' },
    },
    this.moneyCol(100, { headerName: 'Balance', field: 'balance' }),
    this.moneyCol(100, { headerName: 'Equity', field: 'equity' }),
    this.moneyCol(112, { headerName: 'Margin used', field: 'marginUsed' }),
    this.moneyCol(104, { headerName: 'Free margin', field: 'marginAvailable' }),
    {
      headerName: 'Status',
      field: 'isActive',
      width: 96,
      minWidth: 96,
      cellRenderer: (params: { value: boolean }) => {
        const active = params.value;
        const bg = active ? 'rgba(52,199,89,0.12)' : 'rgba(142,142,147,0.12)';
        const color = active ? '#248A3D' : '#636366';
        const dot = active ? '#34C759' : '#AEAEB2';
        const label = active ? 'Active' : 'Inactive';
        return `<span style="display:inline-flex;align-items:center;gap:5px;background:${bg};color:${color};padding:2px 9px;border-radius:999px;font-size:11.5px;font-weight:600;line-height:18px;white-space:nowrap"><i style="width:6px;height:6px;border-radius:50%;background:${dot}"></i>${label}</span>`;
      },
    },
    {
      headerName: 'Synced',
      field: 'lastSyncedAt',
      width: 104,
      minWidth: 104,
      cellStyle: { color: 'var(--text-secondary)', fontSize: '12px' },
      // Same "MMM d, HH:mm" as the snapshot cards — one date format per page.
      valueFormatter: (p: { value: string | null }) =>
        p.value ? formatDate(p.value, 'MMM d, HH:mm', 'en-US') : '—',
    },
    {
      headerName: '',
      field: 'id',
      colId: 'actions',
      width: 176,
      minWidth: 176,
      sortable: false,
      resizable: false,
      cellStyle: { paddingLeft: '6px', paddingRight: '6px' },
      // "Activate" only makes sense on an inactive account; on active rows it
      // was a no-op button that also pushed Sync/Delete out of the cell.
      cellRenderer: (params: { data?: TradingAccountDto }) => {
        const btn = (action: string, label: string, color: string, border: string) =>
          `<button data-action="${action}" style="height:24px;padding:0 7px;border:1px solid ${border};background:transparent;border-radius:999px;font:inherit;font-size:11px;font-weight:600;cursor:pointer;color:${color}">${label}</button>`;
        const activate = params.data?.isActive
          ? ''
          : btn('activate', 'Activate', '#248A3D', 'rgba(52,199,89,0.45)');
        return `<div style="display:flex;gap:3px;align-items:center;justify-content:flex-end;height:100%">
          ${activate}
          ${btn('sync', 'Sync', '#0040DD', 'rgba(0,113,227,0.35)')}
          ${btn('delete', 'Delete', '#D70015', 'rgba(255,59,48,0.35)')}
        </div>`;
      },
      onCellClicked: (params: any) => {
        const action = (params.event?.target as HTMLElement)?.getAttribute('data-action');
        if (action === 'activate') this.activateAccount(params.data);
        if (action === 'sync') this.syncBalance(params.data);
        if (action === 'delete') this.deleteAccount(params.data);
      },
    },
  ];

  fetchData = (params: PagerRequest) => {
    return this.accountsService.list(params).pipe(
      map((response) => {
        if (response.data) {
          // Keep the analytics signal in sync if we happen to be looking at
          // page 1 — nice for cases where the list got mutated externally
          // and we never explicitly called loadAnalyticsSample().
          if ((params.currentPage ?? 1) === 1 && response.data.data) {
            // Only overwrite the analytics signal if the pager total matches
            // the rows we got back (i.e. the whole fleet fits in this page);
            // otherwise the dedicated bulk fetch is the source of truth.
            if (response.data.pager?.totalItemCount === response.data.data.length) {
              this.allAccounts.set(response.data.data);
            }
          }
          return response.data;
        }
        return {
          data: [],
          pager: {
            totalItemCount: 0,
            filter: null,
            currentPage: 1,
            itemCountPerPage: 25,
            pageNo: 0,
            pageSize: 25,
          },
        } as PagedData<TradingAccountDto>;
      }),
    );
  };

  ngOnInit(): void {
    this.loadAnalyticsSample();
  }

  loadAnalyticsSample(): void {
    // Fetch up to 200 accounts so the analytics roll-ups work over the whole
    // fleet, not just the current page. Trading account fleets are
    // small enough that one bulk fetch is cheaper than per-page deltas.
    this.loadError.set(null);
    this.accountsService.list({ currentPage: 1, itemCountPerPage: 200, filter: null }).subscribe({
      next: (res) => {
        if (res?.data?.data) this.allAccounts.set(res.data.data);
        else if (!res?.status) this.loadError.set(res?.message ?? 'Engine returned an error.');
      },
      error: (err) =>
        this.loadError.set(err?.error?.message ?? err?.message ?? 'Engine returned an error.'),
    });
  }

  activateAccount(account: TradingAccountDto): void {
    this.processing.set(true);
    this.accountsService.activate(account.id).subscribe({
      next: (res) => {
        this.processing.set(false);
        if (res.status) {
          this.notifications.success(`Account "${account.accountName}" activated`);
          this.dataTable()?.loadData();
          this.loadAnalyticsSample();
        } else {
          this.notifications.error(res.message ?? 'Failed to activate account');
        }
      },
      error: () => {
        this.processing.set(false);
        this.notifications.error('Failed to activate account');
      },
    });
  }

  syncBalance(account: TradingAccountDto): void {
    this.processing.set(true);
    this.accountsService.sync(account.id).subscribe({
      next: (res) => {
        this.processing.set(false);
        if (res.status) {
          this.notifications.success(`Balance synced for "${account.accountName}"`);
          this.dataTable()?.loadData();
          this.loadAnalyticsSample();
        } else {
          this.notifications.error(res.message ?? 'Failed to sync balance');
        }
      },
      error: () => {
        this.processing.set(false);
        this.notifications.error('Failed to sync balance');
      },
    });
  }

  deleteAccount(account: TradingAccountDto): void {
    this.selectedAccount.set(account);
    this.showDeleteDialog.set(true);
  }

  confirmDelete(): void {
    const acct = this.selectedAccount();
    if (!acct) return;
    this.processing.set(true);
    this.accountsService.delete(acct.id).subscribe({
      next: (res) => {
        this.processing.set(false);
        this.showDeleteDialog.set(false);
        if (res.status) {
          this.notifications.success(`Account "${acct.accountName}" deleted`);
          this.dataTable()?.loadData();
          this.loadAnalyticsSample();
        } else {
          this.notifications.error(res.message ?? 'Failed to delete account');
        }
      },
      error: () => {
        this.processing.set(false);
        this.notifications.error('Failed to delete account');
      },
    });
  }
}

/** AG Grid string renderers inject HTML: escape every data-derived value. */
function esc(v: string): string {
  return v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
