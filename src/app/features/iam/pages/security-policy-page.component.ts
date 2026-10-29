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

import { Permission } from '@core/auth/permissions.generated';
import { NotificationService } from '@core/notifications/notification.service';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { IamApiService } from '../iam-api.service';
import {
  errorText,
  memberLabel,
  parseAllowlist,
  reportable,
  securityPolicyErrors,
  when,
} from '../iam.logic';
import type { IamMember, IamSession, SecurityPolicy } from '../iam.types';
import { ago, plural } from '../shared/admin-context.logic';
import { AuditTrailComponent } from '../shared/audit-trail.component';
import { iamResource } from '../shared/iam-resource';
import { MfaHintComponent } from '../shared/mfa-hint.component';
import { StatTilesComponent, type StatTile } from '../shared/stat-tiles.component';

/**
 * The organisation's sign-in policy (U3.4, contract C3.5): require a second factor, how long a
 * console session may sit idle and live in total, and the networks members may sign in from.
 * Applied by the engine at sign-in and on every request; saving needs `iam.security.manage`, a
 * step-up key. A narrower allow-list can lock people — you included — out, so the page says so.
 */
@Component({
  selector: 'app-iam-security-policy-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    RouterLink,
    PageHeaderComponent,
    ConfirmDialogComponent,
    MfaHintComponent,
    StatTilesComponent,
    AuditTrailComponent,
  ],
  styleUrl: '../shared/iam-page.scss',
  styles: [
    `
      .cols {
        display: grid;
        grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
        gap: var(--space-3);
        align-items: start;
      }
      @media (max-width: 1100px) {
        .cols {
          grid-template-columns: 1fr;
        }
      }
      .help {
        margin: 0;
        padding-left: var(--space-5);
        list-style: disc;
        display: grid;
        gap: var(--space-2);
      }
    `,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Security policy"
        subtitle="How members of this organisation sign in. Changes apply to new requests at once."
      >
        <button
          type="button"
          class="btn btn-secondary"
          (click)="load()"
          [disabled]="policy.loading()"
        >
          {{ policy.loading() ? 'Loading…' : 'Reload' }}
        </button>
      </app-page-header>

      <app-stat-tiles [tiles]="tiles()" label="Sign-in policy summary" />

      <div class="cols">
        <div class="page">
          @if (policy.error(); as err) {
            <section class="card">
              <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
            </section>
          } @else if (policy.loaded()) {
            <section class="card">
              <header class="card-head">
                <h3>Policy</h3>
                <span class="spacer"></span>
                <app-mfa-hint [permission]="P.IamSecurityManage" />
              </header>
              <form class="card-body" (ngSubmit)="review()">
                <label class="check">
                  <input
                    type="checkbox"
                    name="mfa"
                    [ngModel]="mfaRequired()"
                    (ngModelChange)="mfaRequired.set($event)"
                  />
                  Require a second factor (authenticator app or security key) to sign in
                </label>
                <div class="form-grid">
                  <label class="field">
                    <span class="label">Sign out after this many idle minutes</span>
                    <input
                      class="input"
                      type="number"
                      min="1"
                      step="1"
                      name="idle"
                      [ngModel]="idleMinutes()"
                      (ngModelChange)="idleMinutes.set(+$event)"
                    />
                  </label>
                  <label class="field">
                    <span class="label">End every session after this many hours</span>
                    <input
                      class="input"
                      type="number"
                      min="1"
                      step="1"
                      name="absolute"
                      [ngModel]="absoluteHours()"
                      (ngModelChange)="absoluteHours.set(+$event)"
                    />
                  </label>
                </div>
                <label class="field">
                  <span class="label"
                    >Allowed networks — one per line (leave empty to allow any network)</span
                  >
                  <textarea
                    class="textarea"
                    name="allow"
                    rows="5"
                    spellcheck="false"
                    placeholder="203.0.113.0/24&#10;2001:db8:1234::/48"
                    [attr.aria-invalid]="allow().errors.length > 0"
                    [ngModel]="allowText()"
                    (ngModelChange)="allowText.set($event)"
                  ></textarea>
                </label>
                @if (allow().entries.length) {
                  <p class="note warn">
                    Only these networks may sign in: {{ allow().entries.join(', ') }}. Make sure the
                    network you are on now is one of them, or you will be signed out and refused.
                  </p>
                }
                @if (problems().length) {
                  <ul class="errors" role="alert">
                    @for (e of problems(); track e) {
                      <li>{{ e }}</li>
                    }
                  </ul>
                }
                <div class="actions-row">
                  <button
                    type="submit"
                    class="btn btn-primary"
                    [disabled]="busy() || problems().length > 0 || !dirty()"
                  >
                    {{ busy() ? 'Saving…' : 'Save policy' }}
                  </button>
                </div>
              </form>
            </section>
          }

          <section class="card">
            <header class="card-head">
              <h3>Who it applies to</h3>
              <span class="spacer"></span>
              <a class="small" routerLink="/iam/members">Members</a>
            </header>
            @if (members.value().length === 0) {
              <p class="pad small muted">
                {{ members.loaded() ? 'No members to show.' : 'Loading…' }}
              </p>
            } @else {
              <div class="table-wrap">
                <table class="grid">
                  <thead>
                    <tr>
                      <th>Member</th>
                      <th>Signs in with</th>
                      <th>Last sign-in</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (m of members.value(); track m.userId) {
                      <tr>
                        <td>
                          {{ label(m)
                          }}<span class="sub">{{ m.status }} · {{ m.email || '' }}</span>
                        </td>
                        <td class="small">
                          @if (m.signsInWithIdentityProvider) {
                            <span class="chip ok">identity provider</span>
                          } @else if (m.signsInWithIdentityProvider === false) {
                            <span class="chip warn">password form only</span>
                          } @else {
                            —
                          }
                        </td>
                        <td class="small" [title]="when(m.lastSignInAtUtc)">
                          {{ m.lastSignInAtUtc ? ago(m.lastSignInAtUtc) : 'never' }}
                        </td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
              <p class="pad small muted">
                The policy is enforced on identity-provider sessions: the second factor at sign-in,
                the idle and total limits on every request, the network list at sign-in and on every
                request.
              </p>
            }
          </section>
        </div>

        <aside class="page">
          <section class="card">
            <header class="card-head"><h3>What each setting does</h3></header>
            <div class="card-body small">
              <ul class="help">
                <li>
                  <strong>Second factor</strong> — when required, a member without an authenticator
                  app or security key is asked to set one up at their next sign-in.
                </li>
                <li>
                  <strong>Idle minutes</strong> (5–1440) — a console session with no request for
                  this long ends; the console also signs out an idle tab.
                </li>
                <li>
                  <strong>Session hours</strong> (1–720) — the longest any session lives, active or
                  not.
                </li>
                <li>
                  <strong>Allowed networks</strong> — address ranges (CIDR) members may sign in and
                  work from. The engine refuses a list that would lock you out.
                </li>
                <li>
                  Saving needs <code>iam.security.manage</code> and a fresh second-factor sign-in.
                </li>
              </ul>
              <p class="muted">
                {{
                  policy.value()?.updatedAtUtc
                    ? 'Last saved ' +
                      ago(policy.value()!.updatedAtUtc!) +
                      ' (' +
                      when(policy.value()!.updatedAtUtc) +
                      ').'
                    : 'Never saved: these are the defaults every organisation starts with.'
                }}
              </p>
            </div>
          </section>
          <app-audit-trail
            heading="Policy changes and refused sign-ins"
            [actions]="['iam.security_policy.', 'auth.login.failed', 'auth.lockout.']"
            [limit]="6"
            empty="No policy change or refused sign-in is recorded. Each save, each refused password and each lockout appears here."
          />
        </aside>
      </div>

      <app-confirm-dialog
        [open]="confirming()"
        title="Change the sign-in policy?"
        [message]="summary()"
        confirmLabel="Save policy"
        [loading]="busy()"
        (confirm)="save()"
        (cancelled)="confirming.set(false)"
      />
    </div>
  `,
})
export class SecurityPolicyPageComponent {
  private readonly iam = inject(IamApiService);
  private readonly notify = inject(NotificationService);

  protected readonly P = Permission;

  readonly policy = iamResource<SecurityPolicy | null>(
    () => this.iam.securityPolicy(),
    null,
    'Could not load the policy.',
  );

  readonly members = iamResource<IamMember[]>(
    () => this.iam.members().pipe(catchError(() => of([] as IamMember[]))),
    [],
  );
  readonly sessions = iamResource<IamSession[]>(
    () => this.iam.mySessions().pipe(catchError(() => of([] as IamSession[]))),
    [],
  );
  protected readonly ago = (utc: string) => ago(utc);
  protected readonly when = when;
  protected readonly label = memberLabel;
  readonly tiles = computed<StatTile[]>(() => {
    const p = this.policy.value();
    const ms = this.members.value().filter((m) => m.status === 'Active');
    const idp = ms.filter((m) => m.signsInWithIdentityProvider).length;
    return [
      {
        label: 'Second factor',
        value: !p ? '…' : p.mfaRequired ? 'Required' : 'Optional',
        caption: p?.mfaRequired ? 'every member, at sign-in' : 'members choose for themselves',
        tone: !p ? null : p.mfaRequired ? 'good' : 'warn',
      },
      {
        label: 'Session limits',
        value: p ? `${p.sessionIdleMinutes} min · ${p.sessionAbsoluteHours} h` : '…',
        caption: 'idle sign-out · longest session',
      },
      {
        label: 'Allowed networks',
        value: !p ? '…' : p.ipAllowlist.length ? String(p.ipAllowlist.length) : 'Any',
        caption: p?.ipAllowlist.length ? 'ranges members may work from' : 'no address restriction',
      },
      {
        label: 'Active members via identity provider',
        value: this.members.loaded() ? `${idp} of ${ms.length}` : '…',
        caption: 'the sessions this policy governs',
        route: '/iam/members',
      },
      {
        label: 'Your open sessions',
        value: this.sessions.loaded() ? String(this.sessions.value().length) : '…',
        caption: plural(this.sessions.value().length, 'console session') + ' signed in as you',
        route: '/account/sessions',
      },
    ];
  });

  readonly mfaRequired = signal(false);
  readonly idleMinutes = signal(60);
  readonly absoluteHours = signal(12);
  readonly allowText = signal('');
  readonly allow = computed(() => parseAllowlist(this.allowText()));
  readonly draft = computed<SecurityPolicy>(() => ({
    mfaRequired: this.mfaRequired(),
    sessionIdleMinutes: this.idleMinutes(),
    sessionAbsoluteHours: this.absoluteHours(),
    ipAllowlist: this.allow().entries,
  }));
  readonly problems = computed(() => [
    ...securityPolicyErrors(this.draft()),
    ...this.allow().errors,
  ]);
  readonly dirty = computed(() => {
    const p = this.policy.value();
    return !p || JSON.stringify(normalised(p)) !== JSON.stringify(normalised(this.draft()));
  });
  readonly summary = computed(() => {
    const d = this.draft();
    const parts = [
      d.mfaRequired
        ? 'A second factor will be required to sign in.'
        : 'A second factor will not be required.',
      `Sessions end after ${d.sessionIdleMinutes} idle minutes and at most ${d.sessionAbsoluteHours} hours.`,
      d.ipAllowlist.length
        ? `Only ${d.ipAllowlist.length} network(s) may sign in.`
        : 'Any network may sign in.',
    ];
    return parts.join(' ');
  });

  readonly confirming = signal(false);
  readonly busy = signal(false);

  constructor() {
    // Fill the form whenever a policy arrives (first load, reload, after saving).
    effect(() => {
      const p = this.policy.value();
      if (p) untracked(() => this.fill(p));
    });
    this.load();
  }

  load(): void {
    this.policy.reload();
    this.members.reload();
    this.sessions.reload();
  }

  private fill(p: SecurityPolicy): void {
    this.mfaRequired.set(!!p.mfaRequired);
    this.idleMinutes.set(p.sessionIdleMinutes);
    this.absoluteHours.set(p.sessionAbsoluteHours);
    this.allowText.set((p.ipAllowlist ?? []).join('\n'));
  }

  review(): void {
    if (this.problems().length || this.busy() || !this.dirty()) return;
    this.confirming.set(true);
  }

  save(): void {
    if (this.busy()) return;
    const body = this.draft();
    this.busy.set(true);
    this.iam.saveSecurityPolicy(body).subscribe({
      next: () => {
        this.busy.set(false);
        this.confirming.set(false);
        this.notify.success('Security policy saved.');
        this.load();
      },
      error: (e) => {
        this.busy.set(false);
        this.confirming.set(false);
        if (reportable(e)) this.notify.error(errorText(e, 'The policy was not saved.'));
      },
    });
  }
}

/** Only the editable fields: the read-only `updatedAt…` fields must not make an untouched form look changed. */
function normalised(p: SecurityPolicy): SecurityPolicy {
  return {
    mfaRequired: !!p.mfaRequired,
    sessionIdleMinutes: p.sessionIdleMinutes,
    sessionAbsoluteHours: p.sessionAbsoluteHours,
    ipAllowlist: [...(p.ipAllowlist ?? [])].sort(),
  };
}
