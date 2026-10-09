import { beforeEach, describe, expect, it } from 'vitest';
import { TestBed, type ComponentFixture } from '@angular/core/testing';

import { declareSignalIo } from '@shared/testing/jit-signal-io';

import { ScreenFiltersEditorComponent } from './screen-filters-editor.component';
import type { ScreenFilter } from './screens.types';

declareSignalIo(ScreenFiltersEditorComponent, {
  inputs: ['filters', 'columns', 'mainTimeframe', 'extraTimeframes', 'disabled'],
  outputs: ['filtersChange'],
});

describe('ScreenFiltersEditorComponent (SS-I6)', () => {
  let fixture: ComponentFixture<ScreenFiltersEditorComponent>;
  let el: HTMLElement;
  let emitted: ScreenFilter[] | null;

  function set(filters: ScreenFilter[]): void {
    fixture.componentRef.setInput('filters', filters);
    fixture.detectChanges();
  }

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [ScreenFiltersEditorComponent] });
    fixture = TestBed.createComponent(ScreenFiltersEditorComponent);
    fixture.componentRef.setInput('columns', [
      { value: 'RSI', label: 'RSI' },
      { value: 'metric:netProfit', label: 'Net profit' },
    ]);
    fixture.componentRef.setInput('mainTimeframe', 'H1');
    fixture.componentRef.setInput('extraTimeframes', ['H4']);
    emitted = null;
    fixture.componentInstance.filtersChange.subscribe((f) => (emitted = f));
    set([]);
    el = fixture.nativeElement as HTMLElement;
  });

  it('adds a filter on the first suggested column', () => {
    expect(el.textContent).toContain('No filters');
    (el.querySelector('[data-testid="add-filter"]') as HTMLButtonElement).click();
    expect(emitted).toEqual([{ column: 'RSI', timeframe: null, op: 'gt', value: null }]);
  });

  it('edits the timeframe, condition and bounds, and removes a filter', () => {
    set([{ column: 'RSI', timeframe: null, op: 'gt', value: 70 }]);
    const [tf, op] = [...el.querySelectorAll<HTMLSelectElement>('[data-filter="0"] select')];
    expect([...tf.options].map((o) => o.textContent!.trim())).toEqual(['H1', 'H4']);
    tf.value = 'H4';
    tf.dispatchEvent(new Event('change'));
    expect(emitted).toEqual([{ column: 'RSI', timeframe: 'H4', op: 'gt', value: 70 }]);
    set(emitted!);

    op.value = 'between';
    op.dispatchEvent(new Event('change'));
    set(emitted!);
    const [, upper] = [
      ...el.querySelectorAll<HTMLInputElement>('[data-filter="0"] input[type="number"]'),
    ];
    upper.value = '80';
    upper.dispatchEvent(new Event('change'));
    expect(emitted).toEqual([
      { column: 'RSI', timeframe: 'H4', op: 'between', value: 70, value2: 80 },
    ]);

    set([{ column: 'RSI', op: 'isna' }]);
    expect(el.querySelectorAll('[data-filter="0"] input[type="number"]')).toHaveLength(0);
    const remove = [...el.querySelectorAll<HTMLButtonElement>('[data-filter="0"] button')][0];
    expect(remove.getAttribute('aria-label')).toBe('Remove filter 1: RSI is na');
    remove.click();
    expect(emitted).toEqual([]);
  });
});
