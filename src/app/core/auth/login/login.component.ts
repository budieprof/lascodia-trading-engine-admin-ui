import { Component, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { AuthService } from '../auth.service';
import { BffSessionService } from '../bff-session.service';
import { signInErrorMessage } from '../bff.types';
import { SIGNIN_ERROR_PARAM } from '../auth.guard';
import { DEFAULT_POST_LOGIN_ROUTE, RETURN_URL_PARAM, sanitizeReturnUrl } from '../return-url';
import { ThemeService } from '@core/theme/theme.service';
import { LogoComponent } from '@shared/components/logo/logo.component';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [FormsModule, LogoComponent],
  template: `
    <div class="login-page">
      <div class="login-card">
        <div class="login-header">
          <app-logo [size]="60" />
          <h1>Lascodia Trading Engine</h1>
          <p>Admin Console</p>
        </div>

        @if (bffMode) {
          <div class="bff-signin">
            @if (notice(); as n) {
              <p class="notice" role="status">{{ n }}</p>
            }
            @if (error()) {
              <div class="error-message" role="alert">{{ error() }}</div>
            }
            <button type="button" class="login-btn" (click)="onBffSignIn()" [disabled]="loading()">
              @if (loading()) {
                <span class="spinner"></span>
              } @else {
                Sign in
              }
            </button>
            <p class="dev-note">
              You sign in with your organisation account and its second factor. This console never
              stores your password or a token.
            </p>
          </div>
        } @else {
          <div class="mode-toggle" role="tablist" aria-label="Login mode">
            <button
              type="button"
              role="tab"
              class="mode-btn"
              [class.active]="mode() === 'admin'"
              [attr.aria-selected]="mode() === 'admin'"
              (click)="mode.set('admin')"
            >
              Admin
            </button>
            <button
              type="button"
              role="tab"
              class="mode-btn"
              [class.active]="mode() === 'operator'"
              [attr.aria-selected]="mode() === 'operator'"
              (click)="mode.set('operator')"
            >
              Operator
            </button>
          </div>

          @if (mode() === 'admin') {
            <form (ngSubmit)="onAdminLogin()" class="login-form">
              <div class="field">
                <label for="username">Username</label>
                <input
                  id="username"
                  type="text"
                  [(ngModel)]="username"
                  name="username"
                  placeholder="superadmin"
                  autocomplete="username"
                  required
                />
              </div>

              <div class="field">
                <label for="adminPassword">Password</label>
                <input
                  id="adminPassword"
                  type="password"
                  [(ngModel)]="adminPassword"
                  name="adminPassword"
                  autocomplete="current-password"
                  required
                />
              </div>

              @if (error()) {
                <div class="error-message">{{ error() }}</div>
              }

              <button type="submit" [disabled]="loading()" class="login-btn">
                @if (loading()) {
                  <span class="spinner"></span>
                } @else {
                  Sign In
                }
              </button>
            </form>

            <p class="dev-note">Admin user — username &amp; password.</p>
          } @else if (mode() === 'operator') {
            <form
              (ngSubmit)="onOperatorLogin()"
              class="login-form"
           
            >
              <div class="field">
                <label for="accountId">Account ID</label>
                <input
                  id="accountId"
                  type="text"
                  [(ngModel)]="accountId"
                  name="accountId"
                  placeholder="12345678"
                  autocomplete="username"
                  required
                />
              </div>

              <div class="field">
                <label for="brokerServer">Broker Server</label>
                <input
                  id="brokerServer"
                  type="text"
                  [(ngModel)]="brokerServer"
                  name="brokerServer"
                  placeholder="MetaQuotes-Demo"
                  required
                />
              </div>

              <div class="field">
                <label for="password">Password</label>
                <input
                  id="password"
                  type="password"
                  [(ngModel)]="password"
                  name="password"
                  autocomplete="current-password"
                  required
                />
              </div>

              @if (error()) {
                <div class="error-message">{{ error() }}</div>
              }

              <button type="submit" [disabled]="loading()" class="login-btn">
                @if (loading()) {
                  <span class="spinner"></span>
                } @else {
                  Sign In
                }
              </button>
            </form>

            <p class="dev-note">Engine auth — JWT carries role claims.</p>
          }
        }
      </div>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [
    `
      .login-page {
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--bg-primary);
        padding: var(--space-4);
      }

      .login-card {
        width: 100%;
        max-width: 400px;
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-xl);
        padding: var(--space-10);
        box-shadow: var(--shadow-lg);
      }

      .login-header {
        text-align: center;
        margin-bottom: var(--space-8);
      }

      app-logo {
        margin: 0 auto var(--space-4);
        /* Lift the mark off the card the way an app icon sits on a shelf. */
        filter: drop-shadow(0 6px 16px rgba(0, 87, 216, 0.28));
      }

      .login-header h1 {
        font-size: var(--text-lg);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
        margin: 0 0 var(--space-1);
        letter-spacing: var(--tracking-tight);
      }

      .login-header p {
        font-size: var(--text-sm);
        color: var(--text-secondary);
        margin: 0;
      }

      .login-form {
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
        /* Reserve the height of the tallest form (Operator: three fields) so the card does not
         * resize when the operator switches tabs; the submit button is pinned to the bottom so it
         * stays put as well. */
        min-height: 268px;
      }
      .login-form .login-btn {
        margin-top: auto;
      }
      .bff-signin {
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
      }
      .notice {
        margin: 0;
        padding: var(--space-2) var(--space-3);
        border-radius: var(--radius-sm);
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        font-size: var(--text-sm);
        line-height: 1.4;
      }

      .field {
        display: flex;
        flex-direction: column;
        gap: var(--space-1);
      }

      .field label {
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        color: var(--text-secondary);
      }

      .field input {
        height: 40px;
        padding: 0 var(--space-3);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-base);
        font-family: inherit;
        outline: none;
        transition:
          box-shadow 0.15s ease,
          border-color 0.15s ease;
      }

      .field input:focus {
        border-color: var(--accent);
        box-shadow: 0 0 0 3px rgba(0, 113, 227, 0.3);
      }

      .field input::placeholder {
        color: var(--text-tertiary);
      }

      .error-message {
        font-size: var(--text-sm);
        color: var(--loss);
        text-align: center;
      }

      .login-btn {
        height: 44px;
        background: var(--accent);
        color: white;
        border: none;
        border-radius: var(--radius-full);
        font-size: var(--text-base);
        font-weight: var(--font-medium);
        font-family: inherit;
        cursor: pointer;
        transition: all 0.15s ease;
        display: flex;
        align-items: center;
        justify-content: center;
        margin-top: var(--space-2);
      }

      .login-btn:hover:not(:disabled) {
        background: var(--accent-hover);
      }

      .login-btn:active:not(:disabled) {
        transform: scale(0.97);
      }

      .login-btn:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }

      .spinner {
        width: 18px;
        height: 18px;
        border: 2px solid rgba(255, 255, 255, 0.3);
        border-top-color: white;
        border-radius: 50%;
        animation: spin 0.6s linear infinite;
      }

      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }

      .dev-note {
        text-align: center;
        font-size: 11px;
        color: var(--text-tertiary);
        margin: var(--space-4) 0 0;
      }

      .mode-toggle {
        display: flex;
        gap: 4px;
        padding: 4px;
        background: var(--bg-tertiary);
        border-radius: var(--radius-full);
        margin-bottom: var(--space-5);
      }

      .mode-btn {
        flex: 1;
        padding: 8px 16px;
        border: none;
        background: transparent;
        color: var(--text-secondary);
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        font-family: inherit;
        border-radius: var(--radius-full);
        cursor: pointer;
        transition: all 0.15s ease;
      }

      .mode-btn.active {
        background: var(--bg-primary);
        color: var(--text-primary);
        box-shadow: var(--shadow-sm);
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
    if (this.bffMode) this.prepareBffPage();
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
      this.notice.set('You were signed out after a period of inactivity. Sign in again to continue.');
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
