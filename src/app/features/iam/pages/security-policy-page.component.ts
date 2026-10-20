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
import { errorText, parseAllowlist, reportable, securityPolicyErrors } from '../iam.logic';
import type { SecurityPolicy } from '../iam.types';
import { iamResource } from '../shared/iam-resource';
import { MfaHintComponent } from '../shared/mfa-hint.component';

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
  imports: [FormsModule, PageHeaderComponent, ConfirmDialogComponent, MfaHintComponent],
  styleUrl: '../shared/iam-page.scss',
  template: `
    <div class="page">
      <app-page-header
        title="Security policy"
        subtitle="How members of this organisation sign in. Changes apply to new requests at once."
      >
        <button type="button" class="btn btn-secondary" (click)="load()" [disabled]="policy.loading()">
          {{ policy.loading() ? 'Loading…' : 'Reload' }}
        </button>
      </app-page-header>

      @if (policy.error(); as err) {
        <section class="card"><p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p></section>
      } @else if (policy.loaded()) {
        <section class="card">
          <header class="card-head">
            <h3>Policy</h3>
            <span class="spacer"></span>
            <app-mfa-hint [permission]="P.IamSecurityManage" />
          </header>
          <form class="card-body" (ngSubmit)="review()">
            <label class="check">
              <input type="checkbox" name="mfa" [ngModel]="mfaRequired()" (ngModelChange)="mfaRequired.set($event)" />
              Require a second factor (authenticator app or security key) to sign in
            </label>
            <div class="form-grid">
              <label class="field">
                <span class="label">Sign out after this many idle minutes</span>
                <input class="input" type="number" min="1" step="1" name="idle" [ngModel]="idleMinutes()" (ngModelChange)="idleMinutes.set(+$event)" />
              </label>
              <label class="field">
                <span class="label">End every session after this many hours</span>
                <input class="input" type="number" min="1" step="1" name="absolute" [ngModel]="absoluteHours()" (ngModelChange)="absoluteHours.set(+$event)" />
              </label>
            </div>
            <label class="field">
              <span class="label">Allowed networks — one per line (leave empty to allow any network)</span>
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
                Only these networks may sign in: {{ allow().entries.join(', ') }}. Make sure the network you are on now is one
                of them, or you will be signed out and refused.
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
              <button type="submit" class="btn btn-primary" [disabled]="busy() || problems().length > 0 || !dirty()">
                {{ busy() ? 'Saving…' : 'Save policy' }}
              </button>
            </div>
          </form>
        </section>
      }

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

  readonly policy = iamResource<SecurityPolicy | null>(() => this.iam.securityPolicy(), null, 'Could not load the policy.');

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
  readonly problems = computed(() => [...securityPolicyErrors(this.draft()), ...this.allow().errors]);
  readonly dirty = computed(() => {
    const p = this.policy.value();
    return !p || JSON.stringify(normalised(p)) !== JSON.stringify(normalised(this.draft()));
  });
  readonly summary = computed(() => {
    const d = this.draft();
    const parts = [
      d.mfaRequired ? 'A second factor will be required to sign in.' : 'A second factor will not be required.',
      `Sessions end after ${d.sessionIdleMinutes} idle minutes and at most ${d.sessionAbsoluteHours} hours.`,
      d.ipAllowlist.length ? `Only ${d.ipAllowlist.length} network(s) may sign in.` : 'Any network may sign in.',
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

function normalised(p: SecurityPolicy): SecurityPolicy {
  return { ...p, ipAllowlist: [...(p.ipAllowlist ?? [])].sort() };
}
