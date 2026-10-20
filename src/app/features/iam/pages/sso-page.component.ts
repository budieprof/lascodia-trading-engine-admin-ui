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

import { Permission } from '@core/auth/permissions.generated';
import { NotificationService } from '@core/notifications/notification.service';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { IamApiService } from '../iam-api.service';
import { errorText, reportable, ssoErrors, when } from '../iam.logic';
import type { SaveSsoBody, ScimToken, SsoConfig, SsoProtocol } from '../iam.types';
import { iamResource } from '../shared/iam-resource';
import { MfaHintComponent } from '../shared/mfa-hint.component';
import { SecretOnceComponent } from '../shared/secret-once.component';

/**
 * Single sign-on for the organisation (U3.4, contract C3.5): an OIDC or SAML identity provider in
 * Keycloak, picked at sign-in by the e-mail domain. The client secret is write-only — the engine
 * never returns it; leaving the field empty keeps the stored one. SCIM provisioning tokens (shown
 * once) let the organisation's directory create and remove members. Both need `iam.sso.manage`.
 */
@Component({
  selector: 'app-iam-sso-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, PageHeaderComponent, ConfirmDialogComponent, MfaHintComponent, SecretOnceComponent],
  styleUrl: '../shared/iam-page.scss',
  template: `
    <div class="page">
      <app-page-header
        title="Single sign-on"
        subtitle="Let members sign in with your organisation's identity provider, and provision them from your directory."
      />

      <section class="card">
        <header class="card-head">
          <h3>Identity provider</h3>
          @if (config.value()?.enabled) {
            <span class="chip ok">On</span>
          } @else {
            <span class="chip">Off</span>
          }
          <span class="spacer"></span>
          <app-mfa-hint [permission]="P.IamSsoManage" />
        </header>
        @if (config.error(); as err) {
          <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
        } @else {
          <form class="card-body" (ngSubmit)="review()">
            <div class="row">
              <label class="check"><input type="radio" name="protocol" value="oidc" [ngModel]="protocol()" (ngModelChange)="protocol.set($event)" /> OpenID Connect</label>
              <label class="check"><input type="radio" name="protocol" value="saml" [ngModel]="protocol()" (ngModelChange)="protocol.set($event)" /> SAML 2.0</label>
            </div>
            <div class="form-grid">
              <label class="field">
                <span class="label">Name on the sign-in page</span>
                <input class="input" name="displayName" [ngModel]="displayName()" (ngModelChange)="displayName.set($event)" placeholder="e.g. Acme Okta" />
              </label>
              <label class="field">
                <span class="label">{{ protocol() === 'oidc' ? 'Issuer URL' : 'Metadata URL' }}</span>
                <input class="input" type="url" name="issuer" [ngModel]="issuer()" (ngModelChange)="issuer.set($event)" placeholder="https://" />
              </label>
              @if (protocol() === 'oidc') {
                <label class="field">
                  <span class="label">Client id</span>
                  <input class="input" name="clientId" autocomplete="off" [ngModel]="clientId()" (ngModelChange)="clientId.set($event)" />
                </label>
                <label class="field">
                  <span class="label">Client secret {{ hasSecret() ? '(stored — leave empty to keep it)' : '' }}</span>
                  <input class="input" type="password" name="clientSecret" autocomplete="new-password" [ngModel]="clientSecret()" (ngModelChange)="clientSecret.set($event)" />
                </label>
              }
            </div>
            <label class="field">
              <span class="label">E-mail domains that sign in here — one per line</span>
              <textarea class="textarea" name="domains" rows="3" spellcheck="false" [ngModel]="domainsText()" (ngModelChange)="domainsText.set($event)" placeholder="acme.com"></textarea>
            </label>
            <label class="check">
              <input type="checkbox" name="enabled" [ngModel]="enabled()" (ngModelChange)="enabled.set($event)" />
              Send people with these e-mail domains to this identity provider
            </label>
            @if (submitted() && problems().length) {
              <ul class="errors" role="alert">
                @for (e of problems(); track e) {
                  <li>{{ e }}</li>
                }
              </ul>
            }
            <div class="actions-row">
              <button type="submit" class="btn btn-primary" [disabled]="busy()">{{ busy() ? 'Saving…' : 'Save' }}</button>
            </div>
          </form>
        }
      </section>

      <section class="card">
        <header class="card-head">
          <h3>Directory provisioning (SCIM)</h3>
          <span class="spacer"></span>
          <input class="input search" name="scimName" placeholder="Token name, e.g. Azure AD" [ngModel]="scimName()" (ngModelChange)="scimName.set($event)" aria-label="Token name" />
          <button type="button" class="btn btn-sm btn-primary" [disabled]="busy() || !scimName().trim()" (click)="createScim()">Create token</button>
        </header>
        <div class="card-body">
          <p class="note">
            Your directory calls <code>/scim/v2</code> with this token to add, update and remove members of this organisation.
          </p>
          @if (newScim(); as t) {
            <app-secret-once title="SCIM token — paste it into your directory" [value]="t" (dismissed)="newScim.set(null)" />
          }
        </div>
        @if (scim.error(); as err) {
          <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
        } @else if (scim.value().length > 0) {
          <table class="grid">
            <thead>
              <tr>
                <th>Token</th>
                <th>Created</th>
                <th>Last used</th>
                <th>Expires</th>
                <th><span class="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              @for (t of scim.value(); track t.id) {
                <tr>
                  <td>{{ t.name || 'Token' }} <span class="sub"><code>{{ t.prefix }}…</code></span></td>
                  <td class="small">{{ when(t.createdAtUtc) }}</td>
                  <td class="small">{{ t.lastUsedAtUtc ? when(t.lastUsedAtUtc) : 'Never' }}</td>
                  <td class="small">{{ t.expiresAtUtc ? when(t.expiresAtUtc) : 'Never' }}</td>
                  <td class="actions">
                    <button type="button" class="btn btn-sm btn-danger" (click)="revokingScim.set(t)">Revoke</button>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        }
      </section>

      <app-confirm-dialog
        [open]="confirming()"
        title="Save single sign-on?"
        [message]="enabled() ? 'People with these e-mail domains will be sent to ' + displayName() + ' to sign in, from their next sign-in.' : 'The connection is saved switched off: nobody is sent to it yet.'"
        confirmLabel="Save"
        [loading]="busy()"
        (confirm)="save()"
        (cancelled)="confirming.set(false)"
      />
      <app-confirm-dialog
        [open]="revokingScim() !== null"
        [title]="'Revoke ' + (revokingScim()?.name || 'this SCIM token') + '?'"
        message="Your directory can no longer provision members with it."
        confirmLabel="Revoke"
        confirmVariant="destructive"
        [loading]="busy()"
        (confirm)="revokeScim()"
        (cancelled)="revokingScim.set(null)"
      />
    </div>
  `,
})
export class SsoPageComponent {
  private readonly iam = inject(IamApiService);
  private readonly notify = inject(NotificationService);

  protected readonly P = Permission;
  protected readonly when = when;

  readonly config = iamResource<SsoConfig | null>(() => this.iam.sso(), null, 'Could not load the single sign-on settings.');
  readonly scim = iamResource(() => this.iam.scimTokens(), [] as ScimToken[], 'Could not load SCIM tokens.');

  readonly protocol = signal<SsoProtocol>('oidc');
  readonly displayName = signal('');
  readonly issuer = signal('');
  readonly clientId = signal('');
  readonly clientSecret = signal('');
  readonly domainsText = signal('');
  readonly enabled = signal(false);
  readonly hasSecret = computed(() => !!this.config.value()?.hasClientSecret);
  readonly draft = computed<SaveSsoBody>(() => ({
    protocol: this.protocol(),
    displayName: this.displayName().trim(),
    issuerOrMetadataUrl: this.issuer().trim(),
    clientId: this.protocol() === 'oidc' ? this.clientId().trim() : '',
    // Write-only: omitted (null) keeps the stored secret.
    clientSecret: this.protocol() === 'oidc' && this.clientSecret().trim() ? this.clientSecret().trim() : null,
    domains: [...new Set(this.domainsText().split(/[\s,]+/).map((d) => d.trim().toLowerCase()).filter(Boolean))],
    enabled: this.enabled(),
  }));
  readonly problems = computed(() => ssoErrors(this.draft(), this.hasSecret()));
  readonly submitted = signal(false);
  readonly confirming = signal(false);
  readonly busy = signal(false);

  readonly scimName = signal('');
  readonly newScim = signal<string | null>(null);
  readonly revokingScim = signal<ScimToken | null>(null);

  constructor() {
    effect(() => {
      const c = this.config.value();
      if (c) untracked(() => this.fill(c));
    });
    this.config.reload();
    this.scim.reload();
  }

  private fill(c: SsoConfig): void {
    this.protocol.set(c.protocol === 'saml' ? 'saml' : 'oidc');
    this.displayName.set(c.displayName ?? '');
    this.issuer.set(c.issuerOrMetadataUrl ?? '');
    this.clientId.set(c.clientId ?? '');
    this.clientSecret.set('');
    this.domainsText.set((c.domains ?? []).join('\n'));
    this.enabled.set(!!c.enabled);
  }

  review(): void {
    this.submitted.set(true);
    if (this.problems().length || this.busy()) return;
    this.confirming.set(true);
  }

  save(): void {
    if (this.busy()) return;
    this.busy.set(true);
    this.iam.saveSso(this.draft()).subscribe({
      next: () => {
        this.busy.set(false);
        this.confirming.set(false);
        this.submitted.set(false);
        this.notify.success('Single sign-on saved.');
        this.config.reload();
      },
      error: (e) => {
        this.busy.set(false);
        this.confirming.set(false);
        if (reportable(e)) this.notify.error(errorText(e, 'Single sign-on was not saved.'));
      },
    });
  }

  createScim(): void {
    const name = this.scimName().trim();
    if (!name || this.busy()) return;
    this.busy.set(true);
    this.iam.createScimToken(name).subscribe({
      next: (t) => {
        this.busy.set(false);
        this.scimName.set('');
        this.newScim.set(t?.token ?? null);
        this.scim.reload();
      },
      error: (e) => {
        this.busy.set(false);
        if (reportable(e)) this.notify.error(errorText(e, 'The token was not created.'));
      },
    });
  }

  revokeScim(): void {
    const t = this.revokingScim();
    if (!t || this.busy()) return;
    this.busy.set(true);
    this.iam.revokeScimToken(t.id).subscribe({
      next: () => {
        this.busy.set(false);
        this.revokingScim.set(null);
        this.notify.success('SCIM token revoked.');
        this.scim.reload();
      },
      error: (e) => {
        this.busy.set(false);
        this.revokingScim.set(null);
        if (reportable(e)) this.notify.error(errorText(e, 'The token was not revoked.'));
      },
    });
  }
}
