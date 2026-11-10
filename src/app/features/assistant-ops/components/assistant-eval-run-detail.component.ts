import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { DatePipe } from '@angular/common';

import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';

import { AssistantOpsApiService } from '../assistant-ops-api.service';
import { compact, ms, pct } from '../assistant-ops.logic';
import {
  casesText,
  evalKindLabel,
  evalStatusLabel,
  evalStatusTone,
  evalTriggerLabel,
  runDuration,
} from '../assistant-quality.logic';
import type { AssistantEvalCaseResult, AssistantEvalRunDetail } from '../assistant-ops.types';

/**
 * One eval run (`GET assistant/evals/runs/{id}`): its cases — passed or not, every check with
 * why it failed, the answer the assistant gave — and, for a lesson replay, the lesson and each
 * case with and without it.
 */
@Component({
  selector: 'app-assistant-eval-run-detail',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, CardSkeletonComponent],
  template: `
    <section class="detail" aria-label="Eval run detail">
      <header>
        <h3>Run #{{ runId() }}</h3>
        <button type="button" class="link" (click)="closed.emit()">Close</button>
      </header>
      @if (loading()) {
        <app-card-skeleton [lines]="5" />
      } @else if (error(); as e) {
        <p class="bad" role="alert">
          {{ e }} <button type="button" class="link" (click)="load()">Try again</button>
        </p>
      } @else if (detail(); as d) {
        <p class="facts">
          <span class="status" [attr.data-tone]="tone(d.run.status)">{{
            statusText(d.run.status)
          }}</span>
          {{ kindText(d.run.kind) }}, {{ triggerText(d.run.trigger) }} ·
          {{ d.run.queuedAtUtc | date: 'yyyy-MM-dd HH:mm' : 'UTC' }} UTC · {{ cases(d.run) }} ·
          {{ dur(d.run) }} · {{ num(d.run.tokensInput) }} in / {{ num(d.run.tokensOutput) }} out
          tokens
          @if (d.run.resolvedModel || d.run.model) {
            · <code>{{ d.run.resolvedModel || d.run.model }}</code>
          }
        </p>
        @if (d.run.summary) {
          <p class="summary">{{ d.run.summary }}</p>
        }
        @if (d.run.error) {
          <p class="bad">{{ d.run.error }}</p>
        }
        @if (d.lessonText) {
          <blockquote>
            <strong>Lesson #{{ d.lessonId }}</strong>
            @if (d.lessonScope) {
              <span class="muted"> ({{ d.lessonScope }})</span>
            }
            — {{ d.lessonText }}
          </blockquote>
          @if (d.run.improved !== null || d.run.worsened !== null) {
            <p class="facts">
              With the lesson: {{ d.run.improved ?? 0 }} case(s) better,
              {{ d.run.worsened ?? 0 }} worse, {{ d.run.unchanged ?? 0 }} unchanged.
            </p>
          }
        }
        @if (d.cases.length === 0) {
          <p class="muted">
            No case results yet{{ live(d.run.status) ? ' — the run is still going.' : '.' }}
          </p>
        } @else {
          <ul class="cases">
            @for (c of d.cases; track c.id) {
              <li [attr.data-pass]="c.skipped ? 'skip' : c.passed">
                <details>
                  <summary>
                    <span class="mark">{{ c.skipped ? '–' : c.passed ? '✓' : '✕' }}</span>
                    <span class="title">{{ c.caseTitle || c.caseId }}</span>
                    @if (c.arm) {
                      <span class="arm">{{
                        c.arm === 'with' ? 'with the lesson' : 'without the lesson'
                      }}</span>
                    }
                    <span class="muted">
                      score {{ pctOf(c.score) }} · {{ c.checksTotal - c.checksFailed }}/{{
                        c.checksTotal
                      }}
                      checks · {{ c.rounds }} rounds · {{ msOf(c.wallMs) }}
                      @if (c.protocol) {
                        · {{ protocolText(c.protocol) }}
                      }
                    </span>
                  </summary>
                  @if (c.skipped) {
                    <p class="muted">Skipped: {{ c.skipped }}</p>
                  }
                  @if (c.failureReason) {
                    <p class="bad">Why it failed: {{ c.failureReason }}</p>
                  }
                  @if (c.checks.length) {
                    <ul class="checks">
                      @for (k of c.checks; track $index) {
                        <li [class.fail]="!k.passed">
                          {{ k.passed ? '✓' : '✕' }} <code>{{ k.name }}</code>
                          @if (k.detail && !k.passed) {
                            — {{ k.detail }}
                          }
                        </li>
                      }
                    </ul>
                  }
                  <p class="muted small">
                    {{ num(c.tokensInput) }} in / {{ num(c.tokensOutput) }} out tokens ·
                    {{ num(c.tokensCacheRead) }} from the cache · {{ c.modelCalls }} model calls
                    @if (c.heldForRevision > 0) {
                      · held for a fix {{ c.heldForRevision }}×
                    }
                    @if (c.unverified) {
                      · posted unverified
                    }
                  </p>
                  @if (c.answer) {
                    <details class="answer">
                      <summary>The answer it gave</summary>
                      <pre>{{ excerpt(c) }}</pre>
                    </details>
                  }
                </details>
              </li>
            }
          </ul>
        }
      }
    </section>
  `,
  styles: [
    `
      .detail {
        border: 1px solid var(--border);
        border-radius: var(--radius-lg);
        background: var(--bg-secondary);
        padding: var(--space-3) var(--space-4);
        font-size: var(--text-sm);
      }
      header {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
      }
      h3 {
        margin: 0 0 var(--space-2);
        font-size: var(--text-base);
      }
      .link {
        border: none;
        background: none;
        color: var(--accent);
        cursor: pointer;
        font: inherit;
        padding: 0;
      }
      .facts,
      .summary {
        margin: 0 0 var(--space-2);
        color: var(--text-secondary);
      }
      .status {
        font-weight: var(--font-semibold);
        margin-right: 4px;
      }
      [data-tone='good'] {
        color: var(--profit);
      }
      [data-tone='warn'] {
        color: var(--warning);
      }
      [data-tone='bad'] {
        color: var(--loss);
      }
      [data-tone='live'] {
        color: var(--accent);
      }
      blockquote {
        margin: 0 0 var(--space-2);
        padding: 6px 10px;
        border-left: 3px solid var(--accent);
        background: var(--bg-tertiary);
      }
      .cases {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
        gap: 4px;
      }
      .cases > li {
        border-top: 1px solid var(--border);
        padding-top: 4px;
      }
      summary {
        cursor: pointer;
      }
      .mark {
        display: inline-block;
        width: 16px;
        font-weight: var(--font-bold);
      }
      li[data-pass='true'] .mark {
        color: var(--profit);
      }
      li[data-pass='false'] .mark {
        color: var(--loss);
      }
      .title {
        margin-right: 6px;
      }
      .arm {
        font-size: var(--text-xs);
        padding: 0 6px;
        border: 1px solid var(--border);
        border-radius: 8px;
        margin-right: 6px;
      }
      .checks {
        margin: 4px 0;
        padding-left: 20px;
        list-style: none;
        font-size: var(--text-xs);
      }
      .checks .fail {
        color: var(--loss);
      }
      .muted {
        color: var(--text-tertiary);
      }
      .small {
        font-size: var(--text-xs);
      }
      .bad {
        color: var(--loss);
      }
      pre {
        white-space: pre-wrap;
        font-size: var(--text-xs);
        max-height: 240px;
        overflow: auto;
        background: var(--bg-tertiary);
        padding: 6px;
        border-radius: var(--radius-sm);
      }
    `,
  ],
})
export class AssistantEvalRunDetailComponent {
  private readonly api = inject(AssistantOpsApiService);

  readonly runId = input.required<number>();
  readonly closed = output<void>();

  protected readonly detail = signal<AssistantEvalRunDetail | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  private seq = 0;

  constructor() {
    effect(() => {
      this.runId();
      untracked(() => this.load());
    });
  }

  load(): void {
    const id = this.runId();
    const seq = ++this.seq;
    this.loading.set(true);
    this.error.set(null);
    this.api.evalRun(id).subscribe({
      next: (d) => {
        if (seq !== this.seq) return;
        this.detail.set(d);
        this.loading.set(false);
      },
      error: (e: { message?: string }) => {
        if (seq !== this.seq) return;
        this.loading.set(false);
        this.error.set(e?.message || `Could not load run #${id}.`);
      },
    });
  }

  protected statusText = evalStatusLabel;
  protected tone = evalStatusTone;
  protected kindText = evalKindLabel;
  protected triggerText = evalTriggerLabel;
  protected cases = casesText;
  protected dur = runDuration;

  protected live(status: string): boolean {
    return status === 'Queued' || status === 'Running';
  }
  protected num(v: number): string {
    return compact(v);
  }
  protected msOf(v: number): string {
    return ms(v);
  }
  protected pctOf(v: number): string {
    return pct(v);
  }
  protected protocolText(p: string): string {
    return p === 'native'
      ? 'native tool calls'
      : p === 'sentinel'
        ? 'text markers'
        : p.replace(/_/g, ' ');
  }
  protected excerpt(c: AssistantEvalCaseResult): string {
    const a = c.answer ?? '';
    return a.length > 4000 ? `${a.slice(0, 4000)}…` : a;
  }
}
