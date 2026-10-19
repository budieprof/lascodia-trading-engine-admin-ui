import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestBed, type ComponentFixture } from '@angular/core/testing';

import { declareSignalIo } from '@shared/testing/jit-signal-io';

import { RefreshButtonComponent } from './refresh-button.component';

declareSignalIo(RefreshButtonComponent, {
  inputs: ['refreshing', 'label', 'variant'],
  outputs: ['refresh'],
});

describe('RefreshButtonComponent', () => {
  let fixture: ComponentFixture<RefreshButtonComponent>;
  let button: HTMLButtonElement;
  let clicks: number;

  function setRefreshing(v: boolean): void {
    fixture.componentRef.setInput('refreshing', v);
    fixture.detectChanges();
  }

  beforeEach(() => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({ imports: [RefreshButtonComponent] });
    fixture = TestBed.createComponent(RefreshButtonComponent);
    clicks = 0;
    // The parent's handler raises the resource's refreshing flag synchronously.
    fixture.componentInstance.refresh.subscribe(() => {
      clicks++;
      fixture.componentRef.setInput('refreshing', true);
    });
    setRefreshing(false);
    button = (fixture.nativeElement as HTMLElement).querySelector('button')!;
  });

  afterEach(() => vi.useRealTimers());

  it('shows visible progress while the refresh it started is in flight', () => {
    expect(button.textContent).toContain('Refresh');
    button.click();
    fixture.detectChanges();
    expect(clicks).toBe(1);
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.textContent).toContain('Refreshing…');

    // A second click while busy does not queue another fetch.
    button.click();
    expect(clicks).toBe(1);

    // The fetch lands; the busy state is held for its minimum, then clears.
    setRefreshing(false);
    vi.advanceTimersByTime(1000);
    fixture.detectChanges();
    expect(button.disabled).toBe(false);
    expect(button.textContent).toContain('Refresh');
    expect(button.textContent).not.toContain('Refreshing');
  });

  it('ignores background polls it did not start', () => {
    setRefreshing(true);
    expect(button.disabled).toBe(false);
    expect(button.textContent).not.toContain('Refreshing');
  });
});
