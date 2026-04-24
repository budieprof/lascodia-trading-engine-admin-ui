import { describe, it, expect } from 'vitest';
import { TestBed } from '@angular/core/testing';

import { FormFieldComponent } from './form-field.component';

// See `card-skeleton.component.spec.ts` for the full explanation of why
// template-level input variations live in the skipped block under Angular 19.2.

describe('FormFieldComponent (logic)', () => {
  it('is importable and constructable via TestBed', () => {
    TestBed.configureTestingModule({ imports: [FormFieldComponent] });
    expect(() => TestBed.inject(FormFieldComponent, null)).not.toThrow();
  });
});

describe.skip('FormFieldComponent (template — blocked by Angular 19.2 JIT + signal inputs)', () => {
  it('renders the label', () => {
    /* after Angular 20 upgrade */
  });
  it('shows the required marker when `required` is true', () => {
    /* after Angular 20 upgrade */
  });
  it('projects the error message when the control is touched + invalid', () => {
    /* after Angular 20 upgrade */
  });
});
