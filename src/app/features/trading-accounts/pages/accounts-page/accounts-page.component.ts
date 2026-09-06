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
    DatePipe,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <app-page-header title="Trading Accounts" subtitle="Manage broker trading accounts">
        <button class="btn btn-primary" (click)="onAddAccount()">+ Add Account</button>
      </app-page-header>

      @if (loadError()) {
        <app-error-state
          title="Could not load trading accounts"
          [message]="loadError()"
          (retry)="loadAnalyticsSample()"
        />
      }

      <!-- 8-card KPI strip — fleet roll-ups across all accounts -->
      <div class="kpi-strip">
        <div class="kpi">
          <span class="kpi-label">Accounts</span>
          <span class="kpi-value">{{ tile(stats().total) }}</span>
        </div>
        <div class="kpi">
          <span class="kpi-label">Active</span>
          <span class="kpi-value" [class.good]="stats().active > 0">
            {{ tile(stats().active) }}
          </span>
        </div>
        <div class="kpi">
          <span class="kpi-label">Live (real)</span>
          <span class="kpi-value" [class.warn]="stats().live > 0">{{ tile(stats().live) }}</span>
        </div>
        <div class="kpi">
          <span class="kpi-label">Demo · Paper</span>
          <span class="kpi-value">{{ tile(stats().demo) }} · {{ tile(stats().paper) }}</span>
        </div>
        <div class="kpi">
          <span class="kpi-label">Total balance</span>
          <span class="kpi-value mono">
            {{ money(stats().totalBalance, primaryCurrency()) }}
          </span>
        </div>
        <div class="kpi">
          <span class="kpi-label">Total equity</span>
          <span class="kpi-value mono">
            {{ money(stats().totalEquity, primaryCurrency()) }}
          </span>
        </div>
        <div class="kpi">
          <span class="kpi-label">Margin used</span>
          <span class="kpi-value mono">
            {{ money(stats().marginUsed, primaryCurrency()) }}
          </span>
        </div>
        <div class="kpi">
          <span class="kpi-label">Unrealized P&L</span>
          <span
            class="kpi-value mono"
            [class.good]="stats().unrealizedPnL > 0"
            [class.bad]="stats().unrealizedPnL < 0"
          >
            @if (loadError() && allAccounts().length === 0) {
              —
            } @else {
              {{ stats().unrealizedPnL > 0 ? '+' : ''
              }}{{ formatCurrency(stats().unrealizedPnL, primaryCurrency()) }}
            }
          </span>
        </div>
      </div>

      <!-- Charts row: balance/equity bars + the two composition splits.
           A split with a single non-zero bucket is a full ring that says
           nothing a sentence can't, so those render as a text summary. -->
      <div class="charts-row">
        <app-chart-card
          title="Balance vs equity by account"
          subtitle="Top 10 by balance — equity diverges when positions are open"
          [options]="balanceEquityOptions()"
          height="280px"
        />
        @if (envSplit().nonZero >= 2) {
          <app-chart-card
            title="Environment split"
            subtitle="Real-broker live, real-broker demo and paper accounts"
            [options]="envDonutOptions()"
            height="280px"
          />
        } @else {
          <section class="board-card split-card">
            <header class="board-head">
              <h3>Environment split</h3>
              <span class="muted">Real-broker live, real-broker demo and paper accounts</span>
            </header>
            <p class="split-summary">
              @for (b of envSplit().buckets; track b.name) {
                <span class="split-item" [class.dim]="b.value === 0">
                  <strong>{{ b.value }}</strong> {{ b.name }}
                </span>
              }
            </p>
          </section>
        }
        @if (activeSplit().nonZero >= 2) {
          <app-chart-card
            title="Active vs inactive"
            subtitle="Activation status across accounts"
            [options]="activeDonutOptions()"
            height="280px"
          />
        } @else {
          <section class="board-card split-card">
            <header class="board-head">
              <h3>Active vs inactive</h3>
              <span class="muted">Activation status across accounts</span>
            </header>
            <p class="split-summary">
              @for (b of activeSplit().buckets; track b.name) {
                <span class="split-item" [class.dim]="b.value === 0">
                  <strong>{{ b.value }}</strong> {{ b.name }}
                </span>
              }
            </p>
          </section>
        }
      </div>

      <!-- 2-col row: per-broker breakdown + per-currency breakdown -->
      <div class="breakdown-row">
        <section class="board-card">
          <header class="board-head">
            <h3>Per-broker breakdown</h3>
            <span class="muted">Aggregated by broker name</span>
          </header>
          @if (perBrokerBreakdown().length > 0) {
            <div class="board-scroll">
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
                  @for (b of perBrokerBreakdown(); track b.brokerName) {
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
            </div>
          } @else {
            <p class="empty-msg">{{ loadError() ? '—' : 'No accounts loaded yet.' }}</p>
          }
        </section>

        <section class="board-card">
          <header class="board-head">
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
            </div>
          } @else {
            <p class="empty-msg">{{ loadError() ? '—' : 'No accounts loaded yet.' }}</p>
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
                  <span
                    class="acct-pill"
                    [class.live]="environmentOf(a) === 'Live'"
                    [class.demo]="environmentOf(a) === 'Demo'"
                    [title]="environmentTitle(a)"
                  >
                    {{ environmentOf(a).toUpperCase() }}
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
                <span class="acct-foot-label">{{ a.brokerName ?? '—' }}</span>
                <span class="acct-foot-time">
                  Synced {{ a.lastSyncedAt ? (a.lastSyncedAt | date: 'MMM d, HH:mm') : '—' }}
                </span>
              </footer>
            </article>
          }
        </div>
      }

      <app-data-table
        [columnDefs]="columns"
        [fetchData]="fetchData"
        (rowClick)="goToDetail($event)"
      />

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
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: var(--space-2);
        margin: var(--space-3) 0 var(--space-3);
      }
      @media (max-width: 720px) {
        .kpi-strip {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
      }
      .kpi-label {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
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
        align-items: start;
      }
      .split-card {
        align-self: stretch;
      }
      .split-summary {
        margin: 0;
        padding: var(--space-5) var(--space-4);
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-2) var(--space-5);
        font-size: var(--text-sm);
        color: var(--text-secondary);
      }
      .split-item strong {
        font-size: var(--text-xl);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
        font-variant-numeric: tabular-nums;
        margin-right: 4px;
      }
      .split-item.dim {
        color: var(--text-tertiary);
      }
      .split-item.dim strong {
        color: var(--text-tertiary);
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
      /* Money columns must not wrap or clip; a narrow card scrolls instead. */
      .board-scroll {
        overflow-x: auto;
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
        white-space: nowrap;
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
      .acct-pill.demo {
        background: var(--bg-tertiary);
        color: var(--text-secondary);
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

  private donut(buckets: { name: string; value: number; color: string }[]): EChartsOption {
    if (buckets.every((b) => b.value === 0)) return {};
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
          data: buckets
            .filter((b) => b.value > 0)
            .map((b) => ({ value: b.value, name: b.name, itemStyle: { color: b.color } })),
        },
      ],
    };
  }

  envDonutOptions = computed<EChartsOption>(() => this.donut(this.envSplit().buckets));

  activeDonutOptions = computed<EChartsOption>(() => this.donut(this.activeSplit().buckets));

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
  // never clips, and every header fits on one line at its minWidth.
  columns: ColDef<TradingAccountDto>[] = [
    { headerName: 'ID', field: 'id', width: 70, minWidth: 70, sortable: true },
    { headerName: 'Name', field: 'accountName', flex: 1, minWidth: 170 },
    { headerName: 'Broker', field: 'brokerName', width: 160, minWidth: 140 },
    { headerName: 'Currency', field: 'currency', width: 100, minWidth: 100 },
    {
      headerName: 'Balance',
      field: 'balance',
      width: 140,
      minWidth: 140,
      type: 'rightAligned',
      valueFormatter: this.moneyFormatter,
    },
    {
      headerName: 'Equity',
      field: 'equity',
      width: 140,
      minWidth: 140,
      type: 'rightAligned',
      valueFormatter: this.moneyFormatter,
    },
    {
      headerName: 'Margin used',
      field: 'marginUsed',
      width: 140,
      minWidth: 140,
      type: 'rightAligned',
      valueFormatter: this.moneyFormatter,
    },
    {
      headerName: 'Free margin',
      field: 'marginAvailable',
      width: 140,
      minWidth: 140,
      type: 'rightAligned',
      valueFormatter: this.moneyFormatter,
    },
    {
      headerName: 'Status',
      field: 'isActive',
      width: 100,
      minWidth: 100,
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
      width: 130,
      minWidth: 130,
      cellRenderer: (params: { data: TradingAccountDto }) => {
        const env = params.data ? this.environmentOf(params.data) : 'Demo';
        const style =
          env === 'Paper'
            ? 'background:rgba(0,113,227,0.12);color:#0040DD'
            : env === 'Live'
              ? 'background:rgba(255,149,0,0.12);color:#C93400'
              : 'background:rgba(142,142,147,0.12);color:#636366';
        const title = params.data ? this.environmentTitle(params.data) : '';
        return `<span title="${title}" style="${style};padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600">${env}</span>`;
      },
    },
    {
      headerName: 'Synced',
      field: 'lastSyncedAt',
      width: 150,
      minWidth: 150,
      // Same "MMM d, HH:mm" as the snapshot cards — one date format per page.
      valueFormatter: (p: { value: string | null }) =>
        p.value ? formatDate(p.value, 'MMM d, HH:mm', 'en-US') : '—',
    },
    {
      headerName: 'Actions',
      field: 'id',
      width: 190,
      minWidth: 190,
      sortable: false,
      // "Activate" only makes sense on an inactive account; on active rows it
      // was a no-op button that also pushed Sync/Delete out of the cell.
      cellRenderer: (params: { data?: TradingAccountDto }) => {
        const btn = (action: string, label: string, bg: string, color: string) =>
          `<button data-action="${action}" style="height:26px;padding:0 10px;border:none;border-radius:999px;font-size:11px;font-weight:600;cursor:pointer;background:${bg};color:${color}">${label}</button>`;
        const activate = params.data?.isActive
          ? ''
          : btn('activate', 'Activate', 'rgba(52,199,89,0.15)', '#248A3D');
        return `<div style="display:flex;gap:4px;align-items:center;height:100%">
          ${activate}
          ${btn('sync', 'Sync', 'rgba(0,113,227,0.15)', '#0040DD')}
          ${btn('delete', 'Delete', 'rgba(255,59,48,0.15)', '#D70015')}
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
