import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { ChartIconComponent } from '../icons/chart-icon.component';
import { nextChangeText, type MarketView } from './market-status';
import type { SymbolChip } from './symbol-chips';

/** UD11: the series choices a symbol offers — a continuous future's adjusted / raw pair, an equity's adjustment. */
export interface SeriesOptions {
  /** Continuous future: whether this is the back-adjusted series, and what its rolls are ("3 rolls", "no rolls recorded yet"). */
  continuous: { adjusted: boolean; rollsNote: string } | null;
  /** Equity / ETF: the adjustment asked for (null = the engine's default) and what the bars carry. */
  equity: { asked: 'none' | 'splits' | 'all' | null; applied: string | null } | null;
}

/**
 * The legend's market status (UD08: the engine's session state — pre / regular / post / break / closed — with a
 * countdown to the next open or close) and the chips saying what the bars are (UD07: kind, source, exchange, contract,
 * perpetual, volume unit, adjustment). The countdown ticks once a second only while there is one to show.
 */
@Component({
  selector: 'app-chart-market-chips',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ChartIconComponent],
  template: `
    @if (view(); as v) {
      <span
        class="market-status"
        [class]="'market-status ' + v.tone"
        [attr.data-kind]="v.kind"
        [title]="v.title"
        data-testid="market-status"
      >
        <app-chart-icon
          [name]="v.tone === 'open' ? 'live' : v.tone === 'closed' ? 'closed' : 'warning'"
          [size]="12"
        />
        {{ v.label }}
        @if (countdown(); as c) {
          <span class="countdown">· {{ c }}</span>
        }
      </span>
    }
    @if (options(); as o) {
      @if (o.continuous; as c) {
        <button
          type="button"
          class="chip opt"
          data-testid="series-adjusted-toggle"
          [title]="
            (c.adjusted
              ? 'Back-adjusted at each roll. Show the raw (unadjusted) series'
              : 'Raw prices with roll gaps. Show the back-adjusted series') +
            ' — ' +
            c.rollsNote
          "
          (click)="switchSeries.emit()"
        >
          {{ c.adjusted ? 'adjusted' : 'raw' }} ⇄
        </button>
        <span class="chip" data-chip="rolls">{{ c.rollsNote }}</span>
      }
      @if (o.equity; as e) {
        <select
          class="chip opt"
          aria-label="Corporate-action adjustment"
          title="Corporate-action adjustment of the 2h … 1M bars (1m … 1h are stored as traded). The engine applies it to the bars it lays out; it holds no corporate actions until they are loaded."
          data-testid="series-adjustment"
          [value]="e.asked ?? ''"
          (change)="adjustmentChange.emit($any($event.target).value || null)"
        >
          <option value="">default{{ e.applied ? ' (' + e.applied + ')' : '' }}</option>
          <option value="none">unadjusted</option>
          <option value="splits">splits</option>
          <option value="all">splits + dividends</option>
        </select>
      }
    }
    @for (chip of chips(); track chip.id) {
      <span class="chip" [class.warn]="chip.warn" [title]="chip.title" [attr.data-chip]="chip.id">{{
        chip.text
      }}</span>
    }
  `,
  styles: `
    :host {
      display: contents;
    }
    .market-status {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 11px;
      font-weight: 600;
    }
    .market-status.open {
      color: #26a69a;
    }
    .market-status.closed {
      color: var(--text-muted, #787b86);
    }
    .market-status.stale {
      color: #ffa726;
    }
    .countdown {
      font-weight: 400;
      font-variant-numeric: tabular-nums;
    }
    .chip {
      font-size: 10px;
      line-height: 1.4;
      padding: 0 5px;
      border-radius: 3px;
      border: 1px solid var(--border, rgba(120, 123, 134, 0.35));
      color: var(--text-muted, #787b86);
      white-space: nowrap;
      pointer-events: auto;
    }
    .chip.opt {
      cursor: pointer;
      background: transparent;
      font: inherit;
      font-size: 10px;
    }
    .chip.warn {
      color: #ffa726;
      border-color: rgba(255, 167, 38, 0.5);
    }
  `,
})
export class ChartMarketChipsComponent {
  readonly view = input<MarketView | null>(null);
  readonly chips = input<readonly SymbolChip[]>([]);
  readonly options = input<SeriesOptions | null>(null);
  /** Switch a continuous future between its adjusted and raw series. */
  readonly switchSeries = output<void>();
  /** An equity's adjustment picked (null = the engine's default). */
  readonly adjustmentChange = output<'none' | 'splits' | 'all' | null>();

  private readonly now = signal(Date.now());
  readonly countdown = computed(() => {
    const v = this.view();
    return v ? nextChangeText(v, this.now()) : null;
  });

  constructor() {
    let timer: ReturnType<typeof setInterval> | null = null;
    effect(() => {
      const ticking = this.view()?.nextAt != null;
      if (ticking && !timer) {
        this.now.set(Date.now());
        timer = setInterval(() => this.now.set(Date.now()), 1000);
      } else if (!ticking && timer) {
        clearInterval(timer);
        timer = null;
      }
    });
    inject(DestroyRef).onDestroy(() => {
      if (timer) clearInterval(timer);
    });
  }
}
