import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { ApiError } from '@core/api/api.types';
import { ThemeService } from '@core/theme/theme.service';
import { SignInShellComponent } from '@shared/components/sign-in-shell/sign-in-shell.component';
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
  imports: [FormsModule, RouterLink, SignInShellComponent],
  template: `
    <app-sign-in-shell>
      <h1 class="si-title" id="signup-title">Create an organisation</h1>
      <p class="si-subtitle">Trade demo accounts with Lascodia's strategies and research.</p>

      <section class="si-body" aria-labelledby="signup-title">
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
            <p class="si-alert" role="status">
              Creating an organisation is not available right now. Please try again later.
            </p>
          }
          @case ('error') {
            <p class="si-alert si-alert--danger" role="alert">
              The sign-up page could not be loaded. Check your connection and try again.
            </p>
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
        </p>
      </section>
    </app-sign-in-shell>
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
