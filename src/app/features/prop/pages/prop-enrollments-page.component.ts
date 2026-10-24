import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';

import { LscCanDirective } from '@core/auth/can.directive';
import { Permission } from '@core/auth/permissions.generated';
import { NotificationService } from '@core/notifications/notification.service';
import { ModalA11yDirective } from '@shared/directives/modal-a11y.directive';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { when } from '@features/iam/iam.logic';
import { iamResource } from '@features/iam/shared/iam-resource';
import { failureMessage } from '@features/organisation/organisation.logic';
import { PropGateComponent, PROP_DIALOG_STYLES } from '../components/prop-gate.component';
import { PropApiService } from '../prop-api.service';
import { money, optionalNumber, pct, ruleLabel, stateClass } from '../prop.logic';
import type { AccountOption, PropEnrollment, PropEnrollmentState, PropProgram, PropTrader } from '../prop.types';

type Dialog =
  | { kind: 'enrol'; accountId: number | null; traderId: number | null; programId: number | null; phaseIndex: number; initial: string; note: string }
  | { kind: 'withdraw'; enrollment: PropEnrollment; reason: string }
  | { kind: 'advance'; enrollment: PropEnrollment; accountId: number | null; initial: string; note: string };

/**
 * Enrolments (`prop.read`; changes `prop.manage`): which account is in which phase of which program,
 * its state and outcome. Enrolling, withdrawing and advancing are confirmed in a dialog; none of
 * them touches the account's trading or its kill switch.
 */
@Component({
  selector: 'app-prop-enrollments-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, RouterLink, LscCanDirective, ModalA11yDirective, PageHeaderComponent, PropGateComponent],
  styleUrl: '../../iam/shared/iam-page.scss',
  styles: [PROP_DIALOG_STYLES],
  template: `
    <div class="page">
      <app-page-header title="Enrolments" subtitle="Accounts in your programs, their phase, state and outcome.">
        <button type="button" class="btn btn-secondary" (click)="list.reload()" [disabled]="list.loading()">
          {{ list.loading() ? 'Loading…' : 'Refresh' }}
        </button>
        <button *lscCan="P.PropManage" type="button" class="btn btn-primary" (click)="openEnrol()">Enrol an account</button>
      </app-page-header>
      <app-prop-gate (ready)="start()">
        <section class="card">
          <header class="card-head">
            <label class="row small">State
              <select class="select" name="state" [ngModel]="state()" (ngModelChange)="state.set($event); list.reload()">
                <option [ngValue]="null">Any</option>
                @for (s of states; track s) { <option [ngValue]="s">{{ s }}</option> }
              </select>
            </label>
            <label class="row small">Program
              <select class="select" name="program" [ngModel]="programId()" (ngModelChange)="programId.set($event); list.reload()">
                <option [ngValue]="null">Any</option>
                @for (p of programs.value(); track p.id) { <option [ngValue]="p.id">{{ p.name }}</option> }
              </select>
            </label>
            <label class="row small">Trader
              <select class="select" name="trader" [ngModel]="traderId()" (ngModelChange)="traderId.set($event); list.reload()">
                <option [ngValue]="null">Any</option>
                @for (t of traders.value(); track t.id) { <option [ngValue]="t.id">{{ t.displayName }}</option> }
              </select>
            </label>
          </header>
          @if (list.error(); as err) {
            <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
          }
          <div class="table-wrap">
            <table class="grid">
              <thead>
                <tr><th>Trader / account</th><th>Program · phase</th><th>State</th><th class="num">Profit</th><th class="num">Days</th><th>Started</th><th></th></tr>
              </thead>
              <tbody>
                @for (e of list.value(); track e.id) {
                  <tr>
                    <td><a [routerLink]="['/prop/enrollments', e.id]">{{ e.traderName }}</a><span class="sub">{{ e.accountLabel }}</span></td>
                    <td>{{ e.programName }} · {{ e.phaseName }}<span class="sub">v{{ e.programVersion }}</span></td>
                    <td>
                      <span class="chip" [class]="'chip ' + stateClass(e.state)">{{ e.state }}</span>
                      @if (e.state === 'Failed') { <span class="sub">{{ ruleLabel(e.failedRule) }}{{ e.haltAppliedAtUtc ? ' · halted' : e.haltRequired ? ' · halt pending' : '' }}</span> }
                    </td>
                    <td class="num" [class.pos]="e.profitPct > 0" [class.neg]="e.profitPct < 0">{{ pct(e.profitPct) }}</td>
                    <td class="num">{{ e.tradingDays }}</td>
                    <td class="small">{{ when(e.startedAtUtc) }}</td>
                    <td class="actions">
                      <ng-container *lscCan="P.PropManage">
                        @if (e.canAdvance) {
                          <button type="button" class="btn btn-sm btn-secondary" (click)="openAdvance(e)">Advance</button>
                        }
                        @if (e.state === 'Active' || e.state === 'Funded') {
                          <button type="button" class="btn btn-sm btn-danger" (click)="dialog.set({ kind: 'withdraw', enrollment: e, reason: '' })">Withdraw</button>
                        }
                      </ng-container>
                    </td>
                  </tr>
                } @empty {
                  <tr><td colspan="7" class="muted">No enrolment.</td></tr>
                }
              </tbody>
            </table>
          </div>
        </section>
      </app-prop-gate>

      @if (dialog(); as d) {
        <div class="overlay" role="presentation" (click)="close()">
          <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="prop-enrol-title" tabindex="-1"
               appModalA11y (dismiss)="close()" (click)="$event.stopPropagation()" (keydown)="$event.stopPropagation()">
            <form class="card-body" (ngSubmit)="confirm()">
              @switch (d.kind) {
                @case ('enrol') {
                  <h3 id="prop-enrol-title">Enrol an account</h3>
                  @if (d.kind === 'enrol') {
                    <div class="form-grid">
                      <label class="field"><span class="label">Trading account</span>
                        <select class="select" name="account" [(ngModel)]="d.accountId">
                          <option [ngValue]="null">Choose…</option>
                          @for (a of accounts.value(); track a.id) { <option [ngValue]="a.id">{{ a.label }}</option> }
                        </select>
                      </label>
                      <label class="field"><span class="label">Trader</span>
                        <select class="select" name="trader" [(ngModel)]="d.traderId">
                          <option [ngValue]="null">Choose…</option>
                          @for (t of activeTraders(); track t.id) { <option [ngValue]="t.id">{{ t.displayName }}</option> }
                        </select>
                      </label>
                      <label class="field"><span class="label">Program</span>
                        <select class="select" name="program" [(ngModel)]="d.programId" (ngModelChange)="d.phaseIndex = 0">
                          <option [ngValue]="null">Choose…</option>
                          @for (p of activePrograms(); track p.id) { <option [ngValue]="p.id">{{ p.name }}</option> }
                        </select>
                      </label>
                      <label class="field"><span class="label">Start in phase</span>
                        <select class="select" name="phase" [(ngModel)]="d.phaseIndex">
                          @for (ph of phasesOf(d.programId); track $index) { <option [ngValue]="$index">{{ $index + 1 }}. {{ ph.name }}</option> }
                        </select>
                      </label>
                      <label class="field"><span class="label">Initial balance (empty = the account's balance now)</span>
                        <input class="input" name="initial" inputmode="decimal" [(ngModel)]="d.initial" />
                      </label>
                    </div>
                    <label class="field"><span class="label">Note</span><input class="input" name="note" [(ngModel)]="d.note" maxlength="1000" /></label>
                    <p class="note">
                      From now on the platform judges this account against the program's current rules every few seconds.
                      If a rule is broken and the program halts on breach, the account's kill switch is engaged
                      (no new orders; open positions are not closed). Nothing else about the account changes.
                    </p>
                  }
                }
                @case ('withdraw') {
                  <h3 id="prop-enrol-title">Withdraw this enrolment?</h3>
                  @if (d.kind === 'withdraw') {
                    <p>{{ d.enrollment.traderName }} — {{ d.enrollment.accountLabel }} ({{ d.enrollment.phaseName }}). The challenge ends without a breach and is no longer evaluated. The account is not touched; a kill switch engaged earlier stays engaged.</p>
                    <label class="field"><span class="label">Reason</span><input class="input" name="reason" [(ngModel)]="d.reason" maxlength="1000" /></label>
                  }
                }
                @case ('advance') {
                  <h3 id="prop-enrol-title">Advance to the next phase</h3>
                  @if (d.kind === 'advance') {
                    <p>{{ d.enrollment.traderName }} passed {{ d.enrollment.phaseName }}. The next phase starts under the same rule version (v{{ d.enrollment.programVersion }}).</p>
                    <div class="form-grid">
                      <label class="field"><span class="label">Account for the next phase</span>
                        <select class="select" name="account" [(ngModel)]="d.accountId">
                          <option [ngValue]="null">The same account</option>
                          @for (a of accounts.value(); track a.id) { <option [ngValue]="a.id">{{ a.label }}</option> }
                        </select>
                      </label>
                      <label class="field"><span class="label">Initial balance (empty = the account's balance now)</span>
                        <input class="input" name="initial" inputmode="decimal" [(ngModel)]="d.initial" />
                      </label>
                    </div>
                    <label class="field"><span class="label">Note</span><input class="input" name="note" [(ngModel)]="d.note" maxlength="1000" /></label>
                  }
                }
              }
              @if (error(); as err) { <p class="errors" role="alert">{{ err }}</p> }
              <div class="actions-row">
                <button type="button" class="btn btn-secondary" (click)="close()" data-autofocus>Cancel</button>
                <button type="submit" class="btn" [class.btn-primary]="d.kind !== 'withdraw'" [class.btn-danger]="d.kind === 'withdraw'" [disabled]="busy()">
                  {{ busy() ? 'Working…' : d.kind === 'enrol' ? 'Enrol' : d.kind === 'withdraw' ? 'Withdraw' : 'Advance' }}
                </button>
              </div>
            </form>
          </div>
        </div>
      }
    </div>
  `,
})
export class PropEnrollmentsPageComponent {
  private readonly api = inject(PropApiService);
  private readonly notify = inject(NotificationService);

  protected readonly P = Permission;
  protected readonly when = when;
  protected readonly money = money;
  protected readonly pct = pct;
  protected readonly ruleLabel = ruleLabel;
  protected readonly stateClass = stateClass;
  protected readonly states: PropEnrollmentState[] = ['Active', 'Funded', 'Passed', 'Failed', 'Withdrawn'];

  readonly state = signal<PropEnrollmentState | null>(null);
  readonly programId = signal<number | null>(null);
  readonly traderId = signal<number | null>(null);
  readonly list = iamResource<PropEnrollment[]>(
    () => this.api.enrollments({ state: this.state(), programId: this.programId(), traderId: this.traderId() }),
    [],
    'Could not load the enrolments.',
  );
  readonly programs = iamResource<PropProgram[]>(() => this.api.programs(true), [], 'Could not load the programs.');
  readonly traders = iamResource<PropTrader[]>(() => this.api.traders(), [], 'Could not load the traders.');
  readonly accounts = iamResource<AccountOption[]>(() => this.api.accounts(), [], 'Could not load the trading accounts.');
  readonly activePrograms = computed(() => this.programs.value().filter((p) => p.status === 'Active'));
  readonly activeTraders = computed(() => this.traders.value().filter((t) => t.isActive));

  readonly dialog = signal<Dialog | null>(null);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);

  constructor() {
    const q = inject(ActivatedRoute).snapshot.queryParamMap;
    const trader = Number(q.get('traderId'));
    if (trader > 0) this.traderId.set(trader);
  }

  start(): void {
    this.list.reload();
    this.programs.reload();
    this.traders.reload();
  }

  phasesOf(programId: number | null) {
    return this.programs.value().find((p) => p.id === programId)?.rules.phases ?? [];
  }

  openEnrol(): void {
    if (!this.accounts.loaded()) this.accounts.reload();
    this.error.set(null);
    this.dialog.set({ kind: 'enrol', accountId: null, traderId: null, programId: null, phaseIndex: 0, initial: '', note: '' });
  }

  openAdvance(e: PropEnrollment): void {
    if (!this.accounts.loaded()) this.accounts.reload();
    this.error.set(null);
    this.dialog.set({ kind: 'advance', enrollment: e, accountId: null, initial: '', note: '' });
  }

  close(): void {
    if (!this.busy()) {
      this.dialog.set(null);
      this.error.set(null);
    }
  }

  confirm(): void {
    const d = this.dialog();
    if (!d || this.busy()) return;
    const initial = d.kind === 'withdraw' ? null : optionalNumber(d.initial);
    if (initial !== null && !(initial > 0)) {
      this.error.set('The initial balance must be a positive number.');
      return;
    }
    let call;
    if (d.kind === 'enrol') {
      if (!d.accountId || !d.traderId || !d.programId) {
        this.error.set('Choose the account, the trader and the program.');
        return;
      }
      call = this.api.enrol({
        tradingAccountId: d.accountId, traderId: d.traderId, programId: d.programId, phaseIndex: d.phaseIndex,
        initialBalance: initial, note: d.note.trim() || null,
      });
    } else if (d.kind === 'withdraw') {
      call = this.api.withdraw(d.enrollment.id, d.reason.trim() || null);
    } else {
      call = this.api.advance(d.enrollment.id, { tradingAccountId: d.accountId, initialBalance: initial, note: d.note.trim() || null });
    }
    this.busy.set(true);
    this.error.set(null);
    call.subscribe({
      next: (e) => {
        this.busy.set(false);
        this.dialog.set(null);
        this.notify.success(
          d.kind === 'enrol' ? `${e.accountLabel} enrolled in ${e.programName}.` : d.kind === 'withdraw' ? 'Enrolment withdrawn.' : `Advanced to ${e.phaseName}.`,
        );
        this.list.reload();
      },
      error: (err) => {
        this.busy.set(false);
        this.error.set(failureMessage(err, 'That did not work.'));
      },
    });
  }
}
