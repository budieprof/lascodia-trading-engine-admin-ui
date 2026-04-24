import { Pipe, PipeTransform } from '@angular/core';

@Pipe({
  name: 'pips',
  standalone: true,
})
export class PipsPipe implements PipeTransform {
  transform(value: number | null | undefined, decimals = 1): string {
    if (value == null) return '-';
    return `${value.toFixed(decimals)} pips`;
  }
}
