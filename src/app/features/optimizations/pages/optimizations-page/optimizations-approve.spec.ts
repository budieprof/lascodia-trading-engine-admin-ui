import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import { NotificationService } from '@core/notifications/notification.service';
import { StrategiesService } from '@core/services/strategies.service';
import { StrategyFeedbackService } from '@core/services/strategy-feedback.service';
import { ensureTestBed } from '@core/testing/zoneless-test-bed';
import type { OptimizationRunDto } from '@core/api/api.types';

import { OptimizationsPageComponent, approvalOutcome } from './optimizations-page.component';

ensureTestBed();

const RUN = {
  id: 7,
  strategyId: 3,
  status: 'Completed',
  bestSharpeRatio: 1.2,
} as unknown as OptimizationRunDto;
const APPROVED = {
  ...RUN,
  status: 'Approved',
  approvedAt: '2026-11-16T10:00:00Z',
} as OptimizationRunDto;

function setup(approveMessage: string, approveData: string | null = 'Optimization run approved') {
  const feedback = {
    approveOptimization: vi.fn(() =>
      of({ status: true, data: approveData, message: approveMessage, responseCode: '00' }),
    ),
    rejectOptimization: vi.fn(() =>
      of({ status: true, data: 'Rejected', message: 'Successful', responseCode: '00' }),
    ),
    getOptimizationRun: vi.fn(() =>
      of({ status: true, data: APPROVED, message: 'Successful', responseCode: '00' }),
    ),
  };
  const notifications = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: StrategyFeedbackService, useValue: feedback },
      {
        provide: StrategiesService,
        useValue: { list: () => of({ status: true, data: { data: [] } }) },
      },
      { provide: NotificationService, useValue: notifications },
    ],
  });
  const page = TestBed.runInInjectionContext(() => new OptimizationsPageComponent());
  return { page, feedback, notifications };
}

describe('optimisation approve / reject (the engine answers a sentence, not the run)', () => {
  it('never puts the string answer into the detail panel — it re-reads the run', () => {
    const { page, feedback } = setup('Gradual rollout started at 25%.');
    page.selected.set(RUN);
    page.approve();
    expect(feedback.approveOptimization).toHaveBeenCalledWith(7);
    expect(feedback.getOptimizationRun).toHaveBeenCalledWith(7);
    expect(page.selected()).toEqual(APPROVED);
    expect(typeof page.selected()).toBe('object');
  });

  it('says what the engine did: rollout started vs deferred', () => {
    const started = setup('Gradual rollout started at 25%.');
    started.page.selected.set(RUN);
    started.page.approve();
    expect(started.notifications.success).toHaveBeenCalledWith(
      'Run #7: Gradual rollout started at 25%.',
    );

    const deferred = setup('Deferred: strategy 3 is mid-rollout (50%).');
    deferred.page.selected.set(RUN);
    deferred.page.approve();
    expect(deferred.notifications.success).toHaveBeenCalledWith(
      'Run #7: Deferred: strategy 3 is mid-rollout (50%).',
    );
  });

  it('reject re-reads the run too', () => {
    const { page, feedback } = setup('x');
    page.selected.set(RUN);
    page.reject();
    expect(feedback.getOptimizationRun).toHaveBeenCalledWith(7);
    expect(page.selected()).toEqual(APPROVED);
  });

  it('does not replace the panel when the operator has moved to another run', () => {
    const { page } = setup('x');
    page.selected.set({ ...RUN, id: 9 } as OptimizationRunDto);
    page.refreshSelected(7);
    expect(page.selected()?.id).toBe(9);
  });
});

describe('approvalOutcome', () => {
  it('prefers the message, falls back to data when the message is the generic "Successful"', () => {
    expect(approvalOutcome({ message: 'Rollout deferred', data: 'x' })).toBe('Rollout deferred');
    expect(approvalOutcome({ message: 'Successful', data: 'Rollout started' })).toBe(
      'Rollout started',
    );
    expect(approvalOutcome({ message: null, data: null })).toBe('approved');
  });
});
