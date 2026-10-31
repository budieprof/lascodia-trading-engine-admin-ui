import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { catchError, map, of } from 'rxjs';

import { BacktestsService } from '@core/services/backtests.service';
import { ConfigService } from '@core/services/config.service';
import { StrategiesService } from '@core/services/strategies.service';
import { TradingAccountsService } from '@core/services/trading-accounts.service';
import type { BacktestRunDto, StrategyDto } from '@core/api/api.types';
import {
  FeatureStateComponent,
  type FeatureRequirement,
} from '@shared/components/feedback/feature-state.component';
import { ago, count, day } from '@features/strategies/util/figures';
import { isScriptStrategy } from '../../shared/script-strategy';

/** One KPI tile: `value` already formatted; `caption` says what it means; `tone` colours the stripe. */
interface ContextTile {
  label: string;
  value: string;
  caption?: string | null;
  tone?: 'info' | 'good' | 'warn' | null;
  /** Tooltip with the exact definition of the figure. */
  title?: string | null;
  route?: string | null;
  query?: Record<string, string> | null;
}

/** Engine defaults of the PortfolioBacktest:* keys (used only when the key has no row). */
const DEFAULTS: Record<string, string> = {
  'PortfolioBacktest:Enabled': 'true',
  'PortfolioBacktest:MaxMembers': '8',
  'PortfolioBacktest:MaxActiveRuns': '3',
  'PortfolioBacktest:MaxTotalBars': '400000',
};

/**
 * Context for the Portfolio Backtests page: the feature's switch and limits, which script strategies could
 * be members, and the single-strategy backtests already on record — so an empty run list still says what a
 * portfolio backtest is, whether everything it needs is in place, and where to start.
 */
@Component({
  selector: 'app-portfolio-backtest-context',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, FeatureStateComponent],
  template: `
    <div class="kpis" role="list">
      @for (t of tiles(); track t.label) {
        <div class="kpi" role="listitem" [attr.data-tone]="t.tone ?? null" [title]="t.title ?? ''">
          <span class="kpi-label">{{ t.label }}</span>
          @if (t.route) {
            <a class="kpi-value link" [routerLink]="t.route" [queryParams]="t.query ?? undefined">{{
              t.value
            }}</a>
          } @else {
            <span class="kpi-value">{{ t.value }}</span>
          }
          @if (t.caption) {
            <span class="kpi-hint" [title]="t.caption">{{ t.caption }}</span>
          }
        </div>
      }
    </div>

    <!-- With no run yet, explain the feature. Queuing starts from the page header's "New portfolio
         backtest" button, which the detail line points at; a second button here duplicated it. -->
    @if (runCount() === 0) {
      <app-feature-state
        [kind]="enabled() === false ? 'off' : 'waiting'"
        title="No portfolio backtest has been run"
        switchKey="PortfolioBacktest:Enabled"
        summary="A portfolio backtest runs several script strategies on ONE simulated account: they share equity and margin, the live currency-exposure limits refuse entries that would over-concentrate the book, and every member steps on one bar clock. It answers what single backtests cannot — how the strategies behave together."
        [detail]="
          canQueue()
            ? 'Pick two or more script strategies with New portfolio backtest above; the run is queued and this list follows it.'
            : 'Queuing a run needs analyst access.'
        "
        [requirements]="requirements()"
        [links]="[
          { label: 'Script strategies', route: '/strategies' },
          { label: 'Single backtests', route: '/backtests' },
          {
            label: 'Portfolio limits',
            route: '/engine-config',
            query: { search: 'PortfolioBacktest' },
          },
        ]"
      />
    }

    <section class="card" aria-labelledby="pf-recent-title">
      <header class="head">
        <h2 id="pf-recent-title" class="title">Recent single-strategy backtests</h2>
        <span class="hint">the evidence each member brings — newest first</span>
        <span class="spacer"></span>
        <a routerLink="/backtests" class="all">All backtests →</a>
      </header>
      @if (recent() === null) {
        <p class="empty">Loading…</p>
      } @else if (recent()!.length === 0) {
        <p class="empty">No backtest is on record yet.</p>
      } @else {
        <div class="table-wrap">
          <table class="grid">
            <thead>
              <tr>
                <th>Run</th>
                <th>Strategy</th>
                <th>Market</th>
                <th>Status</th>
                <th class="num">Trades</th>
                <th class="num" title="Percent of the initial balance">Return</th>
                <th class="num" title="Percent of peak equity">Max DD</th>
                <th class="num">Completed</th>
              </tr>
            </thead>
            <tbody>
              @for (b of recent(); track b.id) {
                <tr>
                  <td>
                    <a [routerLink]="['/backtests', b.id]" class="run-id">#{{ b.id }}</a>
                  </td>
                  <td class="name-cell">
                    @if (b.strategyId && known(b.strategyId)) {
                      <a
                        class="name"
                        [routerLink]="['/strategies', b.strategyId]"
                        [title]="nameOf(b.strategyId)"
                        >{{ nameOf(b.strategyId) }}</a
                      >
                    } @else if (b.strategyId) {
                      <span class="name dim">#{{ b.strategyId }} (deleted)</span>
                    } @else {
                      <span class="dim">—</span>
                    }
                  </td>
                  <td class="nowrap">
                    <span class="sym">{{ b.symbol }}</span>
                    <span class="tf">{{ b.timeframe }}</span>
                  </td>
                  <td>
                    <span class="dot" [attr.data-status]="b.status">{{ b.status }}</span>
                  </td>
                  <td class="num" [class.dim]="!b.totalTrades">{{ b.totalTrades ?? '—' }}</td>
                  <td
                    class="num"
                    [class.profit]="(b.totalReturn ?? 0) > 0 && b.totalTrades !== 0"
                    [class.loss]="(b.totalReturn ?? 0) < 0 && b.totalTrades !== 0"
                    [class.dim]="
                      !hasNum(b.totalReturn) || b.totalTrades === 0 || b.totalReturn === 0
                    "
                  >
                    {{ b.totalTrades === 0 ? '—' : signedPct(b.totalReturn) }}
                  </td>
                  <td class="num" [class.dim]="!b.maxDrawdownPct">
                    {{ plainPct(b.maxDrawdownPct) }}
                  </td>
                  <td class="num when">{{ day(b.completedAt) }}</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
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

      /* KPI strip — same family as the Drift Report tiles: tone stripe, label, figure, one-line caption. */
      .kpis {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: var(--space-3);
      }
      .kpi {
        --tone: var(--text-tertiary);
        position: relative;
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
        overflow: hidden;
        padding: var(--space-3) var(--space-4) var(--space-3) calc(var(--space-4) + 2px);
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        box-shadow: var(--shadow-sm);
      }
      .kpi::before {
        content: '';
        position: absolute;
        inset: 0 auto 0 0;
        width: 3px;
        background: var(--tone);
        opacity: 0.35;
      }
      .kpi[data-tone='info'] {
        --tone: var(--accent);
      }
      .kpi[data-tone='good'] {
        --tone: var(--profit);
      }
      .kpi[data-tone='warn'] {
        --tone: var(--warning);
      }
      .kpi[data-tone]::before {
        opacity: 1;
      }
      .kpi-label {
        font-size: 10.5px;
        font-weight: var(--font-semibold);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .kpi-value {
        font-size: 26px;
        line-height: 1.2;
        font-weight: var(--font-semibold);
        color: var(--text-primary);
        font-variant-numeric: tabular-nums;
        letter-spacing: -0.01em;
        text-decoration: none;
        align-self: flex-start;
      }
      a.kpi-value:hover {
        color: var(--accent);
      }
      .kpi-hint {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        box-shadow: var(--shadow-sm);
        overflow: hidden;
      }
      .head {
        display: flex;
        align-items: baseline;
        flex-wrap: wrap;
        gap: var(--space-1) var(--space-3);
        padding: var(--space-4) var(--space-5) var(--space-3);
      }
      .title {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .hint {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
      }
      .spacer {
        flex: 1;
      }
      .all {
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
        color: var(--accent);
        text-decoration: none;
        padding: 3px 10px;
        border-radius: var(--radius-full);
      }
      .all:hover {
        background: rgba(0, 113, 227, 0.08);
      }
      .empty {
        margin: 0;
        padding: var(--space-6) var(--space-4);
        text-align: center;
        color: var(--text-tertiary);
        font-size: var(--text-sm);
      }

      /* Board table: small uppercase headers, tabular figures, muted zeros. */
      .table-wrap {
        overflow-x: auto;
      }
      table.grid {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-sm);
        table-layout: auto;
      }
      .grid th,
      .grid td {
        padding: 9px var(--space-3);
        border-bottom: 1px solid var(--border);
        text-align: left;
        vertical-align: middle;
      }
      .grid th:first-child,
      .grid td:first-child {
        padding-left: var(--space-5);
      }
      .grid th:last-child,
      .grid td:last-child {
        padding-right: var(--space-5);
      }
      .grid th {
        font-size: 10.5px;
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-tertiary);
        background: var(--bg-primary);
        white-space: nowrap;
      }
      .grid tbody tr:last-child td {
        border-bottom: none;
      }
      .grid tbody tr:hover td {
        background: var(--bg-primary);
      }
      .num {
        text-align: right !important;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }
      .nowrap {
        white-space: nowrap;
      }
      .dim {
        color: var(--text-tertiary);
      }
      .profit {
        color: var(--profit);
      }
      .loss {
        color: var(--loss);
      }
      .run-id {
        font-family: var(--font-mono, ui-monospace, monospace);
        font-size: 12.5px;
        font-weight: var(--font-semibold);
        color: var(--accent);
        text-decoration: none;
      }
      .run-id:hover {
        text-decoration: underline;
      }
      .name-cell {
        width: 100%;
        max-width: 0;
      }
      .name {
        display: block;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--text-primary);
        text-decoration: none;
      }
      a.name:hover {
        color: var(--accent);
        text-decoration: underline;
      }
      .sym {
        font-weight: var(--font-semibold);
      }
      .tf {
        margin-left: 6px;
        font-size: 10.5px;
        color: var(--text-secondary);
        background: var(--bg-tertiary);
        padding: 1px 6px;
        border-radius: 4px;
      }
      .when {
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }

      /* Status dot. */
      .dot {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
        color: var(--text-secondary);
        white-space: nowrap;
      }
      .dot::before {
        content: '';
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: var(--text-tertiary);
        opacity: 0.6;
      }
      .dot[data-status='Completed']::before {
        background: var(--profit);
        opacity: 1;
      }
      .dot[data-status='Running'] {
        color: var(--accent);
      }
      .dot[data-status='Running']::before {
        background: var(--accent);
        opacity: 1;
        box-shadow: 0 0 0 3px rgba(0, 113, 227, 0.18);
      }
      .dot[data-status='Failed'] {
        color: var(--loss);
      }
      .dot[data-status='Failed']::before {
        background: var(--loss);
        opacity: 1;
      }
      .dot[data-status='Cancelled']::before {
        background: var(--warning);
        opacity: 1;
      }
    `,
  ],
})
export class PortfolioBacktestContextComponent {
  private readonly config = inject(ConfigService);
  private readonly strategies = inject(StrategiesService);
  private readonly backtests = inject(BacktestsService);
  private readonly accounts = inject(TradingAccountsService);

  /** Runs in the page's list (null while it loads). */
  readonly runCount = input<number | null>(null);
  readonly canQueue = input(false);

  protected readonly day = day;

  /** A present, finite figure (null and undefined both read as "no figure"). */
  protected hasNum(v: number | null | undefined): v is number {
    return typeof v === 'number' && Number.isFinite(v);
  }

  /** "+1.23%" / "-0.45%", or "—" when there is no figure. */
  protected signedPct(v: number | null | undefined): string {
    return this.hasNum(v) ? `${v > 0 ? '+' : ''}${v.toFixed(2)}%` : '—';
  }

  /** "3.63%", or "—" when there is no figure. */
  protected plainPct(v: number | null | undefined): string {
    return this.hasNum(v) ? `${v.toFixed(2)}%` : '—';
  }
  private readonly settings = signal<Record<string, string | null>>({});
  private readonly scriptStrategies = signal<StrategyDto[] | null>(null);
  private readonly strategyNames = signal<Map<number, string>>(new Map());
  protected readonly recent = signal<BacktestRunDto[] | null>(null);
  private readonly backtestTotal = signal<number | null>(null);
  private readonly accountCount = signal<number | null>(null);

  constructor() {
    for (const key of Object.keys(DEFAULTS))
      this.config
        .getByKey(key, { silent: true })
        .pipe(catchError(() => of(null)))
        .subscribe((r) =>
          this.settings.update((s) => ({
            ...s,
            [key]: r?.status && r.data && typeof r.data.value === 'string' ? r.data.value : null,
          })),
        );
    this.strategies
      .list({ currentPage: 1, itemCountPerPage: 500, filter: null })
      .pipe(
        map((r) => r?.data?.data ?? []),
        catchError(() => of(null)),
      )
      .subscribe((rows) => {
        this.scriptStrategies.set(rows ? rows.filter((s) => isScriptStrategy(s)) : null);
        this.strategyNames.set(new Map((rows ?? []).map((s) => [s.id, s.name ?? `#${s.id}`])));
      });
    this.backtests
      .list({
        currentPage: 1,
        itemCountPerPage: 10,
        filter: null,
        sortBy: 'id',
        sortDirection: 'desc',
      })
      .pipe(catchError(() => of(null)))
      .subscribe((r) => {
        this.recent.set(r?.data?.data ?? []);
        this.backtestTotal.set(r?.data?.pager?.totalItemCount ?? null);
      });
    this.accounts
      .list({ currentPage: 1, itemCountPerPage: 1, filter: null })
      .pipe(catchError(() => of(null)))
      .subscribe((r) => this.accountCount.set(r?.data?.pager?.totalItemCount ?? null));
  }

  private setting(key: string): string {
    return this.settings()[key] ?? DEFAULTS[key];
  }

  protected readonly enabled = computed(() =>
    key(this.settings(), 'PortfolioBacktest:Enabled') === undefined
      ? null
      : this.setting('PortfolioBacktest:Enabled').toLowerCase() === 'true',
  );

  /** Strategies the list returned (deleted ones are not listed and have no page). */
  protected known(id: number): boolean {
    return this.strategyNames().has(id);
  }

  protected nameOf(id: number): string {
    return this.strategyNames().get(id) ?? `#${id}`;
  }

  protected readonly requirements = computed<FeatureRequirement[]>(() => {
    const scripts = this.scriptStrategies();
    const on = this.enabled();
    const accounts = this.accountCount();
    return [
      {
        label: 'Portfolio backtests switched on',
        ok: on,
        detail:
          on === null
            ? 'reading the setting…'
            : `PortfolioBacktest:Enabled = ${this.setting('PortfolioBacktest:Enabled')}${
                this.settings()['PortfolioBacktest:Enabled'] === null ? ' (engine default)' : ''
              }`,
        route: '/engine-config',
        query: { search: 'PortfolioBacktest' },
      },
      {
        label: 'At least two script strategies to combine',
        ok: scripts === null ? null : scripts.length >= 2,
        detail:
          scripts === null
            ? 'could not list strategies'
            : `${scripts.length} script strateg${scripts.length === 1 ? 'y' : 'ies'}: ${scripts
                .slice(0, 4)
                .map((s) => s.name)
                .join(', ')}${scripts.length > 4 ? '…' : ''}`,
        route: '/strategies',
      },
      {
        label: 'A trading account to take its currency and leverage from',
        ok: accounts === null ? null : accounts > 0,
        detail: accounts === null ? null : `${accounts} trading account(s)`,
        route: '/trading-accounts',
      },
      {
        label: 'Analyst access to queue a run',
        ok: this.canQueue(),
        detail: this.canQueue() ? 'you can queue runs' : 'ask an administrator for access.analyst',
      },
    ];
  });

  protected readonly tiles = computed<ContextTile[]>(() => {
    const scripts = this.scriptStrategies();
    const newest = this.recent()?.[0];
    return [
      {
        label: 'Portfolio runs',
        value: this.runCount() === null ? '…' : count(this.runCount()),
        caption: this.runCount() === 0 ? 'none queued yet' : 'newest 50 listed below',
        tone: this.runCount() ? 'info' : null,
      },
      {
        label: 'Script strategies',
        value: scripts === null ? '—' : count(scripts.length),
        caption: 'can be portfolio members',
        tone: scripts === null ? null : scripts.length >= 2 ? 'good' : 'warn',
        route: '/strategies',
      },
      {
        label: 'Member limit',
        value: count(Number(this.setting('PortfolioBacktest:MaxMembers'))),
        caption: `${this.setting('PortfolioBacktest:MaxActiveRuns')} runs at a time · ${count(
          Number(this.setting('PortfolioBacktest:MaxTotalBars')),
        )} bars max`,
        title: 'PortfolioBacktest:MaxMembers / MaxActiveRuns / MaxTotalBars',
      },
      {
        label: 'Single backtests',
        value: count(this.backtestTotal()),
        caption: newest
          ? `newest #${newest.id} · ${ago(newest.completedAt ?? newest.queuedAt)}`
          : null,
        tone: this.backtestTotal() ? 'info' : null,
        route: '/backtests',
      },
    ];
  });
}

function key(s: Record<string, string | null>, k: string): string | null | undefined {
  return k in s ? s[k] : undefined;
}
