import { describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';

import { ChartSettingsDialogComponent, type ChartSettings } from './chart-settings-dialog.component';

// Signal inputs are swapped for plain signals before the first render (the JIT harness cannot set them).

const base: ChartSettings = {
  appearance: null,
  rememberPerSymbol: false,
  showVolume: true,
  countdown: true,
  scaleMode: 'normal',
  invertScale: false,
  scaleSide: 'right',
  timezone: 'UTC',
  sessionBreaks: false,
  showEvents: true,
  minEventImpact: 'Medium',
  showBlackout: true,
  showPositions: false,
  showOrders: false,
  showOverlays: false,
  showClosedTrades: false,
  fitTradeLines: true,
};

function render() {
  TestBed.configureTestingModule({ imports: [ChartSettingsDialogComponent] });
  const fixture = TestBed.createComponent(ChartSettingsDialogComponent);
  const cmp = fixture.componentInstance;
  (cmp as any).settings = signal(base);
  (cmp as any).timezones = signal([{ id: 'UTC', label: 'UTC' }, { id: 'America/New_York', label: 'New York' }]);
  const changed = vi.fn();
  const closed = vi.fn();
  cmp.changed.subscribe(changed);
  cmp.closed.subscribe(closed);
  fixture.detectChanges();
  return { fixture, cmp, changed, closed, host: fixture.nativeElement as HTMLElement };
}

describe('ChartSettingsDialogComponent (CC-I11)', () => {
  it('applies every edit at once with the whole settings', () => {
    const { cmp, changed } = render();
    cmp.setAppearance('up', '#2962FF');
    cmp.set('invertScale', true);
    expect(changed).toHaveBeenLastCalledWith({ ...base, invertScale: true, appearance: { up: '#2962FF' } });
  });

  it('Cancel puts back the settings it opened with; Ok keeps the edits', () => {
    const a = render();
    a.cmp.setGrid('none');
    a.cmp.cancel();
    expect(a.changed).toHaveBeenLastCalledWith(base);
    expect(a.closed).toHaveBeenCalledWith({ kept: false });
    TestBed.resetTestingModule();
    const b = render();
    b.cmp.set('scaleMode', 'log');
    b.cmp.ok();
    expect(b.changed).toHaveBeenCalledTimes(1);
    expect(b.closed).toHaveBeenCalledWith({ kept: true });
  });

  it('shows the tabs and the theme’s colours when none are set', () => {
    const { host } = render();
    const tabs = [...host.querySelectorAll('[role="tab"]')].map((t) => t.textContent?.trim());
    expect(tabs).toEqual(['Symbol', 'Scales', 'Canvas', 'Trading', 'Events']);
    const colours = [...host.querySelectorAll('input[type="color"]')].map((i) => (i as HTMLInputElement).value.toUpperCase());
    expect(colours).toEqual(['#089981', '#F23645']);
  });

  it('drops the appearance when it is back to the theme’s', () => {
    const { cmp, changed } = render();
    cmp.setGrid('vertical');
    cmp.setGrid('both');
    expect(changed).toHaveBeenLastCalledWith(base);
  });
});
