import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { ParkedRecsCockpitComponent } from '../../components/parked-recs-cockpit/parked-recs-cockpit.component';

/**
 * Standalone operator cockpit for the pending-signal-reval mechanic.
 * Thin page wrapper around <app-parked-recs-cockpit> — the same cockpit
 * is also embedded as the "Parked recs" tab on the Trade Signals page.
 *
 * Uses the shared page header like every sibling page; a hand-rolled header
 * with its own 1.25rem inset sat the title 20px right of every other page's.
 */
@Component({
  selector: 'app-pending-signal-recs-page',
  standalone: true,
  imports: [RouterLink, PageHeaderComponent, ParkedRecsCockpitComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <app-page-header
        title="Pending-signal recs"
        subtitle="LLM recommendations held back from materialising as TradeSignals — waiting for price to reach the recommended entry, then re-validated via a fresh LLM call or a same-direction sibling rec."
      >
        <a
          routerLink="/ea-instances"
          class="btn btn-secondary"
          title="The engine-wide parking gate is toggled on the EA instances page"
        >
          Engine-wide gate →
        </a>
      </app-page-header>
      <app-parked-recs-cockpit />
    </div>
  `,
  styles: [
    `
      /* No global .btn-secondary exists (styles.scss only adds the press feel), so
         the header link rendered as bare text. Same pill as Signal exits. */
      .btn {
        height: 36px;
        padding: 0 var(--space-4);
        border-radius: var(--radius-full);
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        display: inline-flex;
        align-items: center;
        text-decoration: none;
      }
      .btn-secondary {
        background: var(--bg-secondary);
        color: var(--text-primary);
        border: 1px solid var(--border);
      }
      .btn-secondary:hover {
        background: var(--bg-tertiary);
      }
      .page {
        padding: var(--space-2) 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
      }
    `,
  ],
})
export class PendingSignalRecsPageComponent {}
