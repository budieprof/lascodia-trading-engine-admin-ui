import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import { preflightBadgeOf } from './preflight-badge';

const ICON = { pass: '✓', warn: '!', fail: '✕', neutral: '–' } as const;

/**
 * The engine's dry-run verdict on an assistant approval card (`args.preflight`), as a small pill
 * with the details on hover. Renders nothing for cards that are never pre-checked. Display only:
 * the card's approve / dismiss are not touched.
 */
@Component({
  selector: 'app-preflight-badge',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (badge(); as pf) {
      <div class="pf" [attr.data-tone]="pf.tone">
        <span class="pill" [title]="pf.title" [attr.aria-label]="'Pre-check: ' + pf.label"
          >{{ icon(pf.tone) }} {{ pf.label }}</span
        >
        @if (pf.details.length > 0) {
          <ul>
            @for (d of pf.details; track $index) {
              <li>{{ d }}</li>
            }
          </ul>
        }
      </div>
    }
  `,
  styles: [
    `
      .pf {
        --pf: var(--text-secondary);
        margin: 0 0 var(--space-2);
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .pf[data-tone='pass'] {
        --pf: var(--profit);
      }
      .pf[data-tone='warn'] {
        --pf: var(--warning);
      }
      .pf[data-tone='fail'] {
        --pf: var(--loss);
      }
      .pill {
        display: inline-block;
        padding: 1px 8px;
        border-radius: 9px;
        border: 1px solid color-mix(in srgb, var(--pf) 50%, transparent);
        background: color-mix(in srgb, var(--pf) 8%, transparent);
        color: var(--pf);
        cursor: help;
      }
      ul {
        margin: 4px 0 0;
        padding-left: 18px;
      }
    `,
  ],
})
export class PreflightBadgeComponent {
  readonly toolName = input<string | null | undefined>(null);
  readonly toolArgsJson = input<string | null | undefined>(null);

  protected readonly badge = computed(() => preflightBadgeOf(this.toolName(), this.toolArgsJson()));

  protected icon(tone: keyof typeof ICON): string {
    return ICON[tone];
  }
}
