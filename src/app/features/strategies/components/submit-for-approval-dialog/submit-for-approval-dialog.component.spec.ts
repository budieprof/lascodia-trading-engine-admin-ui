import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { Subject, of, throwError } from 'rxjs';

import type { ResponseData, StrategyApprovalResultDto, StrategyDto } from '@core/api/api.types';
import { StrategiesService } from '@core/services/strategies.service';
import { NotificationService } from '@core/notifications/notification.service';
import { declareSignalIo } from '@shared/testing/jit-signal-io';
import { SubmitForApprovalDialogComponent } from './submit-for-approval-dialog.component';

// "Submit for approval" (ADR-0027 DEC-10): the confirm → run → verdict flow, the gate table, and
// an evaluation that outlives the dialog (closing it does not stop the engine).

declareSignalIo(SubmitForApprovalDialogComponent, {
  inputs: ['strategy'],
  outputs: ['closed', 'changed', 'historyRequested'],
});

const DRAFT = { id: 7, name: 'Pine EMA', lifecycleStage: 'Draft' } as StrategyDto;

const envelope = (
  data: StrategyApprovalResultDto | null,
  status = true,
  message = 'Successful',
  responseCode = '00',
): ResponseData<StrategyApprovalResultDto> =>
  ({ data, status, message, responseCode }) as ResponseData<StrategyApprovalResultDto>;

describe('SubmitForApprovalDialogComponent', () => {
  let fixture: ComponentFixture<SubmitForApprovalDialogComponent>;
  let el: HTMLElement;
  let submit: ReturnType<typeof vi.fn>;
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

  beforeEach(() => {
    submit = vi.fn();
    notify = { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() };
    TestBed.configureTestingModule({
      imports: [SubmitForApprovalDialogComponent],
      providers: [
        { provide: StrategiesService, useValue: { submitForApproval: submit } },
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

  afterEach(() => fixture.destroy());

  it('renders nothing until a strategy is set, then explains what submitting does', () => {
    fixture.detectChanges();
    expect(el.querySelector('[role="dialog"]')).toBeNull();
    open();
    expect(el.querySelector('.dialog-sub')!.textContent).toContain('Pine EMA');
    expect(el.textContent).toContain('Draft → Approved');
    expect(el.textContent).toContain('paper trading');
    expect(submit).not.toHaveBeenCalled();
  });

  it('runs the gates and shows an approval; the host re-reads the strategy', () => {
    submit.mockReturnValue(
      of(
        envelope(
          {
            approved: true,
            stage: 'Approved',
            gates: [{ name: 'DSR', passed: true, detail: 'DSR=0.97' }],
          },
          true,
          'Approved. Strategy 7 now paper-trades (Approved + Paused).',
        ),
      ),
    );
    open();
    run();
    expect(submit).toHaveBeenCalledWith(7, { silent: true });
    expect(el.querySelector('.verdict')!.getAttribute('data-verdict')).toBe('approved');
    expect(el.querySelector('.verdict')!.textContent).toContain('Approved');
    expect(el.querySelectorAll('.gates tbody tr')).toHaveLength(1);
    expect(changed).toEqual([7]);
    expect(button('Open gate history')).toBeUndefined();
  });

  it('shows a rejection gate by gate, failed gates marked, with the way to the gate history', () => {
    submit.mockReturnValue(
      of(
        envelope({
          approved: false,
          stage: 'Draft',
          gates: [
            { name: 'DSR', passed: true, detail: 'DSR=0.97' },
            { name: 'CPCV', passed: false, detail: 'median Sharpe 0.21 < 0.5' },
          ],
        }),
      ),
    );
    open();
    run();
    expect(el.querySelector('.verdict')!.getAttribute('data-verdict')).toBe('rejected');
    expect(el.querySelector('.verdict')!.textContent).toContain('1 of 2 gates failed');
    const rows = [...el.querySelectorAll('.gates tbody tr')];
    expect(rows.map((r) => r.classList.contains('failed'))).toEqual([false, true]);
    expect(rows[1].textContent).toContain('median Sharpe 0.21 < 0.5');
    button('Open gate history')!.click();
    expect(history).toBe(1);
  });

  it('reads a timed-out evaluation as not judged, never as a rejection', () => {
    submit.mockReturnValue(
      of(
        envelope(
          {
            approved: false,
            stage: 'Draft',
            gates: [{ name: 'evaluation', passed: false, detail: 'TimedOut' }],
          },
          false,
          'Not judged (TimedOut): budget exhausted',
          '-12',
        ),
      ),
    );
    open();
    run();
    expect(el.querySelector('.verdict')!.getAttribute('data-verdict')).toBe('not-judged');
    expect(el.textContent).toContain('Not judged (TimedOut)');
  });

  it('says so when no verdict came back, and points at the gate history', () => {
    submit.mockReturnValue(throwError(() => new HttpErrorResponse({ status: 524 })));
    open();
    run();
    expect(el.querySelector('[role="alert"]')!.textContent).toContain('No verdict came back');
    expect(button('Open gate history')).toBeDefined();
    expect(changed).toEqual([]);
  });

  it('reads a refusal that arrives as an HTTP error with the result envelope', () => {
    submit.mockReturnValue(
      throwError(
        () =>
          new HttpErrorResponse({
            status: 400,
            error: envelope(
              { approved: false, stage: 'Draft', gates: [] },
              false,
              'An approval evaluation for strategy 7 is already running',
              '-11',
            ),
          }),
      ),
    );
    open();
    run();
    expect(el.querySelector('.verdict')!.getAttribute('data-verdict')).toBe('refused');
    expect(el.textContent).toContain('already running');
  });

  it('keeps an evaluation going after the dialog closes and reports its verdict', () => {
    const response = new Subject<ResponseData<StrategyApprovalResultDto>>();
    submit.mockReturnValue(response);
    open();
    run();
    expect(el.querySelector('.running')).not.toBeNull();
    button('Close')!.click();
    open(null); // the host closes it
    expect(el.querySelector('[role="dialog"]')).toBeNull();

    response.next(envelope({ approved: true, stage: 'Approved', gates: [] }));
    expect(changed).toEqual([7]);
    expect(notify['success']).toHaveBeenCalledWith(expect.stringContaining('approved'));
    // Reopened, it shows the verdict it got.
    open();
    expect(el.querySelector('.verdict')!.getAttribute('data-verdict')).toBe('approved');
  });
});
