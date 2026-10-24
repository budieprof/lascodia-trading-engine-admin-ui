import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';

import { ThemeService } from '@core/theme/theme.service';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import { when } from '@features/iam/iam.logic';
import { curveOption, limitTiles, money, pct, phaseSummary, ruleLabel, stateClass } from '../prop.logic';
import type { PropDashboard } from '../prop.types';
import { PROP_DIALOG_STYLES } from './prop-gate.component';

/**
 * One enrolment's dashboard (the trader's and the firm's view): state and outcome, the remaining daily
 * loss, the distance to the drawdown limit, trading days and consistency, the equity curve against
 * the rule lines, the trading days, the rule events and (funded) the payout statements.
 */
@Component({
  selector: 'app-prop-dashboard-view',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ChartCardComponent],
  styleUrl: '../../iam/shared/iam-page.scss',
  styles: [
    PROP_DIALOG_STYLES,
    `
      .tiles {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
        gap: var(--space-3);
      }
      .tile {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-3) var(--space-4);
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .tile .v {
        font-size: var(--text-lg);
        font-weight: var(--font-semibold);
        font-variant-numeric: tabular-nums;
      }
      .tile.ok .v {
        color: var(--profit, #1f9d55);
      }
      .tile.warn .v {
        color: #b25000;
      }
      .tile.bad .v {
        color: var(--loss);
      }
      ul.rules {
        margin: 0;
        padding-left: var(--space-5);
        font-size: var(--text-sm);
      }
    `,
  ],
  template: `
    @let d = dashboard();
    @let e = d.enrollment;
    <section class="card">
      <header class="card-head">
        <h3>{{ e.traderName }} — {{ e.programName }} · {{ e.phaseName }}</h3>
        <span class="chip" [class]="'chip ' + stateClass(e.state)">{{ e.state }}</span>
        @if (!d.dataFresh && (e.state === 'Active' || e.state === 'Funded')) {
          <span class="chip warn" title="The account's EA has not reported recently; equity rules wait for it.">
            Account data stale
          </span>
        }
        <span class="spacer"></span>
        <span class="muted small">{{ e.accountLabel }} · v{{ e.programVersion }} · started {{ when(e.startedAtUtc) }}</span>
      </header>
      <div class="card-body">
        @if (e.state === 'Failed') {
          <p class="note warn" role="status">
            <strong>Failed — {{ ruleLabel(e.failedRule) }}</strong> at {{ when(e.failedAtUtc) }}:
            {{ e.failedDetail }}
            @if (e.haltRequired) {
              <br />
              {{
                e.haltAppliedAtUtc
                  ? "The account's kill switch was engaged at " + when(e.haltAppliedAtUtc) + ' (no new orders; open positions were not closed).'
                  : "Halting the account is pending" + (e.haltLastError ? ': ' + e.haltLastError : '.')
              }}
            }
          </p>
        } @else if (e.state === 'Passed') {
          <p class="note" role="status">
            Passed at {{ when(e.passedAtUtc) }}.
            @if (e.canAdvance) {
              The firm can move the trader to the next phase.
            }
          </p>
        }
        <div class="tiles">
          @for (t of tiles(); track t.label) {
            <div class="tile" [class.ok]="t.tone === 'ok'" [class.warn]="t.tone === 'warn'" [class.bad]="t.tone === 'bad'">
              <span class="label">{{ t.label }}</span>
              <span class="v">{{ t.value }}</span>
              <span class="muted small">{{ t.hint }}</span>
            </div>
          }
        </div>
        <p class="muted small">
          Balance {{ money(d.metrics.balance) }} · equity {{ money(d.metrics.equity) }} · initial
          {{ money(d.metrics.initialBalance) }} · high-water mark {{ money(d.metrics.highWaterMark) }}
          @if (d.metrics.timeLimitEndsAtUtc) {
            · time limit ends {{ when(d.metrics.timeLimitEndsAtUtc) }}
          }
          · trading day resets {{ d.tradingDay.resetTime }} {{ d.tradingDay.timeZone }}
        </p>
      </div>
    </section>

    <app-chart-card
      title="Equity vs rule lines"
      subtitle="Equity and balance as the account's EA reported them, with the drawdown floor, the day's loss floor and the profit target."
      [options]="chart()"
      height="320px"
      [emptyMessage]="d.curve.length ? null : 'No equity reports yet for this enrolment.'"
    />

    <section class="card">
      <header class="card-head"><h3>Rules of this phase</h3></header>
      <div class="card-body">
        <ul class="rules">
          @for (line of rules(); track line) {
            <li>{{ line }}</li>
          } @empty {
            <li>No limits set.</li>
          }
        </ul>
      </div>
    </section>

    <section class="card">
      <header class="card-head"><h3>Trading days</h3></header>
      <div class="table-wrap">
        <table class="grid">
          <thead>
            <tr>
              <th>Day</th>
              <th class="num">Start balance</th>
              <th class="num">Lowest equity</th>
              <th class="num">Daily floor</th>
              <th class="num">Realised P&amp;L</th>
              <th class="num">Opened</th>
              <th>Traded</th>
            </tr>
          </thead>
          <tbody>
            @for (day of days(); track day.day) {
              <tr>
                <td>{{ day.day }} @if (!day.observed) {<span class="sub">filled in</span>}</td>
                <td class="num">{{ money(day.startBalance) }}</td>
                <td class="num" [class.neg]="day.dailyLossFloor !== null && day.minEquity <= day.dailyLossFloor">
                  {{ money(day.minEquity) }}
                </td>
                <td class="num">{{ money(day.dailyLossFloor) }}</td>
                <td class="num" [class.pos]="day.realizedPnl > 0" [class.neg]="day.realizedPnl < 0">{{ money(day.realizedPnl) }}</td>
                <td class="num">{{ day.positionsOpened }}</td>
                <td>{{ day.traded ? 'yes' : '—' }}</td>
              </tr>
            } @empty {
              <tr><td colspan="7" class="muted">No trading day recorded yet.</td></tr>
            }
          </tbody>
        </table>
      </div>
    </section>

    <section class="card">
      <header class="card-head"><h3>Rule events</h3></header>
      <div class="table-wrap">
        <table class="grid">
          <tbody>
            @for (b of d.events; track b.id) {
              <tr>
                <td><span class="chip" [class.bad]="b.severity === 'Breach'" [class.warn]="b.severity === 'Warning'">{{ b.severity }}</span></td>
                <td>{{ ruleLabel(b.rule) }}</td>
                <td>{{ b.detail }}</td>
                <td class="muted small">{{ when(b.occurredAtUtc) }}</td>
              </tr>
            } @empty {
              <tr><td class="muted">No rule was broken.</td></tr>
            }
          </tbody>
        </table>
      </div>
    </section>

    @if (d.payouts.length) {
      <section class="card">
        <header class="card-head"><h3>Payout statements</h3></header>
        <div class="table-wrap">
          <table class="grid">
            <thead>
              <tr><th>Period</th><th class="num">Gross</th><th class="num">Net to trader</th><th>Status</th></tr>
            </thead>
            <tbody>
              @for (p of d.payouts; track p.id) {
                <tr>
                  <td>{{ when(p.periodStartUtc) }} – {{ when(p.periodEndUtc) }}</td>
                  <td class="num">{{ money(p.grossProfit, p.currency) }}</td>
                  <td class="num">{{ money(p.netPayout, p.currency) }}</td>
                  <td>{{ p.status }}</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      </section>
    }
  `,
})
export class PropDashboardViewComponent {
  private readonly theme = inject(ThemeService);

  readonly dashboard = input.required<PropDashboard>();

  protected readonly when = when;
  protected readonly money = money;
  protected readonly pct = pct;
  protected readonly ruleLabel = ruleLabel;
  protected readonly stateClass = stateClass;

  readonly tiles = computed(() => limitTiles(this.dashboard().metrics));
  readonly rules = computed(() => phaseSummary(this.dashboard().phase));
  readonly days = computed(() => [...this.dashboard().days].reverse());
  readonly chart = computed(() => curveOption(this.dashboard(), this.theme.theme() === 'dark'));
}
