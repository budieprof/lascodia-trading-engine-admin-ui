import { Component, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ApiService } from '@core/api/api.service';
import type { ResponseData } from '@core/api/api.types';
import { AuthService } from '../auth.service';
import { BffSessionService } from '../bff-session.service';
import { signInErrorMessage } from '../bff.types';
import { SIGNIN_ERROR_PARAM } from '../auth.guard';
import { DEFAULT_POST_LOGIN_ROUTE, RETURN_URL_PARAM, sanitizeReturnUrl } from '../return-url';
import { ThemeService } from '@core/theme/theme.service';
import { SignInShellComponent } from '@shared/components/sign-in-shell/sign-in-shell.component';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [FormsModule, RouterLink, SignInShellComponent],
  template: `
    <app-sign-in-shell [secured]="bffMode">
      @if (bffMode) {
        <h1 class="si-title">Sign in</h1>
        <p class="si-subtitle">
          Use your organisation account. You will confirm it is you with a second factor.
        </p>

        <div class="si-body">
          @if (notice(); as n) {
            <p class="si-alert" role="status">{{ n }}</p>
          }
          @if (error()) {
            <p class="si-alert si-alert--danger" role="alert">{{ error() }}</p>
          }
          <button
            type="button"
            class="si-btn si-btn--primary"
            (click)="onBffSignIn()"
            [disabled]="loading()"
          >
            @if (loading()) {
              <span class="si-spinner" aria-hidden="true"></span>
              <span>Opening sign-in…</span>
            } @else {
              Continue to sign in
            }
          </button>
          <p class="si-note">
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path
                fill="currentColor"
                d="M8 1a3.5 3.5 0 0 0-3.5 3.5V6H4a1.5 1.5 0 0 0-1.5 1.5v6A1.5 1.5 0 0 0 4 15h8a1.5 1.5 0 0 0 1.5-1.5v-6A1.5 1.5 0 0 0 12 6h-.5V4.5A3.5 3.5 0 0 0 8 1Zm2 5H6V4.5a2 2 0 1 1 4 0V6Z"
              />
            </svg>
            This console never sees your password and never stores a token.
          </p>
          @if (signupOffered()) {
            <!-- Self-serve sign-up (multi-tenancy Phase 7, c7-lifecycle): only while the engine offers it. -->
            <p class="si-foot">
              New to Lascodia? <a class="si-link" routerLink="/signup">Create an organisation</a>
            </p>
          }
        </div>
      } @else {
        <h1 class="si-title">Sign in</h1>
        <p class="si-subtitle">Lascodia Trading Engine admin console.</p>

        <div class="si-body">
          <div class="si-segmented" role="tablist" aria-label="Login mode">
            <button
              type="button"
              role="tab"
              [attr.aria-selected]="mode() === 'admin'"
              (click)="mode.set('admin')"
            >
              Admin
            </button>
            <button
              type="button"
              role="tab"
              [attr.aria-selected]="mode() === 'operator'"
              (click)="mode.set('operator')"
            >
              Operator
            </button>
          </div>

          @if (mode() === 'admin') {
            <form (ngSubmit)="onAdminLogin()" class="si-form login-form">
              <div class="si-field">
                <label for="username">Username</label>
                <input
                  id="username"
                  class="si-input"
                  type="text"
                  [(ngModel)]="username"
                  name="username"
                  placeholder="superadmin"
                  autocomplete="username"
                  required
                />
              </div>

              <div class="si-field">
                <label for="adminPassword">Password</label>
                <input
                  id="adminPassword"
                  class="si-input"
                  type="password"
                  [(ngModel)]="adminPassword"
                  name="adminPassword"
                  autocomplete="current-password"
                  required
                />
              </div>

              @if (error()) {
                <p class="si-alert si-alert--danger" role="alert">{{ error() }}</p>
              }

              <button type="submit" [disabled]="loading()" class="si-btn si-btn--primary">
                @if (loading()) {
                  <span class="si-spinner" aria-hidden="true"></span>
                } @else {
                  Sign in
                }
              </button>
            </form>

            <p class="si-note">Admin user: username and password.</p>
          } @else if (mode() === 'operator') {
            <form (ngSubmit)="onOperatorLogin()" class="si-form login-form">
              <div class="si-field">
                <label for="accountId">Account ID</label>
                <input
                  id="accountId"
                  class="si-input"
                  type="text"
                  [(ngModel)]="accountId"
                  name="accountId"
                  placeholder="12345678"
                  autocomplete="username"
                  required
                />
              </div>

              <div class="si-field">
                <label for="brokerServer">Broker server</label>
                <input
                  id="brokerServer"
                  class="si-input"
                  type="text"
                  [(ngModel)]="brokerServer"
                  name="brokerServer"
                  placeholder="MetaQuotes-Demo"
                  required
                />
              </div>

              <div class="si-field">
                <label for="password">Password</label>
                <input
                  id="password"
                  class="si-input"
                  type="password"
                  [(ngModel)]="password"
                  name="password"
                  autocomplete="current-password"
                  required
                />
              </div>

              @if (error()) {
                <p class="si-alert si-alert--danger" role="alert">{{ error() }}</p>
              }

              <button type="submit" [disabled]="loading()" class="si-btn si-btn--primary">
                @if (loading()) {
                  <span class="si-spinner" aria-hidden="true"></span>
                } @else {
                  Sign in
                }
              </button>
            </form>

            <p class="si-note">Engine auth: the token carries role claims.</p>
          }
        </div>
      }
    </app-sign-in-shell>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [
    `
      /* Reserve the height of the tallest legacy form (Operator: three fields) so the page does not
       * jump when the operator switches tabs; the submit button stays pinned to the bottom. */
      .login-form {
        min-height: 300px;
      }
      .login-form .si-btn {
        margin-top: auto;
      }
    `,
  ],
})
export class LoginComponent {
  private auth = inject(AuthService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  private bff = inject(BffSessionService);

  /** `config.json` → `featureFlags.bffAuth`: sign in through the engine's BFF (Keycloak). */
  readonly bffMode = this.auth.mode === 'bff';

  constructor() {
    // ThemeService writes `data-theme` on <html> from its constructor effect,
    // but nothing on the login route (no sidebar, no chart card) injected it,
    // so the service was never instantiated and the page always rendered the
    // light palette. Resolving it here makes the login screen honour the
    // stored / system theme like every other route.
    inject(ThemeService);
    if (this.bffMode) {
      this.prepareBffPage();
      inject(ApiService)
        .get<ResponseData<{ available: boolean }>>('/onboarding/signup', { silent: true })
        .subscribe({
          next: (r) => this.signupOffered.set(r?.status === true && r.data?.available === true),
          error: () => {},
        });
    }
  }

  /**
   * Where to land after a successful login.
   *
   * When the session expired under the user, authGuard / errorInterceptor
   * stashed the route they were on as a `returnUrl` param — send them back
   * there so re-authenticating is a blip rather than a loss of place.
   * Falls back to the dashboard when there is no param, or when the param
   * fails sanitisation (it is attacker-controllable — see return-url.ts).
   */
  private postLoginTarget(): string {
    const raw = this.route.snapshot.queryParamMap.get(RETURN_URL_PARAM) ?? this.noteReturnUrl;
    return sanitizeReturnUrl(raw) ?? DEFAULT_POST_LOGIN_ROUTE;
  }

  readonly mode = signal<'admin' | 'operator'>('admin');

  // Admin-mode fields (username + password)
  username = '';
  adminPassword = '';

  // Operator-mode fields
  accountId = '';
  brokerServer = '';
  password = '';

  loading = signal(false);
  error = signal<string | null>(null);
  /** Why the person is here (BFF): their session ended, or they were idle. */
  readonly notice = signal<string | null>(null);
  /** The return route a BFF sign-out remembered (the logout round trip drops query params). */
  private noteReturnUrl: string | null = null;
  /** Self-serve sign-up is on and can run (`GET onboarding/signup`; 404 while it is off). */
  readonly signupOffered = signal(false);

  /**
   * BFF: explain how the person got here — a sign-in that did not complete (`signin_error`, from
   * `/bff/callback`), a session that ended under them, or an idle sign-out — and send someone who
   * IS signed in straight on.
   */
  private prepareBffPage(): void {
    const q = this.route.snapshot.queryParamMap;
    const note = this.auth.takeSignedOutNote();
    this.noteReturnUrl = note?.returnUrl ?? null;
    const reason = note?.reason ?? q.get('reason');
    if (reason === 'idle') {
      this.notice.set(
        'You were signed out after a period of inactivity. Sign in again to continue.',
      );
    } else if (reason === 'expired') {
      this.notice.set('Your session has ended. Sign in again to continue.');
    }
    this.error.set(signInErrorMessage(q.get(SIGNIN_ERROR_PARAM)));
    if (!this.error() && this.bff.unreachable()) {
      this.error.set('The engine could not be reached. Check your connection and try again.');
    }
    if (this.auth.isAuthenticated()) void this.router.navigateByUrl(this.postLoginTarget());
  }

  /** BFF: leave for `/bff/login` (Keycloak) and come back to where the person was going. */
  onBffSignIn(): void {
    this.loading.set(true);
    this.error.set(null);
    this.auth.beginSignIn(this.postLoginTarget());
  }

  onAdminLogin() {
    if (!this.username || !this.adminPassword) {
      this.error.set('Username and password are required.');
      return;
    }
    this.loading.set(true);
    this.error.set(null);
    this.auth.loginAdmin(this.username, this.adminPassword).subscribe({
      next: (res) => {
        if (res?.status && res.data?.token) {
          this.router.navigateByUrl(
            res.data.mustChangePassword ? '/account/change-password' : this.postLoginTarget(),
          );
        } else {
          this.error.set(res?.message || 'Invalid username or password.');
          this.loading.set(false);
        }
      },
      error: (err) => {
        this.error.set(err?.message || 'Login failed. Is the engine reachable?');
        this.loading.set(false);
      },
    });
  }

  onOperatorLogin() {
    if (!this.accountId || !this.brokerServer || !this.password) {
      this.error.set('Account ID, Broker Server, and Password are required.');
      return;
    }
    this.loading.set(true);
    this.error.set(null);
    this.auth
      .loginOperator({
        accountId: this.accountId,
        brokerServer: this.brokerServer,
        password: this.password,
      })
      .subscribe({
        next: (res) => {
          if (res?.status) {
            this.router.navigateByUrl(this.postLoginTarget());
          } else {
            this.error.set(res?.message || 'Login failed.');
            this.loading.set(false);
          }
        },
        error: (err) => {
          this.error.set(err?.message || 'Login failed. Is the engine reachable?');
          this.loading.set(false);
        },
      });
  }
}
