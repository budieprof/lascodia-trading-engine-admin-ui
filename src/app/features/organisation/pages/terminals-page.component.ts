import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { LscCanDirective } from '@core/auth/can.directive';
import { Permission } from '@core/auth/permissions.generated';
import { NotificationService } from '@core/notifications/notification.service';
import { AccountScopeService } from '@core/scope/account-scope.service';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { when } from '@features/iam/iam.logic';
import { iamResource } from '@features/iam/shared/iam-resource';
import { MfaHintComponent } from '@features/iam/shared/mfa-hint.component';
import { SecretOnceComponent } from '@features/iam/shared/secret-once.component';
import { OrganisationApiService } from '../organisation-api.service';
import { failureMessage } from '../organisation.logic';
import type {
  EnrollmentToken,
  EnrollmentTokenCreated,
  MachineCredential,
  MachineKind,
} from '../organisation.types';
import {
  LABEL_MAX,
  LOGIN_MAX,
  MIN_EA_VERSION,
  REVOKE_REASON_MAX,
  SERVER_MAX,
  accountLabel,
  accountRefs,
  boundTo,
  credentialState,
  emptyEnrollmentDraft,
  enrollmentBody,
  enrollmentErrors,
  enrollmentSteps,
  groupCredentials,
  kindLabel,
  originLabel,
  sinceText,
  type BindingMode,
  type EnrollmentDraft,
} from '../terminals.logic';

/**
 * Connect a terminal (multi-tenancy Phase 7, T7.1; engine `MachineController`, EA ADR-0017). Every
 * EA instance and every MT5 supervisor holds its own credential: a person creates a single-use
 * enrollment token (shown once), the machine exchanges it for its credential, and the credential is
 * listed here with its last use until someone revokes or rotates it. Creating a token and revoking
 * or rotating a credential need `accounts.connect` (step-up); revoking an unused token
 * `accounts.manage`.
 */
@Component({
  selector: 'app-org-terminals-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    RouterLink,
    LscCanDirective,
    PageHeaderComponent,
    ConfirmDialogComponent,
    MfaHintComponent,
    SecretOnceComponent,
  ],
  styleUrl: '../../iam/shared/iam-page.scss',
  styles: [
    `
      .steps {
        margin: 0;
        padding-left: var(--space-5);
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
        font-size: var(--text-sm);
      }
      .steps pre {
        margin: var(--space-1) 0 0;
        padding: 6px 8px;
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        border: 1px solid var(--border);
        font-size: var(--text-xs);
        white-space: pre-wrap;
        word-break: break-all;
        user-select: all;
      }
      .kinds {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-4);
      }
      .group-title {
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        color: var(--text-secondary);
        background: var(--bg-tertiary);
      }
    `,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Connect a terminal"
        subtitle="Every EA and every supervisor has its own credential. Create a token to connect one, and revoke what you no longer trust."
      >
        <a class="btn btn-primary" routerLink="/organisation/terminals/connect">Guided connection</a>
        <button
          type="button"
          class="btn btn-secondary"
          (click)="reload()"
          [disabled]="tokens.loading() || credentials.loading()"
        >
          {{ tokens.loading() || credentials.loading() ? 'Loading…' : 'Refresh' }}
        </button>
      </app-page-header>

      <section class="card" *lscCan="P.AccountsConnect">
        <header class="card-head">
          <h3>New enrollment token</h3>
          <span class="spacer"></span>
          <app-mfa-hint [permission]="P.AccountsConnect" />
        </header>
        @if (created(); as c) {
          <div class="card-body">
            <app-secret-once
              [title]="'Enrollment token — ' + c.label"
              [value]="c.token"
              warning="Copy it now: it is shown only this once. It works for one machine and expires in 24 hours."
              (dismissed)="created.set(null)"
            />
            <ol class="steps">
              @for (s of steps(); track $index) {
                <li>
                  {{ s.text }}
                  @if (s.code) {
                    <pre>{{ s.code }}</pre>
                  }
                </li>
              }
            </ol>
          </div>
        } @else {
          <form class="card-body" (ngSubmit)="create()">
            <p class="note">
              A token is used once: the machine exchanges it for its own credential and then signs
              in with that. EAs need version {{ minEa }} or later. A terminal launched by an
              enrolled supervisor daemon enrolls itself, without a token.
            </p>
            <div class="kinds" role="radiogroup" aria-label="What are you connecting?">
              <label class="check">
                <input
                  type="radio"
                  name="kind"
                  value="EaTerminal"
                  [ngModel]="draft().kind"
                  (ngModelChange)="setKind($event)"
                />
                An EA on a chart
              </label>
              <label class="check">
                <input
                  type="radio"
                  name="kind"
                  value="Daemon"
                  [ngModel]="draft().kind"
                  (ngModelChange)="setKind($event)"
                />
                A supervisor daemon (launches terminals)
              </label>
            </div>
            <div class="form-grid">
              <label class="field">
                <span class="label">Label</span>
                <input
                  class="input"
                  name="label"
                  [maxlength]="labelMax"
                  placeholder="e.g. mac2 — EURUSD H1 chart"
                  [ngModel]="draft().label"
                  (ngModelChange)="patch({ label: $event })"
                />
              </label>
              @if (draft().kind === 'EaTerminal') {
                <label class="field">
                  <span class="label">Which account may it connect?</span>
                  <select
                    class="select"
                    name="binding"
                    [ngModel]="draft().binding"
                    (ngModelChange)="setBinding($event)"
                  >
                    <option value="any">Any account of this organisation</option>
                    <option value="account">One account listed here</option>
                    <option value="login">A broker login not listed yet</option>
                  </select>
                </label>
                @if (draft().binding === 'account') {
                  <label class="field">
                    <span class="label">Account</span>
                    <select
                      class="select"
                      name="account"
                      [ngModel]="draft().tradingAccountId"
                      (ngModelChange)="
                        patch({ tradingAccountId: $event === null ? null : +$event })
                      "
                    >
                      <option [ngValue]="null">Choose…</option>
                      @for (a of accounts(); track a.id) {
                        <option [ngValue]="a.id">{{ accountLabel(a) }}</option>
                      }
                    </select>
                  </label>
                }
                @if (draft().binding === 'login') {
                  <label class="field">
                    <span class="label">Broker login</span>
                    <input
                      class="input"
                      name="login"
                      inputmode="numeric"
                      [maxlength]="loginMax"
                      [ngModel]="draft().accountLogin"
                      (ngModelChange)="patch({ accountLogin: $event })"
                    />
                  </label>
                  <label class="field">
                    <span class="label">Broker server</span>
                    <input
                      class="input"
                      name="server"
                      [maxlength]="serverMax"
                      placeholder="e.g. Exness-MT5Trial9"
                      [ngModel]="draft().brokerServer"
                      (ngModelChange)="patch({ brokerServer: $event })"
                    />
                  </label>
                }
              }
            </div>
            @if (submitted() && problems().length) {
              <ul class="errors" role="alert">
                @for (e of problems(); track e) {
                  <li>{{ e }}</li>
                }
              </ul>
            }
            <div class="actions-row">
              <button type="submit" class="btn btn-primary" [disabled]="busy()">
                {{ busy() ? 'Creating…' : 'Create enrollment token' }}
              </button>
            </div>
          </form>
        }
      </section>

      <section class="card">
        <header class="card-head">
          <h3>Enrollment tokens</h3>
          <span class="spacer"></span>
          <label class="check small">
            <input
              type="checkbox"
              name="allTokens"
              [ngModel]="showAllTokens()"
              (ngModelChange)="toggleAllTokens($event)"
            />
            Show used, expired and revoked
          </label>
        </header>
        @if (tokens.error(); as err) {
          <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
        }
        @if (tokens.value().length) {
          <div class="table-wrap">
            <table class="grid">
              <thead>
                <tr>
                  <th>Label</th>
                  <th>For</th>
                  <th>Created</th>
                  <th>Expires</th>
                  <th>Status</th>
                  <th><span class="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                @for (t of tokens.value(); track t.id) {
                  <tr>
                    <td>
                      {{ t.label }}
                      <span class="sub"
                        >{{ kindLabel(t.kind) }} · <code>{{ t.prefix }}…</code></span
                      >
                    </td>
                    <td>{{ boundTo(t) }}</td>
                    <td>
                      {{ when(t.createdAtUtc) }}
                      <span class="sub">{{ t.createdBy }}</span>
                    </td>
                    <td>{{ when(t.expiresAtUtc) }}</td>
                    <td>
                      <span
                        class="chip"
                        [class.ok]="t.status === 'Used'"
                        [class.info]="t.status === 'Pending'"
                        [class.bad]="t.status === 'Revoked'"
                        >{{ t.status }}</span
                      >
                    </td>
                    <td class="actions">
                      @if (t.kind === 'EaTerminal' && (t.status === 'Pending' || t.status === 'Used')) {
                        <a
                          class="btn btn-sm btn-secondary"
                          routerLink="/organisation/terminals/connect"
                          [queryParams]="{ token: t.id }"
                          >Follow</a
                        >
                      }
                      @if (t.status === 'Pending') {
                        <button
                          *lscCan="P.AccountsManage"
                          type="button"
                          class="btn btn-sm btn-danger"
                          (click)="revokingToken.set(t)"
                        >
                          Revoke
                        </button>
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        } @else if (tokens.loaded() && !tokens.error()) {
          <p class="pad muted">
            {{ showAllTokens() ? 'No enrollment tokens yet.' : 'No token is waiting to be used.' }}
          </p>
        }
      </section>

      <section class="card">
        <header class="card-head">
          <h3>Machine credentials</h3>
          <span class="spacer"></span>
          <app-mfa-hint [permission]="P.AccountsConnect" />
          <label class="check small">
            <input
              type="checkbox"
              name="revoked"
              [ngModel]="showRevoked()"
              (ngModelChange)="toggleRevoked($event)"
            />
            Show revoked
          </label>
        </header>
        @if (credentials.error(); as err) {
          <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
        }
        @if (groups().length) {
          <div class="table-wrap">
            <table class="grid">
              <thead>
                <tr>
                  <th>Instance</th>
                  <th>How it got it</th>
                  <th>Created</th>
                  <th>Last used</th>
                  <th>State</th>
                  <th><span class="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                @for (g of groups(); track g.key) {
                  <tr>
                    <td colspan="6" class="group-title">{{ g.title }}</td>
                  </tr>
                  @for (c of g.credentials; track c.id) {
                    <tr>
                      <td>
                        <code>{{ c.instanceId }}</code>
                        <span class="sub">#{{ c.id }} · {{ kindLabel(c.kind) }}</span>
                      </td>
                      <td>{{ originLabel(c.origin) }}</td>
                      <td>
                        {{ when(c.createdAtUtc) }}
                        <span class="sub">{{ c.createdBy }}</span>
                      </td>
                      <td>
                        {{ since(c.lastUsedAtUtc) }}
                        @if (c.lastUsedIp) {
                          <span class="sub">from {{ c.lastUsedIp }}</span>
                        }
                      </td>
                      <td>
                        <span class="chip" [class]="credentialState(c).tone">{{
                          credentialState(c).label
                        }}</span>
                        @if (c.revokedAtUtc) {
                          <span class="sub">{{ when(c.revokedAtUtc) }}</span>
                        }
                      </td>
                      <td class="actions">
                        @if (!c.revokedAtUtc) {
                          <ng-container *lscCan="P.AccountsConnect">
                            <button
                              type="button"
                              class="btn btn-sm btn-secondary"
                              (click)="rotating.set(c)"
                            >
                              Rotate
                            </button>
                            <button
                              type="button"
                              class="btn btn-sm btn-danger"
                              (click)="startRevoke(c)"
                            >
                              Revoke
                            </button>
                          </ng-container>
                        }
                      </td>
                    </tr>
                  }
                }
              </tbody>
            </table>
          </div>
        } @else if (credentials.loaded() && !credentials.error()) {
          <p class="pad muted">No machine holds a credential of this organisation yet.</p>
        }
        <p class="note">
          Last use is sampled every few minutes. A revoked machine is refused within 30 seconds and
          needs a new enrollment token; rotating gives it a new secret on its next sign-in (within
          15 minutes).
        </p>
      </section>

      <app-confirm-dialog
        [open]="revokingToken() !== null"
        title="Revoke this enrollment token?"
        [message]="
          'The token “' +
          (revokingToken()?.label ?? '') +
          '” stops working at once. A machine that has not used it yet cannot connect with it.'
        "
        confirmLabel="Revoke token"
        confirmVariant="destructive"
        [loading]="busy()"
        (confirm)="revokeToken()"
        (cancelled)="revokingToken.set(null)"
      />

      <app-confirm-dialog
        [open]="revoking() !== null"
        title="Revoke this machine's credential?"
        [message]="
          (revoking()?.instanceId ?? '') +
          ' is refused within 30 seconds: it stops receiving signals and sending reports. Open positions stay with the broker. To connect it again, create a new enrollment token.'
        "
        confirmLabel="Revoke credential"
        confirmVariant="destructive"
        [loading]="busy()"
        (confirm)="revokeCredential()"
        (cancelled)="revoking.set(null)"
      >
        <label class="field">
          <span class="label">Reason (kept in the audit log)</span>
          <input
            class="input"
            name="revokeReason"
            [maxlength]="reasonMax"
            [ngModel]="revokeReason()"
            (ngModelChange)="revokeReason.set($event)"
          />
        </label>
      </app-confirm-dialog>

      <app-confirm-dialog
        [open]="rotating() !== null"
        title="Rotate this credential's secret?"
        [message]="
          (rotating()?.instanceId ?? '') +
          ' receives a new secret on its next sign-in (within 15 minutes); the old one stops when the new one is first used. If the secret may have leaked, revoke the credential instead.'
        "
        confirmLabel="Rotate"
        [loading]="busy()"
        (confirm)="rotateCredential()"
        (cancelled)="rotating.set(null)"
      />
    </div>
  `,
})
export class TerminalsPageComponent {
  private readonly api = inject(OrganisationApiService);
  private readonly notify = inject(NotificationService);
  private readonly scope = inject(AccountScopeService);

  protected readonly P = Permission;
  protected readonly when = when;
  protected readonly kindLabel = kindLabel;
  protected readonly originLabel = originLabel;
  protected readonly credentialState = credentialState;
  protected readonly accountLabel = accountLabel;
  protected readonly labelMax = LABEL_MAX;
  protected readonly loginMax = LOGIN_MAX;
  protected readonly serverMax = SERVER_MAX;
  protected readonly reasonMax = REVOKE_REASON_MAX;
  protected readonly minEa = MIN_EA_VERSION;

  readonly accounts = computed(() => accountRefs(this.scope.accounts()));
  private readonly accountsById = computed(() => new Map(this.accounts().map((a) => [a.id, a])));

  readonly showAllTokens = signal(false);
  readonly showRevoked = signal(false);

  readonly tokens = iamResource<EnrollmentToken[]>(
    () => this.api.enrollmentTokens(this.showAllTokens()),
    [],
    'Could not load the enrollment tokens.',
  );
  readonly credentials = iamResource<MachineCredential[]>(
    () => this.api.machineCredentials(this.showRevoked()),
    [],
    'Could not load the machine credentials.',
  );
  readonly groups = computed(() => groupCredentials(this.credentials.value(), this.accounts()));

  readonly draft = signal<EnrollmentDraft>(emptyEnrollmentDraft());
  readonly problems = computed(() => enrollmentErrors(this.draft()));
  readonly submitted = signal(false);
  readonly created = signal<EnrollmentTokenCreated | null>(null);
  readonly steps = computed(() => {
    const c = this.created();
    if (!c) return [];
    const bound =
      c.kind === 'EaTerminal' && (c.tradingAccountId || c.accountLogin) ? this.boundTo(c) : null;
    return enrollmentSteps(c, bound);
  });

  readonly busy = signal(false);
  readonly revokingToken = signal<EnrollmentToken | null>(null);
  readonly revoking = signal<MachineCredential | null>(null);
  readonly revokeReason = signal('');
  readonly rotating = signal<MachineCredential | null>(null);

  constructor() {
    this.reload();
  }

  reload(): void {
    this.tokens.reload();
    this.credentials.reload();
  }

  boundTo(t: Parameters<typeof boundTo>[0]): string {
    return boundTo(t, this.accountsById());
  }

  since(utc: string | null): string {
    return sinceText(utc);
  }

  patch(p: Partial<EnrollmentDraft>): void {
    this.draft.update((d) => ({ ...d, ...p }));
  }

  setKind(kind: MachineKind): void {
    this.patch({
      kind,
      binding: 'any',
      tradingAccountId: null,
      accountLogin: '',
      brokerServer: '',
    });
  }

  setBinding(binding: BindingMode): void {
    this.patch({ binding, tradingAccountId: null, accountLogin: '', brokerServer: '' });
  }

  toggleAllTokens(on: boolean): void {
    this.showAllTokens.set(on);
    this.tokens.reload();
  }

  toggleRevoked(on: boolean): void {
    this.showRevoked.set(on);
    this.credentials.reload();
  }

  create(): void {
    this.submitted.set(true);
    if (this.busy() || this.problems().length) return;
    this.busy.set(true);
    this.api.createEnrollmentToken(enrollmentBody(this.draft())).subscribe({
      next: (c) => {
        this.busy.set(false);
        this.created.set(c);
        this.draft.set(emptyEnrollmentDraft(this.draft().kind));
        this.submitted.set(false);
        this.tokens.reload();
      },
      error: (e) => {
        this.busy.set(false);
        const msg = failureMessage(e, 'The enrollment token was not created.');
        if (msg) this.notify.error(msg);
      },
    });
  }

  revokeToken(): void {
    const t = this.revokingToken();
    if (!t || this.busy()) return;
    this.busy.set(true);
    this.api.revokeEnrollmentToken(t.id).subscribe({
      next: () => {
        this.busy.set(false);
        this.revokingToken.set(null);
        this.notify.success(`Token “${t.label}” revoked.`);
        this.tokens.reload();
      },
      error: (e) => {
        this.busy.set(false);
        this.revokingToken.set(null);
        const msg = failureMessage(e, 'The token was not revoked.');
        if (msg) this.notify.error(msg);
        this.tokens.reload();
      },
    });
  }

  startRevoke(c: MachineCredential): void {
    this.revokeReason.set('');
    this.revoking.set(c);
  }

  revokeCredential(): void {
    const c = this.revoking();
    if (!c || this.busy()) return;
    this.busy.set(true);
    this.api.revokeCredential(c.id, this.revokeReason().trim() || null).subscribe({
      next: () => {
        this.busy.set(false);
        this.revoking.set(null);
        this.notify.success(`Credential of ${c.instanceId} revoked.`);
        this.credentials.reload();
      },
      error: (e) => {
        this.busy.set(false);
        this.revoking.set(null);
        const msg = failureMessage(e, 'The credential was not revoked.');
        if (msg) this.notify.error(msg);
      },
    });
  }

  rotateCredential(): void {
    const c = this.rotating();
    if (!c || this.busy()) return;
    this.busy.set(true);
    this.api.rotateCredential(c.id).subscribe({
      next: () => {
        this.busy.set(false);
        this.rotating.set(null);
        this.notify.success(`${c.instanceId} gets a new secret on its next sign-in.`);
        this.credentials.reload();
      },
      error: (e) => {
        this.busy.set(false);
        this.rotating.set(null);
        const msg = failureMessage(e, 'The rotation was not requested.');
        if (msg) this.notify.error(msg);
      },
    });
  }
}
