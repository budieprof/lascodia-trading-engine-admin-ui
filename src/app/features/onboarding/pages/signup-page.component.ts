import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { ApiError } from '@core/api/api.types';
import { ThemeService } from '@core/theme/theme.service';
import { LogoComponent } from '@shared/components/logo/logo.component';
import { OnboardingApiService } from '../onboarding-api.service';
import { signupProblems, signupRefusal, slugFrom } from '../onboarding.logic';
import type { PublicSignupAvailability, SignupBody, SignupResult } from '../onboarding.types';

type PageState = 'loading' | 'off' | 'unavailable' | 'form' | 'sent' | 'error';

/**
 * "Create an organisation" (engine multi-tenancy Phase 7, LC.1, public, outside the console): the person
 * gives their e-mail address, name and the organisation's name; the engine registers them at the sign-in
 * service and e-mails a link to verify the address and set a password and second factor. The organisation
 * is created when they first sign in with the address verified (and, where required, once Lascodia has
 * approved it); it starts on the Trial plan and is demo-only. While sign-up is off the page says so.
 */
@Component({
  selector: 'app-signup-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, RouterLink, LogoComponent],
  styles: [
    `
      .signup-page {
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: var(--space-6) var(--space-4);
        background: var(--bg-secondary);
      }
      .card {
        width: min(480px, 100%);
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-lg);
        box-shadow: var(--shadow-md);
        padding: var(--space-6);
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
      }
      header {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: var(--space-2);
        text-align: center;
      }
      h1 {
        margin: 0;
        font-size: var(--text-xl);
      }
      p {
        margin: 0;
        color: var(--text-secondary);
      }
      form {
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      label {
        display: flex;
        flex-direction: column;
        gap: var(--space-1);
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
      }
      .hint {
        font-weight: normal;
        color: var(--text-tertiary);
        font-size: var(--text-xs);
      }
      input {
        padding: 9px 12px;
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-sm);
      }
      .submit {
        padding: 10px 14px;
        border-radius: var(--radius-md);
        border: none;
        background: var(--accent);
        color: #fff;
        font-weight: var(--font-semibold);
        cursor: pointer;
      }
      .submit:disabled {
        opacity: 0.6;
        cursor: default;
      }
      .errors {
        margin: 0;
        padding-left: var(--space-4);
        color: var(--loss);
        font-size: var(--text-sm);
      }
      .sent {
        border-left: 3px solid var(--profit);
        padding-left: var(--space-3);
        color: var(--text-primary);
      }
      .foot {
        text-align: center;
        font-size: var(--text-sm);
      }
    `,
  ],
  template: `
    <main class="signup-page">
      <section class="card" aria-labelledby="signup-title">
        <header>
          <app-logo [size]="48" />
          <h1 id="signup-title">Create an organisation</h1>
          <p>Trade demo accounts with Lascodia's strategies and research.</p>
        </header>

        @switch (state()) {
          @case ('loading') {
            <p role="status">Loading…</p>
          }
          @case ('off') {
            <p>
              Organisations are created by invitation. Ask Lascodia for an invitation, or sign in if
              you have one.
            </p>
          }
          @case ('unavailable') {
            <p role="status">
              Creating an organisation is not available right now. Please try again later.
            </p>
          }
          @case ('error') {
            <p role="alert">
              The sign-up page could not be loaded. Check your connection and try again.
            </p>
          }
          @case ('sent') {
            <p class="sent" role="status">{{ result()?.message }}</p>
          }
          @case ('form') {
            <form (ngSubmit)="submit()" novalidate>
              <label>
                Your work e-mail address
                <input
                  type="email"
                  name="email"
                  autocomplete="email"
                  required
                  [ngModel]="email()"
                  (ngModelChange)="email.set($event)"
                />
              </label>
              <label>
                Your name
                <input
                  name="displayName"
                  autocomplete="name"
                  maxlength="128"
                  required
                  [ngModel]="displayName()"
                  (ngModelChange)="displayName.set($event)"
                />
              </label>
              <label>
                Organisation name
                <input
                  name="organisationName"
                  autocomplete="organization"
                  maxlength="128"
                  required
                  [ngModel]="organisationName()"
                  (ngModelChange)="organisationName.set($event)"
                />
              </label>
              <label>
                Handle
                <span class="hint"
                  >(optional — how the organisation is named in links;
                  {{ suggestedSlug() || 'made from its name' }})</span
                >
                <input
                  name="slug"
                  maxlength="63"
                  autocomplete="off"
                  [placeholder]="suggestedSlug()"
                  [ngModel]="slug()"
                  (ngModelChange)="slug.set($event)"
                />
              </label>
              @if (shownProblems().length) {
                <ul class="errors" role="alert">
                  @for (p of shownProblems(); track p) {
                    <li>{{ p }}</li>
                  }
                </ul>
              }
              <button type="submit" class="submit" [disabled]="busy()">
                {{ busy() ? 'Sending…' : 'Create organisation' }}
              </button>
              <p class="hint">
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

        <p class="foot">Already have an account? <a routerLink="/login">Sign in</a></p>
      </section>
    </main>
  `,
})
export class SignupPageComponent {
  private readonly api = inject(OnboardingApiService);

  readonly state = signal<PageState>('loading');
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
        this.state.set(a === null ? 'off' : a.available ? 'form' : 'unavailable');
      },
      error: () => this.state.set('error'),
    });
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
