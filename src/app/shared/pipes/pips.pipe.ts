import { Pipe, PipeTransform } from '@angular/core';

import { distanceUnitLabel, resolveInstrument } from '@core/instruments/instrument-math';

/**
 * A distance already expressed in display units: `12.3 pips`. With a symbol (`value | pips:1:symbol`) the unit is the
 * instrument's (pips for FX, ticks / points otherwise — multi-asset WS7); without one it is pips, as it always was.
 * Impure so a label resolved before the instrument catalogue loaded follows it.
 */
@Pipe({
  name: 'pips',
  standalone: true,
  pure: false,
})
export class PipsPipe implements PipeTransform {
  transform(value: number | null | undefined, decimals = 1, symbol?: string | null): string {
    if (value == null) return '-';
    const unit = symbol ? distanceUnitLabel(resolveInstrument(symbol)) : 'pips';
    return `${value.toFixed(decimals)} ${unit}`;
  }
}
