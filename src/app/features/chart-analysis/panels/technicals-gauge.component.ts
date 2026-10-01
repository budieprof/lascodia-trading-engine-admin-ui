import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { Ohlc } from '../indicators/math';
import { technicalRating, type GroupRating, type RatingLabel } from './technicals';

const LABELS: RatingLabel[] = ['Strong sell', 'Sell', 'Neutral', 'Buy', 'Strong buy'];

/**
 * TradingView-style technicals gauge: a half-dial from Strong sell to Strong
 * buy with the summary needle, plus buy / neutral / sell counts for the moving
 * averages and the oscillators. Computed from the bars passed in (the chart's
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
      <svg viewBox="0 0 200 112" class="gauge" role="img" [attr.aria-label]="'Summary: ' + r().summary.label">
        @for (seg of segments; track seg.label) {
          <path class="seg" [attr.d]="seg.d" [class]="seg.cls" [class.on]="seg.label === r().summary.label" />
        }
        <line
          class="needle"
          x1="100"
          y1="100"
          [attr.x2]="needle().x"
          [attr.y2]="needle().y"
        />
        <circle cx="100" cy="100" r="4" class="hub" />
      </svg>
      <div class="summary" [class]="cls(r().summary.label)">{{ r().summary.label }}</div>
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
  `,
  styles: [
    `
      :host {
        display: block;
        font-size: 12px;
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
        width: 180px;
        margin: 0 auto;
      }
      .seg {
        opacity: 0.35;
      }
      .seg.on {
        opacity: 1;
      }
      .seg.ss {
        fill: #ef5350;
      }
      .seg.s {
        fill: #f28b82;
      }
      .seg.n {
        fill: var(--text-muted, #787b86);
      }
      .seg.b {
        fill: #80cbc4;
      }
      .seg.sb {
        fill: #26a69a;
      }
      .needle {
        stroke: var(--text, #131722);
        stroke-width: 2;
        stroke-linecap: round;
      }
      .hub {
        fill: var(--text, #131722);
      }
      .summary {
        text-align: center;
        font-weight: 600;
        font-size: 14px;
      }
      .groups {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 6px;
        padding: 8px 12px 0;
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
        color: #26a69a;
      }
      .down {
        color: #ef5350;
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

  readonly r = computed(() => technicalRating(this.bars()));

  readonly groups = computed(() => [
    { name: 'Oscillators', rating: this.r().oscillators },
    { name: 'Moving averages', rating: this.r().movingAverages },
  ]);

  /** Needle tip; rating −1 → left (180°), +1 → right (0°). */
  readonly needle = computed(() => {
    const a = Math.PI * (1 - (this.r().summary.rating + 1) / 2);
    return { x: 100 + 70 * Math.cos(a), y: 100 - 70 * Math.sin(a) };
  });

  /** Five equal annular sectors, left (Strong sell) to right (Strong buy). */
  protected readonly segments = LABELS.map((label, i) => {
    const a0 = Math.PI * (1 - i / 5);
    const a1 = Math.PI * (1 - (i + 1) / 5);
    const R = 92;
    const r = 70;
    const p = (rad: number, a: number) =>
      `${(100 + rad * Math.cos(a)).toFixed(2)} ${(100 - rad * Math.sin(a)).toFixed(2)}`;
    const d = `M ${p(R, a0)} A ${R} ${R} 0 0 1 ${p(R, a1)} L ${p(r, a1)} A ${r} ${r} 0 0 0 ${p(r, a0)} Z`;
    return { label, d, cls: ['ss', 's', 'n', 'b', 'sb'][i] };
  });

  protected cls(label: RatingLabel): string {
    return label.endsWith('buy') || label === 'Buy' ? 'up' : label.endsWith('sell') || label === 'Sell' ? 'down' : 'muted';
  }

  protected tooltip(g: GroupRating): string {
    return g.votes
      .map((v) => `${v.name}: ${v.value === null ? 'n/a' : v.value.toFixed(5)} → ${v.vote}`)
      .join('\n');
  }
}
