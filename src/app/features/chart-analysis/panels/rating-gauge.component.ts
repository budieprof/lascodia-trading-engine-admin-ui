import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { gaugePosition } from './technicals';

// Dial geometry, in viewBox units (1:1 with CSS px at the sidebar's 160px).
// Measured off TradingView's gauge: a 6px stroke on a 73px radius, five equal
// round-capped segments with 3° gaps spanning the full half-circle, and a
// tapered needle ~0.7 R long whose round base rests ON the arcs' baseline.
const CX = 80;
const CY = 80;
const R = 73;
const STROKE = 6;
const DIAL_START = 0;
const DIAL_SPAN = 180;
const GAP = 3;
const SEG = (DIAL_SPAN - 4 * GAP) / 5;
/** A round cap overhangs the path end by half the stroke; trim the path so the VISIBLE arc keeps its extent. */
const CAP = ((STROKE / 2 / R) * 180) / Math.PI;
const NEEDLE_LENGTH = 52;
const NEEDLE_BASE = 4.5;

/** Point on the dial at `deg` degrees clockwise from its left (Strong sell) end. */
function dialPoint(deg: number): string {
  const a = (deg * Math.PI) / 180;
  return `${(CX - R * Math.cos(a)).toFixed(2)} ${(CY - R * Math.sin(a)).toFixed(2)}`;
}

const SEGMENTS = (['ss', 's', 'n', 'b', 'sb'] as const).map((cls, i) => {
  const from = DIAL_START + i * (SEG + GAP) + CAP;
  const to = DIAL_START + i * (SEG + GAP) + SEG - CAP;
  return { cls, d: `M ${dialPoint(from)} A ${R} ${R} 0 0 1 ${dialPoint(to)}` };
});

/**
 * TradingView's rating dial: five segments from Strong sell (dark red) to
 * Strong buy (dark blue) and a tapered needle. Presentational only — size it by
 * setting the host's width; it scales from the 160px the geometry was measured at.
 */
@Component({
  selector: 'app-rating-gauge',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg viewBox="0 0 160 82" role="img" [attr.aria-label]="label()">
      @for (seg of segments; track seg.cls) {
        <path class="seg" [class]="seg.cls" [attr.d]="seg.d" />
      }
      <g [attr.transform]="'translate(' + cx + ' ' + cy + ')'">
        <path
          class="needle"
          [attr.d]="needlePath"
          [style.transform]="'rotate(' + needleDeg() + 'deg)'"
        />
      </g>
    </svg>
  `,
  styles: [
    `
      :host {
        --tg-ss: #991f29;
        --tg-s: #f23645;
        --tg-n: #a8a8a8;
        --tg-b: #3179f5;
        --tg-sb: #1848cc;
        --tg-needle: #0f0f0f;
        display: block;
        width: 160px;
      }
      :host-context([data-theme='dark']) {
        --tg-needle: #dbdbdb;
      }
      svg {
        display: block;
        width: 100%;
        overflow: visible;
      }
      .seg {
        fill: none;
        stroke-width: 6;
        stroke-linecap: round;
      }
      .seg.ss {
        stroke: var(--tg-ss);
      }
      .seg.s {
        stroke: var(--tg-s);
      }
      .seg.n {
        stroke: var(--tg-n);
      }
      .seg.b {
        stroke: var(--tg-b);
      }
      .seg.sb {
        stroke: var(--tg-sb);
      }
      .needle {
        fill: var(--tg-needle);
        transition: transform 0.4s ease-out;
      }
      @media (prefers-reduced-motion: reduce) {
        .needle {
          transition: none;
        }
      }
    `,
  ],
})
export class RatingGaugeComponent {
  /** The rating in [−1, 1] (TradingView's scale); out-of-range values pin to the ends. */
  readonly rating = input.required<number>();
  /** Accessible name, e.g. "Summary: Sell". */
  readonly label = input('');

  /** Needle rotation, clockwise from pointing at the dial's Strong-sell end. */
  readonly needleDeg = computed(() => DIAL_START + DIAL_SPAN * gaugePosition(this.rating()));

  protected readonly segments = SEGMENTS;
  protected readonly cx = CX;
  /** The hub sits a base-radius above the dial centre, so it rests on the arcs' baseline. */
  protected readonly cy = CY - NEEDLE_BASE;
  /** Tapered wedge pointing left from a round base at the pivot; rotated into place. */
  protected readonly needlePath = `M ${-NEEDLE_LENGTH} 0 L 0 ${-NEEDLE_BASE} A ${NEEDLE_BASE} ${NEEDLE_BASE} 0 0 1 0 ${NEEDLE_BASE} Z`;
}
