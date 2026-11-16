import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import { NotificationService } from '@core/notifications/notification.service';
import { AnalysisMonitorsService } from '@core/services/analysis-monitors.service';
import { ensureTestBed } from '@core/testing/zoneless-test-bed';

import { MonitorBuilderComponent } from './components/monitor-builder/monitor-builder.component';
import {
  INVALIDATION_ALREADY_TRUE_LEAD,
  isAcceptableWarning,
  warnedSubjects,
} from './monitor-arm-warnings';

ensureTestBed();

// The engine's words (CreateAnalysisMonitorCommandHandler): lint warnings end with this sentence.
const LINT =
  'The trigger parsed but looks wrong: threshold 1.5 is far from current 1.08. Re-submit with acceptWarnings=true to arm it anyway.';
const DEAD = `${INVALIDATION_ALREADY_TRUE_LEAD} — the watch would stand itself down on its first evaluation.`;

describe('which refusals the operator may accept', () => {
  it('accepts the lint warnings, never the invalidation-already-true refusal (same -19 code)', () => {
    expect(isAcceptableWarning(LINT)).toBe(true);
    expect(isAcceptableWarning(DEAD)).toBe(false);
    expect(isAcceptableWarning('This trigger could never fire as written — x')).toBe(false);
    expect(isAcceptableWarning(null)).toBe(false);
  });

  it('picks the warned subjects out of a template fan-out', () => {
    expect(
      warnedSubjects([`EURUSD: ${LINT}`, `GBPUSD: ${DEAD}`, 'USDJPY: Unknown symbol']),
    ).toEqual(['EURUSD']);
  });
});

describe('monitor builder arms in two steps', () => {
  function setup(
    answers: { status: boolean; message: string; responseCode: string; data?: unknown }[],
  ) {
    const queue = [...answers];
    const monitors = {
      create: vi.fn(() => of(queue.shift())),
      metrics: vi.fn(() => of({ status: true, data: [] })),
    };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: AnalysisMonitorsService, useValue: monitors },
        { provide: NotificationService, useValue: { success: vi.fn(), error: vi.fn() } },
      ],
    });
    const builder = TestBed.runInInjectionContext(() => new MonitorBuilderComponent());
    builder['intentText'].set('EURUSD breaks 1.10');
    builder['subjectRef'].set('EURUSD');
    return { builder, monitors };
  }

  it('sends acceptWarnings:false first, shows the warnings, resends true only on "Arm anyway"', () => {
    const { builder, monitors } = setup([
      { status: false, message: LINT, responseCode: '-19' },
      { status: true, message: 'Armed', responseCode: '00', data: { id: 5 } },
    ]);

    builder['save']();
    expect(monitors.create).toHaveBeenCalledTimes(1);
    expect(monitors.create.mock.calls[0][0]).toMatchObject({ acceptWarnings: false });
    expect(builder['armWarnings']()).toBe(LINT);
    expect(builder['saveError']()).toBeNull();

    builder['save'](true);
    expect(monitors.create).toHaveBeenCalledTimes(2);
    expect(monitors.create.mock.calls[1][0]).toMatchObject({ acceptWarnings: true });
  });

  it('does not accept warnings for a watch edited after they were shown', () => {
    const { builder, monitors } = setup([
      { status: false, message: LINT, responseCode: '-19' },
      { status: false, message: LINT, responseCode: '-19' },
    ]);
    builder['save']();
    builder['intentText'].set('EURUSD breaks 1.12');
    builder['save'](true);
    expect(monitors.create.mock.calls[1][0]).toMatchObject({ acceptWarnings: false });
  });

  it('shows the invalidation-already-true refusal as a refusal, with no "Arm anyway"', () => {
    const { builder } = setup([{ status: false, message: DEAD, responseCode: '-19' }]);
    builder['save']();
    expect(builder['armWarnings']()).toBeNull();
    expect(builder['saveError']()).toBe(DEAD);
  });
});
