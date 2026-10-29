import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { catchError, map, of } from 'rxjs';

import {
  PaperTradingService,
  type PaperExecutionSummaryDto,
} from '@core/services/paper-trading.service';
import { StrategiesService } from '@core/services/strategies.service';
import type { StrategyDto } from '@core/api/api.types';
import {
  FactTilesComponent,
  type FactTile,
} from '@features/strategies/components/fact-tiles/fact-tiles.component';
import { ago, count, day, fractionPct, money } from '@features/strategies/util/figures';

/**
 * The per-strategy paper track record: what Approved / PaperTrading strategies would have done live,
 * simulated against the cost profile with nothing sent to a broker (`PaperExecution`). Independent of the
 * engine-wide paper mode switch above it. Before the engine serves the summary it lists the strategies that
 * are paper-trading from the strategy list.
 */
@Component({
  selector: 'app-paper-track-record',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, FactTilesComponent],
  template: `
    <section class="block">
      <header class="head">
        <h3>Strategy paper track record</h3>
        <span class="muted"
          >live signals of strategies in a paper stage, simulated at the engine's costs — last
          {{ summary()?.days ?? 90 }} days</span
        >
      </header>

      @if (summary(); as s) {
        <app-fact-tiles [tiles]="tiles()" />
        @if (s.strategies.length === 0) {
          <p class="muted">
            No paper execution in the window. A strategy paper-trades once it is Approved (and
            Paused) or put in the PaperTrading stage; {{ s.strategiesInPaperStage }} strateg{{
              s.strategiesInPaperStage === 1 ? 'y is' : 'ies are'
            }}
            in such a stage now.
          </p>
        } @else {
          <div class="table-card">
            <table>
              <thead>
                <tr>
                  <th>Strategy</th>
                  <th>Stage</th>
                  <th class="num">Executions</th>
                  <th class="num">Closed</th>
                  <th class="num">Open</th>
                  <th class="num">Expired</th>
                  <th class="num">Win rate</th>
                  <th class="num" title="Net of simulated spread, slippage, commission and swap">
                    Net P&amp;L
                  </th>
                  <th>Last</th>
                </tr>
              </thead>
              <tbody>
                @for (r of s.strategies; track r.strategyId) {
                  <tr>
                    <td class="name">
                      <a [routerLink]="['/strategies', r.strategyId]">{{
                        r.name ?? '#' + r.strategyId
                      }}</a>
                      <span class="muted"> #{{ r.strategyId }} · {{ r.symbol }}</span>
                    </td>
                    <td>{{ r.status }} / {{ r.lifecycleStage }}</td>
                    <td class="num">{{ r.executions }}</td>
                    <td class="num">{{ r.closed }}</td>
                    <td class="num">{{ r.open }}</td>
                    <td class="num">{{ r.expired }}</td>
                    <td class="num">{{ r.closed ? pct(r.wins / r.closed) : '—' }}</td>
                    <td class="num" [class.profit]="r.netPnl > 0" [class.loss]="r.netPnl < 0">
                      {{ money(r.netPnl, null, true) }}
                    </td>
                    <td>{{ ago(r.lastAtUtc) }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          <details>
            <summary>Newest {{ s.recentExecutions.length }} paper executions</summary>
            <div class="table-card">
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Strategy</th>
                    <th>Symbol</th>
                    <th>Side</th>
                    <th class="num">Lots</th>
                    <th class="num">Fill</th>
                    <th>Filled</th>
                    <th>Status</th>
                    <th>Exit</th>
                    <th class="num">Net P&amp;L</th>
                  </tr>
                </thead>
                <tbody>
                  @for (e of s.recentExecutions; track e.id) {
                    <tr>
                      <td class="mono">{{ e.id }}{{ e.isSynthetic ? ' (backfill)' : '' }}</td>
                      <td>
                        <a [routerLink]="['/strategies', e.strategyId]">#{{ e.strategyId }}</a>
                      </td>
                      <td>{{ e.symbol }}</td>
                      <td>{{ e.direction }}</td>
                      <td class="num">{{ e.lotSize }}</td>
                      <td class="num">{{ e.simulatedFillPrice }}</td>
                      <td>{{ day(e.simulatedFillAt) }}</td>
                      <td>{{ e.status }}</td>
                      <td>{{ e.exitReason ?? '—' }}</td>
                      <td
                        class="num"
                        [class.profit]="(e.netPnl ?? 0) > 0"
                        [class.loss]="(e.netPnl ?? 0) < 0"
                      >
                        {{ e.status === 'Closed' ? money(e.netPnl, null, true) : '—' }}
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </details>
        }
      } @else if (fallback(); as list) {
        <p class="muted">
          The paper summary is not available from this engine build yet. Strategies in a paper stage
          now:
        </p>
        @if (list.length === 0) {
          <p class="muted">
            None — a strategy paper-trades once it is Approved (Paused) or in the PaperTrading
            stage.
          </p>
        } @else {
          <ul>
            @for (s of list; track s.id) {
              <li>
                <a [routerLink]="['/strategies', s.id]">{{ s.name }}</a>
                <span class="muted"
                  >#{{ s.id }} · {{ s.symbol }} {{ s.timeframe }} · {{ s.status }} /
                  {{ s.lifecycleStage }}</span
                >
              </li>
            }
          </ul>
        }
      } @else {
        <p class="muted">Loading…</p>
      }
    </section>
  `,
  styles: [
    `
      .block {
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
      .muted {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
        margin: 0;
      }
      .table-card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow-x: auto;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-sm);
      }
      th,
      td {
        padding: 7px 10px;
        border-bottom: 1px solid var(--border);
        text-align: left;
        white-space: nowrap;
      }
      th {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        background: var(--bg-tertiary);
      }
      td.name {
        white-space: normal;
        min-width: 260px;
      }
      .num {
        text-align: right;
        font-variant-numeric: tabular-nums;
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
      details summary {
        cursor: pointer;
        font-size: var(--text-sm);
        color: var(--text-secondary);
        margin-bottom: var(--space-2);
      }
      ul {
        margin: 0;
        padding-left: 18px;
        font-size: var(--text-sm);
      }
      a {
        color: var(--accent);
        text-decoration: none;
      }
    `,
  ],
})
export class PaperTrackRecordComponent {
  private readonly paper = inject(PaperTradingService);
  private readonly strategies = inject(StrategiesService);

  protected readonly summary = signal<PaperExecutionSummaryDto | null>(null);
  protected readonly fallback = signal<StrategyDto[] | null>(null);
  protected readonly money = money;
  protected readonly ago = ago;
  protected readonly day = day;
  protected pct(v: number): string {
    return fractionPct(v, 0, false);
  }

  constructor() {
    this.paper
      .getExecutionSummary()
      .pipe(
        map((r) => (r?.status && r.data ? r.data : null)),
        catchError(() => of(null)),
      )
      .subscribe((s) => {
        this.summary.set(s);
        if (!s) this.loadFallback();
      });
  }

  private loadFallback(): void {
    this.strategies
      .list({ currentPage: 1, itemCountPerPage: 500, filter: null })
      .pipe(
        map((r) => r?.data?.data ?? []),
        catchError(() => of([] as StrategyDto[])),
      )
      .subscribe((rows) =>
        this.fallback.set(
          rows.filter(
            (s) =>
              s.lifecycleStage === 'PaperTrading' ||
              s.lifecycleStage === 'ShadowLive' ||
              (s.lifecycleStage === 'Approved' && s.status === 'Paused'),
          ),
        ),
      );
  }

  protected readonly tiles = computed<FactTile[]>(() => {
    const s = this.summary();
    if (!s) return [];
    return [
      {
        label: 'Paper executions',
        value: count(s.total),
        caption: `${s.closed} closed · ${s.open} open · ${s.expired} expired${s.synthetic ? ` · ${s.synthetic} backfilled` : ''}`,
      },
      {
        label: 'Strategies paper-trading',
        value: count(s.strategies.length),
        caption: `${s.strategiesInPaperStage} in a paper stage now`,
        route: '/strategies',
      },
      {
        label: 'Net P&L (closed)',
        value: money(s.netPnl, null, true),
        tone: s.netPnl > 0 ? 'good' : s.netPnl < 0 ? 'bad' : null,
        caption: 'simulated, after costs',
      },
      {
        label: 'Win rate',
        value: s.closed ? fractionPct(s.wins / s.closed, 1, false) : '—',
        caption: `${s.wins} of ${s.closed} closed`,
      },
      { label: 'Newest', value: ago(s.lastAtUtc), caption: day(s.lastAtUtc) },
    ];
  });
}
