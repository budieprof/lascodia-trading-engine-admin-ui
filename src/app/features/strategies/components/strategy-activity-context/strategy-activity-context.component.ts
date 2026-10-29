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
import { catchError, forkJoin, map, of } from 'rxjs';

import { StrategiesService } from '@core/services/strategies.service';
import { BacktestsService } from '@core/services/backtests.service';
import type {
  BacktestRunDto,
  LatestStrategyRunsDto,
  PromotionGateEvaluationDto,
  StrategyDto,
  StrategyRejectionDistributionDto,
} from '@core/api/api.types';
import { isScriptStrategy } from '@features/scripting/shared/script-strategy';
import { FactTilesComponent, type FactTile } from '../fact-tiles/fact-tiles.component';
import { ago, count, day } from '../../util/figures';
import {
  activityHeadline,
  activityReasons,
  type ActivityReason,
  type StrategyActivityFacts,
} from './strategy-activity.logic';

interface Loaded {
  backtests: { total: number; newest: BacktestRunDto | null } | null;
  latest: LatestStrategyRunsDto | null;
  gate: PromotionGateEvaluationDto | null | undefined;
  rejections: StrategyRejectionDistributionDto | null;
}

/**
 * "What this strategy would do, and why it has not": its stage, its evidence (backtests on any market and
 * on its own, walk-forward, the last recorded promotion attempt, pipeline rejections) and the reasons it
 * produces no signals or orders — every one read from the engine. Shown where a strategy's tab would
 * otherwise be an empty table. `openTab` asks the host detail page to switch tab; elsewhere reasons link
 * to the detail page with `?tab=`.
 */
@Component({
  selector: 'app-strategy-activity-context',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, FactTilesComponent],
  template: `
    <section
      class="ctx"
      [attr.aria-label]="'Why ' + (strategy().name ?? 'this strategy') + ' is quiet'"
    >
      <header class="head">
        <div>
          @if (lead()) {
            <p class="lead">{{ lead() }}</p>
          }
          <h3>{{ headline() }}</h3>
          <p class="sub">
            {{ strategy().symbol }} · {{ strategy().timeframe }} · {{ typeLabel() }} ·
            {{ strategy().status }} / {{ strategy().lifecycleStage }}
            @if (strategy().lastSignalAt) {
              · last signal {{ ago(strategy().lastSignalAt) }}
            } @else {
              · never signalled
            }
          </p>
          @if (strategy().description; as d) {
            <p class="desc" [title]="d">{{ d }}</p>
          }
        </div>
      </header>

      <app-fact-tiles [tiles]="tiles()" />

      <div class="reasons-wrap">
        <h4>{{ loaded() ? 'Why it is quiet' : 'Checking its evidence…' }}</h4>
        <ul class="reasons">
          @for (r of reasons(); track r.title) {
            <li [attr.data-tone]="r.tone">
              <span class="dot" aria-hidden="true"></span>
              <div class="txt">
                <strong>{{ r.title }}</strong>
                <span>{{ r.detail }}</span>
              </div>
              @if (r.tab || r.route) {
                @if (r.tab && embedded()) {
                  <button type="button" class="go" (click)="openTab.emit(r.tab!)">Open</button>
                } @else {
                  <a class="go" [routerLink]="linkFor(r)" [queryParams]="queryFor(r)">Open</a>
                }
              }
            </li>
          }
        </ul>
      </div>
    </section>
  `,
  styles: [
    `
      .ctx {
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
        padding: var(--space-4) var(--space-5);
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
      }
      .lead {
        margin: 0 0 2px;
        font-size: var(--text-xs);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-tertiary);
      }
      h3 {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      h4 {
        margin: 0 0 var(--space-2);
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
        color: var(--text-secondary);
      }
      .sub {
        margin: 2px 0 0;
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .desc {
        margin: 4px 0 0;
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      .reasons {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
        gap: var(--space-2);
      }
      .reasons li {
        display: flex;
        gap: var(--space-2);
        align-items: flex-start;
        padding: var(--space-2) var(--space-3);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
      }
      .dot {
        flex: none;
        width: 8px;
        height: 8px;
        margin-top: 6px;
        border-radius: 50%;
        background: var(--text-tertiary);
      }
      li[data-tone='block'] .dot {
        background: var(--warning);
      }
      li[data-tone='ok'] .dot {
        background: var(--profit);
      }
      .txt {
        display: flex;
        flex-direction: column;
        gap: 2px;
        font-size: var(--text-sm);
        min-width: 0;
        flex: 1;
      }
      .txt span {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        line-height: 1.4;
        overflow-wrap: anywhere;
      }
      .go {
        flex: none;
        font-size: var(--text-xs);
        color: var(--accent);
        background: transparent;
        border: 0;
        cursor: pointer;
        text-decoration: none;
        padding: 2px 0;
      }
    `,
  ],
})
export class StrategyActivityContextComponent {
  private readonly strategies = inject(StrategiesService);
  private readonly backtests = inject(BacktestsService);

  readonly strategy = input.required<StrategyDto>();
  /** Small caption above the headline, e.g. "No signals generated yet". */
  readonly lead = input<string | null>(null);
  /** True on the strategy detail page: tab reasons switch tab in place instead of navigating. */
  readonly embedded = input(false);
  readonly openTab = output<string>();

  protected readonly loaded = signal<Loaded | null>(null);
  protected readonly ago = ago;

  constructor() {
    effect(() => {
      const id = this.strategy().id;
      untracked(() => this.load(id));
    });
  }

  private load(id: number): void {
    forkJoin({
      backtests: this.backtests
        .list({
          currentPage: 1,
          itemCountPerPage: 1,
          filter: { strategyId: id },
          sortBy: 'id',
          sortDirection: 'desc',
        })
        .pipe(
          map((r) => ({
            total: r?.data?.pager?.totalItemCount ?? 0,
            newest: r?.data?.data?.[0] ?? null,
          })),
          catchError(() => of(null)),
        ),
      latest: this.strategies.getLatestRuns([id]).pipe(
        map((r) => r?.data?.find((x) => x.strategyId === id) ?? null),
        catchError(() => of(null)),
      ),
      gate: this.strategies.getPromotionGateHistory(id, 1).pipe(
        map((r) => (r?.status ? (r.data?.[0] ?? null) : undefined)),
        catchError(() => of(undefined)),
      ),
      rejections: this.strategies.getRejectionDistribution(id).pipe(
        map((r) => r?.data ?? null),
        catchError(() => of(null)),
      ),
    }).subscribe((l) => this.loaded.set(l));
  }

  protected readonly typeLabel = computed(() =>
    isScriptStrategy(this.strategy())
      ? 'Pine script'
      : (this.strategy().strategyType ?? 'Strategy'),
  );

  private readonly facts = computed<StrategyActivityFacts>(() => {
    const s = this.strategy();
    const l = this.loaded();
    const worst = l?.rejections?.stages?.[0];
    const newest = l?.backtests?.newest ?? null;
    return {
      id: s.id,
      name: s.name,
      symbol: s.symbol,
      timeframe: s.timeframe,
      status: s.status,
      lifecycleStage: s.lifecycleStage,
      pauseReason: s.pauseReason,
      isScript: isScriptStrategy(s),
      accountBindingCount: s.accountBindingCount ?? null,
      lastSignalAt: s.lastSignalAt,
      backtestCount: l?.backtests ? l.backtests.total : null,
      newestBacktest: newest
        ? {
            id: newest.id,
            symbol: newest.symbol,
            trades: newest.totalTrades ?? null,
            completedAt: newest.completedAt,
          }
        : null,
      ownMarketBacktestId: l ? (l.latest?.backtestRunId ?? null) : -1,
      ownMarketBacktestReturnPct: l?.latest?.backtestReturnPct ?? null,
      walkForwardRunId: l?.latest?.walkForwardRunId ?? null,
      walkForwardOosScore: l?.latest?.walkForwardAverageOutOfSampleScore ?? null,
      lastGate: l?.gate
        ? {
            outcome: l.gate.outcome,
            passed: l.gate.passed,
            isVerdict: l.gate.isVerdict,
            failureSummary: l.gate.failureSummary,
            at: l.gate.evaluatedAtUtc,
          }
        : null,
      rejectionTotal: l?.rejections ? l.rejections.totalRejections : null,
      worstRejectionStage: worst?.stage ?? null,
      worstRejectionReason: worst?.reasons?.[0]?.reason ?? null,
    };
  });

  protected readonly headline = computed(() => activityHeadline(this.facts()));

  protected readonly reasons = computed<ActivityReason[]>(() => {
    const f = this.facts();
    // Until the evidence loads, only the reasons that need nothing but the strategy row.
    if (!this.loaded())
      return activityReasons({
        ...f,
        backtestCount: null,
        ownMarketBacktestId: -1,
        lastGate: null,
      }).filter((r) => r.title !== 'Never submitted for approval');
    return activityReasons(f);
  });

  protected readonly tiles = computed<FactTile[]>(() => {
    const l = this.loaded();
    const f = this.facts();
    const id = this.strategy().id;
    const newest = l?.backtests?.newest;
    const g = l?.gate;
    return [
      {
        label: 'Backtests',
        value: l?.backtests ? count(l.backtests.total) : '…',
        caption: newest
          ? `newest #${newest.id} ${newest.symbol ?? ''} · ${newest.totalTrades ?? '—'} trades · ${day(newest.completedAt)}`
          : l?.backtests
            ? 'none queued yet'
            : null,
        route: newest ? `/backtests/${newest.id}` : null,
      },
      {
        label: 'Own-market evidence',
        value:
          f.ownMarketBacktestReturnPct != null
            ? `${f.ownMarketBacktestReturnPct > 0 ? '+' : ''}${f.ownMarketBacktestReturnPct.toFixed(2)}%`
            : l
              ? 'none'
              : '…',
        caption:
          f.ownMarketBacktestId && f.ownMarketBacktestId > 0
            ? `run #${f.ownMarketBacktestId} on ${this.strategy().symbol} ${this.strategy().timeframe}`
            : 'promotion reads only runs on its own symbol + timeframe',
        tone:
          f.ownMarketBacktestReturnPct == null
            ? 'muted'
            : f.ownMarketBacktestReturnPct > 0
              ? 'good'
              : 'bad',
        route:
          f.ownMarketBacktestId && f.ownMarketBacktestId > 0
            ? `/backtests/${f.ownMarketBacktestId}`
            : null,
      },
      {
        label: 'Walk-forward',
        value: f.walkForwardRunId ? `#${f.walkForwardRunId}` : l ? 'none' : '…',
        caption:
          f.walkForwardOosScore != null
            ? `avg out-of-sample score ${f.walkForwardOosScore.toFixed(2)}`
            : 'no completed walk-forward on its market',
        tone: f.walkForwardRunId ? null : 'muted',
        route: f.walkForwardRunId ? `/walk-forward/${f.walkForwardRunId}` : null,
      },
      {
        label: 'Last promotion attempt',
        value: g ? g.outcome : g === null ? 'never' : '…',
        caption: g
          ? `${day(g.evaluatedAtUtc)} (${ago(g.evaluatedAtUtc)})`
          : g === null
            ? 'no gate attempt recorded'
            : null,
        tone: g ? (g.passed ? 'good' : g.isVerdict ? 'bad' : 'warn') : 'muted',
        route: `/strategies/${id}`,
        query: { tab: 'promotion' },
      },
      {
        label: 'Pipeline rejections',
        value: l?.rejections ? count(l.rejections.totalRejections) : '…',
        caption: f.worstRejectionStage
          ? `most at ${f.worstRejectionStage}`
          : l?.rejections
            ? 'no signal was ever rejected'
            : null,
        route: `/strategies/${id}/analytics`,
        query: { tab: 'rejections' },
      },
    ];
  });

  protected linkFor(r: ActivityReason): string | unknown[] {
    if (r.route) return r.route;
    if (r.tab === 'rejections') return ['/strategies', this.strategy().id, 'analytics'];
    return ['/strategies', this.strategy().id];
  }

  protected queryFor(r: ActivityReason): Record<string, string> | undefined {
    if (r.route) return undefined;
    return r.tab ? { tab: r.tab } : undefined;
  }
}
