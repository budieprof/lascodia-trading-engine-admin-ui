import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { AuthService } from '@core/auth/auth.service';
import { Permission } from '@core/auth/permissions.generated';
import { NotificationService } from '@core/notifications/notification.service';
import { iamResource } from '@features/iam/shared/iam-resource';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { ModalA11yDirective } from '@shared/directives/modal-a11y.directive';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';

import {
  ApprovalPoliciesApiService,
  describePolicy,
  draftOf,
  isLoosening,
  type ApprovalPolicyDraft,
  type ApprovalPolicyRow,
} from '../approval-policies';
import { failureMessage, isApprovalPending } from '../organisation.logic';
import { ago } from '@features/iam/shared/admin-context.logic';
import { AuditTrailComponent } from '@features/iam/shared/audit-trail.component';
import { StatTilesComponent, type StatTile } from '@features/iam/shared/stat-tiles.component';
import { catchError, of } from 'rxjs';
import { IamApiService } from '@features/iam/iam-api.service';
import type { IamGrant, IamRole } from '@features/iam/iam.types';

/**
 * Four-eyes policies (enterprise program, fund-module): for each governable action, how many people
 * other than the requester must approve it, which roles they must hold and (for live manual orders) from
 * which notional. Requests they create are decided on Approvals. With no policy an action behaves exactly
 * as before. Reading needs `iam.approvals.decide`; changing needs `approvals.policy.manage` (MFA). A
 * change that demands less needs a reason and may itself need approval.
 */
@Component({
  selector: 'app-approval-policies-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    PageHeaderComponent,
    ConfirmDialogComponent,
    ModalA11yDirective,
    StatTilesComponent,
    AuditTrailComponent,
  ],
  styleUrl: '../../iam/shared/iam-page.scss',
  template: `
    <div class="page">
      <app-page-header
        title="Approval policies"
        subtitle="Which actions need more than one person. No policy = the action works as before."
      >
        <button
          type="button"
          class="btn btn-secondary"
          (click)="list.reload()"
          [disabled]="list.loading()"
        >
          {{ list.loading() ? 'Loading…' : 'Refresh' }}
        </button>
      </app-page-header>

      <app-stat-tiles [tiles]="tiles()" label="Approval policies summary" />

      <section class="card">
        @if (list.error(); as err) {
          <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
        }
        <div class="table-wrap">
          <table class="grid">
            <thead>
              <tr>
                <th>Action</th>
                <th>Policy</th>
                <th>Last change</th>
                <th><span class="sr-only">Change</span></th>
              </tr>
            </thead>
            <tbody>
              @for (r of list.value(); track r.kind) {
                <tr>
                  <td>
                    {{ r.title }}
                    <span class="sub">{{ r.description }}</span>
                    @if (r.platformWide) {
                      <span class="sub"><span class="chip">House only</span></span>
                    }
                  </td>
                  <td>
                    <span class="chip" [class.ok]="r.policy?.enabled">{{
                      describe(r.policy)
                    }}</span>
                  </td>
                  <td class="small">
                    {{
                      r.policy
                        ? r.policy.updatedBy +
                          ' · ' +
                          r.policy.updatedAtUtc.slice(0, 16).replace('T', ' ')
                        : '—'
                    }}
                  </td>
                  <td class="actions">
                    @if (canManage() && r.settable) {
                      <button type="button" class="btn btn-sm btn-secondary" (click)="edit(r)">
                        {{ r.policy ? 'Change' : 'Set up' }}
                      </button>
                      @if (r.policy) {
                        <button
                          type="button"
                          class="btn btn-sm btn-secondary"
                          (click)="removing.set(r)"
                        >
                          Remove
                        </button>
                      }
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      </section>

      @if (editing(); as r) {
        <div class="modal-backdrop"></div>
        <div
          class="card modal"
          role="dialog"
          aria-modal="true"
          appModalA11y
          (dismiss)="editing.set(null)"
        >
          <div class="card-head">
            <strong>{{ r.title }}</strong>
          </div>
          <div class="card-body form-grid">
            <label class="check"
              ><input
                type="checkbox"
                name="enabled"
                [ngModel]="draft().enabled"
                (ngModelChange)="patch({ enabled: $event })"
              />
              Enabled</label
            >
            <label class="field"
              ><span class="label">Approvers needed (besides the requester)</span>
              <input
                class="input"
                type="number"
                min="1"
                max="5"
                name="n"
                [ngModel]="draft().approversRequired"
                (ngModelChange)="patch({ approversRequired: +$event || 1 })"
            /></label>
            <label class="field"
              ><span class="label"
                >Approver roles (comma-separated; empty = anyone holding the action's
                permission)</span
              >
              <input
                class="input"
                name="roles"
                [ngModel]="rolesText()"
                (ngModelChange)="setRoles($event)"
                placeholder="RiskManager, Admin"
            /></label>
            @if (r.hasThreshold) {
              <label class="field"
                ><span class="label"
                  >Applies at or above notional (account currency; empty = always)</span
                >
                <input
                  class="input"
                  type="number"
                  min="0"
                  name="threshold"
                  [ngModel]="draft().thresholdNotional"
                  (ngModelChange)="
                    patch({ thresholdNotional: $event === '' || $event === null ? null : +$event })
                  "
              /></label>
            }
            <label class="field"
              ><span class="label">Requests expire after (minutes, 5–1440; empty = 24 h)</span>
              <input
                class="input"
                type="number"
                min="5"
                max="1440"
                name="expiry"
                [ngModel]="draft().expiryMinutes"
                (ngModelChange)="
                  patch({ expiryMinutes: $event === '' || $event === null ? null : +$event })
                "
            /></label>
            <label class="field"
              ><span class="label">Description</span>
              <input
                class="input"
                name="description"
                [ngModel]="draft().description"
                (ngModelChange)="patch({ description: $event || null })"
            /></label>
            @if (loosening()) {
              <p class="note">
                This demands less than the current policy: give a reason. If the organisation has a
                policy for changing policies, the change waits for its approvers.
              </p>
              <label class="field"
                ><span class="label">Reason</span>
                <input
                  class="input"
                  name="reason"
                  [ngModel]="draft().reason"
                  (ngModelChange)="patch({ reason: $event || null })"
              /></label>
            }
          </div>
          <div class="actions-row pad">
            <button
              type="button"
              class="btn btn-secondary"
              data-autofocus
              (click)="editing.set(null)"
            >
              Cancel
            </button>
            <button
              type="button"
              class="btn btn-primary"
              [disabled]="busy() || (loosening() && !draft().reason)"
              (click)="save()"
            >
              Save
            </button>
          </div>
        </div>
      }

      <app-confirm-dialog
        [open]="removing() !== null"
        [title]="'Remove the policy for ' + (removing()?.title ?? '') + '?'"
        message="The action will work as it did without a policy. Removing an enabled policy needs a reason and may itself need approval."
        confirmLabel="Remove"
        confirmVariant="destructive"
        [loading]="busy()"
        (confirm)="remove()"
        (cancelled)="removing.set(null)"
      >
        <label class="field"
          ><span class="label">Reason</span>
          <input
            class="input"
            name="removeReason"
            [ngModel]="removeReason()"
            (ngModelChange)="removeReason.set($event)"
        /></label>
      </app-confirm-dialog>

      <section class="card">
        <header class="card-head">
          <h3>Who can approve today</h3>
          <span class="spacer"></span>
          <span class="small muted"
            >people holding <code>iam.approvals.decide</code> through a role</span
          >
        </header>
        @if (approvers().length === 0) {
          <p class="pad small muted">
            {{
              grants.loaded()
                ? 'Nobody here holds the approvals permission through a role. A policy that needs approvers could not be satisfied until someone is granted one (Admin, Owner or RiskManager carry it).'
                : 'Loading…'
            }}
          </p>
        } @else {
          <table class="grid">
            <tbody>
              @for (a of approvers(); track a.name) {
                <tr>
                  <td>{{ a.name }}</td>
                  <td class="small muted">{{ a.roles.join(', ') }}</td>
                </tr>
              }
            </tbody>
          </table>
          <p class="pad small muted">
            An approver must also hold the action's own permission and is never the requester — so a
            policy needing more than {{ approvers().length }} approver(s) could never be met today.
          </p>
        }
      </section>

      <app-audit-trail
        heading="Policy changes and approvals"
        [actions]="['iam.approval_policy.', 'iam.approval.']"
        empty="No policy has been set, changed or removed, and nothing has been sent for approval. Each change and each request is recorded here; requests waiting now are on Approvals."
      />
    </div>
  `,
  styles: [
    `
      .modal-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.4);
        z-index: 40;
      }
      .modal {
        position: fixed;
        top: 8vh;
        left: 50%;
        transform: translateX(-50%);
        width: min(40rem, 94vw);
        z-index: 41;
        max-height: 84vh;
        overflow: auto;
      }
    `,
  ],
})
export class ApprovalPoliciesPageComponent {
  private readonly policies = inject(ApprovalPoliciesApiService);
  private readonly auth = inject(AuthService);
  private readonly notify = inject(NotificationService);

  readonly list = iamResource(
    () => this.policies.list(),
    [] as ApprovalPolicyRow[],
    'Could not load the policies.',
  );
  readonly canManage = computed(() => this.auth.hasPermission(Permission.ApprovalsPolicyManage));
  readonly editing = signal<ApprovalPolicyRow | null>(null);
  readonly draft = signal<ApprovalPolicyDraft>({
    enabled: true,
    approversRequired: 1,
    approverRoles: [],
    thresholdNotional: null,
    expiryMinutes: null,
    description: null,
    reason: null,
  });
  readonly rolesText = computed(() => this.draft().approverRoles.join(', '));
  readonly loosening = computed(() => isLoosening(this.editing()?.policy ?? null, this.draft()));
  readonly removing = signal<ApprovalPolicyRow | null>(null);
  readonly removeReason = signal('');
  readonly busy = signal(false);

  private readonly iamApi = inject(IamApiService);
  readonly grants = iamResource<IamGrant[]>(
    () =>
      this.iamApi.grants({ principalType: 'User' }).pipe(catchError(() => of([] as IamGrant[]))),
    [],
  );
  readonly roles = iamResource<IamRole[]>(
    () => this.iamApi.roles().pipe(catchError(() => of([] as IamRole[]))),
    [],
  );
  readonly approvers = computed(() => {
    const deciding = new Set(
      this.roles
        .value()
        .filter((r) => r.permissions.includes('iam.approvals.decide'))
        .map((r) => r.id),
    );
    const by = new Map<string, string[]>();
    for (const g of this.grants.value()) {
      if (!deciding.has(g.roleId)) continue;
      const who = g.principalName ?? `User #${g.principalId}`;
      by.set(who, [...(by.get(who) ?? []), g.roleName ?? `Role #${g.roleId}`]);
    }
    return [...by.entries()].map(([name, roles]) => ({ name, roles }));
  });
  readonly tiles = computed<StatTile[]>(() => {
    const rows = this.list.value();
    const set = rows.filter((r) => r.policy);
    const on = set.filter((r) => r.policy?.enabled);
    const last =
      set
        .map((r) => r.policy?.updatedAtUtc ?? '')
        .sort()
        .at(-1) || null;
    return [
      {
        label: 'Policies in force',
        value: this.list.loaded() ? `${on.length} of ${rows.length}` : '…',
        caption: on.length ? on.map((r) => r.title).join(', ') : 'every action works as before',
        tone: this.list.loaded() ? (on.length ? 'good' : null) : null,
      },
      {
        label: 'Switched off',
        value: this.list.loaded() ? String(set.length - on.length) : '…',
        caption: 'kept but not applied',
      },
      {
        label: 'Most approvers asked',
        value: on.length ? String(Math.max(...on.map((r) => r.policy!.approversRequired))) : '—',
        caption: 'people besides the requester',
      },
      {
        label: 'Last change',
        value: last ? ago(last) : 'Never',
        caption: last ? 'to any policy' : 'no policy has been set',
      },
      {
        label: 'People who can approve',
        value: this.grants.loaded() ? String(this.approvers().length) : '…',
        caption: 'through a role, besides the requester',
        tone: this.grants.loaded() ? (this.approvers().length > 1 ? 'good' : 'warn') : null,
      },
      {
        label: 'Waiting for approval',
        value: 'Approvals',
        caption: 'requests these policies hold',
        route: '/iam/approvals',
      },
    ];
  });

  constructor() {
    this.grants.reload();
    this.roles.reload();
    this.list.reload();
  }

  describe = describePolicy;

  edit(row: ApprovalPolicyRow): void {
    this.draft.set(draftOf(row));
    this.editing.set(row);
  }

  patch(change: Partial<ApprovalPolicyDraft>): void {
    this.draft.update((d) => ({ ...d, ...change }));
  }

  setRoles(text: string): void {
    this.patch({
      approverRoles: text
        .split(',')
        .map((r) => r.trim())
        .filter((r) => r.length > 0),
    });
  }

  save(): void {
    const row = this.editing();
    if (!row || this.busy()) return;
    this.busy.set(true);
    this.policies.set(row.kind, this.draft()).subscribe({
      next: () => this.done(`Policy for ${row.title} saved.`),
      error: (e) => this.failed(e, 'The policy was not saved.'),
    });
  }

  remove(): void {
    const row = this.removing();
    if (!row || this.busy()) return;
    this.busy.set(true);
    this.policies.remove(row.kind, this.removeReason().trim() || null).subscribe({
      next: () => this.done(`Policy for ${row.title} removed.`),
      error: (e) => this.failed(e, 'The policy was not removed.'),
    });
  }

  private done(message: string): void {
    this.busy.set(false);
    this.editing.set(null);
    this.removing.set(null);
    this.removeReason.set('');
    this.notify.success(message);
    this.list.reload();
  }

  private failed(e: unknown, fallback: string): void {
    this.busy.set(false);
    if (isApprovalPending(e)) {
      // Parked for the policy-change approvers: not a failure (the interceptor announced it).
      this.editing.set(null);
      this.removing.set(null);
      return;
    }
    const message = failureMessage(e, fallback);
    if (message) this.notify.error(message);
  }
}
