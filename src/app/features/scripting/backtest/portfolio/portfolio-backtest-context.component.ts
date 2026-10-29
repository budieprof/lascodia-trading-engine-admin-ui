import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
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
import {
  FactTilesComponent,
  type FactTile,
} from '@features/strategies/components/fact-tiles/fact-tiles.component';
import { ago, count, day } from '@features/strategies/util/figures';
import { isScriptStrategy } from '../../shared/script-strategy';

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
  imports: [RouterLink, FeatureStateComponent, FactTilesComponent],
  template: `
    <app-fact-tiles [tiles]="tiles()" />

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
      @if (canQueue()) {
        <div class="cta">
          <button type="button" class="btn btn-primary" (click)="start.emit()">
            Start a portfolio backtest
          </button>
        </div>
      }
    }

    <section class="card" aria-labelledby="pf-recent-title">
      <header class="head">
        <h2 id="pf-recent-title" class="title">Recent single-strategy backtests</h2>
        <span class="muted small">the evidence each member brings — newest first</span>
        <span class="spacer"></span>
        <a routerLink="/backtests" class="small">All backtests →</a>
      </header>
      @if (recent() === null) {
        <p class="muted">Loading…</p>
      } @else if (recent()!.length === 0) {
        <p class="muted">No backtest is on record yet.</p>
      } @else {
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Run</th>
                <th>Strategy</th>
                <th>Market</th>
                <th>Status</th>
                <th class="num">Trades</th>
                <th class="num" title="Percent of the initial balance">Return</th>
                <th class="num" title="Percent of peak equity">Max DD</th>
                <th>Completed</th>
              </tr>
            </thead>
            <tbody>
              @for (b of recent(); track b.id) {
                <tr>
                  <td>
                    <a [routerLink]="['/backtests', b.id]" class="mono">#{{ b.id }}</a>
                  </td>
                  <td>
                    @if (b.strategyId) {
                      <a [routerLink]="['/strategies', b.strategyId]">{{ nameOf(b.strategyId) }}</a>
                    } @else {
                      —
                    }
                  </td>
                  <td>{{ b.symbol }} {{ b.timeframe }}</td>
                  <td>{{ b.status }}</td>
                  <td class="num">{{ b.totalTrades ?? '—' }}</td>
                  <td
                    class="num"
                    [class.profit]="(b.totalReturn ?? 0) > 0"
                    [class.loss]="(b.totalReturn ?? 0) < 0"
                  >
                    {{
                      b.totalReturn == null || b.totalTrades === 0
                        ? '—'
                        : (b.totalReturn > 0 ? '+' : '') + b.totalReturn.toFixed(2) + '%'
                    }}
                  </td>
                  <td class="num">
                    {{ b.maxDrawdownPct == null ? '—' : b.maxDrawdownPct.toFixed(2) + '%' }}
                  </td>
                  <td class="small">{{ day(b.completedAt) }}</td>
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
      .cta {
        display: flex;
        justify-content: flex-end;
        margin-top: calc(-1 * var(--space-2));
      }
      .card {
        padding: var(--space-4) var(--space-5);
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .head {
        display: flex;
        align-items: baseline;
        gap: 8px;
        flex-wrap: wrap;
      }
      .title {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .spacer {
        flex: 1;
      }
      .table-wrap {
        overflow-x: auto;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-sm);
      }
      th,
      td {
        padding: 6px 8px;
        border-bottom: 1px solid var(--border);
        text-align: left;
        font-weight: normal;
        white-space: nowrap;
      }
      thead th {
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .muted {
        color: var(--text-tertiary);
        margin: 0;
      }
      .small {
        font-size: var(--text-xs);
      }
      .mono {
        font-family: var(--font-mono);
      }
      .profit {
        color: var(--profit);
      }
      .loss {
        color: var(--loss);
      }
      a {
        color: var(--accent);
        text-decoration: none;
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
  readonly start = output<void>();

  protected readonly day = day;
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

  protected readonly tiles = computed<FactTile[]>(() => {
    const scripts = this.scriptStrategies();
    const newest = this.recent()?.[0];
    return [
      {
        label: 'Portfolio runs',
        value: this.runCount() === null ? '…' : count(this.runCount()),
        caption: this.runCount() === 0 ? 'none queued yet' : 'newest 50 listed below',
      },
      {
        label: 'Script strategies',
        value: scripts === null ? '—' : count(scripts.length),
        caption: 'can be portfolio members',
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
        route: '/backtests',
      },
    ];
  });
}

function key(s: Record<string, string | null>, k: string): string | null | undefined {
  return k in s ? s[k] : undefined;
}
