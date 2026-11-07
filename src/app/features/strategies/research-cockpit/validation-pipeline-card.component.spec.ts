import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';

import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import { provideAuthWithPermissions } from '@core/testing/auth-test-double';
import { declareSignalIo } from '@shared/testing/jit-signal-io';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { GateRowsTableComponent } from '../components/gate-rows-table/gate-rows-table.component';
import { ValidationPipelineCardComponent } from './validation-pipeline-card.component';

declareSignalIo(ValidationPipelineCardComponent, { inputs: ['strategyId'] });
declareSignalIo(GateRowsTableComponent, { inputs: ['rows', 'showCounts', 'ariaLabel'] });
declareSignalIo(ConfirmDialogComponent, {
  inputs: ['open', 'title', 'message', 'confirmLabel', 'confirmVariant', 'loading'],
  outputs: ['confirm', 'cancelled'],
});

const BASE = 'http://test/api/v1/lascodia-trading-engine';
const ok = <T>(data: T) => ({ data, status: true, message: 'Successful', responseCode: '00' });
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('ValidationPipelineCardComponent (U12 / S13)', () => {
  let fixture: ComponentFixture<ValidationPipelineCardComponent>;
  let http: HttpTestingController;
  let el: HTMLElement;

  function setup(...permissions: string[]): void {
    TestBed.configureTestingModule({
      imports: [ValidationPipelineCardComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        provideAuthWithPermissions(...permissions),
        { provide: RUNTIME_CONFIG, useValue: { apiBaseUrl: 'http://test' } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(ValidationPipelineCardComponent);
    fixture.componentRef.setInput('strategyId', 9);
    fixture.detectChanges();
    el = fixture.nativeElement as HTMLElement;
  }

  afterEach(() => {
    fixture?.destroy();
    http.verify();
  });

  it('shows the steps, their runs and the dry-run gate rows of the newest pipeline', async () => {
    setup('access.operator');
    http.expectOne(`${BASE}/strategy/9/validation-pipeline`).flush(
      ok({
        id: 3,
        strategyId: 9,
        status: 'Completed',
        currentStep: 'Done',
        gatesPassed: false,
        steps: [
          { name: 'Backtest', status: 'Completed', runId: 812 },
          {
            name: 'WalkForward',
            status: 'Completed',
            runId: 77,
            outcome: 'stitched OOS ExpectancyR +0.120',
          },
          { name: 'Gates', status: 'Completed', outcome: 'failed: dsr' },
          { name: 'Paper', status: 'Skipped' },
        ],
        gateResult: {
          passed: false,
          rows: [
            {
              gate: 'dsr',
              outcome: 'Fail',
              value: 0.4,
              threshold: 0.95,
              unit: 'probability',
              comparator: '>=',
              detail: '',
            },
          ],
        },
      }),
    );
    await settle();
    fixture.detectChanges();
    const steps = [...el.querySelectorAll('.stepper li')];
    expect(steps).toHaveLength(4);
    expect(steps[1].textContent).toContain('run #77');
    expect(steps[1].textContent).toContain('+0.120');
    expect(steps[3].textContent).toContain('Skipped');
    expect(el.querySelector('app-gate-rows-table')).not.toBeNull();
    // Not running: the operator may start a new one.
    expect(el.querySelector('[data-testid="vp-start"]')).not.toBeNull();
  });

  it('starts only from the confirm dialog and sends the paper choice', async () => {
    setup('access.operator');
    http.expectOne(`${BASE}/strategy/9/validation-pipeline`).flush({
      data: null,
      status: false,
      message: 'Validation pipeline not found',
      responseCode: '-14',
    });
    await settle();
    fixture.detectChanges();
    expect(el.textContent).toContain('No validation pipeline has run');
    (el.querySelector('[data-testid="vp-start"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    // The click opened the dialog — nothing was sent yet.
    http.expectNone(`${BASE}/strategy/9/validation-pipeline`);
    expect(fixture.componentInstance.confirm()).toBe('start');
    const done = fixture.componentInstance.start();
    const req = http.expectOne(
      (r) => r.method === 'POST' && r.url === `${BASE}/strategy/9/validation-pipeline`,
    );
    expect(req.request.body).toEqual({ startPaper: false });
    req.flush(ok(4));
    await settle();
    http
      .expectOne(`${BASE}/strategy/9/validation-pipeline`)
      .flush(ok({ id: 4, strategyId: 9, status: 'Queued', currentStep: 'Backtest', steps: [] }));
    await done;
    fixture.detectChanges();
    expect(el.textContent).toContain('Pipeline #4 queued');
    expect(el.querySelector('[data-testid="vp-start"]')).toBeNull(); // active: Cancel instead
  });

  it('offers no start without operator access', async () => {
    setup('strategies.read');
    http
      .expectOne(`${BASE}/strategy/9/validation-pipeline`)
      .flush({ data: null, status: false, message: 'x', responseCode: '-14' });
    await settle();
    fixture.detectChanges();
    expect(el.querySelector('[data-testid="vp-start"]')).toBeNull();
  });
});
