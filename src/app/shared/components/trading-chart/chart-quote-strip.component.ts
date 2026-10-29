import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import type { LivePriceDto } from '@core/api/api.types';

/** Unrealised P&L summed across the symbol's open positions, as the trading chart computes it. */
export interface OpenPnlBadge {
  usd: number;
  count: number;
  display: string;
  sign: 1 | 0 | -1;
}

/** The trading chart's toolbar badges: live bid/ask, the candle-close countdown and open P&L. */
@Component({
  selector: 'app-chart-quote-strip',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './chart-quote-strip.component.scss',
  template: `
    @if (livePrice()) {
      <div class="live-price-display">
        <span class="live-label">Live</span>
        <span class="live-dot"></span>
        <span
          class="live-bid"
          [class.up]="priceDirection() === 'up'"
          [class.down]="priceDirection() === 'down'"
        >
          {{ livePrice()!.bid.toFixed(pricePrecision()) }}
        </span>
        <span class="live-separator">/</span>
        <span class="live-ask">{{ livePrice()!.ask.toFixed(pricePrecision()) }}</span>
        <span class="live-spread">{{ livePrice()!.spread.toFixed(1) }} sp</span>
      </div>
    }
    <div
      class="candle-countdown"
      [class.imminent]="candleCountdown().startsWith('00:0')"
      [title]="'Time remaining until the current ' + timeframe() + ' candle closes (mm:ss)'"
    >
      <span class="countdown-label">{{ timeframe() }} closes in</span>
      <span class="countdown-value">{{ candleCountdown() }}</span>
    </div>
    @if (openPnl(); as pnl) {
      <div
        class="open-pnl"
        [class.gain]="pnl.sign > 0"
        [class.loss]="pnl.sign < 0"
        [title]="
          'Live unrealised P&L summed across ' + pnl.count + ' open position(s) on ' + symbol()
        "
      >
        <span class="countdown-label">Open P&L · {{ pnl.count }} pos</span>
        <span class="countdown-value">{{ pnl.display }}</span>
      </div>
    }
  `,
})
export class ChartQuoteStripComponent {
  readonly livePrice = input.required<LivePriceDto | null>();
  readonly priceDirection = input.required<'up' | 'down' | 'none'>();
  readonly pricePrecision = input.required<number>();
  readonly candleCountdown = input.required<string>();
  readonly timeframe = input.required<string>();
  readonly symbol = input.required<string>();
  readonly openPnl = input.required<OpenPnlBadge | null>();
}
