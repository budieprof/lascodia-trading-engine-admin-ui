import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { Subscription } from 'rxjs';

import { EAAdminService } from '@core/services/ea-admin.service';
import { NotificationService } from '@core/notifications/notification.service';
import type { HostLogKind, TerminalJobDto } from '@core/api/ea-selfheal.types';

import { EaOpsService } from './ea-ops.service';
import { jobStatusText } from './selfheal.logic';
import { filterLogLines } from './host-logs.logic';
import { SELFHEAL_PANEL_STYLES } from './selfheal-styles';

const KINDS: { value: HostLogKind; label: string; hint: string }[] = [
  { value: 'ea', label: 'EA log', hint: "This EA's own log file on the terminal" },
  { value: 'journal', label: 'Terminal journal', hint: "MT5's journal (connection, login, errors)" },
  { value: 'supervisor', label: 'Host supervisor', hint: "The host supervisor's log" },
];

/**
 * Reads a log straight off the EA's host through its supervisor (a TailLog
 * job), so nobody has to open the terminal to see what it is saying.
 */
@Component({
  selector: 'app-ea-host-logs',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `
    <section class="panel" aria-label="Host logs">
      <header class="panel-head">
        <h3>Host logs</h3>
        <span class="meta">Read from the terminal's host on request</span>
      </header>

      <div class="controls">
        <div class="seg" role="radiogroup" aria-label="Which log">
          @for (k of kinds; track k.value) {
            <button
              type="button"
              role="radio"
              [attr.aria-checked]="kind() === k.value"
              [class.active]="kind() === k.value"
              [title]="k.hint"
              (click)="kind.set(k.value)"
            >
              {{ k.label }}
            </button>
          }
        </div>
        <label class="lines">
          Last
          <select [ngModel]="lines()" (ngModelChange)="lines.set(+$event)">
            @for (n of lineChoices; track n) {
              <option [ngValue]="n">{{ n }}</option>
            }
          </select>
          lines
        </label>
        <button type="button" class="btn btn-primary btn-sm" (click)="fetch()" [disabled]="working()">
          {{ working() ? 'Reading…' : text() === null ? 'Fetch' : 'Refresh' }}
        </button>
        <input
          type="search"
          class="search"
          placeholder="Search…"
          [ngModel]="query()"
          (ngModelChange)="query.set($event)"
          aria-label="Search the log"
        />
      </div>

      @if (status()) {
        <p class="small" [class.error-line]="failed()" [class.muted]="!failed()">{{ status() }}</p>
      }

      @if (text() !== null) {
        <div class="small muted">
          @if (path()) {
            <span class="mono">{{ path() }}</span> ·
          }
          @if (query()) {
            {{ shown().length }} of {{ total() }} lines match
          } @else {
            {{ total() }} lines
          }
        </div>
        <div class="log" tabindex="0" role="log">
          @for (l of shown(); track $index) {
            <div class="row"><span class="ln">{{ l.n }}</span>{{ l.text }}</div>
          }
        </div>
      } @else if (!working()) {
        <p class="empty">Pick a log and press Fetch. The host reads it and sends it back (usually a few seconds).</p>
      }
    </section>
  `,
  styles: [
    SELFHEAL_PANEL_STYLES,
    `
      .controls {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-2);
        align-items: center;
      }
      .seg {
        display: inline-flex;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        overflow: hidden;
      }
      .seg button {
        background: var(--bg-primary);
        border: none;
        padding: 4px 10px;
        font-size: var(--text-xs);
        color: var(--text-secondary);
        cursor: pointer;
      }
      .seg button.active {
        background: var(--accent);
        color: var(--accent-contrast, #fff);
      }
      .lines {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        display: inline-flex;
        gap: 6px;
        align-items: center;
      }
      .lines select,
      .search {
        padding: 4px 8px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-xs);
      }
      .search {
        flex: 1;
        min-width: 160px;
      }
      .log {
        margin: 0;
        max-height: 480px;
        overflow: auto;
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        padding: 8px 10px;
        font-family: var(--font-mono);
        font-size: 11.5px;
        line-height: 1.5;
      }
      .row {
        white-space: pre;
        min-height: 1.5em;
      }
      .ln {
        display: inline-block;
        width: 4.5em;
        color: var(--text-tertiary);
        user-select: none;
      }
    `,
  ],
})
export class EaHostLogsComponent {
  readonly instanceId = input.required<string>();

  private readonly admin = inject(EAAdminService);
  private readonly ops = inject(EaOpsService);
  private readonly notify = inject(NotificationService);

  protected readonly kinds = KINDS;
  protected readonly lineChoices = [200, 500, 1000, 2000];
  protected readonly kind = signal<HostLogKind>('ea');
  protected readonly lines = signal(500);
  protected readonly query = signal('');
  protected readonly working = signal(false);
  protected readonly status = signal('');
  protected readonly failed = signal(false);
  protected readonly text = signal<string | null>(null);
  protected readonly path = signal('');

  private readonly allLines = computed(() => (this.text() ?? '').replace(/\r\n/g, '\n').split('\n'));
  protected readonly total = computed(() => (this.text() ? filterLogLines(this.allLines(), '').length : 0));
  protected readonly shown = computed(() => filterLogLines(this.allLines(), this.query()));

  private watch: Subscription | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.watch?.unsubscribe());
  }

  protected fetch(): void {
    const id = this.instanceId();
    const kind = this.kind();
    const label = KINDS.find((k) => k.value === kind)?.label ?? kind;
    this.working.set(true);
    this.failed.set(false);
    this.status.set(`Asking the host for the ${label.toLowerCase()}…`);
    this.watch?.unsubscribe();
    this.admin.requestHostLogs(id, kind, this.lines()).subscribe({
      next: (res) => {
        if (!res.status || !res.data) {
          this.done(res.message ?? 'The engine refused the request.', true);
          return;
        }
        this.watch = this.ops.watchJob(res.data.jobId).subscribe((tick) => {
          const job = tick.value;
          if (tick.final && job) {
            this.finish(job);
          } else if (tick.gaveUp) {
            this.done(
              job ? `${jobStatusText(job)} Stopped waiting.` : 'Could not read the job from the engine.',
              true,
            );
          } else if (job) {
            this.status.set(jobStatusText(job));
          }
        });
      },
      error: (err: { error?: { message?: string } }) =>
        this.done(err?.error?.message ?? 'The engine did not answer.', true),
    });
  }

  private finish(job: TerminalJobDto): void {
    if (job.status !== 'Succeeded') {
      this.done(jobStatusText(job), true);
      return;
    }
    const data = job.resultData ?? {};
    const text = typeof data['text'] === 'string' ? (data['text'] as string) : '';
    this.text.set(text);
    this.path.set(typeof data['path'] === 'string' ? (data['path'] as string) : '');
    this.done(text ? `Read ${new Date().toLocaleTimeString()}.` : 'The log is empty.', false);
  }

  private done(message: string, failed: boolean): void {
    this.working.set(false);
    this.failed.set(failed);
    this.status.set(message);
    if (failed) this.notify.error(message);
  }
}
