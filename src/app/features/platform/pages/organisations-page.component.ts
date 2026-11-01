import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { catchError, of } from 'rxjs';

import { ago, countBy, plural } from '@features/iam/shared/admin-context.logic';
import { AuditTrailComponent } from '@features/iam/shared/audit-trail.component';
import { StatTilesComponent, type StatTile } from '@features/iam/shared/stat-tiles.component';
import { OnboardingApiService } from '@features/onboarding/onboarding-api.service';
import type { SignupStatus } from '@features/onboarding/onboarding.types';

import { AuthService } from '@core/auth/auth.service';
import { Permission } from '@core/auth/permissions.generated';
import { NotificationService } from '@core/notifications/notification.service';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { IamApiService } from '@features/iam/iam-api.service';
import { errorText, memberLabel, reportable, when } from '@features/iam/iam.logic';
import type {
  CreateInvitationResult,
  CreateTenantBody,
  IamMember,
  TenantDto,
} from '@features/iam/iam.types';
import { iamResource } from '@features/iam/shared/iam-resource';
import { SecretOnceComponent } from '@features/iam/shared/secret-once.component';
import { tenantErrors, tenantStatusAction } from '../platform.logic';
import { TenantPlanPanelComponent } from '../components/tenant-plan-panel.component';
import { UsageExportComponent } from '../components/usage-export.component';
import { PlansApiService } from '../plans-api.service';
import type { PlanDto } from '../plans.types';

/**
 * Organisations (U3.6; t2-core `platform/tenants`, `platform.tenants.manage`): list, create a
 * Customer or Canary organisation, suspend (its members are refused; its EAs keep connecting so open
 * positions stay managed — suspension is not a kill switch) and reactivate. House is never
 * suspended. Every change is audited by the engine.
 */
@Component({
  selector: 'app-platform-organisations-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    SecretOnceComponent,
    PageHeaderComponent,
    ConfirmDialogComponent,
    TenantPlanPanelComponent,
    UsageExportComponent,
    RouterLink,
    StatTilesComponent,
    AuditTrailComponent,
  ],
  styleUrls: ['../../iam/shared/iam-page.scss', './org-plans-page.scss'],
  template: `
    <div class="page">
      <app-page-header
        title="Organisations"
        subtitle="Every organisation on the platform — its status, plan, people and first Owner."
      >
        <button type="button" class="btn btn-primary" (click)="creating.set(!creating())">
          New organisation
        </button>
      </app-page-header>

      <app-stat-tiles [tiles]="tiles()" label="Organisations summary" />

      @if (creating()) {
        <section class="card">
          <header class="card-head"><h3>New organisation</h3></header>
          <form class="card-body" (ngSubmit)="create()">
            <div class="form-grid">
              <label class="field">
                <span class="label">Slug (permanent)</span>
                <input
                  class="input"
                  name="slug"
                  [ngModel]="draft().slug"
                  (ngModelChange)="patch({ slug: $event })"
                  placeholder="acme-capital"
                />
              </label>
              <label class="field">
                <span class="label">Name</span>
                <input
                  class="input"
                  name="name"
                  [ngModel]="draft().name"
                  (ngModelChange)="patch({ name: $event })"
                />
              </label>
              <label class="field">
                <span class="label">Kind</span>
                <select
                  class="select"
                  name="kind"
                  [ngModel]="draft().kind"
                  (ngModelChange)="patch({ kind: $event })"
                >
                  <option value="Customer">Customer</option>
                  <option value="Canary">Canary (isolation probe, demo accounts only)</option>
                </select>
              </label>
              @if (canManagePlans) {
                <label class="field">
                  <span class="label">Plan</span>
                  <select
                    class="select"
                    name="plan"
                    [ngModel]="draft().planId ?? null"
                    (ngModelChange)="patch({ planId: $event })"
                  >
                    <option [ngValue]="null">The default plan</option>
                    @for (p of assignablePlans(); track p.id) {
                      <option [ngValue]="p.id">{{ p.name }}</option>
                    }
                  </select>
                </label>
              }
            </div>
            <label class="check">
              <input
                type="checkbox"
                name="learning"
                [ngModel]="draft().contributesToPlatformLearning"
                (ngModelChange)="patch({ contributesToPlatformLearning: $event })"
              />
              Its trading may feed platform-wide research and models
            </label>
            @if (submitted() && errors().length) {
              <ul class="errors" role="alert">
                @for (e of errors(); track e) {
                  <li>{{ e }}</li>
                }
              </ul>
            }
            <div class="actions-row">
              <button type="button" class="btn btn-secondary" (click)="creating.set(false)">
                Cancel
              </button>
              <button type="submit" class="btn btn-primary" [disabled]="busy()">
                {{ busy() ? 'Creating…' : 'Create' }}
              </button>
            </div>
          </form>
        </section>
      }

      <section class="card">
        <div class="toolbar">
          <div class="search-box">
            <input
              class="input"
              type="search"
              placeholder="Search slug or name — Enter"
              aria-label="Search organisations"
              [ngModel]="search()"
              (ngModelChange)="search.set($event)"
              (keyup.enter)="tenants.reload()"
            />
          </div>
          <button
            type="button"
            class="btn btn-sm btn-secondary"
            (click)="tenants.reload()"
            [disabled]="tenants.loading()"
          >
            {{ tenants.loading() ? 'Loading…' : 'Search' }}
          </button>
          <div class="seg" role="group" aria-label="Show organisations by status">
            @for (f of statusFilters; track f.key) {
              <button
                type="button"
                [class.on]="statusFilter() === f.key"
                [attr.aria-pressed]="statusFilter() === f.key"
                (click)="statusFilter.set(f.key)"
              >
                {{ f.label }}<span class="n">{{ statusCount(f.key) }}</span>
              </button>
            }
          </div>
          <span class="grow"></span>
          @if (canReadUsage) {
            <app-usage-export />
          }
        </div>
        @if (tenants.error(); as err) {
          <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
        } @else if (tenants.loaded() && tenants.value().length === 0) {
          <p class="empty">
            <strong>No organisations match.</strong>
            {{
              search().trim()
                ? 'Nothing has a slug or name like "' +
                  search().trim() +
                  '". Clear the search to see them all.'
                : 'Organisations appear here once staff create one or a sign-up is approved.'
            }}
          </p>
        } @else if (tenants.value().length > 0 && shown().length === 0) {
          <p class="empty">
            <strong>No {{ statusFilter().toLowerCase() }} organisations.</strong>
            Pick <em>All</em> to see the other {{ tenants.value().length }}.
          </p>
        } @else if (tenants.value().length > 0) {
          <div class="table-wrap">
            <table class="grid">
              <thead>
                <tr>
                  <th>Organisation</th>
                  <th>Kind</th>
                  <th>Status</th>
                  <th>Plan</th>
                  <th class="num">Members</th>
                  <th>Created</th>
                  <th><span class="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                @for (t of shown(); track t.id) {
                  @let action = statusAction(t);
                  <tr [class.selected]="openMembersFor() === t.id">
                    <td>
                      <span class="name">{{ t.name }}</span>
                      <span class="sub"
                        ><span class="ident">{{ t.slug }}</span> · #{{ t.id }}</span
                      >
                    </td>
                    <td>
                      <span class="chip" [class.info]="t.kind === 'House'">{{ t.kind }}</span>
                    </td>
                    <td>
                      <span
                        class="dot"
                        [class.ok]="t.status === 'Active'"
                        [class.warn]="t.status === 'Suspended'"
                        [class.bad]="t.status !== 'Active' && t.status !== 'Suspended'"
                        >{{ t.status }}</span
                      >
                      @if (t.statusReason) {
                        <span class="sub">{{ t.statusReason }}</span>
                      }
                    </td>
                    <td class="small">
                      {{ t.planName ?? 'Default plan' }}
                      @if (!t.planName) {
                        <span class="sub dim">not assigned</span>
                      }
                    </td>
                    <td class="num">{{ t.activeMembers ?? '—' }}</td>
                    <td class="small nowrap" [attr.title]="when(t.createdAtUtc)">
                      {{ ago(t.createdAtUtc) }}
                      <span class="when-sub">{{ when(t.createdAtUtc) }}</span>
                    </td>
                    <td class="actions">
                      <button
                        type="button"
                        class="btn btn-sm btn-ghost"
                        [class.on]="openMembersFor() === t.id"
                        [attr.aria-expanded]="openMembersFor() === t.id"
                        (click)="toggleMembers(t)"
                      >
                        Members
                      </button>
                      @if (canReadUsage || canManagePlans) {
                        <button
                          type="button"
                          class="btn btn-sm btn-ghost"
                          [class.on]="openPlanFor() === t.id"
                          [attr.aria-expanded]="openPlanFor() === t.id"
                          (click)="togglePlan(t)"
                        >
                          Plan &amp; usage
                        </button>
                      }
                      @if (canInviteOwner(t)) {
                        <button
                          type="button"
                          class="btn btn-sm btn-ghost"
                          [class.on]="ownerInviteFor()?.id === t.id"
                          (click)="startOwnerInvite(t)"
                        >
                          Invite first Owner
                        </button>
                      }
                      @if (action === 'suspend') {
                        <button
                          type="button"
                          class="btn btn-sm btn-ghost-danger"
                          (click)="openStatus(t, 'suspend')"
                        >
                          Suspend
                        </button>
                      } @else if (action === 'reactivate') {
                        <button
                          type="button"
                          class="btn btn-sm btn-secondary"
                          (click)="openStatus(t, 'reactivate')"
                        >
                          Reactivate
                        </button>
                      }
                    </td>
                  </tr>
                  @if (openMembersFor() === t.id) {
                    <tr class="selected detail">
                      <td colspan="7">
                        <p class="section-label">Members of {{ t.name }}</p>
                        @if (membersError(); as e) {
                          <span class="chip bad">Could not load</span> {{ e }}
                        } @else if (members().length === 0) {
                          <span class="muted small">No members.</span>
                        } @else {
                          <div class="chips">
                            @for (m of members(); track m.userId) {
                              <span class="chip" [class.ok]="m.status === 'Active'"
                                >{{ label(m) }} — {{ m.status }}</span
                              >
                            }
                          </div>
                        }
                      </td>
                    </tr>
                  }
                  @if (ownerInviteFor()?.id === t.id) {
                    <tr class="selected detail">
                      <td colspan="7">
                        @if (ownerInvite(); as r) {
                          @if (r.acceptUrl) {
                            <app-secret-once
                              title="Invitation link — pass it to the new Owner"
                              [value]="r.acceptUrl"
                              warning="Shown once. It works once, for this person, for 7 days."
                              (dismissed)="closeOwnerInvite()"
                            />
                          } @else {
                            <p class="small">The new Owner was e-mailed a set-up link.</p>
                          }
                          @if (r.temporaryPassword) {
                            <app-secret-once
                              title="One-time password for their first sign-in"
                              [value]="r.temporaryPassword"
                              warning="Shown once. They must replace it when they first sign in."
                            />
                          }
                          <button
                            type="button"
                            class="btn btn-sm btn-secondary"
                            (click)="closeOwnerInvite()"
                          >
                            Done
                          </button>
                        } @else {
                          <form class="actions-row" (ngSubmit)="inviteOwner()">
                            <label class="field">
                              <span class="label">Owner's e-mail address</span>
                              <input
                                class="input"
                                type="email"
                                name="ownerEmail"
                                maxlength="256"
                                [ngModel]="ownerEmail()"
                                (ngModelChange)="ownerEmail.set($event)"
                              />
                            </label>
                            <span class="small muted"
                              >They become the organisation's Owner when they accept; they then
                              invite everyone else.</span
                            >
                            <button
                              type="button"
                              class="btn btn-sm btn-secondary"
                              (click)="closeOwnerInvite()"
                            >
                              Cancel
                            </button>
                            <button
                              type="submit"
                              class="btn btn-sm btn-primary"
                              [disabled]="busy() || !ownerEmail().includes('@')"
                            >
                              {{ busy() ? 'Inviting…' : 'Invite' }}
                            </button>
                          </form>
                        }
                      </td>
                    </tr>
                  }
                  @if (openPlanFor() === t.id) {
                    <tr class="selected detail">
                      <td colspan="7">
                        <app-tenant-plan-panel
                          [tenant]="t"
                          [plans]="canManagePlans ? plans.value() : null"
                          [canReadUsage]="canReadUsage"
                          (changed)="tenants.reload()"
                        />
                      </td>
                    </tr>
                  }
                }
              </tbody>
            </table>
          </div>
        }
      </section>

      <div class="cols">
        <section class="card">
          <header class="card-head">
            <h3>Plans in use</h3>
            @if (canManagePlans && plans.loaded()) {
              <span class="count">{{ plans.value().length }}</span>
            }
            <span class="spacer"></span>
            <a class="small" routerLink="/platform/plans">Manage plans →</a>
          </header>
          @if (!canManagePlans) {
            <p class="pad small muted">
              Seeing the plans needs <code>platform.plans.manage</code>.
            </p>
          } @else if (plans.loaded() && plans.value().length === 0) {
            <p class="empty">
              <strong>No plans yet.</strong>
              Each plan you create on the Plans page is listed here with the organisations on it.
            </p>
          } @else {
            <div class="table-wrap">
              <table class="grid">
                <thead>
                  <tr>
                    <th>Plan</th>
                    <th>Organisations on it</th>
                    <th class="num">Share</th>
                  </tr>
                </thead>
                <tbody>
                  @for (p of plans.value(); track p.id) {
                    @let n = onPlanCount(p.id, p.isDefault);
                    <tr>
                      <td>
                        <span class="name">{{ p.name }}</span>
                        @if (p.isDefault) {
                          <span class="chip info">default</span>
                        }
                        <span class="sub">{{ p.description || '' }}</span>
                      </td>
                      <td class="small" [class.dim]="n === 0">{{ onPlan(p.id, p.isDefault) }}</td>
                      <td class="num">
                        <span class="share">
                          <span class="bar" aria-hidden="true"
                            ><span [style.width.%]="sharePct(n)"></span
                          ></span>
                          {{ n }}
                        </span>
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        </section>

        <section class="card">
          <header class="card-head"><h3>How organisations arrive and leave</h3></header>
          <div class="card-body small">
            <ul class="links">
              <li>
                <strong>Created by staff</strong> here with <em>New organisation</em>, then
                <em>Invite first Owner</em> seats its first Owner.
              </li>
              <li>
                <strong>Self-serve sign-up</strong>:
                @if (signup.value(); as su) {
                  {{ su.available ? 'available' : su.enabled ? 'switched on but blocked' : 'off' }}
                  ({{ su.pending }} waiting) —
                }
                <a routerLink="/platform/signups">Sign-ups</a>.
              </li>
              <li>
                <strong>Suspended</strong> organisations keep their data and open positions under
                watch; members cannot sign in.
              </li>
              <li>
                <strong>Closed</strong> by an Owner, reopenable for the grace period, then deleted
                by staff — <a routerLink="/platform/closures">Closed organisations</a>.
              </li>
              <li>
                Their terminals' health across organisations:
                <a routerLink="/platform/fleet">Fleet</a>.
              </li>
            </ul>
          </div>
        </section>
      </div>

      <app-audit-trail
        heading="Organisation and membership changes"
        [actions]="['platform.tenant.', 'iam.membership.']"
        empty="No organisation has been created, suspended or moved to another plan, and no membership changed since the audit log began. Each change is recorded here."
      />

      <app-confirm-dialog
        [open]="statusChange() !== null"
        [title]="
          (statusChange()?.action === 'suspend' ? 'Suspend ' : 'Reactivate ') +
          (statusChange()?.tenant?.name ?? '') +
          '?'
        "
        [message]="
          statusChange()?.action === 'suspend'
            ? 'Its members are refused at once. Its EAs keep connecting so open positions stay managed — this is not a kill switch.'
            : 'Its members can sign in again.'
        "
        [confirmLabel]="statusChange()?.action === 'suspend' ? 'Suspend' : 'Reactivate'"
        [confirmVariant]="statusChange()?.action === 'suspend' ? 'destructive' : 'primary'"
        [loading]="busy()"
        (confirm)="changeStatus()"
        (cancelled)="statusChange.set(null)"
      >
        <label class="field">
          <span class="label"
            >Reason (recorded{{ statusChange()?.action === 'suspend' ? ', required' : '' }})</span
          >
          <input
            class="input"
            name="reason"
            [ngModel]="reason()"
            (ngModelChange)="reason.set($event)"
          />
        </label>
      </app-confirm-dialog>
    </div>
  `,
})
export class OrganisationsPageComponent {
  private readonly iam = inject(IamApiService);
  private readonly notify = inject(NotificationService);
  private readonly auth = inject(AuthService);
  private readonly plansApi = inject(PlansApiService);

  /** Multi-tenancy Phase 7: move organisations between plans / read their usage and the monthly export. */
  protected readonly canManagePlans = this.auth.hasPermission(Permission.PlatformPlansManage);
  protected readonly canReadUsage = this.auth.hasPermission(Permission.PlatformUsageRead);
  readonly plans = iamResource(
    () => this.plansApi.plans(),
    [] as PlanDto[],
    'Could not load plans.',
  );
  /** The House plan is House's alone. */
  readonly assignablePlans = computed(() => this.plans.value().filter((p) => !p.isHousePlan));
  readonly openPlanFor = signal<number | null>(null);

  protected readonly when = when;

  readonly search = signal('');
  readonly tenants = iamResource(
    () => this.iam.tenants(this.search().trim() || undefined),
    [] as TenantDto[],
    'Could not load organisations.',
  );

  private readonly onboarding = inject(OnboardingApiService);
  readonly signup = iamResource<SignupStatus | null>(
    () =>
      this.auth.hasPermission(Permission.PlatformTenantsManage)
        ? this.onboarding.signupStatus().pipe(catchError(() => of(null)))
        : of(null),
    null,
  );
  readonly tiles = computed<StatTile[]>(() => {
    const t = this.tenants.value();
    const s = countBy(t, (x) => x.status);
    const k = countBy(t, (x) => x.kind);
    const members = t.reduce((n, x) => n + (x.activeMembers ?? 0), 0);
    const newest =
      t
        .map((x) => x.createdAtUtc ?? '')
        .sort()
        .at(-1) || null;
    return [
      {
        label: 'Organisations',
        value: this.tenants.loaded() ? String(t.length) : '…',
        caption:
          Object.entries(k)
            .map(([kind, n]) => `${n} ${kind}`)
            .join(' · ') || 'none',
      },
      {
        label: 'Active',
        value: this.tenants.loaded() ? String(s['Active'] ?? 0) : '…',
        caption: `${s['Suspended'] ?? 0} suspended · ${s['Closed'] ?? 0} closed`,
        tone: s['Suspended'] ? 'warn' : 'good',
      },
      {
        label: 'Active members',
        value: this.tenants.loaded() ? String(members) : '…',
        caption: 'across every organisation',
      },
      {
        label: 'Newest',
        value: newest ? ago(newest) : '—',
        caption: newest ? 'since the last organisation was created' : 'no organisation yet',
      },
      {
        label: 'Self-serve sign-up',
        value: !this.signup.value()
          ? '—'
          : this.signup.value()!.available
            ? 'Available'
            : this.signup.value()!.enabled
              ? 'Blocked'
              : 'Off',
        caption: this.signup.value()
          ? `${plural(this.signup.value()!.pending, 'request')} waiting`
          : 'staff create organisations',
        route: '/platform/signups',
      },
    ];
  });

  /** Client-side status filter over the loaded list (the search still goes to the engine). */
  protected readonly statusFilters = [
    { key: 'All', label: 'All' },
    { key: 'Active', label: 'Active' },
    { key: 'Suspended', label: 'Suspended' },
    { key: 'Closed', label: 'Closed' },
  ] as const;
  readonly statusFilter = signal<'All' | 'Active' | 'Suspended' | 'Closed'>('All');
  readonly shown = computed(() => {
    const f = this.statusFilter();
    const all = this.tenants.value();
    return f === 'All' ? all : all.filter((t) => t.status === f);
  });
  protected readonly ago = ago;

  statusCount(key: string): number {
    const all = this.tenants.value();
    return key === 'All' ? all.length : all.filter((t) => t.status === key).length;
  }

  onPlanCount(planId: number, isDefault: boolean): number {
    return this.tenants
      .value()
      .filter((t) => t.planId === planId || (isDefault && t.planId == null)).length;
  }

  sharePct(n: number): number {
    const total = this.tenants.value().length;
    return total > 0 ? Math.round((n / total) * 100) : 0;
  }

  onPlan(planId: number, isDefault: boolean): string {
    const names = this.tenants
      .value()
      .filter((t) => t.planId === planId || (isDefault && t.planId == null))
      .map((t) => t.name);
    return names.length ? names.join(', ') : 'none';
  }

  readonly creating = signal(false);
  readonly draft = signal<CreateTenantBody>({
    slug: '',
    name: '',
    kind: 'Customer',
    contributesToPlatformLearning: false,
  });
  readonly submitted = signal(false);
  readonly errors = computed(() => tenantErrors(this.draft()));
  readonly busy = signal(false);

  readonly openMembersFor = signal<number | null>(null);
  readonly members = signal<IamMember[]>([]);
  readonly membersError = signal<string | null>(null);

  readonly statusChange = signal<{ tenant: TenantDto; action: 'suspend' | 'reactivate' } | null>(
    null,
  );
  readonly reason = signal('');

  constructor() {
    this.tenants.reload();
    this.signup.reload();
    if (this.canManagePlans) this.plans.reload();
  }

  togglePlan(t: TenantDto): void {
    this.openPlanFor.set(this.openPlanFor() === t.id ? null : t.id);
  }

  statusAction(t: TenantDto) {
    return tenantStatusAction(t);
  }

  label(m: IamMember): string {
    return memberLabel(m);
  }

  patch(change: Partial<CreateTenantBody>): void {
    this.draft.update((d) => ({ ...d, ...change }));
  }

  create(): void {
    this.submitted.set(true);
    if (this.errors().length || this.busy()) return;
    const body = {
      ...this.draft(),
      slug: this.draft().slug.trim().toLowerCase(),
      name: this.draft().name.trim(),
    };
    this.busy.set(true);
    this.iam.createTenant(body).subscribe({
      next: () => {
        this.busy.set(false);
        this.submitted.set(false);
        this.creating.set(false);
        this.draft.set({
          slug: '',
          name: '',
          kind: 'Customer',
          contributesToPlatformLearning: false,
          planId: null,
        });
        this.notify.success(`Organisation ${body.name} created.`);
        this.tenants.reload();
      },
      error: (e) => {
        this.busy.set(false);
        if (reportable(e)) this.notify.error(errorText(e, 'The organisation was not created.'));
      },
    });
  }

  // ── First Owner (engine enterprise onboarding) ──
  readonly ownerInviteFor = signal<TenantDto | null>(null);
  readonly ownerEmail = signal('');
  readonly ownerInvite = signal<CreateInvitationResult | null>(null);

  /** Customer and Canary organisations that are active; the engine refuses one that already has an Owner. */
  canInviteOwner(t: TenantDto): boolean {
    return (t.kind === 'Customer' || t.kind === 'Canary') && t.status === 'Active';
  }

  startOwnerInvite(t: TenantDto): void {
    this.ownerInvite.set(null);
    this.ownerEmail.set('');
    this.ownerInviteFor.set(this.ownerInviteFor()?.id === t.id ? null : t);
  }

  closeOwnerInvite(): void {
    this.ownerInviteFor.set(null);
    this.ownerInvite.set(null);
    this.ownerEmail.set('');
  }

  inviteOwner(): void {
    const t = this.ownerInviteFor();
    const email = this.ownerEmail().trim();
    if (!t || !email || this.busy()) return;
    this.busy.set(true);
    this.iam.inviteFirstOwner(t.id, email).subscribe({
      next: (r) => {
        this.busy.set(false);
        this.ownerInvite.set(r);
        this.notify.success(`${email} invited as the first Owner of ${t.name}.`);
      },
      error: (e) => {
        this.busy.set(false);
        if (reportable(e)) this.notify.error(errorText(e, 'The Owner was not invited.'));
      },
    });
  }

  toggleMembers(t: TenantDto): void {
    if (this.openMembersFor() === t.id) {
      this.openMembersFor.set(null);
      return;
    }
    this.openMembersFor.set(t.id);
    this.members.set([]);
    this.membersError.set(null);
    this.iam.tenantMembers(t.id).subscribe({
      next: (m) => this.members.set(m),
      error: (e) => this.membersError.set(errorText(e, 'Could not load members.')),
    });
  }

  openStatus(tenant: TenantDto, action: 'suspend' | 'reactivate'): void {
    this.reason.set('');
    this.statusChange.set({ tenant, action });
  }

  changeStatus(): void {
    const c = this.statusChange();
    if (!c || this.busy()) return;
    const reason = this.reason().trim();
    if (c.action === 'suspend' && !reason) {
      this.notify.error('Say why the organisation is suspended.');
      return;
    }
    this.busy.set(true);
    const call =
      c.action === 'suspend'
        ? this.iam.suspendTenant(c.tenant.id, reason)
        : this.iam.reactivateTenant(c.tenant.id, reason || null);
    call.subscribe({
      next: () => {
        this.busy.set(false);
        this.statusChange.set(null);
        this.notify.success(
          `${c.tenant.name} ${c.action === 'suspend' ? 'suspended' : 'reactivated'}.`,
        );
        this.tenants.reload();
      },
      error: (e) => {
        this.busy.set(false);
        this.statusChange.set(null);
        if (reportable(e)) this.notify.error(errorText(e, 'The status was not changed.'));
      },
    });
  }
}
