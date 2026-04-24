import { ChangeDetectionStrategy, Component, OnInit, inject } from '@angular/core';
import { PaperTradingService } from '@core/services/paper-trading.service';
import { LucideAngularModule, FlaskConical } from 'lucide-angular';

@Component({
  selector: 'app-paper-mode-banner',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideAngularModule],
  template: `
    @if (service.isPaperMode()) {
      <div class="banner" role="status" aria-live="polite">
        <lucide-icon [img]="FlaskConical" size="16" strokeWidth="2" />
        <span
          ><strong>Paper Trading mode is active.</strong> Orders route to a simulated broker; no
          real money is at risk.</span
        >
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
        border-bottom: 1px solid rgba(255, 149, 0, 0.2);
      }
      strong {
        font-weight: var(--font-semibold);
        margin-right: 4px;
      }
    `,
  ],
})
export class PaperModeBannerComponent implements OnInit {
  protected readonly FlaskConical = FlaskConical;
  protected readonly service = inject(PaperTradingService);

  ngOnInit(): void {
    this.service.getStatus().subscribe({
      error: () => {
        /* status banner silent on error */
      },
    });
  }
}
