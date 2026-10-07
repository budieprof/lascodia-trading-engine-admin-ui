import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { signal, type WritableSignal } from '@angular/core';

import { UNDO_NOTICE_MS, UndoNoticeComponent } from './undo-notice.component';

// Signal inputs cannot be set under the JIT harness before the first render, so the spec swaps the
// component's input signal for a writable one before detectChanges (as the settings-dialog spec does).

describe('UndoNoticeComponent', () => {
  let fixture: ComponentFixture<UndoNoticeComponent>;
  let host: HTMLElement;
  let message: WritableSignal<string | null>;
  let action: Mock<() => void>;
  let dismissed: Mock<() => void>;

  const button = (text: string) =>
    [...host.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === text || b.getAttribute('aria-label') === text,
    )!;
  const card = () => host.querySelector('.un') as HTMLElement | null;

  function render(text: string | null): void {
    TestBed.configureTestingModule({ imports: [UndoNoticeComponent] });
    fixture = TestBed.createComponent(UndoNoticeComponent);
    const cmp = fixture.componentInstance;
    message = signal(text);
    (cmp as any).message = message;
    (cmp as any).actionLabel = signal('Undo');
    action = vi.fn<() => void>();
    dismissed = vi.fn<() => void>();
    cmp.action.subscribe(action);
    cmp.dismissed.subscribe(dismissed);
    fixture.detectChanges();
    host = fixture.nativeElement;
  }

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('shows the message in a polite live region that is there before any message', () => {
    render(null);
    const region = host.querySelector('[role="status"]')!;
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(card()).toBeNull();
    message.set('Replaced MeanRev v5 with MA Cross: one strategy at a time on the chart');
    fixture.detectChanges();
    expect(region.textContent).toContain('Replaced MeanRev v5 with MA Cross');
    expect(button('Undo')).toBeTruthy();
    expect(button('Dismiss')).toBeTruthy();
  });

  it('Undo is the action; × dismisses', () => {
    render('Replaced A with B');
    button('Undo').click();
    expect(action).toHaveBeenCalledTimes(1);
    expect(dismissed).not.toHaveBeenCalled();
    button('Dismiss').click();
    expect(dismissed).toHaveBeenCalledTimes(1);
  });

  it('dismisses itself after about eight seconds', () => {
    render('Replaced A with B');
    vi.advanceTimersByTime(UNDO_NOTICE_MS - 1);
    expect(dismissed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(dismissed).toHaveBeenCalledTimes(1);
    expect(UNDO_NOTICE_MS).toBe(8_000);
  });

  it('holds while the pointer or the focus is on it, and gives the full time back after', () => {
    render('Replaced A with B');
    card()!.dispatchEvent(new Event('pointerenter'));
    vi.advanceTimersByTime(UNDO_NOTICE_MS * 3);
    expect(dismissed).not.toHaveBeenCalled();
    card()!.dispatchEvent(new Event('pointerleave'));
    vi.advanceTimersByTime(UNDO_NOTICE_MS - 1);
    expect(dismissed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(dismissed).toHaveBeenCalledTimes(1);

    // Focus moving from one of its buttons to the other is still on it.
    message.set('Replaced B with C');
    fixture.detectChanges();
    button('Undo').dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    button('Undo').dispatchEvent(
      new FocusEvent('focusout', { bubbles: true, relatedTarget: button('Dismiss') }),
    );
    vi.advanceTimersByTime(UNDO_NOTICE_MS * 2);
    expect(dismissed).toHaveBeenCalledTimes(1);
  });

  it('a new message starts the time again', () => {
    render('Replaced A with B');
    vi.advanceTimersByTime(UNDO_NOTICE_MS - 1_000);
    message.set('Replaced B with C');
    fixture.detectChanges();
    vi.advanceTimersByTime(UNDO_NOTICE_MS - 1);
    expect(dismissed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(dismissed).toHaveBeenCalledTimes(1);
  });
});
