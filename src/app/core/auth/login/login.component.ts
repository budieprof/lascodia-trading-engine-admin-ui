import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../auth.service';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="login-page">
      <div class="login-card">
        <div class="login-header">
          <div class="logo">L</div>
          <h1>Lascodia Trading Engine</h1>
          <p>Admin Console</p>
        </div>

        <div class="mode-toggle" role="tablist" aria-label="Login mode">
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
          <button
            type="button"
            role="tab"
            class="mode-btn"
            [class.active]="mode() === 'dev'"
            [attr.aria-selected]="mode() === 'dev'"
            (click)="mode.set('dev')"
          >
            Developer
          </button>
        </div>

        @if (mode() === 'operator') {
          <form (ngSubmit)="onOperatorLogin()" class="login-form">
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
        } @else {
          <form (ngSubmit)="onDevLogin()" class="login-form">
            <div class="field">
              <label for="userId">User ID</label>
              <input
                id="userId"
                type="text"
                [(ngModel)]="userId"
                name="userId"
                placeholder="dev-user-1"
                autocomplete="username"
              />
            </div>

            <div class="field">
              <label for="firstName">First Name</label>
              <input
                id="firstName"
                type="text"
                [(ngModel)]="firstName"
                name="firstName"
                placeholder="Dev"
              />
            </div>

            <div class="field">
              <label for="lastName">Last Name</label>
              <input
                id="lastName"
                type="text"
                [(ngModel)]="lastName"
                name="lastName"
                placeholder="User"
              />
            </div>

            <div class="field">
              <label for="email">Email</label>
              <input
                id="email"
                type="email"
                [(ngModel)]="email"
                name="email"
                placeholder="dev@lascodia.com"
                autocomplete="email"
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

          <p class="dev-note">Development token generator — no role claims.</p>
        }
      </div>
    </div>
  `,
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

      .logo {
        width: 56px;
        height: 56px;
        background: var(--accent);
        color: white;
        border-radius: var(--radius-md);
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 24px;
        font-weight: 700;
        margin: 0 auto var(--space-4);
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

  readonly mode = signal<'operator' | 'dev'>('operator');

  // Operator-mode fields
  accountId = '';
  brokerServer = '';
  password = '';

  // Developer-mode fields (shared-library dev token)
  userId = 'dev-user-1';
  firstName = 'Dev';
  lastName = 'User';
  email = 'dev@lascodia.com';

  loading = signal(false);
  error = signal<string | null>(null);

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
            this.router.navigate(['/dashboard']);
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

  onDevLogin() {
    this.loading.set(true);
    this.error.set(null);
    this.auth
      .login({
        userId: this.userId,
        firstName: this.firstName,
        lastName: this.lastName,
        email: this.email,
      })
      .subscribe({
        next: () => {
          this.router.navigate(['/dashboard']);
        },
        error: (err) => {
          this.error.set(err?.message || 'Login failed. Is the backend running?');
          this.loading.set(false);
        },
      });
  }
}
