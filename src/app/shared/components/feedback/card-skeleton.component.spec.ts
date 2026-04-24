import { describe, it, expect } from 'vitest';
import { TestBed } from '@angular/core/testing';

import { CardSkeletonComponent } from './card-skeleton.component';

// Covers the default-render path only. Tests that need to vary signal inputs
// live under `describe.skip` below — on Angular 19.2 without Analog's AOT
// plugin, both `setInput` and host-template bindings fail to seed signal
// inputs before the first change-detection pass (NG0950). Revisit after the
// Angular 20 upgrade, when Analog's plugin stops mis-resolving
// `@angular/core/fesm2022/{null,undefined}`.
describe('CardSkeletonComponent (default render)', () => {
  function create() {
    TestBed.configureTestingModule({ imports: [CardSkeletonComponent] });
    const fixture = TestBed.createComponent(CardSkeletonComponent);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  it('renders the default four-line body', () => {
    const body = create().querySelector('.body')!;
    expect(body.children.length).toBe(4);
  });

  it('renders a header block by default', () => {
    expect(create().querySelector('.header')).not.toBeNull();
  });

  it('sets an aria-label for screen readers', () => {
    const card = create().querySelector('.card')!;
    expect(card.getAttribute('aria-label')).toBe('Loading');
    expect(card.getAttribute('role')).toBe('status');
  });

  it('computes per-line widths from a repeating pattern', () => {
    // Exercise the pure helper so we cover the computed path without
    // re-rendering under varied inputs.
    TestBed.configureTestingModule({ imports: [CardSkeletonComponent] });
    const fixture = TestBed.createComponent(CardSkeletonComponent);
    const instance = fixture.componentInstance;
    expect(instance.lineWidth(0)).toBe('100%');
    expect(instance.lineWidth(1)).toBe('88%');
    expect(instance.lineWidth(6)).toBe('100%'); // wraps
  });
});

describe.skip('CardSkeletonComponent (input variations — blocked on JIT setInput timing)', () => {
  // Still fails under Angular 20 + JIT: signal-backed `input()` defaults
  // don't propagate setInput writes before the first detectChanges pass.
  // Unblocks with a stable Analog Vite plugin (AOT) — currently only 3.x
  // alphas exist and they have broken peer deps against Angular 20.
  it('omits the header when showHeader is false', () => {
    /* ... */
  });
  it('honours a custom line count', () => {
    /* ... */
  });
});
