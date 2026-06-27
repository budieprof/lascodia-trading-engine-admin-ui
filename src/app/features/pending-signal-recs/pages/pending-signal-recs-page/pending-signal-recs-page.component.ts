import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ParkedRecsCockpitComponent } from '../../components/parked-recs-cockpit/parked-recs-cockpit.component';

/**
 * Standalone operator cockpit for the pending-signal-reval mechanic.
 * Thin page wrapper around <app-parked-recs-cockpit> — the same cockpit
 * is also embedded as the "Parked recs" tab on the Trade Signals page.
 */
@Component({
  selector: 'app-pending-signal-recs-page',
  standalone: true,
  imports: [RouterLink, ParkedRecsCockpitComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <header class="page-header">
        <div>
          <h1>Pending-signal recs</h1>
          <p class="muted small">
            LLM recommendations held back from materialising as TradeSignals — waiting for price to
            reach the recommended entry, then re-validated via a fresh LLM call or a same-direction
            sibling rec.
            <a routerLink="/ea-instances" class="link">Engine-wide gate</a> toggled on the EA
            instances page.
          </p>
        </div>
      </header>
      <app-parked-recs-cockpit />
    </div>
  `,
  styles: [
    `
      .page {
        padding: 1rem 1.25rem;
      }
      .page-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 1rem;
        margin-bottom: 1rem;
      }
      h1 {
        font-size: 1.25rem;
        margin: 0 0 0.25rem;
      }
      .muted {
        color: var(--text-muted, #888);
      }
      .small {
        font-size: 0.85rem;
      }
      .link {
        color: var(--link, #4a8cff);
        text-decoration: none;
      }
      .link:hover {
        text-decoration: underline;
      }
    `,
  ],
})
export class PendingSignalRecsPageComponent {}
