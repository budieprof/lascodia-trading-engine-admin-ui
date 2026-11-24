import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import { RecWatchProgressDto } from './watch-checklist.types';

/**
 * A watch's steps to fire in one line — "2/4" and a segmented mini bar (met steps green, the current one blue, a step
 * it died on red/amber), with the current step's name on hover or, when `showStep` is set, underneath. The compact form
 * of `app-watch-checklist`, for list rows on the monitors board.
 */
@Component({
  selector: 'app-watch-progress',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let p = progress();
    <div class="wp" [class]="'wp wp--' + p.state" [title]="tooltip()">
      <div class="wp-top">
        <span class="wp-count"
          ><b>{{ p.done }}</b
          ><span class="of">/{{ p.total }}</span></span
        >
        <span class="wp-bar" aria-hidden="true">
          @for (s of p.statuses; track $index) {
            <span class="seg" [class]="'seg seg--' + s"></span>
          }
        </span>
        @if (stateWord(); as w) {
          <span class="wp-state">{{ w }}</span>
        }
      </div>
      @if (showStep() && p.currentStep) {
        <span class="wp-step">{{ p.currentStep }}</span>
      }
      <span class="sr-only">{{ tooltip() }}</span>
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
        min-width: 120px;
        max-width: 220px;
      }
      .wp {
        display: flex;
        flex-direction: column;
        gap: 3px;
        min-width: 0;
      }
      .wp-top {
        display: flex;
        align-items: center;
        gap: 7px;
      }
      .wp-count {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-variant-numeric: tabular-nums;
        font-size: 12px;
        white-space: nowrap;
      }
      .wp-count b {
        font-weight: var(--font-semibold);
        color: var(--text-primary);
      }
      .of {
        color: var(--text-secondary);
      }
      .wp-bar {
        display: flex;
        gap: 2px;
        flex: 1;
        min-width: 44px;
        max-width: 96px;
      }
      .seg {
        flex: 1;
        height: 5px;
        border-radius: 999px;
        background: var(--bg-tertiary);
      }
      .seg--done {
        background: var(--profit);
      }
      .seg--current {
        background: var(--accent);
        animation: wp-breathe 1.8s ease-in-out infinite;
      }
      .seg--failed {
        background: var(--loss);
      }
      .seg--stopped {
        background: var(--warning);
      }
      .wp--fired .seg {
        background: var(--profit);
      }
      @keyframes wp-breathe {
        50% {
          opacity: 0.45;
        }
      }
      .wp-state {
        font-size: 10.5px;
        font-weight: var(--font-semibold);
        white-space: nowrap;
      }
      .wp--fired .wp-state {
        color: var(--profit);
      }
      .wp--broken .wp-state,
      .wp--error .wp-state {
        color: var(--loss);
      }
      .wp--expired .wp-state,
      .wp--cancelled .wp-state,
      .wp--paused .wp-state {
        color: var(--warning);
      }
      .wp-step {
        font-size: 11.5px;
        color: var(--text-secondary);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        overflow: hidden;
        clip: rect(0 0 0 0);
        white-space: nowrap;
      }
      @media (prefers-reduced-motion: reduce) {
        .seg--current {
          animation: none;
        }
      }
    `,
  ],
})
export class WatchProgressComponent {
  readonly progress = input.required<RecWatchProgressDto>();
  /** Show the current step's name under the bar (comfortable density). */
  readonly showStep = input(false);

  /** A word only when the watch is no longer simply waiting. */
  readonly stateWord = computed(() => {
    switch (this.progress().state) {
      case 'fired':
        return 'fired';
      case 'broken':
        return 'broke';
      case 'expired':
        return 'expired';
      case 'cancelled':
        return 'cancelled';
      case 'paused':
        return 'paused';
      case 'error':
        return 'error';
      default:
        return null;
    }
  });

  readonly tooltip = computed(() => {
    const p = this.progress();
    const head = `${p.done} of ${p.total} steps met`;
    return p.currentStep ? `${head} · ${p.currentStep}` : head;
  });
}
