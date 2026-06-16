import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';

import { AuthService } from '@core/auth/auth.service';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';

type PermGroup = { category: string; keys: string[] };

@Component({
  selector: 'app-profile-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, PageHeaderComponent, EmptyStateComponent],
  template: `
    <div class="page">
      <app-page-header
        title="My Profile"
        subtitle="Your account details, granted roles, and effective permissions."
      >
        <a class="btn btn-primary" routerLink="/account/change-password">Change password</a>
      </app-page-header>

      @if (user(); as u) {
        <section class="card">
          <header class="card-head"><h3>Account</h3></header>
          <dl class="detail-grid">
            <div class="detail">
              <dt>Name</dt>
              <dd>{{ u.firstName || '—' }}</dd>
            </div>
            <div class="detail">
              <dt>Email</dt>
              <dd>{{ u.email || '—' }}</dd>
            </div>
            <div class="detail">
              <dt>Super admin</dt>
              <dd>{{ isSuperAdmin() ? 'Yes' : 'No' }}</dd>
            </div>
          </dl>
        </section>
      }

      <section class="card">
        <header class="card-head">
          <h3>Roles</h3>
          <span class="muted">{{ roles().length }}</span>
        </header>
        <div class="chips pad">
          @for (role of roles(); track role) {
            <span class="chip">{{ role }}</span>
          }
          @if (roles().length === 0) {
            <span class="muted small">No roles assigned.</span>
          }
        </div>
      </section>

      <section class="card">
        <header class="card-head">
          <h3>Permissions</h3>
          <span class="muted">{{ permissions().length }}</span>
        </header>
        @if (permissions().length === 0) {
          <app-empty-state
            title="No explicit permissions"
            description="This account relies on role-based access or is a non-admin session."
          />
        } @else {
          <div class="perm-groups pad">
            @for (g of permissionGroups(); track g.category) {
              <div class="perm-group">
                <span class="perm-cat">{{ g.category }}</span>
                <div class="chips">
                  @for (key of g.keys; track key) {
                    <span class="chip perm">{{ key }}</span>
                  }
                </div>
              </div>
            }
          </div>
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
      .detail-grid {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: var(--space-3);
        padding: var(--space-3) var(--space-4);
        margin: 0;
      }
      @media (max-width: 720px) {
        .detail-grid {
          grid-template-columns: 1fr;
        }
      }
      .detail dt {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        font-weight: var(--font-medium);
        margin-bottom: 2px;
      }
      .detail dd {
        margin: 0;
        font-size: var(--text-sm);
        color: var(--text-primary);
      }
      .chips {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-2);
      }
      .chip {
        display: inline-flex;
        align-items: center;
        padding: 2px 10px;
        border-radius: var(--radius-full);
        font-size: 11px;
        font-weight: var(--font-semibold);
        background: rgba(10, 132, 255, 0.12);
        color: #0a84ff;
      }
      .chip.perm {
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        font-family: 'SF Mono', 'Menlo', monospace;
        font-weight: var(--font-medium);
      }
      .perm-groups {
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .perm-group {
        display: flex;
        flex-direction: column;
        gap: var(--space-1);
      }
      .perm-cat {
        font-size: 10.5px;
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-secondary);
      }
      .btn {
        padding: 8px 16px;
        border-radius: var(--radius-full);
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        border: 1px solid transparent;
        cursor: pointer;
        text-decoration: none;
      }
      .btn-primary {
        background: var(--accent);
        color: #fff;
      }
    `,
  ],
})
export class ProfilePageComponent {
  private readonly auth = inject(AuthService);

  readonly user = this.auth.user;
  readonly roles = this.auth.roles;
  readonly permissions = this.auth.permissions;
  readonly isSuperAdmin = this.auth.isSuperAdmin;

  readonly permissionGroups = computed<PermGroup[]>(() => {
    const byCat = new Map<string, string[]>();
    for (const key of this.permissions()) {
      // Permission keys are typically `category.action` — group by prefix.
      const dot = key.indexOf('.');
      const category = dot > 0 ? key.slice(0, dot) : 'general';
      const list = byCat.get(category) ?? [];
      list.push(key);
      byCat.set(category, list);
    }
    return Array.from(byCat.entries())
      .map(([category, keys]) => ({ category, keys: keys.sort((a, b) => a.localeCompare(b)) }))
      .sort((a, b) => a.category.localeCompare(b.category));
  });
}
