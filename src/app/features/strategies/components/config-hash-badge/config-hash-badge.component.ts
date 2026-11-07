import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import { hashRelation, shortHash } from '../../research-cockpit/research-cockpit.model';

/**
 * C1 version stamp — the configuration hash a signal, position, run or pipeline was made by (lower-hex sha256 of the
 * strategy's configuration), shortened to 8 digits. With the strategy's current hash it says "current" or "older
 * version"; without a stamp (legacy rows, or an engine that does not send it) it renders nothing — never a guess.
 */
@Component({
  selector: 'app-config-hash-badge',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (short()) {
      <span
        class="hash"
        [attr.data-relation]="relation()"
        [title]="title()"
        data-testid="config-hash"
        >cfg {{ short() }}
        @if (relation() === 'older') {
          · older version
        } @else if (relation() === 'current') {
          · current
        }
      </span>
    }
  `,
  styles: [
    `
      .hash {
        display: inline-flex;
        padding: 1px 6px;
        border-radius: 4px;
        font-family: var(--font-mono, ui-monospace, monospace);
        font-size: var(--text-xs);
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        white-space: nowrap;
      }
      .hash[data-relation='older'] {
        color: var(--warning, #b25000);
      }
    `,
  ],
})
export class ConfigHashBadgeComponent {
  readonly hash = input<string | null | undefined>(null);
  readonly currentHash = input<string | null | undefined>(null);

  readonly short = computed(() => shortHash(this.hash()));
  readonly relation = computed(() => hashRelation(this.hash(), this.currentHash()));
  readonly title = computed(
    () =>
      `Configuration ${this.hash()}` +
      (this.relation() === 'older'
        ? ' — not the strategy’s current configuration'
        : this.relation() === 'current'
          ? ' — the strategy’s current configuration'
          : ''),
  );
}
