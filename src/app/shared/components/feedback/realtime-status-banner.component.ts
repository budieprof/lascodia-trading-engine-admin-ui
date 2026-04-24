import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { HubConnectionState } from '@microsoft/signalr';
import { LucideAngularModule, RadioTower, WifiOff } from 'lucide-angular';

import { RealtimeService } from '@core/realtime/realtime.service';

/**
 * Surfaces the SignalR connection state. Silent when the hub is healthy
 * (Connected or freshly Connecting); shows an inline banner while reconnecting
 * — so operators know they're temporarily back on the polling fallback — and
 * a persistent one when the hub stays disconnected.
 *
 * Rendered in the app shell, directly under the offline banner so the two
 * stack cleanly when network + hub go down together.
 */
@Component({
  selector: 'app-realtime-status-banner',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideAngularModule],
  template: `
    @if (visible()) {
      <div
        class="banner"
        [class.reconnecting]="reconnecting()"
        [class.disconnected]="disconnected()"
        role="status"
        aria-live="polite"
      >
        @if (reconnecting()) {
          <lucide-icon [img]="RadioTower" size="16" strokeWidth="2" />
          <span>Live updates reconnecting…</span>
        } @else {
          <lucide-icon [img]="WifiOff" size="16" strokeWidth="2" />
          <span>Live updates offline. Data may be stale until the connection recovers.</span>
        }
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
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        border-bottom: 1px solid transparent;
      }
      .banner.reconnecting {
        background: rgba(0, 113, 227, 0.1);
        color: var(--accent);
        border-bottom-color: rgba(0, 113, 227, 0.2);
      }
      .banner.disconnected {
        background: rgba(255, 59, 48, 0.1);
        color: var(--loss);
        border-bottom-color: rgba(255, 59, 48, 0.2);
      }
    `,
  ],
})
export class RealtimeStatusBannerComponent {
  private readonly realtime = inject(RealtimeService);

  protected readonly RadioTower = RadioTower;
  protected readonly WifiOff = WifiOff;

  readonly reconnecting = computed(() => this.realtime.state() === HubConnectionState.Reconnecting);

  /**
   * Latches to `true` the first time the hub reports `Connected`. Guards the
   * disconnected banner so we don't flash it during cold boot (before the
   * first handshake completes, the state is also `Disconnected`).
   */
  private readonly hasConnectedOnce = signal(false);

  readonly disconnected = computed(
    () => this.realtime.state() === HubConnectionState.Disconnected && this.hasConnectedOnce(),
  );

  readonly visible = computed(() => this.reconnecting() || this.disconnected());

  constructor() {
    // Latch on first successful connect.
    effect(() => {
      if (this.realtime.state() === HubConnectionState.Connected) {
        this.hasConnectedOnce.set(true);
      }
    });
  }
}
