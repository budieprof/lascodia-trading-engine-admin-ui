import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';

import { ApiService } from '@core/api/api.service';
import { AuthService } from '@core/auth/auth.service';
import { NotificationService } from '@core/notifications/notification.service';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';

@Component({
  selector: 'app-change-password-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, PageHeaderComponent],
  template: `
    <div class="page">
      <app-page-header
        title="Change Password"
        subtitle="Choose a strong password — at least 8 characters with upper, lower, and a digit."
      />

      @if (mustChange()) {
        <div class="banner">You must change your password before continuing.</div>
      }

      <section class="card">
        <form class="form" (ngSubmit)="submit()">
          <label class="field">
            <span class="label">Current password</span>
            <input
              class="input"
              type="password"
              [(ngModel)]="currentPassword"
              name="currentPassword"
              autocomplete="current-password"
              required
            />
          </label>
          <label class="field">
            <span class="label">New password</span>
            <input
              class="input"
              type="password"
              [(ngModel)]="newPassword"
              name="newPassword"
              autocomplete="new-password"
              required
            />
          </label>
          <label class="field">
            <span class="label">Confirm new password</span>
            <input
              class="input"
              type="password"
              [(ngModel)]="confirmPassword"
              name="confirmPassword"
              autocomplete="new-password"
              required
            />
          </label>

          <ul class="rules">
            <li [class.ok]="ruleLength()">At least 8 characters</li>
            <li [class.ok]="ruleUpper()">An uppercase letter</li>
            <li [class.ok]="ruleLower()">A lowercase letter</li>
            <li [class.ok]="ruleDigit()">A number</li>
            <li [class.ok]="ruleMatch()">New password and confirmation match</li>
          </ul>

          <div class="form-actions">
            <button type="submit" class="btn btn-primary" [disabled]="pending() || !valid()">
              {{ pending() ? 'Updating…' : 'Change password' }}
            </button>
          </div>
        </form>
      </section>
    </div>
  `,
  styles: [
    `
      .page {
        padding: var(--space-2) 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
        max-width: 520px;
      }
      .banner {
        background: rgba(255, 149, 0, 0.12);
        border: 1px solid var(--loss);
        color: var(--text-primary);
        border-radius: var(--radius-md);
        padding: var(--space-3) var(--space-4);
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
      }
      .card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: hidden;
      }
      .form {
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
        padding: var(--space-4);
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: var(--space-1);
      }
      .label {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        font-weight: var(--font-medium);
      }
      .input {
        padding: 8px 10px;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-sm);
        outline: none;
      }
      .input:focus {
        border-color: var(--accent);
      }
      .rules {
        list-style: none;
        margin: 0;
        padding: var(--space-2) var(--space-3);
        background: var(--bg-tertiary);
        border-radius: var(--radius-sm);
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .rules li {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        position: relative;
        padding-left: 18px;
      }
      .rules li::before {
        content: '○';
        position: absolute;
        left: 0;
      }
      .rules li.ok {
        color: var(--profit);
      }
      .rules li.ok::before {
        content: '●';
      }
      .form-actions {
        display: flex;
        justify-content: flex-end;
      }
      .btn {
        padding: 8px 16px;
        border-radius: var(--radius-full);
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        border: 1px solid transparent;
        cursor: pointer;
      }
      .btn-primary {
        background: var(--accent);
        color: #fff;
      }
      .btn-primary:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
    `,
  ],
})
export class ChangePasswordPageComponent {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly notify = inject(NotificationService);
  private readonly router = inject(Router);

  readonly mustChange = this.auth.mustChangePassword;
  readonly pending = signal(false);

  currentPassword = '';
  newPassword = '';
  confirmPassword = '';

  // Plain methods (not computed) — they read template-bound plain fields, which
  // aren't signals, so they must re-evaluate every change-detection cycle.
  ruleLength(): boolean {
    return this.newPassword.length >= 8;
  }
  ruleUpper(): boolean {
    return /[A-Z]/.test(this.newPassword);
  }
  ruleLower(): boolean {
    return /[a-z]/.test(this.newPassword);
  }
  ruleDigit(): boolean {
    return /[0-9]/.test(this.newPassword);
  }
  ruleMatch(): boolean {
    return this.newPassword.length > 0 && this.newPassword === this.confirmPassword;
  }

  valid(): boolean {
    return (
      this.currentPassword.length > 0 &&
      this.ruleLength() &&
      this.ruleUpper() &&
      this.ruleLower() &&
      this.ruleDigit() &&
      this.ruleMatch()
    );
  }

  submit(): void {
    if (!this.valid() || this.pending()) return;
    this.pending.set(true);
    this.api
      .postEnvelope<string>('/admin/auth/change-password', {
        currentPassword: this.currentPassword,
        newPassword: this.newPassword,
      })
      .subscribe({
        next: (msg) => {
          this.pending.set(false);
          this.auth.clearMustChangePassword();
          this.notify.success(msg || 'Password changed');
          void this.router.navigate(['/dashboard']);
        },
        error: (err) => {
          this.pending.set(false);
          this.notify.error(err?.message ?? 'Failed to change password');
        },
      });
  }
}
