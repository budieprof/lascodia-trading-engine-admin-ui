import { afterEach, describe, expect, it } from 'vitest';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';

import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import { provideAuthWithPermissions } from '@core/testing/auth-test-double';
import { declareSignalIo } from '@shared/testing/jit-signal-io';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { LabImportCardComponent } from './lab-import-card.component';

declareSignalIo(LabImportCardComponent, { inputs: ['strategyId'] });
declareSignalIo(ConfirmDialogComponent, {
  inputs: ['open', 'title', 'message', 'confirmLabel', 'confirmVariant', 'loading'],
  outputs: ['confirm', 'cancelled'],
});

const BASE = 'http://test/api/v1/lascodia-trading-engine';
const trial = {
  windowFromUtc: '2024-01-01T00:00:00Z',
  windowToUtc: '2025-01-01T00:00:00Z',
  tradeR: [1, -1],
  dataHash: 'd',
  codeHash: 'c',
};

describe('LabImportCardComponent (U12 / V16)', () => {
  let fixture: ComponentFixture<LabImportCardComponent>;
  let http: HttpTestingController;
  let el: HTMLElement;

  function setup(...permissions: string[]): void {
    TestBed.configureTestingModule({
      imports: [LabImportCardComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideAuthWithPermissions(...permissions),
        { provide: RUNTIME_CONFIG, useValue: { apiBaseUrl: 'http://test' } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(LabImportCardComponent);
    fixture.componentRef.setInput('strategyId', 9);
    fixture.detectChanges();
    el = fixture.nativeElement as HTMLElement;
  }

  afterEach(() => http.verify());

  it('is hidden from a person without operator access', () => {
    setup('strategies.read');
    expect(el.querySelector('[data-testid="lab-import"]')).toBeNull();
  });

  it('checks the file first, then imports what it read', async () => {
    setup('access.operator');
    fixture.componentInstance.fileText.set(JSON.stringify([{ ...trial, dataHash: '' }]));
    fixture.detectChanges();
    expect(el.querySelector('[data-testid="li-errors"]')!.textContent).toContain('dataHash');

    fixture.componentInstance.fileText.set(JSON.stringify({ batch: 'mr-v4', trials: [trial] }));
    fixture.detectChanges();
    expect(el.querySelector('[data-testid="li-ready"]')!.textContent).toContain('1 trial ready');
    const done = fixture.componentInstance.submit();
    const req = http.expectOne(`${BASE}/strategy-feedback/9/trials/lab-import`);
    expect(req.request.body.batch).toBe('mr-v4');
    expect(req.request.body.trials).toHaveLength(1);
    req.flush({
      data: {
        lineageRootStrategyId: 5,
        imported: 1,
        duplicates: 0,
        reproductionsQueued: 1,
        trialIds: [44],
        notes: [],
      },
      status: true,
      message: 'Successful',
      responseCode: '00',
    });
    await done;
    fixture.detectChanges();
    expect(el.querySelector('[data-testid="li-result"]')!.textContent).toContain('Imported 1');
  });
});
