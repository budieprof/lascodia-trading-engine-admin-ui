import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';

import type { RecExpiryDto } from '../../trade-recommendations.types';
import { HOUR, MIN, RecClock, expiryElapsedPct, expiryTone, shortSpan } from './rec-expiry.util';

/**
 * The list-card form of `app-rec-expiry`: one line — "Expires in 5h 42m · Watch #12 stops" — over a thin bar that
 * drains as the window runs out, in the same calm / soon / urgent colours, seconds shown only in the last hour. Once
 * time has run out: "Expired 3h ago · Filing window closed", muted.
 */
@Component({
  selector: 'app-rec-expiry-chip',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let e = expiry();
    <div class="xc" [class]="'xc xc--' + tone()" [title]="e.binding.detail">
      <div class="line">
        <span class="ico" aria-hidden="true">{{ tone() === 'ended' ? '⌛' : '⏱' }}</span>
        @if (tone() === 'ended') {
          <span class="lead">Expired {{ ago() }} ago</span>
        } @else {
          <span class="lead"
            >Expires in <b class="mono">{{ left() }}</b></span
          >
        }
        <span class="what">· {{ e.binding.title }}</span>
      </div>
      @if (tone() !== 'ended') {
        <span class="bar" aria-hidden="true"
          ><span class="fill" [style.width.%]="remainingPct()"></span
        ></span>
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
        min-width: 0;
      }
      .xc {
        --tone: var(--accent);
        display: flex;
        flex-direction: column;
        gap: 5px;
        padding: 7px 10px;
        border-radius: var(--radius-sm, 6px);
        background: color-mix(in srgb, var(--tone) 9%, transparent);
        font-size: 12px;
      }
      .xc--soon {
        --tone: var(--warning);
      }
      .xc--urgent {
        --tone: var(--loss);
      }
      .xc--ended {
        --tone: var(--text-secondary);
        background: var(--bg-tertiary);
      }
      .line {
        display: flex;
        align-items: baseline;
        gap: 6px;
        min-width: 0;
        white-space: nowrap;
      }
      .ico {
        font-size: 12px;
      }
      .xc--urgent .ico {
        animation: xc-pulse 1s ease-in-out infinite;
      }
      @keyframes xc-pulse {
        50% {
          opacity: 0.35;
        }
      }
      .lead {
        color: var(--tone);
        font-weight: var(--font-semibold);
      }
      .xc--ended .lead {
        font-weight: normal;
      }
      .mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-variant-numeric: tabular-nums;
        color: var(--text-primary);
      }
      .what {
        color: var(--text-secondary);
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .bar {
        display: block;
        height: 3px;
        border-radius: 999px;
        background: var(--bg-tertiary);
        overflow: hidden;
      }
      .fill {
        display: block;
        height: 100%;
        border-radius: inherit;
        background: var(--tone);
        transition: width 0.9s linear;
      }
      @media (prefers-reduced-motion: reduce) {
        .fill {
          transition: none;
        }
        .xc--urgent .ico {
          animation: none;
        }
      }
    `,
  ],
})
export class RecExpiryChipComponent {
  readonly expiry = input.required<RecExpiryDto>();

  private readonly now = inject(RecClock).now;
  private readonly leftMs = computed(() => Date.parse(this.expiry().binding.atUtc) - this.now());

  readonly tone = computed(() => expiryTone(this.expiry(), this.now()));
  readonly remainingPct = computed(() => 100 - expiryElapsedPct(this.expiry(), this.now()));

  /** "1d 4h", "5h 42m", then "12m 08s" in the last hour. */
  readonly left = computed(() => {
    const ms = Math.max(0, this.leftMs());
    if (ms >= HOUR) return shortSpan(ms);
    return `${Math.floor(ms / MIN)}m ${String(Math.floor((ms % MIN) / 1000)).padStart(2, '0')}s`;
  });

  readonly ago = computed(() => shortSpan(this.leftMs()));
}
