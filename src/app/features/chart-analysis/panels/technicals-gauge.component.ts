import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import type { Ohlc } from '../indicators/math';
import { RatingGaugeComponent } from './rating-gauge.component';
import { technicalRating } from './technicals';

/**
 * The symbol panel's technicals widget, as in TradingView's: the summary dial,
 * its label, and "More technicals", which opens the full Technicals view over
 * the chart. Computed from the bars passed in (the chart's current timeframe) —
 * no fetch.
 */
@Component({
  selector: 'app-technicals-gauge',
  standalone: true,
  imports: [RatingGaugeComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="tree-title">Technicals{{ timeframe() ? ' · ' + timeframe() : '' }}</div>
    @if (bars().length < 30) {
      <div class="pane-empty">Not enough bars to rate.</div>
    } @else {
      <app-rating-gauge
        class="gauge"
        [rating]="summary().rating"
        [label]="'Summary: ' + summary().label"
      />
      <div class="summary">{{ summary().label }}</div>
      <button type="button" class="more" (click)="more.emit()">More technicals</button>
    }
  `,
  styles: [
    `
      :host {
        --tg-label: #4a4a4a;
        --tg-pill: #f2f2f2;
        --tg-pill-hover: #e6e6e6;
        --tg-pill-ink: #0f0f0f;
        display: block;
        padding-bottom: 12px;
        font-size: 12px;
      }
      :host-context([data-theme='dark']) {
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
        margin: 8px auto 0;
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
    `,
  ],
})
export class TechnicalsGaugeComponent {
  /** Ascending bars of the chart's current timeframe. */
  readonly bars = input.required<readonly Ohlc[]>();
  /** Optional label for the title (e.g. "1H"). */
  readonly timeframe = input<string | null>(null);
  /** "More technicals": open the full Technicals view. */
  readonly more = output<void>();

  readonly summary = computed(() => technicalRating(this.bars()).summary);
}
