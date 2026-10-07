import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Component, Input, signal, type WritableSignal } from '@angular/core';

import type { ScriptInputDto, ScriptInputValues } from '@core/api/scripting.types';
import { withSavedDefaults } from '@features/scripting/pine/pine-inputs';
import { StrategyTesterPanelComponent } from './strategy-tester-panel.component';

// Signal inputs cannot be set under the JIT harness before the first render, so the spec swaps the
// component's input signals for writable ones before detectChanges (as the settings-dialog spec does),
// and the icon child, whose signal inputs JIT cannot bind, is stood in for by a decorator-input stub.

@Component({ selector: 'app-chart-icon', template: '' })
class ChartIconStubComponent {
  @Input() name = '';
  @Input() size = 0;
}

// An engine strategy whose stored inputs differ from its source: Length 20 in the source and 30
// stored, "Use stop" on in the source and off stored. Every run applies the stored values beneath
// the chart's overrides, so they — not the source's — are what "no override" runs with.
const SOURCE: ScriptInputDto[] = [
  {
    id: 'Main::Length',
    kind: 'int',
    title: 'Length',
    defaultValue: 20,
    minValue: 1,
    maxValue: 500,
  },
  { id: 'Risk::Use stop', kind: 'bool', title: 'Use stop', defaultValue: true },
  { id: 'Display::Colour', kind: 'bool', title: 'Colour', defaultValue: true, display: 'none' },
];
const STORED: ScriptInputValues = { 'Main::Length': 30, 'Risk::Use stop': false };
/** The inputs as the page hands them over (`ScriptSettings.inputsOf`). */
const EFFECTIVE = withSavedDefaults(SOURCE, STORED);

describe('StrategyTesterPanelComponent — Inputs against the defaults the strategy runs on', () => {
  let fixture: ComponentFixture<StrategyTesterPanelComponent>;
  let host: HTMLElement;
  let inputs: WritableSignal<readonly ScriptInputDto[] | null>;
  let rerun: Mock<(values: ScriptInputValues) => void>;

  function render(list: readonly ScriptInputDto[] | null, values: ScriptInputValues = {}): void {
    TestBed.configureTestingModule({ imports: [StrategyTesterPanelComponent] });
    TestBed.overrideComponent(StrategyTesterPanelComponent, {
      set: { imports: [ChartIconStubComponent] },
    });
    fixture = TestBed.createComponent(StrategyTesterPanelComponent);
    const cmp = fixture.componentInstance as any;
    inputs = signal(list);
    cmp.result = signal({ title: 'MeanRev v5', inputs: SOURCE, strategy: null, error: null });
    cmp.inputs = inputs;
    cmp.values = signal(values);
    cmp.running = signal(false);
    cmp.resolution = signal('60');
    rerun = vi.fn<(values: ScriptInputValues) => void>();
    cmp.rerun.subscribe(rerun);
    fixture.detectChanges();
    cmp.tab.set('inputs');
    fixture.detectChanges();
    host = fixture.nativeElement;
  }

  afterEach(() => TestBed.resetTestingModule());

  const field = (title: string): HTMLInputElement =>
    [...host.querySelectorAll('label.field')]
      .find((l) => l.querySelector('span')?.textContent?.trim() === title)!
      .querySelector('input')!;
  const edit = (title: string, value: string | boolean) => {
    const el = field(title);
    if (typeof value === 'boolean') el.checked = value;
    else el.value = value;
    el.dispatchEvent(new Event('change'));
    fixture.detectChanges();
  };
  const rerunNow = () => {
    host.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    fixture.detectChanges();
  };

  it('shows the values the strategy runs with: the stored inputs where the chart sets none', () => {
    render(EFFECTIVE);
    expect(field('Length').value).toBe('30');
    expect(field('Use stop').checked).toBe(false);
  });

  it('an input set back to its SOURCE default is sent: left out, the stored value would win', () => {
    render(EFFECTIVE);
    edit('Length', '20');
    edit('Use stop', true);
    rerunNow();
    expect(rerun).toHaveBeenCalledWith({ 'Main::Length': 20, 'Risk::Use stop': true });
  });

  it('a value equal to the stored input is no override — the engine applies it beneath anyway', () => {
    render(EFFECTIVE, { 'Main::Length': 25 });
    expect(field('Length').value).toBe('25');
    edit('Length', '30');
    rerunNow();
    expect(rerun).toHaveBeenCalledWith({});
  });

  it('keeps the override of an input the form does not show (display.none), set in Settings', () => {
    render(EFFECTIVE, { 'Display::Colour': false });
    edit('Length', '40');
    rerunNow();
    expect(rerun).toHaveBeenCalledWith({ 'Main::Length': 40, 'Display::Colour': false });
  });

  it('Defaults goes back to the strategy’s stored inputs: nothing to override', () => {
    render(EFFECTIVE, { 'Main::Length': 25 });
    [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Defaults')!.click();
    fixture.detectChanges();
    expect(field('Length').value).toBe('30');
    rerunNow();
    expect(rerun).toHaveBeenCalledWith({});
  });

  it('a script with no stored inputs measures against its source defaults, as before', () => {
    render(SOURCE);
    edit('Length', '20');
    rerunNow();
    expect(rerun).toHaveBeenLastCalledWith({});
    edit('Length', '25');
    rerunNow();
    expect(rerun).toHaveBeenLastCalledWith({ 'Main::Length': 25 });
  });

  it('waits for an engine strategy’s stored inputs before showing the form', () => {
    render(null);
    expect(host.querySelector('form')).toBeNull();
    expect(host.textContent).toContain('Loading the strategy');
    inputs.set(EFFECTIVE);
    fixture.detectChanges();
    expect(field('Length').value).toBe('30');
  });

  it('the browser’s own validation never blocks Re-run: a Pine step is no constraint', () => {
    // MeanRev v5's exhaustion input: input.float(1.0, minval = 0.05) comes with step 1, and 1 is
    // no whole number of steps above 0.05 — the browser refused the form and Re-run did nothing.
    render([
      ...EFFECTIVE,
      {
        id: 'Exits::Exhaustion',
        kind: 'float',
        title: 'Exhaustion',
        defaultValue: 1,
        minValue: 0.05,
        maxValue: 1,
        step: 1,
      },
    ]);
    edit('Length', '20');
    [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Re-run')!.click();
    expect(rerun).toHaveBeenCalledWith({ 'Main::Length': 20 });
  });
});

