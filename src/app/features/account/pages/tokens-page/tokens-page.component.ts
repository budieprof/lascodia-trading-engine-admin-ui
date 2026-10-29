import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { AuthService } from '@core/auth/auth.service';
import {
  PERMISSION_CATALOG,
  Permission,
  type PermissionDefinition,
} from '@core/auth/permissions.generated';
import { NotificationService } from '@core/notifications/notification.service';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { IamApiService } from '@features/iam/iam-api.service';
import {
  MAX_TOKEN_DAYS,
  errorText,
  groupCatalog,
  reportable,
  toggled,
  tokenErrors,
  when,
} from '@features/iam/iam.logic';
import type { PersonalAccessToken } from '@features/iam/iam.types';
import { iamResource } from '@features/iam/shared/iam-resource';
import { MfaHintComponent } from '@features/iam/shared/mfa-hint.component';
import { SecretOnceComponent } from '@features/iam/shared/secret-once.component';
import { ago, countBy } from '@features/iam/shared/admin-context.logic';
import { AuditTrailComponent } from '@features/iam/shared/audit-trail.component';
import { StatTilesComponent, type StatTile } from '@features/iam/shared/stat-tiles.component';

const LIFETIMES = [7, 30, 90, 180, MAX_TOKEN_DAYS];

/**
 * Personal access tokens (U3.5, ADR-0030 §6, contract C3.5): for scripts and tools that call the
 * engine as you. A token works only in this organisation and only with the permissions chosen —
 * never more than you hold yourself (the engine evaluates "you ∩ the token" on every call). The
 * token is shown once. Creating one needs `iam.tokens.create`, a step-up key.
 */
@Component({
  selector: 'app-account-tokens-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    PageHeaderComponent,
    ConfirmDialogComponent,
    MfaHintComponent,
    SecretOnceComponent,
    StatTilesComponent,
    AuditTrailComponent,
  ],
  styleUrl: '../../../iam/shared/iam-page.scss',
  template: `
    <div class="page">
      <app-page-header
        title="Access tokens"
        subtitle="Tokens for scripts and tools that call the engine as you, in this organisation only."
      >
        <button
          type="button"
          class="btn btn-secondary"
          (click)="tokens.reload()"
          [disabled]="tokens.loading()"
        >
          {{ tokens.loading() ? 'Loading…' : 'Refresh' }}
        </button>
      </app-page-header>

      <app-stat-tiles [tiles]="tiles()" label="Access tokens summary" />

      <section class="card">
        <header class="card-head">
          <h3>New token</h3>
          <span class="spacer"></span>
          <app-mfa-hint [permission]="P.IamTokensCreate" />
        </header>
        <form class="card-body" (ngSubmit)="create()">
          @if (created(); as t) {
            <app-secret-once
              title="Your new token"
              [value]="t"
              warning="Copy it now and keep it like a password: it will not be shown again. Send it as a Bearer token in the Authorization header."
              (dismissed)="created.set(null)"
            />
          }
          <div class="form-grid">
            <label class="field">
              <span class="label">Name — what will use it</span>
              <input
                class="input"
                name="name"
                maxlength="80"
                [ngModel]="name()"
                (ngModelChange)="name.set($event)"
                placeholder="e.g. Nightly P&L export"
              />
            </label>
            <label class="field">
              <span class="label">Expires after</span>
              <select
                class="select"
                name="days"
                [ngModel]="days()"
                (ngModelChange)="days.set(+$event)"
              >
                @for (d of lifetimes; track d) {
                  <option [ngValue]="d">{{ d }} days</option>
                }
              </select>
            </label>
          </div>
          <fieldset class="matrix">
            <legend class="label">
              Permissions · {{ chosen().size }} selected (only ones you hold are offered)
            </legend>
            @for (g of groups(); track g.category) {
              <div>
                <span class="matrix-cat">{{ g.category }}</span>
                <div class="matrix-checks">
                  @for (p of g.permissions; track p.key) {
                    <label class="check" [title]="p.description">
                      <input
                        type="checkbox"
                        [checked]="chosen().has(p.key)"
                        (change)="toggle(p.key)"
                      />
                      <span>{{ p.key }}</span>
                    </label>
                  }
                </div>
              </div>
            } @empty {
              <p class="muted small">You hold no permissions a token could carry.</p>
            }
          </fieldset>
          @if (submitted() && errors().length) {
            <ul class="errors" role="alert">
              @for (e of errors(); track e) {
                <li>{{ e }}</li>
              }
            </ul>
          }
          <div class="actions-row">
            <button type="submit" class="btn btn-primary" [disabled]="busy()">
              {{ busy() ? 'Creating…' : 'Create token' }}
            </button>
          </div>
        </form>
      </section>

      <section class="card">
        <header class="card-head"><h3>Your tokens</h3></header>
        @if (tokens.error(); as err) {
          <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
        } @else if (tokens.loaded() && tokens.value().length === 0) {
          <p class="pad small muted">
            You have no access tokens. A token lets a script call the engine as you with only the
            permissions you tick (never more than you hold), in this organisation only, for at most
            365 days; it is shown once when created. Revoke it here the moment it is not needed.
          </p>
        } @else if (tokens.value().length > 0) {
          <div class="table-wrap">
            <table class="grid">
              <thead>
                <tr>
                  <th>Token</th>
                  <th>Permissions</th>
                  <th>Created</th>
                  <th>Last used</th>
                  <th>Expires</th>
                  <th><span class="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                @for (t of tokens.value(); track t.id) {
                  <tr>
                    <td>
                      {{ t.name }}
                      <span class="sub"
                        ><code>lsc_pat_{{ t.prefix }}…</code></span
                      >
                    </td>
                    <td class="small">{{ t.permissions.join(', ') }}</td>
                    <td class="small">{{ when(t.createdAtUtc) }}</td>
                    <td class="small">{{ t.lastUsedAtUtc ? when(t.lastUsedAtUtc) : 'Never' }}</td>
                    <td class="small">
                      {{ when(t.expiresAtUtc) }}
                      @if (t.status && t.status !== 'Active') {
                        <span class="chip">{{ t.status }}</span>
                      }
                    </td>
                    <td class="actions">
                      @if (!t.status || t.status === 'Active') {
                        <button
                          type="button"
                          class="btn btn-sm btn-danger"
                          [disabled]="busy()"
                          (click)="revoking.set(t)"
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
        }
      </section>

      <app-confirm-dialog
        [open]="revoking() !== null"
        [title]="'Revoke ' + (revoking()?.name ?? 'this token') + '?'"
        message="Anything using it is refused from now on."
        confirmLabel="Revoke"
        confirmVariant="destructive"
        [loading]="busy()"
        (confirm)="revoke()"
        (cancelled)="revoking.set(null)"
      />

      @if (actorId()) {
        <app-audit-trail
          heading="Your token activity"
          [actions]="['iam.token.']"
          [actor]="actorId()"
          empty="You have never created or revoked an access token."
        />
      }
    </div>
  `,
})
export class TokensPageComponent {
  private readonly iam = inject(IamApiService);
  private readonly auth = inject(AuthService);
  private readonly notify = inject(NotificationService);

  protected readonly P = Permission;
  protected readonly when = when;
  protected readonly lifetimes = LIFETIMES;

  readonly tokens = iamResource(
    () => this.iam.myTokens(),
    [] as PersonalAccessToken[],
    'Could not load your tokens.',
  );
  private readonly held = computed(() => new Set(this.auth.permissions()));
  /** Only what the session holds can go on a token (deprecated tier keys are not offered). */
  readonly groups = computed(() =>
    groupCatalog(
      PERMISSION_CATALOG.filter(
        (p: PermissionDefinition) => this.held().has(p.key) && !p.deprecated,
      ),
    ),
  );

  readonly name = signal('');
  readonly days = signal(90);
  readonly chosen = signal<Set<string>>(new Set());
  readonly submitted = signal(false);
  readonly errors = computed(() =>
    tokenErrors(this.name(), [...this.chosen()], this.days(), this.held()),
  );
  readonly busy = signal(false);
  readonly created = signal<string | null>(null);
  readonly revoking = signal<PersonalAccessToken | null>(null);

  readonly actorId = computed(() => {
    const id = this.auth.user()?.passportId;
    return id ? `admin-user:${id}` : null;
  });
  readonly tiles = computed<StatTile[]>(() => {
    const list = this.tokens.value();
    const c = countBy(list, (t) => t.status ?? 'Active');
    const used =
      list
        .map((t) => t.lastUsedAtUtc ?? '')
        .sort()
        .at(-1) || null;
    const next = list
      .filter((t) => (t.status ?? 'Active') === 'Active')
      .map((t) => t.expiresAtUtc)
      .sort()[0];
    return [
      {
        label: 'Active tokens',
        value: this.tokens.loaded() ? String(c['Active'] ?? 0) : '…',
        caption: `${c['Revoked'] ?? 0} revoked · ${c['Expired'] ?? 0} expired`,
      },
      {
        label: 'Last used',
        value: used ? ago(used) : 'Never',
        caption: 'by any of your tokens',
      },
      {
        label: 'Next to expire',
        value: next ? ago(next) : '—',
        caption: next ? new Date(next).toLocaleDateString() : 'no active token',
      },
      {
        label: 'Permissions you could give',
        value: String(this.auth.permissions().length),
        caption: 'a token never holds more than you',
      },
    ];
  });

  constructor() {
    this.tokens.reload();
  }

  toggle(key: string): void {
    this.chosen.update((s) => toggled(s, key));
  }

  create(): void {
    this.submitted.set(true);
    if (this.errors().length || this.busy()) return;
    this.busy.set(true);
    this.iam
      .createMyToken({
        name: this.name().trim(),
        permissions: [...this.chosen()].sort(),
        expiresInDays: this.days(),
      })
      .subscribe({
        next: (t) => {
          this.busy.set(false);
          this.submitted.set(false);
          this.created.set(t?.token ?? null);
          this.name.set('');
          this.chosen.set(new Set());
          this.tokens.reload();
        },
        error: (e) => {
          this.busy.set(false);
          if (reportable(e)) this.notify.error(errorText(e, 'The token was not created.'));
        },
      });
  }

  revoke(): void {
    const t = this.revoking();
    if (!t || this.busy()) return;
    this.busy.set(true);
    this.iam.revokeMyToken(t.id).subscribe({
      next: () => {
        this.busy.set(false);
        this.revoking.set(null);
        this.notify.success(`${t.name} revoked.`);
        this.tokens.reload();
      },
      error: (e) => {
        this.busy.set(false);
        this.revoking.set(null);
        if (reportable(e)) this.notify.error(errorText(e, 'The token was not revoked.'));
      },
    });
  }
}
