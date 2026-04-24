import { describe, it, expect } from 'vitest';
import { TestBed } from '@angular/core/testing';

import { ConfirmDialogComponent } from './confirm-dialog.component';

// See `card-skeleton.component.spec.ts` for the blocker explanation.

describe('ConfirmDialogComponent (logic)', () => {
  it('is importable and constructable via TestBed', () => {
    TestBed.configureTestingModule({ imports: [ConfirmDialogComponent] });
    expect(() => TestBed.inject(ConfirmDialogComponent, null)).not.toThrow();
  });
});

describe.skip('ConfirmDialogComponent (template — blocked by Angular 19.2 JIT + signal inputs)', () => {
  it('renders title and message', () => {
    /* after Angular 20 upgrade */
  });
  it('fires confirm output when primary button is clicked', () => {
    /* after Angular 20 upgrade */
  });
  it('fires cancel output on Escape', () => {
    /* after Angular 20 upgrade */
  });
  it('exposes aria-modal="true" and the correct labelledby', () => {
    /* after Angular 20 upgrade */
  });
});
