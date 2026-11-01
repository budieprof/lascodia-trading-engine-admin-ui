import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { catchError, map, of } from 'rxjs';

import {
  PaperTradingService,
  type PaperExecutionSummaryDto,
  type PaperStrategySummaryDto,
} from '@core/services/paper-trading.service';
import { StrategiesService } from '@core/services/strategies.service';
import type { StrategyDto } from '@core/api/api.types';
import {
  FactTilesComponent,
  type FactTile,
} from '@features/strategies/components/fact-tiles/fact-tiles.component';
import { ago, count, day, fractionPct, money } from '@features/strategies/util/figures';
import { enumLabel, statusTone } from '../paper-trading.logic';

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
        <span class="hint"
          >live signals of strategies in a paper stage, simulated at the engine's costs — last
          {{ summary()?.days ?? 90 }} days</span
        >
      </header>

      @if (summary(); as s) {
        <app-fact-tiles [tiles]="tiles()" />
        @if (s.strategies.length === 0) {
          <div class="empty">
            <strong>No paper execution in the window.</strong>
            A strategy paper-trades once it is Approved (and Paused) or put in the PaperTrading
            stage; {{ s.strategiesInPaperStage }} strateg{{
              s.strategiesInPaperStage === 1 ? 'y is' : 'ies are'
            }}
            in such a stage now.
          </div>
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
                  <th class="num">Last</th>
                </tr>
              </thead>
              <tbody>
                @for (r of s.strategies; track r.strategyId) {
                  <tr [class.gone]="!linkable(r)">
                    <td class="name">
                      @if (linkable(r)) {
                        <a
                          class="nm"
                          [routerLink]="['/strategies', r.strategyId]"
                          [title]="r.name ?? ''"
                          >{{ r.name ?? '#' + r.strategyId }}</a
                        >
                      } @else {
                        <span class="nm" [title]="r.name ?? ''">{{
                          r.name ?? '#' + r.strategyId
                        }}</span>
                      }
                      <span class="sub">#{{ r.strategyId }} · {{ r.symbol }}</span>
                    </td>
                    <td class="stage" [title]="r.status + ' / ' + r.lifecycleStage">
                      <span class="pill" [attr.data-tone]="statusTone(r.status)">{{
                        r.status
                      }}</span>
                      {{ enumLabel(r.lifecycleStage) }}
                    </td>
                    <td class="num">{{ r.executions }}</td>
                    <td class="num">{{ r.closed }}</td>
                    <td class="num" [class.dim]="r.open === 0">{{ r.open }}</td>
                    <td class="num" [class.dim]="r.expired === 0">{{ r.expired }}</td>
                    <td
                      class="num"
                      [title]="
                        r.closed ? r.wins + ' of ' + r.closed + ' closed won' : 'nothing closed'
                      "
                    >
                      {{ r.closed ? pct(r.wins / r.closed) : '—' }}
                    </td>
                    <td
                      class="num strong"
                      [class.profit]="r.netPnl > 0"
                      [class.loss]="r.netPnl < 0"
                    >
                      {{ r.closed ? money(r.netPnl, null, true) : '—' }}
                    </td>
                    <td class="num when" [title]="day(r.lastAtUtc)">{{ ago(r.lastAtUtc) }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          <details class="method">
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
                    <th>Filled (UTC)</th>
                    <th>Status</th>
                    <th>Exit</th>
                    <th class="num">Net P&amp;L</th>
                  </tr>
                </thead>
                <tbody>
                  @for (e of s.recentExecutions; track e.id) {
                    <tr>
                      <td class="mono">
                        {{ e.id }}
                        @if (e.isSynthetic) {
                          <span class="pill">backfill</span>
                        }
                      </td>
                      <td>
                        @if (deletedIds().has(e.strategyId)) {
                          #{{ e.strategyId }}
                        } @else {
                          <a [routerLink]="['/strategies', e.strategyId]">#{{ e.strategyId }}</a>
                        }
                      </td>
                      <td>{{ e.symbol }}</td>
                      <td>
                        <span
                          class="pill"
                          [attr.data-tone]="
                            e.direction === 'Buy' ? 'ok' : e.direction === 'Sell' ? 'bad' : null
                          "
                          >{{ e.direction }}</span
                        >
                      </td>
                      <td class="num">{{ e.lotSize }}</td>
                      <td class="num">{{ e.simulatedFillPrice }}</td>
                      <td>{{ day(e.simulatedFillAt) }}</td>
                      <td>{{ enumLabel(e.status) }}</td>
                      <td>{{ e.exitReason ? enumLabel(e.exitReason) : '—' }}</td>
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
        <p class="note">
          The paper summary is not available from this engine build yet. Strategies in a paper stage
          now:
        </p>
        @if (list.length === 0) {
          <div class="empty">
            <strong>None.</strong>
            A strategy paper-trades once it is Approved (Paused) or in the PaperTrading stage.
          </div>
        } @else {
          <ul>
            @for (s of list; track s.id) {
              <li>
                <a [routerLink]="['/strategies', s.id]">{{ s.name }}</a>
                <span class="hint"
                  >#{{ s.id }} · {{ s.symbol }} {{ s.timeframe }} · {{ s.status }} /
                  {{ s.lifecycleStage }}</span
                >
              </li>
            }
          </ul>
        }
      } @else {
        <p class="note">Loading…</p>
      }
    </section>
  `,
  styleUrl: './paper-track-record.component.scss',
})
export class PaperTrackRecordComponent {
  private readonly paper = inject(PaperTradingService);
  private readonly strategies = inject(StrategiesService);

  protected readonly summary = signal<PaperExecutionSummaryDto | null>(null);
  protected readonly fallback = signal<StrategyDto[] | null>(null);
  protected readonly money = money;
  protected readonly ago = ago;
  protected readonly day = day;
  protected readonly enumLabel = enumLabel;
  protected readonly statusTone = statusTone;
  /** A deleted strategy keeps its paper record but has no page (older engines only mark it in the name). */
  protected linkable(r: PaperStrategySummaryDto): boolean {
    return !r.strategyDeleted && !(r.name ?? '').endsWith('(deleted)');
  }
  protected readonly deletedIds = computed(
    () =>
      new Set(
        (this.summary()?.strategies ?? [])
          .filter((r) => !this.linkable(r))
          .map((r) => r.strategyId),
      ),
  );

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
