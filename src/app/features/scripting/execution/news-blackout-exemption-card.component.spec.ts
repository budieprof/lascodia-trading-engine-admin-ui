import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';

import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import { NotificationService } from '@core/notifications/notification.service';

import { NewsBlackoutExemptionCardComponent } from './news-blackout-exemption-card.component';
import { TypedConfirmDialogComponent } from './typed-confirm-dialog.component';
import { declareSignalIo } from '@shared/testing/jit-signal-io';

declareSignalIo(NewsBlackoutExemptionCardComponent, {
  inputs: ['strategyId', 'strategyName', 'exempt'],
  outputs: ['changed'],
});
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

const STRATEGY_URL = 'http://test/api/v1/lascodia-trading-engine/strategy/41';
const OK = { data: true, status: true, message: 'Successful', responseCode: '00' };

describe('NewsBlackoutExemptionCardComponent', () => {
  let fixture: ComponentFixture<NewsBlackoutExemptionCardComponent>;
  let http: HttpTestingController;
  let el: HTMLElement;
  let toasts: { success: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

  function render(exempt: boolean): void {
    fixture = TestBed.createComponent(NewsBlackoutExemptionCardComponent);
    fixture.componentRef.setInput('strategyId', 41);
    fixture.componentRef.setInput('strategyName', 'NFP fade');
    fixture.componentRef.setInput('exempt', exempt);
    fixture.detectChanges();
    el = fixture.nativeElement as HTMLElement;
  }

  const q = <T extends HTMLElement>(id: string) => el.querySelector<T>(`[data-testid="${id}"]`);
  const switchBtn = () => q<HTMLButtonElement>('exemption-switch')!;
  const reviewBtn = () => q<HTMLButtonElement>('exemption-review')!;
  const dialog = () => el.querySelector<HTMLElement>('[role="alertdialog"]');
  const type = (text: string) => {
    const area = q<HTMLTextAreaElement>('exemption-reason')!;
    area.value = text;
    area.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  };
  const click = (b: HTMLElement) => {
    b.click();
    fixture.detectChanges();
  };

  beforeEach(() => {
    toasts = { success: vi.fn(), error: vi.fn() };
    TestBed.configureTestingModule({
      imports: [NewsBlackoutExemptionCardComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: RUNTIME_CONFIG, useValue: { apiBaseUrl: 'http://test' } },
        { provide: NotificationService, useValue: { ...toasts, info: vi.fn(), warning: vi.fn() } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('shows the current state clearly and explains the blackout', () => {
    render(false);
    expect(switchBtn().getAttribute('role')).toBe('switch');
    expect(switchBtn().getAttribute('aria-checked')).toBe('false');
    expect(q('exemption-state')!.textContent).toContain('Not exempt');
    expect(el.textContent).toContain('High-impact');
    expect(q('exemption-pending')).toBeNull();

    fixture.componentRef.setInput('exempt', true);
    fixture.detectChanges();
    expect(switchBtn().getAttribute('aria-checked')).toBe('true');
    expect(q('exemption-state')!.textContent).toContain('Exempt.');
  });

  it('needs a reason of at least 10 characters before a grant can be reviewed', () => {
    render(false);
    click(switchBtn());
    expect(switchBtn().getAttribute('aria-checked')).toBe('true');
    expect(q('exemption-unsaved')).toBeTruthy();
    // Flipping the switch saves nothing on its own.
    expect(q('exemption-state')!.textContent).toContain('Not exempt');
    expect(reviewBtn().disabled).toBe(true);

    type('too short');
    expect(reviewBtn().disabled).toBe(true);
    expect(el.querySelector('.hint.problem')!.textContent).toContain('at least 10 characters');

    type('Fades the first NFP minute');
    expect(reviewBtn().disabled).toBe(false);
    http.expectNone(STRATEGY_URL);
  });

  it('confirms what a grant does, then saves it with the reason and reports success', () => {
    render(false);
    const changed = vi.fn();
    fixture.componentInstance.changed.subscribe(changed);
    click(switchBtn());
    type('  Fades the first NFP minute  ');
    click(reviewBtn());

    const text = dialog()!.textContent!;
    expect(text).toContain('Exempt this strategy from the news blackout?');
    expect(text).toContain('live, paper and backtest entries are NOT blocked');
    expect(text).toContain('designed around releases');
    expect(text).toContain('Fades the first NFP minute');
    http.expectNone(STRATEGY_URL);

    click(dialog()!.querySelector<HTMLButtonElement>('.btn.confirm')!);
    const req = http.expectOne(STRATEGY_URL);
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual({
      newsBlackoutExempt: true,
      newsBlackoutExemptReason: 'Fades the first NFP minute',
      changeReason: 'News-blackout exemption granted',
    });
    // Not shown as exempt until the engine accepts.
    expect(q('exemption-state')!.textContent).toContain('Not exempt');
    req.flush(OK);
    fixture.detectChanges();

    expect(q('exemption-state')!.textContent).toContain('Exempt.');
    expect(switchBtn().getAttribute('aria-checked')).toBe('true');
    expect(q('exemption-pending')).toBeNull();
    expect(dialog()).toBeNull();
    expect(toasts.success).toHaveBeenCalledWith('News-blackout exemption granted for NFP fade');
    expect(changed).toHaveBeenCalledWith(true);
  });

  it('surfaces the engine’s refusal, keeps the state and the pending reason', () => {
    render(false);
    click(switchBtn());
    type('Fades the first NFP minute');
    click(reviewBtn());
    click(dialog()!.querySelector<HTMLButtonElement>('.btn.confirm')!);
    const refusal =
      'Strategy 41 is not a Pine script strategy: the news-blackout exemption exists only for script strategies designed to trade around releases.';
    http.expectOne(STRATEGY_URL).flush({
      data: false,
      status: false,
      message: refusal,
      responseCode: '-11',
    });
    fixture.detectChanges();

    expect(el.querySelector('[role="alert"]')!.textContent).toContain('not a Pine script');
    expect(toasts.error).toHaveBeenCalledWith(refusal);
    expect(toasts.success).not.toHaveBeenCalled();
    expect(q('exemption-state')!.textContent).toContain('Not exempt');
    expect(q<HTMLTextAreaElement>('exemption-reason')!.value).toBe('Fades the first NFP minute');
  });

  it('surfaces an HTTP failure the same way', () => {
    render(false);
    click(switchBtn());
    type('Fades the first NFP minute');
    click(reviewBtn());
    click(dialog()!.querySelector<HTMLButtonElement>('.btn.confirm')!);
    http
      .expectOne(STRATEGY_URL)
      .flush(
        { status: false, message: 'NewsBlackoutExemptReason cannot exceed 1000 characters.' },
        { status: 400, statusText: 'Bad Request' },
      );
    fixture.detectChanges();
    expect(toasts.error).toHaveBeenCalledWith(
      'NewsBlackoutExemptReason cannot exceed 1000 characters.',
    );
    expect(q('exemption-state')!.textContent).toContain('Not exempt');
  });

  it('revokes with an optional reason after confirming', () => {
    render(true);
    const changed = vi.fn();
    fixture.componentInstance.changed.subscribe(changed);
    click(switchBtn());
    expect(switchBtn().getAttribute('aria-checked')).toBe('false');
    expect(reviewBtn().disabled).toBe(false);
    click(reviewBtn());
    expect(dialog()!.textContent).toContain('Restore the news blackout for this strategy?');
    expect(dialog()!.textContent).toContain('No reason given.');
    click(dialog()!.querySelector<HTMLButtonElement>('.btn.confirm')!);

    const req = http.expectOne(STRATEGY_URL);
    expect(req.request.body).toEqual({
      newsBlackoutExempt: false,
      newsBlackoutExemptReason: null,
      changeReason: 'News-blackout exemption revoked',
    });
    req.flush(OK);
    fixture.detectChanges();
    expect(q('exemption-state')!.textContent).toContain('Not exempt');
    expect(toasts.success).toHaveBeenCalledWith(
      'News-blackout exemption revoked for NFP fade — the blackout applies again',
    );
    expect(changed).toHaveBeenCalledWith(false);
  });

  it('abandons a pending change on cancel, or by flipping the switch back', () => {
    render(false);
    click(switchBtn());
    type('Fades the first NFP minute');
    click(el.querySelector<HTMLButtonElement>('.pending .btn.secondary')!);
    expect(q('exemption-pending')).toBeNull();
    expect(switchBtn().getAttribute('aria-checked')).toBe('false');

    click(switchBtn());
    expect(q('exemption-pending')).toBeTruthy();
    click(switchBtn());
    expect(q('exemption-pending')).toBeNull();
    http.expectNone(STRATEGY_URL);
  });

  it('closing the confirmation sends nothing and keeps the pending change', () => {
    render(false);
    click(switchBtn());
    type('Fades the first NFP minute');
    click(reviewBtn());
    click(dialog()!.querySelector<HTMLButtonElement>('.btn.secondary')!);
    expect(dialog()).toBeNull();
    expect(q('exemption-pending')).toBeTruthy();
    http.expectNone(STRATEGY_URL);
  });
});
