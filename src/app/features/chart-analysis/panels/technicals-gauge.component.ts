import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import type { Ohlc } from '../indicators/math';
import { gaugePosition, technicalRating, type GroupRating, type RatingLabel } from './technicals';

// Dial geometry, in CSS px (the viewBox is 1:1). Measured off TradingView's
// right-panel gauge: a 6px stroke on a 73px radius, five equal round-capped
// segments with 3° gaps spanning the full half-circle, and a tapered needle
// ~0.7 R long whose round base rests ON the baseline the arcs end on.
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
 * TradingView-style technicals gauge: a five-segment half-dial from Strong sell
 * (dark red) to Strong buy (dark blue) with a tapered needle and the summary
 * label beneath, as in TradingView's symbol panel. "More technicals" opens the
 * buy / neutral / sell counts for the oscillators and moving averages — where
 * TradingView's button leads. Computed from the bars passed in (the chart's
 * current timeframe) — no fetch.
 */
@Component({
  selector: 'app-technicals-gauge',
  standalone: true,
  imports: [],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="tree-title">Technicals{{ timeframe() ? ' · ' + timeframe() : '' }}</div>
    @if (bars().length < 30) {
      <div class="pane-empty">Not enough bars to rate.</div>
    } @else {
      <svg
        viewBox="0 0 160 82"
        class="gauge"
        role="img"
        [attr.aria-label]="'Summary: ' + r().summary.label"
      >
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
      <div class="summary">{{ r().summary.label }}</div>
      <button
        type="button"
        class="more"
        [attr.aria-expanded]="expanded()"
        (click)="expanded.set(!expanded())"
      >
        {{ expanded() ? 'Hide details' : 'More technicals' }}
      </button>
      @if (expanded()) {
        <div class="groups">
          @for (g of groups(); track g.name) {
            <div class="group" [title]="tooltip(g.rating)">
              <div class="g-name">{{ g.name }}</div>
              <div class="g-label" [class]="cls(g.rating.label)">{{ g.rating.label }}</div>
              <div class="counts">
                <span class="down">Sell {{ g.rating.sell }}</span>
                <span class="muted">Neutral {{ g.rating.neutral }}</span>
                <span class="up">Buy {{ g.rating.buy }}</span>
              </div>
            </div>
          }
        </div>
      }
    }
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
        --tg-label: #4a4a4a;
        --tg-pill: #f2f2f2;
        --tg-pill-hover: #e6e6e6;
        --tg-pill-ink: #0f0f0f;
        display: block;
        padding-bottom: 12px;
        font-size: 12px;
      }
      :host-context([data-theme='dark']) {
        --tg-needle: #dbdbdb;
        --tg-label: #b8b8b8;
        --tg-pill: #2e2e2e;
        --tg-pill-hover: #3a3a3a;
        --tg-pill-ink: #dbdbdb;
      }
      .tree-title {
        padding: 2px 10px 6px;
        font-weight: 600;
        color: var(--text-muted, #787b86);
      }
      .pane-empty {
        padding: 10px 12px;
        color: var(--text-muted, #787b86);
      }
      .gauge {
        display: block;
        width: 160px;
        margin: 8px auto 0;
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
      .summary {
        margin-top: 18px;
        text-align: center;
        font-size: 20px;
        font-weight: 600;
        line-height: 24px;
        color: var(--tg-label);
      }
      .more {
        display: block;
        height: 22px;
        margin: 16px auto 0;
        padding: 0 14px;
        border: 0;
        border-radius: 11px;
        background: var(--tg-pill);
        color: var(--tg-pill-ink);
        font: inherit;
        font-size: 12px;
        cursor: pointer;
      }
      .more:hover {
        background: var(--tg-pill-hover);
      }
      .groups {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 6px;
        padding: 12px 12px 0;
      }
      .group {
        text-align: center;
      }
      .g-name {
        color: var(--text-muted, #787b86);
      }
      .g-label {
        font-weight: 600;
      }
      .counts {
        display: flex;
        flex-direction: column;
        font-variant-numeric: tabular-nums;
        font-size: 11px;
      }
      .up {
        color: var(--tg-b);
      }
      .down {
        color: var(--tg-s);
      }
      .muted {
        color: var(--text-muted, #787b86);
      }
    `,
  ],
})
export class TechnicalsGaugeComponent {
  /** Ascending bars of the chart's current timeframe. */
  readonly bars = input.required<readonly Ohlc[]>();
  /** Optional label for the title (e.g. "1H"). */
  readonly timeframe = input<string | null>(null);

  /** Whether the oscillator / moving-average counts are open. */
  protected readonly expanded = signal(false);

  readonly r = computed(() => technicalRating(this.bars()));

  readonly groups = computed(() => [
    { name: 'Oscillators', rating: this.r().oscillators },
    { name: 'Moving averages', rating: this.r().movingAverages },
  ]);

  /** Needle rotation, clockwise from pointing at the dial's Strong-sell end. */
  readonly needleDeg = computed(
    () => DIAL_START + DIAL_SPAN * gaugePosition(this.r().summary.rating),
  );

  protected readonly segments = SEGMENTS;
  protected readonly cx = CX;
  /** The hub sits a base-radius above the dial centre, so it rests on the arcs' baseline. */
  protected readonly cy = CY - NEEDLE_BASE;
  /** Tapered wedge pointing left from a round base at the pivot; rotated into place. */
  protected readonly needlePath = `M ${-NEEDLE_LENGTH} 0 L 0 ${-NEEDLE_BASE} A ${NEEDLE_BASE} ${NEEDLE_BASE} 0 0 1 0 ${NEEDLE_BASE} Z`;

  protected cls(label: RatingLabel): string {
    return label.endsWith('buy') || label === 'Buy'
      ? 'up'
      : label.endsWith('sell') || label === 'Sell'
        ? 'down'
        : 'muted';
  }

  protected tooltip(g: GroupRating): string {
    return g.votes
      .map((v) => `${v.name}: ${v.value === null ? 'n/a' : v.value.toFixed(5)} → ${v.vote}`)
      .join('\n');
  }
}
