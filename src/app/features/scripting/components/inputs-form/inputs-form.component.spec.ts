import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { ChangeDetectorRef, signal, type WritableSignal } from '@angular/core';

import type { ScriptInputDto, ScriptInputValues } from '@core/api/scripting.types';
import { InputsFormComponent } from './inputs-form.component';

// Signal inputs cannot be set under the JIT harness before the first render, so the specs swap
// the component's input/model signals for writable ones before detectChanges (the same approach
// the strategy-form specs use).

const INPUTS: ScriptInputDto[] = [
  {
    id: 'len',
    kind: 'int',
    title: 'Length',
    defaultValue: 14,
    minValue: 1,
    maxValue: 200,
    step: 1,
    group: 'Main',
  },
  {
    id: 'mult',
    kind: 'float',
    title: 'Multiplier',
    defaultValue: 1.5,
    minValue: 0,
    step: 0.1,
    group: 'Main',
  },
  { id: 'show', kind: 'bool', title: 'Show bands', defaultValue: true, group: 'Main' },
  {
    id: 'bandLen',
    kind: 'int',
    title: 'Band length',
    defaultValue: 20,
    group: 'Main',
    activeWhenInputId: 'show',
  },
  {
    id: 'mode',
    kind: 'string',
    title: 'Mode',
    defaultValue: 'A',
    options: ['A', 'B'],
    inline: 'm',
    group: 'Style',
  },
  {
    id: 'col',
    kind: 'color',
    title: 'Colour',
    defaultValue: '#089981FF',
    inline: 'm',
    group: 'Style',
    tooltip: 'Line colour',
  },
  { id: 'note', kind: 'textArea', title: 'Notes', defaultValue: '' },
  { id: 'label', kind: 'string', title: 'Label', defaultValue: 'x' },
  { id: 'sym', kind: 'symbol', title: 'Symbol', defaultValue: '' },
  { id: 'tf', kind: 'timeframe', title: 'Timeframe', defaultValue: '1D' },
  { id: 'sess', kind: 'session', title: 'Session', defaultValue: '0800-1700' },
  { id: 'src', kind: 'source', title: 'Source', defaultValue: 'close', defaultText: 'close' },
  {
    id: 'start',
    kind: 'time',
    title: 'Start',
    defaultValue: Date.UTC(2024, 0, 1, 0, 0),
    confirm: true,
  },
  { id: 'level', kind: 'price', title: 'Level', defaultValue: 1.1 },
  {
    id: 'dir',
    kind: 'enum',
    title: 'Direction',
    defaultValue: 'long',
    options: ['long', 'short'],
    optionTexts: ['Long only', 'Short only'],
    enumName: 'Dir',
  },
];

describe('InputsFormComponent', () => {
  let fixture: ComponentFixture<InputsFormComponent>;
  let cmp: InputsFormComponent;
  let overrides: WritableSignal<ScriptInputValues>;
  let host: HTMLElement;

  const field = (id: string) => host.querySelector(`[data-input-id="${id}"]`) as HTMLElement;
  const control = <T extends Element>(id: string, sel: string) =>
    field(id).querySelector(sel) as unknown as T;
  const change = (
    el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
    value: string,
    event = 'change',
  ) => {
    el.value = value;
    el.dispatchEvent(new Event(event));
    fixture.detectChanges();
  };

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [InputsFormComponent] });
    fixture = TestBed.createComponent(InputsFormComponent);
    cmp = fixture.componentInstance;
    overrides = signal<ScriptInputValues>({});
    (cmp as any).inputs = signal(INPUTS);
    (cmp as any).overrides = overrides;
    (cmp as any).symbols = signal(['EURUSD', 'GBPUSD']);
    fixture.detectChanges();
    host = fixture.nativeElement;
  });

  it('renders the Pine layout: group headings, inline rows and the row tooltip', () => {
    const groups = [...host.querySelectorAll('.in-group')].map((g) => g.textContent?.trim());
    expect(groups).toEqual(['Main', 'Style']);
    const inline = host.querySelector('.in-row.is-inline')!;
    expect(
      [...inline.querySelectorAll('[data-input-id]')].map((e) => e.getAttribute('data-input-id')),
    ).toEqual(['mode', 'col']);
    expect(inline.querySelector('.in-tip')?.getAttribute('title')).toBe('Line colour');
  });

  it('renders the right widget for every kind', () => {
    expect(control<HTMLInputElement>('len', 'input').type).toBe('number');
    expect(control<HTMLInputElement>('len', 'input').getAttribute('max')).toBe('200');
    expect(control<HTMLInputElement>('mult', 'input').getAttribute('step')).toBe('0.1');
    expect(control<HTMLInputElement>('show', 'input').type).toBe('checkbox');
    expect(control<HTMLSelectElement>('mode', 'select')).toBeTruthy();
    expect(control<HTMLInputElement>('col', 'input[type=color]')).toBeTruthy();
    expect(control<HTMLInputElement>('col', 'input[type=range]')).toBeTruthy();
    expect(control<HTMLTextAreaElement>('note', 'textarea')).toBeTruthy();
    expect(control<HTMLInputElement>('label', 'input').type).toBe('text');
    expect(control<HTMLInputElement>('sym', 'input').getAttribute('list')).toBeTruthy();
    expect(control<HTMLSelectElement>('tf', 'select').options.length).toBeGreaterThan(10);
    expect(field('sess').querySelectorAll('input[type=time]').length).toBe(2);
    expect(field('sess').querySelectorAll('.day').length).toBe(7);
    expect([...control<HTMLSelectElement>('src', 'select').options].map((o) => o.value)).toContain(
      'hlc3',
    );
    expect(control<HTMLInputElement>('start', 'input').type).toBe('datetime-local');
    expect(control<HTMLInputElement>('start', 'input').value).toBe('2024-01-01T00:00');
    expect(field('start').querySelector('.chip')?.textContent).toContain('confirm');
    expect(field('level').querySelector('.pick')).toBeTruthy();
    expect(
      [...control<HTMLSelectElement>('dir', 'select').options].map((o) => o.textContent?.trim()),
    ).toEqual(['Long only', 'Short only']);
  });

  it('starts every widget at the default and stores nothing', () => {
    expect(control<HTMLInputElement>('len', 'input').value).toBe('14');
    expect(control<HTMLInputElement>('show', 'input').checked).toBe(true);
    expect(overrides()).toEqual({});
  });

  it('round-trips a value for every kind into §9 wire overrides', () => {
    change(control('len', 'input'), '250');
    change(control('mult', 'input'), '2.25');
    const show = control<HTMLInputElement>('show', 'input');
    show.checked = false;
    show.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    change(control('mode', 'select'), 'B');
    change(control('col', 'input[type=color]'), '#ff0000', 'input');
    change(control('col', 'input[type=range]'), '50', 'input');
    change(control('note', 'textarea'), 'line1\nline2');
    change(control('label', 'input'), 'hello');
    change(control('sym', 'input'), ' gbpusd ');
    change(control('tf', 'select'), '240');
    change(field('sess').querySelectorAll('input[type=time]')[0] as HTMLInputElement, '09:30');
    (field('sess').querySelectorAll('.day')[6] as HTMLButtonElement).click(); // Su off
    fixture.detectChanges();
    change(control('src', 'select'), 'hl2');
    change(control('start', 'input'), '2025-03-04T05:06');
    change(control('level', 'input'), '1.2345');
    change(control('dir', 'select'), 'short');

    expect(overrides()).toEqual({
      len: 200, // clamped to maxval
      mult: 2.25,
      show: false,
      mode: 'B',
      col: '#FF000080',
      note: 'line1\nline2',
      label: 'hello',
      sym: 'GBPUSD',
      tf: '240',
      sess: '0930-1700:234567',
      src: 'hl2',
      start: Date.UTC(2025, 2, 4, 5, 6),
      level: 1.2345,
      dir: 'short',
    });
    // The number field shows the clamped value, not what was typed.
    expect(control<HTMLInputElement>('len', 'input').value).toBe('200');
  });

  it('greys out and locks an input whose active bool is off', () => {
    expect(field('bandLen').classList).not.toContain('is-inactive');
    const show = control<HTMLInputElement>('show', 'input');
    show.checked = false;
    show.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(field('bandLen').classList).toContain('is-inactive');
    expect(control<HTMLInputElement>('bandLen', 'input').disabled).toBe(true);
  });

  it('shows saved overrides and resets to the defaults', () => {
    overrides.set({ len: 30, col: '#00000000' });
    fixture.detectChanges();
    expect(control<HTMLInputElement>('len', 'input').value).toBe('30');
    expect(control<HTMLInputElement>('col', 'input[type=range]').value).toBe('0');
    const reset = [...host.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Reset to defaults'),
    )!;
    expect(reset.disabled).toBe(false);
    reset.click();
    fixture.detectChanges();
    expect(overrides()).toEqual({});
    expect(control<HTMLInputElement>('len', 'input').value).toBe('14');
  });

  it('is read-only when disabled', () => {
    (cmp as any).disabled = signal(true);
    // Swapping a signal does not mark the OnPush view; do it by hand.
    fixture.debugElement.injector.get(ChangeDetectorRef).markForCheck();
    fixture.detectChanges();
    expect(control<HTMLInputElement>('len', 'input').disabled).toBe(true);
    cmp.set(INPUTS[0], 50);
    expect(overrides()).toEqual({});
    expect([...host.querySelectorAll('button')].some((b) => b.textContent?.includes('Reset'))).toBe(
      false,
    );
  });
});
