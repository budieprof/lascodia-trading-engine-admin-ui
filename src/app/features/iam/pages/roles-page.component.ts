import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { catchError, of } from 'rxjs';

import { AuthService } from '@core/auth/auth.service';
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
import { errorText, groupCatalog, reportable, roleErrors, toggled, unknownKeys } from '../iam.logic';
import type { IamRole } from '../iam.types';
import { iamResource } from '../shared/iam-resource';
import { MfaHintComponent } from '../shared/mfa-hint.component';

type Mode = 'idle' | 'view' | 'edit' | 'create';

/**
 * Roles of this organisation (U3.4, contract C3.5). System roles (Owner, Admin, Trader, …) are shown
 * read-only; custom roles are composed from the permission catalog, grouped by category, with each
 * key's flags (step-up, two-person, organisation-wide only, deprecated) beside it. The catalog comes
 * from the engine (`GET /admin/permissions/catalog`), falling back to the console's generated copy.
 */
@Component({
  selector: 'app-iam-roles-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, PageHeaderComponent, ConfirmDialogComponent, LscCanDirective, MfaHintComponent],
  styleUrl: '../shared/iam-page.scss',
  styles: [
    `
      .layout {
        display: grid;
        grid-template-columns: minmax(260px, 1fr) 2fr;
        gap: var(--space-3);
        align-items: start;
      }
      @media (max-width: 1024px) {
        .layout {
          grid-template-columns: 1fr;
        }
      }
      .role-list {
        list-style: none;
        margin: 0;
        padding: 0;
      }
      .role-row {
        width: 100%;
        display: block;
        text-align: left;
        padding: var(--space-2) var(--space-4);
        border: none;
        border-bottom: 1px solid var(--border);
        background: transparent;
        color: inherit;
        font-family: inherit;
        cursor: pointer;
      }
      .role-row:hover,
      .role-row[aria-current='true'] {
        background: var(--bg-tertiary);
      }
      .role-row[aria-current='true'] {
        box-shadow: inset 3px 0 0 var(--accent);
      }
      .role-name {
        font-weight: var(--font-semibold);
        font-size: var(--text-sm);
      }
      .flag {
        margin-left: 4px;
      }
    `,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Roles"
        subtitle="What each role allows. System roles are fixed; custom roles are yours to compose. Give roles to people on Access grants."
      >
        <button type="button" class="btn btn-secondary" (click)="roles.reload()" [disabled]="roles.loading()">
          {{ roles.loading() ? 'Loading…' : 'Refresh' }}
        </button>
        <button type="button" class="btn btn-primary" *lscCan="P.RolesManage" (click)="startCreate()">New role</button>
      </app-page-header>

      <div class="layout">
        <section class="card">
          <header class="card-head"><h3>{{ roles.value().length }} roles</h3></header>
          @if (roles.error(); as err) {
            <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
          }
          <ul class="role-list">
            @for (r of sortedRoles(); track r.id) {
              <li>
                <button type="button" class="role-row" [attr.aria-current]="selectedId() === r.id" (click)="select(r)">
                  <span class="role-name">{{ r.name }}</span>
                  @if (r.isSystem) {
                    <span class="chip flag">system</span>
                  }
                  <span class="sub small muted">
                    {{ r.permissions.length }} permission{{ r.permissions.length === 1 ? '' : 's' }}
                    @if (r.assignmentCount !== null && r.assignmentCount !== undefined) {
                      · {{ r.assignmentCount }} grant{{ r.assignmentCount === 1 ? '' : 's' }}
                    }
                  </span>
                </button>
              </li>
            }
          </ul>
        </section>

        <section class="card">
          @if (mode() === 'idle') {
            <p class="pad muted">Choose a role to see what it allows{{ canManage() ? ', or create a new one' : '' }}.</p>
          } @else {
            <header class="card-head">
              <h3>{{ mode() === 'create' ? 'New role' : (selected()?.name ?? '') }}</h3>
              @if (selected()?.isSystem) {
                <span class="chip">system — read-only</span>
              }
              <span class="spacer"></span>
              <button type="button" class="btn btn-sm btn-secondary" (click)="close()">Close</button>
            </header>
            <form class="card-body" (ngSubmit)="save()">
              <div class="form-grid">
                <label class="field">
                  <span class="label">Name</span>
                  <input class="input" name="name" [ngModel]="name()" (ngModelChange)="name.set($event)" [disabled]="readOnly()" />
                </label>
                <label class="field">
                  <span class="label">Description</span>
                  <input class="input" name="description" [ngModel]="description()" (ngModelChange)="description.set($event)" [disabled]="readOnly()" />
                </label>
              </div>

              @if (unknown().length) {
                <p class="note warn">
                  This role also holds permissions this console does not know yet: {{ unknown().join(', ') }}. They are kept when you save.
                </p>
              }

              <fieldset class="matrix" [disabled]="readOnly()">
                <legend class="label">Permissions · {{ chosen().size }} selected</legend>
                @for (g of groups(); track g.category) {
                  <div>
                    <span class="matrix-cat">{{ g.category }}</span>
                    <div class="matrix-checks">
                      @for (p of g.permissions; track p.key) {
                        <label class="check" [title]="p.description">
                          <input type="checkbox" [checked]="chosen().has(p.key)" (change)="toggle(p.key)" />
                          <span>{{ p.key }}</span>
                          @if (p.stepUp) {
                            <span class="chip info flag" title="Needs a fresh sign-in with a second factor">MFA</span>
                          }
                          @if (p.twoPerson) {
                            <span class="chip warn flag" title="Needs a second person's approval">2-person</span>
                          }
                          @if (!p.scopeable) {
                            <span class="chip flag" title="Only counts when the role is given for the whole organisation">org-wide</span>
                          }
                          @if (p.deprecated) {
                            <span class="chip flag" title="Still enforced; give the specific keys instead">deprecated</span>
                          }
                        </label>
                      }
                    </div>
                  </div>
                }
              </fieldset>

              @if (!readOnly()) {
                @if (submitted() && errors().length) {
                  <ul class="errors" role="alert">
                    @for (e of errors(); track e) {
                      <li>{{ e }}</li>
                    }
                  </ul>
                }
                <div class="actions-row">
                  <app-mfa-hint [permission]="P.RolesManage" />
                  @if (mode() === 'edit') {
                    <button
                      type="button"
                      class="btn btn-danger"
                      [disabled]="busy() || inUse()"
                      [title]="inUse() ? 'Revoke its grants first' : ''"
                      (click)="deleting.set(true)"
                    >
                      Delete role
                    </button>
                  }
                  <button type="submit" class="btn btn-primary" [disabled]="busy()">
                    {{ busy() ? 'Saving…' : mode() === 'create' ? 'Create role' : 'Save changes' }}
                  </button>
                </div>
              }
            </form>
          }
        </section>
      </div>

      <app-confirm-dialog
        [open]="deleting()"
        [title]="'Delete role ' + (selected()?.name ?? '') + '?'"
        message="The role is removed from this organisation. This cannot be undone."
        confirmLabel="Delete role"
        confirmVariant="destructive"
        [loading]="busy()"
        (confirm)="remove()"
        (cancelled)="deleting.set(false)"
      />
    </div>
  `,
})
export class IamRolesPageComponent {
  private readonly iam = inject(IamApiService);
  private readonly notify = inject(NotificationService);
  private readonly auth = inject(AuthService);

  protected readonly P = Permission;

  readonly roles = iamResource(() => this.iam.roles(), [] as IamRole[], 'Could not load roles.');
  readonly catalog = iamResource<PermissionDefinition[]>(
    () => this.iam.permissionCatalog().pipe(catchError(() => of([...PERMISSION_CATALOG]))),
    [...PERMISSION_CATALOG],
  );
  readonly groups = computed(() => groupCatalog(this.catalog.value()));
  readonly sortedRoles = computed(() =>
    [...this.roles.value()].sort((a, b) => Number(b.isSystem) - Number(a.isSystem) || a.name.localeCompare(b.name)),
  );

  readonly mode = signal<Mode>('idle');
  readonly selectedId = signal<number | null>(null);
  readonly selected = computed(() => this.roles.value().find((r) => r.id === this.selectedId()) ?? null);
  readonly canManage = computed(() => this.auth.hasPermission(Permission.RolesManage));
  readonly readOnly = computed(() => this.mode() === 'view' || !this.canManage());
  readonly inUse = computed(() => (this.selected()?.assignmentCount ?? 0) > 0);

  readonly name = signal('');
  readonly description = signal('');
  readonly chosen = signal<Set<string>>(new Set());
  readonly unknown = computed(() => unknownKeys([...this.chosen()], this.catalog.value()));
  readonly submitted = signal(false);
  readonly errors = computed(() =>
    roleErrors(this.name(), [...this.chosen()], this.roles.value(), this.mode() === 'edit' ? this.selectedId() : null),
  );
  readonly busy = signal(false);
  readonly deleting = signal(false);

  constructor() {
    this.roles.reload();
    this.catalog.reload();
  }

  select(r: IamRole): void {
    this.selectedId.set(r.id);
    this.mode.set(r.isSystem ? 'view' : 'edit');
    this.name.set(r.name);
    this.description.set(r.description ?? '');
    this.chosen.set(new Set(r.permissions));
    this.submitted.set(false);
  }

  startCreate(): void {
    this.selectedId.set(null);
    this.mode.set('create');
    this.name.set('');
    this.description.set('');
    this.chosen.set(new Set());
    this.submitted.set(false);
  }

  close(): void {
    this.mode.set('idle');
    this.selectedId.set(null);
  }

  toggle(key: string): void {
    this.chosen.update((s) => toggled(s, key));
  }

  save(): void {
    this.submitted.set(true);
    if (this.errors().length || this.busy() || this.readOnly()) return;
    const body = {
      name: this.name().trim(),
      description: this.description().trim(),
      permissions: [...this.chosen()].sort(),
    };
    this.busy.set(true);
    const id = this.selectedId();
    const call = this.mode() === 'create' || id === null ? this.iam.createRole(body) : this.iam.updateRole(id, body);
    call.subscribe({
      next: (created) => {
        this.busy.set(false);
        this.notify.success(`Role "${body.name}" saved.`);
        this.roles.reload();
        const newId = (created as IamRole | null)?.id;
        if (this.mode() === 'create' && newId) {
          this.selectedId.set(newId);
          this.mode.set('edit');
        }
      },
      error: (e) => {
        this.busy.set(false);
        if (reportable(e)) this.notify.error(errorText(e, 'The role was not saved.'));
      },
    });
  }

  remove(): void {
    const id = this.selectedId();
    if (id === null || this.busy()) return;
    this.busy.set(true);
    this.iam.deleteRole(id).subscribe({
      next: () => {
        this.busy.set(false);
        this.deleting.set(false);
        this.notify.success('Role deleted.');
        this.close();
        this.roles.reload();
      },
      error: (e) => {
        this.busy.set(false);
        this.deleting.set(false);
        if (reportable(e)) this.notify.error(errorText(e, 'The role was not deleted.'));
      },
    });
  }
}
