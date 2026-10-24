import { Injectable, inject } from '@angular/core';

import {
  distanceInUnits,
  distanceUnitLabel,
  distanceUnitSize,
  formatDistance,
  formatMoney,
  formatPrice,
  formatQuantity,
} from './instrument-math';
import { InstrumentsService } from './instruments.service';
import type { InstrumentDto } from './instrument.types';

/**
 * The console's ONE instrument formatter (multi-asset WS7 7.1): price at the instrument's decimals, distance in its
 * display unit (pips for FX only, else ticks / points), quantity with its unit, money in a currency. Every method reads
 * the catalogue signal, so a `computed()` calling it follows the catalogue load.
 */
@Injectable({ providedIn: 'root' })
export class InstrumentFormatService {
  private readonly instruments = inject(InstrumentsService);

  instrument(symbol: string | null | undefined): InstrumentDto {
    return this.instruments.get(symbol);
  }

  /** One display unit in price — the pip for FX. */
  unitSize(symbol: string | null | undefined): number {
    return distanceUnitSize(this.instrument(symbol));
  }

  /** `pips`, `ticks`, `points`, … */
  unitLabel(symbol: string | null | undefined): string {
    return distanceUnitLabel(this.instrument(symbol));
  }

  priceDecimals(symbol: string | null | undefined): number {
    return this.instrument(symbol).priceDecimals;
  }

  price(symbol: string | null | undefined, value: number | null | undefined): string {
    return formatPrice(this.instrument(symbol), value);
  }

  /** A price difference as a number of display units. */
  distanceValue(
    symbol: string | null | undefined,
    priceDelta: number,
    refPrice?: number | null,
  ): number {
    return distanceInUnits(this.instrument(symbol), priceDelta, refPrice);
  }

  /** A price difference as text: `12.3 pips`, `4.0 ticks`. */
  distance(
    symbol: string | null | undefined,
    priceDelta: number | null | undefined,
    decimals = 1,
    refPrice?: number | null,
  ): string {
    return formatDistance(this.instrument(symbol), priceDelta, decimals, refPrice);
  }

  quantity(symbol: string | null | undefined, qty: number | null | undefined): string {
    return formatQuantity(this.instrument(symbol), qty);
  }

  money(value: number | null | undefined, currency: string | null | undefined): string {
    return formatMoney(value, currency);
  }
}
