import { beforeEach, describe, expect, it } from 'vitest';
import { TestBed, type ComponentFixture } from '@angular/core/testing';

import { InputOverridesEditorComponent } from './input-overrides-editor.component';
import type { ScriptInputDef } from '../api/scripting-api.types';
import { declareSignalIo } from '@shared/testing/jit-signal-io';

declareSignalIo(InputOverridesEditorComponent, {
  inputs: ['inputs', 'baseline', 'disabled'],
  outputs: ['overridesChange', 'validityChange'],
});

const DEFS: ScriptInputDef[] = [
  { id: 'in_len', kind: 'int', title: 'Length', defaultValue: 20, minValue: 1, maxValue: 200 },
  { id: 'in_src', kind: 'source', title: 'Source', defaultValue: 'close' },
  { id: 'in_useTp', kind: 'bool', title: 'Use take profit', defaultValue: true, group: 'Exits' },
  {
    id: 'in_tp',
    kind: 'float',
    title: 'Take profit %',
    defaultValue: 2,
    group: 'Exits',
    activeWhenInputId: 'in_useTp',
    tooltip: 'Percent from entry',
  },
];

describe('InputOverridesEditorComponent', () => {
  let fixture: ComponentFixture<InputOverridesEditorComponent>;
  let el: HTMLElement;
  let overrides: Record<string, unknown>[];
  let validity: boolean[];

  function render(inputs: ScriptInputDef[] | null, baseline: Record<string, unknown> = {}): void {
    fixture = TestBed.createComponent(InputOverridesEditorComponent);
    overrides = [];
    validity = [];
    fixture.componentInstance.overridesChange.subscribe((o) => overrides.push(o));
    fixture.componentInstance.validityChange.subscribe((v) => validity.push(v));
    fixture.componentRef.setInput('inputs', inputs);
    fixture.componentRef.setInput('baseline', baseline);
    fixture.detectChanges();
    el = fixture.nativeElement as HTMLElement;
  }

  const control = (id: string) => el.querySelector<HTMLInputElement>(`[id$="-${id}"]`)!;

  function change(id: string, value: string | boolean): void {
    const c = control(id);
    if (typeof value === 'boolean') c.checked = value;
    else c.value = value;
    c.dispatchEvent(new Event('change'));
    fixture.detectChanges();
  }

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [InputOverridesEditorComponent] });
  });

  it('pre-fills the values in effect, saved overrides included', () => {
    render(DEFS, { in_len: 50 });
    expect(control('in_len').value).toBe('50');
    expect((control('in_src') as unknown as HTMLSelectElement).value).toBe('"close"');
    expect(control('in_useTp').checked).toBe(true);
    expect(el.querySelector('legend')!.textContent).toContain('Exits');
    expect(el.textContent).toContain('Percent from entry');
    expect(overrides.at(-1)).toEqual({});
  });

  it('emits only the inputs that changed, and resets them', () => {
    render(DEFS, { in_len: 50 });
    change('in_len', '30');
    change('in_src', '"hl2"');
    expect(overrides.at(-1)).toEqual({ in_len: 30, in_src: 'hl2' });

    // Back to the saved value: nothing to override for that input.
    const lenRow = control('in_len').closest('.row')!;
    lenRow.querySelector<HTMLButtonElement>('.reset')!.click();
    fixture.detectChanges();
    expect(control('in_len').value).toBe('50');
    expect(overrides.at(-1)).toEqual({ in_src: 'hl2' });
  });

  it('flags out-of-range values and reports the editor invalid', () => {
    render(DEFS);
    change('in_len', '500');
    expect(el.querySelector('.err')!.textContent).toContain('at most 200');
    expect(validity.at(-1)).toBe(false);
    expect(overrides.at(-1)).toEqual({});
    change('in_len', '120');
    expect(validity.at(-1)).toBe(true);
    expect(overrides.at(-1)).toEqual({ in_len: 120 });
  });

  it('disables an input whose active= switch is off', () => {
    render(DEFS);
    change('in_useTp', false);
    expect(control('in_tp').disabled).toBe(true);
    expect(overrides.at(-1)).toEqual({ in_useTp: false });
  });

  it('falls back to a key / value list without a schema', () => {
    render(null);
    el.querySelector<HTMLButtonElement>('.add')!.click();
    fixture.detectChanges();
    const [key, value] = [...el.querySelectorAll<HTMLInputElement>('.free input')];
    key.value = 'in_3_length';
    key.dispatchEvent(new Event('input'));
    value.value = '21';
    value.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(overrides.at(-1)).toEqual({ in_3_length: 21 });
  });
});
