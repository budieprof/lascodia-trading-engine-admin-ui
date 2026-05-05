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
import { DatePipe } from '@angular/common';
import { map } from 'rxjs';

import { TradingAccountsService } from '@core/services/trading-accounts.service';
import { BrokersService } from '@core/services/brokers.service';
import { NotificationService } from '@core/notifications/notification.service';
import type { TradingAccountDto, BrokerDto, PagedData, PagerRequest } from '@core/api/api.types';

import { DataTableComponent } from '@shared/components/data-table/data-table.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import { CurrencyFormatPipe } from '@shared/pipes/currency-format.pipe';

@Component({
  selector: 'app-accounts-page',
  standalone: true,
  imports: [
    DataTableComponent,
    PageHeaderComponent,
    ConfirmDialogComponent,
    ChartCardComponent,
    DatePipe,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <app-page-header title="Trading Accounts" subtitle="Manage broker trading accounts">
        <button class="btn btn-primary" (click)="onAddAccount()">+ Add Account</button>
      </app-page-header>

      <!-- 8-card KPI strip — fleet roll-ups across all accounts -->
      <div class="kpi-strip">
        <div class="kpi">
          <span class="kpi-label">Accounts</span>
          <span class="kpi-value">{{ stats().total }}</span>
        </div>
        <div class="kpi">
          <span class="kpi-label">Active</span>
          <span class="kpi-value good">{{ stats().active }}</span>
        </div>
        <div class="kpi">
          <span class="kpi-label">Live</span>
          <span class="kpi-value warn">{{ stats().live }}</span>
        </div>
        <div class="kpi">
          <span class="kpi-label">Paper</span>
          <span class="kpi-value info">{{ stats().paper }}</span>
        </div>
        <div class="kpi">
          <span class="kpi-label">Total balance</span>
          <span class="kpi-value mono">
            {{ formatCurrency(stats().totalBalance, primaryCurrency()) }}
          </span>
        </div>
        <div class="kpi">
          <span class="kpi-label">Total equity</span>
          <span class="kpi-value mono">
            {{ formatCurrency(stats().totalEquity, primaryCurrency()) }}
          </span>
        </div>
        <div class="kpi">
          <span class="kpi-label">Margin used</span>
          <span class="kpi-value mono">
            {{ formatCurrency(stats().marginUsed, primaryCurrency()) }}
          </span>
        </div>
        <div class="kpi">
          <span class="kpi-label">Unrealized P&L</span>
          <span
            class="kpi-value mono"
            [class.good]="stats().unrealizedPnL > 0"
            [class.bad]="stats().unrealizedPnL < 0"
          >
            {{ stats().unrealizedPnL >= 0 ? '+' : ''
            }}{{ formatCurrency(stats().unrealizedPnL, primaryCurrency()) }}
          </span>
        </div>
      </div>

      <!-- 3-col charts row: balance/equity bars + environment donut + status donut -->
      <div class="charts-row">
        <app-chart-card
          title="Balance vs equity by account"
          subtitle="Top 10 by balance — equity diverges when positions are open"
          [options]="balanceEquityOptions()"
          height="280px"
        />
        <app-chart-card
          title="Environment split"
          subtitle="Live vs paper accounts in the fleet"
          [options]="envDonutOptions()"
          height="280px"
        />
        <app-chart-card
          title="Active vs inactive"
          subtitle="Activation status across accounts"
          [options]="activeDonutOptions()"
          height="280px"
        />
      </div>

      <!-- 2-col row: per-broker breakdown + per-currency breakdown -->
      <div class="breakdown-row">
        <section class="board-card">
          <header class="board-head">
            <h3>Per-broker breakdown</h3>
            <span class="muted">Aggregated by brokerId</span>
          </header>
          @if (perBrokerBreakdown().length > 0) {
            <table class="board-table">
              <thead>
                <tr>
                  <th>Broker</th>
                  <th class="num">Accounts</th>
                  <th class="num">Active</th>
                  <th class="num">Balance</th>
                  <th class="num">Equity</th>
                  <th class="num">Margin used</th>
                </tr>
              </thead>
              <tbody>
                @for (b of perBrokerBreakdown(); track b.brokerId) {
                  <tr>
                    <td class="mono">{{ b.brokerName }}</td>
                    <td class="num mono">{{ b.count }}</td>
                    <td class="num mono">{{ b.active }}</td>
                    <td class="num mono">
                      {{ formatCurrency(b.balance, primaryCurrency()) }}
                    </td>
                    <td class="num mono">
                      {{ formatCurrency(b.equity, primaryCurrency()) }}
                    </td>
                    <td class="num mono">
                      {{ formatCurrency(b.marginUsed, primaryCurrency()) }}
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          } @else {
            <p class="empty-msg">No accounts loaded yet.</p>
          }
        </section>

        <section class="board-card">
          <header class="board-head">
            <h3>Per-currency breakdown</h3>
            <span class="muted">Group by base currency</span>
          </header>
          @if (perCurrencyBreakdown().length > 0) {
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
                    <td class="mono">{{ c.currency }}</td>
                    <td class="num mono">{{ c.count }}</td>
                    <td class="num mono">{{ formatCurrency(c.balance, c.currency) }}</td>
                    <td class="num mono">{{ formatCurrency(c.equity, c.currency) }}</td>
                    <td class="num mono">
                      {{ formatCurrency(c.marginUsed, c.currency) }}
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          } @else {
            <p class="empty-msg">No accounts loaded yet.</p>
          }
        </section>
      </div>

      <!-- Account snapshot cards — quick scan of every account's health -->
      @if (allAccounts().length > 0) {
        <div class="account-grid">
          @for (a of allAccounts(); track a.id) {
            <article class="acct-card" [class.inactive]="!a.isActive">
              <header class="acct-head">
                <span class="acct-name">{{ a.accountName ?? '—' }}</span>
                <div class="acct-pills">
                  <span class="acct-pill" [class.live]="!a.isPaper">
                    {{ a.isPaper ? 'PAPER' : 'LIVE' }}
                  </span>
                  <span class="acct-pill" [class.good]="a.isActive" [class.muted]="!a.isActive">
                    {{ a.isActive ? 'Active' : 'Inactive' }}
                  </span>
                </div>
              </header>
              <div class="acct-equity mono">
                {{ formatCurrency(a.equity, a.currency ?? 'USD') }}
              </div>
              <div class="acct-rows">
                <div class="acct-row">
                  <span class="acct-row-label">Balance</span>
                  <span class="acct-row-value mono">
                    {{ formatCurrency(a.balance, a.currency ?? 'USD') }}
                  </span>
                </div>
                <div class="acct-row">
                  <span class="acct-row-label">Margin used</span>
                  <span class="acct-row-value mono">
                    {{ formatCurrency(a.marginUsed, a.currency ?? 'USD') }}
                  </span>
                </div>
                <div class="acct-row">
                  <span class="acct-row-label">Free margin</span>
                  <span class="acct-row-value mono">
                    {{ formatCurrency(a.marginAvailable, a.currency ?? 'USD') }}
                  </span>
                </div>
                <div class="acct-row">
                  <span class="acct-row-label">Margin level</span>
                  <span class="acct-row-value mono">
                    {{ marginLevelLabel(a) }}
                  </span>
                </div>
              </div>
              <footer class="acct-foot">
                <span class="acct-foot-label">Broker #{{ a.brokerId }}</span>
                <span class="acct-foot-time">
                  Synced {{ a.lastSyncedAt ? (a.lastSyncedAt | date: 'HH:mm') : '—' }}
                </span>
              </footer>
            </article>
          }
        </div>
      }

      <app-data-table [columnDefs]="columns" [fetchData]="fetchData" />

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
  styles: [
    `
      .page {
        padding: var(--space-2) 0;
      }

      .btn {
        height: 36px;
        padding: 0 var(--space-5);
        border: none;
        border-radius: var(--radius-full);
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        font-family: inherit;
        cursor: pointer;
        transition: all 0.15s ease;
        display: inline-flex;
        align-items: center;
        gap: var(--space-1);
      }
      .btn:active {
        transform: scale(0.97);
      }
      .btn-primary {
        background: var(--accent);
        color: white;
      }
      .btn-primary:hover {
        background: var(--accent-hover);
      }

      /* KPI strip */
      .kpi-strip {
        display: grid;
        grid-template-columns: repeat(8, 1fr);
        gap: var(--space-2);
        margin: var(--space-3) 0 var(--space-3);
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
      .kpi {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-3) var(--space-4);
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .kpi-label {
        font-size: 10px;
        font-weight: var(--font-semibold);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .kpi-value {
        font-size: var(--text-xl);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
        font-variant-numeric: tabular-nums;
      }
      .kpi-value.mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: var(--text-base);
      }
      .kpi-value.good {
        color: var(--profit);
      }
      .kpi-value.bad {
        color: var(--loss);
      }
      .kpi-value.warn {
        color: #c93400;
      }
      .kpi-value.info {
        color: var(--accent);
      }

      /* Charts row */
      .charts-row {
        display: grid;
        grid-template-columns: 1.4fr 1fr 1fr;
        gap: var(--space-3);
        margin-bottom: var(--space-3);
      }
      @media (max-width: 1100px) {
        .charts-row {
          grid-template-columns: 1fr;
        }
      }

      /* Breakdown row */
      .breakdown-row {
        display: grid;
        grid-template-columns: 1.4fr 1fr;
        gap: var(--space-3);
        margin-bottom: var(--space-3);
      }
      @media (max-width: 1100px) {
        .breakdown-row {
          grid-template-columns: 1fr;
        }
      }
      .board-card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: hidden;
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
      .board-table .mono,
      .acct-card .mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
      }
      .empty-msg {
        padding: var(--space-4);
        margin: 0;
        color: var(--text-tertiary);
        font-size: var(--text-xs);
      }

      /* Account snapshot grid */
      .account-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
        gap: var(--space-3);
        margin-bottom: var(--space-3);
      }
      .acct-card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-3) var(--space-4);
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
        transition: all 0.2s ease;
      }
      .acct-card:hover {
        box-shadow: var(--shadow-md);
        transform: translateY(-1px);
      }
      .acct-card.inactive {
        opacity: 0.65;
      }
      .acct-head {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: var(--space-2);
      }
      .acct-name {
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
      }
      .acct-pills {
        display: flex;
        gap: 4px;
      }
      .acct-pill {
        padding: 2px 6px;
        border-radius: 3px;
        font-size: 9px;
        font-weight: var(--font-bold);
        letter-spacing: 0.04em;
        background: rgba(0, 113, 227, 0.12);
        color: #0040dd;
      }
      .acct-pill.live {
        background: rgba(255, 149, 0, 0.14);
        color: #c93400;
      }
      .acct-pill.good {
        background: rgba(52, 199, 89, 0.14);
        color: #248a3d;
      }
      .acct-pill.muted {
        background: var(--bg-tertiary);
        color: var(--text-tertiary);
      }
      .acct-equity {
        font-size: var(--text-xl);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
        letter-spacing: var(--tracking-tight);
      }
      .acct-rows {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .acct-row {
        display: flex;
        justify-content: space-between;
        font-size: var(--text-xs);
      }
      .acct-row-label {
        color: var(--text-tertiary);
      }
      .acct-row-value {
        color: var(--text-secondary);
      }
      .acct-foot {
        display: flex;
        justify-content: space-between;
        padding-top: var(--space-2);
        border-top: 1px solid var(--border);
        font-size: 10px;
        color: var(--text-tertiary);
      }
    `,
  ],
})
export class AccountsPageComponent implements OnInit {
  private readonly accountsService = inject(TradingAccountsService);
  private readonly brokersService = inject(BrokersService);
  private readonly notifications = inject(NotificationService);
  private readonly currencyPipe = new CurrencyFormatPipe();
  private readonly dataTable = viewChild(DataTableComponent);

  processing = signal(false);
  showDeleteDialog = signal(false);
  selectedAccount = signal<TradingAccountDto | null>(null);

  // Fleet-wide sample for analytics roll-ups (KPI strip + charts +
  // breakdown tables + account snapshot cards). Loaded once on mount;
  // refreshed after every successful activate / sync / delete action.
  allAccounts = signal<TradingAccountDto[]>([]);
  brokerNames = signal<Record<number, string>>({});

  formatCurrency(value: number, currency: string): string {
    return this.currencyPipe.transform(value, currency || 'USD') ?? '—';
  }

  // Expose Math to template not needed — only used in component logic here.

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
    let paper = 0;
    let totalBalance = 0;
    let totalEquity = 0;
    let marginUsed = 0;
    for (const a of all) {
      if (a.isActive) active++;
      if (a.isPaper) paper++;
      else live++;
      totalBalance += a.balance ?? 0;
      totalEquity += a.equity ?? 0;
      marginUsed += a.marginUsed ?? 0;
    }
    return {
      total: all.length,
      active,
      live,
      paper,
      totalBalance,
      totalEquity,
      marginUsed,
      unrealizedPnL: totalEquity - totalBalance,
    };
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

  envDonutOptions = computed<EChartsOption>(() => {
    const s = this.stats();
    if (s.total === 0) return {};
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
            { value: s.live, name: 'Live', itemStyle: { color: '#FF9500' } },
            { value: s.paper, name: 'Paper', itemStyle: { color: '#0071E3' } },
          ].filter((d) => d.value > 0),
        },
      ],
    };
  });

  activeDonutOptions = computed<EChartsOption>(() => {
    const s = this.stats();
    if (s.total === 0) return {};
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
            { value: s.active, name: 'Active', itemStyle: { color: '#34C759' } },
            {
              value: s.total - s.active,
              name: 'Inactive',
              itemStyle: { color: '#8E8E93' },
            },
          ].filter((d) => d.value > 0),
        },
      ],
    };
  });

  perBrokerBreakdown = computed(() => {
    const groups: Record<
      number,
      { count: number; active: number; balance: number; equity: number; marginUsed: number }
    > = {};
    for (const a of this.allAccounts()) {
      const k = a.brokerId;
      if (!groups[k]) groups[k] = { count: 0, active: 0, balance: 0, equity: 0, marginUsed: 0 };
      groups[k].count++;
      if (a.isActive) groups[k].active++;
      groups[k].balance += a.balance ?? 0;
      groups[k].equity += a.equity ?? 0;
      groups[k].marginUsed += a.marginUsed ?? 0;
    }
    const names = this.brokerNames();
    return Object.entries(groups)
      .map(([id, g]) => ({
        brokerId: +id,
        brokerName: names[+id] ?? `Broker #${id}`,
        ...g,
      }))
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

  columns: ColDef<TradingAccountDto>[] = [
    { headerName: 'ID', field: 'id', width: 70, sortable: true },
    { headerName: 'Name', field: 'accountName', flex: 1, minWidth: 140 },
    { headerName: 'Broker ID', field: 'brokerId', width: 90 },
    { headerName: 'Currency', field: 'currency', width: 90 },
    {
      headerName: 'Balance',
      field: 'balance',
      width: 130,
      valueFormatter: (params) =>
        this.currencyPipe.transform(params.value, params.data?.currency ?? 'USD'),
    },
    {
      headerName: 'Equity',
      field: 'equity',
      width: 130,
      valueFormatter: (params) =>
        this.currencyPipe.transform(params.value, params.data?.currency ?? 'USD'),
    },
    {
      headerName: 'Margin Used',
      field: 'marginUsed',
      width: 120,
      valueFormatter: (params) =>
        this.currencyPipe.transform(params.value, params.data?.currency ?? 'USD'),
    },
    {
      headerName: 'Free margin',
      field: 'marginAvailable',
      width: 130,
      valueFormatter: (params) =>
        this.currencyPipe.transform(params.value, params.data?.currency ?? 'USD'),
    },
    {
      headerName: 'Status',
      field: 'isActive',
      width: 100,
      cellRenderer: (params: { value: boolean }) => {
        const active = params.value;
        const bg = active ? 'rgba(52,199,89,0.12)' : 'rgba(142,142,147,0.12)';
        const color = active ? '#248A3D' : '#636366';
        const label = active ? 'Active' : 'Inactive';
        return `<span style="background:${bg};color:${color};padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600">${label}</span>`;
      },
    },
    {
      headerName: 'Environment',
      field: 'isPaper',
      width: 110,
      cellRenderer: (params: { data: TradingAccountDto }) => {
        const isPaper = params.data?.isPaper;
        const bg = isPaper ? 'rgba(0,113,227,0.12)' : 'rgba(255,149,0,0.12)';
        const color = isPaper ? '#0040DD' : '#C93400';
        const label = isPaper ? 'Paper' : 'Live';
        return `<span style="background:${bg};color:${color};padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600">${label}</span>`;
      },
    },
    {
      headerName: 'Synced',
      field: 'lastSyncedAt',
      width: 140,
      valueFormatter: (p: any) => (p.value ? new Date(p.value).toLocaleString() : '—'),
    },
    {
      headerName: 'Actions',
      field: 'id',
      width: 220,
      sortable: false,
      cellRenderer: () => {
        return `<div style="display:flex;gap:4px;align-items:center;height:100%">
          <button data-action="activate" style="height:26px;padding:0 10px;border:none;border-radius:999px;font-size:11px;font-weight:600;cursor:pointer;background:rgba(52,199,89,0.15);color:#248A3D">Activate</button>
          <button data-action="sync" style="height:26px;padding:0 10px;border:none;border-radius:999px;font-size:11px;font-weight:600;cursor:pointer;background:rgba(0,113,227,0.15);color:#0040DD">Sync</button>
          <button data-action="delete" style="height:26px;padding:0 10px;border:none;border-radius:999px;font-size:11px;font-weight:600;cursor:pointer;background:rgba(255,59,48,0.15);color:#D70015">Delete</button>
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
    this.loadBrokerNames();
  }

  private loadAnalyticsSample(): void {
    // Fetch up to 200 accounts so the analytics roll-ups work over the whole
    // fleet, not just the current page. Trading account fleets are
    // small enough that one bulk fetch is cheaper than per-page deltas.
    this.accountsService.list({ currentPage: 1, itemCountPerPage: 200, filter: null }).subscribe({
      next: (res) => {
        if (res?.data?.data) this.allAccounts.set(res.data.data);
      },
    });
  }

  private loadBrokerNames(): void {
    this.brokersService.list({ currentPage: 1, itemCountPerPage: 100, filter: null }).subscribe({
      next: (res) => {
        const map: Record<number, string> = {};
        for (const b of (res?.data?.data ?? []) as BrokerDto[]) {
          map[b.id] = b.name ?? `Broker #${b.id}`;
        }
        this.brokerNames.set(map);
      },
    });
  }

  onAddAccount(): void {
    this.notifications.info('Add Account dialog coming soon');
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
