import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { of } from 'rxjs';

import type { PromotionGatesDto, ResponseData } from '@core/api/api.types';
import { StrategiesService } from '@core/services/strategies.service';
import { NotificationService } from '@core/notifications/notification.service';
import { declareSignalIo } from '@shared/testing/jit-signal-io';
import { GateRowsTableComponent } from '../gate-rows-table/gate-rows-table.component';
import {
  PromotionReadinessCardComponent,
  parseDiagnostic,
} from './promotion-readiness-card.component';

// U03: render the engine's C2 gate rows (outcome chips, value vs threshold); keep the text parse as
// the fallback for engines/answers without rows — and make that fallback show "Pass" at all.

declareSignalIo(GateRowsTableComponent, { inputs: ['rows', 'showCounts', 'ariaLabel'] });
declareSignalIo(PromotionReadinessCardComponent, {
  inputs: ['strategyId'],
  outputs: ['activated'],
});

const env = (data: PromotionGatesDto): ResponseData<PromotionGatesDto> =>
  ({
    data,
    status: true,
    message: 'Successful',
    responseCode: '00',
  }) as ResponseData<PromotionGatesDto>;

describe('PromotionReadinessCardComponent', () => {
  let fixture: ComponentFixture<PromotionReadinessCardComponent>;
  let el: HTMLElement;
  let getGates: ReturnType<typeof vi.fn>;

  function render(data: PromotionGatesDto): void {
    getGates.mockReturnValue(of(env(data)));
    fixture = TestBed.createComponent(PromotionReadinessCardComponent);
    el = fixture.nativeElement as HTMLElement;
    fixture.componentRef.setInput('strategyId', 11);
    fixture.detectChanges();
    fixture.detectChanges();
  }

  beforeEach(() => {
    getGates = vi.fn();
    TestBed.configureTestingModule({
      imports: [PromotionReadinessCardComponent],
      providers: [
        {
          provide: StrategiesService,
          useValue: { getPromotionGates: getGates, activate: vi.fn() },
        },
        { provide: NotificationService, useValue: { success: vi.fn(), error: vi.fn() } },
      ],
    });
  });

  it('renders the structured rows with outcome chips and value vs threshold', () => {
    render({
      passed: false,
      failureSummary: 'DSR 0.81 < 0.95',
      diagnostics: ['DSR: PSR=0.81', 'CPCV (16): p25=0.41'],
      rows: [
        {
          gate: 'dsr',
          outcome: 'Fail',
          value: 0.81,
          threshold: 0.95,
          unit: 'probability',
          comparator: '>=',
          detail: 'PSR vs expected max',
          displayName: 'Deflated Sharpe',
        },
        {
          gate: 'cpcv',
          outcome: 'Pass',
          value: 0.41,
          threshold: 0.2,
          unit: 'per-trade Sharpe',
          comparator: '>=',
          detail: '',
          displayName: 'Time-dispersion stress',
        },
        {
          gate: 'plateau',
          outcome: 'NotMeasurable',
          value: null,
          threshold: 0.5,
          unit: 'score',
          comparator: '>=',
          detail: 'no optimization run',
          displayName: 'Parameter plateau',
        },
      ],
    });
    const chips = [...el.querySelectorAll('app-gate-rows-table .chip')].map((c) =>
      c.textContent!.trim(),
    );
    expect(chips).toEqual(['Fail', 'Pass', 'Not measurable']);
    expect(el.textContent).toContain('Time-dispersion stress');
    expect(el.textContent).toContain('0.81 probability (needs ≥ 0.95)');
    // Failure list comes from the Fail row, not a split of the free-text summary.
    const fails = [...el.querySelectorAll('.failure-list li')].map((l) => l.textContent!.trim());
    expect(fails).toEqual([
      'Deflated Sharpe: 0.81 probability (needs ≥ 0.95) — PSR vs expected max',
    ]);
    // The regex-parsed table is not drawn when rows exist.
    expect(el.querySelector('table.diagnostics')).toBeNull();
  });

  it('says how many gates could not be measured on a pass', () => {
    render({
      passed: true,
      failureSummary: '',
      diagnostics: [],
      rows: [
        {
          gate: 'dsr',
          outcome: 'Pass',
          value: 0.97,
          threshold: 0.95,
          unit: 'probability',
          comparator: '>=',
          detail: '',
        },
        {
          gate: 'tca',
          outcome: 'NotMeasurable',
          value: null,
          threshold: 0,
          unit: null,
          comparator: '>',
          detail: 'no fills',
        },
      ],
    });
    expect(el.querySelector('[data-testid="unmeasured-note"]')?.textContent).toContain(
      '1 gate could not be',
    );
  });

  it('falls back to the text diagnostics without rows, and shows Pass on an all-pass answer', () => {
    render({
      passed: true,
      failureSummary: '',
      diagnostics: ['EdgePosterior: μ=0.170 σ=0.129 P(edge>0)=0.907'],
    });
    expect(el.querySelector('app-gate-rows-table .chip')).toBeNull();
    const pills = [...el.querySelectorAll('table.diagnostics .pill')].map((p) =>
      p.textContent!.trim(),
    );
    expect(pills).toEqual(['Pass']);
  });
});

describe('parseDiagnostic (text fallback)', () => {
  it('classifies a failure before a skip keyword', () => {
    expect(parseDiagnostic('PBO failed: 0.62 > max 0.5 (skip remaining)').tone).toBe('fail');
    expect(parseDiagnostic('DSR auto-skipped: CPCV on').tone).toBe('skip');
    expect(parseDiagnostic('Paper gate bypassed by operator').tone).toBe('bypass');
  });
});
