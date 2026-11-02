import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { DomSanitizer, type SafeHtml } from '@angular/platform-browser';

import { resolveInstrument } from '@core/instruments/instrument-math';
import type { InstrumentAssetClass } from '@core/instruments/instrument.types';
import { PairIconComponent, pairFlags } from './pair-icon.component';
import { symbolArt } from './symbol-art';

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
 * as before — `app-pair-icon`); a coin, index flag, energy mark or stock monogram for everything else
 * ({@link symbolArt}); a letter badge per asset class only when there is no artwork.
 */
@Component({
  selector: 'app-instrument-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PairIconComponent],
  template: `
    @if (flags()) {
      <app-pair-icon [symbol]="symbol()" [big]="big()" />
    } @else if (art(); as a) {
      <span
        class="ia"
        [class.big]="big()"
        [class.duo]="!!a.back"
        role="img"
        [attr.aria-label]="a.label"
        [title]="a.label"
      >
        @if (a.back) {
          <span class="ia-f ia-back" [innerHTML]="a.back"></span>
        }
        <span class="ia-f ia-front" [innerHTML]="a.front"></span>
      </span>
    } @else {
      <span
        class="ii"
        [class.big]="big()"
        [attr.data-ac]="resolvedClass()"
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
    /* Same geometry as app-pair-icon: one full disc, or base top-left in front of quote bottom-right. */
    .ia {
      position: relative;
      display: inline-block;
      width: 18px;
      height: 18px;
    }
    .ia.big {
      width: 28px;
      height: 28px;
    }
    .ia-f {
      position: absolute;
      inset: 0;
      border-radius: 50%;
      overflow: hidden;
    }
    /* A faint rim so a white-field disc (Japan's flag, Microsoft) keeps its edge on the light theme. */
    .ia:not(.duo) .ia-f::after {
      content: '';
      position: absolute;
      inset: 0;
      border-radius: 50%;
      box-shadow: inset 0 0 0 1px rgba(127, 127, 127, 0.28);
      pointer-events: none;
    }
    .ia.duo .ia-f {
      inset: auto;
      width: 72%;
      height: 72%;
      box-shadow: 0 0 0 1px var(--surface, #fff);
    }
    .ia.duo .ia-back {
      right: 0;
      bottom: 0;
    }
    .ia.duo .ia-front {
      left: 0;
      top: 0;
    }
  `,
})
export class InstrumentIconComponent {
  private readonly sanitizer = inject(DomSanitizer);
  readonly symbol = input.required<string>();
  /** The asset class when the caller has the instrument; else resolved from the catalogue. */
  readonly assetClass = input<InstrumentAssetClass | null>(null);
  readonly big = input(false);

  readonly resolvedClass = computed<InstrumentAssetClass>(
    () => this.assetClass() ?? resolveInstrument(this.symbol()).assetClass,
  );
  /**
   * An FX pair or a metal quoted in a currency (XAUUSD) shows its two flags when both have artwork; an FX pair
   * without artwork (USDSEK) falls through to the "FX" badge rather than an empty gap.
   */
  readonly flags = computed(() => {
    const ac = this.resolvedClass();
    return (ac === 'Fx' || ac === 'Commodity') && !!pairFlags(this.symbol());
  });
  /** Trusted static artwork from `symbol-art.ts` only — never user input. */
  readonly art = computed<{ front: SafeHtml; back: SafeHtml | null; label: string } | null>(() => {
    if (this.flags()) return null;
    const ac = this.resolvedClass();
    const inst = resolveInstrument(this.symbol());
    const a = symbolArt(this.symbol(), ac, inst.quoteCurrency ?? null);
    if (!a) return null;
    const wrap = (svg: string): SafeHtml =>
      this.sanitizer.bypassSecurityTrustHtml(
        `<svg viewBox="0 0 32 32" width="100%" height="100%" style="display:block" aria-hidden="true">${svg}</svg>`,
      );
    return { front: wrap(a.front), back: a.back ? wrap(a.back) : null, label: a.label };
  });
  readonly badge = computed(() => ASSET_CLASS_BADGE[this.resolvedClass()] ?? ASSET_CLASS_BADGE.Fx);
}
