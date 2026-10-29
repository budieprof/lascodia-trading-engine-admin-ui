import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { catchError, of } from 'rxjs';

import {
  AdminUsersService,
  AdminUserCredentialDto,
  AdminUserDto,
} from '@core/services/admin-users.service';
import { RolesService, RoleDto } from '@core/services/roles.service';
import { NotificationService } from '@core/notifications/notification.service';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { ModalA11yDirective } from '@shared/directives/modal-a11y.directive';
import { RouterLink } from '@angular/router';
import { StatTilesComponent, type StatTile } from '@features/iam/shared/stat-tiles.component';
import { AuditTrailComponent } from '@features/iam/shared/audit-trail.component';
import { ago } from '@features/iam/shared/admin-context.logic';

type EditState = { id: number; email: string; displayName: string };
type RolesState = { id: number; username: string; selected: Set<number> };

@Component({
  selector: 'app-admin-users-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    DatePipe,
    PageHeaderComponent,
    EmptyStateComponent,
    ErrorStateComponent,
    ConfirmDialogComponent,
    ModalA11yDirective,
    RouterLink,
    StatTilesComponent,
    AuditTrailComponent,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Admin Users"
        subtitle="Provision admin accounts, assign roles, and manage access. New users and password resets issue a one-time temporary password."
      />

      <app-stat-tiles [tiles]="tiles()" label="Admin users summary" />

      <!-- Temp-password callout — shown once after create / reset -->
      @if (lastCredential(); as cred) {
        <section class="cred-callout">
          <div class="cred-head">
            <h3>Temporary password for &#64;{{ cred.username }}</h3>
            <span class="once">Shown once — copy it now</span>
          </div>
          <div class="cred-body">
            <code class="cred-pass mono">{{ cred.temporaryPassword }}</code>
            <button type="button" class="btn btn-primary" (click)="copyPassword(cred)">
              {{ copied() ? 'Copied' : 'Copy' }}
            </button>
            <button type="button" class="btn btn-ghost" (click)="lastCredential.set(null)">
              Dismiss
            </button>
          </div>
        </section>
      }

      <!-- New user panel -->
      <section class="card">
        <header class="card-head">
          <h3>New user</h3>
          <span class="muted"
            >Username, email and at least one role. Display name is optional.</span
          >
        </header>
        <!-- The fields are signals: canCreate() used to be a computed over plain properties, which
             never re-ran, so "Create user" stayed disabled whatever was typed. -->
        <form class="form-grid" (ngSubmit)="createUser()">
          <label class="field">
            <span class="label">Username</span>
            <input
              class="input"
              [class.invalid]="usernameError()"
              [ngModel]="newUsername()"
              (ngModelChange)="newUsername.set($event)"
              name="username"
              placeholder="jdoe"
              autocomplete="off"
              required
            />
            @if (usernameError(); as err) {
              <span class="field-error">{{ err }}</span>
            }
          </label>
          <label class="field">
            <span class="label">Email</span>
            <input
              class="input"
              type="email"
              [class.invalid]="emailError()"
              [ngModel]="newEmail()"
              (ngModelChange)="newEmail.set($event)"
              name="email"
              placeholder="jdoe@lascodia.com"
              autocomplete="off"
              required
            />
            @if (emailError(); as err) {
              <span class="field-error">{{ err }}</span>
            }
          </label>
          <label class="field">
            <span class="label">Display name</span>
            <input
              class="input"
              [ngModel]="newDisplayName()"
              (ngModelChange)="newDisplayName.set($event)"
              name="displayName"
              placeholder="Jane Doe"
              maxlength="128"
            />
          </label>
          <fieldset class="roles-field">
            <legend class="label">Roles</legend>
            @if (roles().length === 0) {
              <span class="muted small">No roles available.</span>
            } @else {
              <div class="role-checks">
                @for (r of roles(); track r.id) {
                  <label class="check">
                    <input
                      type="checkbox"
                      [checked]="newRoleIds().has(r.id)"
                      (change)="toggleNewRole(r.id)"
                    />
                    <span>{{ r.name }}</span>
                  </label>
                }
              </div>
            }
          </fieldset>
          <div class="form-actions">
            @if (createBlocker(); as why) {
              <span class="muted small">{{ why }}</span>
            }
            <button
              type="submit"
              class="btn btn-primary"
              [disabled]="createPending() || !canCreate()"
            >
              {{ createPending() ? 'Creating…' : 'Create user' }}
            </button>
          </div>
        </form>
      </section>

      <!-- Toolbar -->
      <div class="toolbar">
        <input
          type="search"
          class="input search"
          placeholder="Search users…"
          [ngModel]="search()"
          (ngModelChange)="onSearch($event)"
        />
        <span class="muted">{{ users().length }} users</span>
        <button type="button" class="btn btn-ghost" (click)="reload()" [disabled]="loading()">
          {{ loading() ? 'Loading…' : 'Refresh' }}
        </button>
      </div>

      <section class="card">
        <header class="card-head">
          <h3>Users</h3>
          <span class="muted">{{ users().length }} total</span>
        </header>

        @if (loading() && users().length === 0) {
          <p class="muted small pad">Loading…</p>
        } @else if (loadError() && users().length === 0) {
          <!-- A failed read is not "no users": an empty roster reads as "nobody has access". -->
          <app-error-state
            title="Could not load admin users"
            [message]="loadError()!"
            (retry)="reload()"
          />
        } @else if (users().length === 0) {
          <app-empty-state
            title="No users found"
            description="Adjust the search or create a new user above."
          />
        } @else {
          <div class="table-scroll">
            <table class="data-table">
              <thead>
                <tr>
                  <th>Username</th>
                  <th>Display name</th>
                  <th>Email</th>
                  <th>Roles</th>
                  <th>Status</th>
                  <th>Last login</th>
                  <th class="actions">Actions</th>
                </tr>
              </thead>
              <tbody>
                @for (u of users(); track u.id) {
                  <tr>
                    <td class="mono">
                      &#64;{{ u.username }}
                      @if (u.isSuperAdmin) {
                        <span class="chip super">super</span>
                      }
                    </td>
                    <td>{{ u.displayName }}</td>
                    <td class="email">{{ u.email }}</td>
                    <td>
                      @for (role of u.roles; track role.id) {
                        <span class="chip">{{ role.name }}</span>
                      }
                      @if (u.roles.length === 0) {
                        <span class="muted small">none</span>
                      }
                    </td>
                    <td>
                      <span class="chip" [class.active]="u.isActive" [class.inactive]="!u.isActive">
                        {{ u.isActive ? 'Active' : 'Inactive' }}
                      </span>
                    </td>
                    <td class="muted small">
                      @if (u.lastLoginAt) {
                        {{ u.lastLoginAt | date: 'MMM d, yyyy HH:mm' }}
                      } @else {
                        never
                      }
                    </td>
                    <td class="actions">
                      <button type="button" class="btn btn-ghost btn-xs" (click)="openEdit(u)">
                        Edit
                      </button>
                      <button type="button" class="btn btn-ghost btn-xs" (click)="openRoles(u)">
                        Roles
                      </button>
                      <!-- The engine refuses to deactivate a super admin; say so instead of
                           offering a button that always fails. -->
                      <button
                        type="button"
                        class="btn btn-ghost btn-xs"
                        [disabled]="busyId() === u.id || (u.isActive && u.isSuperAdmin)"
                        [title]="
                          u.isActive && u.isSuperAdmin ? 'A super admin cannot be deactivated' : ''
                        "
                        (click)="askAction(u, u.isActive ? 'deactivate' : 'activate')"
                      >
                        {{ u.isActive ? 'Deactivate' : 'Activate' }}
                      </button>
                      <button
                        type="button"
                        class="btn btn-ghost btn-xs"
                        [disabled]="busyId() === u.id"
                        (click)="askAction(u, 'reset')"
                      >
                        Reset password
                      </button>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      </section>

      <div class="ctx-cols">
        <section class="ctx-card">
          <h3>Roles in use</h3>
          <ul class="ctx-list">
            @for (r of roleUse(); track r.name) {
              <li>
                <strong>{{ r.name }}</strong> <span class="muted">— {{ r.users.join(', ') }}</span>
              </li>
            } @empty {
              <li class="muted">No role is assigned to anyone yet.</li>
            }
          </ul>
          <p class="muted small-note">
            {{ unusedRoles() }} of {{ roles().length }} roles are assigned to nobody. Roles are
            bundles of permissions — <a routerLink="/admin/roles">see what each holds</a>; in an
            organisation they are given as grants on <a routerLink="/iam/grants">Access grants</a>.
          </p>
        </section>
        <app-audit-trail
          heading="User changes"
          [actions]="['iam.user.', 'auth.password.']"
          empty="No admin user has been created, edited, deactivated or had a password reset since the audit log began. Each is recorded here."
        />
      </div>
    </div>

    <!-- Edit profile panel. Escape + focus come from appModalA11y; before it, an open panel
         ignored Escape and sat over the row's other buttons. -->
    @if (editState(); as ed) {
      <div class="overlay" (click)="editState.set(null)">
        <div
          class="panel"
          role="dialog"
          aria-modal="true"
          aria-labelledby="admin-user-edit-title"
          appModalA11y
          (dismiss)="editState.set(null)"
          (click)="$event.stopPropagation()"
        >
          <header class="panel-head">
            <h3 id="admin-user-edit-title">Edit profile</h3>
            <button
              type="button"
              class="close-btn"
              aria-label="Close"
              title="Close"
              (click)="editState.set(null)"
            >
              ×
            </button>
          </header>
          <form class="panel-form" (ngSubmit)="saveEdit()">
            <div class="panel-body">
              <label class="field">
                <span class="label">Email</span>
                <input
                  class="input"
                  type="email"
                  [(ngModel)]="ed.email"
                  name="editEmail"
                  required
                />
              </label>
              <label class="field">
                <span class="label">Display name</span>
                <input class="input" [(ngModel)]="ed.displayName" name="editDisplayName" required />
              </label>
            </div>
            <footer class="panel-actions">
              <button type="submit" class="btn btn-primary" [disabled]="busyId() === ed.id">
                Save
              </button>
            </footer>
          </form>
        </div>
      </div>
    }

    <!-- Manage roles panel -->
    @if (rolesState(); as rs) {
      <div class="overlay" (click)="rolesState.set(null)">
        <div
          class="panel"
          role="dialog"
          aria-modal="true"
          aria-labelledby="admin-user-roles-title"
          appModalA11y
          (dismiss)="rolesState.set(null)"
          (click)="$event.stopPropagation()"
        >
          <header class="panel-head">
            <h3 id="admin-user-roles-title">Manage roles · &#64;{{ rs.username }}</h3>
            <button
              type="button"
              class="close-btn"
              aria-label="Close"
              title="Close"
              (click)="rolesState.set(null)"
            >
              ×
            </button>
          </header>
          <div class="panel-body">
            <div class="role-checks col">
              @for (r of roles(); track r.id) {
                <label class="check">
                  <input
                    type="checkbox"
                    [checked]="rs.selected.has(r.id)"
                    (change)="toggleRoleAssign(rs, r.id)"
                  />
                  <span>{{ r.name }}</span>
                  @if (r.description) {
                    <span class="muted small">— {{ r.description }}</span>
                  }
                </label>
              }
            </div>
          </div>
          <footer class="panel-actions">
            <button
              type="button"
              class="btn btn-primary"
              [disabled]="busyId() === rs.id"
              (click)="saveRoles()"
            >
              Save roles
            </button>
          </footer>
        </div>
      </div>
    }

    <!-- Deactivating locks a person out; a reset invalidates their current password at once. -->
    <app-confirm-dialog
      [open]="pendingAction() !== null"
      [title]="actionTitle()"
      [message]="actionMessage()"
      [confirmLabel]="actionConfirmLabel()"
      [confirmVariant]="pendingAction()?.kind === 'activate' ? 'primary' : 'destructive'"
      [loading]="pendingAction() !== null && busyId() === pendingAction()!.user.id"
      (confirm)="confirmAction()"
      (cancelled)="pendingAction.set(null)"
    />
  `,
  styles: [
    `
      .ctx-cols {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(380px, 1fr));
        gap: var(--space-3);
        align-items: start;
      }
      .ctx-card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-3) var(--space-4);
      }
      .ctx-card h3 {
        margin: 0 0 var(--space-2);
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      .ctx-list {
        margin: 0;
        padding-left: var(--space-5);
        list-style: disc;
        font-size: var(--text-sm);
        display: grid;
        gap: 4px;
      }
      .small-note {
        font-size: var(--text-xs);
        margin: var(--space-2) 0 0;
      }

      .page {
        padding: var(--space-2) 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: hidden;
      }
      .card-head {
        display: flex;
        align-items: baseline;
        gap: var(--space-3);
        padding: var(--space-3) var(--space-4);
        border-bottom: 1px solid var(--border);
      }
      .card-head h3 {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      .muted {
        color: var(--text-tertiary);
      }
      /* Header/toolbar captions sat at body size — larger than the 13px card title beside them. */
      .card-head .muted,
      .toolbar .muted {
        font-size: var(--text-xs);
      }
      .small {
        font-size: var(--text-xs);
      }
      .pad {
        padding: var(--space-3) var(--space-4);
      }
      .mono {
        font-family: 'SF Mono', 'Menlo', monospace;
      }

      /* Temp-password callout */
      .cred-callout {
        background: var(--bg-secondary);
        border: 1px solid var(--accent);
        border-radius: var(--radius-md);
        overflow: hidden;
      }
      .cred-head {
        display: flex;
        align-items: baseline;
        gap: var(--space-3);
        padding: var(--space-3) var(--space-4);
        border-bottom: 1px solid var(--border);
      }
      .cred-head h3 {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      .once {
        font-size: var(--text-xs);
        color: var(--loss);
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .cred-body {
        display: flex;
        align-items: center;
        gap: var(--space-3);
        padding: var(--space-3) var(--space-4);
        flex-wrap: wrap;
      }
      .cred-pass {
        font-size: var(--text-md);
        font-weight: var(--font-semibold);
        padding: 8px 14px;
        background: var(--bg-tertiary);
        border-radius: var(--radius-sm);
        color: var(--text-primary);
        letter-spacing: 0.04em;
      }

      /* Forms */
      .form-grid {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: var(--space-3);
        padding: var(--space-3) var(--space-4);
      }
      @media (max-width: 900px) {
        .form-grid {
          grid-template-columns: 1fr;
        }
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: var(--space-1);
      }
      .label {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        font-weight: var(--font-medium);
      }
      .input {
        padding: 8px 10px;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-sm);
        outline: none;
      }
      .input:focus {
        border-color: var(--accent);
      }
      .input.invalid {
        border-color: var(--tone-red);
      }
      .field-error {
        font-size: var(--text-xs);
        color: var(--tone-red);
      }
      .roles-field {
        grid-column: 1 / -1;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        padding: var(--space-2) var(--space-3);
        margin: 0;
      }
      .roles-field legend {
        padding: 0 var(--space-1);
      }
      .role-checks {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-2) var(--space-4);
      }
      .role-checks.col {
        flex-direction: column;
        gap: var(--space-2);
      }
      .check {
        display: flex;
        align-items: center;
        gap: var(--space-1);
        font-size: var(--text-sm);
        color: var(--text-primary);
        cursor: pointer;
      }
      .form-actions {
        grid-column: 1 / -1;
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: var(--space-3);
      }

      /* Buttons */
      .btn {
        padding: 8px 16px;
        border-radius: var(--radius-full);
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        border: 1px solid transparent;
        cursor: pointer;
      }
      .btn-primary {
        background: var(--accent);
        color: #fff;
      }
      .btn-primary:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .btn-ghost {
        background: transparent;
        color: var(--text-secondary);
        border-color: var(--border);
      }
      .btn-ghost:hover:not(:disabled) {
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }
      .btn-ghost:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .btn-xs {
        padding: 4px 10px;
        font-size: var(--text-xs);
      }
      .link-btn {
        background: transparent;
        border: none;
        padding: 0;
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
        color: var(--accent);
        cursor: pointer;
      }
      .link-btn:hover {
        text-decoration: underline;
      }

      /* Toolbar */
      .toolbar {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        flex-wrap: wrap;
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-2) var(--space-3);
      }
      .input.search {
        flex: 1 1 240px;
        min-width: 200px;
        height: 32px;
      }

      /* Table */
      .table-scroll {
        max-height: 620px;
        overflow-y: auto;
      }
      .data-table {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-xs);
      }
      .data-table th,
      .data-table td {
        padding: 8px var(--space-3);
        border-bottom: 1px solid var(--border);
        text-align: left;
        vertical-align: middle;
      }
      .data-table tbody tr:last-child td {
        border-bottom: none;
      }
      .data-table th {
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        font-size: 10.5px;
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        position: sticky;
        top: 0;
        z-index: 1;
      }
      /* Email was painted text-tertiary (#636366 on the dark row) — a real
         identifier column, not decoration, so it gets body contrast. */
      .data-table td.email {
        color: var(--text-secondary);
      }
      .data-table .actions {
        text-align: right;
        white-space: nowrap;
      }
      .data-table td.actions {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        justify-content: flex-end;
      }
      .chip {
        display: inline-flex;
        align-items: center;
        padding: 2px 8px;
        border-radius: var(--radius-full);
        font-size: 10.5px;
        font-weight: var(--font-semibold);
        background: rgba(10, 132, 255, 0.12);
        color: #0a84ff;
        margin-right: 4px;
      }
      .chip.active {
        background: rgba(52, 199, 89, 0.14);
        color: var(--profit);
      }
      .chip.inactive {
        background: rgba(142, 142, 147, 0.16);
        color: var(--text-tertiary);
      }
      .chip.super {
        background: rgba(255, 59, 48, 0.14);
        color: var(--loss);
      }

      /* Overlay panels */
      .overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.4);
        display: grid;
        place-items: center;
        z-index: 100;
        padding: var(--space-4);
      }
      /* Dialog shell: header and footer stay put, only the body scrolls, and
         the whole thing is capped at 90vh like every other dialog in the app.
         The old panel scrolled as one block, so the actions could scroll out
         of view, and it carried both a "Close" link and a "Cancel" button —
         the × in the header is the single dismiss control now. */
      .panel {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        width: 100%;
        max-width: 480px;
        max-height: 90vh;
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }
      .panel-form {
        display: flex;
        flex-direction: column;
        min-height: 0;
        flex: 1;
      }
      .panel-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-3);
        padding: var(--space-3) var(--space-4);
        border-bottom: 1px solid var(--border);
        flex-shrink: 0;
      }
      .panel-head h3 {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .close-btn {
        flex-shrink: 0;
        width: 28px;
        height: 28px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border: none;
        border-radius: var(--radius-full);
        background: transparent;
        color: var(--text-secondary);
        font-size: 20px;
        line-height: 1;
        cursor: pointer;
        font-family: inherit;
      }
      .close-btn:hover {
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }
      .panel-body {
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
        padding: var(--space-4);
        overflow-y: auto;
        min-height: 0;
        flex: 1;
      }
      .panel-actions {
        display: flex;
        justify-content: flex-end;
        gap: var(--space-2);
        padding: var(--space-3) var(--space-4);
        border-top: 1px solid var(--border);
        flex-shrink: 0;
      }
    `,
  ],
})
export class AdminUsersPageComponent {
  private readonly service = inject(AdminUsersService);
  private readonly rolesService = inject(RolesService);
  private readonly notify = inject(NotificationService);

  readonly users = signal<AdminUserDto[]>([]);
  readonly roles = signal<RoleDto[]>([]);
  readonly loading = signal(false);
  readonly loadError = signal<string | null>(null);
  readonly createPending = signal(false);
  readonly busyId = signal<number | null>(null);
  readonly search = signal('');

  readonly lastCredential = signal<AdminUserCredentialDto | null>(null);
  readonly copied = signal(false);

  // New-user form fields — signals, so canCreate() and the field errors re-evaluate as you type.
  readonly newUsername = signal('');
  readonly newEmail = signal('');
  readonly newDisplayName = signal('');
  readonly newRoleIds = signal<Set<number>>(new Set());

  /** Same rule as the engine's CreateAdminUserCommandValidator, shown before the round trip. */
  readonly usernameError = computed<string | null>(() => {
    const v = this.newUsername().trim();
    if (!v) return null;
    if (v.length > 64) return 'At most 64 characters.';
    return /^[A-Za-z0-9._-]+$/.test(v) ? null : 'Letters, digits, dot, underscore and hyphen only.';
  });
  readonly emailError = computed<string | null>(() => {
    const v = this.newEmail().trim();
    if (!v) return null;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? null : 'Not a valid email address.';
  });
  /** Why "Create user" is disabled, once the operator has started filling the form. */
  readonly createBlocker = computed<string | null>(() => {
    const started = !!(this.newUsername().trim() || this.newEmail().trim());
    if (!started) return null;
    if (!this.newUsername().trim()) return 'Enter a username.';
    if (!this.newEmail().trim()) return 'Enter an email.';
    if (this.usernameError() || this.emailError()) return null; // shown on the field
    if (this.newRoleIds().size === 0) return 'Pick at least one role.';
    return null;
  });
  readonly canCreate = computed(
    () =>
      this.newUsername().trim().length > 0 &&
      this.newEmail().trim().length > 0 &&
      !this.usernameError() &&
      !this.emailError() &&
      this.newRoleIds().size > 0,
  );

  /** Deactivate / activate / password reset waiting on the confirmation dialog. */
  readonly pendingAction = signal<{
    user: AdminUserDto;
    kind: 'deactivate' | 'activate' | 'reset';
  } | null>(null);
  readonly actionTitle = computed(() => {
    const p = this.pendingAction();
    if (!p) return '';
    const who = `@${p.user.username}`;
    return p.kind === 'reset'
      ? `Reset the password for ${who}?`
      : p.kind === 'deactivate'
        ? `Deactivate ${who}?`
        : `Activate ${who}?`;
  });
  readonly actionMessage = computed(() => {
    switch (this.pendingAction()?.kind) {
      case 'reset':
        return 'Their current password stops working now. A one-time temporary password is shown once here — they must change it at next sign-in.';
      case 'deactivate':
        return 'They can no longer sign in to the console. Their roles and history are kept; Activate restores access.';
      case 'activate':
        return 'They can sign in again with their existing password and roles.';
      default:
        return '';
    }
  });
  readonly actionConfirmLabel = computed(() => {
    switch (this.pendingAction()?.kind) {
      case 'reset':
        return 'Reset password';
      case 'deactivate':
        return 'Deactivate';
      default:
        return 'Activate';
    }
  });

  // Panel state
  readonly editState = signal<EditState | null>(null);
  readonly rolesState = signal<RolesState | null>(null);

  private searchDebounce: ReturnType<typeof setTimeout> | null = null;

  readonly roleUse = computed(() => {
    const by = new Map<string, string[]>();
    for (const u of this.users())
      for (const r of u.roles ?? [])
        by.set(r.name, [...(by.get(r.name) ?? []), u.displayName || u.username]);
    return [...by.entries()].map(([name, users]) => ({ name, users }));
  });
  readonly unusedRoles = computed(() => {
    const used = new Set(this.roleUse().map((r) => r.name));
    return this.roles().filter((r) => !used.has(r.name)).length;
  });
  readonly tiles = computed<StatTile[]>(() => {
    const us = this.users();
    const active = us.filter((u) => u.isActive).length;
    const noRole = us.filter((u) => u.isActive && !(u.roles ?? []).length).length;
    const mustChange = us.filter((u) => u.mustChangePassword).length;
    const latest =
      us
        .map((u) => u.lastLoginAt ?? '')
        .sort()
        .at(-1) || null;
    return [
      {
        label: 'Users',
        value: String(us.length),
        caption: `${active} active · ${us.length - active} deactivated`,
      },
      {
        label: 'Without a role',
        value: String(noRole),
        caption: 'active but can do nothing privileged',
        tone: noRole ? 'warn' : 'good',
      },
      {
        label: 'Super admins',
        value: String(us.filter((u) => u.isSuperAdmin).length),
        caption: 'bypass every permission check',
      },
      {
        label: 'Must change password',
        value: String(mustChange),
        caption: 'temporary password not yet replaced',
        tone: mustChange ? 'warn' : null,
      },
      {
        label: 'Last sign-in',
        value: latest ? ago(latest) : 'Never',
        caption: 'by any admin user',
      },
    ];
  });

  constructor() {
    this.loadRoles();
    this.reload();
  }

  // ── Loaders ──────────────────────────────────────────────────────────────
  loadRoles(): void {
    this.rolesService
      .getRoles()
      .pipe(catchError(() => of([] as RoleDto[])))
      .subscribe((roles) => this.roles.set(roles));
  }

  reload(): void {
    this.loading.set(true);
    this.service.getUsers(this.search()).subscribe({
      next: (users) => {
        this.users.set(users);
        this.loadError.set(null);
        this.loading.set(false);
      },
      error: (err) => {
        this.loadError.set(err?.message ?? 'The engine could not be reached.');
        this.loading.set(false);
      },
    });
  }

  onSearch(value: string): void {
    this.search.set(value);
    if (this.searchDebounce) clearTimeout(this.searchDebounce);
    this.searchDebounce = setTimeout(() => this.reload(), 300);
  }

  // ── New user ─────────────────────────────────────────────────────────────
  toggleNewRole(id: number): void {
    this.newRoleIds.update((set) => {
      const next = new Set(set);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  createUser(): void {
    if (!this.canCreate() || this.createPending()) return;
    this.createPending.set(true);
    this.service
      .createUser({
        username: this.newUsername().trim(),
        email: this.newEmail().trim(),
        displayName: this.newDisplayName().trim(),
        roleIds: Array.from(this.newRoleIds()),
      })
      .subscribe({
        next: (cred) => {
          this.createPending.set(false);
          this.notify.success(`User @${cred.username} created`);
          this.lastCredential.set(cred);
          this.copied.set(false);
          this.newUsername.set('');
          this.newEmail.set('');
          this.newDisplayName.set('');
          this.newRoleIds.set(new Set());
          this.reload();
        },
        error: (err) => {
          this.createPending.set(false);
          this.notify.error(err?.message ?? 'Failed to create user');
        },
      });
  }

  copyPassword(cred: AdminUserCredentialDto): void {
    void navigator.clipboard?.writeText(cred.temporaryPassword).then(
      () => {
        this.copied.set(true);
        this.notify.success('Temporary password copied');
      },
      () => this.notify.error('Could not copy to clipboard'),
    );
  }

  // ── Edit profile ─────────────────────────────────────────────────────────
  openEdit(u: AdminUserDto): void {
    this.editState.set({ id: u.id, email: u.email, displayName: u.displayName });
  }

  saveEdit(): void {
    const ed = this.editState();
    if (!ed) return;
    this.busyId.set(ed.id);
    this.service
      .updateUser(ed.id, { email: ed.email.trim(), displayName: ed.displayName.trim() })
      .subscribe({
        next: (msg) => {
          this.busyId.set(null);
          this.editState.set(null);
          this.notify.success(msg || 'Profile updated');
          this.reload();
        },
        error: (err) => {
          this.busyId.set(null);
          this.notify.error(err?.message ?? 'Failed to update profile');
        },
      });
  }

  // ── Manage roles ─────────────────────────────────────────────────────────
  openRoles(u: AdminUserDto): void {
    this.rolesState.set({
      id: u.id,
      username: u.username,
      selected: new Set(u.roles.map((r) => r.id)),
    });
  }

  toggleRoleAssign(rs: RolesState, id: number): void {
    const next = new Set(rs.selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.rolesState.set({ ...rs, selected: next });
  }

  saveRoles(): void {
    const rs = this.rolesState();
    if (!rs) return;
    this.busyId.set(rs.id);
    this.service.assignRoles(rs.id, Array.from(rs.selected)).subscribe({
      next: (msg) => {
        this.busyId.set(null);
        this.rolesState.set(null);
        this.notify.success(msg || 'Roles updated');
        this.reload();
      },
      error: (err) => {
        this.busyId.set(null);
        this.notify.error(err?.message ?? 'Failed to update roles');
      },
    });
  }

  // ── Active toggle + reset password ───────────────────────────────────────
  askAction(u: AdminUserDto, kind: 'deactivate' | 'activate' | 'reset'): void {
    this.pendingAction.set({ user: u, kind });
  }

  confirmAction(): void {
    const p = this.pendingAction();
    if (!p || this.busyId() === p.user.id) return;
    if (p.kind === 'reset') this.resetPassword(p.user);
    else this.toggleActive(p.user);
  }

  toggleActive(u: AdminUserDto): void {
    this.busyId.set(u.id);
    this.service.setActive(u.id, !u.isActive).subscribe({
      next: (msg) => {
        this.busyId.set(null);
        this.pendingAction.set(null);
        this.notify.success(msg || (u.isActive ? 'User deactivated' : 'User activated'));
        this.reload();
      },
      error: (err) => {
        this.busyId.set(null);
        this.pendingAction.set(null);
        this.notify.error(err?.message ?? 'Failed to change status');
      },
    });
  }

  resetPassword(u: AdminUserDto): void {
    this.busyId.set(u.id);
    this.service.resetPassword(u.id).subscribe({
      next: (cred) => {
        this.busyId.set(null);
        this.pendingAction.set(null);
        this.notify.success(`Password reset for @${cred.username}`);
        this.lastCredential.set(cred);
        this.copied.set(false);
        this.reload();
      },
      error: (err) => {
        this.busyId.set(null);
        this.pendingAction.set(null);
        this.notify.error(err?.message ?? 'Failed to reset password');
      },
    });
  }
}
