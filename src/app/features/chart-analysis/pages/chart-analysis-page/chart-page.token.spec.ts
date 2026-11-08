import { describe, expect, it } from 'vitest';
import { signal } from '@angular/core';
import type { ChartAnalysisPageComponent } from './chart-analysis-page.component';
import { SIDE_PANE_KEYS, pageSlice } from './chart-page.token';

describe('US02 page slices (children no longer get the whole page)', () => {
  it('exposes only the listed members: signals as they are, methods bound to the page', () => {
    const symbol = signal('EURUSD');
    const page = {
      symbol,
      secret: signal('not for the legend'),
      label(this: { symbol: () => string }) {
        return `${this.symbol()}!`;
      },
    } as unknown as ChartAnalysisPageComponent;
    const slice = pageSlice(page, ['symbol', 'label'] as never[]) as unknown as Record<string, unknown>;
    expect(slice['symbol']).toBe(symbol);
    expect((slice['label'] as () => string)()).toBe('EURUSD!');
    expect('secret' in slice).toBe(false);
    expect(Object.keys(slice)).toEqual(['symbol', 'label']);
  });

  it('a section reads a short, listed set of the page', () => {
    expect(SIDE_PANE_KEYS.length).toBeLessThan(30);
    expect(SIDE_PANE_KEYS).toContain('details');
  });
});
