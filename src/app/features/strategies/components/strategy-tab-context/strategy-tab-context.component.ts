import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { catchError, map, of } from 'rxjs';
import type { EChartsOption } from 'echarts';

import { StrategiesService, type StrategyFootprintDto } from '@core/services/strategies.service';
import { AuditTrailService } from '@core/services/audit-trail.service';
import { KillSwitchService } from '@core/services/kill-switch.service';
import type {
  DecisionLogDto,
  KillSwitchStatusDto,
  StrategyDto,
  StrategyVersionDto,
} from '@core/api/api.types';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import { FeatureStateComponent } from '@shared/components/feedback/feature-state.component';
import { FactTilesComponent, type FactTile } from '../fact-tiles/fact-tiles.component';
import { StrategyActivityContextComponent } from '../strategy-activity-context/strategy-activity-context.component';
import { ago, count, day, fractionPct, money } from '../../util/figures';
import {
  isSentinelName,
  perDay,
  tabApplicability,
  type DetailTab,
} from './strategy-tab-context.logic';

/**
 * Fills a strategy-detail tab that would otherwise be one line on a blank screen. It says whether the tab
 * applies (a sentinel strategy has no rules, so its evidence tabs do not), then shows what DOES apply from
 * `GET strategy/{id}/footprint`: signals and orders per day, accounts, fills, P&L, kill switches — or, for a
 * strategy that never traded, why it is quiet. Capacity adds its fill quality, Reviews its decision log,
 * Lineage its creation record, versions and the other strategies on its market.
 */
@Component({
  selector: 'app-strategy-tab-context',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    ChartCardComponent,
    FeatureStateComponent,
    FactTilesComponent,
    StrategyActivityContextComponent,
  ],
  template: `
    @if (!applicability().applies) {
      <app-feature-state
        kind="off"
        [title]="applicability().title"
        [summary]="applicability().why ?? ''"
        detail="Below: what this strategy actually does."
        [links]="[
          { label: 'Its signals', route: '/trade-signals' },
          { label: 'Kill switches', route: '/kill-switches' },
          { label: 'LLM Backtest', route: '/llm-backtest' },
        ]"
      />
    }

    @if (tab() === 'reviews') {
      <section class="card">
        <header class="head">
          <h3>How this strategy is reviewed</h3>
        </header>
        <ul class="bullets">
          <li>
            <strong>Health</strong> — StrategyHealthWorker scores every Active strategy with closed
            trades each minute
            {{ sentinel() ? '(sentinels are skipped: their results belong to their source)' : '' }}.
          </li>
          <li>
            <strong>Promotion gates</strong> — each auto-promote attempt and each Submit for
            approval is recorded.
          </li>
          <li>
            <strong>Promotion reviews</strong> — a bull / bear / judge LLM review is written for
            promotion candidates when promotion reviews are on.
          </li>
          <li>
            <strong>Pauses and resumes</strong> by drawdown recovery or the execution-quality
            breaker.
          </li>
        </ul>
        <h4>
          Decision log
          <span class="muted"
            >newest {{ decisions()?.length ?? 0 }} of {{ decisionTotal() ?? '—' }}</span
          >
        </h4>
        @if (decisions() === null) {
          <p class="muted">Loading…</p>
        } @else if (decisions()!.length === 0) {
          <p class="muted">
            Nothing has been recorded for this strategy: it was never health-scored, put through the
            gates, paused or resumed{{ sentinel() ? ' — expected for a sentinel' : '' }}.
          </p>
        } @else {
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Decision</th>
                  <th>Outcome</th>
                  <th>By</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                @for (d of decisions(); track d.id) {
                  <tr>
                    <td class="nowrap">{{ day(d.createdAt) }} · {{ ago(d.createdAt) }}</td>
                    <td>{{ d.decisionType }}</td>
                    <td>{{ d.outcome }}</td>
                    <td class="muted">{{ d.source }}</td>
                    <td class="reason">{{ d.reason }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      </section>
    }

    @if (tab() === 'lineage') {
      <section class="card">
        <header class="head"><h3>Creation record</h3></header>
        @if (fp(); as f) {
          <dl class="grid-dl">
            <div>
              <dt>Created</dt>
              <dd>{{ day(f.origin.createdAt) }} ({{ ago(f.origin.createdAt) }})</dd>
            </div>
            <div>
              <dt>Source</dt>
              <dd>{{ originLabel() }}</dd>
            </div>
            <div>
              <dt>Generation</dt>
              <dd>{{ f.origin.generation }}</dd>
            </div>
            <div>
              <dt>Hypothesis class</dt>
              <dd>{{ f.origin.hypothesisClass ?? '—' }}</dd>
            </div>
            <div>
              <dt>Cloned / bred from</dt>
              <dd>
                @if (f.origin.parentStrategyId) {
                  <a [routerLink]="['/strategies', f.origin.parentStrategyId]"
                    >#{{ f.origin.parentStrategyId }}</a
                  >
                  {{ f.origin.parentName ?? '' }}
                  @if (f.origin.secondParentStrategyId) {
                    × #{{ f.origin.secondParentStrategyId }}
                  }
                } @else {
                  {{ sentinel() ? 'none — the engine created it' : 'none — authored directly' }}
                }
              </dd>
            </div>
            <div>
              <dt>Versions captured</dt>
              <dd>
                {{ f.origin.versions }}
                @if (f.origin.lastVersionAtUtc) {
                  · last {{ day(f.origin.lastVersionAtUtc)
                  }}{{ f.origin.lastVersionReason ? ' — ' + f.origin.lastVersionReason : '' }}
                }
              </dd>
            </div>
            <div>
              <dt>In this stage since</dt>
              <dd>{{ day(f.origin.lifecycleStageEnteredAt ?? f.origin.createdAt) }}</dd>
            </div>
            @if (f.origin.generationCycleId) {
              <div>
                <dt>Generation cycle</dt>
                <dd class="mono">{{ f.origin.generationCycleId }}</dd>
              </div>
            }
          </dl>
        } @else {
          <p class="muted">
            Created {{ day(strategy().createdAt) }} · {{ strategy().strategyType }}.
          </p>
        }
        @if (versions()?.length) {
          <h4>Version history</h4>
          <ul class="versions">
            @for (v of versions(); track v.id) {
              <li>
                <strong>v{{ v.versionNumber }}</strong> · {{ day(v.capturedAt) }}
                <span class="muted"
                  >{{ v.changeReason ?? 'captured'
                  }}{{ v.createdBy ? ' · ' + v.createdBy : '' }}</span
                >
              </li>
            }
          </ul>
        }
        @if (fp()?.sameMarket?.length) {
          <h4>
            Other strategies on {{ strategy().symbol }}
            <span class="muted">siblings and same-market neighbours</span>
          </h4>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Strategy</th>
                  <th>Timeframe</th>
                  <th>Status</th>
                  <th>Stage</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                @for (x of fp()!.sameMarket; track x.id) {
                  <tr>
                    <td>
                      <a [routerLink]="['/strategies', x.id]">{{ x.name }}</a>
                      <span class="muted">#{{ x.id }}</span>
                    </td>
                    <td>{{ x.timeframe }}</td>
                    <td>{{ x.status }}</td>
                    <td>{{ x.lifecycleStage }}</td>
                    <td class="muted">{{ x.sameParent ? 'same parent' : '' }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      </section>
    }

    @if (tab() === 'capacity' && fp(); as f) {
      <section class="card">
        <header class="head">
          <h3>How its orders actually filled</h3>
          <span class="muted">last {{ f.days }} days · real fills, not a simulation</span>
        </header>
        @if (f.fills === 0) {
          <p class="muted">
            No fill recorded in the window, so there is no size or slippage evidence yet.
          </p>
        } @else {
          <app-fact-tiles [tiles]="fillTiles()" />
        }
      </section>
    }

    <!-- What applies: the live footprint, or why a never-traded strategy is quiet. -->
    @if (showFootprint()) {
      <section class="card">
        <header class="head">
          <h3>What it does live</h3>
          <span class="muted"
            >last {{ fp()!.days }} days · signals, orders and results of the trades it owns</span
          >
        </header>
        <app-fact-tiles [tiles]="footprintTiles()" />
        @if (fp()!.signalsInWindow + fp()!.ordersInWindow > 0) {
          <app-chart-card
            title="Signals and orders per day"
            [subtitle]="'≈ ' + perDayText() + ' signals a day'"
            [options]="dailyChart()"
            height="220px"
          />
        }
        @if (fp()!.accounts.length) {
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Account</th>
                  <th class="num">Orders</th>
                  <th class="num">Filled</th>
                  <th class="num">Lots</th>
                  <th class="num">Closed</th>
                  <th class="num">Realised P&amp;L</th>
                </tr>
              </thead>
              <tbody>
                @for (a of fp()!.accounts; track a.tradingAccountId) {
                  <tr>
                    <td>
                      <a [routerLink]="['/trading-accounts', a.tradingAccountId]">{{
                        a.accountName || '#' + a.tradingAccountId
                      }}</a>
                    </td>
                    <td class="num">{{ a.orders }}</td>
                    <td class="num">{{ a.filled }}</td>
                    <td class="num">{{ a.filledLots.toFixed(2) }}</td>
                    <td class="num">{{ a.positionsClosed }}</td>
                    <td
                      class="num"
                      [class.profit]="a.realizedPnl > 0"
                      [class.loss]="a.realizedPnl < 0"
                    >
                      {{ money(a.realizedPnl, null, true) }}
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      </section>
    } @else if (showQuiet()) {
      <app-strategy-activity-context
        [strategy]="strategy()"
        [lead]="quietLead()"
        [embedded]="embedded()"
        (openTab)="openTab.emit($event)"
      />
    }
  `,
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
        margin-top: var(--space-4);
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
        gap: var(--space-2);
        flex-wrap: wrap;
      }
      h3 {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      h4 {
        margin: var(--space-2) 0 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      .muted {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
        font-weight: normal;
        margin: 0;
      }
      .bullets {
        margin: 0;
        padding-left: 18px;
        font-size: var(--text-sm);
        color: var(--text-secondary);
        line-height: 1.6;
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
        padding: 6px 10px;
        border-bottom: 1px solid var(--border);
        text-align: left;
      }
      th {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        font-weight: normal;
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .nowrap {
        white-space: nowrap;
      }
      .reason {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        max-width: 520px;
        overflow-wrap: anywhere;
      }
      .mono {
        font-family: var(--font-mono);
        font-size: var(--text-xs);
      }
      .profit {
        color: var(--profit);
      }
      .loss {
        color: var(--loss);
      }
      .grid-dl {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: var(--space-3);
        margin: 0;
      }
      .grid-dl dt {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .grid-dl dd {
        margin: 2px 0 0;
        font-size: var(--text-sm);
      }
      .versions {
        margin: 0;
        padding-left: 18px;
        font-size: var(--text-sm);
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      a {
        color: var(--accent);
        text-decoration: none;
      }
    `,
  ],
})
export class StrategyTabContextComponent {
  private readonly strategies = inject(StrategiesService);
  private readonly audit = inject(AuditTrailService);
  private readonly killSwitches = inject(KillSwitchService);

  readonly strategy = input.required<StrategyDto>();
  readonly tab = input.required<DetailTab>();
  readonly embedded = input(false);
  readonly openTab = output<string>();

  protected readonly fp = signal<StrategyFootprintDto | null>(null);
  protected readonly fpLoaded = signal(false);
  protected readonly decisions = signal<DecisionLogDto[] | null>(null);
  protected readonly decisionTotal = signal<number | null>(null);
  protected readonly versions = signal<StrategyVersionDto[] | null>(null);
  private readonly strategyKill = signal<KillSwitchStatusDto | null>(null);
  private readonly globalKill = signal<KillSwitchStatusDto | null>(null);

  protected readonly money = money;
  protected readonly day = day;
  protected readonly ago = ago;

  constructor() {
    effect(() => {
      const id = this.strategy().id;
      const tab = this.tab();
      untracked(() => this.load(id, tab));
    });
  }

  private load(id: number, tab: DetailTab): void {
    this.strategies
      .getFootprint(id)
      .pipe(
        map((r) => (r?.status && r.data ? r.data : null)),
        catchError(() => of(null)),
      )
      .subscribe((f) => {
        this.fp.set(f);
        this.fpLoaded.set(true);
      });
    this.killSwitches
      .getStrategy(id)
      .pipe(catchError(() => of(null)))
      .subscribe((r) => this.strategyKill.set(r?.status ? (r.data ?? null) : null));
    this.killSwitches
      .getGlobal()
      .pipe(catchError(() => of(null)))
      .subscribe((r) => this.globalKill.set(r?.status ? (r.data ?? null) : null));
    if (tab === 'reviews')
      this.audit
        .list({
          currentPage: 1,
          itemCountPerPage: 15,
          filter: { entityType: 'Strategy', entityId: id },
          sortBy: 'createdAt',
          sortDirection: 'desc',
        })
        .pipe(catchError(() => of(null)))
        .subscribe((r) => {
          this.decisions.set(r?.data?.data ?? []);
          this.decisionTotal.set(r?.data?.pager?.totalItemCount ?? 0);
        });
    if (tab === 'lineage')
      this.strategies
        .getVersions(id, 10)
        .pipe(catchError(() => of(null)))
        .subscribe((r) => this.versions.set(r?.data ?? []));
  }

  protected readonly sentinel = computed(
    () => this.fp()?.isSentinel ?? isSentinelName(this.strategy().name),
  );
  protected readonly applicability = computed(() => tabApplicability(this.tab(), this.sentinel()));

  /** Live footprint when the strategy has traded or is a sentinel; otherwise the "why it is quiet" card. */
  protected readonly showFootprint = computed(() => {
    const f = this.fp();
    return !!f && (f.isSentinel || f.signalsAllTime > 0 || f.ordersInWindow > 0);
  });
  protected readonly showQuiet = computed(
    () =>
      this.fpLoaded() &&
      !this.showFootprint() &&
      this.tab() !== 'signals' &&
      this.tab() !== 'orders',
  );
  protected readonly quietLead = computed(() =>
    this.tab() === 'promotion'
      ? 'Where it stands on the way to an account'
      : 'Its evidence and why it is not trading',
  );

  protected readonly perDayText = computed(() => perDay(this.fp()?.signalsByDay ?? []).toFixed(1));

  protected readonly originLabel = computed(() => {
    const o = this.fp()?.origin;
    if (!o) return '—';
    if (this.sentinel()) return 'Engine sentinel (created by the engine for its signal source)';
    if (o.generationSource && o.generationSource !== 'Other')
      return `Generated (${o.generationSource})`;
    if (o.parentStrategyId) return 'Cloned / bred from another strategy';
    return 'Authored by an operator';
  });

  protected readonly footprintTiles = computed<FactTile[]>(() => {
    const f = this.fp();
    if (!f) return [];
    const approved = (f.signalsByStatus['Approved'] ?? 0) + (f.signalsByStatus['Executed'] ?? 0);
    const sk = this.strategyKill();
    const gk = this.globalKill();
    return [
      {
        label: 'Signals',
        value: count(f.signalsInWindow),
        caption: `${count(f.signalsAllTime)} all time · last ${ago(f.lastSignalAtUtc)}${approved ? ` · ${approved} approved` : ''}`,
        route: '/trade-signals',
      },
      {
        label: 'Orders',
        value: count(f.ordersInWindow),
        caption:
          Object.entries(f.ordersByStatus)
            .map(([k, v]) => `${v} ${k.toLowerCase()}`)
            .join(' · ') || 'none in the window',
        route: '/orders',
      },
      {
        label: 'Realised P&L',
        value: money(f.realizedPnl, null, true),
        tone: f.realizedPnl > 0 ? 'good' : f.realizedPnl < 0 ? 'bad' : null,
        caption: `${f.positionsClosed} closed (${f.positionsWon} won) · ${f.positionsOpen} open ${money(f.unrealizedPnl, null, true)}`,
      },
      {
        label: 'Filled',
        value: `${f.filledLots.toFixed(2)} lots`,
        caption: f.fills
          ? `${f.fills} fills · avg slippage ${f.avgSlippagePips?.toFixed(2)} pips`
          : 'no fill recorded',
      },
      {
        label: 'Kill switches',
        value: sk?.enabled || gk?.enabled ? 'ENGAGED' : sk || gk ? 'clear' : '—',
        tone: sk?.enabled || gk?.enabled ? 'bad' : sk || gk ? 'good' : 'muted',
        caption: `strategy ${sk ? (sk.enabled ? 'engaged' : 'off') : '—'} · global ${gk ? (gk.enabled ? 'engaged' : 'off') : '—'}`,
        route: '/kill-switches',
      },
    ];
  });

  protected readonly fillTiles = computed<FactTile[]>(() => {
    const f = this.fp();
    if (!f) return [];
    return [
      { label: 'Fills', value: count(f.fills), caption: `${f.partialFills} partial` },
      {
        label: 'Volume filled',
        value: `${f.filledLots.toFixed(2)} lots`,
        caption: `${f.accounts.length} account(s)`,
      },
      {
        label: 'Average slippage',
        value: f.avgSlippagePips == null ? '—' : `${f.avgSlippagePips.toFixed(2)} pips`,
        caption: 'signed: positive = worse than requested',
        title: 'Mean of filled − requested price, in pips, from the execution-quality log',
      },
      {
        label: 'Average |slippage|',
        value: f.avgAbsSlippagePips == null ? '—' : `${f.avgAbsSlippagePips.toFixed(2)} pips`,
        caption:
          f.worstSlippagePips == null ? null : `worst ${f.worstSlippagePips.toFixed(2)} pips`,
      },
      {
        label: 'Submit → fill',
        value: f.avgSubmitToFillMs == null ? '—' : `${Math.round(f.avgSubmitToFillMs)} ms`,
        caption: 'average broker latency',
      },
      {
        label: 'Win rate',
        value: f.positionsClosed ? fractionPct(f.positionsWon / f.positionsClosed, 0, false) : '—',
        caption: `${f.positionsClosed} closed positions`,
      },
    ];
  });

  protected readonly dailyChart = computed<EChartsOption>(() => {
    const days = this.fp()?.signalsByDay ?? [];
    return {
      tooltip: { trigger: 'axis' },
      legend: { data: ['Signals', 'Orders'], top: 0 },
      grid: { left: 36, right: 12, top: 28, bottom: 24 },
      xAxis: {
        type: 'category',
        data: days.map((d) => d.date.slice(5, 10)),
        axisLabel: { fontSize: 10 },
      },
      yAxis: { type: 'value', minInterval: 1 },
      series: [
        {
          name: 'Signals',
          type: 'bar',
          data: days.map((d) => d.signals),
          color: '#0071E3',
          barMaxWidth: 10,
        },
        {
          name: 'Orders',
          type: 'bar',
          data: days.map((d) => d.orders),
          color: '#34C759',
          barMaxWidth: 10,
        },
      ],
    };
  });
}
