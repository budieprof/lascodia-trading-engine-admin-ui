import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
} from '@angular/core';

import { AuthService } from '@core/auth/auth.service';
import { PresenceService } from '@core/presence/presence.service';

/**
 * Shows a small indicator of how many other operators are viewing the same
 * page. Drop on any feature component; pass `routeKey` (usually the route
 * path) to scope presence.
 *
 * Handles the lifecycle automatically — enters the presence room on mount,
 * leaves on destroy. Callers don't need to touch `PresenceService` directly.
 *
 * Hidden when the count including the current user is ≤1.
 */
@Component({
  selector: 'app-presence-badge',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (otherCount() > 0) {
      <span class="badge" [attr.aria-label]="otherCount() + ' other operators viewing this page'">
        <span class="dot" aria-hidden="true"></span>
        {{ otherCount() }} other{{ otherCount() === 1 ? '' : 's' }}
      </span>
    }
  `,
  styles: [
    `
      .badge {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 3px 10px;
        background: rgba(10, 132, 255, 0.12);
        color: var(--accent);
        border-radius: var(--radius-full);
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
      }
      .dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: var(--accent);
        animation: pulse 2s ease-in-out infinite;
      }
      @keyframes pulse {
        0%,
        100% {
          opacity: 1;
        }
        50% {
          opacity: 0.4;
        }
      }
    `,
  ],
})
export class PresenceBadgeComponent {
  private readonly presence = inject(PresenceService);
  private readonly auth = inject(AuthService);
  private readonly destroyRef = inject(DestroyRef);

  readonly routeKey = input.required<string>();

  private readonly present = computed(() => this.presence.watch(this.routeKey())());

  /**
   * Count of *other* operators — subtract 1 for the current user if they
   * appear in the set. The server adds the inviter themselves to the group
   * so peers see them; we want the badge to show "N others", not "N total".
   */
  readonly otherCount = computed(() => {
    const all = this.present();
    const mine = this.currentAccountId();
    if (mine == null) return all.length;
    return all.filter((id) => id !== mine).length;
  });

  constructor() {
    // Enter on mount, leave on destroy. Re-enter when the routeKey changes
    // (e.g. navigating from /strategies/42 → /strategies/43 on the same
    // component instance).
    effect(() => {
      const key = this.routeKey();
      this.presence.enter(key);
    });
    this.destroyRef.onDestroy(() => {
      void this.presence.leave(this.routeKey());
    });
  }

  private currentAccountId(): number | null {
    const user = this.auth.user();
    if (!user) return null;
    const parsed = Number(user.passportId);
    return Number.isFinite(parsed) ? parsed : null;
  }
}
