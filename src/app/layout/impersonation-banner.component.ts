import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';

import { AuthService } from '@core/auth/auth.service';
import { BrowserLocation } from '@core/browser/browser-location';
import { DEFAULT_POST_LOGIN_ROUTE } from '@core/auth/return-url';
import { NotificationService } from '@core/notifications/notification.service';
import { IamApiService } from '@features/iam/iam-api.service';
import { errorText, reportable } from '@features/iam/iam.logic';

/**
 * While platform staff view the console as someone else (ADR-0031 §6), this stays on every page:
 * who is being viewed, by whom, and whether it is read-only — with the way out. Ending it returns
 * the session to the staff member and reloads the console.
 */
@Component({
  selector: 'app-impersonation-banner',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (impersonation(); as imp) {
      <div class="banner" role="alert" aria-live="polite">
        <span class="text">
          <strong>Viewing as {{ viewed() }}</strong>
          @if (tenant()) {
            in {{ tenant() }}
          }
          — by {{ imp.actorName || 'platform staff' }}.
          {{ imp.readOnly ? 'Read-only: nothing can be changed.' : 'Changes are allowed and recorded.' }}
        </span>
        <button type="button" class="end" [disabled]="busy()" (click)="end()">
          {{ busy() ? 'Ending…' : 'End impersonation' }}
        </button>
      </div>
    }
  `,
  styles: [
    `
      .banner {
        display: flex;
        align-items: center;
        gap: var(--space-3);
        flex-wrap: wrap;
        padding: 10px var(--space-5);
        background: rgba(175, 82, 222, 0.14);
        border-bottom: 1px solid rgba(175, 82, 222, 0.35);
        color: var(--text-primary);
        font-size: var(--text-sm);
      }
      .text {
        flex: 1;
        min-width: 0;
      }
      .end {
        padding: 5px 14px;
        border-radius: var(--radius-full);
        border: none;
        background: #af52de;
        color: #fff;
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        font-family: inherit;
        cursor: pointer;
      }
      .end:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }
    `,
  ],
})
export class ImpersonationBannerComponent {
  private readonly auth = inject(AuthService);
  private readonly iam = inject(IamApiService);
  private readonly browser = inject(BrowserLocation);
  private readonly notify = inject(NotificationService);

  readonly impersonation = this.auth.impersonation;
  readonly viewed = computed(() => this.auth.user()?.firstName || 'another user');
  readonly tenant = computed(() => this.auth.activeTenant()?.name ?? null);
  readonly busy = signal(false);

  end(): void {
    if (this.busy()) return;
    this.busy.set(true);
    this.iam.endImpersonation().subscribe({
      next: () => this.browser.assign(DEFAULT_POST_LOGIN_ROUTE),
      error: (e) => {
        this.busy.set(false);
        if (reportable(e)) this.notify.error(errorText(e, 'Impersonation did not end. Sign out to end it.'));
      },
    });
  }
}
