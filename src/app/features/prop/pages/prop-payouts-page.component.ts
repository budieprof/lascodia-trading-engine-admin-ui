import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { LscCanDirective } from '@core/auth/can.directive';
import { Permission } from '@core/auth/permissions.generated';
import { NotificationService } from '@core/notifications/notification.service';
import { ModalA11yDirective } from '@shared/directives/modal-a11y.directive';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { when } from '@features/iam/iam.logic';
import { iamResource } from '@features/iam/shared/iam-resource';
import { MfaHintComponent } from '@features/iam/shared/mfa-hint.component';
import { failureMessage } from '@features/organisation/organisation.logic';
import { PropGateComponent, PROP_DIALOG_STYLES } from '../components/prop-gate.component';
import { PropApiService } from '../prop-api.service';
import { dayStartUtc, money, optionalNumber } from '../prop.logic';
import type { PropEnrollment, PropPayout, PropPayoutDeduction, PropPayoutStatus } from '../prop.types';

interface PrepareDraft {
  enrollmentId: number | null;
  from: string;
  to: string;
  deductions: { label: string; amount: string }[];
  note: string;
}

/**
 * Payout statements (`prop.read`; prepare `prop.manage`; approve / reject `prop.payouts.approve`,
 * step-up, never by the person who prepared it). A statement is a record: the platform moves no money.
 */
@Component({
  selector: 'app-prop-payouts-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, RouterLink, LscCanDirective, ModalA11yDirective, MfaHintComponent, PageHeaderComponent, PropGateComponent],
  styleUrl: '../../iam/shared/iam-page.scss',
  styles: [PROP_DIALOG_STYLES],
  template: `
    <div class="page">
      <app-page-header title="Payouts" subtitle="Profit-split statements of funded traders. The platform moves no money.">
        <app-mfa-hint [permission]="P.PropPayoutsApprove" />
        <button type="button" class="btn btn-secondary" (click)="list.reload()" [disabled]="list.loading()">
          {{ list.loading() ? 'Loading…' : 'Refresh' }}
        </button>
        <button *lscCan="P.PropManage" type="button" class="btn btn-primary" (click)="openPrepare()">Prepare a statement</button>
      </app-page-header>
      <app-prop-gate (ready)="list.reload()">
        <section class="card">
          <header class="card-head">
            <label class="row small">Status
              <select class="select" name="status" [ngModel]="status()" (ngModelChange)="status.set($event); list.reload()">
                <option [ngValue]="null">Any</option>
                <option [ngValue]="'Draft'">Waiting for approval</option>
                <option [ngValue]="'Approved'">Approved</option>
                <option [ngValue]="'Rejected'">Rejected</option>
              </select>
            </label>
            <span class="spacer"></span>
            <label class="row small">From <input class="input" type="date" name="ef" [(ngModel)]="exportFrom" /></label>
            <label class="row small">To <input class="input" type="date" name="et" [(ngModel)]="exportTo" /></label>
            <button type="button" class="btn btn-sm btn-secondary" (click)="exportCsv()">Export CSV</button>
          </header>
          @if (list.error(); as err) {
            <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
          }
          <div class="table-wrap">
            <table class="grid">
              <thead>
                <tr><th>Trader / account</th><th>Period (UTC)</th><th class="num">Gross</th><th class="num">Split</th><th class="num">Deductions</th><th class="num">Net to trader</th><th>Status</th><th></th></tr>
              </thead>
              <tbody>
                @for (p of list.value(); track p.id) {
                  <tr>
                    <td><a [routerLink]="['/prop/enrollments', p.enrollmentId]">{{ p.traderName }}</a><span class="sub">{{ p.accountLabel }}</span></td>
                    <td class="small">{{ when(p.periodStartUtc) }} – {{ when(p.periodEndUtc) }}</td>
                    <td class="num" [class.pos]="p.grossProfit > 0" [class.neg]="p.grossProfit < 0">{{ money(p.grossProfit, p.currency) }}</td>
                    <td class="num">{{ p.traderSharePct }}%</td>
                    <td class="num">{{ money(p.deductionsTotal) }}</td>
                    <td class="num"><strong>{{ money(p.netPayout, p.currency) }}</strong></td>
                    <td>
                      <span class="chip" [class.ok]="p.status === 'Approved'" [class.bad]="p.status === 'Rejected'" [class.info]="p.status === 'Draft'">{{ p.status }}</span>
                      <span class="sub">by {{ p.preparedBy }}{{ p.decidedBy ? ' · ' + p.decidedBy : '' }}</span>
                      @if (p.consistencyMet === false) { <span class="sub">consistency rule not met</span> }
                    </td>
                    <td class="actions">
                      <button type="button" class="btn btn-sm btn-secondary" (click)="pdf(p)">PDF</button>
                      @if (p.status === 'Draft') {
                        <ng-container *lscCan="P.PropPayoutsApprove">
                          <button type="button" class="btn btn-sm btn-primary" (click)="deciding.set({ payout: p, approve: true, note: '' })">Approve</button>
                          <button type="button" class="btn btn-sm btn-danger" (click)="deciding.set({ payout: p, approve: false, note: '' })">Reject</button>
                        </ng-container>
                      }
                    </td>
                  </tr>
                } @empty {
                  <tr><td colspan="8" class="muted">No statement.</td></tr>
                }
              </tbody>
            </table>
          </div>
        </section>
      </app-prop-gate>

      @if (draft(); as d) {
        <div class="overlay" role="presentation" (click)="closePrepare()">
          <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="prop-payout-title" tabindex="-1"
               appModalA11y (dismiss)="closePrepare()" (click)="$event.stopPropagation()" (keydown)="$event.stopPropagation()">
            <form class="card-body" (ngSubmit)="prepare(false)">
              <h3 id="prop-payout-title">Prepare a payout statement</h3>
              <div class="form-grid">
                <label class="field"><span class="label">Funded enrolment</span>
                  <select class="select" name="enr" [(ngModel)]="d.enrollmentId" (ngModelChange)="preview.set(null)">
                    <option [ngValue]="null">Choose…</option>
                    @for (e of funded(); track e.id) { <option [ngValue]="e.id">{{ e.traderName }} — {{ e.accountLabel }}</option> }
                  </select>
                </label>
                <label class="field"><span class="label">From (UTC day, inclusive)</span>
                  <input class="input" type="date" name="from" [(ngModel)]="d.from" (ngModelChange)="preview.set(null)" />
                </label>
                <label class="field"><span class="label">To (UTC day, exclusive)</span>
                  <input class="input" type="date" name="to" [(ngModel)]="d.to" (ngModelChange)="preview.set(null)" />
                </label>
              </div>
              <span class="label">Deductions</span>
              @for (x of d.deductions; track $index; let i = $index) {
                <div class="row">
                  <input class="input" style="flex: 2" [name]="'dl-' + i" placeholder="What for" [(ngModel)]="x.label" (ngModelChange)="preview.set(null)" />
                  <input class="input" style="flex: 1" [name]="'da-' + i" inputmode="decimal" placeholder="Amount" [(ngModel)]="x.amount" (ngModelChange)="preview.set(null)" />
                  <button type="button" class="btn btn-sm btn-secondary" (click)="d.deductions.splice(i, 1); preview.set(null)">Remove</button>
                </div>
              }
              <div class="row"><button type="button" class="btn btn-sm btn-secondary" (click)="d.deductions.push({ label: '', amount: '' })">Add a deduction</button></div>
              <label class="field"><span class="label">Note</span><input class="input" name="note" [(ngModel)]="d.note" maxlength="1000" /></label>
              @if (preview(); as p) {
                <p class="note">
                  {{ p.positionsClosed }} position(s) closed in the period · gross {{ money(p.grossProfit, p.currency) }} ·
                  {{ p.traderSharePct }}% to the trader = {{ money(p.traderShare) }} · deductions {{ money(p.deductionsTotal) }} ·
                  <strong>net {{ money(p.netPayout, p.currency) }}</strong>
                  @if (p.consistencyMet === false) { · the consistency rule is not met over the period }
                </p>
              }
              @if (error(); as err) { <p class="errors" role="alert">{{ err }}</p> }
              <div class="actions-row">
                <button type="button" class="btn btn-secondary" (click)="closePrepare()" data-autofocus>Cancel</button>
                <button type="button" class="btn btn-secondary" [disabled]="busy()" (click)="prepare(true)">Preview</button>
                <button type="submit" class="btn btn-primary" [disabled]="busy() || !preview()">{{ busy() ? 'Working…' : 'Prepare' }}</button>
              </div>
            </form>
          </div>
        </div>
      }

      @if (deciding(); as x) {
        <div class="overlay" role="presentation" (click)="deciding.set(null)">
          <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="prop-decide-title" tabindex="-1"
               appModalA11y (dismiss)="deciding.set(null)" (click)="$event.stopPropagation()" (keydown)="$event.stopPropagation()">
            <form class="card-body" (ngSubmit)="decide()">
              <h3 id="prop-decide-title">{{ x.approve ? 'Approve' : 'Reject' }} the statement of {{ x.payout.traderName }}?</h3>
              <p>
                Net to the trader {{ money(x.payout.netPayout, x.payout.currency) }} for {{ when(x.payout.periodStartUtc) }} –
                {{ when(x.payout.periodEndUtc) }}. Approving records the decision; paying the trader is done outside the platform.
              </p>
              <label class="field"><span class="label">{{ x.approve ? 'Note (optional)' : 'Why it is rejected' }}</span>
                <input class="input" name="note" [(ngModel)]="x.note" maxlength="1000" />
              </label>
              @if (error(); as err) { <p class="errors" role="alert">{{ err }}</p> }
              <div class="actions-row">
                <button type="button" class="btn btn-secondary" (click)="deciding.set(null)" data-autofocus>Cancel</button>
                <button type="submit" class="btn" [class.btn-primary]="x.approve" [class.btn-danger]="!x.approve"
                        [disabled]="busy() || (!x.approve && !x.note.trim())">{{ x.approve ? 'Approve' : 'Reject' }}</button>
              </div>
            </form>
          </div>
        </div>
      }
    </div>
  `,
})
export class PropPayoutsPageComponent {
  private readonly api = inject(PropApiService);
  private readonly notify = inject(NotificationService);

  protected readonly P = Permission;
  protected readonly when = when;
  protected readonly money = money;

  readonly status = signal<PropPayoutStatus | null>(null);
  readonly list = iamResource<PropPayout[]>(() => this.api.payouts(this.status()), [], 'Could not load the statements.');
  readonly enrollments = iamResource<PropEnrollment[]>(() => this.api.enrollments({}), [], 'Could not load the enrolments.');
  readonly funded = computed(() => this.enrollments.value().filter((e) => e.phaseKind === 'Funded'));

  readonly draft = signal<PrepareDraft | null>(null);
  readonly preview = signal<PropPayout | null>(null);
  readonly deciding = signal<{ payout: PropPayout; approve: boolean; note: string } | null>(null);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  exportFrom = '';
  exportTo = '';

  openPrepare(): void {
    this.enrollments.reload();
    this.error.set(null);
    this.preview.set(null);
    this.draft.set({ enrollmentId: null, from: '', to: '', deductions: [], note: '' });
  }

  closePrepare(): void {
    if (!this.busy()) this.draft.set(null);
  }

  prepare(previewOnly: boolean): void {
    const d = this.draft();
    if (!d || this.busy()) return;
    const from = dayStartUtc(d.from);
    const to = dayStartUtc(d.to);
    if (!d.enrollmentId || !from || !to) {
      this.error.set('Choose the funded enrolment and both dates.');
      return;
    }
    const deductions: PropPayoutDeduction[] = [];
    for (const x of d.deductions) {
      const amount = optionalNumber(x.amount);
      if (!x.label.trim() || amount === null || !(amount >= 0)) {
        this.error.set('Every deduction needs a label and a positive amount.');
        return;
      }
      deductions.push({ label: x.label.trim(), amount });
    }
    this.busy.set(true);
    this.error.set(null);
    this.api
      .preparePayout({ enrollmentId: d.enrollmentId, periodStartUtc: from, periodEndUtc: to, deductions, note: d.note.trim() || null, preview: previewOnly })
      .subscribe({
        next: (p) => {
          this.busy.set(false);
          if (previewOnly) {
            this.preview.set(p);
            return;
          }
          this.draft.set(null);
          this.notify.success('Statement prepared. It waits for approval by someone else.');
          this.list.reload();
        },
        error: (e) => {
          this.busy.set(false);
          this.error.set(failureMessage(e, 'The statement was not prepared.'));
        },
      });
  }

  decide(): void {
    const x = this.deciding();
    if (!x || this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    const note = x.note.trim() || null;
    (x.approve ? this.api.approvePayout(x.payout.id, note) : this.api.rejectPayout(x.payout.id, note ?? '')).subscribe({
      next: () => {
        this.busy.set(false);
        this.deciding.set(null);
        this.notify.success(x.approve ? 'Statement approved.' : 'Statement rejected.');
        this.list.reload();
      },
      error: (e) => {
        this.busy.set(false);
        const msg = failureMessage(e, 'The decision was not recorded.');
        if (msg) this.error.set(msg);
        else this.deciding.set(null);
      },
    });
  }

  async exportCsv(): Promise<void> {
    const blob = await this.api.exportPayoutsCsv(dayStartUtc(this.exportFrom), dayStartUtc(this.exportTo));
    if (!blob) {
      this.notify.error('The export could not be downloaded.');
      return;
    }
    save(blob, 'prop-payouts.csv');
  }

  async pdf(p: PropPayout): Promise<void> {
    const blob = await this.api.payoutPdf(p.id);
    if (!blob) {
      this.notify.error('The PDF could not be downloaded.');
      return;
    }
    save(blob, `prop-payout-${p.id}.pdf`);
  }
}

function save(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
