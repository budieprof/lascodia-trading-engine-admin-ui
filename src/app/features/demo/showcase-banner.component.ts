import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';

import { AuthService } from '@core/auth/auth.service';

/**
 * While the console acts in the demonstration organisation (engine `TenantKind.Demo`), every page says
 * so: its data is recorded and replayed, and it cannot trade (the engine refuses every account of it on
 * every order, enrollment and sign-in path).
 */
@Component({
  selector: 'app-showcase-banner',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `
    @if (showcase()) {
      <div class="banner" role="note">
        <strong>Demonstration organisation</strong> — recorded data, replayed; nothing here is live and
        trading is switched off.
        <a routerLink="/demo">Open the recorded-data replay</a>
      </div>
    }
  `,
  styles: [
    `
      .banner {
        padding: 8px var(--space-5);
        background: rgba(180, 83, 9, 0.14);
        border-bottom: 1px solid rgba(180, 83, 9, 0.4);
        font-size: var(--text-sm);
      }
      a {
        margin-left: var(--space-2);
        color: var(--accent);
      }
    `,
  ],
})
export class ShowcaseBannerComponent {
  private readonly auth = inject(AuthService);
  readonly showcase = computed(() => this.auth.activeTenant()?.kind === 'Demo');
}
