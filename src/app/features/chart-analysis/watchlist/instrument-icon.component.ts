import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import { resolveInstrument } from '@core/instruments/instrument-math';
import type { InstrumentAssetClass } from '@core/instruments/instrument.types';
import { PairIconComponent, pairFlags } from './pair-icon.component';

/** A short badge per non-FX asset class (flags are for currencies only). */
export const ASSET_CLASS_BADGE: Readonly<
  Record<InstrumentAssetClass, { text: string; title: string }>
> = {
  Fx: { text: 'FX', title: 'Foreign exchange' },
  Future: { text: 'F', title: 'Futures' },
  Crypto: { text: '₿', title: 'Crypto' },
  Equity: { text: 'S', title: 'Stock' },
  Etf: { text: 'E', title: 'ETF' },
  Index: { text: 'I', title: 'Index' },
  Commodity: { text: 'C', title: 'Commodity' },
};

export const ASSET_CLASS_LABEL: Readonly<Record<InstrumentAssetClass, string>> = {
  Fx: 'FX',
  Future: 'Futures',
  Crypto: 'Crypto',
  Equity: 'Stocks',
  Etf: 'ETFs',
  Index: 'Indices',
  Commodity: 'Commodities',
};

/**
 * An instrument's icon (multi-asset WS7 7.3): the two currency flags for an FX pair (and a metal against a currency,
 * as before — `app-pair-icon`), a letter badge per asset class for anything else.
 */
@Component({
  selector: 'app-instrument-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PairIconComponent],
  template: `
    @if (flags()) {
      <app-pair-icon [symbol]="symbol()" [big]="big()" />
    } @else {
      <span
        class="ii"
        [class.big]="big()"
        [attr.data-ac]="assetClass()"
        [title]="badge().title"
        role="img"
        [attr.aria-label]="badge().title"
        >{{ badge().text }}</span
      >
    }
  `,
  styles: `
    :host {
      display: inline-flex;
      flex: none;
    }
    .ii {
      display: inline-grid;
      place-items: center;
      width: 18px;
      height: 18px;
      border-radius: 50%;
      font-size: 10px;
      font-weight: 700;
      line-height: 1;
      color: var(--tv-ink, currentColor);
      background: var(--tv-hover, rgba(127, 127, 127, 0.18));
    }
    .ii.big {
      width: 28px;
      height: 28px;
      font-size: 13px;
    }
  `,
})
export class InstrumentIconComponent {
  readonly symbol = input.required<string>();
  /** The asset class when the caller has the instrument; else resolved from the catalogue. */
  readonly assetClassIn = input<InstrumentAssetClass | null>(null, { alias: 'assetClass' });
  readonly big = input(false);

  readonly assetClass = computed<InstrumentAssetClass>(
    () => this.assetClassIn() ?? resolveInstrument(this.symbol()).assetClass,
  );
  /**
   * FX always goes to `app-pair-icon` (flags, or nothing when a currency has no artwork — exactly as before); a metal
   * quoted in a currency (XAUUSD) keeps its flags; anything else gets its asset-class badge.
   */
  readonly flags = computed(() => {
    const ac = this.assetClass();
    return ac === 'Fx' || (ac === 'Commodity' && !!pairFlags(this.symbol()));
  });
  readonly badge = computed(() => ASSET_CLASS_BADGE[this.assetClass()] ?? ASSET_CLASS_BADGE.Fx);
}
