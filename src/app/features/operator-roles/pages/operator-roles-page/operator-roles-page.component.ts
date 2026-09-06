import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import type { EChartsOption } from 'echarts';

import { OperatorRolesService } from '@core/services/operator-roles.service';
import { NotificationService } from '@core/notifications/notification.service';
import type { OperatorRoleDto } from '@core/api/api.types';
import { ROLES } from '@core/auth/auth.service';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';

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

// Operator-facing summary of what each role lets you do. Keep in sync with
// the engine's `Policies.Register` cascade.
const ROLE_DESCRIPTIONS: Record<string, { tier: number; summary: string }> = {
  Viewer: { tier: 1, summary: 'Read-only access to dashboards and historical data.' },
  Trader: { tier: 2, summary: 'Place / cancel orders + read all Viewer surfaces.' },
  Analyst: { tier: 2, summary: 'Run analytics, drift reports, attribution, ML diagnostics.' },
  Operator: {
    tier: 3,
    summary: 'Triage alerts, manage feature flags, ack DLQ — covers Trader + Analyst reads.',
  },
  Admin: { tier: 4, summary: 'Full control · grant/revoke roles · edit engine config.' },
  EA: { tier: 0, summary: 'Auto-assigned to Expert Advisors logging in via the EA endpoint.' },
};

const ROLE_PALETTE: Record<string, string> = {
  Viewer: '#8E8E93',
  Trader: '#5AC8FA',
  Analyst: '#AF52DE',
  Operator: '#0071E3',
  Admin: '#FF3B30',
  EA: '#34C759',
};

type RoleRow = {
  tradingAccountId: number;
  roles: string[];
  assignedAt: string;
  assignedByAccountId: number | null;
  highestTier: number;
};

type RoleFilter = '' | 'Viewer' | 'Trader' | 'Analyst' | 'Operator' | 'Admin' | 'EA';

const DAY_MS = 24 * 60 * 60 * 1000;

@Component({
  selector: 'app-operator-roles-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    PageHeaderComponent,
    MetricCardComponent,
    ChartCardComponent,
    EmptyStateComponent,
    ErrorStateComponent,
    DatePipe,
    RelativeTimePipe,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Operator Roles"
        subtitle="Grant or revoke platform roles for trading accounts. Changes affect future logins — combine with a forced logout for immediate effect."
      />

      <!-- Five tiles: the per-role counts fold into one so labels stay on one line. Tiles read
           "-" when the grant list has never loaded — a failed fetch is not "0 grants". -->
      <div class="kpis">
        <app-metric-card label="Total grants" [value]="tile(grants().length)" format="number" />
        <app-metric-card label="Accounts" [value]="tile(rows().length)" format="number" />
        <app-metric-card
          label="Multi-role accounts"
          [value]="tile(multiRoleCount())"
          format="number"
        />
        <app-metric-card label="Granted (7d)" [value]="tile(recent7dCount())" format="number" />
        <div class="role-tile">
          <span class="role-tile-label">By role</span>
          @if (loaded()) {
            <ul class="role-tile-list">
              @for (r of roleReference(); track r.role) {
                <li>
                  <span class="role-tile-dot" [style.background]="r.color"></span>
                  <span class="role-tile-name">{{ r.role }}</span>
                  <span class="role-tile-count">{{ roleCount(r.role) }}</span>
                </li>
              }
            </ul>
          } @else {
            <span class="role-tile-empty">-</span>
          }
        </div>
      </div>

      <!-- 2-col chart row: role distribution donut + grant timeline -->
      <div class="chart-row">
        <app-chart-card
          title="Role distribution"
          subtitle="Across all current grants"
          [options]="roleDonutOptions()"
          height="200px"
        />
        <app-chart-card
          [title]="'Grants over time (last ' + timelineDays() + ' days)'"
          [subtitle]="
            timelineDays() === 30
              ? 'When operators were given access'
              : 'Nothing in the last 30 days — widened to 90'
          "
          [options]="grantsTimelineOptions()"
          height="200px"
        />
      </div>

      <!-- Role reference: tiered hierarchy + summary -->
      <section class="ref-card">
        <header class="card-head">
          <h3>Role hierarchy reference</h3>
          <span class="muted">Tier 4 = highest privilege · cascade-style policy</span>
        </header>
        <div class="ref-grid">
          @for (r of roleReference(); track r.role) {
            <article class="ref-cell" [class.ref-active]="roleCount(r.role) > 0">
              <header class="ref-cell-head">
                <span class="ref-dot" [style.background]="r.color"></span>
                <span class="ref-name">{{ r.role }}</span>
                <span class="ref-tier">Tier {{ r.tier }}</span>
                <span class="ref-count">{{ roleCount(r.role) }}</span>
              </header>
              <p class="ref-summary">{{ r.summary }}</p>
            </article>
          }
        </div>
      </section>

      <section class="grant-card">
        <header class="card-head">
          <h3>Grant a role</h3>
          <span class="muted">
            Changes affect future logins. Force a logout for immediate effect.
          </span>
        </header>
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

      <!-- Toolbar: search + role filter + refresh -->
      <div class="toolbar">
        <input
          type="search"
          class="input search"
          placeholder="Filter by account ID…"
          [ngModel]="search()"
          (ngModelChange)="search.set($event)"
        />
        <select class="input" [ngModel]="roleFilter()" (ngModelChange)="roleFilter.set($event)">
          <option value="">All roles</option>
          @for (r of allRoles; track r) {
            <option [value]="r">{{ r }} ({{ roleCount(r) }})</option>
          }
        </select>
        @if (search() || roleFilter()) {
          <button type="button" class="link-btn" (click)="resetFilters()">Reset</button>
        }
        <span class="muted">{{ filteredRows().length }} of {{ rows().length }} accounts</span>
        <button type="button" class="btn btn-ghost" (click)="reload()" [disabled]="loading()">
          {{ loading() ? 'Loading…' : 'Refresh' }}
        </button>
      </div>

      <div class="data-row">
        <section class="list-card">
          <header class="card-head">
            <h3>Current grants</h3>
            <span class="muted">
              {{ filteredRows().length }} of {{ rows().length }} accounts ·
              {{ filteredGrantCount() }} grants
            </span>
          </header>

          @if (loading() && !loaded()) {
            <p class="muted small">Loading…</p>
          } @else if (loadError(); as err) {
            <app-error-state
              title="Could not load role grants"
              [message]="err"
              (retry)="reload()"
            />
          } @else if (rows().length === 0) {
            <app-empty-state
              title="No role grants yet"
              description="Use the form above to grant the first role."
            />
          } @else if (filteredRows().length === 0) {
            <app-empty-state
              title="No role grants match"
              description="Adjust the filters or use the form above to grant a role."
            />
          } @else {
            <div class="roles-scroll">
              <table class="roles-table">
                <thead>
                  <tr>
                    <th>Account</th>
                    <th>Roles</th>
                    <th>Tier</th>
                    <th>First assigned</th>
                    <th>Granted by</th>
                    <th class="actions">Revoke</th>
                  </tr>
                </thead>
                <tbody>
                  @for (row of filteredRows(); track row.tradingAccountId) {
                    <tr>
                      <!-- An account id is an identifier, not a quantity: left-aligned like its header. -->
                      <td class="mono">#{{ row.tradingAccountId }}</td>
                      <td>
                        @for (role of row.roles; track role) {
                          <span
                            class="role-pill"
                            [style.background]="rolePillBg(role)"
                            [style.color]="rolePillColor(role)"
                          >
                            {{ role }}
                          </span>
                        }
                      </td>
                      <td>
                        <span class="tier-pill">Tier {{ row.highestTier }}</span>
                      </td>
                      <td class="muted">
                        {{ row.assignedAt | date: 'MMM d, yyyy HH:mm' }}
                      </td>
                      <td class="mono muted">
                        @if (row.assignedByAccountId !== null) {
                          #{{ row.assignedByAccountId }}
                        } @else {
                          system
                        }
                      </td>
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
            </div>
          }
        </section>

        <section class="activity-card">
          <header class="card-head">
            <h3>Recent activity</h3>
            <span class="muted">Last 12 grants, newest first</span>
          </header>
          @if (recentActivity().length === 0) {
            <p class="muted small">No grant activity yet.</p>
          } @else {
            <ul class="activity-list">
              @for (g of recentActivity(); track g.id) {
                <li class="activity-row">
                  <span class="activity-time mono">{{ g.assignedAt | relativeTime }}</span>
                  <span
                    class="role-pill"
                    [style.background]="rolePillBg(g.role)"
                    [style.color]="rolePillColor(g.role)"
                  >
                    {{ g.role }}
                  </span>
                  <span class="activity-target mono">→ #{{ g.tradingAccountId }}</span>
                  <span class="muted small">
                    by
                    @if (g.assignedByAccountId !== null) {
                      <span class="mono">#{{ g.assignedByAccountId }}</span>
                    } @else {
                      system
                    }
                  </span>
                </li>
              }
            </ul>
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

      /* Five-tile KPI strip; the By-role tile takes a double column so six rows fit. */
      .kpis {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr)) minmax(0, 1.4fr);
        gap: var(--space-3);
        align-items: start;
      }
      @media (max-width: 1200px) {
        .kpis {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
        .role-tile {
          grid-column: 1 / -1;
        }
      }
      @media (max-width: 600px) {
        .kpis {
          grid-template-columns: 1fr;
        }
      }
      .role-tile {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--card-padding);
        box-shadow: var(--shadow-sm);
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
      }
      .role-tile-label {
        font-size: var(--text-sm);
        color: var(--text-secondary);
        font-weight: var(--font-medium);
        line-height: 1.3;
      }
      .role-tile-list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 2px var(--space-3);
      }
      .role-tile-list li {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: var(--text-xs);
      }
      .role-tile-dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        flex-shrink: 0;
      }
      .role-tile-name {
        color: var(--text-secondary);
        flex: 1;
      }
      .role-tile-count {
        font-weight: var(--font-semibold);
        font-variant-numeric: tabular-nums;
      }
      .role-tile-empty {
        font-size: var(--text-2xl);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
      }

      /* 2-col chart row */
      .chart-row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--space-3);
      }
      @media (max-width: 1024px) {
        .chart-row {
          grid-template-columns: 1fr;
        }
      }

      /* Role hierarchy reference */
      .ref-card,
      .grant-card,
      .list-card,
      .activity-card {
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
      .ref-grid {
        display: grid;
        grid-template-columns: repeat(6, 1fr);
        gap: var(--space-2);
        padding: var(--space-3) var(--space-4);
      }
      @media (max-width: 1100px) {
        .ref-grid {
          grid-template-columns: repeat(3, 1fr);
        }
      }
      @media (max-width: 720px) {
        .ref-grid {
          grid-template-columns: 1fr 1fr;
        }
      }
      .ref-cell {
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding: var(--space-2) var(--space-3);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        opacity: 0.6;
        transition: opacity 0.12s ease;
      }
      /* Presence is carried by the count badge alone — an accent border read as "selected". */
      .ref-cell.ref-active {
        opacity: 1;
      }
      .ref-cell-head {
        display: flex;
        align-items: center;
        gap: var(--space-2);
      }
      .ref-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        flex-shrink: 0;
      }
      .ref-name {
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
      }
      .ref-tier {
        font-size: 10px;
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .ref-count {
        margin-left: auto;
        font-size: 10px;
        font-weight: var(--font-semibold);
        font-variant-numeric: tabular-nums;
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        padding: 1px 6px;
        border-radius: var(--radius-full);
      }
      .ref-summary {
        margin: 0;
        font-size: 11px;
        color: var(--text-secondary);
        line-height: 1.4;
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
      .input {
        height: 32px;
        padding: 0 var(--space-2);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-xs);
        outline: none;
      }
      .input:focus {
        border-color: var(--accent);
      }
      .input.search {
        flex: 1 1 240px;
        min-width: 200px;
      }
      .link-btn {
        background: transparent;
        border: none;
        padding: 0 var(--space-2);
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
        color: var(--accent);
        cursor: pointer;
      }
      .link-btn:hover {
        text-decoration: underline;
      }

      /* Two-col data row: grants table + activity feed */
      .data-row {
        display: grid;
        grid-template-columns: 1.6fr 1fr;
        gap: var(--space-3);
      }
      @media (max-width: 1100px) {
        .data-row {
          grid-template-columns: 1fr;
        }
      }

      .grant-form {
        display: flex;
        gap: var(--space-3);
        align-items: flex-end;
        flex-wrap: wrap;
        padding: var(--space-3) var(--space-4);
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
      /* Bounded scroll container so a long roster can't push the activity
         feed off-screen — sticky header keeps column titles visible. */
      .roles-scroll {
        max-height: 540px;
        overflow-y: auto;
      }
      .roles-table {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-xs);
      }
      .roles-table th,
      .roles-table td {
        padding: 8px var(--space-3);
        border-bottom: 1px solid var(--border);
        text-align: left;
        vertical-align: middle;
      }
      .roles-table tbody tr:last-child td {
        border-bottom: none;
      }
      .roles-table th {
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
      .roles-table th.num,
      .roles-table td.num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .roles-table td.mono {
        font-family: 'SF Mono', 'Menlo', monospace;
      }
      /* Tier is a rank, not an alarm: same grey pill the reference cards use. */
      .tier-pill {
        display: inline-flex;
        align-items: center;
        padding: 1px 8px;
        border-radius: var(--radius-full);
        font-size: 10px;
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
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
        padding: 2px 8px;
        border-radius: var(--radius-full);
        font-size: 10.5px;
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

      /* Recent activity feed */
      .activity-list {
        list-style: none;
        margin: 0;
        padding: 0;
        max-height: 540px;
        overflow-y: auto;
      }
      .activity-row {
        display: grid;
        grid-template-columns: 80px auto 1fr auto;
        align-items: center;
        gap: var(--space-2);
        padding: var(--space-2) var(--space-4);
        border-bottom: 1px solid var(--border);
        font-size: var(--text-xs);
      }
      .activity-row:last-child {
        border-bottom: none;
      }
      .activity-time {
        color: var(--text-tertiary);
        font-size: 10.5px;
        white-space: nowrap;
      }
      .activity-target {
        color: var(--text-primary);
      }
      .mono {
        font-family: 'SF Mono', 'Menlo', monospace;
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
  /** True once the grant list has come back at least once — tiles read "-" before that. */
  readonly loaded = signal(false);
  readonly loadError = signal<string | null>(null);
  readonly grantPending = signal(false);
  readonly revokePending = signal(false);

  /** Null (rendered "-") until the first successful load, so a failure never reads as 0. */
  tile(n: number): number | null {
    return this.loaded() ? n : null;
  }

  /** Groups grants by account so the table renders one row per account. */
  readonly rows = computed<RoleRow[]>(() => {
    const byAccount = new Map<number, RoleRow>();
    for (const g of this.grants()) {
      const tier = ROLE_DESCRIPTIONS[g.role]?.tier ?? 0;
      const existing = byAccount.get(g.tradingAccountId);
      if (existing) {
        existing.roles.push(g.role);
        if (g.assignedAt < existing.assignedAt) existing.assignedAt = g.assignedAt;
        if (tier > existing.highestTier) existing.highestTier = tier;
        if (existing.assignedByAccountId === null && g.assignedByAccountId !== null) {
          existing.assignedByAccountId = g.assignedByAccountId;
        }
      } else {
        byAccount.set(g.tradingAccountId, {
          tradingAccountId: g.tradingAccountId,
          roles: [g.role],
          assignedAt: g.assignedAt,
          assignedByAccountId: g.assignedByAccountId,
          highestTier: tier,
        });
      }
    }
    return Array.from(byAccount.values()).sort(
      // Higher-privilege accounts first — Admin/Operator typically what the
      // operator looking at this page needs to audit.
      (a, b) => b.highestTier - a.highestTier || a.tradingAccountId - b.tradingAccountId,
    );
  });

  // ── Filter state ────────────────────────────────────────────────────────
  readonly search = signal('');
  readonly roleFilter = signal<RoleFilter>('');

  readonly allRoles = ['Viewer', 'Trader', 'Analyst', 'Operator', 'Admin', 'EA'] as const;

  readonly filteredRows = computed<RoleRow[]>(() => {
    const q = this.search().trim();
    const role = this.roleFilter();
    return this.rows().filter((r) => {
      if (q && !String(r.tradingAccountId).includes(q)) return false;
      if (role && !r.roles.includes(role)) return false;
      return true;
    });
  });

  readonly filteredGrantCount = computed(() =>
    this.filteredRows().reduce((s, r) => s + r.roles.length, 0),
  );

  resetFilters(): void {
    this.search.set('');
    this.roleFilter.set('');
  }

  // ── KPIs ────────────────────────────────────────────────────────────────
  // Typed return so the template can use dot-access (Angular strict mode
  // rejects `roleCounts().Admin` on a `Record<string, number>`).
  readonly roleCounts = computed<{
    Viewer: number;
    Trader: number;
    Analyst: number;
    Operator: number;
    Admin: number;
    EA: number;
  }>(() => {
    const counts = { Viewer: 0, Trader: 0, Analyst: 0, Operator: 0, Admin: 0, EA: 0 };
    for (const g of this.grants()) {
      if (g.role === 'Viewer') counts.Viewer++;
      else if (g.role === 'Trader') counts.Trader++;
      else if (g.role === 'Analyst') counts.Analyst++;
      else if (g.role === 'Operator') counts.Operator++;
      else if (g.role === 'Admin') counts.Admin++;
      else if (g.role === 'EA') counts.EA++;
    }
    return counts;
  });

  readonly multiRoleCount = computed(() => this.rows().filter((r) => r.roles.length > 1).length);

  // String-keyed helper for the template — Angular strict mode rejects
  // dynamic indexing on a typed shape, so keep this as a method instead of
  // an inline `(roleCounts())[role]` expression.
  roleCount(role: string): number {
    const counts = this.roleCounts();
    return (counts as Record<string, number>)[role] ?? 0;
  }

  readonly recent7dCount = computed(() => {
    const cutoff = Date.now() - 7 * DAY_MS;
    return this.grants().filter((g) => new Date(g.assignedAt).getTime() > cutoff).length;
  });

  // Last 12 grants newest-first — feeds the activity panel.
  readonly recentActivity = computed(() =>
    [...this.grants()]
      .sort((a, b) => new Date(b.assignedAt).getTime() - new Date(a.assignedAt).getTime())
      .slice(0, 12),
  );

  // ── Role hierarchy reference (template iteration) ───────────────────────
  readonly roleReference = computed(() =>
    Object.entries(ROLE_DESCRIPTIONS)
      .map(([role, def]) => ({
        role,
        tier: def.tier,
        summary: def.summary,
        color: ROLE_PALETTE[role] ?? '#8E8E93',
      }))
      .sort((a, b) => b.tier - a.tier),
  );

  // ── Charts ──────────────────────────────────────────────────────────────
  readonly roleDonutOptions = computed<EChartsOption>(() => {
    const counts = this.roleCounts();
    const data = Object.entries(counts)
      .filter(([, v]) => v > 0)
      .map(([name, value]) => ({
        name,
        value,
        itemStyle: { color: ROLE_PALETTE[name] ?? '#8E8E93' },
      }));
    if (data.length === 0) return {};
    return {
      tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
      legend: { bottom: 0, textStyle: { fontSize: 10, color: '#6E6E73' } },
      series: [
        {
          type: 'pie',
          radius: ['45%', '70%'],
          center: ['50%', '45%'],
          label: { show: false },
          data,
        },
      ],
    };
  });

  /**
   * 30 days, widening to 90 when the last month is empty — an empty chart card teaches nothing,
   * while the 90-day view still shows the most recent access changes.
   */
  readonly timelineDays = computed<30 | 90>(() => {
    const now = Date.now();
    const within = (days: number) =>
      this.grants().some((g) => now - new Date(g.assignedAt).getTime() < days * DAY_MS);
    return within(30) || !within(90) ? 30 : 90;
  });

  // Daily grant counts over the timeline window, stacked by role.
  readonly grantsTimelineOptions = computed<EChartsOption>(() => {
    const days = this.timelineDays();
    const startDay = (() => {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      return d.getTime() - (days - 1) * DAY_MS;
    })();
    const labels: string[] = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(startDay + i * DAY_MS);
      labels.push(`${d.getMonth() + 1}/${d.getDate()}`);
    }
    const buckets: Record<string, number[]> = {};
    for (const role of this.allRoles) buckets[role] = new Array(days).fill(0);
    for (const g of this.grants()) {
      const t = new Date(g.assignedAt).getTime();
      const idx = Math.floor((t - startDay) / DAY_MS);
      if (idx < 0 || idx >= days) continue;
      const role = g.role in buckets ? g.role : 'Viewer';
      buckets[role][idx]++;
    }
    const totalAcrossDays = Object.values(buckets).reduce(
      (s, arr) => s + arr.reduce((a, b) => a + b, 0),
      0,
    );
    if (totalAcrossDays === 0) {
      return {
        title: {
          text: `No grants in the last ${days} days`,
          left: 'center',
          top: 'middle',
          textStyle: { fontSize: 12, color: '#8E8E93', fontWeight: 'normal' },
        },
      };
    }
    return {
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      legend: { bottom: 0, textStyle: { fontSize: 10, color: '#6E6E73' } },
      grid: { top: 10, right: 16, bottom: 36, left: 32 },
      xAxis: {
        type: 'category',
        data: labels,
        axisLabel: { fontSize: 9, color: '#6E6E73', interval: days === 30 ? 3 : 9 },
      },
      yAxis: {
        type: 'value',
        axisLabel: { fontSize: 10, color: '#6E6E73' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
        minInterval: 1,
      },
      series: this.allRoles
        .filter((r) => buckets[r].some((v) => v > 0))
        .map((role) => ({
          name: role,
          type: 'bar' as const,
          stack: 'grants',
          data: buckets[role],
          itemStyle: { color: ROLE_PALETTE[role] ?? '#8E8E93' },
          barWidth: '70%',
        })),
    };
  });

  // ── Pill colours used in the table + activity feed ──────────────────────
  rolePillBg(role: string): string {
    const base = ROLE_PALETTE[role] ?? '#8E8E93';
    return this.hexToRgba(base, 0.14);
  }

  rolePillColor(role: string): string {
    return ROLE_PALETTE[role] ?? '#636366';
  }

  private hexToRgba(hex: string, alpha: number): string {
    const m = hex.replace('#', '').match(/.{1,2}/g);
    if (!m || m.length < 3) return `rgba(142,142,147,${alpha})`;
    const r = parseInt(m[0], 16);
    const g = parseInt(m[1], 16);
    const b = parseInt(m[2], 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  constructor() {
    this.reload();
  }

  /**
   * A failed list call is surfaced, not swallowed into `[]` — an empty roster looks exactly like
   * "nobody has access", which is the one thing an operator must never be told by mistake.
   */
  reload(): void {
    this.loading.set(true);
    this.service.list().subscribe({
      next: (res) => {
        if (res?.status === false) {
          this.loadError.set(res.message ?? 'The engine rejected the request.');
        } else {
          this.grants.set(res?.data ?? []);
          this.loaded.set(true);
          this.loadError.set(null);
        }
        this.loading.set(false);
      },
      error: (err: { status?: number; error?: { message?: string } }) => {
        const detail = err?.error?.message ?? (err?.status ? `HTTP ${err.status}` : null);
        this.loadError.set(detail ? `${detail}.` : 'The engine could not be reached.');
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
