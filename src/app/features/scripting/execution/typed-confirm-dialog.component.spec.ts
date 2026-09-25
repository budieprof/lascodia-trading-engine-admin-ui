import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TestBed, type ComponentFixture } from '@angular/core/testing';

import { TypedConfirmDialogComponent } from './typed-confirm-dialog.component';
import { declareSignalIo } from '@shared/testing/jit-signal-io';

declareSignalIo(TypedConfirmDialogComponent, {
  inputs: [
    'open',
    'title',
    'message',
    'details',
    'expected',
    'promptLabel',
    'confirmLabel',
    'tone',
    'busy',
  ],
  outputs: ['confirmed', 'cancelled'],
});

describe('TypedConfirmDialogComponent', () => {
  let fixture: ComponentFixture<TypedConfirmDialogComponent>;
  let el: HTMLElement;
  let confirmed: ReturnType<typeof vi.fn>;
  let cancelled: ReturnType<typeof vi.fn>;

  function render(inputs: Record<string, unknown>): void {
    fixture = TestBed.createComponent(TypedConfirmDialogComponent);
    for (const [k, v] of Object.entries(inputs)) fixture.componentRef.setInput(k, v);
    confirmed = vi.fn();
    cancelled = vi.fn();
    fixture.componentInstance.confirmed.subscribe(confirmed);
    fixture.componentInstance.cancelled.subscribe(cancelled);
    fixture.detectChanges();
    el = fixture.nativeElement as HTMLElement;
  }

  const confirmBtn = () => el.querySelector<HTMLButtonElement>('.btn.confirm')!;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [TypedConfirmDialogComponent] });
  });

  it('renders nothing while closed', () => {
    render({ open: false });
    expect(el.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it('is a labelled modal alertdialog', () => {
    render({
      open: true,
      title: 'Bind a REAL-money account',
      message: 'Careful.',
      details: ['One', 'Two'],
    });
    const d = el.querySelector('[role="alertdialog"]')!;
    expect(d.getAttribute('aria-modal')).toBe('true');
    expect(el.querySelector(`#${d.getAttribute('aria-labelledby')}`)!.textContent).toContain(
      'Bind a REAL-money account',
    );
    expect(el.querySelector(`#${d.getAttribute('aria-describedby')}`)!.textContent).toContain(
      'Two',
    );
  });

  it('gates confirm on the typed phrase and confirms on Enter once it matches', () => {
    render({ open: true, expected: ['99887766'], confirmLabel: 'Bind REAL account' });
    expect(confirmBtn().disabled).toBe(true);
    const input = el.querySelector<HTMLInputElement>('input.phrase')!;
    input.value = '99887766';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(confirmBtn().disabled).toBe(false);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(confirmed).toHaveBeenCalledTimes(1);
  });

  it('is a plain confirm when no phrase is expected', () => {
    render({ open: true, expected: [] });
    expect(el.querySelector('input.phrase')).toBeNull();
    confirmBtn().click();
    expect(confirmed).toHaveBeenCalledTimes(1);
  });

  it('cancels on Escape and on the backdrop, never while busy', () => {
    render({ open: true });
    el.querySelector('[role="alertdialog"]')!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    expect(cancelled).toHaveBeenCalledTimes(1);
    (el.querySelector('.overlay') as HTMLElement).click();
    expect(cancelled).toHaveBeenCalledTimes(2);

    fixture.componentRef.setInput('busy', true);
    fixture.detectChanges();
    (el.querySelector('.overlay') as HTMLElement).click();
    expect(cancelled).toHaveBeenCalledTimes(2);
    expect(confirmBtn().textContent).toContain('Working');
  });

  it('clears what was typed each time it opens', () => {
    render({ open: true, expected: ['x'] });
    fixture.componentInstance.typed.set('x');
    fixture.componentRef.setInput('open', false);
    fixture.detectChanges();
    fixture.componentRef.setInput('open', true);
    fixture.detectChanges();
    expect(fixture.componentInstance.typed()).toBe('');
  });
});
