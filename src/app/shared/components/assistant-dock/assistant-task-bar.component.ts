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
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { AssistantService, type AssistantTaskDto } from '@core/assistant/assistant.service';
import { RealtimeService } from '@core/realtime/realtime.service';
import { NotificationService } from '@core/notifications/notification.service';

/** How long an ended task stays on the bar before it gets out of the way. */
const ENDED_VISIBLE_MS = 30 * 60_000;
const POLL_MS = 20_000;

/** Ended tasks stay visible for a while so the operator sees how it finished. */
export function taskBarVisible(task: AssistantTaskDto | null, now = Date.now()): boolean {
  if (!task) return false;
  if (task.status === 'Active' || task.status === 'Waiting') return true;
  const ended = task.endedAtUtc ? Date.parse(task.endedAtUtc) : 0;
  return now - ended < ENDED_VISIBLE_MS;
}

export function taskProgress(task: AssistantTaskDto): { done: number; total: number; pct: number } {
  const total = task.todos.length;
  const done = task.todos.filter((t) => t.status === 'done' || t.status === 'skipped').length;
  return { done, total, pct: total === 0 ? 0 : Math.round((done / total) * 100) };
}

/**
 * The assistant's long-running task, pinned above the chat: what it is working toward, how far it
 * is, what it is doing or waiting on right now, and a Stop that cancels the task, its monitors and
 * any queued wake. The plan card in the thread carries the full checklist; this bar is the part
 * that must stay visible while the thread scrolls.
 */
@Component({
  selector: 'app-assistant-task-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, RouterLink],
  template: `
    @if (visible() && task(); as t) {
      <section class="task-bar" [attr.data-status]="t.status" aria-label="Assistant task">
        <div class="row">
          <span class="pill">{{ t.status === 'Waiting' ? 'Waiting' : t.status }}</span>
          <span class="goal" [title]="t.goal">{{ t.goal }}</span>
          <button
            type="button"
            class="link"
            (click)="expanded.set(!expanded())"
            [attr.aria-expanded]="expanded()"
          >
            {{ expanded() ? 'Less' : 'Details' }}
          </button>
          @if (live()) {
            <button
              type="button"
              class="stop"
              [class.armed]="stopArmed()"
              [disabled]="stopping()"
              (click)="onStop()"
            >
              {{ stopping() ? 'Stopping…' : stopArmed() ? 'Confirm stop' : 'Stop' }}
            </button>
          }
        </div>

        <div
          class="progress"
          role="progressbar"
          [attr.aria-valuenow]="progress().pct"
          aria-valuemin="0"
          aria-valuemax="100"
        >
          <span [style.width.%]="progress().pct"></span>
        </div>

        <div class="meta">
          <span>{{ progress().done }}/{{ progress().total }} steps</span>
          <span>wakes {{ t.wakeCount }}/{{ t.maxWakes }}</span>
          @if (t.budgetUsd > 0) {
            <span>\${{ t.spentUsd.toFixed(2) }} / \${{ t.budgetUsd.toFixed(2) }}</span>
          }
          @for (id of t.waitingOnMonitorIds; track id) {
            <a [routerLink]="['/analysis-monitors']" [queryParams]="{ focus: id }"
              >watching #{{ id }}</a
            >
          }
        </div>

        @if (t.currentActivity) {
          <div class="now">{{ t.currentActivity }}</div>
        } @else if (t.endReason && !live()) {
          <div class="now">{{ t.endReason }}</div>
        }

        @if (expanded()) {
          <ul class="todos">
            @for (todo of t.todos; track todo.id) {
              <li [attr.data-status]="todo.status">
                <span class="box">{{ todoGlyph(todo.status) }}</span>
                {{ todo.text }}
                @if (todo.note) {
                  <span class="note">— {{ todo.note }}</span>
                }
              </li>
            }
          </ul>
          <ol class="activity">
            @for (a of recentActivity(); track $index) {
              <li>
                <time>{{ a.atUtc | date: 'MMM d HH:mm' }}</time>
                <span class="kind">{{ a.kind }}</span>
                {{ a.text }}
              </li>
            }
          </ol>
        }
      </section>
    }
  `,
  styles: [
    `
      .task-bar {
        margin: 0 0 var(--space-2);
        padding: var(--space-2) var(--space-3);
        border: 1px solid var(--border);
        border-left: 3px solid var(--accent);
        border-radius: var(--radius-md);
        background: var(--bg-secondary);
        font-size: var(--text-xs);
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .task-bar[data-status='Waiting'] {
        border-left-color: var(--warning, #ff9500);
      }
      .task-bar[data-status='Done'] {
        border-left-color: var(--profit);
      }
      .task-bar[data-status='Failed'],
      .task-bar[data-status='Cancelled'] {
        border-left-color: var(--loss);
      }
      .row {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        min-width: 0;
      }
      .pill {
        flex: none;
        padding: 1px 8px;
        border-radius: var(--radius-full);
        background: var(--bg-tertiary);
        font-weight: var(--font-semibold);
      }
      .goal {
        flex: 1 1 auto;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--text-primary);
        font-weight: var(--font-semibold);
      }
      .link,
      .stop {
        flex: none;
        border: 1px solid var(--border);
        background: var(--bg-primary);
        color: var(--text-secondary);
        border-radius: var(--radius-sm);
        padding: 2px 8px;
        font: inherit;
        cursor: pointer;
      }
      .stop.armed {
        border-color: var(--loss);
        color: var(--loss);
      }
      .progress {
        height: 4px;
        border-radius: 2px;
        background: var(--bg-tertiary);
        overflow: hidden;
      }
      .progress span {
        display: block;
        height: 100%;
        background: var(--accent);
        transition: width 0.3s ease;
      }
      .meta {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-3);
        color: var(--text-secondary);
      }
      .now {
        color: var(--text-primary);
      }
      .todos,
      .activity {
        margin: 0;
        padding: 0;
        list-style: none;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .todos li[data-status='done'],
      .todos li[data-status='skipped'] {
        color: var(--text-tertiary);
        text-decoration: line-through;
      }
      .box {
        display: inline-block;
        width: 1.2em;
      }
      .note,
      .activity time,
      .activity .kind {
        color: var(--text-tertiary);
      }
      .activity {
        max-height: 160px;
        overflow: auto;
        border-top: 1px solid var(--border);
        padding-top: 4px;
      }
      .activity .kind {
        margin: 0 4px;
      }
    `,
  ],
})
export class AssistantTaskBarComponent {
  readonly sessionId = input.required<number>();

  private readonly assistant = inject(AssistantService);
  private readonly realtime = inject(RealtimeService);
  private readonly notify = inject(NotificationService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly task = signal<AssistantTaskDto | null>(null);
  protected readonly expanded = signal(false);
  protected readonly stopArmed = signal(false);
  protected readonly stopping = signal(false);

  protected readonly visible = computed(() => taskBarVisible(this.task()));
  protected readonly live = computed(() => {
    const s = this.task()?.status;
    return s === 'Active' || s === 'Waiting';
  });
  protected readonly progress = computed(() => {
    const t = this.task();
    return t ? taskProgress(t) : { done: 0, total: 0, pct: 0 };
  });
  protected readonly recentActivity = computed(() =>
    [...(this.task()?.activity ?? [])].reverse().slice(0, 12),
  );

  private loadTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    effect(() => {
      this.sessionId();
      untracked(() => {
        this.task.set(null);
        this.load();
      });
    });

    this.realtime.connect();
    this.realtime
      .on<{ llmInvocationId: number }>('analysisConversationChanged')
      .pipe(takeUntilDestroyed())
      .subscribe((p) => {
        if (p?.llmInvocationId === this.sessionId()) this.scheduleLoad(500);
      });

    // Waiting tasks change state from a worker in another process; poll gently as a belt.
    const poll = setInterval(() => {
      if (this.live()) this.load();
    }, POLL_MS);
    this.destroyRef.onDestroy(() => {
      clearInterval(poll);
      if (this.loadTimer) clearTimeout(this.loadTimer);
    });
  }

  protected todoGlyph(status: string): string {
    return status === 'done'
      ? '☑'
      : status === 'in_progress'
        ? '◐'
        : status === 'blocked'
          ? '⛔'
          : status === 'skipped'
            ? '↷'
            : '☐';
  }

  protected onStop(): void {
    if (!this.stopArmed()) {
      this.stopArmed.set(true);
      setTimeout(() => this.stopArmed.set(false), 4000);
      return;
    }
    this.stopArmed.set(false);
    this.stopping.set(true);
    this.assistant.cancelTask(this.sessionId()).subscribe({
      next: (res) => {
        this.stopping.set(false);
        if (res?.data) this.task.set(res.data);
        this.notify.success('Task stopped — its monitors and queued wakes are cancelled.');
      },
      error: () => this.stopping.set(false),
    });
  }

  private scheduleLoad(delayMs: number): void {
    if (this.loadTimer) clearTimeout(this.loadTimer);
    this.loadTimer = setTimeout(() => this.load(), delayMs);
  }

  private load(): void {
    const id = this.sessionId();
    this.assistant.getTask(id).subscribe({
      next: (res) => {
        if (id === this.sessionId()) this.task.set(res?.data ?? null);
      },
      error: () => undefined,
    });
  }
}
