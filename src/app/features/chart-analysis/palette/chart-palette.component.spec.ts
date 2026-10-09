import { describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';

import { ChartPaletteComponent } from './chart-palette.component';
import type { PaletteAction } from './chart-palette';

const action = (title: string, confirm = false): PaletteAction => ({
  id: title,
  title,
  detail: '',
  keywords: '',
  commandId: 'chart.x',
  args: {},
  confirm,
});

function render(actions: PaletteAction[]) {
  TestBed.configureTestingModule({ imports: [ChartPaletteComponent] });
  const fixture = TestBed.createComponent(ChartPaletteComponent);
  const cmp = fixture.componentInstance;
  (cmp as any).actions = signal(actions);
  (cmp as any).recent = signal([]);
  const run = vi.fn();
  cmp.run.subscribe(run);
  fixture.detectChanges();
  return { fixture, cmp, run, host: fixture.nativeElement as HTMLElement };
}

const key = (k: string) => new KeyboardEvent('keydown', { key: k });

describe('ChartPaletteComponent (CC-I11)', () => {
  it('filters as the operator types and runs the chosen entry with Enter', () => {
    const { fixture, cmp, run, host } = render([action('Timeframe: 1h'), action('Timeframe: 4h'), action('Style: Renko')]);
    cmp.onQuery('timeframe');
    fixture.detectChanges();
    expect([...host.querySelectorAll('.cp-title')].map((e) => e.textContent)).toEqual(['Timeframe: 1h', 'Timeframe: 4h']);
    cmp.onKey(key('ArrowDown'));
    cmp.onKey(key('Enter'));
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ title: 'Timeframe: 4h' }));
  });

  it('says when nothing matches, and marks entries that ask first', () => {
    const { fixture, cmp, host } = render([action('Remove all drawings', true)]);
    fixture.detectChanges();
    expect(host.querySelector('.cp-warn')?.textContent).toContain('asks first');
    cmp.onQuery('zzz');
    fixture.detectChanges();
    expect(host.querySelector('.cp-empty')?.textContent).toContain('No chart command matches');
  });
});
