import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { catchError, of } from 'rxjs';

import { LscCanDirective } from '@core/auth/can.directive';
import {
  PERMISSION_CATALOG,
  Permission,
  type PermissionDefinition,
} from '@core/auth/permissions.generated';
import { NotificationService } from '@core/notifications/notification.service';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { IamApiService } from '../iam-api.service';
import {
  errorText,
  grantErrors,
  localToUtc,
  memberLabel,
  reportable,
  scopeLabel,
  unscopeableIn,
  when,
} from '../iam.logic';
import type {
  ExplainResult,
  IamGrant,
  IamMember,
  IamRole,
  IamTeam,
  PrincipalType,
  ScopeType,
} from '../iam.types';
import { PRINCIPAL_TYPES } from '../iam.types';
import { iamResource } from '../shared/iam-resource';
import { MfaHintComponent } from '../shared/mfa-hint.component';
import { ScopeTargetComponent } from '../shared/scope-target.component';

const PRINCIPAL_NAMES: Record<PrincipalType, string> = {
  User: 'Person',
  Team: 'Team',
  ServiceAccount: 'Service account',
};

/**
 * Access grants (U3.4, ADR-0031 §2, contract C3.5): who holds which role, where (the whole
 * organisation, an account group, a trading account or a strategy), until when and why. Grant and
 * revoke need `iam.grants.manage` (a step-up key; the engine also refuses granting what you do not
 * hold yourself). "Why can they?" asks the engine's evaluator (`/iam/explain`) which grants give a
 * principal a permission at a scope — or what is missing.
 */
@Component({
  selector: 'app-iam-grants-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    PageHeaderComponent,
    ConfirmDialogComponent,
    LscCanDirective,
    MfaHintComponent,
    ScopeTargetComponent,
  ],
  styleUrl: '../shared/iam-page.scss',
  template: `
    <div class="page">
      <app-page-header
        title="Access grants"
        subtitle="Roles given to people, teams and service accounts — for the whole organisation or a narrower scope."
      >
        <button
          type="button"
          class="btn btn-secondary"
          (click)="grants.reload()"
          [disabled]="grants.loading()"
        >
          {{ grants.loading() ? 'Loading…' : 'Refresh' }}
        </button>
      </app-page-header>

      <section class="card" *lscCan="P.IamGrantsManage">
        <header class="card-head">
          <h3>Grant a role</h3>
          <span class="spacer"></span>
          <app-mfa-hint [permission]="P.IamGrantsManage" />
        </header>
        <form class="card-body" (ngSubmit)="grant()">
          <div class="form-grid">
            <label class="field">
              <span class="label">To</span>
              <select
                class="select"
                name="ptype"
                [ngModel]="pType()"
                (ngModelChange)="pType.set($event); pId.set(null)"
              >
                @for (t of principalTypes; track t) {
                  <option [value]="t">{{ principalNames[t] }}</option>
                }
              </select>
            </label>
            <label class="field">
              <span class="label">{{ principalNames[pType()] }}</span>
              @switch (pType()) {
                @case ('User') {
                  <select
                    class="select"
                    name="pid"
                    [ngModel]="pId()"
                    (ngModelChange)="pId.set($event)"
                  >
                    <option [ngValue]="null">Choose…</option>
                    @for (m of members.value(); track m.userId) {
                      <option [ngValue]="m.userId">{{ label(m) }}</option>
                    }
                  </select>
                }
                @case ('Team') {
                  <select
                    class="select"
                    name="pid"
                    [ngModel]="pId()"
                    (ngModelChange)="pId.set($event)"
                  >
                    <option [ngValue]="null">Choose…</option>
                    @for (t of teams.value(); track t.id) {
                      <option [ngValue]="t.id">{{ t.name }}</option>
                    }
                  </select>
                }
                @default {
                  <input
                    class="input"
                    type="number"
                    min="1"
                    name="pid"
                    placeholder="Service account id"
                    [ngModel]="pId()"
                    (ngModelChange)="pId.set(toId($event))"
                  />
                }
              }
            </label>
            <label class="field">
              <span class="label">Role</span>
              <select
                class="select"
                name="role"
                [ngModel]="roleId()"
                (ngModelChange)="roleId.set($event)"
              >
                <option [ngValue]="null">Choose…</option>
                @for (r of roles.value(); track r.id) {
                  <option [ngValue]="r.id">{{ r.name }}</option>
                }
              </select>
            </label>
            <app-scope-target idPrefix="grant" [(scopeType)]="scopeType" [(scopeId)]="scopeId" />
            <label class="field">
              <span class="label">Expires (optional)</span>
              <input
                class="input"
                type="datetime-local"
                name="expires"
                [ngModel]="expires()"
                (ngModelChange)="expires.set($event)"
              />
            </label>
          </div>
          <label class="field">
            <span class="label">Reason (recorded in the audit log)</span>
            <input
              class="input"
              name="reason"
              maxlength="500"
              [ngModel]="reason()"
              (ngModelChange)="reason.set($event)"
              placeholder="e.g. Covering the London desk this week"
            />
          </label>
          @if (orgWideOnly().length) {
            <p class="note warn">
              Given for less than the whole organisation, this role does not carry:
              {{ orgWideOnly().join(', ') }} — those only count organisation-wide.
            </p>
          }
          @if (submitted() && errors().length) {
            <ul class="errors" role="alert">
              @for (e of errors(); track e) {
                <li>{{ e }}</li>
              }
            </ul>
          }
          <div class="actions-row">
            <button type="submit" class="btn btn-primary" [disabled]="busy()">
              {{ busy() ? 'Granting…' : 'Grant role' }}
            </button>
          </div>
        </form>
      </section>

      <section class="card">
        <header class="card-head">
          <h3>Grants</h3>
          <span class="spacer"></span>
          <label class="row small">
            Show
            <select
              class="select"
              name="filterType"
              [ngModel]="filterType()"
              (ngModelChange)="filterType.set($event); grants.reload()"
            >
              <option [ngValue]="null">everyone</option>
              @for (t of principalTypes; track t) {
                <option [ngValue]="t">{{ principalNames[t] }}s</option>
              }
            </select>
          </label>
        </header>
        @if (grants.error(); as err) {
          <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
        } @else if (grants.loaded() && grants.value().length === 0) {
          <p class="pad muted">No grants.</p>
        } @else if (grants.value().length > 0) {
          <div class="table-wrap">
            <table class="grid">
              <thead>
                <tr>
                  <th>Who</th>
                  <th>Role</th>
                  <th>Applies to</th>
                  <th>Expires</th>
                  <th>Granted</th>
                  <th>Last used</th>
                  <th><span class="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                @for (g of grants.value(); track g.id) {
                  <tr>
                    <td>
                      {{ g.principalName || '#' + g.principalId }}
                      <span class="sub">{{ principalName(g.principalType) }}</span>
                    </td>
                    <td>{{ g.roleName || '#' + g.roleId }}</td>
                    <td>{{ scope(g) }}</td>
                    <td class="small">{{ g.expiresAtUtc ? when(g.expiresAtUtc) : 'Never' }}</td>
                    <td class="small">
                      {{ when(g.grantedAtUtc) }}
                      <span class="sub"
                        >{{ g.grantedBy || '' }}{{ g.reason ? ' — ' + g.reason : '' }}</span
                      >
                    </td>
                    <td class="small">{{ g.lastUsedAtUtc ? when(g.lastUsedAtUtc) : 'Not yet' }}</td>
                    <td class="actions">
                      <button
                        type="button"
                        class="btn btn-sm btn-danger"
                        *lscCan="P.IamGrantsManage"
                        (click)="revoking.set(g)"
                      >
                        Revoke
                      </button>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      </section>

      <section class="card">
        <header class="card-head"><h3>Why can they?</h3></header>
        <form class="card-body" (ngSubmit)="explain()">
          <p class="note">
            Ask the engine which grants give someone a permission at a scope — or what is missing.
          </p>
          <div class="form-grid">
            <label class="field">
              <span class="label">Who</span>
              <select
                class="select"
                name="xtype"
                [ngModel]="xType()"
                (ngModelChange)="xType.set($event); xId.set(null)"
              >
                @for (t of principalTypes; track t) {
                  <option [value]="t">{{ principalNames[t] }}</option>
                }
              </select>
            </label>
            <label class="field">
              <span class="label">{{ principalNames[xType()] }}</span>
              @if (xType() === 'User') {
                <select
                  class="select"
                  name="xid"
                  [ngModel]="xId()"
                  (ngModelChange)="xId.set($event)"
                >
                  <option [ngValue]="null">Choose…</option>
                  @for (m of members.value(); track m.userId) {
                    <option [ngValue]="m.userId">{{ label(m) }}</option>
                  }
                </select>
              } @else if (xType() === 'Team') {
                <select
                  class="select"
                  name="xid"
                  [ngModel]="xId()"
                  (ngModelChange)="xId.set($event)"
                >
                  <option [ngValue]="null">Choose…</option>
                  @for (t of teams.value(); track t.id) {
                    <option [ngValue]="t.id">{{ t.name }}</option>
                  }
                </select>
              } @else {
                <input
                  class="input"
                  type="number"
                  min="1"
                  name="xid"
                  [ngModel]="xId()"
                  (ngModelChange)="xId.set(toId($event))"
                />
              }
            </label>
            <label class="field">
              <span class="label">Permission</span>
              <select
                class="select"
                name="xperm"
                [ngModel]="xPermission()"
                (ngModelChange)="xPermission.set($event)"
              >
                <option [ngValue]="null">Choose…</option>
                @for (p of catalog.value(); track p.key) {
                  <option [ngValue]="p.key">{{ p.key }}</option>
                }
              </select>
            </label>
            <app-scope-target
              idPrefix="explain"
              label="At"
              [(scopeType)]="xScopeType"
              [(scopeId)]="xScopeId"
            />
          </div>
          <div class="actions-row">
            <button
              type="submit"
              class="btn btn-secondary"
              [disabled]="explaining() || !canExplain()"
            >
              {{ explaining() ? 'Checking…' : 'Check' }}
            </button>
          </div>
          @if (explained(); as r) {
            <div class="note" [class.warn]="!r.allowed" role="status">
              @if (r.allowed) {
                <strong>Yes.</strong> Through:
                <ul>
                  @for (v of r.via; track v.grantId) {
                    <li>
                      {{ v.roleName }} — {{ scopeText(v.scopeType, v.scopeId) }} (grant #{{
                        v.grantId
                      }})
                    </li>
                  }
                </ul>
              } @else {
                <strong>No.</strong>
                {{ r.missingReason || 'No grant gives this permission at that scope.' }}
              }
            </div>
          }
        </form>
      </section>

      <app-confirm-dialog
        [open]="revoking() !== null"
        [title]="
          'Revoke ' +
          (revoking()?.roleName ?? 'this role') +
          ' from ' +
          (revoking()?.principalName ?? 'this principal') +
          '?'
        "
        message="The permissions it gave stop working within seconds."
        confirmLabel="Revoke"
        confirmVariant="destructive"
        [loading]="busy()"
        (confirm)="revoke()"
        (cancelled)="revoking.set(null)"
      >
        <label class="field">
          <span class="label">Reason (recorded in the audit log)</span>
          <input
            class="input"
            name="revokeReason"
            [ngModel]="revokeReason()"
            (ngModelChange)="revokeReason.set($event)"
          />
        </label>
      </app-confirm-dialog>
    </div>
  `,
})
export class GrantsPageComponent {
  private readonly iam = inject(IamApiService);
  private readonly notify = inject(NotificationService);

  protected readonly P = Permission;
  protected readonly when = when;
  protected readonly principalTypes = PRINCIPAL_TYPES;
  protected readonly principalNames = PRINCIPAL_NAMES;

  readonly filterType = signal<PrincipalType | null>(null);
  readonly grants = iamResource(
    () => this.iam.grants({ principalType: this.filterType() }),
    [] as IamGrant[],
    'Could not load grants.',
  );
  readonly members = iamResource(() => this.iam.members(), [] as IamMember[]);
  readonly teams = iamResource(() => this.iam.teams(), [] as IamTeam[]);
  readonly roles = iamResource(() => this.iam.roles(), [] as IamRole[]);
  readonly catalog = iamResource<PermissionDefinition[]>(
    () => this.iam.permissionCatalog().pipe(catchError(() => of([...PERMISSION_CATALOG]))),
    [...PERMISSION_CATALOG],
  );

  // Grant form
  readonly pType = signal<PrincipalType>('User');
  readonly pId = signal<number | null>(null);
  readonly roleId = signal<number | null>(null);
  readonly scopeType = signal<ScopeType>('Tenant');
  readonly scopeId = signal<number | null>(null);
  readonly expires = signal('');
  readonly reason = signal('');
  readonly submitted = signal(false);
  readonly busy = signal(false);
  readonly errors = computed(() =>
    grantErrors({
      principalId: this.pId(),
      roleId: this.roleId(),
      scopeType: this.scopeType(),
      scopeId: this.scopeId(),
      expiresLocal: this.expires(),
      reason: this.reason(),
    }),
  );
  readonly orgWideOnly = computed(() =>
    unscopeableIn(
      this.roles.value().find((r) => r.id === this.roleId()),
      this.scopeType(),
      this.catalog.value(),
    ),
  );

  readonly revoking = signal<IamGrant | null>(null);
  readonly revokeReason = signal('');

  // Explain
  readonly xType = signal<PrincipalType>('User');
  readonly xId = signal<number | null>(null);
  readonly xPermission = signal<string | null>(null);
  readonly xScopeType = signal<ScopeType>('Tenant');
  readonly xScopeId = signal<number | null>(null);
  readonly explaining = signal(false);
  readonly explained = signal<ExplainResult | null>(null);
  readonly canExplain = computed(
    () =>
      !!this.xId() && !!this.xPermission() && (this.xScopeType() === 'Tenant' || !!this.xScopeId()),
  );

  constructor() {
    this.grants.reload();
    this.members.reload();
    this.teams.reload();
    this.roles.reload();
    this.catalog.reload();
  }

  label(m: IamMember): string {
    return memberLabel(m);
  }

  principalName(t: string): string {
    return PRINCIPAL_NAMES[t as PrincipalType] ?? t;
  }

  scope(g: IamGrant): string {
    return scopeLabel(g.scopeType, g.scopeId, g.scopeName);
  }

  scopeText(type: string, id: number | null): string {
    return scopeLabel(type, id);
  }

  toId(v: unknown): number | null {
    const n = Number(v);
    return v === null || v === '' || !Number.isInteger(n) || n <= 0 ? null : n;
  }

  grant(): void {
    this.submitted.set(true);
    if (this.errors().length || this.busy()) return;
    this.busy.set(true);
    this.iam
      .createGrant({
        principalType: this.pType(),
        principalId: this.pId()!,
        roleId: this.roleId()!,
        scopeType: this.scopeType(),
        scopeId: this.scopeType() === 'Tenant' ? null : this.scopeId(),
        expiresAtUtc: localToUtc(this.expires()),
        reason: this.reason().trim() || null,
      })
      .subscribe({
        next: () => {
          this.busy.set(false);
          this.submitted.set(false);
          this.notify.success('Role granted.');
          this.pId.set(null);
          this.roleId.set(null);
          this.expires.set('');
          this.reason.set('');
          this.grants.reload();
        },
        error: (e) => {
          this.busy.set(false);
          if (reportable(e)) this.notify.error(errorText(e, 'The role was not granted.'));
        },
      });
  }

  revoke(): void {
    const g = this.revoking();
    if (!g || this.busy()) return;
    this.busy.set(true);
    this.iam.revokeGrant(g.id, this.revokeReason().trim() || null).subscribe({
      next: () => {
        this.busy.set(false);
        this.revoking.set(null);
        this.revokeReason.set('');
        this.notify.success('Grant revoked.');
        this.grants.reload();
      },
      error: (e) => {
        this.busy.set(false);
        this.revoking.set(null);
        if (reportable(e)) this.notify.error(errorText(e, 'The grant was not revoked.'));
      },
    });
  }

  explain(): void {
    if (!this.canExplain() || this.explaining()) return;
    this.explaining.set(true);
    this.explained.set(null);
    this.iam
      .explain({
        principalType: this.xType(),
        principalId: this.xId()!,
        permission: this.xPermission()!,
        scopeType: this.xScopeType(),
        scopeId: this.xScopeType() === 'Tenant' ? null : this.xScopeId(),
      })
      .subscribe({
        next: (r) => {
          this.explaining.set(false);
          this.explained.set(r ? { ...r, via: r.via ?? [] } : null);
        },
        error: (e) => {
          this.explaining.set(false);
          if (reportable(e)) this.notify.error(errorText(e, 'The engine could not answer that.'));
        },
      });
  }
}
