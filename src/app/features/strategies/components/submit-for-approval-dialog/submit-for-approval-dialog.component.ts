import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';

import type { ResponseData, StrategyApprovalJobDto, StrategyDto } from '@core/api/api.types';
import { StrategiesService } from '@core/services/strategies.service';
import { NotificationService } from '@core/notifications/notification.service';
import { failureMessage } from '../../util/api-failure';
import { readApprovalJob, type ApprovalOutcome } from '../../util/approval';

type Phase = 'confirm' | 'running' | 'result' | 'failed';

/** How often a running approval job is polled. */
export const APPROVAL_POLL_MS = 3000;
/** Consecutive failed polls (backing off) before the dialog gives up on the job. */
export const APPROVAL_MAX_POLL_FAILURES = 5;

/**
 * "Submit for approval" (ADR-0027 DEC-10): the operator's path from Draft to Approved for a
 * hand-authored strategy. Runs every promotion gate on the engine (the paper gate is bypassed — a
 * Draft has no paper history) and shows the verdict gate by gate. Approved + Paused paper-trades;
 * going live is still Activate.
 *
 * The evaluation can take minutes (CPCV) — longer than a request may last — so the engine runs it as
 * a job: submitting starts it (or returns the one already running for the strategy) and the dialog
 * polls it until it is `done` or `failed`. Closing the dialog does not stop it: the component stays
 * alive while hidden — the host keeps it in its template and opens it by setting `strategy` — keeps
 * polling, and still reports the verdict (`changed`, a toast) when it lands. "No verdict came back"
 * is only for real failures: the engine unreachable when submitting, or the job unreadable after
 * several tries.
 */
@Component({
  selector: 'app-submit-for-approval-dialog',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (strategy(); as s) {
      <div
        class="overlay"
        role="presentation"
        tabindex="-1"
        (click)="close()"
        (keydown.escape)="close()"
      >
        <div
          class="dialog"
          role="dialog"
          aria-modal="true"
          tabindex="-1"
          aria-labelledby="sfa-title"
          (click)="$event.stopPropagation()"
          (keydown)="$event.stopPropagation()"
        >
          <header class="dialog-header">
            <h3 class="dialog-title" id="sfa-title">Submit for approval</h3>
            <p class="dialog-sub">{{ s.name || 'Strategy #' + s.id }}</p>
          </header>

          <div class="dialog-body">
            @switch (phase()) {
              @case ('confirm') {
                <p>
                  Runs every promotion gate against this Draft — the same qualification the engine
                  runs before promoting a generated strategy. The paper-trade gate is skipped: a
                  Draft has no paper history yet.
                </p>
                <ul class="facts">
                  <li>
                    On a pass the strategy moves <strong>Draft → Approved</strong> and starts
                    <strong>paper trading</strong> (Approved + Paused).
                  </li>
                  <li>
                    Going live is still <strong>Activate</strong>, once its paper trading satisfies
                    the graduation gate.
                  </li>
                  <li>
                    The gates include CPCV and can take several minutes. Closing this window does
                    not stop the evaluation; its verdict is recorded either way.
                  </li>
                </ul>
              }
              @case ('running') {
                <div class="running" role="status" aria-live="polite">
                  <span class="spinner" aria-hidden="true"></span>
                  <div>
                    <strong>Evaluating the promotion gates…</strong>
                    <p>
                      This can take several minutes. You can close this window — the verdict still
                      lands, and the page updates when it does.
                    </p>
                  </div>
                </div>
              }
              @case ('result') {
                @if (outcome(); as o) {
                  <div class="verdict" [attr.data-verdict]="o.verdict" role="status">
                    <strong>{{ verdictTitle() }}</strong>
                    <span>{{ verdictDetail() }}</span>
                  </div>
                  @if (o.message) {
                    <p class="engine-message">{{ o.message }}</p>
                  }
                  @if (o.gates.length > 0) {
                    <table class="gates" aria-label="Promotion gates">
                      <thead>
                        <tr>
                          <th scope="col">Gate</th>
                          <th scope="col">Result</th>
                          <th scope="col">Detail</th>
                        </tr>
                      </thead>
                      <tbody>
                        @for (g of o.gates; track $index) {
                          <tr [class.failed]="!g.passed">
                            <td class="gate-name">{{ g.name }}</td>
                            <td>
                              <span class="pill" [class.pass]="g.passed" [class.fail]="!g.passed">
                                {{ g.passed ? 'Pass' : 'Fail' }}
                              </span>
                            </td>
                            <td class="gate-detail">{{ g.detail || '—' }}</td>
                          </tr>
                        }
                      </tbody>
                    </table>
                  }
                }
              }
              @case ('failed') {
                <div class="verdict" data-verdict="not-judged" role="alert">
                  <strong>No verdict came back</strong>
                  <span>{{ failure() }}</span>
                </div>
                <p>
                  The engine could not be reached. If the evaluation started it keeps running and
                  records its verdict — the Promotion tab's gate history shows it.
                </p>
              }
            }
          </div>

          <footer class="dialog-actions">
            @switch (phase()) {
              @case ('confirm') {
                <button type="button" class="btn btn-secondary" (click)="close()">Cancel</button>
                <button type="button" class="btn btn-primary" (click)="submit()">
                  Run the gates
                </button>
              }
              @case ('running') {
                <button type="button" class="btn btn-secondary" (click)="close()">Close</button>
              }
              @case ('failed') {
                <button type="button" class="btn btn-secondary" (click)="openHistory()">
                  Open gate history
                </button>
                <button type="button" class="btn btn-primary" (click)="close()">Close</button>
              }
              @default {
                @if (outcome()?.verdict !== 'approved') {
                  <button type="button" class="btn btn-secondary" (click)="openHistory()">
                    Open gate history
                  </button>
                }
                <button type="button" class="btn btn-primary" (click)="close()">Close</button>
              }
            }
          </footer>
        </div>
      </div>
    }
  `,
  styles: [
    `
      .overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.4);
        backdrop-filter: blur(8px);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1000;
        padding: 16px;
      }
      .dialog {
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-lg);
        box-shadow: var(--shadow-lg);
        width: 100%;
        max-width: 640px;
        max-height: 90vh;
        display: flex;
        flex-direction: column;
      }
      .dialog-header {
        padding: var(--space-5) var(--space-6) 0;
      }
      .dialog-title {
        margin: 0;
        font-size: var(--text-lg);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
      }
      .dialog-sub {
        margin: 2px 0 0;
        font-size: var(--text-sm);
        color: var(--text-secondary);
      }
      .dialog-body {
        padding: var(--space-3) var(--space-6);
        overflow-y: auto;
        font-size: var(--text-sm);
        color: var(--text-secondary);
        line-height: 1.5;
      }
      .dialog-body p {
        margin: 0 0 var(--space-3);
      }
      .facts {
        margin: 0;
        padding-left: var(--space-5);
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
      }
      .facts strong,
      .running strong,
      .verdict strong {
        color: var(--text-primary);
      }
      .running {
        display: flex;
        gap: var(--space-3);
        align-items: flex-start;
      }
      .running p {
        margin: 4px 0 0;
      }
      .spinner {
        flex: none;
        width: 16px;
        height: 16px;
        margin-top: 2px;
        border: 2px solid var(--accent);
        border-right-color: transparent;
        border-radius: 50%;
        animation: sfa-spin 0.8s linear infinite;
      }
      @keyframes sfa-spin {
        to {
          transform: rotate(360deg);
        }
      }
      .verdict {
        display: flex;
        flex-direction: column;
        gap: 2px;
        padding: var(--space-3) var(--space-4);
        margin-bottom: var(--space-3);
        border-radius: var(--radius-md);
        border: 1px solid var(--border);
      }
      .verdict[data-verdict='approved'] {
        background: rgba(52, 199, 89, 0.1);
        border-color: rgba(52, 199, 89, 0.4);
      }
      .verdict[data-verdict='rejected'] {
        background: rgba(255, 59, 48, 0.08);
        border-color: rgba(255, 59, 48, 0.35);
      }
      .verdict[data-verdict='not-judged'],
      .verdict[data-verdict='refused'] {
        background: rgba(255, 149, 0, 0.1);
        border-color: rgba(255, 149, 0, 0.4);
      }
      .engine-message {
        font-size: var(--text-xs);
      }
      .gates {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-xs);
      }
      .gates th {
        text-align: left;
        font-weight: var(--font-semibold);
        color: var(--text-secondary);
        padding: 6px 8px;
        border-bottom: 1px solid var(--border);
      }
      .gates td {
        padding: 6px 8px;
        border-bottom: 1px solid var(--border);
        vertical-align: top;
        color: var(--text-primary);
      }
      .gates tr.failed td {
        background: rgba(255, 59, 48, 0.05);
      }
      .gate-name {
        white-space: nowrap;
        font-weight: var(--font-medium);
      }
      .gate-detail {
        word-break: break-word;
        color: var(--text-secondary);
      }
      .pill {
        display: inline-block;
        padding: 1px 8px;
        border-radius: var(--radius-full);
        font-weight: var(--font-semibold);
      }
      .pill.pass {
        background: rgba(52, 199, 89, 0.14);
        color: #248a3d;
      }
      .pill.fail {
        background: rgba(255, 59, 48, 0.14);
        color: #d70015;
      }
      .dialog-actions {
        display: flex;
        justify-content: flex-end;
        gap: var(--space-3);
        padding: var(--space-4) var(--space-6) var(--space-5);
      }
      .btn {
        height: 36px;
        padding: 0 var(--space-5);
        border: none;
        border-radius: var(--radius-full);
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        font-family: inherit;
        cursor: pointer;
      }
      .btn-secondary {
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }
      .btn-primary {
        background: var(--accent);
        color: #fff;
      }
    `,
  ],
})
export class SubmitForApprovalDialogComponent {
  private readonly strategies = inject(StrategiesService);
  private readonly notifications = inject(NotificationService);

  /** The Draft to submit; null keeps the dialog closed (an evaluation in flight carries on). */
  readonly strategy = input<StrategyDto | null>(null);

  /** The operator closed the dialog. */
  readonly closed = output<void>();
  /** A verdict landed for this strategy id — its lifecycle stage may have changed: re-read it. */
  readonly changed = output<number>();
  /** Show the Promotion tab (its gate history records every evaluation). */
  readonly historyRequested = output<void>();

  readonly phase = signal<Phase>('confirm');
  readonly outcome = signal<ApprovalOutcome | null>(null);
  readonly failure = signal<string | null>(null);
  /** The strategy whose evaluation is in flight or shown. */
  private subjectId: number | null = null;
  /** The next poll of each strategy's running job (an evaluation keeps reporting after the page moves on). */
  private readonly polls = new Map<number, ReturnType<typeof setTimeout>>();

  constructor() {
    // Opened for another strategy (the page moved on): start from the confirmation. An
    // evaluation still in flight for the previous one only reports back (`changed`, a toast).
    effect(() => {
      const s = this.strategy();
      untracked(() => {
        if (s && this.subjectId !== null && this.subjectId !== s.id) this.reset();
      });
    });
    // Leaving the page stops polling; the verdict is still recorded in the gate history.
    inject(DestroyRef).onDestroy(() => {
      for (const timer of this.polls.values()) clearTimeout(timer);
      this.polls.clear();
    });
  }

  readonly verdictTitle = computed(() => {
    switch (this.outcome()?.verdict) {
      case 'approved':
        return 'Approved';
      case 'rejected':
        return 'Not approved';
      case 'refused':
        return 'Not submitted';
      default:
        return 'Not judged';
    }
  });

  readonly verdictDetail = computed(() => {
    const o = this.outcome();
    if (!o) return '';
    if (o.verdict === 'approved') {
      return 'Every gate passed. The strategy now paper-trades (Approved + Paused); activate it once it has paper evidence.';
    }
    if (o.verdict === 'rejected') {
      const failed = o.gates.filter((g) => !g.passed).length;
      return `${failed} of ${o.gates.length} gate${o.gates.length === 1 ? '' : 's'} failed. The strategy stays ${o.stage ?? 'a Draft'}.`;
    }
    if (o.verdict === 'refused') {
      return `The engine did not run the gates${o.stage ? ` — the strategy is ${o.stage}` : ''}.`;
    }
    return `The evaluation did not reach a verdict. The strategy stays ${o.stage ?? 'a Draft'}.`;
  });

  submit(): void {
    const s = this.strategy();
    if (!s || this.phase() === 'running') return;
    this.subjectId = s.id;
    this.phase.set('running');
    this.outcome.set(null);
    this.failure.set(null);
    const id = s.id;
    this.strategies.submitForApproval(id, { silent: true }).subscribe({
      next: (res) => this.onJob(id, res, 0),
      error: (err: unknown) => {
        // A refusal can arrive as an HTTP error that still carries the envelope.
        const body = (err as { error?: unknown } | null)?.error as
          | ResponseData<StrategyApprovalJobDto>
          | undefined;
        if (body?.data && typeof body.data === 'object') {
          this.onJob(id, body, 0);
          return;
        }
        this.fail(id, failureMessage(err, 'The request failed.'));
      },
    });
  }

  /** A submit or poll answer: keep polling a running job, settle a finished (or refused) one. */
  private onJob(
    id: number,
    res: ResponseData<StrategyApprovalJobDto> | null | undefined,
    failures: number,
  ): void {
    const job = res?.data;
    if (!job || typeof job !== 'object') {
      this.fail(id, failureMessage(res, 'The engine returned no job.'));
      return;
    }
    if (job.status === 'running') {
      if (job.jobId) this.schedulePoll(id, job.jobId, failures);
      else this.fail(id, 'The engine returned a job without an id.');
      return;
    }
    // Finished — or refused before a job started, when the envelope's message says why.
    this.settle(id, readApprovalJob({ ...job, message: job.message ?? res?.message ?? null }));
  }

  private schedulePoll(id: number, jobId: string, failures: number): void {
    const pending = this.polls.get(id);
    if (pending !== undefined) clearTimeout(pending);
    const delay = Math.min(APPROVAL_POLL_MS * 2 ** failures, 30_000);
    this.polls.set(
      id,
      setTimeout(() => {
        this.polls.delete(id);
        this.strategies.getApprovalJob(id, jobId, { silent: true }).subscribe({
          next: (res) => {
            if (res?.data && typeof res.data === 'object') this.onJob(id, res, 0);
            else
              this.retry(id, jobId, failures, failureMessage(res, 'The engine returned no job.'));
          },
          error: (err: unknown) =>
            this.retry(id, jobId, failures, failureMessage(err, 'The request failed.')),
        });
      }, delay),
    );
  }

  /** A poll that failed: try again, backing off, and give up only after several in a row. */
  private retry(id: number, jobId: string, failures: number, why: string): void {
    if (failures + 1 >= APPROVAL_MAX_POLL_FAILURES) {
      this.fail(id, why);
      return;
    }
    this.schedulePoll(id, jobId, failures + 1);
  }

  close(): void {
    // Only a finished dialog resets; an evaluation in flight is shown again on reopening.
    if (this.phase() !== 'running') this.reset();
    this.closed.emit();
  }

  openHistory(): void {
    this.reset();
    this.historyRequested.emit();
  }

  /** No verdict came back: a real failure (the engine unreachable, the job unreadable). */
  private fail(id: number, why: string): void {
    if (this.subjectId !== id) {
      if (!this.strategy() || this.strategy()?.id !== id) {
        this.notifications.warning(
          `Strategy #${id}: no approval verdict came back — see its gate history.`,
        );
      }
      return;
    }
    this.phase.set('failed');
    this.failure.set(why);
  }

  private settle(id: number, outcome: ApprovalOutcome | null): void {
    if (!outcome) {
      this.fail(id, 'The engine returned no verdict.');
      return;
    }
    this.changed.emit(id);
    if (!this.strategy() || this.strategy()?.id !== id) {
      // Closed (or moved on) while the gates ran: say how it went.
      if (outcome.verdict === 'approved') {
        this.notifications.success(`Strategy #${id} approved — it now paper-trades.`);
      } else if (outcome.verdict === 'rejected') {
        this.notifications.error(`Strategy #${id} was not approved — see its gate history.`);
      } else {
        this.notifications.warning(
          `Strategy #${id}: no approval verdict — ${outcome.message ?? 'see its gate history'}.`,
        );
      }
    }
    if (this.subjectId !== id) return;
    this.outcome.set(outcome);
    this.phase.set('result');
  }

  private reset(): void {
    this.phase.set('confirm');
    this.outcome.set(null);
    this.failure.set(null);
    this.subjectId = null;
  }
}
