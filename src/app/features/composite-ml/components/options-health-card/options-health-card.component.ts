import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { catchError, map, of } from 'rxjs';

import { CompositeMLService } from '@core/services/composite-ml.service';
import type { CompositeMLOptionsDiagnosticDto } from '@core/api/api.types';
import { createPolledResource } from '@core/polling/polled-resource';

/**
 * Compact audit card surfacing the CompositeML options-health diagnostic
 * (PRD §5.1 FR-1.11). Drops on any page that wants the operator-visible
 * "are knob combinations sane?" check without scrolling to a separate
 * Tuning page — currently lives at the top of the Active Policies view.
 *
 * Renders nothing when the engine reports a clean configuration (empty
 * findings array). Renders a Warning-bordered card with collapsed details
 * when findings exist. 5-minute poll matches the cadence at which an
 * operator might realistically be editing config.
 */
@Component({
  selector: 'app-options-health-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (showCard()) {
      <section class="card" [class.has-warnings]="hasWarnings()">
        <header>
          <span class="icon" aria-hidden="true">
            {{ hasWarnings() ? '⚠' : 'ⓘ' }}
          </span>
          <div class="head-text">
            <strong
              >{{ findings().length }} options-health finding{{
                findings().length === 1 ? '' : 's'
              }}</strong
            >
            <span class="sub">Cross-knob diagnostic audit against the live generator options.</span>
          </div>
        </header>
        <ul class="findings">
          @for (f of findings(); track f.checkName) {
            <li [attr.data-severity]="f.severity">
              <span class="pill">{{ f.severity }}</span>
              <code class="check">{{ f.checkName }}</code>
              <span class="msg">{{ f.message }}</span>
            </li>
          }
        </ul>
      </section>
    }
  `,
  styles: [
    `
      .card {
        background: rgba(0, 113, 227, 0.04);
        border: 1px solid var(--accent);
        border-radius: var(--radius-md);
        padding: var(--space-3) var(--space-4);
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
      }
      .card.has-warnings {
        background: rgba(255, 149, 0, 0.06);
        border-color: #ff9500;
      }
      header {
        display: flex;
        align-items: center;
        gap: var(--space-3);
      }
      .icon {
        font-size: 20px;
        line-height: 1;
        color: var(--accent);
      }
      .card.has-warnings .icon {
        color: #c93400;
      }
      .head-text {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .head-text strong {
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      .sub {
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      ul.findings {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      ul.findings li {
        display: grid;
        grid-template-columns: 90px 180px 1fr;
        gap: var(--space-3);
        align-items: center;
        padding: 6px 0;
        border-top: 1px solid rgba(0, 0, 0, 0.06);
        font-size: var(--text-xs);
      }
      .pill {
        text-transform: uppercase;
        letter-spacing: 0.04em;
        font-weight: var(--font-semibold);
        padding: 2px 8px;
        border-radius: var(--radius-full);
        text-align: center;
      }
      [data-severity='Information'] .pill {
        background: rgba(0, 113, 227, 0.12);
        color: #0040dd;
      }
      [data-severity='Warning'] .pill {
        background: rgba(255, 149, 0, 0.16);
        color: #c93400;
      }
      .check {
        font-family: var(--font-mono);
        color: var(--text-secondary);
      }
      .msg {
        color: var(--text-primary);
      }
    `,
  ],
})
export class OptionsHealthCardComponent {
  private readonly compositeMl = inject(CompositeMLService);

  protected readonly resource = createPolledResource(
    () =>
      this.compositeMl.getOptionsHealth().pipe(
        map((res) => res.data ?? []),
        catchError(() => of<CompositeMLOptionsDiagnosticDto[]>([])),
      ),
    // 5 minutes — config edits are rare; this is a passive audit, not a feed.
    { intervalMs: 300_000 },
  );

  protected readonly findings = computed(() => this.resource.value() ?? []);
  protected readonly showCard = computed(() => this.findings().length > 0);
  protected readonly hasWarnings = computed(() =>
    this.findings().some((f) => f.severity === 'Warning'),
  );
}
