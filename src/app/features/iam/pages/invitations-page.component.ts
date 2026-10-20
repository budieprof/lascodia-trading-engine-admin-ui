import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { LscCanDirective } from '@core/auth/can.directive';
import { Permission } from '@core/auth/permissions.generated';
import { NotificationService } from '@core/notifications/notification.service';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { IamApiService } from '../iam-api.service';
import { errorText, invitationErrors, reportable, scopeLabel, when } from '../iam.logic';
import type { GrantSpec, IamInvitation, IamRole, ScopeType } from '../iam.types';
import { iamResource } from '../shared/iam-resource';
import { ScopeTargetComponent } from '../shared/scope-target.component';
import { SecretOnceComponent } from '../shared/secret-once.component';

interface GrantRow {
  key: number;
  roleId: number | null;
  scopeType: ScopeType;
  scopeId: number | null;
}

/**
 * Invitations (U3.4, contract C3.5): invite a person by e-mail with the roles they will hold, revoke
 * a pending invitation. When the engine cannot e-mail it (no SMTP in Keycloak yet) it returns a
 * single-use link, shown once with a copy button for the inviter to pass on.
 */
@Component({
  selector: 'app-iam-invitations-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    PageHeaderComponent,
    ConfirmDialogComponent,
    LscCanDirective,
    ScopeTargetComponent,
    SecretOnceComponent,
  ],
  styleUrl: '../shared/iam-page.scss',
  template: `
    <div class="page">
      <app-page-header
        title="Invitations"
        subtitle="Invite people into this organisation with the roles they will hold. An invitation is valid for 7 days."
      >
        <button
          type="button"
          class="btn btn-secondary"
          (click)="invitations.reload()"
          [disabled]="invitations.loading()"
        >
          {{ invitations.loading() ? 'Loading…' : 'Refresh' }}
        </button>
      </app-page-header>

      <section class="card" *lscCan="P.IamInvitationsManage">
        <header class="card-head"><h3>Invite someone</h3></header>
        <form class="card-body" (ngSubmit)="send()">
          @if (tempPassword(); as pw) {
            <app-secret-once
              title="Temporary password for their new account"
              [value]="pw"
              warning="Give it to them with the invitation link, separately. They must change it at first sign-in. It will not be shown again."
              (dismissed)="tempPassword.set(null)"
            />
          }
          @if (link(); as l) {
            <app-secret-once
              title="Invitation link — send it to the person"
              [value]="l"
              warning="It works once, for this e-mail address, and expires in 7 days. It will not be shown again."
              (dismissed)="link.set(null)"
            />
          }
          <div class="form-grid">
            <label class="field">
              <span class="label">E-mail address</span>
              <input
                class="input"
                type="email"
                name="email"
                [ngModel]="email()"
                (ngModelChange)="email.set($event)"
                autocomplete="off"
                placeholder="name@example.com"
              />
            </label>
          </div>

          @for (row of rows(); track row.key; let i = $index) {
            <div class="form-grid">
              <label class="field">
                <span class="label">Role {{ i + 1 }}</span>
                <select
                  class="select"
                  [name]="'role-' + row.key"
                  [ngModel]="row.roleId"
                  (ngModelChange)="patch(row.key, { roleId: $event })"
                >
                  <option [ngValue]="null">Choose…</option>
                  @for (r of roles.value(); track r.id) {
                    <option [ngValue]="r.id">
                      {{ r.name }}{{ r.isSystem ? '' : ' (custom)' }}
                    </option>
                  }
                </select>
              </label>
              <app-scope-target
                [idPrefix]="'inv-' + row.key"
                [scopeType]="row.scopeType"
                (scopeTypeChange)="patch(row.key, { scopeType: $event, scopeId: null })"
                [scopeId]="row.scopeId"
                (scopeIdChange)="patch(row.key, { scopeId: $event })"
              />
              @if (rows().length > 1) {
                <div class="field">
                  <span class="label">&nbsp;</span>
                  <button
                    type="button"
                    class="btn btn-secondary btn-sm"
                    (click)="removeRow(row.key)"
                  >
                    Remove role
                  </button>
                </div>
              }
            </div>
          }
          <div class="row">
            <button type="button" class="btn btn-secondary btn-sm" (click)="addRow()">
              Add another role
            </button>
          </div>

          @if (submitted() && errors().length) {
            <ul class="errors" role="alert">
              @for (e of errors(); track e) {
                <li>{{ e }}</li>
              }
            </ul>
          }
          <div class="actions-row">
            <button type="submit" class="btn btn-primary" [disabled]="sending()">
              {{ sending() ? 'Sending…' : 'Send invitation' }}
            </button>
          </div>
        </form>
      </section>

      <section class="card">
        <header class="card-head">
          <h3>Pending and recent invitations</h3>
        </header>
        @if (invitations.error(); as err) {
          <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
        } @else if (invitations.loaded() && invitations.value().length === 0) {
          <p class="pad muted">No invitations.</p>
        } @else if (invitations.value().length > 0) {
          <div class="table-wrap">
            <table class="grid">
              <thead>
                <tr>
                  <th>E-mail</th>
                  <th>Roles</th>
                  <th>Status</th>
                  <th>Invited by</th>
                  <th>Expires</th>
                  <th><span class="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                @for (inv of invitations.value(); track inv.id) {
                  <tr>
                    <td>{{ inv.email }}</td>
                    <td>
                      @for (g of inv.grants ?? []; track $index) {
                        <span class="sub"
                          >{{ g.roleName ?? roleName(g.roleId) }} ·
                          {{ scope(g.scopeType, g.scopeId) }}</span
                        >
                      } @empty {
                        <span class="muted small">—</span>
                      }
                    </td>
                    <td>
                      <span class="chip" [class.warn]="isPending(inv)">{{
                        inv.status || 'Pending'
                      }}</span>
                    </td>
                    <td class="small">{{ inv.invitedBy || '—' }}</td>
                    <td class="small">{{ when(inv.expiresAtUtc) }}</td>
                    <td class="actions">
                      @if (isPending(inv)) {
                        <button
                          type="button"
                          class="btn btn-sm btn-danger"
                          *lscCan="P.IamInvitationsManage"
                          (click)="revoking.set(inv)"
                        >
                          Revoke
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
        [open]="revoking() !== null"
        [title]="'Revoke the invitation for ' + (revoking()?.email ?? '') + '?'"
        message="The link stops working at once. You can invite them again later."
        confirmLabel="Revoke"
        confirmVariant="destructive"
        [loading]="busy()"
        (confirm)="revoke()"
        (cancelled)="revoking.set(null)"
      />
    </div>
  `,
})
export class InvitationsPageComponent {
  private readonly iam = inject(IamApiService);
  private readonly notify = inject(NotificationService);

  protected readonly P = Permission;
  protected readonly when = when;

  readonly invitations = iamResource(
    () => this.iam.invitations(),
    [] as IamInvitation[],
    'Could not load invitations.',
  );
  readonly roles = iamResource(() => this.iam.roles(), [] as IamRole[], 'Could not load roles.');

  readonly email = signal('');
  private nextKey = 1;
  readonly rows = signal<GrantRow[]>([
    { key: 0, roleId: null, scopeType: 'Tenant', scopeId: null },
  ]);
  readonly submitted = signal(false);
  readonly sending = signal(false);
  readonly link = signal<string | null>(null);
  readonly tempPassword = signal<string | null>(null);
  readonly errors = computed(() => invitationErrors(this.email(), this.specs()));

  readonly revoking = signal<IamInvitation | null>(null);
  readonly busy = signal(false);

  constructor() {
    this.invitations.reload();
    this.roles.reload();
  }

  private specs(): GrantSpec[] {
    return this.rows().map((r) => ({
      roleId: r.roleId ?? 0,
      scopeType: r.scopeType,
      scopeId: r.scopeType === 'Tenant' ? null : r.scopeId,
    }));
  }

  addRow(): void {
    this.rows.update((rs) => [
      ...rs,
      { key: this.nextKey++, roleId: null, scopeType: 'Tenant', scopeId: null },
    ]);
  }

  removeRow(key: number): void {
    this.rows.update((rs) => rs.filter((r) => r.key !== key));
  }

  patch(key: number, change: Partial<GrantRow>): void {
    this.rows.update((rs) => rs.map((r) => (r.key === key ? { ...r, ...change } : r)));
  }

  roleName(id: number): string {
    return this.roles.value().find((r) => r.id === id)?.name ?? `Role #${id}`;
  }

  scope(type: string, id: number | null): string {
    return scopeLabel(type, id);
  }

  isPending(inv: IamInvitation): boolean {
    return !inv.status || inv.status === 'Pending';
  }

  send(): void {
    this.submitted.set(true);
    if (this.errors().length || this.sending()) return;
    this.sending.set(true);
    const email = this.email().trim();
    this.iam.invite({ email, grants: this.specs() }).subscribe({
      next: (res) => {
        this.sending.set(false);
        this.submitted.set(false);
        this.email.set('');
        this.rows.set([{ key: this.nextKey++, roleId: null, scopeType: 'Tenant', scopeId: null }]);
        this.tempPassword.set(res?.temporaryPassword ?? null);
        if (res?.acceptUrl) {
          this.link.set(res.acceptUrl);
          this.notify.success(
            `Invitation for ${email} created. Copy the link and send it to them.`,
          );
        } else {
          this.notify.success(`Invitation e-mailed to ${email}.`);
        }
        this.invitations.reload();
      },
      error: (e) => {
        this.sending.set(false);
        if (reportable(e)) this.notify.error(errorText(e, 'The invitation was not sent.'));
      },
    });
  }

  revoke(): void {
    const inv = this.revoking();
    if (!inv || this.busy()) return;
    this.busy.set(true);
    this.iam.revokeInvitation(inv.id).subscribe({
      next: () => {
        this.busy.set(false);
        this.revoking.set(null);
        this.notify.success(`Invitation for ${inv.email} revoked.`);
        this.invitations.reload();
      },
      error: (e) => {
        this.busy.set(false);
        this.revoking.set(null);
        if (reportable(e)) this.notify.error(errorText(e, 'Could not revoke the invitation.'));
      },
    });
  }
}
