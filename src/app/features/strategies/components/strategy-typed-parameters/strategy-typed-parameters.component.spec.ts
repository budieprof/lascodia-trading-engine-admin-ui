import { describe, expect, it, beforeEach } from 'vitest';
import { TestBed, type ComponentFixture } from '@angular/core/testing';

import type { StrategyParameterSchemaDto } from '@core/api/api.types';
import {
  StrategyTypedParametersComponent,
  type TypedParameterChange,
} from './strategy-typed-parameters.component';

// b10-ui: the strategy form's typed parameter grid — one input per schema field with the value or its default, each
// edit reported (typed) for the form to merge into its Parameters JSON.

const SCHEMA = {
  strategyType: 'CompositeML',
  fields: [
    { name: 'mode', label: 'Mode', kind: 'enum', enumValues: ['Fast', 'Slow'], default: 'Slow' },
    { name: 'on', label: 'On', kind: 'bool', default: true },
    { name: 'period', label: 'Period', kind: 'int', default: 14, min: 2 },
    { name: 'tag', label: 'Tag', kind: 'string', default: 'x', description: 'a label' },
  ],
} as unknown as StrategyParameterSchemaDto;

describe('StrategyTypedParametersComponent', () => {
  let fixture: ComponentFixture<StrategyTypedParametersComponent>;
  let host: HTMLElement;
  let changes: TypedParameterChange[];

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [StrategyTypedParametersComponent] });
    fixture = TestBed.createComponent(StrategyTypedParametersComponent);
    host = fixture.nativeElement as HTMLElement;
    changes = [];
    fixture.componentInstance.changed.subscribe((c) => changes.push(c));
  });

  it('renders nothing without a schema', () => {
    fixture.detectChanges();
    expect(host.querySelector('.typed-params')).toBeNull();
  });

  it('one input per field, showing the value or the default, and reports each edit typed', () => {
    fixture.componentInstance.schema = SCHEMA;
    fixture.componentInstance.values = { period: 20 };
    fixture.detectChanges();
    expect(host.textContent).toContain('Typed parameters · 4 fields');
    const select = host.querySelector('select') as HTMLSelectElement;
    const inputs = host.querySelectorAll('input');
    const [checkbox, period, tag] = Array.from(inputs) as HTMLInputElement[];
    expect(checkbox.type).toBe('checkbox');
    expect(period.type).toBe('number');
    expect(period.value).toBe('20');
    expect(tag.value).toBe('x');

    select.value = 'Fast';
    select.dispatchEvent(new Event('change'));
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event('change'));
    period.value = '30';
    period.dispatchEvent(new Event('input'));
    tag.value = 'y';
    tag.dispatchEvent(new Event('input'));
    expect(changes).toEqual([
      { name: 'mode', value: 'Fast' },
      { name: 'on', value: false },
      { name: 'period', value: 30 },
      { name: 'tag', value: 'y' },
    ]);
  });
});
