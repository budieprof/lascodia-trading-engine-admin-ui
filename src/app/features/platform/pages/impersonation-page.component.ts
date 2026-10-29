import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { catchError, of } from 'rxjs';

import { AuthService } from '@core/auth/auth.service';
import { BrowserLocation } from '@core/browser/browser-location';
import { Permission, permissionDefinition } from '@core/auth/permissions.generated';
import { DEFAULT_POST_LOGIN_ROUTE } from '@core/auth/return-url';
import { NotificationService } from '@core/notifications/notification.service';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { IamApiService } from '@features/iam/iam-api.service';
import { errorText, filterMembers, memberLabel, reportable } from '@features/iam/iam.logic';
import type { AccessElevation, IamMember, TenantDto } from '@features/iam/iam.types';
import { ago, plural } from '@features/iam/shared/admin-context.logic';
import { AuditTrailComponent } from '@features/iam/shared/audit-trail.component';
import { iamResource } from '@features/iam/shared/iam-resource';
import { MfaHintComponent } from '@features/iam/shared/mfa-hint.component';
import { StatTilesComponent, type StatTile } from '@features/iam/shared/stat-tiles.component';
import {
  FeatureStateComponent,
  type FeatureRequirement,
} from '@shared/components/feedback/feature-state.component';

/**
 * Impersonation (U3.6, ADR-0031 §6): platform staff view the console as another user to see what
 * they see — read-only (every change is refused), carried as the staff member in the session and
 * recorded in the organisation's audit log. A banner stays on every page until it is ended.
 */
@Component({
  selector: 'app-platform-impersonation-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    RouterLink,
    PageHeaderComponent,
    ConfirmDialogComponent,
    MfaHintComponent,
    StatTilesComponent,
    FeatureStateComponent,
    AuditTrailComponent,
  ],
  styleUrl: '../../iam/shared/iam-page.scss',
  styles: [
    `
      .split {
        display: grid;
        grid-template-columns: minmax(0, 3fr) minmax(300px, 2fr);
        gap: var(--space-3);
        align-items: start;
      }
      @media (max-width: 1100px) {
        .split {
          grid-template-columns: 1fr;
        }
      }
      .main-col,
      .side {
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
        min-width: 0;
      }

      .cols {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(380px, 1fr));
        gap: var(--space-3);
        align-items: start;
      }
      @media (max-width: 860px) {
        .cols {
          grid-template-columns: 1fr;
        }
      }
      .rules {
        list-style: disc;
        margin: 0;
        padding-left: var(--space-5);
        display: grid;
        gap: var(--space-2);
      }
    `,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Impersonation"
        subtitle="See the console as another user, read-only. Recorded in their organisation's audit log."
      />

      <app-stat-tiles [tiles]="tiles()" label="Impersonation summary" />

      <app-feature-state
        title="View as another person"
        summary="Shows you the console exactly as the chosen person sees it — their organisation, their permissions, their pages — so you can see what they report. Nothing can be changed while viewing unless an approved elevation allows it."
        [kind]="ready() ? 'on' : 'partial'"
        [stateLabel]="ready() ? 'Ready' : 'Not available to you'"
        [requirements]="requirements()"
        [links]="[
          { label: 'Elevated access', route: '/platform/elevations' },
          {
            label: 'Audit log',
            route: '/admin/audit',
            query: { action: 'platform.impersonation.' },
          },
          { label: 'Platform operator guide', route: '/docs/platform-guide' },
        ]"
      />

      <div class="split">
        <div class="main-col">
          <section class="card">
            <header class="card-head">
              <h3>Choose the person</h3>
              <span class="spacer"></span>
              <select
                class="select search"
                name="tenant"
                aria-label="Organisation"
                [ngModel]="tenantId()"
                (ngModelChange)="pickTenant($event)"
              >
                <option [ngValue]="null">Organisation…</option>
                @for (t of tenants.value(); track t.id) {
                  <option [ngValue]="t.id">{{ t.name }} ({{ t.slug }})</option>
                }
              </select>
              <input
                class="input search"
                type="search"
                placeholder="Filter people"
                aria-label="Filter people"
                [ngModel]="filter()"
                (ngModelChange)="filter.set($event)"
              />
            </header>
            @if (tenantId() === null) {
              <p class="pad muted">Choose an organisation to list its members.</p>
            } @else if (membersError(); as e) {
              <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ e }}</p>
            } @else if (shown().length === 0) {
              <p class="pad small muted">
                {{
                  members().length
                    ? 'No one else is an active member here — you cannot view yourself, and suspended or invited people have no console to see.'
                    : 'This organisation has no members yet.'
                }}
              </p>
            } @else {
              <table class="grid">
                <thead>
                  <tr>
                    <th>Person</th>
                    <th>Membership</th>
                    <th><span class="sr-only">View</span></th>
                  </tr>
                </thead>
                <tbody>
                  @for (m of shown(); track m.userId) {
                    <tr>
                      <td>
                        {{ label(m) }}<span class="sub">{{ m.email || '' }}</span>
                      </td>
                      <td class="small">
                        {{ m.status }}
                        <span class="sub">{{ memberSince(m) }}</span>
                      </td>
                      <td class="actions">
                        <button
                          type="button"
                          class="btn btn-sm btn-primary"
                          [disabled]="busy()"
                          (click)="target.set(m)"
                        >
                          View as
                        </button>
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            }
          </section>
        </div>
        <aside class="side">
          <section class="card">
            <header class="card-head"><h3>The rules</h3></header>
            <div class="card-body small">
              <ul class="rules">
                <li>
                  Read-only: every change is refused while you view, unless an approved elevation
                  for that organisation is active (<a routerLink="/platform/elevations"
                    >elevated access</a
                  >
                  — {{ activeElevations() }} active now).
                </li>
                <li>
                  Who may: platform staff holding <code>platform.impersonate</code> ({{
                    impersonateText()
                  }}).
                </li>
                <li>
                  It switches your console session; a banner stays on every page until you end it.
                  It works only in a console session signed in through the identity provider.
                </li>
                <li>
                  The start, the reason you give and the end are written to the viewed
                  organisation's audit log with your name.
                </li>
              </ul>
            </div>
          </section>

          <app-audit-trail
            heading="Impersonation history"
            [actions]="['platform.impersonation.']"
            empty="No one has viewed the console as another person yet. Each start (with its reason) and each end is recorded here and in the viewed organisation's audit log."
          />
        </aside>
      </div>

      <app-confirm-dialog
        [open]="target() !== null"
        [title]="'View the console as ' + (target() ? label(target()!) : '') + '?'"
        message="Read-only: you see what they see and can change nothing. It is recorded in their organisation's audit log, and a banner shows it until you end it."
        confirmLabel="Start, read-only"
        [loading]="busy()"
        (confirm)="start()"
        (cancelled)="target.set(null)"
      >
        <label class="field">
          <span class="label">Why (recorded in their audit log)</span>
          <input
            class="input"
            name="reason"
            [ngModel]="reason()"
            (ngModelChange)="reason.set($event)"
            placeholder="e.g. Ticket 4411: their dashboard is empty"
          />
        </label>
        <app-mfa-hint [permission]="P.PlatformImpersonate" />
      </app-confirm-dialog>
    </div>
  `,
})
export class ImpersonationPageComponent {
  private readonly iam = inject(IamApiService);
  private readonly auth = inject(AuthService);
  private readonly browser = inject(BrowserLocation);
  private readonly notify = inject(NotificationService);

  protected readonly P = Permission;

  readonly tenants = iamResource(
    () =>
      this.auth.hasPermission(Permission.PlatformTenantsManage)
        ? this.iam.tenants().pipe(catchError(() => of([] as TenantDto[])))
        : of([] as TenantDto[]),
    [] as TenantDto[],
  );
  readonly elevations = iamResource(
    () =>
      this.auth.hasPermission(Permission.PlatformElevationRequest)
        ? this.iam.elevations().pipe(catchError(() => of([] as AccessElevation[])))
        : of([] as AccessElevation[]),
    [] as AccessElevation[],
  );
  readonly canImpersonate = computed(() => this.auth.hasPermission(Permission.PlatformImpersonate));
  readonly bffSession = this.auth.mode === 'bff';
  readonly ready = computed(() => this.canImpersonate() && this.bffSession);
  readonly activeElevations = computed(
    () => this.elevations.value().filter((e) => e.status === 'Active').length,
  );
  readonly requirements = computed<FeatureRequirement[]>(() => [
    {
      label: 'You hold platform.impersonate',
      ok: this.canImpersonate(),
      detail: this.canImpersonate()
        ? 'Granted to you as platform staff.'
        : 'Only platform staff (PlatformAdmin / PlatformSupport, or House admins) hold it.',
    },
    {
      label: 'Console signed in through the identity provider',
      ok: this.bffSession,
      detail: this.bffSession
        ? 'This console uses identity-provider sessions, which impersonation switches.'
        : 'This console signs in with the older password form; the engine refuses impersonation from it.',
    },
    {
      label: 'An approved elevation, to change anything',
      ok: this.activeElevations() > 0 ? true : null,
      detail:
        this.activeElevations() > 0
          ? `${plural(this.activeElevations(), 'elevation')} active — changes allowed in that organisation.`
          : 'None active — viewing stays read-only, which is enough to see what someone sees.',
      route: '/platform/elevations',
    },
  ]);
  readonly tiles = computed<StatTile[]>(() => {
    const tenants = this.tenants.value();
    const people = this.shown().length;
    return [
      {
        label: 'Organisations',
        value: String(tenants.length),
        caption: tenants.length === 1 ? `only ${tenants[0].name}` : 'whose members you can view',
        route: '/platform/organisations',
      },
      {
        label: 'People you could view',
        value: this.tenantId() === null ? '—' : String(people),
        caption:
          this.tenantId() === null ? 'choose an organisation' : 'active members, yourself excluded',
      },
      {
        label: 'Elevations active',
        value: String(this.activeElevations()),
        caption: this.activeElevations()
          ? 'changes allowed while they last'
          : 'viewing is read-only',
        route: '/platform/elevations',
      },
      {
        label: 'Your access',
        value: this.ready() ? 'Can view' : 'Cannot view',
        caption: this.canImpersonate()
          ? 'you hold platform.impersonate'
          : 'needs platform.impersonate',
        tone: this.ready() ? 'good' : 'warn',
      },
    ];
  });
  readonly tenantId = signal<number | null>(null);
  readonly members = signal<IamMember[]>([]);
  readonly membersError = signal<string | null>(null);
  readonly filter = signal('');
  readonly shown = computed(() =>
    filterMembers(
      this.members().filter(
        (m) => m.status === 'Active' && String(m.userId) !== this.auth.user()?.passportId,
      ),
      this.filter(),
    ),
  );
  readonly target = signal<IamMember | null>(null);
  readonly reason = signal('');
  readonly busy = signal(false);

  constructor() {
    this.tenants.reload();
    this.elevations.reload();
    // One organisation (the usual single-install case): list its people straight away.
    effect(() => {
      const list = this.tenants.value();
      if (list.length === 1 && untracked(this.tenantId) === null) {
        untracked(() => this.pickTenant(list[0].id));
      }
    });
  }

  memberSince(m: IamMember): string {
    const parts: string[] = [];
    if (m.roles?.length) parts.push(m.roles.join(', '));
    parts.push(m.lastSignInAtUtc ? `signed in ${ago(m.lastSignInAtUtc)}` : 'never signed in');
    return parts.join(' · ');
  }

  impersonateText(): string {
    const d = permissionDefinition(Permission.PlatformImpersonate);
    return d?.stepUp
      ? 'a fresh second-factor sign-in is asked for at the start'
      : 'no extra sign-in step';
  }

  label(m: IamMember): string {
    return memberLabel(m);
  }

  pickTenant(id: number | null): void {
    this.tenantId.set(id);
    this.members.set([]);
    this.membersError.set(null);
    if (id === null) return;
    this.iam.tenantMembers(id).subscribe({
      next: (m) => this.members.set(m),
      error: (e) => this.membersError.set(errorText(e, 'Could not load members.')),
    });
  }

  start(): void {
    const m = this.target();
    const tenantId = this.tenantId();
    if (!m || tenantId === null || this.busy()) return;
    this.busy.set(true);
    this.iam
      .startImpersonation({
        userId: m.userId,
        tenantId,
        readOnly: true,
        reason: this.reason().trim() || null,
      })
      .subscribe({
        next: () => {
          // The session is now theirs (read-only): reload so every page shows their console.
          this.browser.assign(DEFAULT_POST_LOGIN_ROUTE);
        },
        error: (e) => {
          this.busy.set(false);
          this.target.set(null);
          if (reportable(e)) this.notify.error(errorText(e, 'Impersonation did not start.'));
        },
      });
  }
}
