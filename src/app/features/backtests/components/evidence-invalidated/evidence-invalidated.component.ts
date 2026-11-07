import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { DatePipe } from '@angular/common';

import {
  EVIDENCE_INVALIDATED_NOTE,
  evidenceInvalidation,
  type EvidenceInvalidationFields,
} from '../../run-provenance';

/**
 * A backtest run the engine has excluded from evidence after the fact (`evidenceInvalidatedReason`): a compact badge for
 * grids / headers (`mode="badge"`), or the full note with the engine's reason and date (`mode="notice"`). Renders nothing
 * for a valid run or when the engine build does not send the field.
 */
@Component({
  selector: 'app-evidence-invalidated',
  standalone: true,
  imports: [DatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (invalidation(); as inv) {
      @if (mode() === 'badge') {
        <span
          class="badge"
          data-testid="evidence-invalidated-badge"
          [attr.title]="inv.reason + ' — ' + note"
          >Excluded from evidence</span
        >
      } @else {
        <section class="notice" role="note" data-testid="evidence-invalidated-notice">
          <span class="badge">Excluded from evidence</span>
          <p class="reason">{{ inv.reason }}</p>
          <p class="note">
            {{ note }}
            @if (inv.atUtc) {
              Invalidated {{ inv.atUtc | date: 'yyyy-MM-dd HH:mm' : 'UTC' }} UTC.
            }
          </p>
        </section>
      }
    }
  `,
  styles: [
    `
      :host {
        display: contents;
      }
      .badge {
        display: inline-flex;
        align-items: center;
        padding: 1px 8px;
        border-radius: 999px;
        border: 1px solid color-mix(in srgb, var(--warning) 45%, transparent);
        background: color-mix(in srgb, var(--warning) 14%, transparent);
        color: var(--text-primary);
        font-size: var(--text-xs);
        font-weight: 600;
        white-space: nowrap;
      }
      .notice {
        display: flex;
        flex-direction: column;
        gap: var(--space-1);
        padding: var(--space-3);
        border-radius: var(--radius-md);
        border: 1px solid color-mix(in srgb, var(--warning) 45%, transparent);
        background: color-mix(in srgb, var(--warning) 8%, var(--bg-secondary));
      }
      .notice .badge {
        align-self: flex-start;
      }
      .reason {
        margin: 0;
        font-weight: 600;
        color: var(--text-primary);
      }
      .note {
        margin: 0;
        font-size: var(--text-sm);
        color: var(--text-secondary);
      }
    `,
  ],
})
export class EvidenceInvalidatedComponent {
  readonly run = input<EvidenceInvalidationFields | null | undefined>(null);
  readonly mode = input<'badge' | 'notice'>('badge');

  protected readonly note = EVIDENCE_INVALIDATED_NOTE;
  protected readonly invalidation = computed(() => evidenceInvalidation(this.run()));
}
