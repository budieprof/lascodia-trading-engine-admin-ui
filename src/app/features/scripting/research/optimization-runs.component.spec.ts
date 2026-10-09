import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';

import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import { declareSignalIo } from '@shared/testing/jit-signal-io';

import { ScriptDialogService } from '../shared/script-dialog.service';
import { OptimizationRunsComponent, RUN_POLL_MS } from './optimization-runs.component';

declareSignalIo(OptimizationRunsComponent, {
  inputs: ['strategyId', 'selectedId', 'canApprove', 'refreshKey'],
  outputs: ['runSelected', 'loaded'],
});

const BASE = 'http://test/api/v1/lascodia-trading-engine';
const ok = <T>(data: T) => ({ data, status: true, message: 'Successful', responseCode: '00' });
const page = <T>(data: T[]) => ok({ data, pager: { totalItemCount: data.length } });
const settle = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

function run(id: number, over: Record<string, unknown> = {}) {
  return {
    id,
    strategyId: 7,
    triggerType: 'Manual',
    status: 'Completed',
    iterations: 40,
    bestParametersJson: '{"Length":21}',
    bestHealthScore: 0.71,
    baselineParametersJson: null,
    baselineHealthScore: 0.6,
    errorMessage: null,
    startedAt: '2026-10-09T08:00:00Z',
    completedAt: '2026-10-09T09:00:00Z',
    approvedAt: null,
    searchSpecJson: null,
    ...over,
  };
}

describe('OptimizationRunsComponent (PE-I4)', () => {
  let fixture: ComponentFixture<OptimizationRunsComponent>;
  let http: HttpTestingController;
  let el: HTMLElement;
  const confirm = vi.fn(async () => true);

  beforeEach(() => {
    vi.useFakeTimers();
    confirm.mockClear();
    TestBed.configureTestingModule({
      imports: [OptimizationRunsComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: RUNTIME_CONFIG, useValue: { apiBaseUrl: 'http://test' } },
        { provide: ScriptDialogService, useValue: { confirm } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(OptimizationRunsComponent);
    fixture.componentRef.setInput('strategyId', 7);
    fixture.componentRef.setInput('canApprove', true);
    fixture.detectChanges();
    el = fixture.nativeElement as HTMLElement;
  });

  afterEach(() => {
    http.verify();
    vi.useRealTimers();
  });

  const list = () => http.expectOne(`${BASE}/strategy-feedback/optimization/list`);

  it('reads the newest runs first and re-reads while one is going', async () => {
    const req = list();
    expect(req.request.body).toEqual({
      currentPage: 1,
      itemCountPerPage: 20,
      filter: { strategyId: 7 },
      sortBy: 'Id',
      sortDirection: 'desc',
    });
    req.flush(
      page([
        run(90, {
          status: 'Running',
          executionStage: 'Search',
          executionStageMessage: '12 of 40 evaluations',
          completedAt: null,
          searchSpecJson: '{"ranges":{},"locked":{},"objective":"ExpectancyR"}',
        }),
        run(88),
      ]),
    );
    await settle();
    fixture.detectChanges();

    const first = el.querySelector('tr[data-run="90"]')!.textContent!;
    expect(first).toContain('Search: 12 of 40 evaluations');
    expect(first).toContain('Expectancy (R per trade)');
    expect(first).toContain('spec');
    expect(el.textContent).toContain('Updating while a run is going');

    await vi.advanceTimersByTimeAsync(RUN_POLL_MS);
    list().flush(page([run(90), run(88)]));
    await settle();
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(RUN_POLL_MS);
    http.expectNone(`${BASE}/strategy-feedback/optimization/list`); // nothing going any more
  });

  it('approves a completed run only after the operator confirms', async () => {
    list().flush(page([run(88)]));
    await settle();
    fixture.detectChanges();

    (el.querySelector('tr[data-run="88"] .actions button') as HTMLButtonElement).click();
    await settle();
    expect(confirm).toHaveBeenCalledTimes(1);
    http.expectOne(`${BASE}/strategy-feedback/optimization/88/approve`).flush(ok(null));
    await settle();
    list().flush(page([run(88, { status: 'Approved' })]));
    await settle();
  });

  it('does nothing when the operator cancels', async () => {
    confirm.mockResolvedValueOnce(false);
    list().flush(page([run(88)]));
    await settle();
    fixture.detectChanges();
    (el.querySelectorAll('tr[data-run="88"] .actions button')[1] as HTMLButtonElement).click();
    await settle();
    http.expectNone(`${BASE}/strategy-feedback/optimization/88/reject`);
  });

  it('opens a run when its row is chosen', async () => {
    let chosen: number | null = null;
    fixture.componentInstance.runSelected.subscribe((id) => (chosen = id));
    list().flush(page([run(88)]));
    await settle();
    fixture.detectChanges();
    (el.querySelector('tr[data-run="88"]') as HTMLElement).click();
    expect(chosen).toBe(88);
  });
});
