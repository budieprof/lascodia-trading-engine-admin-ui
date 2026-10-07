import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Component, Input, signal, type WritableSignal } from '@angular/core';

import { ChartBottomBarComponent } from './chart-bottom-bar.component';

// The bar holds no state: every control is an event the page acts on, and what it shows comes from
// the page. Signal inputs cannot be set under the JIT harness before the first render, so the spec
// swaps them for writable signals (as the settings dialog's spec does); for the same reason the
// icons' required `name` never arrives, so they are stand-ins (as in the script editor's spec).

@Component({ selector: 'app-chart-icon', template: '' })
class ChartIconStubComponent {
  @Input() name = '';
  @Input() size = 0;
}

const PRESETS = [
  { id: '1D', title: '1 day in 1 minute intervals' },
  { id: '5D', title: '5 days in 5 minute intervals' },
  { id: 'All', title: 'All data in 1 month intervals' },
];
const ZONES = [
  { id: 'UTC', label: 'UTC' },
  { id: 'America/New_York', label: 'New York' },
];

describe('ChartBottomBarComponent', () => {
  let fixture: ComponentFixture<ChartBottomBarComponent>;
  let bar: ChartBottomBarComponent;
  let state: Record<string, WritableSignal<any>>;

  const el = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const buttons = (sel = 'button'): HTMLButtonElement[] =>
    [...el().querySelectorAll(sel)] as HTMLButtonElement[];
  const byText = (text: string, sel = 'button'): HTMLButtonElement =>
    buttons(sel).find((b) => b.textContent!.replace(/\s+/g, ' ').trim() === text)!;
  const spy = <T>(out: { subscribe(fn: (v: T) => void): unknown }) => {
    const fn = vi.fn();
    out.subscribe(fn);
    return fn;
  };

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [ChartBottomBarComponent] });
    TestBed.overrideComponent(ChartBottomBarComponent, {
      set: { imports: [ChartIconStubComponent] },
    });
    fixture = TestBed.createComponent(ChartBottomBarComponent);
    bar = fixture.componentInstance;
    state = {
      presets: signal(PRESETS),
      barCount: signal(1501),
      clock: signal('16:32:43'),
      zone: signal('UTC'),
      timezone: signal('UTC'),
      timezones: signal(ZONES),
      scaleMode: signal('normal'),
      dockTab: signal(null),
      hasStrategy: signal(false),
      menu: signal(null),
    };
    Object.assign(bar, state);
    fixture.detectChanges();
  });

  const set = (key: string, value: unknown): void => {
    state[key].set(value);
    fixture.detectChanges();
  };

  it('shows the page’s values: bars loaded and the clock on the chart’s zone', () => {
    expect(el().querySelector('.bb-status')!.textContent!.trim()).toBe('1501 bars');
    expect(el().querySelector('.bb-clock')!.textContent!.replace(/\s+/g, ' ').trim()).toBe(
      '16:32:43 UTC',
    );
  });

  it('a preset asks the page for its range', () => {
    const range = spy(bar.range);
    byText('5D').click();
    expect(range).toHaveBeenCalledWith('5D');
  });

  it('the Range button hands the page its click, and its menu picks a preset', () => {
    const toggle = spy(bar.menuToggle);
    const range = spy(bar.range);
    el().querySelector<HTMLButtonElement>('.bb-range-btn')!.click();
    expect(toggle).toHaveBeenCalledWith({ menu: 'range', event: expect.any(MouseEvent) });
    expect(el().querySelector('.bb-menu')).toBeNull(); // the page decides what is open

    set('menu', 'range');
    const items = buttons('.bb-menu .bb-menu-item');
    expect(items.map((b) => b.querySelector('b')!.textContent)).toEqual(['1D', '5D', 'All']);
    expect(items[2].textContent).toContain('All data in 1 month intervals');
    items[2].click();
    expect(range).toHaveBeenCalledWith('All');
  });

  it('the clock opens the zones, the chart’s own marked, and a pick goes to the page', () => {
    const toggle = spy(bar.menuToggle);
    const zone = spy(bar.timezoneChange);
    el().querySelector<HTMLButtonElement>('.bb-clock')!.click();
    expect(toggle).toHaveBeenCalledWith({ menu: 'tz', event: expect.any(MouseEvent) });

    set('menu', 'tz');
    const items = buttons('.bb-menu-tz .bb-menu-item');
    expect(items.map((b) => b.classList.contains('selected'))).toEqual([true, false]);
    items[1].click();
    expect(zone).toHaveBeenCalledWith('America/New_York');
  });

  it('a click inside an open menu stays in it (the page closes menus on a document click)', () => {
    set('menu', 'tz');
    const reached = vi.fn();
    document.addEventListener('click', reached);
    buttons('.bb-menu-tz .bb-menu-item')[0].click();
    expect(reached).not.toHaveBeenCalled();
    byText('Pine Editor').click(); // any other click does reach it
    document.removeEventListener('click', reached);
    expect(reached).toHaveBeenCalledTimes(1);
  });

  it('the dock’s tabs: each asks for its panel, the open one is marked', () => {
    const editor = spy(bar.editor);
    const tester = spy(bar.tester);
    byText('Pine Editor').click();
    byText('Strategy Tester').click();
    expect(editor).toHaveBeenCalledTimes(1);
    expect(tester).toHaveBeenCalledTimes(1);
    expect(byText('Strategy Tester').title).toBe('Add a strategy to the chart to test it');

    set('dockTab', 'tester');
    set('hasStrategy', true);
    expect(byText('Strategy Tester').classList.contains('active')).toBe(true);
    expect(byText('Pine Editor').classList.contains('active')).toBe(false);
    expect(byText('Strategy Tester').title).toBe('Strategy Tester');
  });

  it('the scale buttons toggle their mode, and auto fits the price scale', () => {
    const mode = spy(bar.scaleModeChange);
    const auto = spy(bar.autoScale);
    byText('%').click();
    byText('log').click();
    expect(mode.mock.calls).toEqual([['percent'], ['log']]);
    expect(byText('auto').classList.contains('on')).toBe(true);

    set('scaleMode', 'log');
    expect(byText('log').classList.contains('on')).toBe(true);
    byText('log').click();
    byText('auto').click();
    expect(mode).toHaveBeenLastCalledWith('normal');
    expect(auto).toHaveBeenCalledTimes(1);
  });

  it('go to date hands the page the day picked', () => {
    const go = spy(bar.goToDate);
    const input = el().querySelector<HTMLInputElement>('.bb-goto input[type="date"]')!;
    input.value = '2026-10-02';
    input.dispatchEvent(new Event('change'));
    expect(go).toHaveBeenCalledWith('2026-10-02');
  });
});
