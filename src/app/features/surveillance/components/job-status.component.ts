import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';

import { errorText } from '@features/iam/iam.logic';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';

import { SurveillanceApiService } from '../surveillance-api.service';
import { jobHealth, relative } from '../surveillance.logic';
import type { JobStatus } from '../surveillance.types';

/**
 * A background job's last run, result and next run, with a confirmed "run now" for people allowed to
 * ask (platform.engine.manage). The job picks the request up within about 30 seconds.
 */
@Component({
  selector: 'app-surveillance-job-status',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ConfirmDialogComponent],
  styles: [
    `
      :host {
        display: flex;
        gap: 14px;
        align-items: center;
        flex-wrap: wrap;
        font-size: 0.85rem;
      }
      .dot {
        display: inline-block;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        margin-right: 6px;
        background: #9ca3af;
      }
      .dot.ok {
        background: #16a34a;
      }
      .dot.failing {
        background: #dc2626;
      }
      .dot.late,
      .dot.skipped {
        background: #d97706;
      }
      .muted {
        color: var(--text-muted, #666);
      }
      .msg {
        max-width: 520px;
      }
      .err {
        color: #8a1c14;
      }
    `,
  ],
  template: `
    <strong><span class="dot" [class]="'dot ' + health()"></span>{{ title() }}</strong>
    @if (status(); as s) {
      <span
        >last run {{ when(s.lastFinishedAtUtc) }} · {{ s.lastOutcome ?? 'never'
        }}{{
          s.lastDurationMs !== null ? ' in ' + (s.lastDurationMs / 1000).toFixed(1) + ' s' : ''
        }}</span
      >
      <span class="muted">next {{ when(s.nextRunAtUtc) }}</span>
      @if (s.consecutiveFailures > 1) {
        <span class="err">{{ s.consecutiveFailures }} failures in a row</span>
      }
      @if (s.lastMessage) {
        <span class="muted msg">{{ s.lastMessage }}</span>
      }
      @if (s.runRequestedAtUtc) {
        <span class="muted"
          >run requested {{ when(s.runRequestedAtUtc)
          }}{{ s.runRequestedBy ? ' by ' + s.runRequestedBy : '' }}</span
        >
      }
    } @else {
      <span class="muted">No run recorded yet.</span>
    }
    @if (canRun()) {
      <button
        type="button"
        class="btn btn-sm btn-secondary"
        [disabled]="busy() || !!status()?.runRequestedAtUtc"
        (click)="confirming.set(true)"
      >
        {{ runLabel() }}
      </button>
    }
    @if (error()) {
      <span class="err" role="alert">{{ error() }}</span>
    }
    <app-confirm-dialog
      [open]="confirming()"
      [title]="runLabel() + '?'"
      [message]="confirmText()"
      [confirmLabel]="runLabel()"
      [loading]="busy()"
      (confirm)="run()"
      (cancelled)="confirming.set(false)"
    />
  `,
})
export class JobStatusComponent {
  private readonly api = inject(SurveillanceApiService);

  readonly title = input.required<string>();
  readonly status = input<JobStatus | null>(null);
  readonly canRun = input(false);
  readonly runLabel = input('Run now');
  readonly job = input.required<'scan' | 'anchors'>();
  readonly requested = output<void>();

  readonly busy = signal(false);
  readonly confirming = signal(false);
  readonly error = signal<string | null>(null);
  readonly health = computed(() => jobHealth(this.status(), new Date()));
  readonly confirmText = computed(() =>
    this.job() === 'scan'
      ? "Scan every organisation's orders and fills now instead of at the next scheduled time? It only reads trades and raises alerts."
      : "Publish the audit chain's head to the anchor targets now? It appends one more anchor; the schedule restarts from it.",
  );

  when(iso: string | null): string {
    return relative(iso, new Date());
  }

  run(): void {
    this.busy.set(true);
    this.error.set(null);
    this.api.runNow(this.job()).subscribe({
      next: () => {
        this.busy.set(false);
        this.confirming.set(false);
        this.requested.emit();
      },
      error: (e) => {
        this.busy.set(false);
        this.confirming.set(false);
        this.error.set(errorText(e, 'The request was refused.'));
      },
    });
  }
}
