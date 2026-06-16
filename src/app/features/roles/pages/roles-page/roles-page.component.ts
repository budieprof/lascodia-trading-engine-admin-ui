import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { catchError, of } from 'rxjs';

import { RolesService, RoleDto } from '@core/services/roles.service';
import { PermissionsService, PermissionDto } from '@core/services/permissions.service';
import { NotificationService } from '@core/notifications/notification.service';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';

type PermissionGroup = { category: string; permissions: PermissionDto[] };

@Component({
  selector: 'app-roles-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, PageHeaderComponent, EmptyStateComponent],
  template: `
    <div class="page">
      <app-page-header
        title="Roles & Permissions"
        subtitle="Define roles and the permission keys they grant. System roles are code-managed — their permissions can't be edited here."
      />

      <div class="layout">
        <!-- Left: role list + new-role form -->
        <div class="col">
          <section class="card">
            <header class="card-head">
              <h3>Roles</h3>
              <span class="muted">{{ roles().length }} total</span>
              <button
                type="button"
                class="btn btn-ghost btn-xs reload"
                (click)="reload()"
                [disabled]="loading()"
              >
                {{ loading() ? 'Loading…' : 'Refresh' }}
              </button>
            </header>

            @if (loading() && roles().length === 0) {
              <p class="muted small pad">Loading…</p>
            } @else if (roles().length === 0) {
              <app-empty-state title="No roles" description="Create a role using the form below." />
            } @else {
              <ul class="role-list">
                @for (r of roles(); track r.id) {
                  <li class="role-row" [class.selected]="selectedId() === r.id" (click)="select(r)">
                    <div class="role-main">
                      <span class="role-name">{{ r.name }}</span>
                      @if (r.isSystem) {
                        <span class="chip system">system</span>
                      }
                    </div>
                    <p class="role-desc muted small">{{ r.description || 'No description' }}</p>
                    <div class="role-meta muted small">
                      {{ r.permissionKeys.length }} permissions · {{ r.userCount }} users
                    </div>
                  </li>
                }
              </ul>
            }
          </section>

          <section class="card">
            <header class="card-head">
              <h3>New role</h3>
            </header>
            <form class="form" (ngSubmit)="createRole()">
              <label class="field">
                <span class="label">Name</span>
                <input
                  class="input"
                  [(ngModel)]="newName"
                  name="newName"
                  placeholder="e.g. analyst-readonly"
                  required
                />
              </label>
              <label class="field">
                <span class="label">Description</span>
                <input
                  class="input"
                  [(ngModel)]="newDescription"
                  name="newDescription"
                  placeholder="What this role is for"
                />
              </label>
              <fieldset class="matrix">
                <legend class="label">Permissions</legend>
                @for (g of permissionGroups(); track g.category) {
                  <div class="matrix-group">
                    <span class="matrix-cat">{{ g.category }}</span>
                    <div class="matrix-checks">
                      @for (p of g.permissions; track p.key) {
                        <label class="check" [title]="p.description">
                          <input
                            type="checkbox"
                            [checked]="newPermissions().has(p.key)"
                            (change)="toggleNewPermission(p.key)"
                          />
                          <span>{{ p.key }}</span>
                        </label>
                      }
                    </div>
                  </div>
                }
              </fieldset>
              <div class="form-actions">
                <button
                  type="submit"
                  class="btn btn-primary"
                  [disabled]="createPending() || !newName.trim()"
                >
                  {{ createPending() ? 'Creating…' : 'Create role' }}
                </button>
              </div>
            </form>
          </section>
        </div>

        <!-- Right: role editor -->
        <section class="card editor">
          @if (selectedRole(); as role) {
            <header class="card-head">
              <h3>Edit · {{ role.name }}</h3>
              @if (role.isSystem) {
                <span class="chip system">system</span>
              }
              <button type="button" class="link-btn close" (click)="clearSelection()">Close</button>
            </header>
            <div class="editor-body">
              <label class="field">
                <span class="label">Description</span>
                <input
                  class="input"
                  [(ngModel)]="editDescription"
                  name="editDescription"
                  placeholder="What this role is for"
                />
              </label>

              @if (role.isSystem) {
                <p class="note">
                  System role — permissions are code-managed. You can edit the description only.
                </p>
              }

              <fieldset class="matrix" [disabled]="role.isSystem">
                <legend class="label">Permissions</legend>
                @for (g of permissionGroups(); track g.category) {
                  <div class="matrix-group">
                    <span class="matrix-cat">{{ g.category }}</span>
                    <div class="matrix-checks">
                      @for (p of g.permissions; track p.key) {
                        <label class="check" [title]="p.description">
                          <input
                            type="checkbox"
                            [disabled]="role.isSystem"
                            [checked]="editPermissions().has(p.key)"
                            (change)="toggleEditPermission(p.key)"
                          />
                          <span>{{ p.key }}</span>
                        </label>
                      }
                    </div>
                  </div>
                }
              </fieldset>

              <div class="editor-actions">
                @if (!role.isSystem) {
                  <button
                    type="button"
                    class="btn btn-danger"
                    [disabled]="savePending()"
                    (click)="deleteRole(role)"
                  >
                    Delete role
                  </button>
                }
                <span class="spacer"></span>
                <button
                  type="button"
                  class="btn btn-primary"
                  [disabled]="savePending()"
                  (click)="saveRole(role)"
                >
                  {{ savePending() ? 'Saving…' : 'Save changes' }}
                </button>
              </div>
            </div>
          } @else {
            <app-empty-state
              title="Select a role"
              description="Pick a role from the list to view and edit its permission matrix."
            />
          }
        </section>
      </div>
    </div>
  `,
  styles: [
    `
      .page {
        padding: var(--space-2) 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .layout {
        display: grid;
        grid-template-columns: 1fr 1.4fr;
        gap: var(--space-3);
        align-items: start;
      }
      @media (max-width: 1024px) {
        .layout {
          grid-template-columns: 1fr;
        }
      }
      .col {
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
        align-items: center;
        gap: var(--space-3);
        padding: var(--space-3) var(--space-4);
        border-bottom: 1px solid var(--border);
      }
      .card-head h3 {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      .card-head .reload,
      .card-head .close {
        margin-left: auto;
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

      /* Role list */
      .role-list {
        list-style: none;
        margin: 0;
        padding: 0;
        max-height: 420px;
        overflow-y: auto;
      }
      .role-row {
        padding: var(--space-2) var(--space-4);
        border-bottom: 1px solid var(--border);
        cursor: pointer;
        transition: background 0.12s ease;
      }
      .role-row:last-child {
        border-bottom: none;
      }
      .role-row:hover {
        background: var(--bg-tertiary);
      }
      .role-row.selected {
        background: var(--bg-tertiary);
        box-shadow: inset 3px 0 0 var(--accent);
      }
      .role-main {
        display: flex;
        align-items: center;
        gap: var(--space-2);
      }
      .role-name {
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
      }
      .role-desc {
        margin: 2px 0;
      }
      .role-meta {
        font-variant-numeric: tabular-nums;
      }

      /* Forms */
      .form,
      .editor-body {
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
        padding: var(--space-3) var(--space-4);
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

      /* Permission matrix */
      .matrix {
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        padding: var(--space-2) var(--space-3);
        margin: 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .matrix:disabled {
        opacity: 0.6;
      }
      .matrix legend {
        padding: 0 var(--space-1);
      }
      .matrix-group {
        display: flex;
        flex-direction: column;
        gap: var(--space-1);
      }
      .matrix-cat {
        font-size: 10.5px;
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-secondary);
      }
      .matrix-checks {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-2) var(--space-4);
      }
      .check {
        display: flex;
        align-items: center;
        gap: var(--space-1);
        font-size: var(--text-xs);
        color: var(--text-primary);
        cursor: pointer;
      }
      .note {
        margin: 0;
        font-size: var(--text-xs);
        color: var(--text-secondary);
        background: var(--bg-tertiary);
        border-radius: var(--radius-sm);
        padding: var(--space-2) var(--space-3);
      }

      .form-actions,
      .editor-actions {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        justify-content: flex-end;
      }
      .editor-actions .spacer {
        flex: 1;
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
      .btn-danger {
        background: transparent;
        color: var(--loss);
        border-color: var(--loss);
      }
      .btn-danger:disabled {
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

      .chip {
        display: inline-flex;
        align-items: center;
        padding: 2px 8px;
        border-radius: var(--radius-full);
        font-size: 10.5px;
        font-weight: var(--font-semibold);
        background: rgba(10, 132, 255, 0.12);
        color: #0a84ff;
      }
      .chip.system {
        background: rgba(175, 82, 222, 0.14);
        color: #af52de;
      }
    `,
  ],
})
export class RolesPageComponent {
  private readonly rolesService = inject(RolesService);
  private readonly permissionsService = inject(PermissionsService);
  private readonly notify = inject(NotificationService);

  readonly roles = signal<RoleDto[]>([]);
  readonly catalog = signal<PermissionDto[]>([]);
  readonly loading = signal(false);
  readonly createPending = signal(false);
  readonly savePending = signal(false);

  readonly selectedId = signal<number | null>(null);
  readonly selectedRole = computed(
    () => this.roles().find((r) => r.id === this.selectedId()) ?? null,
  );

  // New-role form
  newName = '';
  newDescription = '';
  readonly newPermissions = signal<Set<string>>(new Set());

  // Editor state
  editDescription = '';
  readonly editPermissions = signal<Set<string>>(new Set());

  readonly permissionGroups = computed<PermissionGroup[]>(() => {
    const byCat = new Map<string, PermissionDto[]>();
    for (const p of this.catalog()) {
      const list = byCat.get(p.category) ?? [];
      list.push(p);
      byCat.set(p.category, list);
    }
    return Array.from(byCat.entries())
      .map(([category, permissions]) => ({
        category,
        permissions: permissions.sort((a, b) => a.key.localeCompare(b.key)),
      }))
      .sort((a, b) => a.category.localeCompare(b.category));
  });

  constructor() {
    this.loadCatalog();
    this.reload();
  }

  loadCatalog(): void {
    this.permissionsService
      .getCatalog()
      .pipe(catchError(() => of([] as PermissionDto[])))
      .subscribe((cat) => this.catalog.set(cat));
  }

  reload(): void {
    this.loading.set(true);
    this.rolesService
      .getRoles()
      .pipe(catchError(() => of([] as RoleDto[])))
      .subscribe((roles) => {
        this.roles.set(roles);
        this.loading.set(false);
        // Re-sync the open editor with fresh data.
        const sel = this.selectedRole();
        if (sel) this.hydrateEditor(sel);
      });
  }

  // ── Selection / editor ───────────────────────────────────────────────────
  select(role: RoleDto): void {
    this.selectedId.set(role.id);
    this.hydrateEditor(role);
  }

  clearSelection(): void {
    this.selectedId.set(null);
  }

  private hydrateEditor(role: RoleDto): void {
    this.editDescription = role.description ?? '';
    this.editPermissions.set(new Set(role.permissionKeys));
  }

  toggleEditPermission(key: string): void {
    this.editPermissions.update((set) => {
      const next = new Set(set);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  toggleNewPermission(key: string): void {
    this.newPermissions.update((set) => {
      const next = new Set(set);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  // ── Mutations ──────────────────────────────────────────────────────────────
  createRole(): void {
    const name = this.newName.trim();
    if (!name || this.createPending()) return;
    this.createPending.set(true);
    this.rolesService
      .createRole({
        name,
        description: this.newDescription.trim(),
        permissionKeys: Array.from(this.newPermissions()),
      })
      .subscribe({
        next: (role) => {
          this.createPending.set(false);
          this.notify.success(`Role "${role.name}" created`);
          this.newName = '';
          this.newDescription = '';
          this.newPermissions.set(new Set());
          this.reload();
          this.select(role);
        },
        error: (err) => {
          this.createPending.set(false);
          this.notify.error(err?.message ?? 'Failed to create role');
        },
      });
  }

  saveRole(role: RoleDto): void {
    this.savePending.set(true);
    this.rolesService
      .updateRole(role.id, {
        description: this.editDescription.trim(),
        // System roles keep their code-managed permissions; only description is editable.
        permissionKeys: role.isSystem ? role.permissionKeys : Array.from(this.editPermissions()),
      })
      .subscribe({
        next: (msg) => {
          this.savePending.set(false);
          this.notify.success(msg || `Role "${role.name}" updated`);
          this.reload();
        },
        error: (err) => {
          this.savePending.set(false);
          this.notify.error(err?.message ?? 'Failed to update role');
        },
      });
  }

  deleteRole(role: RoleDto): void {
    if (role.isSystem) return;
    this.savePending.set(true);
    this.rolesService.deleteRole(role.id).subscribe({
      next: (msg) => {
        this.savePending.set(false);
        this.notify.success(msg || `Role "${role.name}" deleted`);
        this.clearSelection();
        this.reload();
      },
      error: (err) => {
        this.savePending.set(false);
        this.notify.error(err?.message ?? 'Failed to delete role');
      },
    });
  }
}
