import { describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';

import { CompareDialogComponent } from './compare-dialog.component';
import type { CompareSeriesSpec } from './compare-series';

function render(series: CompareSeriesSpec[] = []) {
  TestBed.configureTestingModule({ imports: [CompareDialogComponent] });
  const fixture = TestBed.createComponent(CompareDialogComponent);
  const cmp = fixture.componentInstance;
  (cmp as any).series = signal(series);
  (cmp as any).symbols = signal(['EURUSD', 'GBPUSD', 'USDJPY']);
  (cmp as any).chartSymbol = signal('EURUSD');
  const add = vi.fn();
  const remove = vi.fn();
  cmp.add.subscribe(add);
  cmp.remove.subscribe(remove);
  fixture.detectChanges();
  return { fixture, cmp, add, remove, host: fixture.nativeElement as HTMLElement };
}

describe('CompareDialogComponent (CC-I12)', () => {
  it('adds a compare symbol, in a colour not yet used', () => {
    const { cmp, add } = render([{ id: 'a', kind: 'compare', symbols: ['USDJPY'], color: '#FF6D00' }]);
    expect(cmp.problem()).toMatch(/Pick the symbol/);
    cmp.symA.set('GBPUSD');
    cmp.submit();
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ kind: 'compare', symbols: ['GBPUSD'], color: '#AB47BC' }));
  });

  it('a ratio defaults A to the chart’s symbol; a spread carries its multiplier', () => {
    const { cmp, add } = render();
    cmp.kind.set('spread');
    cmp.symB.set('GBPUSD');
    cmp.mult.set(1.5);
    cmp.submit();
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ symbols: ['EURUSD', 'GBPUSD'], mult: 1.5 }));
  });

  it('a basket takes its members and weights, and refuses an incomplete one', () => {
    const { cmp, add } = render();
    cmp.kind.set('basket');
    cmp.setMember(0, 'EURUSD', 2);
    expect(cmp.problem()).toMatch(/at least two/);
    cmp.setMember(1, 'GBPUSD', 1);
    cmp.submit();
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ symbols: ['EURUSD', 'GBPUSD'], weights: [2, 1] }));
  });

  it('lists what is on the chart with a way to remove it', () => {
    const { fixture, host, remove } = render([{ id: 'r1', kind: 'ratio', symbols: ['EURUSD', 'GBPUSD'], color: '#FF6D00' }]);
    fixture.detectChanges();
    expect(host.querySelector('.cd-name')?.textContent).toContain('EURUSD ÷ GBPUSD');
    (host.querySelector('.cd-list .cd-link') as HTMLButtonElement).click();
    expect(remove).toHaveBeenCalledWith('r1');
  });
});
