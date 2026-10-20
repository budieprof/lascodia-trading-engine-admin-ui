import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { NotificationService } from '@core/notifications/notification.service';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { ModalA11yDirective } from '@shared/directives/modal-a11y.directive';
import { errorText } from '@features/iam/iam.logic';
import { iamResource } from '@features/iam/shared/iam-resource';
import { OnboardingApiService } from '../onboarding-api.service';
import { canDecide, signupStatusLabel, signupTone } from '../onboarding.logic';
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
  imports: [DatePipe, FormsModule, PageHeaderComponent, ModalA11yDirective],
  styleUrls: ['../../iam/shared/iam-page.scss'],
  styles: [
    `
      .overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.4);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1000;
      }
      .dialog {
        background: var(--bg-primary);
        border-radius: var(--radius-lg);
        box-shadow: var(--shadow-lg);
        padding: var(--space-5);
        width: min(520px, calc(100vw - 32px));
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
    `,
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

      <section class="card">
        <header class="card-head"><h3>Self-serve sign-up</h3></header>
        <div class="card-body">
          @if (status.value(); as s) {
            @if (!s.enabled) {
              <p>
                <span class="chip">Off</span> Self-serve sign-up is off
                (<code>Tenancy:SelfServeSignup</code>). Organisations are created by platform staff.
              </p>
            } @else if (s.available) {
              <p>
                <span class="chip ok">On</span>
                {{
                  s.requiresApproval
                    ? 'Every new organisation waits for approval here.'
                    : 'Organisations are created as soon as the address is verified.'
                }}
                {{ s.pending }} waiting.
              </p>
            } @else {
              <p>
                <span class="chip bad">On, but not available</span> The public page answers that
                sign-up is not available, because:
              </p>
              <ul class="errors">
                @for (r of s.reasons; track r) {
                  <li>{{ r }}</li>
                }
              </ul>
            }
          } @else if (status.error(); as err) {
            <p role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
          }
        </div>
      </section>

      <section class="card">
        <header class="card-head">
          <h3>Requests</h3>
          <span class="spacer"></span>
          <label class="small">
            Show
            <select
              class="select"
              name="filter"
              [ngModel]="filter()"
              (ngModelChange)="filter.set($event); signups.reload()"
            >
              <option value="">All</option>
              <option value="Pending">Waiting</option>
              <option value="Approved">Approved</option>
              <option value="Provisioned">Created</option>
              <option value="Rejected">Turned down</option>
            </select>
          </label>
        </header>
        @if (signups.error(); as err) {
          <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
        }
        @if (signups.loaded() && signups.value().length === 0 && !signups.error()) {
          <p class="pad muted">No sign-ups.</p>
        }
        @if (signups.value().length) {
          <div class="table-wrap">
            <table>
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
                  <tr>
                    <td>
                      {{ s.organisationName }}
                      <div class="sub">
                        {{ s.organisationSlug }}
                        @if (s.tenantId) {
                          · #{{ s.tenantId }}
                        }
                      </div>
                    </td>
                    <td>
                      {{ s.displayName }}
                      <div class="sub">{{ s.email }}</div>
                    </td>
                    <td>
                      {{ s.requestedAtUtc | date: 'medium' }}
                      <div class="sub">from {{ s.requestIp || 'unknown' }}</div>
                    </td>
                    <td>
                      <span [class]="'chip ' + tone(s)">{{ label(s) }}</span>
                      @if (s.decisionNote) {
                        <div class="sub">{{ s.decisionNote }}</div>
                      }
                    </td>
                    <td>
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
                          class="btn btn-danger btn-sm"
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

  protected readonly label = signupStatusLabel;
  protected readonly tone = signupTone;
  protected readonly decide = canDecide;

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
  readonly deciding = signal<{ signup: TenantSignup; action: 'approve' | 'reject' } | null>(null);
  readonly note = signal('');
  readonly busy = signal(false);

  constructor() {
    this.reload();
  }

  reload(): void {
    this.signups.reload();
    this.status.reload();
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
