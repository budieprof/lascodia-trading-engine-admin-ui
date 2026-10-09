import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { ChartIconComponent } from '../icons/chart-icon.component';
import type { ReplayController } from './replay-controller';
import type { PaperSide } from './paper-broker';

/** Speeds offered, in steps per second. */
const SPEEDS = [1, 2, 4, 10, 30, 60] as const;

/**
 * Bar Replay's controls under the chart (CC-I4): where it starts (a click on the chart or a date and time), step /
 * play / pause / speed, intrabar steps, and the paper account — market buys and sells at the head with a stop and
 * target in pips, their P&L at the head and the closed trades' tally. Paper trades live in this browser tab only.
 *
 * The page owns the controller and the start (it may have to load history back to a date first); this component
 * reads the controller and asks it to move.
 */
@Component({
  selector: 'app-replay-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ChartIconComponent, DecimalPipe],
  template: `
    <div class="rp-row" role="toolbar" aria-label="Bar replay">
      <button
        type="button"
        class="rp-btn"
        [class.on]="replay().selecting()"
        (click)="pickStart.emit()"
        title="Choose the start on the chart: click a bar"
      >
        Select bar
      </button>
      <label class="rp-start" title="Start replay at a date and time on the chart's clock">
        Start at
        <input type="datetime-local" (change)="startAt.emit($any($event.target).value)" aria-label="Start replay at" />
      </label>
      <span class="rp-sep"></span>
      <button type="button" class="rp-btn" (click)="replay().step(-1)" title="Back one step (Shift+←)" aria-label="Back one step">
        <app-chart-icon name="step-back" [size]="18" />
      </button>
      <button
        type="button"
        class="rp-btn"
        (click)="replay().togglePlay()"
        [title]="replay().playing() ? 'Pause (Shift+↓)' : 'Play (Shift+↓)'"
        [attr.aria-label]="replay().playing() ? 'Pause' : 'Play'"
      >
        <app-chart-icon [name]="replay().playing() ? 'pause' : 'play'" [size]="18" />
      </button>
      <button type="button" class="rp-btn" (click)="replay().step(1)" title="Forward one step (Shift+→)" aria-label="Forward one step">
        <app-chart-icon name="step-forward" [size]="18" />
      </button>
      <input
        type="range"
        class="rp-scrub"
        min="1"
        [max]="total()"
        [value]="replay().cursor().index"
        (input)="replay().setIndex(+$any($event.target).value)"
        aria-label="Replay position"
      />
      <span class="rp-muted">{{ replay().cursor().index }} / {{ total() }}</span>
      <span class="rp-head" data-testid="replay-head">{{ headLabel() }}</span>
      <label class="rp-muted">
        Speed
        <select [value]="replay().speed()" (change)="replay().setSpeed(+$any($event.target).value)" aria-label="Steps per second">
          @for (s of speeds; track s) {
            <option [value]="s">{{ s }}/s</option>
          }
        </select>
      </label>
      @if (replay().intrabarSource(); as src) {
        <label class="rp-muted" [title]="'Step through each bar’s ' + (src === '1' ? '1-minute' : '1-hour') + ' bars'">
          <input type="checkbox" [checked]="replay().intrabar()" (change)="replay().setIntrabar($any($event.target).checked)" />
          {{ src === '1' ? '1m' : '1h' }} steps
        </label>
      }
      @if (replay().loadingIntrabar()) {
        <span class="rp-muted">Loading intrabar bars…</span>
      }
      <span class="rp-grow"></span>
      <button type="button" class="rp-btn" (click)="exit.emit()" title="Leave Bar Replay (paper trades end with it)">Exit</button>
    </div>
    @if (replay().intrabarNote(); as note) {
      <div class="rp-note" role="status">{{ note }}</div>
    }
    <div class="rp-row rp-paper" aria-label="Paper trading">
      <span class="rp-tag" title="Simulated in this browser tab only: nothing is sent to the engine or a broker">Paper</span>
      <label class="rp-muted">Lots <input class="rp-num" type="number" min="0.01" step="0.01" [value]="lots()" (input)="lots.set(+$any($event.target).value)" /></label>
      <label class="rp-muted">Stop <input class="rp-num" type="number" min="0" step="1" placeholder="pips" [value]="stopPips() ?? ''" (input)="stopPips.set(num($any($event.target).value))" /></label>
      <label class="rp-muted">Target <input class="rp-num" type="number" min="0" step="1" placeholder="pips" [value]="targetPips() ?? ''" (input)="targetPips.set(num($any($event.target).value))" /></label>
      <button type="button" class="rp-btn rp-buy" (click)="order('buy')" [disabled]="!head()">
        Buy {{ head() ? (head()!.close + head()!.spread | number: digitsFormat()) : '' }}
      </button>
      <button type="button" class="rp-btn rp-sell" (click)="order('sell')" [disabled]="!head()">
        Sell {{ head() ? (head()!.close | number: digitsFormat()) : '' }}
      </button>
      <span class="rp-muted" [title]="spreadTitle()">{{ spreadText() }}</span>
      @if (refusal(); as why) {
        <span class="rp-warn" role="alert">{{ why }}</span>
      }
    </div>
    @if (replay().openRows().length || tally().trades) {
      <div class="rp-row rp-trades">
        @for (t of replay().openRows(); track t.id) {
          <span class="rp-trade" [class.up]="t.money >= 0" [class.down]="t.money < 0">
            {{ t.side === 'buy' ? 'Buy' : 'Sell' }} {{ t.lots }} &#64; {{ t.entry | number: digitsFormat() }}
            @if (t.stop !== null) {
              · SL {{ t.stop | number: digitsFormat() }}
            }
            @if (t.target !== null) {
              · TP {{ t.target | number: digitsFormat() }}
            }
            · {{ signed(t.pips, 1) }} pips · {{ signed(t.money, 2) }} {{ currency() }}
            <button type="button" class="rp-link" (click)="replay().close(t.id)">Close</button>
          </span>
        }
        <span class="rp-grow"></span>
        <span class="rp-tally" data-testid="paper-tally">
          Closed {{ tally().trades }} · won {{ tally().wins }} · {{ signed(tally().pips, 1) }} pips ·
          {{ signed(tally().money, 2) }} {{ currency() }} · {{ signed(tally().r, 2) }}R
          @if (replay().openRows().length) {
            · open {{ signed(tally().openPips, 1) }} pips
          }
        </span>
        @if (replay().openRows().length) {
          <button type="button" class="rp-btn" (click)="replay().closeAll()">Close all</button>
        }
        <button type="button" class="rp-btn" (click)="replay().resetPaper()" title="Clear the paper trades">Reset</button>
      </div>
    }
  `,
  styles: `
    :host {
      display: block;
      flex: 0 0 auto;
      background: var(--tv-bg);
      font-size: 12px;
      border-top: 1px solid var(--border, #e6e9ef);
    }
    .rp-row {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
      padding: 4px 10px;
    }
    .rp-btn {
      border: 1px solid var(--border, #e6e9ef);
      border-radius: 6px;
      background: transparent;
      color: inherit;
      font: inherit;
      padding: 3px 8px;
      cursor: pointer;
    }
    .rp-btn:hover:not(:disabled) {
      background: var(--surface-hover, rgba(0, 0, 0, 0.05));
    }
    .rp-btn:disabled {
      opacity: 0.5;
      cursor: default;
    }
    .rp-btn.on {
      border-color: var(--tv-blue, #2962ff);
      color: var(--tv-blue, #2962ff);
    }
    .rp-buy {
      color: #26a69a;
      border-color: #26a69a;
    }
    .rp-sell {
      color: #ef5350;
      border-color: #ef5350;
    }
    select,
    input[type='datetime-local'],
    .rp-num {
      border: 1px solid var(--border, #e6e9ef);
      border-radius: 4px;
      background: transparent;
      color: inherit;
      font: inherit;
      padding: 2px 4px;
    }
    .rp-num {
      width: 64px;
    }
    .rp-start,
    label {
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .rp-scrub {
      flex: 1 1 120px;
      min-width: 100px;
    }
    .rp-muted {
      color: var(--text-muted, #787b86);
    }
    .rp-head {
      font-variant-numeric: tabular-nums;
    }
    .rp-sep {
      width: 1px;
      height: 18px;
      background: var(--border, #e6e9ef);
    }
    .rp-grow {
      flex: 1 1 auto;
    }
    .rp-tag {
      padding: 1px 6px;
      border-radius: 4px;
      background: #7e57c2;
      color: #fff;
      font-weight: 600;
    }
    .rp-note,
    .rp-warn {
      color: var(--tv-orange, #f57c00);
    }
    .rp-note {
      padding: 0 10px 4px;
    }
    .rp-trade {
      font-variant-numeric: tabular-nums;
    }
    .rp-trade.up {
      color: #26a69a;
    }
    .rp-trade.down {
      color: #ef5350;
    }
    .rp-tally {
      font-variant-numeric: tabular-nums;
    }
    .rp-link {
      border: none;
      background: none;
      color: var(--tv-blue, #2962ff);
      cursor: pointer;
      font: inherit;
      padding: 0 2px;
    }
  `,
})
export class ReplayPanelComponent {
  readonly replay = input.required<ReplayController>();
  /** The bars loaded (the scrubber's range). */
  readonly total = input.required<number>();
  /** The head's time as the page prints it. */
  readonly headLabel = input<string>('');
  /** Price digits of the symbol. */
  readonly digits = input<number>(5);
  /** The pip size, for the spread readout. */
  readonly pipSize = input<number>(0.0001);
  /** The quote currency the money P&L is in. */
  readonly currency = input<string>('');

  /** Choose the start with a click on the chart. */
  readonly pickStart = output<void>();
  /** Start at a `yyyy-mm-ddThh:mm` on the chart's clock. */
  readonly startAt = output<string>();
  readonly exit = output<void>();

  readonly speeds = SPEEDS;
  readonly lots = signal(0.1);
  readonly stopPips = signal<number | null>(null);
  readonly targetPips = signal<number | null>(null);
  /** Why the last order was refused. */
  readonly refusal = signal<string | null>(null);

  readonly head = computed(() => this.replay().headUnit());
  readonly tally = computed(() => this.replay().tally());
  readonly digitsFormat = computed(() => `1.${this.digits()}-${this.digits()}`);

  readonly spreadText = computed(() => {
    const points = this.replay().headSpreadPoints();
    if (points === null) return 'Spread: not recorded (0 charged)';
    const pips = (points * 10 ** -this.digits()) / (this.pipSize() || 1);
    return `Spread ${pips.toFixed(1)} pips`;
  });
  readonly spreadTitle = computed(() =>
    this.replay().headSpreadPoints() === null
      ? 'These bars carry no recorded spread: buys fill at the bid.'
      : 'The spread the broker recorded for the bar at the head (or the last one recorded before it): a buy pays it.',
  );

  order(side: PaperSide): void {
    this.refusal.set(this.replay().place(side, this.lots(), this.stopPips(), this.targetPips()));
  }

  num(raw: string): number | null {
    const v = Number(raw);
    return raw === '' || !Number.isFinite(v) || v <= 0 ? null : v;
  }

  signed(v: number, digits: number): string {
    return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(digits)}`;
  }
}
