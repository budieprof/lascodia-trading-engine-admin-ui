import { describe, it, expect, beforeEach } from 'vitest';
import { Component } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { FormControl, ReactiveFormsModule } from '@angular/forms';

import { SubConfigEditorComponent } from './sub-config-editor.component';
import { RISK_OVERRIDES_SCHEMA, SIZING_SCHEMA } from '../../util/sub-config-schema';

@Component({
  standalone: true,
  imports: [ReactiveFormsModule, SubConfigEditorComponent],
  template: `<app-sub-config-editor [formControl]="ctrl" [schema]="schema" />`,
})
class HostComponent {
  ctrl = new FormControl<string>('');
  schema = RISK_OVERRIDES_SCHEMA;
}

describe('SubConfigEditorComponent', () => {
  let fixture: ComponentFixture<HostComponent>;
  let host: HostComponent;
  let el: HTMLElement;
  let editor: SubConfigEditorComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [HostComponent] }).compileComponents();
    fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
    el = fixture.nativeElement;
    fixture.detectChanges();
    editor = fixture.debugElement.children[0].componentInstance as SubConfigEditorComponent;
    editor.activeSchema.set(RISK_OVERRIDES_SCHEMA);
  });

  const select = (id: string) => el.querySelector<HTMLSelectElement>(`#sc-riskOverrides-${id}`)!;
  const input = (id: string) => el.querySelector<HTMLInputElement>(`#sc-riskOverrides-${id}`)!;

  it('populates the form from stored JSON', () => {
    host.ctrl.setValue('{"slMode":"Pips","slMultiplier":25,"extra":1}');
    fixture.detectChanges();
    expect(select('slMode').value).toBe('Pips');
    expect(input('slMultiplier').value).toBe('25');
    // The label follows the mode.
    expect(el.textContent).toContain('Stop-loss distance (pips)');
    expect(el.textContent).toContain('extra');
  });

  it('writes typed edits back to the control, preserving unknown keys', () => {
    host.ctrl.setValue('{"extra":1,"slMode":"Atr"}');
    fixture.detectChanges();
    const mul = input('slMultiplier');
    mul.value = '1.5';
    mul.dispatchEvent(new Event('change'));
    expect(host.ctrl.value).toBe('{"extra":1,"slMode":"Atr","slMultiplier":1.5}');

    const mode = select('slMode');
    mode.value = '';
    mode.dispatchEvent(new Event('change'));
    expect(host.ctrl.value).toBe('{"extra":1,"slMultiplier":1.5}');
  });

  it('clears the column when the last field is blanked', () => {
    host.ctrl.setValue('{"maxOpenPositions":2}');
    fixture.detectChanges();
    const f = input('maxOpenPositions');
    f.value = '';
    f.dispatchEvent(new Event('change'));
    expect(host.ctrl.value).toBe('');
  });

  it('syncs raw JSON edits into the form', () => {
    fixture.detectChanges();
    (el.querySelector('.sub-config-raw-toggle') as HTMLButtonElement).click();
    fixture.detectChanges();
    const ta = el.querySelector<HTMLTextAreaElement>('.sub-config-raw textarea')!;
    ta.value = '{"tpMode":"Atr","tpMultiplier":2.5}';
    ta.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(host.ctrl.value).toBe('{"tpMode":"Atr","tpMultiplier":2.5}');
    expect(select('tpMode').value).toBe('Atr');
    expect(input('tpMultiplier').value).toBe('2.5');
  });

  it('shows malformed JSON in the raw editor and disables the typed fields', () => {
    host.ctrl.setValue('{"slMode":');
    fixture.detectChanges();
    expect(el.querySelector('[role="alert"]')).toBeTruthy();
    expect(el.querySelector('.sub-config-raw textarea')).toBeTruthy();
    expect(select('slMode').disabled).toBe(true);
  });

  it('shows only the sizing fields the chosen mode reads', () => {
    editor.activeSchema.set(SIZING_SCHEMA);
    host.ctrl.setValue('{"mode":"AtrBased"}');
    fixture.detectChanges();
    expect(el.querySelector('#sc-sizing-riskPerTradePct')).toBeTruthy();
    expect(el.querySelector('#sc-sizing-atrMultiplier')).toBeTruthy();
    expect(el.querySelector('#sc-sizing-value')).toBeNull();
  });
});
