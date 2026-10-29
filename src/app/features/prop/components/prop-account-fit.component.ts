import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  signal,
  type OnInit,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

import { errorText } from '@features/iam/iam.logic';
import { isMissingEndpoint } from '@features/organisation/organisation.logic';
import { SparklineComponent } from '@shared/components/sparkline/sparkline.component';
import { PropApiService } from '../prop-api.service';
import { fitTally, fitVerdict, limitUse, useTone } from '../prop-overview.logic';
import { money, pct, phaseSummary, ruleLabel } from '../prop.logic';
import type { PropAccountFit, PropAccountFitReport } from '../prop.types';

/**
 * "How your accounts measure against the rules" (`GET prop/account-fit`): each active account's REAL equity record of
 * the last N days replayed through the engine's own rule evaluator as if it had started the phase then — against a
 * program's rules, or (no program yet) the editor's default FX two-step. Hypothetical, and labelled so everywhere.
 */
@Component({
  selector: 'app-prop-account-fit',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, SparklineComponent],
  styleUrl: '../../iam/shared/iam-page.scss',
  styles: [
    `
      .num {
        text-align: right;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }
      tr.fit-row {
        cursor: pointer;
      }
      tr.fit-row:hover td {
        background: var(--bg-tertiary);
      }
      .bar {
        height: 4px;
        border-radius: 2px;
        background: var(--bg-tertiary);
        margin-top: 3px;
        overflow: hidden;
      }
      .bar span {
        display: block;
        height: 100%;
        background: var(--profit, #1f9d55);
      }
      .bar[data-tone='warn'] span {
        background: #ff9500;
      }
      .bar[data-tone='bad'] span {
        background: var(--loss);
      }
      .rules {
        margin: 0;
        padding-left: var(--space-5);
        font-size: var(--text-xs);
        columns: 2 18rem;
      }
      .detail td {
        background: var(--bg-primary);
      }
      .detail ul {
        margin: 0 0 var(--space-2);
        padding-left: var(--space-5);
        font-size: var(--text-xs);
      }
      .pos {
        color: var(--profit, #1f9d55);
      }
      .neg {
        color: var(--loss);
      }
      @media (max-width: 900px) {
        .eq {
          display: none;
        }
      }
      details summary {
        cursor: pointer;
      }
    `,
  ],
  template: `
    <section class="card">
      <header class="card-head">
        <h3>How your accounts measure against {{ title() }}</h3>
        <span class="chip info" title="Nothing is enrolled, stored or halted">Hypothetical</span>
        <span class="spacer"></span>
        <label class="row small">
          Window
          <select
            class="select"
            name="fitDays"
            [ngModel]="days()"
            (ngModelChange)="setDays($event)"
          >
            <option [ngValue]="7">7 days</option>
            <option [ngValue]="30">30 days</option>
            <option [ngValue]="60">60 days</option>
            <option [ngValue]="90">90 days</option>
          </select>
        </label>
      </header>
      @if (missing()) {
        <p class="pad small muted">
          This panel replays your accounts' equity record through the rule evaluator; it needs the
          engine update that adds <code>GET prop/account-fit</code>.
        </p>
      } @else if (error(); as err) {
        <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
      } @else if (report(); as r) {
        <div class="card-body">
          <p class="small muted">
            Each active account is treated as if it had started the
            <strong>{{ r.phase.name }}</strong> phase {{ r.days }} days ago with its equity then as
            the initial balance, and its real equity record and trades since are judged by the same
            evaluator that judges live enrolments. Trading day resets {{ r.tradingDay.resetTime }}
            {{ r.tradingDay.timeZone }}.
          </p>
          <ul class="rules">
            @for (line of rules(); track line) {
              <li>{{ line }}</li>
            }
          </ul>
          <p class="small">
            <strong>{{ tally().Passed }}</strong> would have passed ·
            <strong>{{ tally().Failed }}</strong> would have failed ·
            <strong>{{ tally().Running }}</strong> no decision yet
            @if (tally().NoData) {
              · {{ tally().NoData }} without an equity record
            }
          </p>
        </div>
        <div class="table-wrap">
          <table class="grid">
            <thead>
              <tr>
                <th>Account</th>
                <th>Verdict</th>
                <th class="num" title="End equity vs the start, against the profit target">
                  Profit
                </th>
                <th
                  class="num"
                  title="Largest loss within one trading day, against the daily limit"
                >
                  Worst day
                </th>
                <th
                  class="num"
                  title="Deepest fall of equity below the start balance, against the drawdown limit"
                >
                  Max drawdown
                </th>
                <th class="num">Trading days</th>
                <th class="eq">Equity</th>
              </tr>
            </thead>
            <tbody>
              @for (a of r.accounts; track a.tradingAccountId) {
                <tr
                  class="fit-row"
                  (click)="toggle(a.tradingAccountId)"
                  [attr.aria-expanded]="open() === a.tradingAccountId"
                >
                  <td>
                    {{ a.accountLabel }}
                    <span class="sub">{{ a.accountType }} · {{ a.currency }}</span>
                  </td>
                  <td>
                    <span class="chip" [class]="'chip ' + verdict(a).tone">{{
                      verdict(a).label
                    }}</span>
                    @if (a.replay.failedRule) {
                      <span class="sub">{{ ruleLabel(a.replay.failedRule) }}</span>
                    }
                  </td>
                  <td
                    class="num"
                    [class.pos]="a.replay.profitPct > 0"
                    [class.neg]="a.replay.profitPct < 0"
                  >
                    {{ pct(a.replay.profitPct) }}
                    @if (a.replay.profitTargetPct !== null) {
                      <span class="sub">target {{ pct(a.replay.profitTargetPct, 0) }}</span>
                    }
                  </td>
                  <td class="num">
                    {{ pct(a.replay.worstDayLossPct) }}
                    @if (a.replay.dailyLossLimitPct !== null) {
                      <span class="sub">limit {{ pct(a.replay.dailyLossLimitPct, 0) }}</span>
                      <div
                        class="bar"
                        [attr.data-tone]="
                          tone(a.replay.worstDayLossPct, a.replay.dailyLossLimitPct)
                        "
                      >
                        <span
                          [style.width.%]="
                            width(a.replay.worstDayLossPct, a.replay.dailyLossLimitPct)
                          "
                        ></span>
                      </div>
                    }
                  </td>
                  <td class="num">
                    {{ pct(a.replay.maxDrawdownFromInitialPct) }}
                    @if (a.replay.drawdownLimitPct !== null) {
                      <span class="sub">limit {{ pct(a.replay.drawdownLimitPct, 0) }}</span>
                      <div
                        class="bar"
                        [attr.data-tone]="
                          tone(a.replay.maxDrawdownFromInitialPct, a.replay.drawdownLimitPct)
                        "
                      >
                        <span
                          [style.width.%]="
                            width(a.replay.maxDrawdownFromInitialPct, a.replay.drawdownLimitPct)
                          "
                        ></span>
                      </div>
                    }
                  </td>
                  <td class="num">
                    {{ a.replay.tradingDays }}
                    @if (a.replay.minTradingDays) {
                      <span class="sub">{{ a.replay.minTradingDays }} needed</span>
                    }
                  </td>
                  <td class="eq">
                    <app-sparkline
                      [data]="curve(a)"
                      width="120px"
                      height="28px"
                      [color]="curveColor(a)"
                    />
                  </td>
                </tr>
                @if (open() === a.tradingAccountId) {
                  <tr class="detail">
                    <td colspan="7">
                      @if (a.replay.failedDetail) {
                        <p class="small"><strong>Why:</strong> {{ a.replay.failedDetail }}</p>
                      }
                      <p class="small muted">
                        Measured {{ day(a.replay.measuredFromUtc) }} →
                        {{ day(a.replay.measuredToUtc) }} from
                        {{ a.replay.points.toLocaleString('en-US') }} equity readings · start
                        {{ money(a.replay.initialBalance) }} → end equity
                        {{ money(a.replay.endEquity) }} · deepest fall from the running peak
                        {{ pct(a.replay.maxDrawdownFromPeakPct) }} of the start
                        @if (a.replay.profitTargetReachedAtUtc) {
                          · profit target first reached {{ day(a.replay.profitTargetReachedAtUtc) }}
                        }
                      </p>
                      @if (a.replay.notes.length) {
                        <ul>
                          @for (n of a.replay.notes; track $index) {
                            <li>{{ n }}</li>
                          }
                        </ul>
                      }
                      @if (a.replay.days.length) {
                        <table class="grid">
                          <thead>
                            <tr>
                              <th>Trading day</th>
                              <th class="num">Start</th>
                              <th class="num">Low</th>
                              <th class="num">End</th>
                              <th class="num">Day loss</th>
                              <th class="num">Realised</th>
                              <th class="num">Opened</th>
                            </tr>
                          </thead>
                          <tbody>
                            @for (d of a.replay.days; track d.day) {
                              <tr>
                                <td>{{ d.day }}</td>
                                <td class="num">{{ money(d.startEquity) }}</td>
                                <td class="num">{{ money(d.minEquity) }}</td>
                                <td class="num">{{ money(d.endEquity) }}</td>
                                <td
                                  class="num"
                                  [class.neg]="d.lossPct >= (a.replay.dailyLossLimitPct ?? 1e9)"
                                >
                                  {{ pct(d.lossPct) }}
                                </td>
                                <td
                                  class="num"
                                  [class.pos]="d.realizedPnl > 0"
                                  [class.neg]="d.realizedPnl < 0"
                                >
                                  {{ money(d.realizedPnl) }}
                                </td>
                                <td class="num">{{ d.positionsOpened }}</td>
                              </tr>
                            }
                          </tbody>
                        </table>
                      }
                    </td>
                  </tr>
                }
              } @empty {
                <tr>
                  <td colspan="7" class="muted">
                    No active trading account to measure. Accounts appear when an EA terminal signs
                    in.
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
        <details class="pad small muted">
          <summary>How this is computed</summary>
          <ul>
            @for (m of r.methodology; track $index) {
              <li>{{ m }}</li>
            }
          </ul>
        </details>
      } @else {
        <p class="pad muted small">Replaying the accounts' equity record…</p>
      }
    </section>
  `,
})
export class PropAccountFitComponent implements OnInit {
  private readonly api = inject(PropApiService);

  /** Measure against this program's rules; null = the editor's default FX two-step rules. */
  readonly programId = input<number | null>(null);
  /** Load on first render (a page that shows this only once its own data arrived). */
  readonly autoload = input(false);

  ngOnInit(): void {
    if (this.autoload()) this.load();
  }

  protected readonly money = money;
  protected readonly pct = pct;
  protected readonly ruleLabel = ruleLabel;

  readonly days = signal(30);
  readonly report = signal<PropAccountFitReport | null>(null);
  readonly error = signal<string | null>(null);
  readonly missing = signal(false);
  readonly open = signal<number | null>(null);

  readonly title = computed(() => {
    const r = this.report();
    if (!r) return 'the rules';
    return r.programId === null ? 'the default FX two-step rules' : r.rulesName;
  });
  readonly rules = computed(() => {
    const r = this.report();
    return r ? phaseSummary(r.phase) : [];
  });
  readonly tally = computed(() => fitTally(this.report()?.accounts ?? []));

  private program: number | null = null;

  /** Loads (again); `programId` overrides the input (a page that learns its program late passes it here). */
  load(programId: number | null = this.programId()): void {
    this.program = programId;
    this.error.set(null);
    this.report.set(null);
    this.api.accountFit(this.days(), programId).subscribe({
      next: (r) => this.report.set(r),
      error: (e) => {
        if (isMissingEndpoint(e)) this.missing.set(true);
        else this.error.set(errorText(e, 'The accounts could not be measured.'));
      },
    });
  }

  setDays(d: number): void {
    this.days.set(d);
    this.load(this.program);
  }

  toggle(id: number): void {
    this.open.update((o) => (o === id ? null : id));
  }

  verdict(a: PropAccountFit) {
    return fitVerdict(a.replay);
  }

  tone(value: number, limit: number | null) {
    return useTone(limitUse(value, limit));
  }

  width(value: number, limit: number | null): number {
    return Math.min(100, limitUse(value, limit) ?? 0);
  }

  curve(a: PropAccountFit): number[] {
    return a.replay.curve.map((p) => p.equity);
  }

  curveColor(a: PropAccountFit): string {
    return a.replay.outcome === 'Failed'
      ? '#ff3b30'
      : a.replay.profitPct >= 0
        ? '#34c759'
        : '#ff9500';
  }

  day(iso: string | null): string {
    return iso ? iso.slice(0, 16).replace('T', ' ') : '—';
  }
}
