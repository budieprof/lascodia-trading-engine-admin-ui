import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { catchError, of } from 'rxjs';

import { OperatorRolesService } from '@core/services/operator-roles.service';
import { NotificationService } from '@core/notifications/notification.service';
import type { OperatorRoleDto } from '@core/api/api.types';
import { ROLES } from '@core/auth/auth.service';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';

// Canonical roles the engine will accept, mirroring `OperatorRoleNames`.
// `EA` is omitted because it's auto-assigned by login-source, not manually
// grantable via this UI.
const GRANTABLE_ROLES = [
  ROLES.Viewer,
  ROLES.Trader,
  ROLES.Analyst,
  ROLES.Operator,
  ROLES.Admin,
] as const;

type RoleRow = {
  tradingAccountId: number;
  roles: string[];
  assignedAt: string;
};

@Component({
  selector: 'app-operator-roles-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, PageHeaderComponent, EmptyStateComponent, DatePipe],
  template: `
    <div class="page">
      <app-page-header
        title="Operator Roles"
        subtitle="Grant or revoke platform roles for trading accounts. Changes affect future logins — combine with a forced logout for immediate effect."
      />

      <section class="grant-card">
        <h3>Grant a role</h3>
        <form class="grant-form" (ngSubmit)="grant()">
          <label class="field">
            <span class="label">Trading Account ID</span>
            <input
              type="number"
              min="1"
              [(ngModel)]="grantAccountId"
              name="accountId"
              placeholder="e.g. 42"
              required
            />
          </label>
          <label class="field">
            <span class="label">Role</span>
            <select [(ngModel)]="grantRole" name="role">
              @for (r of grantableRoles; track r) {
                <option [value]="r">{{ r }}</option>
              }
            </select>
          </label>
          <button
            type="submit"
            class="btn btn-primary"
            [disabled]="grantPending() || !grantAccountId"
          >
            {{ grantPending() ? 'Granting…' : 'Grant' }}
          </button>
        </form>
      </section>

      <section class="list-card">
        <header class="list-head">
          <h3>Current grants</h3>
          <button type="button" class="btn btn-ghost" (click)="reload()" [disabled]="loading()">
            {{ loading() ? 'Loading…' : 'Refresh' }}
          </button>
        </header>

        @if (loading() && rows().length === 0) {
          <p class="muted small">Loading…</p>
        } @else if (rows().length === 0) {
          <app-empty-state
            title="No role grants found"
            description="Use the form above to grant a role to a trading account."
          />
        } @else {
          <table class="roles-table">
            <thead>
              <tr>
                <th>Account ID</th>
                <th>Roles</th>
                <th>First assigned</th>
                <th class="actions">Revoke</th>
              </tr>
            </thead>
            <tbody>
              @for (row of rows(); track row.tradingAccountId) {
                <tr>
                  <td class="num">{{ row.tradingAccountId }}</td>
                  <td>
                    @for (role of row.roles; track role) {
                      <span class="role-pill">{{ role }}</span>
                    }
                  </td>
                  <td>{{ row.assignedAt | date: 'MMM d, yyyy HH:mm' }}</td>
                  <td class="actions">
                    @for (role of row.roles; track role) {
                      <button
                        type="button"
                        class="btn btn-ghost btn-xs"
                        [disabled]="revokePending()"
                        (click)="revoke(row.tradingAccountId, role)"
                      >
                        Revoke {{ role }}
                      </button>
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        }
      </section>
    </div>
  `,
  styles: [
    `
      .page {
        padding: var(--space-2) 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-5);
      }
      .grant-card,
      .list-card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-5);
      }
      .grant-card h3,
      .list-card h3 {
        margin: 0 0 var(--space-4);
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .grant-form {
        display: flex;
        gap: var(--space-4);
        align-items: flex-end;
        flex-wrap: wrap;
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: var(--space-1);
        min-width: 180px;
      }
      .label {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        font-weight: var(--font-medium);
      }
      .field input,
      .field select {
        padding: 8px 10px;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-sm);
      }
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
      .btn-xs {
        padding: 4px 10px;
        font-size: var(--text-xs);
      }
      .list-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: var(--space-4);
      }
      .list-head h3 {
        margin: 0;
      }
      .roles-table {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-sm);
      }
      .roles-table th,
      .roles-table td {
        padding: var(--space-3);
        border-bottom: 1px solid var(--border);
        text-align: left;
        vertical-align: top;
      }
      .roles-table th {
        color: var(--text-secondary);
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .roles-table td.num {
        font-variant-numeric: tabular-nums;
      }
      .roles-table .actions {
        text-align: right;
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        justify-content: flex-end;
      }
      .role-pill {
        display: inline-flex;
        align-items: center;
        padding: 2px 10px;
        border-radius: var(--radius-full);
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        background: rgba(10, 132, 255, 0.12);
        color: #0a84ff;
        margin-right: 4px;
      }
      .muted {
        color: var(--text-tertiary);
      }
      .small {
        font-size: var(--text-xs);
      }
    `,
  ],
})
export class OperatorRolesPageComponent {
  private readonly service = inject(OperatorRolesService);
  private readonly notify = inject(NotificationService);

  readonly grantableRoles = GRANTABLE_ROLES;

  grantAccountId: number | null = null;
  grantRole: string = GRANTABLE_ROLES[0];

  readonly grants = signal<OperatorRoleDto[]>([]);
  readonly loading = signal(false);
  readonly grantPending = signal(false);
  readonly revokePending = signal(false);

  /** Groups grants by account so the table renders one row per account. */
  readonly rows = computed<RoleRow[]>(() => {
    const byAccount = new Map<number, RoleRow>();
    for (const g of this.grants()) {
      const existing = byAccount.get(g.tradingAccountId);
      if (existing) {
        existing.roles.push(g.role);
        if (g.assignedAt < existing.assignedAt) existing.assignedAt = g.assignedAt;
      } else {
        byAccount.set(g.tradingAccountId, {
          tradingAccountId: g.tradingAccountId,
          roles: [g.role],
          assignedAt: g.assignedAt,
        });
      }
    }
    return Array.from(byAccount.values()).sort((a, b) => a.tradingAccountId - b.tradingAccountId);
  });

  constructor() {
    this.reload();
  }

  reload(): void {
    this.loading.set(true);
    this.service
      .list()
      .pipe(catchError(() => of({ data: [] as OperatorRoleDto[] } as any)))
      .subscribe({
        next: (res) => {
          this.grants.set(res?.data ?? []);
          this.loading.set(false);
        },
      });
  }

  grant(): void {
    if (!this.grantAccountId || !this.grantRole) return;
    this.grantPending.set(true);
    this.service.grant(this.grantAccountId, this.grantRole).subscribe({
      next: (res) => {
        this.grantPending.set(false);
        if (res?.status) {
          this.notify.success(`Granted ${this.grantRole} to account ${this.grantAccountId}`);
          this.grantAccountId = null;
          this.reload();
        } else {
          this.notify.error(res?.message ?? 'Grant failed');
        }
      },
      error: () => {
        this.grantPending.set(false);
        this.notify.error('Grant failed');
      },
    });
  }

  revoke(tradingAccountId: number, role: string): void {
    this.revokePending.set(true);
    this.service.revoke(tradingAccountId, role).subscribe({
      next: (res) => {
        this.revokePending.set(false);
        if (res?.status) {
          this.notify.success(`Revoked ${role} from account ${tradingAccountId}`);
          this.reload();
        } else {
          this.notify.error(res?.message ?? 'Revoke failed');
        }
      },
      error: () => {
        this.revokePending.set(false);
        this.notify.error('Revoke failed');
      },
    });
  }
}
