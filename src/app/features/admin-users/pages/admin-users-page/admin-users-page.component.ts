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

type EditState = { id: number; email: string; displayName: string };
type RolesState = { id: number; username: string; selected: Set<number> };

@Component({
  selector: 'app-admin-users-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, DatePipe, PageHeaderComponent, EmptyStateComponent],
  template: `
    <div class="page">
      <app-page-header
        title="Admin Users"
        subtitle="Provision admin accounts, assign roles, and manage access. New users and password resets issue a one-time temporary password."
      />

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
          <span class="muted">Username + email + at least one role.</span>
        </header>
        <form class="form-grid" (ngSubmit)="createUser()">
          <label class="field">
            <span class="label">Username</span>
            <input
              class="input"
              [(ngModel)]="newUsername"
              name="username"
              placeholder="jdoe"
              required
            />
          </label>
          <label class="field">
            <span class="label">Email</span>
            <input
              class="input"
              type="email"
              [(ngModel)]="newEmail"
              name="email"
              placeholder="jdoe@lascodia.com"
              required
            />
          </label>
          <label class="field">
            <span class="label">Display name</span>
            <input
              class="input"
              [(ngModel)]="newDisplayName"
              name="displayName"
              placeholder="Jane Doe"
              required
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
                    <td class="muted">{{ u.email }}</td>
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
                      <button
                        type="button"
                        class="btn btn-ghost btn-xs"
                        [disabled]="busyId() === u.id"
                        (click)="toggleActive(u)"
                      >
                        {{ u.isActive ? 'Deactivate' : 'Activate' }}
                      </button>
                      <button
                        type="button"
                        class="btn btn-ghost btn-xs"
                        [disabled]="busyId() === u.id"
                        (click)="resetPassword(u)"
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
    </div>

    <!-- Edit profile panel -->
    @if (editState(); as ed) {
      <div class="overlay" (click)="editState.set(null)">
        <div class="panel" (click)="$event.stopPropagation()">
          <header class="panel-head">
            <h3>Edit profile</h3>
            <button type="button" class="link-btn" (click)="editState.set(null)">Close</button>
          </header>
          <form class="panel-body" (ngSubmit)="saveEdit()">
            <label class="field">
              <span class="label">Email</span>
              <input class="input" type="email" [(ngModel)]="ed.email" name="editEmail" required />
            </label>
            <label class="field">
              <span class="label">Display name</span>
              <input class="input" [(ngModel)]="ed.displayName" name="editDisplayName" required />
            </label>
            <div class="panel-actions">
              <button type="button" class="btn btn-ghost" (click)="editState.set(null)">
                Cancel
              </button>
              <button type="submit" class="btn btn-primary" [disabled]="busyId() === ed.id">
                Save
              </button>
            </div>
          </form>
        </div>
      </div>
    }

    <!-- Manage roles panel -->
    @if (rolesState(); as rs) {
      <div class="overlay" (click)="rolesState.set(null)">
        <div class="panel" (click)="$event.stopPropagation()">
          <header class="panel-head">
            <h3>Manage roles · &#64;{{ rs.username }}</h3>
            <button type="button" class="link-btn" (click)="rolesState.set(null)">Close</button>
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
            <div class="panel-actions">
              <button type="button" class="btn btn-ghost" (click)="rolesState.set(null)">
                Cancel
              </button>
              <button
                type="button"
                class="btn btn-primary"
                [disabled]="busyId() === rs.id"
                (click)="saveRoles()"
              >
                Save roles
              </button>
            </div>
          </div>
        </div>
      </div>
    }
  `,
  styles: [
    `
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
        justify-content: flex-end;
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
      .panel {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        width: 100%;
        max-width: 480px;
        max-height: 80vh;
        overflow-y: auto;
      }
      .panel-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--space-3) var(--space-4);
        border-bottom: 1px solid var(--border);
      }
      .panel-head h3 {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      .panel-body {
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
        padding: var(--space-4);
      }
      .panel-actions {
        display: flex;
        justify-content: flex-end;
        gap: var(--space-2);
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
  readonly createPending = signal(false);
  readonly busyId = signal<number | null>(null);
  readonly search = signal('');

  readonly lastCredential = signal<AdminUserCredentialDto | null>(null);
  readonly copied = signal(false);

  // New-user form fields
  newUsername = '';
  newEmail = '';
  newDisplayName = '';
  readonly newRoleIds = signal<Set<number>>(new Set());

  readonly canCreate = computed(
    () =>
      this.newUsername.trim().length > 0 &&
      this.newEmail.trim().length > 0 &&
      this.newDisplayName.trim().length > 0,
  );

  // Panel state
  readonly editState = signal<EditState | null>(null);
  readonly rolesState = signal<RolesState | null>(null);

  private searchDebounce: ReturnType<typeof setTimeout> | null = null;

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
    this.service
      .getUsers(this.search())
      .pipe(catchError(() => of([] as AdminUserDto[])))
      .subscribe((users) => {
        this.users.set(users);
        this.loading.set(false);
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
        username: this.newUsername.trim(),
        email: this.newEmail.trim(),
        displayName: this.newDisplayName.trim(),
        roleIds: Array.from(this.newRoleIds()),
      })
      .subscribe({
        next: (cred) => {
          this.createPending.set(false);
          this.notify.success(`User @${cred.username} created`);
          this.lastCredential.set(cred);
          this.copied.set(false);
          this.newUsername = '';
          this.newEmail = '';
          this.newDisplayName = '';
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
  toggleActive(u: AdminUserDto): void {
    this.busyId.set(u.id);
    this.service.setActive(u.id, !u.isActive).subscribe({
      next: (msg) => {
        this.busyId.set(null);
        this.notify.success(msg || (u.isActive ? 'User deactivated' : 'User activated'));
        this.reload();
      },
      error: (err) => {
        this.busyId.set(null);
        this.notify.error(err?.message ?? 'Failed to change status');
      },
    });
  }

  resetPassword(u: AdminUserDto): void {
    this.busyId.set(u.id);
    this.service.resetPassword(u.id).subscribe({
      next: (cred) => {
        this.busyId.set(null);
        this.notify.success(`Password reset for @${cred.username}`);
        this.lastCredential.set(cred);
        this.copied.set(false);
        this.reload();
      },
      error: (err) => {
        this.busyId.set(null);
        this.notify.error(err?.message ?? 'Failed to reset password');
      },
    });
  }
}
