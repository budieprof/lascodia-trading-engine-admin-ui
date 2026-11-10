import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import { preflightBadgeOf, replayLineOf } from './preflight-badge';

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
        @if (replay(); as rp) {
          <details class="replay" [attr.data-tone]="rp.tone">
            <summary
              [title]="'The engine replayed the watch script this change arms over the candles it was written for.'"
            >
              {{ rp.text }}
            </summary>
            <ul>
              @for (l of rp.legs; track $index) {
                <li>
                  <strong>{{ l.label }}</strong> — {{ outcomeWord(l.outcome) }}
                  @if (l.window) {
                    <span class="muted"> · {{ l.window }}</span>
                  }
                  @if (l.bars > 0) {
                    <span class="muted"> · {{ l.bars }} candles</span>
                  }
                  @if (l.summary) {
                    <div>{{ l.summary }}</div>
                  }
                </li>
              }
            </ul>
          </details>
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
      .replay {
        margin-top: 4px;
      }
      .replay summary {
        cursor: pointer;
        color: var(--pf);
      }
      .replay[data-tone='pass'] summary {
        color: var(--profit);
      }
      .replay[data-tone='fail'] summary {
        color: var(--loss);
      }
      .replay[data-tone='neutral'] summary {
        color: var(--text-secondary);
      }
      .muted {
        color: var(--text-tertiary);
      }
    `,
  ],
})
export class PreflightBadgeComponent {
  readonly toolName = input<string | null | undefined>(null);
  readonly toolArgsJson = input<string | null | undefined>(null);

  protected readonly badge = computed(() => preflightBadgeOf(this.toolName(), this.toolArgsJson()));
  protected readonly replay = computed(() => replayLineOf(this.toolArgsJson()));

  protected outcomeWord(o: string): string {
    return o === 'passed'
      ? 'would have caught the setup'
      : o === 'blocked'
        ? 'would have missed the setup'
        : 'could not be replayed';
  }

  protected icon(tone: keyof typeof ICON): string {
    return ICON[tone];
  }
}
