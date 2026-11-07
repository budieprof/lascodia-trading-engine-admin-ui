import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { AuthService } from '@core/auth/auth.service';
import { Permission } from '@core/auth/permissions.generated';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { GateRowsTableComponent } from '@features/strategies/components/gate-rows-table/gate-rows-table.component';
import { describeFailure } from '@features/scripting/shared/api-error';

import { COCKPIT_CARD_STYLES } from './cockpit.styles';
import { ResearchCockpitApiService } from './research-cockpit-api.service';
import { isPipelineActive, pipelineSteps, shortHash } from './research-cockpit.model';
import type { ValidationPipelineDto } from './research-cockpit.types';

/** How often a running pipeline is re-read. */
export const PIPELINE_POLL_MS = 10_000;

/**
 * U12 / S13 — the one-click validation pipeline: evidence backtest → walk-forward (re-optimised per fold, history
 * before the lineage holdout) → promotion-gate dry run → optionally paper trading. Start and cancel are operator
 * actions behind a confirm dialog; the gate rows of the dry run reuse the promotion card's table.
 */
@Component({
  selector: 'app-validation-pipeline-card',
  standalone: true,
  imports: [RouterLink, ConfirmDialogComponent, GateRowsTableComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card" aria-labelledby="vp-title" data-testid="validation-pipeline">
      <header class="head">
        <h3 id="vp-title" class="title">Validation pipeline</h3>
        @if (pipeline(); as p) {
          <span class="chip" [attr.data-tone]="statusTone()">{{ p.status }}</span>
          <span class="muted small">#{{ p.id }}</span>
          @if (hash()) {
            <span class="chip mono" title="Configuration this pipeline validated (C1)"
              >cfg {{ hash() }}</span
            >
          }
        }
        <span class="spacer"></span>
        @if (canOperate()) {
          @if (active()) {
            <button
              type="button"
              class="btn btn-secondary btn-sm"
              [disabled]="busy() || pipeline()?.cancelRequested"
              (click)="confirm.set('cancel')"
            >
              {{ pipeline()?.cancelRequested ? 'Cancelling…' : 'Cancel' }}
            </button>
          } @else {
            <button
              type="button"
              class="btn btn-primary btn-sm"
              [disabled]="busy()"
              data-testid="vp-start"
              (click)="confirm.set('start')"
            >
              Validate now
            </button>
          }
        }
      </header>
      <p class="muted small">
        Evidence backtest → walk-forward (anchored, re-optimised per fold, history before the
        lineage holdout) → promotion gates as a dry run → optionally paper trading. Each step only
        queues or reads; the research workers do the work.
      </p>
      @if (error(); as e) {
        <p class="error-box" role="alert">{{ e }}</p>
      }
      @if (notice(); as n) {
        <p class="note" role="status">{{ n }}</p>
      }
      @if (pipeline(); as p) {
        <ol class="stepper" aria-label="Pipeline steps">
          @for (s of steps(); track s.name) {
            <li [attr.data-tone]="s.tone">
              <span class="dot" aria-hidden="true"></span>
              <div class="step-body">
                <span class="step-label">{{ s.label }}</span>
                <span class="chip" [attr.data-tone]="s.tone">{{ s.statusText }}</span>
                @if (s.link) {
                  <a class="small" [routerLink]="s.link">run #{{ s.runId }}</a>
                }
                @if (s.outcome) {
                  <span class="muted small outcome">{{ s.outcome }}</span>
                }
              </div>
            </li>
          }
        </ol>
        @if (p.errorMessage) {
          <p class="error-box">{{ p.errorMessage }}</p>
        }
        @if (gateRows().length > 0) {
          <app-gate-rows-table
            [rows]="gateRows()"
            [showCounts]="true"
            ariaLabel="Dry-run gate results"
          />
        } @else if (p.gateResult?.failureSummary) {
          <p class="small">{{ p.gateResult?.failureSummary }}</p>
        }
      } @else if (!loading() && !error()) {
        <p class="muted">No validation pipeline has run for this strategy.</p>
      }

      @if (canOperate() && !active()) {
        <label class="opt">
          <input
            type="checkbox"
            [checked]="startPaper()"
            (change)="startPaper.set($any($event.target).checked)"
          />
          <span class="small"
            >Start paper trading at the end (only if every gate passes; nothing is sent to an
            account)</span
          >
        </label>
      }
    </section>

    <app-confirm-dialog
      [open]="confirm() === 'start'"
      title="Start the validation pipeline?"
      [message]="startMessage()"
      confirmLabel="Start"
      [loading]="busy()"
      (confirm)="start()"
      (cancelled)="confirm.set(null)"
    />
    <app-confirm-dialog
      [open]="confirm() === 'cancel'"
      title="Cancel the validation pipeline?"
      message="It stops before its next step. Runs already queued finish on their own."
      confirmLabel="Cancel pipeline"
      confirmVariant="destructive"
      [loading]="busy()"
      (confirm)="cancel()"
      (cancelled)="confirm.set(null)"
    />
  `,
  styles: [
    COCKPIT_CARD_STYLES,
    `
      .stepper {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 10px;
      }
      .stepper li {
        display: flex;
        gap: 8px;
        padding: 8px;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
      }
      .dot {
        width: 10px;
        height: 10px;
        margin-top: 4px;
        border-radius: 50%;
        background: var(--border);
        flex: none;
      }
      li[data-tone='done'] .dot {
        background: var(--profit);
      }
      li[data-tone='running'] .dot {
        background: var(--warning, #ff9500);
      }
      li[data-tone='failed'] .dot,
      li[data-tone='cancelled'] .dot {
        background: var(--loss);
      }
      .step-body {
        display: flex;
        flex-direction: column;
        gap: 3px;
        min-width: 0;
      }
      .step-label {
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
      }
      .outcome {
        overflow-wrap: anywhere;
      }
      .opt {
        display: flex;
        gap: 6px;
        align-items: flex-start;
      }
    `,
  ],
})
export class ValidationPipelineCardComponent {
  private readonly api = inject(ResearchCockpitApiService);
  private readonly auth = inject(AuthService);
  private readonly destroyRef = inject(DestroyRef);

  readonly strategyId = input.required<number>();

  readonly pipeline = signal<ValidationPipelineDto | null>(null);
  readonly loading = signal(false);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly notice = signal<string | null>(null);
  readonly confirm = signal<'start' | 'cancel' | null>(null);
  readonly startPaper = signal(false);

  readonly canOperate = computed(() => this.auth.hasPermission(Permission.AccessOperator));
  readonly active = computed(() => isPipelineActive(this.pipeline()));
  readonly steps = computed(() => {
    const p = this.pipeline();
    return p ? pipelineSteps(p) : [];
  });
  readonly gateRows = computed(() => this.pipeline()?.gateResult?.rows ?? []);
  readonly hash = computed(() => shortHash(this.pipeline()?.strategyConfigHash));
  readonly statusTone = computed(() => {
    const s = this.pipeline()?.status;
    return s === 'Completed'
      ? this.pipeline()?.gatesPassed
        ? 'done'
        : 'warn'
      : s === 'Failed'
        ? 'failed'
        : s === 'Running' || s === 'Queued'
          ? 'running'
          : '';
  });
  readonly startMessage = computed(
    () =>
      'Queues an evidence backtest, then a walk-forward re-optimised per fold, then a dry run of every promotion gate' +
      (this.startPaper()
        ? ', then starts paper trading if every gate passes.'
        : '. Nothing changes the strategy’s stage.') +
      ' Research runs can take hours.',
  );

  private timer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    effect(() => {
      const id = this.strategyId();
      untracked(() => void this.load(id));
    });
    this.destroyRef.onDestroy(() => this.stopPolling());
  }

  async load(id = this.strategyId()): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const res = await firstValueFrom(this.api.latestPipeline(id));
      if (id !== this.strategyId()) return;
      // -14 "not found" = never ran: not an error.
      this.pipeline.set(res?.status && res.data ? res.data : null);
      if (res && !res.status && res.responseCode !== '-14')
        this.error.set(describeFailure(res, 'The pipeline could not be read.'));
    } catch (err) {
      if (id === this.strategyId())
        this.error.set(describeFailure(err, 'The pipeline could not be read.'));
    } finally {
      this.loading.set(false);
      this.syncPolling();
    }
  }

  async start(): Promise<void> {
    if (!this.canOperate()) return;
    this.busy.set(true);
    this.error.set(null);
    this.notice.set(null);
    try {
      const res = await firstValueFrom(
        this.api.startPipeline(this.strategyId(), { startPaper: this.startPaper() }),
      );
      if (res?.status) this.notice.set(`Pipeline #${res.data} queued.`);
      else if (res?.responseCode === '-409')
        this.notice.set(`A pipeline is already running (#${res.data}).`);
      else this.error.set(describeFailure(res, 'The pipeline could not be started.'));
      await this.load();
    } catch (err) {
      this.error.set(describeFailure(err, 'The pipeline could not be started.'));
    } finally {
      this.busy.set(false);
      this.confirm.set(null);
    }
  }

  async cancel(): Promise<void> {
    const p = this.pipeline();
    if (!p || !this.canOperate()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const res = await firstValueFrom(this.api.cancelPipeline(this.strategyId(), p.id));
      if (!res?.status)
        this.error.set(describeFailure(res, 'The pipeline could not be cancelled.'));
      await this.load();
    } catch (err) {
      this.error.set(describeFailure(err, 'The pipeline could not be cancelled.'));
    } finally {
      this.busy.set(false);
      this.confirm.set(null);
    }
  }

  private syncPolling(): void {
    if (this.active()) {
      if (!this.timer) this.timer = setInterval(() => void this.load(), PIPELINE_POLL_MS);
    } else this.stopPolling();
  }

  private stopPolling(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
