import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { fromEvent, merge } from 'rxjs';
import { LucideWifiOff } from '@lucide/angular';

@Component({
  selector: 'app-offline-banner',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideWifiOff],
  template: `
    @if (offline()) {
      <div class="banner" role="status" aria-live="polite">
        <svg lucideWifiOff [size]="16" [strokeWidth]="2"></svg>
        <span>You are offline. Some features may be unavailable.</span>
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
        background: rgba(255, 149, 0, 0.12);
        color: var(--warning);
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        border-bottom: 1px solid rgba(255, 149, 0, 0.2);
      }
    `,
  ],
})
export class OfflineBannerComponent {
  private readonly destroyRef = inject(DestroyRef);

  readonly offline = signal(typeof navigator !== 'undefined' && !navigator.onLine);

  constructor() {
    merge(fromEvent(window, 'online'), fromEvent(window, 'offline'))
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.offline.set(!navigator.onLine));
  }
}
