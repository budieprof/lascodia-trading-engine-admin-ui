import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { filter, take } from 'rxjs';

import { NotificationService } from '@core/notifications/notification.service';
import { SIGNIN_ERROR_PARAM, splitSignInError } from './auth.guard';
import { signInErrorMessage } from './bff.types';
import { StepUpService } from './step-up.service';

/**
 * After a step-up sign-in (contract C3.2) the person is back on the page where the engine refused
 * the action. This banner offers to finish it — one deliberate click — or to drop it. Also reports
 * a step-up that came back without a second factor (`signin_error` on a signed-in page).
 */
@Component({
  selector: 'app-step-up-banner',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (stepUp.pending(); as p) {
      <div class="banner" role="status">
        <span class="text">
          <strong>Second factor confirmed.</strong>
          Finish what you started: <code>{{ p.label }}</code>?
        </span>
        <span class="actions">
          <button type="button" class="btn ghost" (click)="stepUp.discard()" [disabled]="stepUp.busy()">
            Discard
          </button>
          <button type="button" class="btn primary" (click)="stepUp.retry()" [disabled]="stepUp.busy()">
            {{ stepUp.busy() ? 'Finishing…' : 'Finish now' }}
          </button>
        </span>
      </div>
    } @else if (stepUp.failed(); as f) {
      <div class="banner warn" role="alert">
        <span class="text">
          The sign-in did not confirm a second factor, so <code>{{ f.label }}</code> was not done.
        </span>
        <span class="actions">
          <button type="button" class="btn ghost" (click)="stepUp.discard()">Dismiss</button>
        </span>
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
        background: rgba(10, 132, 255, 0.1);
        border-bottom: 1px solid rgba(10, 132, 255, 0.25);
        color: var(--text-primary);
        font-size: var(--text-sm);
      }
      .banner.warn {
        background: rgba(255, 149, 0, 0.1);
        border-bottom-color: rgba(255, 149, 0, 0.3);
      }
      .text {
        flex: 1;
        min-width: 0;
      }
      code {
        font-size: var(--text-xs);
        padding: 1px 6px;
        border-radius: var(--radius-sm);
        background: var(--bg-tertiary);
      }
      .actions {
        display: inline-flex;
        gap: var(--space-2);
      }
      .btn {
        padding: 5px 14px;
        border-radius: var(--radius-full);
        border: 1px solid var(--border);
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        font-family: inherit;
        cursor: pointer;
      }
      .btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .btn.ghost {
        background: transparent;
        color: var(--text-primary);
      }
      .btn.primary {
        background: var(--accent);
        border-color: var(--accent);
        color: #fff;
      }
    `,
  ],
})
export class StepUpBannerComponent {
  protected readonly stepUp = inject(StepUpService);
  private readonly router = inject(Router);
  private readonly notify = inject(NotificationService);

  constructor() {
    this.stepUp.restore();
    this.reportSignInError();
  }

  /** A step-up that failed still lands on a signed-in page, carrying `signin_error`. */
  private reportSignInError(): void {
    if (typeof location === 'undefined' || !location.search.includes(SIGNIN_ERROR_PARAM)) return;
    const { url, error } = splitSignInError(`${location.pathname}${location.search}${location.hash}`);
    if (!error) return;
    this.notify.error(signInErrorMessage(error) ?? 'Sign-in did not complete.');
    // Drop the param once the current navigation has settled, so a reload does not repeat it.
    this.router.events
      .pipe(
        filter((e) => e instanceof NavigationEnd),
        take(1),
      )
      .subscribe(() => void this.router.navigateByUrl(url, { replaceUrl: true }));
  }
}
