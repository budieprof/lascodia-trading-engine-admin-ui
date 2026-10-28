import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { catchError, forkJoin, map, of } from 'rxjs';

import { AuthService } from '@core/auth/auth.service';
import { Permission } from '@core/auth/permissions.generated';
import { NotificationService } from '@core/notifications/notification.service';
import { errorText } from '@features/iam/iam.logic';
import { saveBlob } from '@features/scripting/shared/download';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';

import { FundApiService } from '../fund-api.service';
import {
  MONTHS,
  day,
  defaultPeriod,
  isUpgradeNotice,
  liveScopeAccounts,
  money,
  monthlyGrid,
  num,
  pct,
  periodQuery,
  signedAmount,
  sparkline,
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
  imports: [FormsModule, PageHeaderComponent, ConfirmDialogComponent],
  styleUrls: ['../../iam/shared/iam-page.scss', './fund-page.scss'],
  styles: [
    `
      tr.pick {
        cursor: pointer;
      }
      tr.pick:hover td,
      tr.picked td {
        background: var(--bg-tertiary);
      }
      .spark {
        width: 120px;
        height: 28px;
        display: block;
      }
      .spark polyline {
        fill: none;
        stroke: var(--accent, #2563eb);
        stroke-width: 1.5;
      }
    `,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Performance"
        subtitle="Time-weighted return, drawdown and risk-adjusted figures from the engine's own equity records."
      />

      @if (upgrade()) {
        <section class="card upgrade" role="status">
          <span class="chip warn">Not in your plan</span> {{ upgrade() }}
        </section>
      } @else {
        <section class="card">
          <div class="filters">
            <label class="field">
              <span class="label">Account or portfolio</span>
              <select
                class="select"
                name="subject"
                [ngModel]="subject()"
                (ngModelChange)="subject.set($event)"
              >
                @for (a of scope().accounts; track a.id) {
                  <option [ngValue]="'a:' + a.id">
                    {{ a.accountId }} · {{ a.broker }} · {{ a.accountType }}
                  </option>
                }
                @for (g of scope().groups; track g.id) {
                  <option [ngValue]="'g:' + g.id">
                    Portfolio: {{ g.name }} ({{ g.accounts }})
                  </option>
                }
              </select>
            </label>
            <label class="field">
              <span class="label">From (UTC)</span>
              <input
                class="input"
                type="date"
                name="from"
                [ngModel]="from()"
                (ngModelChange)="from.set($event)"
              />
            </label>
            <label class="field">
              <span class="label">To (UTC, exclusive)</span>
              <input
                class="input"
                type="date"
                name="to"
                [ngModel]="to()"
                (ngModelChange)="to.set($event)"
              />
            </label>
            <label class="field">
              <span class="label">Risk-free rate (% a year)</span>
              <input
                class="input"
                type="number"
                step="0.1"
                name="rf"
                [ngModel]="riskFree()"
                (ngModelChange)="riskFree.set(+$event || 0)"
              />
            </label>
            <button
              type="button"
              class="btn btn-primary"
              [disabled]="loading() || !subject()"
              (click)="load()"
            >
              {{ loading() ? 'Loading…' : 'Show' }}
            </button>
            <button
              type="button"
              class="btn btn-secondary"
              [disabled]="!statement() || busy()"
              (click)="download('pdf')"
            >
              PDF
            </button>
            <button
              type="button"
              class="btn btn-secondary"
              [disabled]="!statement() || busy()"
              (click)="download('csv')"
            >
              CSV
            </button>
          </div>
          @if (error()) {
            <p class="pad" role="alert">
              <span class="chip bad">Could not load</span> {{ error() }}
            </p>
          }
          @if (scopeLoaded() && scope().accounts.length === 0 && scope().groups.length === 0) {
            <p class="pad muted">You have no accounts to report on.</p>
          }
        </section>

        @if (glance().length) {
          <section class="card">
            <div class="card-head">
              <strong>Live accounts at a glance</strong>
              <span class="muted small"
                >{{ glancePeriod() }} · time-weighted, deposits and withdrawals taken out · click a
                row for its statement</span
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
                    <th class="num">In drawdown now</th>
                    <th class="num">Sharpe</th>
                    <th class="num">Worst day</th>
                    <th>Growth of 1</th>
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
                        {{ g.account.accountId }} · {{ g.account.accountName }}
                        <div class="small muted">
                          {{ g.account.broker }} · {{ g.account.accountType }}
                        </div>
                      </td>
                      @if (g.statement; as st) {
                        <td class="num">{{ money(st.endEquity) }} {{ st.currency }}</td>
                        <td
                          class="num"
                          [class.pos]="(st.timeWeightedReturn ?? 0) > 0"
                          [class.neg]="(st.timeWeightedReturn ?? 0) < 0"
                        >
                          {{ pct(st.timeWeightedReturn) }}
                        </td>
                        <td class="num neg">{{ pct(st.maxDrawdown) }}</td>
                        <td class="num">{{ pct(st.currentDrawdown) }}</td>
                        <td class="num">{{ num(st.sharpe) }}</td>
                        <td class="num">{{ pct(st.worstDay) }}</td>
                        <td>
                          <svg
                            class="spark"
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
              <p class="pad small muted">
                {{ otherAccounts() }} more account(s) in your scope are inactive (no recent equity
                record) — pick one in the list above to see its history.
              </p>
            }
          </section>
        }

        @if (statement(); as s) {
          <section class="card">
            <div class="card-head">
              <strong>{{ s.scope }}</strong> <span class="muted small">· {{ s.currency }}</span>
            </div>
            <div class="tiles">
              <div class="tile">
                <div class="tile-label">Time-weighted return</div>
                <div
                  class="tile-value"
                  [class.pos]="(s.timeWeightedReturn ?? 0) > 0"
                  [class.neg]="(s.timeWeightedReturn ?? 0) < 0"
                >
                  {{ pct(s.timeWeightedReturn) }}
                </div>
              </div>
              <div class="tile">
                <div class="tile-label">Annualised</div>
                <div class="tile-value">
                  {{ s.annualisedReturn === null ? 'n/a (< 1 year)' : pct(s.annualisedReturn) }}
                </div>
              </div>
              <div class="tile">
                <div class="tile-label">Max drawdown</div>
                <div class="tile-value neg">{{ pct(s.maxDrawdown) }}</div>
              </div>
              <div class="tile">
                <div class="tile-label">Volatility (ann.)</div>
                <div class="tile-value">{{ pct(s.annualisedVolatility) }}</div>
              </div>
              <div class="tile">
                <div class="tile-label">Sharpe</div>
                <div class="tile-value">{{ num(s.sharpe) }}</div>
              </div>
              <div class="tile">
                <div class="tile-label">Sortino</div>
                <div class="tile-value">{{ num(s.sortino) }}</div>
              </div>
              <div class="tile">
                <div class="tile-label">Start → end equity</div>
                <div class="tile-value small">
                  {{ money(s.startEquity) }} → {{ money(s.endEquity) }}
                </div>
              </div>
              <div class="tile">
                <div class="tile-label">Net external flows</div>
                <div class="tile-value">{{ money(s.netFlows) }}</div>
              </div>
              <div class="tile">
                <div class="tile-label">Positive days</div>
                <div class="tile-value">{{ pct(s.positiveDayShare, 0) }} of {{ s.returnDays }}</div>
              </div>
            </div>
            <div class="pad">
              <div class="small muted">Time-weighted index</div>
              <svg
                class="chart"
                viewBox="0 0 600 120"
                preserveAspectRatio="none"
                role="img"
                aria-label="Time-weighted index"
              >
                <polyline [attr.points]="indexLine()" />
              </svg>
              <div class="small muted">
                Drawdown (peak
                {{ day(s.maxDrawdownPeakUtc) === '—' ? 'start' : day(s.maxDrawdownPeakUtc) }},
                trough {{ day(s.maxDrawdownTroughUtc) }}, recovered
                {{
                  s.maxDrawdownTroughUtc
                    ? s.maxDrawdownRecoveredUtc
                      ? day(s.maxDrawdownRecoveredUtc)
                      : 'not yet'
                    : '—'
                }})
              </div>
              <svg
                class="chart dd"
                viewBox="0 0 600 120"
                preserveAspectRatio="none"
                role="img"
                aria-label="Drawdown"
              >
                <polyline [attr.points]="drawdownLine()" />
              </svg>
            </div>
          </section>

          <section class="card">
            <div class="card-head"><strong>Monthly returns</strong></div>
            <div class="table-wrap">
              <table class="grid">
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
                      <td>{{ row.year }}</td>
                      @for (v of row.months; track $index) {
                        <td class="num" [class.pos]="(v ?? 0) > 0" [class.neg]="(v ?? 0) < 0">
                          {{ v === null ? '' : pct(v, 1) }}
                        </td>
                      }
                      <td class="num">
                        <strong>{{ pct(row.total, 1) }}</strong>
                      </td>
                    </tr>
                  } @empty {
                    <tr>
                      <td colspan="14" class="muted">No returns in the period.</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </section>

          <section class="card">
            <div class="card-head">
              <strong>External cash flows</strong>
              <span class="muted small">taken out of the return</span>
            </div>
            <div class="table-wrap">
              <table class="grid">
                <thead>
                  <tr>
                    <th>Day</th>
                    <th>Account</th>
                    <th class="num">Amount</th>
                    <th>Source</th>
                    <th>Note</th>
                  </tr>
                </thead>
                <tbody>
                  @for (f of s.flows; track $index) {
                    <tr>
                      <td>{{ day(f.dayUtc) }}</td>
                      <td>#{{ f.tradingAccountId }}</td>
                      <td class="num">{{ money(f.amount) }}</td>
                      <td>
                        @if (f.inferred) {
                          <span class="chip warn">inferred</span>
                        } @else {
                          <span class="chip">recorded</span>
                        }
                      </td>
                      <td class="small">{{ f.note }}</td>
                    </tr>
                  } @empty {
                    <tr>
                      <td colspan="5" class="muted">None in the period.</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </section>

          @if (accountId(); as accountId) {
            <section class="card">
              <div class="card-head"><strong>Recorded deposits and withdrawals</strong></div>
              @if (canRecord()) {
                <div class="filters">
                  <label class="field"
                    ><span class="label">When (UTC)</span>
                    <input
                      class="input"
                      type="datetime-local"
                      name="flowAt"
                      [ngModel]="flowAt()"
                      (ngModelChange)="flowAt.set($event)"
                  /></label>
                  <label class="field"
                    ><span class="label">Kind</span>
                    <select
                      class="select"
                      name="flowKind"
                      [ngModel]="flowKind()"
                      (ngModelChange)="flowKind.set($event)"
                    >
                      @for (k of kinds; track k) {
                        <option [ngValue]="k">{{ k }}</option>
                      }
                    </select></label
                  >
                  <label class="field"
                    ><span class="label">Amount ({{ s.currency }})</span>
                    <input
                      class="input"
                      type="number"
                      step="0.01"
                      name="flowAmount"
                      [ngModel]="flowAmount()"
                      (ngModelChange)="flowAmount.set(+$event || 0)"
                  /></label>
                  <label class="field"
                    ><span class="label">Note</span>
                    <input
                      class="input"
                      name="flowNote"
                      [ngModel]="flowNote()"
                      (ngModelChange)="flowNote.set($event)"
                  /></label>
                  <button
                    type="button"
                    class="btn btn-secondary"
                    [disabled]="busy() || !flowAt() || !flowAmount()"
                    (click)="confirmFlow.set(true)"
                  >
                    Record
                  </button>
                </div>
              }
              <div class="table-wrap">
                <table class="grid">
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>Kind</th>
                      <th class="num">Amount</th>
                      <th>Note</th>
                      <th>Recorded by</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (f of flows(); track f.id) {
                      <tr>
                        <td>{{ f.occurredAtUtc.slice(0, 16).replace('T', ' ') }}</td>
                        <td>{{ f.kind }}</td>
                        <td class="num">{{ money(f.amount) }}</td>
                        <td class="small">{{ f.note }}</td>
                        <td class="small">{{ f.recordedBy }}</td>
                        <td class="actions">
                          @if (canRecord()) {
                            <button
                              type="button"
                              class="btn btn-sm btn-secondary"
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
                        <td colspan="6" class="muted">
                          Nothing recorded. Equity changes on days without positions are inferred as
                          flows.
                        </td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            </section>
          }

          <section class="card">
            <div class="card-head"><strong>Data notes and methodology</strong></div>
            <ul class="pad notes small">
              @for (n of s.dataNotes; track $index) {
                <li>
                  <strong>{{ n }}</strong>
                </li>
              }
              @for (m of s.methodology; track $index) {
                <li>{{ m }}</li>
              }
            </ul>
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
  protected readonly day = day;
  protected readonly months = MONTHS;
  protected readonly kinds: CashFlowKind[] = ['Deposit', 'Withdrawal', 'Fee', 'Adjustment'];

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

  readonly glance = signal<GlanceRow[]>([]);
  readonly glancePeriod = signal('');
  readonly otherAccounts = computed(() =>
    Math.max(0, this.scope().accounts.length - this.glance().length),
  );

  readonly accountId = computed(() => {
    const s = this.subject();
    return s?.startsWith('a:') ? Number(s.slice(2)) : null;
  });
  readonly groupId = computed(() => {
    const s = this.subject();
    return s?.startsWith('g:') ? Number(s.slice(2)) : null;
  });
  readonly canRecord = computed(() => this.auth.hasPermission(Permission.AccountsManage));
  readonly grid = computed(() => {
    const s = this.statement();
    return s ? monthlyGrid(s.months, s.years) : [];
  });
  readonly indexLine = computed(() =>
    sparkline(this.statement()?.days.map((d) => d.index) ?? [], 600, 120),
  );
  readonly drawdownLine = computed(() =>
    sparkline(this.statement()?.days.map((d) => -d.drawdown) ?? [], 600, 120),
  );
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
    this.glancePeriod.set(`${period.from.slice(0, 10)} → ${period.to.slice(0, 10)}`);
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

  pick(accountId: number): void {
    this.subject.set(`a:${accountId}`);
    this.load();
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
