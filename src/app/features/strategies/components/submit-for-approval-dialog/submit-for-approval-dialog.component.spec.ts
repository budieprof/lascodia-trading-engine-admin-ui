import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { of, throwError } from 'rxjs';

import type {
  ResponseData,
  StrategyApprovalJobDto,
  StrategyApprovalResultDto,
  StrategyDto,
} from '@core/api/api.types';
import { StrategiesService } from '@core/services/strategies.service';
import { NotificationService } from '@core/notifications/notification.service';
import { declareSignalIo } from '@shared/testing/jit-signal-io';
import {
  APPROVAL_MAX_POLL_FAILURES,
  APPROVAL_POLL_MS,
  SubmitForApprovalDialogComponent,
} from './submit-for-approval-dialog.component';

// "Submit for approval" (ADR-0027 DEC-10, engine D88): confirm → start the job → poll it → the
// verdict gate by gate; refusals; an evaluation that outlives the dialog; "no verdict" only for real
// failures.

declareSignalIo(SubmitForApprovalDialogComponent, {
  inputs: ['strategy'],
  outputs: ['closed', 'changed', 'historyRequested'],
});

const DRAFT = { id: 7, name: 'Pine EMA', lifecycleStage: 'Draft' } as StrategyDto;
const JOB_ID = '1790253600000';

function job(
  status: StrategyApprovalJobDto['status'],
  result: StrategyApprovalResultDto | null = null,
  message: string | null = null,
  responseCode: string | null = status === 'running' ? null : '00',
  jobId: string | null = JOB_ID,
): StrategyApprovalJobDto {
  return {
    jobId,
    strategyId: 7,
    status,
    startedAtUtc: '2026-09-24T12:00:00Z',
    finishedAtUtc: status === 'running' ? null : '2026-09-24T12:03:00Z',
    result,
    message,
    responseCode,
  };
}

const envelope = (
  data: StrategyApprovalJobDto | null,
  status = true,
  message = 'Successful',
  responseCode = '00',
): ResponseData<StrategyApprovalJobDto> =>
  ({ data, status, message, responseCode }) as ResponseData<StrategyApprovalJobDto>;

const RUNNING = envelope(job('running'), true, 'Evaluating every promotion gate for strategy 7.');

describe('SubmitForApprovalDialogComponent', () => {
  let fixture: ComponentFixture<SubmitForApprovalDialogComponent>;
  let el: HTMLElement;
  let submit: ReturnType<typeof vi.fn>;
  let poll: ReturnType<typeof vi.fn>;
  let notify: Record<string, ReturnType<typeof vi.fn>>;
  let changed: number[];
  let history: number;

  function open(strategy: StrategyDto | null = DRAFT): void {
    fixture.componentRef.setInput('strategy', strategy);
    fixture.detectChanges();
  }

  const button = (label: string) =>
    [...el.querySelectorAll<HTMLButtonElement>('.dialog-actions button')].find(
      (b) => b.textContent!.trim() === label,
    );

  function run(): void {
    button('Run the gates')!.click();
    fixture.detectChanges();
  }

  /** One poll interval passes (plus the backoff after `failures` failed polls in a row). */
  function tick(failures = 0): void {
    vi.advanceTimersByTime(Math.min(APPROVAL_POLL_MS * 2 ** failures, 30_000));
    fixture.detectChanges();
  }

  beforeEach(() => {
    vi.useFakeTimers();
    submit = vi.fn();
    poll = vi.fn();
    notify = { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() };
    TestBed.configureTestingModule({
      imports: [SubmitForApprovalDialogComponent],
      providers: [
        {
          provide: StrategiesService,
          useValue: { submitForApproval: submit, getApprovalJob: poll },
        },
        { provide: NotificationService, useValue: notify },
      ],
    });
    fixture = TestBed.createComponent(SubmitForApprovalDialogComponent);
    el = fixture.nativeElement as HTMLElement;
    changed = [];
    history = 0;
    fixture.componentInstance.changed.subscribe((id) => changed.push(id));
    fixture.componentInstance.historyRequested.subscribe(() => history++);
  });

  afterEach(() => {
    fixture.destroy();
    vi.useRealTimers();
  });

  it('renders nothing until a strategy is set, then explains what submitting does', () => {
    fixture.detectChanges();
    expect(el.querySelector('[role="dialog"]')).toBeNull();
    open();
    expect(el.querySelector('.dialog-sub')!.textContent).toContain('Pine EMA');
    expect(el.textContent).toContain('Draft → Approved');
    expect(el.textContent).toContain('paper trading');
    expect(el.querySelector('[data-testid="sfa-from-paper"]')).toBeNull();
    expect(submit).not.toHaveBeenCalled();
  });

  it('explains a submission from a script’s paper-only stage (PaperTrading → Approved)', () => {
    open({ ...DRAFT, lifecycleStage: 'PaperTrading' } as StrategyDto);
    expect(el.querySelector('[data-testid="sfa-from-paper"]')).not.toBeNull();
    expect(el.textContent).toContain('PaperTrading → Approved');
    expect(el.textContent).not.toContain('Draft → Approved');
    expect(el.textContent).toContain('keeps');
  });

  it('starts the job, polls it while it runs, then shows an approval; the host re-reads the strategy', () => {
    submit.mockReturnValue(of(RUNNING));
    poll.mockReturnValueOnce(of(envelope(job('running'))));
    poll.mockReturnValueOnce(
      of(
        envelope(
          job(
            'done',
            {
              approved: true,
              stage: 'Approved',
              gates: [{ name: 'DSR', passed: true, detail: 'DSR=0.97' }],
            },
            'Approved. Strategy 7 now paper-trades (Approved + Paused).',
          ),
        ),
      ),
    );
    open();
    run();
    expect(submit).toHaveBeenCalledWith(7, { silent: true });
    expect(el.querySelector('.running')).not.toBeNull();
    expect(poll).not.toHaveBeenCalled(); // nothing to ask before the first interval

    tick();
    expect(poll).toHaveBeenCalledWith(7, JOB_ID, { silent: true });
    expect(el.querySelector('.running')).not.toBeNull();
    expect(changed).toEqual([]);

    tick();
    expect(poll).toHaveBeenCalledTimes(2);
    expect(el.querySelector('.verdict')!.getAttribute('data-verdict')).toBe('approved');
    expect(el.querySelector('.verdict')!.textContent).toContain('Approved');
    expect(el.querySelectorAll('.gates tbody tr')).toHaveLength(1);
    expect(changed).toEqual([7]);
    expect(button('Open gate history')).toBeUndefined();

    tick();
    expect(poll).toHaveBeenCalledTimes(2); // a finished job is not polled again
  });

  it('shows a rejection gate by gate, failed gates marked, with the way to the gate history', () => {
    submit.mockReturnValue(of(RUNNING));
    poll.mockReturnValue(
      of(
        envelope(
          job('done', {
            approved: false,
            stage: 'Draft',
            gates: [
              { name: 'DSR', passed: true, detail: 'DSR=0.97' },
              { name: 'CPCV', passed: false, detail: 'median Sharpe 0.21 < 0.5' },
            ],
          }),
        ),
      ),
    );
    open();
    run();
    tick();
    expect(el.querySelector('.verdict')!.getAttribute('data-verdict')).toBe('rejected');
    expect(el.querySelector('.verdict')!.textContent).toContain('1 of 2 gates failed');
    const rows = [...el.querySelectorAll('.gates tbody tr')];
    expect(rows.map((r) => r.classList.contains('failed'))).toEqual([false, true]);
    expect(rows[1].textContent).toContain('median Sharpe 0.21 < 0.5');
    button('Open gate history')!.click();
    expect(history).toBe(1);
  });

  it('reads a timed-out evaluation as not judged, never as a rejection', () => {
    submit.mockReturnValue(of(RUNNING));
    poll.mockReturnValue(
      of(
        envelope(
          job(
            'failed',
            {
              approved: false,
              stage: 'Draft',
              gates: [{ name: 'evaluation', passed: false, detail: 'TimedOut' }],
            },
            'Not judged (TimedOut): budget exhausted',
            '-12',
          ),
        ),
      ),
    );
    open();
    run();
    tick();
    expect(el.querySelector('.verdict')!.getAttribute('data-verdict')).toBe('not-judged');
    expect(el.textContent).toContain('Not judged (TimedOut)');
  });

  it('reads a job interrupted by an engine restart as not judged, with the engine’s reason', () => {
    submit.mockReturnValue(of(RUNNING));
    poll.mockReturnValue(
      of(
        envelope(
          job(
            'failed',
            { approved: false, stage: 'Draft', gates: [] },
            'No verdict was recorded for job 1790253600000: the engine restarted before the evaluation finished.',
            '-12',
          ),
        ),
      ),
    );
    open();
    run();
    tick();
    expect(el.querySelector('.verdict')!.getAttribute('data-verdict')).toBe('not-judged');
    expect(el.textContent).toContain('the engine restarted');
    expect(el.querySelector('[role="alert"]')).toBeNull(); // the engine answered: not a lost request
  });

  it('shows a refusal from the submit at once, without polling', () => {
    submit.mockReturnValue(
      of(
        envelope(
          job('failed', { approved: true, stage: 'Approved', gates: [] }, null, '-11', null),
          false,
          'Only a Draft can be submitted for approval — strategy 7 is Approved.',
          '-11',
        ),
      ),
    );
    open();
    run();
    expect(el.querySelector('.verdict')!.getAttribute('data-verdict')).toBe('refused');
    expect(el.textContent).toContain('Only a Draft');
    tick();
    expect(poll).not.toHaveBeenCalled();
  });

  it('reads a refusal that arrives as an HTTP error with the envelope', () => {
    submit.mockReturnValue(
      throwError(
        () =>
          new HttpErrorResponse({
            status: 400,
            error: envelope(
              job('failed', { approved: false, stage: 'Draft', gates: [] }, null, '-11', null),
              false,
              'Strategy 7 is Active; only a Paused Draft can be approved',
              '-11',
            ),
          }),
      ),
    );
    open();
    run();
    expect(el.querySelector('.verdict')!.getAttribute('data-verdict')).toBe('refused');
    expect(el.textContent).toContain('only a Paused Draft');
  });

  it('says no verdict came back only when the submit itself fails', () => {
    submit.mockReturnValue(throwError(() => new HttpErrorResponse({ status: 524 })));
    open();
    run();
    expect(el.querySelector('[role="alert"]')!.textContent).toContain('No verdict came back');
    expect(button('Open gate history')).toBeDefined();
    expect(changed).toEqual([]);
  });

  it('rides out failed polls, backing off, and gives up only after several in a row', () => {
    submit.mockReturnValue(of(RUNNING));
    const down = () => throwError(() => new HttpErrorResponse({ status: 502 }));
    for (let i = 0; i < APPROVAL_MAX_POLL_FAILURES - 1; i++) poll.mockReturnValueOnce(down());
    poll.mockReturnValueOnce(
      of(envelope(job('done', { approved: true, stage: 'Approved', gates: [] }, 'Approved.'))),
    );
    open();
    run();
    for (let i = 0; i < APPROVAL_MAX_POLL_FAILURES - 1; i++) {
      tick(i);
      expect(el.querySelector('[role="alert"]')).toBeNull();
      expect(el.querySelector('.running')).not.toBeNull();
    }
    tick(APPROVAL_MAX_POLL_FAILURES - 1);
    expect(el.querySelector('.verdict')!.getAttribute('data-verdict')).toBe('approved');
  });

  it('shows the fallback once every poll in a row has failed', () => {
    submit.mockReturnValue(of(RUNNING));
    poll.mockImplementation(() => throwError(() => new HttpErrorResponse({ status: 502 })));
    open();
    run();
    for (let i = 0; i < APPROVAL_MAX_POLL_FAILURES; i++) tick(i);
    expect(poll).toHaveBeenCalledTimes(APPROVAL_MAX_POLL_FAILURES);
    expect(el.querySelector('[role="alert"]')!.textContent).toContain('No verdict came back');
    tick(APPROVAL_MAX_POLL_FAILURES);
    expect(poll).toHaveBeenCalledTimes(APPROVAL_MAX_POLL_FAILURES); // it stopped
  });

  it('keeps polling after the dialog closes and reports the verdict when it lands', () => {
    submit.mockReturnValue(of(RUNNING));
    poll.mockReturnValue(
      of(envelope(job('done', { approved: true, stage: 'Approved', gates: [] }, 'Approved.'))),
    );
    open();
    run();
    expect(el.querySelector('.running')).not.toBeNull();
    button('Close')!.click();
    open(null); // the host closes it
    expect(el.querySelector('[role="dialog"]')).toBeNull();

    tick();
    expect(changed).toEqual([7]);
    expect(notify['success']).toHaveBeenCalledWith(expect.stringContaining('approved'));
    // Reopened, it shows the verdict it got.
    open();
    expect(el.querySelector('.verdict')!.getAttribute('data-verdict')).toBe('approved');
  });

  it('stops polling when it is destroyed', () => {
    submit.mockReturnValue(of(RUNNING));
    poll.mockReturnValue(of(envelope(job('running'))));
    open();
    run();
    fixture.destroy();
    vi.advanceTimersByTime(APPROVAL_POLL_MS * 10);
    expect(poll).not.toHaveBeenCalled();
  });
});
