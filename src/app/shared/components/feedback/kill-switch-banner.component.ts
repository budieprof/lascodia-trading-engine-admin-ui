import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { catchError, EMPTY, exhaustMap, filter, timer } from 'rxjs';
import { RouterLink } from '@angular/router';
import { LucidePower } from '@lucide/angular';
import { KillSwitchService } from '@core/services/kill-switch.service';
import { AuthService } from '@core/auth/auth.service';
import { Permission } from '@core/auth/permissions.generated';

@Component({
  selector: 'app-kill-switch-banner',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucidePower, RouterLink],
  template: `
    @if (service.isGlobalEngaged()) {
      <div class="banner" role="alert" aria-live="assertive">
        <svg lucidePower [size]="16" [strokeWidth]="2"></svg>
        <span>
          <strong>Global Kill Switch is engaged.</strong>
          No new signals or orders will be generated until disengaged.
        </span>
        <a routerLink="/kill-switches" class="action">Manage</a>
      </div>
    }
  `,
  styles: [
    `
      .banner {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        padding: 10px var(--space-5);
        background: rgba(255, 59, 48, 0.12);
        color: var(--loss);
        font-size: var(--text-sm);
        border-bottom: 1px solid rgba(255, 59, 48, 0.2);
      }
      strong {
        font-weight: var(--font-semibold);
        margin-right: 4px;
      }
      .action {
        margin-left: auto;
        padding: 4px 12px;
        border-radius: var(--radius-full);
        background: var(--loss);
        color: white;
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
      }
      .action:hover {
        opacity: 0.9;
      }
    `,
  ],
})
export class KillSwitchBannerComponent implements OnInit {
  private static readonly POLL_MS = 30_000;

  protected readonly service = inject(KillSwitchService);
  private readonly auth = inject(AuthService);
  private readonly destroyRef = inject(DestroyRef);

  ngOnInit(): void {
    // `/admin/kill-switch/global` needs `access.operator` (p0-authz endpoint map). Only fetch when
    // the person holds it — otherwise the engine answers 403 on every page load and the browser
    // logs the failure regardless of our `catchError`. A session without permissions holds
    // nothing (there is no "no roles = full access" fallback any more).
    if (!this.auth.hasPermission(Permission.AccessOperator)) return;

    // Re-check on a cadence: no realtime event carries the switch, so a switch engaged by
    // another operator (or the engine) used to stay invisible here until a full reload.
    timer(0, KillSwitchBannerComponent.POLL_MS)
      .pipe(
        filter(() => typeof document === 'undefined' || document.visibilityState !== 'hidden'),
        exhaustMap(() => this.service.getGlobal().pipe(catchError(() => EMPTY))),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe();
  }
}
