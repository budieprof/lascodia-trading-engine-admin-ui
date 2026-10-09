import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';

import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import { declareSignalIo } from '@shared/testing/jit-signal-io';

import { ChartCardStubComponent } from '../testing/stubs';
import { OptimizationRunDetailComponent } from './optimization-run-detail.component';
import { ParameterHeatmapComponent } from './parameter-heatmap.component';
import type { OptimizationCandidatesDto, OptimizationHeatmapDto } from './research.types';

declareSignalIo(OptimizationRunDetailComponent, { inputs: ['runId'] });
declareSignalIo(ParameterHeatmapComponent, { inputs: ['runId'] });

const BASE = 'http://test/api/v1/lascodia-trading-engine';
const ok = <T>(data: T) => ({ data, status: true, message: 'Successful', responseCode: '00' });
const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

function candidates(): OptimizationCandidatesDto {
  return {
    optimizationRunId: 88,
    strategyId: 7,
    status: 'Completed',
    completedAt: '2026-10-09T10:00:00Z',
    objective: 'ExpectancyR',
    candidates: 3,
    candidatesWithR: 3,
    sortBy: 'healthScore',
    rows: [
      {
        rank: 1,
        parametersJson: '{"Length":21}',
        parameters: { __ScriptInputs: 9, Length: 21 },
        healthScore: 0.71,
        expectancyR: 0.21,
        sharpeR: 0.19,
        trades: 140,
        rTrades: 138,
        isWinner: true,
        folds: [{ trades: 28, rTrades: 28, meanR: 0.3, sharpeR: 0.25 }, null],
      },
      {
        rank: 2,
        parametersJson: '{"Length":10}',
        parameters: { __ScriptInputs: 9, Length: 10 },
        healthScore: 0.6,
        expectancyR: -0.05,
        sharpeR: -0.04,
        trades: 90,
        rTrades: 90,
        isWinner: false,
        folds: [],
      },
    ],
    selection: {
      selectedParametersJson: '{"Length":21}',
      selectedIsWinner: true,
      selectedSharpeR: 0.19,
      selectedRTrades: 138,
      runTrials: 3,
      ledgerTrials: 40,
      peerStrategies: 31,
      effectiveTrials: 40,
      deflatedSharpeRun: 1.4,
      deflatedSharpeEffective: 0.6,
      minDsr: 1,
      pbo: 0.45,
      pboBlocks: 5,
      pboCombinations: 10,
      pboMedianLogit: -0.2,
      pboWhyNot: null,
      maxPbo: 0.3,
      degradationSlope: -0.8,
      warnings: [
        'Probability of backtest overfitting is 45 %, above the promotion limit of 30 %: …',
      ],
    },
    cscvSplits: [
      { inSampleSharpe: 0.4, outOfSampleSharpe: -0.1, logit: -0.7 },
      { inSampleSharpe: 0.3, outOfSampleSharpe: 0.1, logit: 0.2 },
      { inSampleSharpe: 0.5, outOfSampleSharpe: null, logit: -1.5 },
    ],
    validation: {
      passed: false,
      hasOosValidation: true,
      inSampleHealthScore: 0.71,
      outOfSampleHealthScore: 0.42,
      failureReason: 'failed pessimistic cost test',
    },
    whyNot: null,
  };
}

function heatmap(): OptimizationHeatmapDto {
  return {
    optimizationRunId: 88,
    strategyId: 7,
    candidates: 3,
    parameters: [{ id: 'Length', numeric: true, distinct: 3, min: 10, max: 30 }],
    heatmap: null,
    plateau: {
      score: 0.3,
      peakExpectancyR: 0.21,
      neighboursMeanExpectancyR: 0.06,
      neighbours: 2,
      positiveShare: 0.5,
    },
    peakParametersJson: '{"Length":21}',
    whyNot: 'the candidates vary in 1 parameter(s); a heatmap needs two',
  };
}

describe('OptimizationRunDetailComponent (PE-I4, BT-I4, BT-I7)', () => {
  let fixture: ComponentFixture<OptimizationRunDetailComponent>;
  let http: HttpTestingController;
  let el: HTMLElement;

  beforeEach(async () => {
    TestBed.configureTestingModule({
      imports: [OptimizationRunDetailComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: RUNTIME_CONFIG, useValue: { apiBaseUrl: 'http://test' } },
      ],
    });
    TestBed.overrideComponent(OptimizationRunDetailComponent, {
      remove: { imports: [ChartCardComponent] },
      add: { imports: [ChartCardStubComponent] },
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(OptimizationRunDetailComponent);
    fixture.componentRef.setInput('runId', 88);
    fixture.detectChanges();
    el = fixture.nativeElement as HTMLElement;
    http
      .expectOne(
        `${BASE}/strategy-feedback/optimization/88/candidates?sortBy=healthScore&limit=200`,
      )
      .flush(ok(candidates()));
    await settle();
    fixture.detectChanges();
    http
      .expectOne(`${BASE}/strategy-feedback/optimization/88/heatmap?bins=10`)
      .flush(ok(heatmap()));
    await settle();
    fixture.detectChanges();
  });

  afterEach(() => http.verify());

  it('shows the engine’s overfitting warnings and numbers against the promotion limits', () => {
    expect(el.querySelector('[data-testid="overfit-warnings"]')!.textContent).toContain(
      'above the promotion limit of 30 %',
    );
    const evidence = el.querySelector('table.evidence')!.textContent!;
    expect(evidence).toContain('0.60'); // effective-trials DSR
    expect(evidence).toContain('45%');
    expect(evidence).toContain('deflated by 40 trials');
    expect(el.querySelector('[data-testid="run-validation"]')!.textContent).toContain(
      'health 0.710 in sample → 0.420 out of sample',
    );
  });

  it('lists the candidates with their parameters (not the space marker), the chosen one marked', () => {
    const table = el.querySelector('[data-testid="candidates-table"]')!;
    const headers = [...table.querySelectorAll('thead th')].map((h) => h.textContent!.trim());
    expect(headers).toContain('Length');
    expect(headers).not.toContain('__ScriptInputs');
    const first = table.querySelector('tbody tr')!;
    expect(first.classList).toContain('winner');
    expect(first.textContent).toContain('chosen');
    expect(first.querySelectorAll('.fold')).toHaveLength(2);
  });

  it('draws the IS vs OOS splits and the logit histogram', () => {
    const titles = [...el.querySelectorAll('.chart-stub')].map((c) => c.getAttribute('data-title'));
    expect(titles).toEqual([
      'In-sample vs out-of-sample Sharpe',
      'Where the in-sample winner ranked out of sample',
    ]);
    expect(fixture.componentInstance.scatter()).not.toBeNull();
  });

  it('re-reads the candidates in another order without rebuilding the heatmap', async () => {
    const select = el.querySelector<HTMLSelectElement>('select[aria-label="Sort candidates"]')!;
    select.value = 'expectancyR';
    select.dispatchEvent(new Event('change'));
    http
      .expectOne(
        `${BASE}/strategy-feedback/optimization/88/candidates?sortBy=expectancyR&limit=200`,
      )
      .flush(ok(candidates()));
    await settle();
    fixture.detectChanges();
    http.expectNone(`${BASE}/strategy-feedback/optimization/88/heatmap?bins=10`);
    expect(fixture.componentInstance.sortBy()).toBe('expectancyR');
  });

  it('says why there is no heatmap and still reads the full-space plateau', () => {
    const card = el.querySelector('[data-testid="parameter-heatmap"]')!;
    expect(card.textContent).toContain('a heatmap needs two');
    expect(card.querySelector('[data-testid="plateau-readout"]')!.textContent).toContain(
      'keep 30%',
    );
    expect(card.querySelector('[data-testid="plateau-readout"]')!.getAttribute('data-level')).toBe(
      'spike',
    );
  });
});
