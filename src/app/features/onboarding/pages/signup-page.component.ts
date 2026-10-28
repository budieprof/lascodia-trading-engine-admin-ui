import { DOCUMENT } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { ApiError } from '@core/api/api.types';
import { SALES_EMAIL } from '@core/branding/contact';
import { ThemeService } from '@core/theme/theme.service';
import { SignInShellComponent } from '@shared/components/sign-in-shell/sign-in-shell.component';
import { OnboardingApiService } from '../onboarding-api.service';
import {
  ACCESS_ROLES,
  accessRequestMailto,
  accessRequestProblems,
  signupProblems,
  signupRefusal,
  slugFrom,
  type AccessRequest,
} from '../onboarding.logic';
import type { PublicSignupAvailability, SignupBody, SignupResult } from '../onboarding.types';

type PageState = 'loading' | 'request' | 'requested' | 'form' | 'sent';

/** Why the page asks for access instead of creating an organisation. */
type RequestReason = 'off' | 'unavailable' | 'error';

/**
 * "Create an organisation" (engine multi-tenancy Phase 7, LC.1, public, outside the console): the person
 * gives their e-mail address, name and the organisation's name; the engine registers them at the sign-in
 * service and e-mails a link to verify the address and set a password and second factor. The organisation
 * is created when they first sign in with the address verified (and, where required, once Lascodia has
 * approved it); it starts on the Trial plan and is demo-only. While sign-up is off (or cannot run, or the engine
 * cannot be reached) the page is a request-access form instead: it opens the person's mail app with a message to
 * Lascodia's sales address, so the landing page's "Get started" never leads to a dead end.
 */
@Component({
  selector: 'app-signup-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, RouterLink, SignInShellComponent],
  template: `
    <app-sign-in-shell>
      @if (state() === 'request' || state() === 'requested') {
        <h1 class="si-title" id="signup-title">Request access</h1>
        <p class="si-subtitle">Tell us a little about your trading and we will set you up.</p>
      } @else {
        <h1 class="si-title" id="signup-title">Create an organisation</h1>
        <p class="si-subtitle">Trade demo accounts with Lascodia's strategies and research.</p>
      }

      <section class="si-body" aria-labelledby="signup-title">
        @switch (state()) {
          @case ('loading') {
            <p role="status">Loading…</p>
          }
          @case ('request') {
            @if (reason() === 'unavailable') {
              <p class="si-alert" role="status">
                Instant sign-up is paused right now. Request access and we will create your
                organisation for you.
              </p>
            } @else if (reason() === 'error') {
              <p class="si-alert" role="status">
                Instant sign-up could not be checked just now. You can still request access.
              </p>
            } @else {
              <p class="su-lede">
                New organisations are opened by invitation. Send us your details and we reply by
                e-mail with your invitation.
              </p>
            }
            <form class="si-form" (ngSubmit)="sendRequest()" novalidate>
              <div class="si-field">
                <label for="req-name">Your name</label>
                <input
                  id="req-name"
                  class="si-input"
                  name="name"
                  autocomplete="name"
                  maxlength="128"
                  required
                  [ngModel]="req().name"
                  (ngModelChange)="patch('name', $event)"
                />
              </div>
              <div class="si-field">
                <label for="req-email">Work e-mail address</label>
                <input
                  id="req-email"
                  class="si-input"
                  type="email"
                  name="email"
                  autocomplete="email"
                  required
                  [ngModel]="req().email"
                  (ngModelChange)="patch('email', $event)"
                />
              </div>
              <div class="si-field">
                <label for="req-org">Organisation</label>
                <input
                  id="req-org"
                  class="si-input"
                  name="organisation"
                  autocomplete="organization"
                  maxlength="128"
                  required
                  [ngModel]="req().organisation"
                  (ngModelChange)="patch('organisation', $event)"
                />
              </div>
              <div class="su-row">
                <div class="si-field">
                  <label for="req-role">You are</label>
                  <select
                    id="req-role"
                    class="si-input"
                    name="role"
                    [ngModel]="req().role"
                    (ngModelChange)="patch('role', $event)"
                  >
                    <option value="">Choose…</option>
                    @for (r of roles; track r) {
                      <option [value]="r">{{ r }}</option>
                    }
                  </select>
                </div>
                <div class="si-field">
                  <label for="req-terminals">MT5 terminals</label>
                  <input
                    id="req-terminals"
                    class="si-input"
                    name="terminals"
                    inputmode="numeric"
                    maxlength="12"
                    placeholder="e.g. 2"
                    [ngModel]="req().terminals"
                    (ngModelChange)="patch('terminals', $event)"
                  />
                </div>
              </div>
              <div class="si-field">
                <label for="req-message">Anything else? <small>(optional)</small></label>
                <textarea
                  id="req-message"
                  class="si-input su-textarea"
                  name="message"
                  rows="3"
                  maxlength="2000"
                  placeholder="Your broker, the markets you trade, what you want to automate…"
                  [ngModel]="req().message"
                  (ngModelChange)="patch('message', $event)"
                ></textarea>
              </div>
              @if (reqAttempted() && reqProblems().length) {
                <div class="si-alert si-alert--danger" role="alert">
                  <ul>
                    @for (p of reqProblems(); track p) {
                      <li>{{ p }}</li>
                    }
                  </ul>
                </div>
              }
              <button type="submit" class="si-btn si-btn--primary">Request access</button>
              <ol class="su-steps" aria-label="What happens next">
                <li>We reply by e-mail with your invitation.</li>
                <li>You set a password and an authenticator app, then sign in.</li>
                <li>
                  A guided set-up connects your first MetaTrader 5 terminal, on demo accounts first.
                </li>
              </ol>
            </form>
          }
          @case ('requested') {
            <p class="si-alert si-alert--success" role="status">
              Your e-mail app should now show a message to {{ salesEmail }} with your request filled
              in. Send it and we will reply with your invitation.
            </p>
            <p class="su-lede">
              Nothing opened? E-mail
              <a class="si-link" [href]="'mailto:' + salesEmail">{{ salesEmail }}</a> directly.
            </p>
            <button type="button" class="si-btn si-btn--secondary" (click)="state.set('request')">
              Edit the request
            </button>
          }
          @case ('sent') {
            <p class="si-alert si-alert--success" role="status">{{ result()?.message }}</p>
          }
          @case ('form') {
            <form class="si-form" (ngSubmit)="submit()" novalidate>
              <div class="si-field">
                <label for="signup-email">Your work e-mail address</label>
                <input
                  id="signup-email"
                  class="si-input"
                  type="email"
                  name="email"
                  autocomplete="email"
                  required
                  [ngModel]="email()"
                  (ngModelChange)="email.set($event)"
                />
              </div>
              <div class="si-field">
                <label for="signup-name">Your name</label>
                <input
                  id="signup-name"
                  class="si-input"
                  name="displayName"
                  autocomplete="name"
                  maxlength="128"
                  required
                  [ngModel]="displayName()"
                  (ngModelChange)="displayName.set($event)"
                />
              </div>
              <div class="si-field">
                <label for="signup-org">Organisation name</label>
                <input
                  id="signup-org"
                  class="si-input"
                  name="organisationName"
                  autocomplete="organization"
                  maxlength="128"
                  required
                  [ngModel]="organisationName()"
                  (ngModelChange)="organisationName.set($event)"
                />
              </div>
              <div class="si-field">
                <label for="signup-slug">Handle</label>
                <input
                  id="signup-slug"
                  class="si-input"
                  name="slug"
                  maxlength="63"
                  autocomplete="off"
                  aria-describedby="signup-slug-hint"
                  [placeholder]="suggestedSlug()"
                  [ngModel]="slug()"
                  (ngModelChange)="slug.set($event)"
                />
                <span class="si-field__hint" id="signup-slug-hint"
                  >Optional: how the organisation is named in links;
                  {{ suggestedSlug() || 'made from its name' }}.</span
                >
              </div>
              @if (shownProblems().length) {
                <div class="si-alert si-alert--danger" role="alert">
                  <ul>
                    @for (p of shownProblems(); track p) {
                      <li>{{ p }}</li>
                    }
                  </ul>
                </div>
              }
              <button type="submit" class="si-btn si-btn--primary" [disabled]="busy()">
                {{ busy() ? 'Sending…' : 'Create organisation' }}
              </button>
              <p class="si-note">
                We e-mail you a link to verify your address and set your password and a second
                factor (authenticator app).
                @if (availability()?.requiresApproval) {
                  Lascodia reviews every new organisation before it can be used.
                }
                New organisations use demo accounts only.
              </p>
            </form>
          }
        }

        <p class="si-foot">
          Already have an account? <a class="si-link" routerLink="/login">Sign in</a>
          <span class="su-dot" aria-hidden="true">·</span>
          <a class="si-link" routerLink="/welcome">About Lascodia</a>
        </p>
      </section>
    </app-sign-in-shell>
  `,
  styles: `
    .su-lede {
      margin: 0;
      font-size: 14px;
      line-height: 1.55;
      color: var(--text-secondary);
    }
    .su-row {
      display: grid;
      grid-template-columns: 1.4fr 1fr;
      gap: 12px;
    }
    @media (max-width: 420px) {
      .su-row {
        grid-template-columns: 1fr;
      }
    }
    select.si-input {
      appearance: none;
      padding-right: 36px;
      background-image:
        linear-gradient(45deg, transparent 50%, currentColor 50%),
        linear-gradient(135deg, currentColor 50%, transparent 50%);
      background-position:
        calc(100% - 19px) 50%,
        calc(100% - 14px) 50%;
      background-size: 5px 5px;
      background-repeat: no-repeat;
    }
    .su-textarea {
      height: auto;
      min-height: 88px;
      padding: 12px 14px;
      resize: vertical;
      line-height: 1.45;
    }
    .si-field label small {
      font-weight: 400;
      color: var(--text-tertiary);
    }
    .su-steps {
      margin: 4px 0 0;
      padding-left: 20px;
      display: grid;
      gap: 6px;
      font-size: 13px;
      line-height: 1.5;
      color: var(--text-secondary);
    }
    .su-dot {
      margin: 0 8px;
      color: var(--text-tertiary);
    }
  `,
})
export class SignupPageComponent {
  private readonly api = inject(OnboardingApiService);
  private readonly document = inject(DOCUMENT);

  protected readonly roles = ACCESS_ROLES;
  protected readonly salesEmail = SALES_EMAIL;

  readonly state = signal<PageState>('loading');
  readonly reason = signal<RequestReason>('off');
  readonly req = signal<AccessRequest>({
    name: '',
    email: '',
    organisation: '',
    role: '',
    terminals: '',
    message: '',
  });
  readonly reqAttempted = signal(false);
  readonly reqProblems = computed(() => accessRequestProblems(this.req()));
  readonly availability = signal<PublicSignupAvailability | null>(null);
  readonly result = signal<SignupResult | null>(null);
  readonly email = signal('');
  readonly displayName = signal('');
  readonly organisationName = signal('');
  readonly slug = signal('');
  readonly busy = signal(false);
  readonly attempted = signal(false);
  readonly serverError = signal<string | null>(null);

  readonly suggestedSlug = computed(() =>
    this.organisationName().trim() ? slugFrom(this.organisationName()) : '',
  );
  readonly body = computed<SignupBody>(() => ({
    email: this.email().trim(),
    displayName: this.displayName().trim(),
    organisationName: this.organisationName().trim(),
    organisationSlug: this.slug().trim().toLowerCase() || null,
  }));
  readonly problems = computed(() => signupProblems(this.body()));
  readonly shownProblems = computed(() => [
    ...(this.attempted() ? this.problems() : []),
    ...(this.serverError() ? [this.serverError()!] : []),
  ]);

  constructor() {
    // The page is outside the console, which is what normally starts the theme.
    inject(ThemeService);
    this.api.signupAvailability().subscribe({
      next: (a) => {
        this.availability.set(a);
        if (a?.available) this.state.set('form');
        else this.askForAccess(a === null ? 'off' : 'unavailable');
      },
      error: () => this.askForAccess('error'),
    });
  }

  private askForAccess(reason: RequestReason): void {
    this.reason.set(reason);
    this.state.set('request');
  }

  patch<K extends keyof AccessRequest>(key: K, value: AccessRequest[K]): void {
    this.req.update((r) => ({ ...r, [key]: value }));
  }

  sendRequest(): void {
    this.reqAttempted.set(true);
    if (this.reqProblems().length) return;
    this.document.location.href = accessRequestMailto(this.salesEmail, this.req());
    this.state.set('requested');
  }

  submit(): void {
    this.attempted.set(true);
    this.serverError.set(null);
    if (this.problems().length || this.busy()) return;
    this.busy.set(true);
    this.api.signUp(this.body()).subscribe({
      next: (r) => {
        this.busy.set(false);
        this.result.set(r);
        this.state.set('sent');
      },
      error: (e: unknown) => {
        this.busy.set(false);
        // The engine's envelope says why (an HTTP error's own text is transport noise).
        const body = (
          e as { error?: { responseCode?: string | null; message?: string | null } } | null
        )?.error;
        const code = body?.responseCode ?? (e instanceof ApiError ? e.code : null);
        const message = body?.message ?? (e instanceof ApiError ? e.message : null);
        this.serverError.set(signupRefusal(code, message));
      },
    });
  }
}
