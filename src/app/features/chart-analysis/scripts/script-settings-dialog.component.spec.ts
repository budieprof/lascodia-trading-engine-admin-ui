import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { ChangeDetectorRef, computed, signal, type WritableSignal } from '@angular/core';

import type { ScriptInputDto, ScriptInputValues } from '@core/api/scripting.types';
import { InputsFormComponent } from '@features/scripting/components/inputs-form/inputs-form.component';
import {
  SCRIPT_SETTINGS_APPLY_MS,
  ScriptSettingsDialogComponent,
} from './script-settings-dialog.component';

// Signal inputs cannot be set under the JIT harness before the first render, so the spec swaps the
// component's input signals for writable ones before detectChanges (as the inputs-form spec does).
// For the same reason a template's bindings never reach the inputs form inside the dialog (JIT has
// no metadata for signal inputs and outputs), so `wireForm` binds it the way the template does:
// [inputs] from the dialog's, [overrides] from its draft, (overridesChange) into edit().

// A slice of "Smart Algo Signals Suite v2" as the engine compiles it (chart script #20).
const INPUTS: ScriptInputDto[] = [
  {
    id: 'Signals::Sensitivity',
    kind: 'float',
    title: 'Sensitivity',
    defaultValue: 1.3,
    minValue: 0.4,
    maxValue: 5,
    step: 0.1,
    group: 'Signals',
  },
  {
    id: 'Pullback mode (RSI-2)::Skip signals',
    kind: 'bool',
    title: 'Skip signals',
    defaultValue: true,
    inline: 'pbs1',
    group: 'Pullback mode (RSI-2)',
  },
  {
    id: 'Pullback mode (RSI-2)::#17',
    kind: 'session',
    title: '',
    defaultValue: '0600-1100',
    inline: 'pbs1',
    group: 'Pullback mode (RSI-2)',
    tooltip: 'UTC.',
  },
  {
    id: 'Display::Colour candles',
    kind: 'bool',
    title: 'Colour candles',
    defaultValue: true,
    group: 'Display',
    display: 'none',
    tooltip: "Off: the chart's own green and red candles.",
  },
  { id: 'Lines::Colour', kind: 'color', title: 'Colour', defaultValue: '#2962FFFF' },
];
const COLOUR = 'Display::Colour candles';

describe('ScriptSettingsDialogComponent', () => {
  let fixture: ComponentFixture<ScriptSettingsDialogComponent>;
  let cmp: ScriptSettingsDialogComponent;
  let host: HTMLElement;
  let values: WritableSignal<ScriptInputValues>;
  let inputs: WritableSignal<readonly ScriptInputDto[] | null>;
  let canSaveDefault: WritableSignal<boolean>;
  let changed: Mock<(values: ScriptInputValues) => void>;
  let saveDefault: Mock<(values: ScriptInputValues) => void>;
  let closed: Mock<() => void>;

  const field = (id: string) => host.querySelector(`[data-input-id="${id}"]`) as HTMLElement;
  const checkbox = (id: string) =>
    field(id).querySelector('input[type=checkbox]') as HTMLInputElement;
  const button = (text: string) =>
    [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)!;
  const tick = (id: string, on: boolean) => {
    const box = checkbox(id);
    box.checked = on;
    box.dispatchEvent(new Event('change'));
    fixture.detectChanges();
  };

  function render(start: ScriptInputValues = {}, opts: { saveable?: boolean } = {}): void {
    TestBed.configureTestingModule({ imports: [ScriptSettingsDialogComponent] });
    fixture = TestBed.createComponent(ScriptSettingsDialogComponent);
    cmp = fixture.componentInstance;
    values = signal(start);
    inputs = signal<readonly ScriptInputDto[] | null>(INPUTS);
    canSaveDefault = signal(!!opts.saveable);
    (cmp as any).title = signal('Smart Algo v2');
    (cmp as any).inputs = inputs;
    (cmp as any).values = values;
    (cmp as any).canSaveDefault = canSaveDefault;
    (cmp as any).savingDefault = signal(false);
    changed = vi.fn<(values: ScriptInputValues) => void>();
    saveDefault = vi.fn<(values: ScriptInputValues) => void>();
    closed = vi.fn<() => void>();
    cmp.changed.subscribe(changed);
    cmp.saveDefault.subscribe(saveDefault);
    cmp.closed.subscribe(closed);
    fixture.detectChanges();
    host = fixture.nativeElement;
    wireForm();
  }

  function wireForm(): void {
    const de = fixture.debugElement.query(By.directive(InputsFormComponent));
    if (!de) return;
    const form = de.componentInstance as any;
    form.inputs = computed(() => cmp.inputs() ?? []);
    form.overrides = Object.assign(() => cmp.draft(), {
      set: (v: ScriptInputValues) => cmp.edit(v),
    });
    form.showReset = signal(false);
    de.injector.get(ChangeDetectorRef).markForCheck();
    fixture.detectChanges();
  }

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('lays the inputs out as TradingView does: group headings, inline rows, tooltips', () => {
    render();
    expect(host.querySelector('.sd-title')?.textContent?.trim()).toBe('Smart Algo v2');
    const groups = [...host.querySelectorAll('.in-group')].map((g) => g.textContent?.trim());
    expect(groups).toEqual(['Signals', 'Pullback mode (RSI-2)', 'Display']);
    const inline = host.querySelector('.in-row.is-inline')!;
    expect(
      [...inline.querySelectorAll('[data-input-id]')].map((e) => e.getAttribute('data-input-id')),
    ).toEqual(['Pullback mode (RSI-2)::Skip signals', 'Pullback mode (RSI-2)::#17']);
    expect(inline.querySelector('.in-tip')?.getAttribute('title')).toBe('UTC.');
    // A display.none input still has its place in Settings (display only hides it elsewhere).
    expect(checkbox(COLOUR).checked).toBe(true);
    expect(field(COLOUR).closest('.in-row')?.querySelector('.in-tip')?.getAttribute('title')).toBe(
      "Off: the chart's own green and red candles.",
    );
  });

  it('applies a bool switched off once the edits pause, as the one override that differs', () => {
    render();
    tick(COLOUR, false);
    expect(changed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(SCRIPT_SETTINGS_APPLY_MS);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenLastCalledWith({ [COLOUR]: false });
    expect(host.querySelector('.sd-note')?.textContent).toContain('1 changed');

    // Ticked again: back to the defaults, nothing to send.
    tick(COLOUR, true);
    vi.advanceTimersByTime(SCRIPT_SETTINGS_APPLY_MS);
    expect(changed).toHaveBeenLastCalledWith({});
    expect(host.querySelector('.sd-note')).toBeNull();
  });

  it('a burst of edits (a colour dragged) is one re-run', () => {
    render();
    const picker = field('Lines::Colour').querySelector('input[type=color]') as HTMLInputElement;
    for (const hex of ['#ff0000', '#ee0000', '#dd0000']) {
      picker.value = hex;
      picker.dispatchEvent(new Event('input'));
      fixture.detectChanges();
      vi.advanceTimersByTime(SCRIPT_SETTINGS_APPLY_MS / 2);
    }
    vi.advanceTimersByTime(SCRIPT_SETTINGS_APPLY_MS);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledWith({ 'Lines::Colour': '#DD0000FF' });
  });

  it('opens on the values the script runs with', () => {
    render({ [COLOUR]: false });
    expect(checkbox(COLOUR).checked).toBe(false);
    expect(checkbox('Pullback mode (RSI-2)::Skip signals').checked).toBe(true);
  });

  it('Ok applies an edit still waiting and closes', () => {
    render();
    tick(COLOUR, false);
    button('Ok').click();
    expect(changed).toHaveBeenCalledWith({ [COLOUR]: false });
    expect(closed).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(SCRIPT_SETTINGS_APPLY_MS);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('Cancel puts back the values it opened with', () => {
    render({ 'Signals::Sensitivity': 2 });
    tick(COLOUR, false);
    vi.advanceTimersByTime(SCRIPT_SETTINGS_APPLY_MS);
    expect(changed).toHaveBeenLastCalledWith({ 'Signals::Sensitivity': 2, [COLOUR]: false });
    button('Cancel').click();
    expect(changed).toHaveBeenLastCalledWith({ 'Signals::Sensitivity': 2 });
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('Cancel with nothing applied re-runs nothing; an edit still waiting is dropped', () => {
    render();
    tick(COLOUR, false);
    (host.querySelector('.sd-x') as HTMLButtonElement).click();
    vi.advanceTimersByTime(SCRIPT_SETTINGS_APPLY_MS);
    expect(changed).not.toHaveBeenCalled();
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('Esc cancels, and keys never reach the chart’s shortcuts', () => {
    render();
    const page = vi.fn();
    host.addEventListener('keydown', page);
    const dialog = host.querySelector('.sd') as HTMLElement;
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    expect(page).not.toHaveBeenCalled();
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('Defaults ▾ → Reset to defaults applies none at once', () => {
    render({ [COLOUR]: false });
    button('Defaults ▾').click();
    fixture.detectChanges();
    expect(button('Save as default')).toBeUndefined(); // not a saved script
    button('Reset to defaults').click();
    fixture.detectChanges();
    expect(changed).toHaveBeenCalledWith({});
    expect(checkbox(COLOUR).checked).toBe(true);
  });

  it('Defaults ▾ → Save as default sends the overrides of a saved script', () => {
    render({ [COLOUR]: false, 'Signals::Sensitivity': 1.3 }, { saveable: true });
    button('Defaults ▾').click();
    fixture.detectChanges();
    button('Save as default').click();
    // Only what differs from the defaults (1.3 is Sensitivity's).
    expect(saveDefault).toHaveBeenCalledWith({ [COLOUR]: false });
  });

  it('values changed elsewhere replace the form’s — unless an edit here is waiting', () => {
    render();
    values.set({ 'Signals::Sensitivity': 2.5 });
    fixture.detectChanges();
    const sensitivity = field('Signals::Sensitivity').querySelector('input') as HTMLInputElement;
    expect(sensitivity.value).toBe('2.5');

    tick(COLOUR, false);
    values.set({ 'Signals::Sensitivity': 3 });
    fixture.detectChanges();
    expect(checkbox(COLOUR).checked).toBe(false);
    vi.advanceTimersByTime(SCRIPT_SETTINGS_APPLY_MS);
    expect(changed).toHaveBeenLastCalledWith({ 'Signals::Sensitivity': 2.5, [COLOUR]: false });
    // The chart reporting back what was sent changes nothing.
    values.set({ 'Signals::Sensitivity': 2.5, [COLOUR]: false });
    fixture.detectChanges();
    expect(changed).toHaveBeenCalledTimes(1);
    expect(checkbox(COLOUR).checked).toBe(false);
  });

  it('waits for an engine strategy’s stored inputs before showing the form', () => {
    render();
    inputs.set(null);
    fixture.detectChanges();
    expect(host.querySelector('app-inputs-form')).toBeNull();
    expect(host.querySelector('.sd-hint')?.textContent).toContain('Loading');
  });
});
