import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';

import { ThemeService } from '@core/theme/theme.service';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';

import { reportPalette } from './report-charts';
import {
  DEFAULT_ROLLING_WINDOW,
  ROLLING_WINDOWS,
  buildRollingROptions,
  rollingR,
  type RPoint,
} from './rolling-metrics';

/**
 * U08 — rolling expectancy and rolling per-trade Sharpe, both in R, over the last N closed trades. Used on the Strategy
 * report's Overview and on a script strategy's Live tab. Shows nothing invented: with fewer R trades than the window it
 * says how many there are.
 */
@Component({
  selector: 'app-rolling-r-chart',
  standalone: true,
  imports: [ChartCardComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="rolling" data-testid="rolling-r">
      <label class="window">
        <span class="muted small">Window</span>
        <select
          class="field-input"
          aria-label="Rolling window in trades"
          (change)="window.set(+$any($event.target).value)"
        >
          @for (w of windows; track w) {
            <option [value]="w" [selected]="w === window()">last {{ w }} trades</option>
          }
        </select>
      </label>
      <app-chart-card
        [title]="title()"
        [subtitle]="subtitle()"
        [options]="options() ?? {}"
        [emptyMessage]="options() ? null : emptyMessage()"
        emptyHint="Trades without a stop on their losing side have no R and are not counted."
        alt="Rolling expectancy in R above and rolling Sharpe in R below, on a shared time axis"
        height="340px"
      />
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .rolling {
        position: relative;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .window {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        align-self: flex-end;
      }
      .muted {
        color: var(--text-secondary);
      }
      .small {
        font-size: var(--text-xs);
      }
    `,
  ],
})
export class RollingRChartComponent {
  private readonly theme = inject(ThemeService);

  /** Closed trades' R in close order. */
  readonly points = input.required<readonly RPoint[]>();
  /** Closed trades looked at (R or not), for the caption. */
  readonly closed = input<number | null>(null);
  readonly title = input('Rolling expectancy and Sharpe (R)');
  /** What the trades are, e.g. "backtest trades" or "live session trades". */
  readonly source = input('closed trades');

  readonly windows = ROLLING_WINDOWS;
  readonly window = signal<number>(DEFAULT_ROLLING_WINDOW);

  readonly series = computed(() => rollingR(this.points(), this.window()));
  readonly options = computed(() =>
    buildRollingROptions(this.series(), this.window(), reportPalette(this.theme.theme())),
  );
  readonly subtitle = computed(() => {
    const n = this.points().length;
    const closed = this.closed();
    const of = closed !== null && closed !== n ? ` of ${closed}` : '';
    return `Each point: the last ${this.window()} ${this.source()} with an R (${n}${of} have one). Dashed line = 0R.`;
  });
  readonly emptyMessage = computed(
    () =>
      `Needs at least ${this.window() + 1} ${this.source()} with an R — ${this.points().length} so far`,
  );
}
