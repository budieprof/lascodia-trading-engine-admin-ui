import { ChangeDetectionStrategy, Component, OnInit, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideAngularModule, Power } from 'lucide-angular';
import { KillSwitchService } from '@core/services/kill-switch.service';

@Component({
  selector: 'app-kill-switch-banner',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideAngularModule, RouterLink],
  template: `
    @if (service.isGlobalEngaged()) {
      <div class="banner" role="alert" aria-live="assertive">
        <lucide-icon [img]="Power" size="16" strokeWidth="2" />
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
  protected readonly Power = Power;
  protected readonly service = inject(KillSwitchService);

  ngOnInit(): void {
    this.service.getGlobal().subscribe({
      error: () => {
        /* silent on error */
      },
    });
  }
}
