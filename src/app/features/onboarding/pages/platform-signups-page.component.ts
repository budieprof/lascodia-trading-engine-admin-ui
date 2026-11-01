import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { of } from 'rxjs';

import { AuthService } from '@core/auth/auth.service';
import { Permission } from '@core/auth/permissions.generated';
import { BillingApiService } from '@features/billing/billing-api.service';
import type { BillingSubscription } from '@features/billing/billing.types';
import { ago, plural } from '@features/iam/shared/admin-context.logic';
import { AuditTrailComponent } from '@features/iam/shared/audit-trail.component';
import { StatTilesComponent, type StatTile } from '@features/iam/shared/stat-tiles.component';
import { PlansApiService } from '@features/platform/plans-api.service';
import type { PlanDto } from '@features/platform/plans.types';
import { FeatureStateComponent } from '@shared/components/feedback/feature-state.component';

import { NotificationService } from '@core/notifications/notification.service';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { ModalA11yDirective } from '@shared/directives/modal-a11y.directive';
import { errorText } from '@features/iam/iam.logic';
import { iamResource } from '@features/iam/shared/iam-resource';
import { OnboardingApiService } from '../onboarding-api.service';
import {
  canDecide,
  signupCounts,
  signupRequirements,
  signupStatusLabel,
  signupTone,
} from '../onboarding.logic';
import type { SignupStatus, TenantSignup } from '../onboarding.types';

/**
 * Self-serve sign-ups, for platform staff (engine multi-tenancy Phase 7, LC.1, `/platform/signups`,
 * `platform.tenants.manage`): whether sign-up is on and can run (and why not — it stays off while the
 * sign-in service cannot e-mail), and the requests. Approving creates the organisation once the person's
 * address is verified (Trial plan, demo-only, the person as Owner); turning one down removes the person's
 * sign-in. Every decision is audited.
 */
@Component({
  selector: 'app-platform-signups-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    FormsModule,
    RouterLink,
    PageHeaderComponent,
    ModalA11yDirective,
    StatTilesComponent,
    FeatureStateComponent,
    AuditTrailComponent,
  ],
  styleUrls: [
    '../../iam/shared/iam-page.scss',
    '../../venues/pages/venue-page.scss',
    './platform-signups-page.scss',
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Sign-ups"
        subtitle="People who asked to create an organisation. Approve to create it; turn down to remove their sign-in."
      >
        <button
          type="button"
          class="btn btn-secondary"
          (click)="reload()"
          [disabled]="signups.loading()"
        >
          {{ signups.loading() ? 'Loading…' : 'Refresh' }}
        </button>
      </app-page-header>

      <app-stat-tiles [tiles]="tiles()" label="Sign-up summary" />

      @if (status.value(); as st) {
        <app-feature-state
          title="Self-serve sign-up"
          summary="Lets someone create their own organisation from the public sign-in page: they verify their e-mail, set a password and a second factor, and the engine creates a demo-only organisation on the default plan with them as Owner."
          [kind]="st.available ? 'on' : st.enabled ? 'partial' : 'off'"
          [stateLabel]="st.available ? 'On' : st.enabled ? 'On · cannot run' : 'Off'"
          switchKey="Tenancy:SelfServeSignup"
          [detail]="stateDetail()"
          [requirements]="requirements()"
          [links]="[
            { label: 'Organisations', route: '/platform/organisations' },
            { label: 'Plans', route: '/platform/plans' },
            { label: 'Platform operator guide', route: '/docs/platform-guide' },
          ]"
        />
      } @else if (status.error(); as err) {
        <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
      }

      <section class="card">
        <header class="card-head">
          <h3>Requests</h3>
          @if (signups.loaded()) {
            <span class="count">{{ signups.value().length }}</span>
          }
          <span class="spacer"></span>
          <span class="hint">Newest first · every decision is audited</span>
        </header>
        <div class="toolbar">
          <div class="seg" role="group" aria-label="Show requests">
            @for (f of filters; track f.value) {
              <button
                type="button"
                [class.on]="filter() === f.value"
                [attr.aria-pressed]="filter() === f.value"
                (click)="filter.set(f.value); signups.reload()"
              >
                {{ f.label }}
              </button>
            }
          </div>
          <span class="grow"></span>
          @if (signups.loading()) {
            <span class="hint small muted">Loading…</span>
          }
        </div>
        @if (signups.error(); as err) {
          <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
        }
        @if (signups.loaded() && signups.value().length === 0 && !signups.error()) {
          <div class="empty">
            @if (filter()) {
              <p class="empty-title">No request with this status.</p>
              <p>Pick “All” to see every request, whatever happened to it.</p>
            } @else if (status.value()?.available) {
              <p class="empty-title">Nobody has asked yet.</p>
              <p>
                A request appears here as soon as someone fills in the public "Create an
                organisation" form.
              </p>
            } @else {
              <p class="empty-title">No one has asked to create an organisation.</p>
              <p>
                The public form is not offered while sign-up cannot run (see the checklist above),
                so organisations are created by staff on
                <a routerLink="/platform/organisations">Organisations</a>.
              </p>
            }
          </div>
        }
        @if (signups.value().length) {
          <div class="table-wrap">
            <table class="grid">
              <thead>
                <tr>
                  <th scope="col">Organisation</th>
                  <th scope="col">Person</th>
                  <th scope="col">Asked</th>
                  <th scope="col">Status</th>
                  <th scope="col"><span class="sr-only">Decide</span></th>
                </tr>
              </thead>
              <tbody>
                @for (s of signups.value(); track s.id) {
                  <tr [class.is-past]="!decide(s).reject">
                    <td>
                      <span class="who">{{ s.organisationName }}</span>
                      <span class="sub">
                        <span class="mono">{{ s.organisationSlug }}</span>
                        @if (s.tenantId) {
                          · #{{ s.tenantId }}
                        }
                      </span>
                    </td>
                    <td>
                      {{ s.displayName }}
                      <span class="sub">{{ s.email }}</span>
                    </td>
                    <td class="nowrap" [title]="s.requestedAtUtc | date: 'medium'">
                      {{ ago(s.requestedAtUtc) }}
                      <span class="when-sub">from {{ s.requestIp || 'unknown address' }}</span>
                    </td>
                    <td>
                      <span [class]="'dot ' + tone(s)">{{ label(s) }}</span>
                      @if (s.decisionNote) {
                        <span class="decision-note">“{{ s.decisionNote }}”</span>
                      }
                    </td>
                    <td class="actions">
                      @if (decide(s).approve) {
                        <button
                          type="button"
                          class="btn btn-primary btn-sm"
                          [disabled]="busy()"
                          (click)="open(s, 'approve')"
                        >
                          Approve…
                        </button>
                      }
                      @if (decide(s).reject) {
                        <button
                          type="button"
                          class="btn btn-ghost-danger btn-sm"
                          [disabled]="busy()"
                          (click)="open(s, 'reject')"
                        >
                          Turn down…
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

      <div class="cols">
        <section class="card">
          <header class="card-head">
            <div class="titles">
              <h3>How a sign-up becomes an organisation</h3>
              <p>Four steps, from the public form to a working organisation</p>
            </div>
          </header>
          <div class="card-body small">
            <ol class="steps">
              <li>
                The person fills in the public form.
                @if (status.value()?.maxPerIpPerDay; as ip) {
                  At most {{ ip }} sign-ups per client address and
                  {{ status.value()?.maxPerDomainPerDay }} per e-mail domain a day;
                  {{ status.value()?.deniedDomainCount }} throwaway-mail domains are refused.
                } @else {
                  Sign-ups per client address and per e-mail domain are limited each day, and
                  throwaway-mail domains are refused.
                }
                An existing account gets the same answer as a new one.
              </li>
              <li>
                They verify the address from the e-mail (link valid
                {{ status.value()?.linkHours ?? 24 }} h)
                @if (status.value()?.expiryDays; as d) {
                  ; an unverified request lapses after {{ d }} days
                }
                .
              </li>
              <li>
                @if (status.value()?.requiresApproval) {
                  Platform staff approve it here (<code
                    >Tenancy:SelfServeSignupRequiresApproval</code
                  >
                  is on).
                } @else {
                  No staff approval: <code>Tenancy:SelfServeSignupRequiresApproval</code> is off, so
                  the organisation is created at the first verified sign-in.
                }
              </li>
              <li>
                The engine creates the organisation on the default plan
                <strong>{{ defaultPlan()?.name ?? '—' }}</strong
                >, demo accounts only, with the person as Owner, and opens its onboarding checklist.
              </li>
            </ol>
          </div>
        </section>

        <section class="card">
          <header class="card-head">
            <div class="titles">
              <h3>Plans and payment for new organisations</h3>
              <p>What a new organisation gets, and how it can upgrade</p>
            </div>
            <span class="spacer"></span>
            @if (defaultPlan()) {
              <a class="btn btn-ghost btn-sm" routerLink="/platform/plans">Change plans</a>
            }
          </header>
          <div class="card-body small">
            @if (defaultPlan(); as p) {
              <p class="line">
                New organisations start on <strong>{{ p.name }}</strong>
              </p>
              <ul class="facts-list" aria-label="Default plan limits">
                <li>
                  <span class="k">Trading accounts</span>
                  <span class="v">{{ limitValue(p.maxTradingAccounts) }}</span>
                </li>
                <li>
                  <span class="k">Terminals</span>
                  <span class="v">{{ limitValue(p.maxActiveEaInstances) }}</span>
                </li>
                <li>
                  <span class="k">Members</span>
                  <span class="v">{{ limitValue(p.maxMembers) }}</span>
                </li>
                <li>
                  <span class="k">Strategies</span>
                  <span class="v">{{ limitValue(p.maxStrategies) }}</span>
                </li>
              </ul>
            } @else if (!canReadPlans()) {
              <p class="muted">Seeing the plans needs <code>platform.plans.manage</code>.</p>
            }
            @if (billing.value(); as b) {
              <p class="line">
                @if (b.selfServeEnabled) {
                  <span class="dot ok">Card billing on</span>
                  <span
                    >An Owner can upgrade with a card (the payment provider's payment page) from
                    their organisation's billing page.</span
                  >
                } @else {
                  <span class="dot">Card billing off</span>
                  <span
                    >Upgrading is by contacting the platform operator: self-serve card billing
                    (<code>Billing:SelfServe:Enabled</code> + payment provider keys on the engine
                    host) is not set up.</span
                  >
                }
              </p>
            }
          </div>
        </section>
      </div>

      <app-audit-trail
        heading="Sign-up activity"
        [actions]="['tenant.signup.']"
        empty="No sign-up has been requested, verified, approved or turned down yet. Every step of every request is recorded here."
      />

      @if (deciding(); as d) {
        <div class="overlay" role="presentation">
          <div
            class="dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="signup-decision-title"
            tabindex="-1"
            appModalA11y
            (dismiss)="cancel()"
          >
            <h3 id="signup-decision-title">
              {{ d.action === 'approve' ? 'Approve' : 'Turn down' }} “{{
                d.signup.organisationName
              }}”?
            </h3>
            <p>
              @if (d.action === 'approve') {
                The organisation is created on the Trial plan (demo accounts only) with
                {{ d.signup.displayName }} as its Owner — now if their address is verified,
                otherwise when they first sign in with it verified.
              } @else {
                {{ d.signup.displayName }}'s sign-in is removed and no organisation is created.
              }
            </p>
            <label class="field">
              <span class="label">{{
                d.action === 'approve' ? 'Note (optional)' : 'Why? (required)'
              }}</span>
              <textarea
                class="textarea"
                name="note"
                rows="3"
                maxlength="500"
                [ngModel]="note()"
                (ngModelChange)="note.set($event)"
              ></textarea>
            </label>
            <div class="actions-row">
              <button
                type="button"
                class="btn btn-secondary"
                data-autofocus
                [disabled]="busy()"
                (click)="cancel()"
              >
                Cancel
              </button>
              <button
                type="button"
                class="btn"
                [class.btn-primary]="d.action === 'approve'"
                [class.btn-danger]="d.action === 'reject'"
                [disabled]="busy() || (d.action === 'reject' && !note().trim())"
                (click)="confirm()"
              >
                {{ d.action === 'approve' ? 'Approve' : 'Turn down' }}
              </button>
            </div>
          </div>
        </div>
      }
    </div>
  `,
})
export class PlatformSignupsPageComponent {
  private readonly api = inject(OnboardingApiService);
  private readonly notify = inject(NotificationService);
  private readonly auth = inject(AuthService);
  private readonly plansApi = inject(PlansApiService);
  private readonly billingApi = inject(BillingApiService);

  protected readonly label = signupStatusLabel;
  protected readonly tone = signupTone;
  protected readonly decide = canDecide;
  protected readonly ago = ago;
  /** The status filter as segmented pills; values are the engine's filter keys. */
  protected readonly filters: readonly { value: string; label: string }[] = [
    { value: '', label: 'All' },
    { value: 'Pending', label: 'Waiting' },
    { value: 'Approved', label: 'Approved' },
    { value: 'Provisioned', label: 'Created' },
    { value: 'Rejected', label: 'Turned down' },
  ];

  readonly filter = signal('');
  readonly signups = iamResource<TenantSignup[]>(
    () => this.api.signups(this.filter() || null),
    [],
    'Could not load the sign-ups.',
  );
  readonly status = iamResource<SignupStatus | null>(
    () => this.api.signupStatus(),
    null,
    'Could not load the sign-up status.',
  );
  /** Every request (unfiltered) for the tiles. */
  readonly all = iamResource<TenantSignup[]>(
    () => this.api.signups(null),
    [],
    'Could not load the sign-ups.',
  );
  readonly canReadPlans = computed(() => this.auth.hasPermission(Permission.PlatformPlansManage));
  readonly plans = iamResource<PlanDto[]>(
    () => (this.canReadPlans() ? this.plansApi.plans() : of([])),
    [],
    'Could not load the plans.',
  );
  readonly billing = iamResource<BillingSubscription | null>(
    () =>
      this.auth.hasPermission(Permission.TenantBillingRead)
        ? this.billingApi.subscription()
        : of(null),
    null,
    'Could not load the billing state.',
  );
  readonly defaultPlan = computed(() => this.plans.value().find((p) => p.isDefault) ?? null);
  readonly requirements = computed(() => {
    const s = this.status.value();
    return s ? signupRequirements(s) : [];
  });
  readonly stateDetail = computed(() => {
    const s = this.status.value();
    if (!s) return null;
    const missing = this.requirements().filter((r) => r.ok === false).length;
    if (s.available) return `Running. ${s.pending} waiting for approval.`;
    if (!s.enabled)
      return missing > 1
        ? `Off, and ${missing - 1} more requirement${missing - 1 === 1 ? '' : 's'} would have to be met before it could run.`
        : 'Off. Everything else it needs is in place — switching it on is an engine-host setting.';
    return 'Switched on, but the public page answers "not available" until every requirement below is met.';
  });
  readonly tiles = computed<StatTile[]>(() => {
    const s = this.status.value();
    const rows = this.all.value();
    const c = signupCounts(rows);
    const met = this.requirements().filter((r) => r.ok === true).length;
    const total = this.requirements().length;
    const last = rows[0]?.requestedAtUtc ?? null;
    return [
      {
        label: 'Self-serve sign-up',
        value: !s ? '…' : s.available ? 'Available' : s.enabled ? 'Blocked' : 'Off',
        caption: total ? `${met} of ${total} requirements met` : null,
        tone: !s ? null : s.available ? 'good' : 'warn',
      },
      {
        label: 'Waiting for approval',
        value: s ? String(s.pending) : '…',
        caption: s?.requiresApproval ? 'staff approve each one' : 'approval is not required',
        tone: s?.pending ? 'warn' : null,
      },
      {
        label: 'Requests so far',
        value: this.all.loaded() ? String(rows.length) : '…',
        caption: last ? `latest ${ago(last)}` : 'none ever made',
      },
      {
        label: 'Organisations created',
        value: this.all.loaded() ? String(c['Provisioned'] ?? 0) : '…',
        caption: `${c['Rejected'] ?? 0} turned down · ${c['Expired'] ?? 0} lapsed`,
      },
      {
        label: 'New organisations start on',
        value: this.defaultPlan()?.name ?? (this.canReadPlans() ? '…' : '—'),
        caption: 'the default plan · demo accounts only',
        route: '/platform/plans',
      },
    ];
  });
  readonly deciding = signal<{ signup: TenantSignup; action: 'approve' | 'reject' } | null>(null);
  readonly note = signal('');
  readonly busy = signal(false);

  constructor() {
    this.reload();
  }

  reload(): void {
    this.signups.reload();
    this.status.reload();
    this.all.reload();
    this.plans.reload();
    this.billing.reload();
  }

  limit(n: number | null, one: string, many?: string): string {
    return n == null ? `unlimited ${many ?? one + 's'}` : plural(n, one, many);
  }

  /** A plan limit as a tile figure: the number, or "Unlimited". */
  limitValue(n: number | null): string {
    return n == null ? 'Unlimited' : n.toLocaleString();
  }

  open(signup: TenantSignup, action: 'approve' | 'reject'): void {
    this.note.set('');
    this.deciding.set({ signup, action });
  }

  cancel(): void {
    if (!this.busy()) this.deciding.set(null);
  }

  confirm(): void {
    const d = this.deciding();
    if (!d) return;
    this.busy.set(true);
    const call =
      d.action === 'approve'
        ? this.api.approve(d.signup.id, this.note().trim() || null)
        : this.api.reject(d.signup.id, this.note().trim());
    call.subscribe({
      next: (updated) => {
        this.busy.set(false);
        this.deciding.set(null);
        this.notify.success(d.action === 'approve' ? signupStatusLabel(updated) : 'Turned down.');
        this.reload();
      },
      error: (e) => {
        this.busy.set(false);
        this.notify.error(
          errorText(
            e,
            d.action === 'approve' ? 'Could not approve it.' : 'Could not turn it down.',
          ),
        );
      },
    });
  }
}
