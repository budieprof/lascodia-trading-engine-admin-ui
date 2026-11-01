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
import { catchError, of, type Subscription } from 'rxjs';

import { EAAdminService } from '@core/services/ea-admin.service';
import type { PruneFilesResult } from '@core/api/ea-selfheal.types';

import { EaActionDialogComponent } from './ea-action-dialog.component';
import { EaOpsService } from './ea-ops.service';
import {
  PRUNE_COPY,
  formatBytes,
  jobStatusText,
  parsePruneResult,
  pruneConfirmLabel,
  pruneDryRunText,
  pruneFileLabel,
  pruneGroups,
  pruneOutcomeText,
} from './selfheal.logic';

type Phase = 'checking' | 'review' | 'empty' | 'deleting' | 'done' | 'error';

/**
 * "Clean up old files" (PruneFiles, C6) in two steps that cannot be skipped:
 * opening runs a DRY RUN on the host and shows exactly what it would delete
 * (grouped by why, with sizes); only the confirm button then asks the engine
 * for the real clean-up, naming the reviewed dry run (the engine refuses a real
 * run without one). The outcome — deleted, freed, failures — shows here and in
 * the page's results tray. Used by the health card's fix and the terminal card.
 */
@Component({
  selector: 'app-ea-prune-files-dialog',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [EaActionDialogComponent],
  template: `
    <app-ea-action-dialog
      [open]="open()"
      [title]="title"
      [description]="description()"
      [warning]="warning()"
      [confirmLabel]="confirmLabel()"
      [tone]="phase() === 'review' ? 'bad' : 'warn'"
      [askReason]="phase() === 'review'"
      [busy]="sending()"
      [confirmDisabled]="phase() === 'checking' || phase() === 'deleting'"
      [showCancel]="phase() !== 'done' && phase() !== 'empty'"
      (confirmed)="onConfirm($event)"
      (cancelled)="close()"
    >
      <div class="prune" aria-live="polite">
        @switch (phase()) {
          @case ('checking') {
            <p class="status"><span class="spin" aria-hidden="true"></span>{{ status() }}</p>
          }
          @case ('deleting') {
            <p class="status"><span class="spin" aria-hidden="true"></span>{{ status() }}</p>
          }
          @case ('error') {
            <p class="status tone-bad">{{ status() }}</p>
          }
          @case ('empty') {
            <p class="status tone-ok">{{ status() }}</p>
          }
          @case ('done') {
            <p class="status" [class.tone-ok]="!outcomeFailures().length" [class.tone-warn]="outcomeFailures().length > 0">
              {{ status() }}
            </p>
            @if (outcomeFailures().length > 0) {
              <ul class="failures">
                @for (f of outcomeFailures(); track $index) {
                  <li class="mono small">{{ f }}</li>
                }
              </ul>
            }
          }
          @case ('review') {
            <p class="status"><strong>{{ status() }}</strong></p>
          }
        }

        @if (phase() === 'review' || phase() === 'deleting') {
          <div class="groups">
            @for (g of groups(); track g.reason) {
              <details>
                <summary>
                  <span class="reason">{{ g.reason }}</span>
                  <span class="muted small">{{ g.count }} · {{ bytes(g.bytes) }}</span>
                </summary>
                <ul class="files">
                  @for (f of g.files; track f.path) {
                    <li [title]="f.path">
                      <span class="mono small name">{{ label(f.path).name }}</span>
                      <span class="muted small folder">{{ label(f.path).folder }}</span>
                      <span class="small size">{{ bytes(f.bytes) }}</span>
                    </li>
                  }
                </ul>
              </details>
            }
          </div>
          <p class="muted small">{{ safeText }}</p>
        }
      </div>
    </app-ea-action-dialog>
  `,
  styles: [
    `
      .prune {
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
      }
      .status {
        margin: 0;
        font-size: var(--text-sm);
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .tone-ok {
        color: var(--tone-green);
      }
      .tone-warn {
        color: var(--tone-amber);
      }
      .tone-bad {
        color: var(--tone-red);
      }
      .spin {
        width: 12px;
        height: 12px;
        border-radius: 50%;
        border: 2px solid var(--border);
        border-top-color: var(--text-secondary);
        animation: spin 0.8s linear infinite;
        flex: none;
      }
      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }
      .groups {
        max-height: 40vh;
        overflow: auto;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
      }
      details + details {
        border-top: 1px solid var(--border);
      }
      summary {
        cursor: pointer;
        padding: 6px 10px;
        display: flex;
        gap: 8px;
        justify-content: space-between;
        font-size: var(--text-sm);
      }
      .files,
      .failures {
        list-style: none;
        margin: 0;
        padding: 0 10px 6px;
      }
      .files li {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto auto;
        gap: 8px;
        padding: 2px 0;
        align-items: baseline;
      }
      .name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .folder {
        white-space: nowrap;
      }
      .size {
        text-align: right;
        min-width: 56px;
      }
      .muted {
        color: var(--text-secondary);
      }
      .small {
        font-size: var(--text-xs);
      }
      .mono {
        font-family: var(--font-mono, monospace);
      }
    `,
  ],
})
export class EaPruneFilesDialogComponent {
  readonly instanceId = input<string>('');
  readonly open = input(false);
  readonly closed = output<void>();

  private readonly admin = inject(EAAdminService);
  private readonly ops = inject(EaOpsService);

  protected readonly title = PRUNE_COPY.title;
  protected readonly safeText = PRUNE_COPY.safe;

  protected readonly phase = signal<Phase>('checking');
  protected readonly status = signal('');
  protected readonly sending = signal(false);
  private readonly dryRun = signal<PruneFilesResult | null>(null);
  private readonly dryRunJobId = signal<string | null>(null);
  protected readonly outcomeFailures = signal<string[]>([]);
  private watch: Subscription | null = null;

  protected readonly groups = computed(() => pruneGroups(this.dryRun()?.files ?? []));
  protected readonly description = computed(() =>
    this.phase() === 'checking' || this.phase() === 'error' ? PRUNE_COPY.intro : '',
  );
  protected readonly warning = computed(() =>
    this.phase() === 'review'
      ? 'Deleted files cannot be brought back. Trading is not affected: the EA keeps running while its old files are removed.'
      : null,
  );
  protected readonly confirmLabel = computed(() => {
    switch (this.phase()) {
      case 'checking':
        return 'Checking…';
      case 'review':
        return pruneConfirmLabel(this.dryRun());
      case 'deleting':
        return 'Deleting…';
      case 'error':
        return 'Check again';
      default:
        return 'Close';
    }
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => this.stopWatching());
    let wasOpen = false;
    effect(() => {
      const open = this.open();
      if (open && !wasOpen) untracked(() => this.startDryRun());
      if (!open && wasOpen) untracked(() => this.stopWatching());
      wasOpen = open;
    });
  }

  protected onConfirm(reason: string): void {
    switch (this.phase()) {
      case 'review':
        this.runForReal(reason);
        return;
      case 'error':
        this.startDryRun();
        return;
      case 'done':
      case 'empty':
        this.close();
        return;
    }
  }

  protected close(): void {
    if (this.sending()) return;
    this.stopWatching();
    this.closed.emit();
  }

  private startDryRun(): void {
    const id = this.instanceId();
    this.stopWatching();
    this.dryRun.set(null);
    this.dryRunJobId.set(null);
    this.outcomeFailures.set([]);
    this.phase.set('checking');
    this.status.set('Asking the host which files could be deleted…');
    this.sending.set(true);
    this.admin
      .pruneFiles(id, { dryRun: true })
      .pipe(catchError((err: { error?: { message?: string } }) => of({ status: false, message: err?.error?.message ?? null, data: null })))
      .subscribe((res) => {
        this.sending.set(false);
        if (!res.status || !res.data) {
          this.fail(res.message ?? 'The engine did not accept the dry run.');
          return;
        }
        const jobId = res.data.jobId;
        this.dryRunJobId.set(jobId);
        this.status.set(res.data.message || 'Checking…');
        this.watch = this.ops.watchJob(jobId).subscribe((tick) => {
          const j = tick.value;
          if (j && !tick.final) this.status.set(`Dry run: ${jobStatusText(j)}`);
          if (tick.final && j) {
            const r = j.status === 'Succeeded' ? parsePruneResult(j.resultData) : null;
            if (!r) {
              this.fail(j.status === 'Succeeded' ? 'The host answered without a list of files.' : `Dry run: ${jobStatusText(j)}`);
              return;
            }
            this.dryRun.set(r);
            this.status.set(pruneDryRunText(r));
            this.phase.set(r.fileCount > 0 ? 'review' : 'empty');
          } else if (tick.gaveUp) {
            this.fail('The host did not answer the dry run in time. Is its supervisor running?');
          }
        });
      });
  }

  private runForReal(reason: string): void {
    const id = this.instanceId();
    const dryRunJobId = this.dryRunJobId();
    if (!dryRunJobId) return;
    this.stopWatching();
    this.sending.set(true);
    this.admin
      .pruneFiles(id, { dryRun: false, dryRunJobId, reason: reason || null })
      .pipe(catchError((err: { error?: { message?: string } }) => of({ status: false, message: err?.error?.message ?? null, data: null })))
      .subscribe((res) => {
        this.sending.set(false);
        if (!res.status || !res.data) {
          // e.g. the dry run went stale: say why and offer a fresh one.
          this.fail(res.message ?? 'The engine did not accept the clean-up.');
          return;
        }
        const jobId = res.data.jobId;
        this.phase.set('deleting');
        this.status.set(res.data.message || 'Deleting…');
        this.ops.trackJob(id, jobId, 'Clean up old files');
        this.watch = this.ops.watchJob(jobId).subscribe((tick) => {
          const j = tick.value;
          if (tick.final && j) {
            const r = j.status === 'Succeeded' ? parsePruneResult(j.resultData) : null;
            if (r) {
              this.status.set(pruneOutcomeText(r));
              this.outcomeFailures.set(r.failures);
              this.phase.set('done');
            } else {
              this.fail(`Clean-up: ${jobStatusText(j)}`);
            }
          } else if (tick.gaveUp) {
            this.status.set('Still waiting for the host. The outcome will show under "Your actions".');
            this.phase.set('done');
          }
        });
      });
  }

  private fail(message: string): void {
    this.status.set(message);
    this.phase.set('error');
  }

  private stopWatching(): void {
    this.watch?.unsubscribe();
    this.watch = null;
  }

  protected bytes = formatBytes;
  protected label = pruneFileLabel;
}
