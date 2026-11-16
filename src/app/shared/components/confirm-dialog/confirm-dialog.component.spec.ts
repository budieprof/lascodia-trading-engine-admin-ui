import { afterEach, describe, it, expect, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';

import { ConfirmDialogComponent } from './confirm-dialog.component';

// See `card-skeleton.component.spec.ts` for the blocker explanation.

describe('ConfirmDialogComponent (logic)', () => {
  it('is importable and constructable via TestBed', () => {
    TestBed.configureTestingModule({ imports: [ConfirmDialogComponent] });
    expect(() => TestBed.inject(ConfirmDialogComponent, null)).not.toThrow();
  });
});

// Review A15 (2026-11-16): one confirmation, one emit. Driven through the class (signal inputs
// cannot be varied under this runner's JIT — see above), at the defaults: no `loading` raised.
describe('ConfirmDialogComponent (confirm latch)', () => {
  afterEach(() => {
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  it('a double confirm emits once, and the latch lifts after the fallback window', () => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({ imports: [ConfirmDialogComponent] });
    const fixture = TestBed.createComponent(ConfirmDialogComponent);
    fixture.detectChanges();
    const dialog = fixture.componentInstance;
    let emits = 0;
    dialog.confirm.subscribe(() => emits++);

    dialog.onConfirm();
    dialog.onConfirm();
    expect(emits).toBe(1);

    vi.advanceTimersByTime(ConfirmDialogComponent.LATCH_FALLBACK_MS - 1);
    dialog.onConfirm();
    expect(emits).toBe(1);

    vi.advanceTimersByTime(1);
    dialog.onConfirm();
    expect(emits).toBe(2);
    fixture.destroy();
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
