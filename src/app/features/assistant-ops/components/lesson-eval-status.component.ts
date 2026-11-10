import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';

import { LscCanDirective } from '@core/auth/can.directive';
import { Permission } from '@core/auth/permissions.generated';

import { AssistantOpsApiService } from '../assistant-ops-api.service';
import { lessonEvalOf, queueRefusalText } from '../assistant-quality.logic';
import type { AssistantLesson } from '../assistant-ops.types';

/**
 * One lesson's measured effect: the latest replay of its test cases with and without it
 * (better / worse / unchanged, link to the run), the "No measurable effect" flag, and Evaluate
 * (`POST assistant/lessons/{id}/evaluate`, `access.operator`).
 */
@Component({
  selector: 'app-lesson-eval-status',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, RouterLink, LscCanDirective],
  template: `
    @if (lesson().noMeasurableEffect || view() || canEvaluate() || message()) {
      <div class="ev">
        @if (lesson().noMeasurableEffect) {
          <span
            class="badge"
            title="Approved for 30+ days and in use, but replaying its test cases with and without it changed nothing. Consider retiring it."
            >No measurable effect</span
          >
        }
        @if (view(); as v) {
          <span class="out" [attr.data-tone]="v.tone">{{ v.text }}</span>
          @if (v.at) {
            <span class="muted" [title]="v.at | date: 'yyyy-MM-dd HH:mm' : 'UTC'"
              >· {{ v.at | date: 'MMM d' : 'UTC' }}</span
            >
          }
          @if (v.runId) {
            <a routerLink="/assistant" [queryParams]="{ tab: 'evals', run: v.runId }"
              >run #{{ v.runId }}</a
            >
          }
        } @else if (lesson().status === 'Approved' || lesson().status === 'Candidate') {
          <span class="muted">Not measured yet</span>
        }
        @if (canEvaluate()) {
          <button
            *lscCan="operatorKey"
            type="button"
            class="act"
            [disabled]="busy() || view()?.live"
            title="Replay the test cases this lesson applies to on the real model, with and without it"
            (click)="evaluate()"
          >
            {{ busy() ? 'Queuing…' : 'Evaluate' }}
          </button>
        }
        @if (message(); as m) {
          <span class="msg" [attr.data-tone]="m.tone" role="status">{{ m.text }}</span>
        }
      </div>
    }
  `,
  styles: [
    `
      .ev {
        display: flex;
        flex-wrap: wrap;
        gap: 4px 8px;
        align-items: center;
        font-size: var(--text-xs);
        margin: 6px 0;
      }
      .badge {
        padding: 1px 8px;
        border-radius: 9px;
        border: 1px solid color-mix(in srgb, var(--warning) 55%, transparent);
        color: var(--warning);
        cursor: help;
      }
      .out[data-tone='good'] {
        color: var(--profit);
      }
      .out[data-tone='bad'] {
        color: var(--loss);
      }
      .out[data-tone='live'] {
        color: var(--accent);
      }
      .muted {
        color: var(--text-tertiary);
      }
      a {
        color: var(--accent);
      }
      .act {
        border: 1px solid var(--border);
        background: var(--bg-tertiary);
        color: var(--text-primary);
        border-radius: var(--radius-sm);
        padding: 2px 8px;
        font-size: var(--text-xs);
        cursor: pointer;
      }
      .act:disabled {
        opacity: 0.55;
        cursor: default;
      }
      .msg {
        width: 100%;
      }
      .msg[data-tone='bad'] {
        color: var(--loss);
      }
      .msg[data-tone='good'] {
        color: var(--profit);
      }
    `,
  ],
})
export class LessonEvalStatusComponent {
  private readonly api = inject(AssistantOpsApiService);

  readonly lesson = input.required<AssistantLesson>();

  protected readonly operatorKey = Permission.AccessOperator;
  protected readonly busy = signal(false);
  protected readonly message = signal<{ text: string; tone: 'good' | 'bad' } | null>(null);
  protected readonly view = computed(() => lessonEvalOf(this.lesson()));
  /** Rejected / retired lessons reach nobody, so measuring them is pointless. */
  protected readonly canEvaluate = computed(() => {
    const s = this.lesson().status;
    return s === 'Approved' || s === 'Candidate';
  });

  protected evaluate(): void {
    if (this.busy()) return;
    this.busy.set(true);
    this.message.set(null);
    this.api.evaluateLesson(this.lesson().id).subscribe({
      next: (run) => {
        this.busy.set(false);
        this.message.set({
          text: `Replay queued as run #${run.id}; it starts within a minute.`,
          tone: 'good',
        });
      },
      error: (err: unknown) => {
        this.busy.set(false);
        this.message.set({ text: queueRefusalText(err, 'lesson'), tone: 'bad' });
      },
    });
  }
}
