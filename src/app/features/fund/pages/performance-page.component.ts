import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { catchError, forkJoin, map, of } from 'rxjs';

import { AuthService } from '@core/auth/auth.service';
import { Permission } from '@core/auth/permissions.generated';
import { NotificationService } from '@core/notifications/notification.service';
import { errorText } from '@features/iam/iam.logic';
import { saveBlob } from '@features/scripting/shared/download';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';

import { FundApiService } from '../fund-api.service';
import { performanceChart } from '../fund-charts';
import {
  MONTHS,
  dayLabel,
  defaultPeriod,
  flowSource,
  flowSourceChip,
  flowWhen,
  heatColor,
  isUpgradeNotice,
  ledgerSource,
  liveScopeAccounts,
  lossPct,
  matchPreset,
  minuteUtc,
  money,
  monthlyGrid,
  num,
  pct,
  periodLabel,
  periodPresets,
  periodQuery,
  signedAmount,
  signedPct,
  sparkline,
  tone,
  type PresetKey,
} from '../fund.logic';
import type {
  CashFlow,
  CashFlowKind,
  FundScope,
  FundScopeAccount,
  PerformanceStatement,
} from '../fund.types';

interface GlanceRow {
  account: FundScopeAccount;
  statement: PerformanceStatement | null;
  error: string | null;
}

/**
 * Performance statements (fund module): one account or one account group (portfolio) over a period —
 * time-weighted return, drawdown, Sharpe/Sortino, monthly returns, the external cash flows taken out of
 * the return — with PDF/CSV downloads. An Investor (granted on accounts or a group) sees only those.
 * Recording deposits/withdrawals needs `accounts.manage` on the account.
 */
@Component({
  selector: 'app-fund-performance-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, PageHeaderComponent, ConfirmDialogComponent, ChartCardComponent],
  styleUrls: ['../../iam/shared/iam-page.scss', './fund-page.scss', './performance-page.scss'],
  template: `
    <div class="page">
      <app-page-header
        title="Performance statements"
        subtitle="Time-weighted return, drawdown and risk-adjusted figures from the engine's own equity records."
      >
        @if (!upgrade()) {
          <button
            type="button"
            class="btn btn-secondary"
            [disabled]="!statement() || busy()"
            (click)="download('pdf')"
            title="Download this statement as a PDF"
          >
            ⤓ PDF
          </button>
          <button
            type="button"
            class="btn btn-secondary"
            [disabled]="!statement() || busy()"
            (click)="download('csv')"
            title="Download the daily series as CSV"
          >
            ⤓ CSV
          </button>
        }
      </app-page-header>

      @if (upgrade()) {
        <section class="card upgrade" role="status">
          <span class="chip warn">Not in your plan</span> {{ upgrade() }}
        </section>
      } @else {
        <!-- ── What to report on ─────────────────────────── -->
        <section class="card">
          <div class="query">
            <label class="field grow">
              <span class="label">Account or portfolio</span>
              <select
                class="select"
                name="subject"
                [ngModel]="subject()"
                (ngModelChange)="subject.set($event)"
              >
                @if (scope().accounts.length) {
                  <optgroup label="Accounts">
                    @for (a of scope().accounts; track a.id) {
                      <option [ngValue]="'a:' + a.id">
                        {{ a.accountId }} — {{ a.accountName }} · {{ a.broker }} ·
                        {{ a.accountType }}
                      </option>
                    }
                  </optgroup>
                }
                @if (scope().groups.length) {
                  <optgroup label="Portfolios">
                    @for (g of scope().groups; track g.id) {
                      <option [ngValue]="'g:' + g.id">
                        {{ g.name }} ({{ g.accounts }} accounts)
                      </option>
                    }
                  </optgroup>
                }
              </select>
            </label>
            <div class="field">
              <span class="label">Period</span>
              <div class="seg" role="group" aria-label="Quick periods">
                @for (p of presets; track p.key) {
                  <button
                    type="button"
                    [class.on]="preset() === p.key"
                    [attr.aria-pressed]="preset() === p.key"
                    (click)="applyPreset(p.key)"
                  >
                    {{ p.label }}
                  </button>
                }
                <button type="button" [class.on]="preset() === null" disabled>Custom</button>
              </div>
            </div>
            <label class="field date">
              <span class="label">From (UTC)</span>
              <input
                class="input"
                type="date"
                name="from"
                [ngModel]="from()"
                (ngModelChange)="from.set($event)"
              />
            </label>
            <label class="field date">
              <span class="label">To (not included)</span>
              <input
                class="input"
                type="date"
                name="to"
                [ngModel]="to()"
                (ngModelChange)="to.set($event)"
              />
            </label>
            <label class="field rf" title="Used for Sharpe and Sortino">
              <span class="label">Risk-free %/yr</span>
              <div class="suffix">
                <input
                  class="input"
                  type="number"
                  step="0.1"
                  name="rf"
                  [ngModel]="riskFree()"
                  (ngModelChange)="riskFree.set(+$event || 0)"
                />
                <span>%</span>
              </div>
            </label>
            <button
              type="button"
              class="btn btn-primary"
              [disabled]="loading() || !subject()"
              (click)="run()"
            >
              {{ loading() ? 'Loading…' : 'Show' }}
            </button>
          </div>
          @if (error()) {
            <p class="alert" role="alert"><strong>Could not load.</strong> {{ error() }}</p>
          }
          @if (scopeLoaded() && scope().accounts.length === 0 && scope().groups.length === 0) {
            <p class="empty">
              <strong>No accounts to report on</strong>
              Statements appear here for the trading accounts and portfolios you have been given
              access to.
            </p>
          }
        </section>

        <!-- ── Live accounts at a glance ─────────────────── -->
        @if (glance().length) {
          <section class="card">
            <div class="card-head">
              <h3>Live accounts</h3>
              <span class="count">{{ glance().length }}</span>
              <span class="hint"
                >{{ glancePeriod() }} · time-weighted, deposits and withdrawals taken out · click a
                row to open its statement</span
              >
            </div>
            <div class="table-wrap">
              <table class="grid">
                <thead>
                  <tr>
                    <th>Account</th>
                    <th class="num">Equity now</th>
                    <th class="num">Return</th>
                    <th class="num">Max drawdown</th>
                    <th class="num">Below peak now</th>
                    <th class="num">Sharpe</th>
                    <th class="num">Worst day</th>
                    <th>Trend</th>
                  </tr>
                </thead>
                <tbody>
                  @for (g of glance(); track g.account.id) {
                    <tr
                      class="pick"
                      [class.picked]="subject() === 'a:' + g.account.id"
                      (click)="pick(g.account.id)"
                    >
                      <td>
                        <span class="strong mono">{{ g.account.accountId }}</span>
                        {{ g.account.accountName }}
                        <span class="sub"
                          >{{ g.account.broker }} · {{ g.account.accountType }}</span
                        >
                      </td>
                      @if (g.statement; as st) {
                        <td class="num">
                          {{ money(st.endEquity) }}
                          <span class="sub">{{ st.currency }}</span>
                        </td>
                        <td class="num strong" [class]="tone(st.timeWeightedReturn)">
                          {{ signedPct(st.timeWeightedReturn) }}
                        </td>
                        <td class="num neg">{{ lossPct(st.maxDrawdown) }}</td>
                        <td class="num" [class.muted]="st.currentDrawdown === 0">
                          {{ lossPct(st.currentDrawdown) }}
                        </td>
                        <td class="num" [class]="tone(st.sharpe)">{{ num(st.sharpe) }}</td>
                        <td class="num">{{ signedPct(st.worstDay) }}</td>
                        <td>
                          <svg
                            class="spark"
                            [class.up]="(st.timeWeightedReturn ?? 0) >= 0"
                            viewBox="0 0 120 28"
                            preserveAspectRatio="none"
                            aria-hidden="true"
                          >
                            <polyline [attr.points]="spark(st)" />
                          </svg>
                        </td>
                      } @else {
                        <td colspan="7" class="small muted">{{ g.error ?? 'Loading…' }}</td>
                      }
                    </tr>
                  }
                </tbody>
              </table>
            </div>
            @if (otherAccounts() > 0) {
              <p class="foot">
                {{ otherAccounts() }} more account{{ otherAccounts() === 1 ? '' : 's' }} in your
                scope {{ otherAccounts() === 1 ? 'is' : 'are' }} inactive (no recent equity record)
                — pick one in the list above to see its history.
              </p>
            }
          </section>
        }

        @if (!statement() && loading()) {
          <section class="card"><p class="empty">Building the statement…</p></section>
        }

        @if (statement(); as s) {
          <!-- ── Headline ───────────────────────────────── -->
          <section class="card hero" [class.stale]="loading()">
            <div class="hero-main">
              <div>
                <h2>{{ s.scope }}</h2>
                <span class="sub"
                  >{{ statementPeriod() }} · {{ s.returnDays }} trading days ·
                  {{ s.currency }}</span
                >
              </div>
              <div class="hero-figure">
                <span class="k-label">Time-weighted return</span>
                <span class="big" [class]="tone(s.timeWeightedReturn)">{{
                  signedPct(s.timeWeightedReturn)
                }}</span>
                <span class="sub">
                  @if (s.annualisedReturn === null) {
                    Not annualised — under a year of history
                  } @else {
                    {{ signedPct(s.annualisedReturn) }} annualised
                  }
                </span>
              </div>
              <dl class="facts">
                <div>
                  <dt>Equity</dt>
                  <dd>{{ money(s.startEquity) }} → {{ money(s.endEquity) }}</dd>
                </div>
                <div>
                  <dt>Net deposits / withdrawals</dt>
                  <dd>{{ money(s.netFlows) }}</dd>
                </div>
              </dl>
            </div>
            <div class="kpis">
              <div class="kpi neg">
                <div class="k-label">Max drawdown</div>
                <div class="k-value neg">{{ lossPct(s.maxDrawdown) }}</div>
                <div class="k-hint">{{ drawdownStory() }}</div>
              </div>
              <div class="kpi" [class.warn]="s.currentDrawdown > 0">
                <div class="k-label">Below peak now</div>
                <div class="k-value">{{ lossPct(s.currentDrawdown) }}</div>
                <div class="k-hint">
                  {{ s.currentDrawdown > 0 ? 'still recovering' : 'at a new high' }}
                </div>
              </div>
              <div class="kpi">
                <div class="k-label">Volatility</div>
                <div class="k-value">{{ pct(s.annualisedVolatility) }}</div>
                <div class="k-hint">annualised, from daily returns</div>
              </div>
              <div class="kpi" [class]="tone(s.sharpe)">
                <div class="k-label">Sharpe</div>
                <div class="k-value">{{ num(s.sharpe) }}</div>
                <div class="k-hint">risk-free {{ s.riskFreeRatePct }} % a year</div>
              </div>
              <div class="kpi" [class]="tone(s.sortino)">
                <div class="k-label">Sortino</div>
                <div class="k-value">{{ num(s.sortino) }}</div>
                <div class="k-hint">counts only downside moves</div>
              </div>
              <div class="kpi">
                <div class="k-label">Positive days</div>
                <div class="k-value">{{ pct(s.positiveDayShare, 0) }}</div>
                <div class="k-hint">{{ positiveDays() }} of {{ s.returnDays }} days up</div>
              </div>
              <div class="kpi pos">
                <div class="k-label">Best day</div>
                <div class="k-value">{{ signedPct(s.bestDay) }}</div>
              </div>
              <div class="kpi neg">
                <div class="k-label">Worst day</div>
                <div class="k-value">{{ signedPct(s.worstDay) }}</div>
              </div>
            </div>
          </section>

          <app-chart-card
            title="Growth and drawdown"
            subtitle="Cumulative time-weighted return (top) and the fall from the running peak (bottom). Orange dots mark days with a deposit or withdrawal — not performance."
            height="340px"
            [options]="chartOptions()"
            [emptyMessage]="
              s.days.length < 2 ? 'Not enough days in the period to draw a chart.' : null
            "
          />

          <!-- ── Monthly returns ────────────────────────── -->
          <section class="card">
            <div class="card-head">
              <h3>Monthly returns</h3>
              <span class="hint">chain-linked within each calendar month (UTC)</span>
            </div>
            <div class="table-wrap">
              <table class="grid heat">
                <thead>
                  <tr>
                    <th>Year</th>
                    @for (m of months; track m) {
                      <th class="num">{{ m }}</th>
                    }
                    <th class="num">Year</th>
                  </tr>
                </thead>
                <tbody>
                  @for (row of grid(); track row.year) {
                    <tr>
                      <td class="strong">{{ row.year }}</td>
                      @for (v of row.months; track $index) {
                        <td class="num cell" [style.background]="heat(v)">
                          {{ v === null ? '·' : signedPct(v, 1) }}
                        </td>
                      }
                      <td class="num strong total" [class]="tone(row.total)">
                        {{ signedPct(row.total, 1) }}
                      </td>
                    </tr>
                  } @empty {
                    <tr>
                      <td colspan="14" class="empty">No returns in the period.</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </section>

          <!-- ── Cash flows ─────────────────────────────── -->
          <section class="card">
            <div class="card-head">
              <h3>Cash flows</h3>
              <div class="seg" role="tablist">
                <button
                  type="button"
                  role="tab"
                  [class.on]="tab() === 'period'"
                  (click)="flowTab.set('period')"
                >
                  In this statement <span class="n">{{ s.flows.length }}</span>
                </button>
                @if (accountId() !== null) {
                  <button
                    type="button"
                    role="tab"
                    [class.on]="tab() === 'ledger'"
                    (click)="flowTab.set('ledger')"
                  >
                    Account ledger <span class="n">{{ flows().length }}</span>
                  </button>
                }
              </div>
              <span class="spacer"></span>
              @if (accountId() !== null && canRecord()) {
                <button
                  type="button"
                  class="btn btn-sm"
                  [class.btn-secondary]="!recording()"
                  [class.btn-ghost]="recording()"
                  (click)="toggleRecording()"
                >
                  {{ recording() ? 'Close' : '+ Record a flow' }}
                </button>
              }
            </div>
            <p class="foot top">
              @if (tab() === 'period') {
                Deposits and withdrawals inside the period. They are taken out of the return, so
                adding or removing money never counts as performance.
              } @else {
                Every balance change on this account — reported by the EA from the broker, or
                entered by hand.
              }
            </p>

            @if (recording() && accountId() !== null && canRecord()) {
              <div class="record">
                <label class="field">
                  <span class="label">When (UTC)</span>
                  <input
                    class="input"
                    type="datetime-local"
                    name="flowAt"
                    [ngModel]="flowAt()"
                    (ngModelChange)="flowAt.set($event)"
                  />
                </label>
                <div class="field">
                  <span class="label">Kind</span>
                  <div class="seg" role="radiogroup" aria-label="Kind">
                    @for (k of kinds; track k) {
                      <button
                        type="button"
                        role="radio"
                        [class.on]="flowKind() === k"
                        [attr.aria-checked]="flowKind() === k"
                        (click)="flowKind.set(k)"
                      >
                        {{ k }}
                      </button>
                    }
                  </div>
                </div>
                <label class="field amount">
                  <span class="label">Amount</span>
                  <div class="suffix">
                    <input
                      class="input"
                      type="number"
                      step="0.01"
                      name="flowAmount"
                      [ngModel]="flowAmount()"
                      (ngModelChange)="flowAmount.set(+$event || 0)"
                    />
                    <span>{{ s.currency }}</span>
                  </div>
                </label>
                <label class="field grow">
                  <span class="label">Note</span>
                  <input
                    class="input"
                    name="flowNote"
                    placeholder="Optional — e.g. wire ref"
                    [ngModel]="flowNote()"
                    (ngModelChange)="flowNote.set($event)"
                  />
                </label>
                <button
                  type="button"
                  class="btn btn-primary"
                  [disabled]="busy() || !flowAt() || !flowAmount()"
                  (click)="confirmFlow.set(true)"
                >
                  Record…
                </button>
                <p class="foot full">
                  Withdrawals and fees are stored as negative amounts and deposits as positive; an
                  adjustment keeps the sign you type.
                </p>
              </div>
            }

            <div class="table-wrap">
              @if (tab() === 'period') {
                <table class="grid">
                  <thead>
                    <tr>
                      <th>When (UTC)</th>
                      <th>Account</th>
                      <th class="num">Amount</th>
                      <th>Source</th>
                      <th>Note</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (f of s.flows; track $index) {
                      <tr>
                        <td class="nowrap">{{ flowWhen(f) }}</td>
                        <td class="mono">#{{ f.tradingAccountId }}</td>
                        <td class="num strong" [class]="tone(f.amount)">
                          {{ money(f.amount) }}
                        </td>
                        <td>
                          @let chip = sourceChip(flowSource(f));
                          <span
                            class="pill"
                            [class.ok]="chip.tone === 'ok'"
                            [class.warn]="chip.tone === 'warn'"
                            [title]="chip.title"
                            >{{ chip.label }}</span
                          >
                        </td>
                        <td class="small">{{ f.note }}</td>
                      </tr>
                    } @empty {
                      <tr>
                        <td colspan="5" class="empty">
                          <strong>No deposits or withdrawals in this period</strong>
                          @if (accountId() !== null && flows().length) {
                            Earlier ones are on the account ledger.
                          }
                        </td>
                      </tr>
                    }
                  </tbody>
                </table>
              } @else {
                <table class="grid">
                  <thead>
                    <tr>
                      <th>When (UTC)</th>
                      <th>Kind</th>
                      <th class="num">Amount</th>
                      <th>Note</th>
                      <th>Source</th>
                      <th><span class="sr-only">Actions</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (f of flows(); track f.id) {
                      <tr>
                        <td class="nowrap">{{ minuteUtc(f.occurredAtUtc) }}</td>
                        <td>
                          <span class="pill" [class]="kindTone(f.kind)">{{ f.kind }}</span>
                        </td>
                        <td class="num strong" [class]="tone(f.amount)">
                          {{ money(f.amount) }}
                        </td>
                        <td class="small">{{ f.note }}</td>
                        <td class="small">
                          @if (f.brokerDealTicket) {
                            <span
                              class="pill ok"
                              title="The broker's own balance deal, reported by the EA"
                              >broker</span
                            >
                          }
                          {{ ledgerSource(f) }}
                        </td>
                        <td class="actions">
                          @if (canRecord()) {
                            <button
                              type="button"
                              class="btn btn-sm btn-ghost-danger"
                              [disabled]="busy()"
                              (click)="removing.set(f)"
                            >
                              Remove
                            </button>
                          }
                        </td>
                      </tr>
                    } @empty {
                      <tr>
                        <td colspan="6" class="empty">
                          <strong>Nothing recorded yet</strong>
                          The EA reports the broker's deposits, withdrawals and balance resets;
                          until it has, equity changes on days without positions are inferred as
                          flows.
                        </td>
                      </tr>
                    }
                  </tbody>
                </table>
              }
            </div>
          </section>

          <!-- ── Notes and methodology ──────────────────── -->
          <section class="card">
            <div class="card-head">
              <h3>About these figures</h3>
              <span class="hint">generated {{ minuteUtc(s.generatedAtUtc) }} UTC</span>
            </div>
            <div class="notes">
              @for (n of s.dataNotes; track $index) {
                <p class="callout">{{ n }}</p>
              } @empty {
                <p class="small muted">No data caveats for this statement.</p>
              }
            </div>
            @if (s.methodology.length) {
              <details class="method">
                <summary>
                  How these figures are calculated ({{ s.methodology.length }} notes)
                </summary>
                <ol>
                  @for (m of s.methodology; track $index) {
                    <li>{{ m }}</li>
                  }
                </ol>
              </details>
            }
          </section>
        }
      }

      <app-confirm-dialog
        [open]="confirmFlow()"
        title="Record this cash flow?"
        [message]="flowMessage()"
        confirmLabel="Record"
        [loading]="busy()"
        (confirm)="recordFlow()"
        (cancelled)="confirmFlow.set(false)"
      />
      <app-confirm-dialog
        [open]="removing() !== null"
        title="Remove this cash flow?"
        message="The statement will treat this money as performance again (or infer it on a flat day)."
        confirmLabel="Remove"
        confirmVariant="destructive"
        [loading]="busy()"
        (confirm)="removeFlow()"
        (cancelled)="removing.set(null)"
      />
    </div>
  `,
})
export class PerformancePageComponent {
  private readonly fund = inject(FundApiService);
  private readonly auth = inject(AuthService);
  private readonly notify = inject(NotificationService);

  protected readonly pct = pct;
  protected readonly num = num;
  protected readonly money = money;
  protected readonly minuteUtc = minuteUtc;
  protected readonly flowWhen = flowWhen;
  protected readonly flowSource = flowSource;
  protected readonly sourceChip = flowSourceChip;
  protected readonly ledgerSource = ledgerSource;
  protected readonly signedPct = signedPct;
  protected readonly lossPct = lossPct;
  protected readonly tone = tone;
  protected readonly months = MONTHS;
  protected readonly kinds: CashFlowKind[] = ['Deposit', 'Withdrawal', 'Fee', 'Adjustment'];
  protected readonly presets = periodPresets(new Date());

  readonly scope = signal<FundScope>({ accounts: [], groups: [], bestExecution: false });
  readonly scopeLoaded = signal(false);
  readonly subject = signal<string | null>(null);
  readonly from = signal(defaultPeriod(new Date(), 90).from);
  readonly to = signal(defaultPeriod(new Date(), 90).to);
  readonly riskFree = signal(0);
  readonly statement = signal<PerformanceStatement | null>(null);
  readonly flows = signal<CashFlow[]>([]);
  readonly loading = signal(false);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly upgrade = signal<string | null>(null);

  readonly flowAt = signal('');
  readonly flowKind = signal<CashFlowKind>('Deposit');
  readonly flowAmount = signal(0);
  readonly flowNote = signal('');
  readonly confirmFlow = signal(false);
  readonly removing = signal<CashFlow | null>(null);
  readonly recording = signal(false);
  readonly flowTab = signal<'period' | 'ledger'>('period');

  readonly glance = signal<GlanceRow[]>([]);
  readonly glancePeriod = signal('');
  private liveAccounts: FundScopeAccount[] = [];
  readonly otherAccounts = computed(() =>
    Math.max(0, this.scope().accounts.length - this.glance().length),
  );

  readonly preset = computed(() => matchPreset(this.from(), this.to(), new Date()));
  readonly accountId = computed(() => {
    const s = this.subject();
    return s?.startsWith('a:') ? Number(s.slice(2)) : null;
  });
  readonly groupId = computed(() => {
    const s = this.subject();
    return s?.startsWith('g:') ? Number(s.slice(2)) : null;
  });
  /** A portfolio has no single ledger, so it always shows the statement's flows. */
  readonly tab = computed(() => (this.accountId() === null ? 'period' : this.flowTab()));
  readonly canRecord = computed(() => this.auth.hasPermission(Permission.AccountsManage));
  readonly grid = computed(() => {
    const s = this.statement();
    return s ? monthlyGrid(s.months, s.years) : [];
  });
  private readonly heatMax = computed(() =>
    Math.max(0, ...(this.statement()?.months ?? []).map((m) => Math.abs(m.return))),
  );
  readonly chartOptions = computed(() => {
    const s = this.statement();
    return s ? performanceChart(s.days, s.currency) : {};
  });
  readonly statementPeriod = computed(() => {
    const s = this.statement();
    return s ? periodLabel(s.fromUtc, s.toUtc) : '';
  });
  readonly positiveDays = computed(() => {
    const s = this.statement();
    return s && s.positiveDayShare !== null ? Math.round(s.positiveDayShare * s.returnDays) : 0;
  });
  /** "Peak 24 Aug, trough 22 Sep · not recovered". */
  readonly drawdownStory = computed(() => {
    const s = this.statement();
    if (!s || !s.maxDrawdownTroughUtc) return 'no fall from a high in the period';
    const peak = s.maxDrawdownPeakUtc ? dayLabel(s.maxDrawdownPeakUtc, false) : 'start';
    const rec = s.maxDrawdownRecoveredUtc
      ? `recovered ${dayLabel(s.maxDrawdownRecoveredUtc, false)}`
      : 'not recovered yet';
    return `peak ${peak} → trough ${dayLabel(s.maxDrawdownTroughUtc, false)} · ${rec}`;
  });
  readonly flowMessage = computed(
    () =>
      `${this.flowKind()} of ${money(signedAmount(this.flowKind(), this.flowAmount()))} on ${this.flowAt().replace('T', ' ')} UTC. ` +
      'It is taken out of the account’s return from now on; the account itself is not touched.',
  );

  constructor() {
    // Open on the live accounts: a glance table of each one's statement, and the first one's full statement.
    this.fund.scope().subscribe({
      next: (s) => {
        this.scope.set(s);
        this.scopeLoaded.set(true);
        this.fund.activeAccountIds().subscribe((ids) => {
          const live = liveScopeAccounts(s.accounts, ids);
          this.liveAccounts = live;
          const first = live[0] ?? s.accounts[0];
          this.subject.set(first ? `a:${first.id}` : s.groups[0] ? `g:${s.groups[0].id}` : null);
          if (this.subject()) this.load();
          this.loadGlance(live);
        });
      },
      error: (e) => this.fail(e),
    });
  }

  private loadGlance(accounts: FundScopeAccount[]): void {
    const period = periodQuery(this.from(), this.to());
    if ('problem' in period || !accounts.length) return;
    this.glancePeriod.set(periodLabel(period.from, period.to));
    this.glance.set(accounts.map((account) => ({ account, statement: null, error: null })));
    forkJoin(
      accounts.map((account) =>
        this.fund
          .performance({ tradingAccountId: account.id, from: period.from, to: period.to })
          .pipe(
            map((statement): GlanceRow => ({ account, statement, error: null })),
            catchError((e) =>
              of<GlanceRow>({ account, statement: null, error: errorText(e, 'No statement.') }),
            ),
          ),
      ),
    ).subscribe((rows) => this.glance.set(rows));
  }

  /** Show: the chosen statement, and the live-account table for the same period. */
  run(): void {
    this.load();
    this.loadGlance(this.liveAccounts);
  }

  applyPreset(key: PresetKey): void {
    const p = this.presets.find((x) => x.key === key);
    if (!p) return;
    this.from.set(p.from);
    this.to.set(p.to);
    if (this.subject()) this.run();
  }

  pick(accountId: number): void {
    this.subject.set(`a:${accountId}`);
    this.load();
  }

  toggleRecording(): void {
    this.recording.update((r) => !r);
    if (this.recording()) this.flowTab.set('ledger');
  }

  heat(v: number | null): string | null {
    return heatColor(v, this.heatMax());
  }

  kindTone(kind: string): string {
    return kind === 'Deposit'
      ? 'ok'
      : kind === 'Withdrawal'
        ? 'bad'
        : kind === 'Fee'
          ? 'warn'
          : 'info';
  }

  spark(st: PerformanceStatement): string {
    return sparkline(
      st.days.map((d) => d.index),
      120,
      28,
    );
  }

  private params() {
    const period = periodQuery(this.from(), this.to());
    if ('problem' in period) {
      this.error.set(period.problem);
      return null;
    }
    return {
      tradingAccountId: this.accountId(),
      accountGroupId: this.groupId(),
      from: period.from,
      to: period.to,
      riskFreeRatePct: this.riskFree(),
    };
  }

  private fail(e: unknown): void {
    this.loading.set(false);
    this.busy.set(false);
    this.scopeLoaded.set(true);
    if (isUpgradeNotice(e))
      this.upgrade.set(errorText(e, 'Your plan does not include the fund module.'));
    else this.error.set(errorText(e, 'The statement could not be loaded.'));
  }

  load(): void {
    const params = this.params();
    if (!params) return;
    this.loading.set(true);
    this.error.set(null);
    this.fund.performance(params).subscribe({
      next: (s) => {
        this.statement.set(s);
        this.loading.set(false);
        this.loadFlows();
      },
      error: (e) => this.fail(e),
    });
  }

  private loadFlows(): void {
    const id = this.accountId();
    if (id === null) {
      this.flows.set([]);
      return;
    }
    this.fund
      .cashFlows(id)
      .subscribe({ next: (f) => this.flows.set(f), error: () => this.flows.set([]) });
  }

  download(format: 'pdf' | 'csv'): void {
    const params = this.params();
    if (!params) return;
    this.busy.set(true);
    this.fund.performanceExport(params, format).subscribe({
      next: (file) => {
        this.busy.set(false);
        saveBlob(file.blob, file.fileName);
      },
      error: (e) => {
        this.busy.set(false);
        this.notify.error(errorText(e, 'The download failed.'));
      },
    });
  }

  recordFlow(): void {
    const id = this.accountId();
    if (id === null || this.busy()) return;
    this.busy.set(true);
    this.fund
      .recordCashFlow(id, {
        occurredAtUtc: `${this.flowAt()}:00Z`,
        amount: signedAmount(this.flowKind(), this.flowAmount()),
        kind: this.flowKind(),
        note: this.flowNote().trim() || null,
      })
      .subscribe({
        next: () => {
          this.busy.set(false);
          this.confirmFlow.set(false);
          this.notify.success('Cash flow recorded.');
          this.load();
        },
        error: (e) => {
          this.busy.set(false);
          this.confirmFlow.set(false);
          this.notify.error(errorText(e, 'The cash flow was not recorded.'));
        },
      });
  }

  removeFlow(): void {
    const id = this.accountId();
    const flow = this.removing();
    if (id === null || !flow || this.busy()) return;
    this.busy.set(true);
    this.fund.removeCashFlow(id, flow.id, null).subscribe({
      next: () => {
        this.busy.set(false);
        this.removing.set(null);
        this.load();
      },
      error: (e) => {
        this.busy.set(false);
        this.removing.set(null);
        this.notify.error(errorText(e, 'The cash flow was not removed.'));
      },
    });
  }
}
