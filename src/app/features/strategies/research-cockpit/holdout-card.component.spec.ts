import { afterEach, describe, expect, it } from 'vitest';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';

import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import { provideAuthWithPermissions } from '@core/testing/auth-test-double';
import { declareSignalIo } from '@shared/testing/jit-signal-io';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { HoldoutCardComponent } from './holdout-card.component';

declareSignalIo(HoldoutCardComponent, { inputs: ['strategyId'] });
declareSignalIo(ConfirmDialogComponent, {
  inputs: ['open', 'title', 'message', 'confirmLabel', 'confirmVariant', 'loading'],
  outputs: ['confirm', 'cancelled'],
});

const BASE = 'http://test/api/v1/lascodia-trading-engine';
const ok = <T>(data: T) => ({ data, status: true, message: 'Successful', responseCode: '00' });
const settle = () => new Promise((r) => setTimeout(r, 0));
const locked = {
  id: 2,
  lineageRootStrategyId: 9,
  fromUtc: '2026-05-01T00:00:00',
  toUtc: '2026-11-01T00:00:00',
  status: 'Locked',
  mode: 'Enforce',
};

describe('HoldoutCardComponent (U12 / V03)', () => {
  let fixture: ComponentFixture<HoldoutCardComponent>;
  let http: HttpTestingController;
  let el: HTMLElement;

  function setup(...permissions: string[]): void {
    TestBed.configureTestingModule({
      imports: [HoldoutCardComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideAuthWithPermissions(...permissions),
        { provide: RUNTIME_CONFIG, useValue: { apiBaseUrl: 'http://test' } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(HoldoutCardComponent);
    fixture.componentRef.setInput('strategyId', 9);
    fixture.detectChanges();
    el = fixture.nativeElement as HTMLElement;
  }

  afterEach(() => http.verify());

  it('shows a locked holdout and spends it only through the confirm dialog', async () => {
    setup('access.operator');
    http.expectOne(`${BASE}/strategy/9/holdout`).flush(ok(locked));
    await settle();
    fixture.detectChanges();
    expect(el.querySelector('[data-testid="ho-status"]')!.textContent).toContain('Locked');
    const evaluate = [...el.querySelectorAll('button')].find((b) =>
      b.textContent!.includes('Evaluate'),
    )!;
    evaluate.click();
    fixture.detectChanges();
    http.expectNone(`${BASE}/strategy/9/holdout/evaluate`);
    expect(fixture.componentInstance.confirm()).toBe('evaluate');
    const done = fixture.componentInstance.act('evaluate');
    http
      .expectOne(`${BASE}/strategy/9/holdout/evaluate`)
      .flush(
        ok({
          ...locked,
          status: 'Spent',
          spentAtUtc: '2026-11-07T12:00:00',
          spentOnCurrentConfiguration: true,
          result: { expectancyR: 0.2, totalTrades: 30, rTrades: 30 },
        }),
      );
    await done;
    fixture.detectChanges();
    expect(el.querySelector('[data-testid="ho-status"]')!.textContent).toContain(
      'Spent 2026-11-07',
    );
    expect(el.textContent).toContain('+0.200 R');
    expect(
      [...el.querySelectorAll('button')].some((b) => b.textContent!.includes('Re-carve')),
    ).toBe(true);
  });

  it('says when the lineage has no holdout and offers no action to a reader', async () => {
    setup('strategies.read');
    http.expectOne(`${BASE}/strategy/9/holdout`).flush({
      data: null,
      status: false,
      message:
        "The strategy's lineage has no holdout yet (carved when its first evidence run is queued)",
      responseCode: '-14',
    });
    await settle();
    fixture.detectChanges();
    expect(el.textContent).toContain('carved when its first evidence run is queued');
    expect(el.querySelectorAll('.head button')).toHaveLength(0);
  });
});
