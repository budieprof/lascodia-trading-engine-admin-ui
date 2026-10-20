import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { AuthService } from '@core/auth/auth.service';
import { permissionDefinition } from '@core/auth/permissions.generated';
import { NotificationService } from '@core/notifications/notification.service';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { IamApiService } from '../iam-api.service';
import { canDecide, errorText, reportable, when } from '../iam.logic';
import type { ApprovalRequest, ApprovalStatus } from '../iam.types';
import { iamResource } from '../shared/iam-resource';

/**
 * Two-person approvals (U3.4, contract C3.3): actions that need a second person — releasing a kill
 * switch, loosening risk — wait here until another person who holds the action's own permission
 * approves (then the engine runs it, with both names in the audit log) or rejects it. Requests
 * expire after 24 hours. Deciding needs `iam.approvals.decide`.
 */
@Component({
  selector: 'app-iam-approvals-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, PageHeaderComponent, ConfirmDialogComponent],
  styleUrl: '../shared/iam-page.scss',
  template: `
    <div class="page">
      <app-page-header
        title="Approvals"
        subtitle="Actions waiting for a second person. Approving runs the action as requested."
      >
        <select
          class="select search"
          name="status"
          aria-label="Show"
          [ngModel]="status()"
          (ngModelChange)="status.set($event); list.reload()"
        >
          <option [ngValue]="'Pending'">Waiting for approval</option>
          <option [ngValue]="null">All recent requests</option>
        </select>
        <button
          type="button"
          class="btn btn-secondary"
          (click)="list.reload()"
          [disabled]="list.loading()"
        >
          {{ list.loading() ? 'Loading…' : 'Refresh' }}
        </button>
      </app-page-header>

      <section class="card">
        @if (list.error(); as err) {
          <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
        } @else if (list.loaded() && list.value().length === 0) {
          <p class="pad muted">
            {{ status() === 'Pending' ? 'Nothing is waiting for approval.' : 'No requests.' }}
          </p>
        } @else if (list.value().length > 0) {
          <div class="table-wrap">
            <table class="grid">
              <thead>
                <tr>
                  <th>Action</th>
                  <th>Requested by</th>
                  <th>Expires</th>
                  <th>Status</th>
                  <th><span class="sr-only">Decision</span></th>
                </tr>
              </thead>
              <tbody>
                @for (r of list.value(); track r.id) {
                  @let d = decide(r);
                  <tr>
                    <td>
                      {{ r.summary || describe(r.actionKey) }}
                      <span class="sub"
                        ><code>{{ r.actionKey }}</code> · request #{{ r.id }}</span
                      >
                    </td>
                    <td class="small">
                      {{ r.requestedBy || '—'
                      }}<span class="sub">{{ when(r.requestedAtUtc) }}</span>
                    </td>
                    <td class="small">{{ when(r.expiresAtUtc) }}</td>
                    <td>
                      <span
                        class="chip"
                        [class.warn]="r.status === 'Pending'"
                        [class.ok]="r.status === 'Approved' || r.status === 'Executed'"
                        [class.bad]="r.status === 'Rejected'"
                      >
                        {{ r.status }}
                      </span>
                      @if (r.decidedBy) {
                        <span class="sub">by {{ r.decidedBy }}</span>
                      }
                    </td>
                    <td class="actions">
                      @if (r.status === 'Pending') {
                        <button
                          type="button"
                          class="btn btn-sm btn-secondary"
                          [disabled]="!d.ok"
                          [title]="d.why"
                          (click)="open(r, 'reject')"
                        >
                          Reject
                        </button>
                        <button
                          type="button"
                          class="btn btn-sm btn-primary"
                          [disabled]="!d.ok"
                          [title]="d.why"
                          (click)="open(r, 'approve')"
                        >
                          Approve
                        </button>
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      </section>

      <app-confirm-dialog
        [open]="deciding() !== null"
        [title]="dialogTitle()"
        [message]="dialogMessage()"
        [confirmLabel]="deciding()?.verdict === 'approve' ? 'Approve and run' : 'Reject'"
        [confirmVariant]="deciding()?.verdict === 'approve' ? 'primary' : 'destructive'"
        [loading]="busy()"
        (confirm)="decideNow()"
        (cancelled)="deciding.set(null)"
      >
        @if (deciding()?.verdict === 'reject') {
          <label class="field">
            <span class="label">Reason (shown to the requester)</span>
            <input
              class="input"
              name="reason"
              [ngModel]="reason()"
              (ngModelChange)="reason.set($event)"
            />
          </label>
        }
      </app-confirm-dialog>
    </div>
  `,
})
export class ApprovalsPageComponent {
  private readonly iam = inject(IamApiService);
  private readonly auth = inject(AuthService);
  private readonly notify = inject(NotificationService);

  protected readonly when = when;

  readonly status = signal<ApprovalStatus | null>('Pending');
  readonly list = iamResource(
    () => this.iam.approvals(this.status()),
    [] as ApprovalRequest[],
    'Could not load approvals.',
  );
  private readonly me = computed(() => {
    const id = Number(this.auth.user()?.passportId);
    return Number.isInteger(id) && id > 0 ? id : null;
  });

  readonly deciding = signal<{ request: ApprovalRequest; verdict: 'approve' | 'reject' } | null>(
    null,
  );
  readonly reason = signal('');
  readonly busy = signal(false);
  readonly dialogTitle = computed(() => {
    const d = this.deciding();
    if (!d) return '';
    return `${d.verdict === 'approve' ? 'Approve' : 'Reject'} request #${d.request.id}?`;
  });
  readonly dialogMessage = computed(() => {
    const d = this.deciding();
    if (!d) return '';
    const what = d.request.summary || this.describe(d.request.actionKey);
    return d.verdict === 'approve'
      ? `${what} — requested by ${d.request.requestedBy || 'another member'}. The engine runs it as soon as you approve.`
      : `${what} — it will not run.`;
  });

  constructor() {
    this.list.reload();
  }

  decide(r: ApprovalRequest) {
    return canDecide(r, this.me());
  }

  describe(key: string): string {
    return permissionDefinition(key)?.description ?? key;
  }

  open(r: ApprovalRequest, verdict: 'approve' | 'reject'): void {
    this.reason.set('');
    this.deciding.set({ request: r, verdict });
  }

  decideNow(): void {
    const d = this.deciding();
    if (!d || this.busy()) return;
    this.busy.set(true);
    const call =
      d.verdict === 'approve'
        ? this.iam.approve(d.request.id)
        : this.iam.reject(d.request.id, this.reason().trim() || null);
    call.subscribe({
      next: () => {
        this.busy.set(false);
        this.deciding.set(null);
        this.notify.success(
          d.verdict === 'approve'
            ? `Request #${d.request.id} approved.`
            : `Request #${d.request.id} rejected.`,
        );
        this.list.reload();
      },
      error: (e) => {
        this.busy.set(false);
        this.deciding.set(null);
        if (reportable(e)) this.notify.error(errorText(e, 'The decision was not recorded.'));
        this.list.reload();
      },
    });
  }
}
