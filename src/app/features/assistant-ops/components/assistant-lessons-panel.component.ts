import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import type { Subscription } from 'rxjs';

import { NotificationService } from '@core/notifications/notification.service';
import { Permission } from '@core/auth/permissions.generated';
import { LscCanDirective } from '@core/auth/can.directive';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { FeatureStateComponent } from '@shared/components/feedback/feature-state.component';
import { RefreshButtonComponent } from '@shared/components/refresh-button/refresh-button.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';
import { errorText } from '@features/iam/iam.logic';

import { AssistantOpsApiService } from '../assistant-ops-api.service';
import { LessonEvalStatusComponent } from './lesson-eval-status.component';
import {
  LESSON_SCOPES,
  LESSON_SOURCES,
  LESSON_STATUS_FILTERS,
  NOTE_MAX,
  SCOPE_VALUE_MAX,
  TEXT_MAX,
  dialogMessage,
  dialogTitle,
  editsText,
  lessonActions,
  needsReason,
  personLabel,
  reviewBody,
  reviewDoneMessage,
  reviewFormFor,
  reviewProblem,
  scopeLabel,
  sourceLabel,
  statusLabel,
  statusTone,
  type LessonAction,
  type LessonActionKind,
  type ReviewForm,
} from '../assistant-ops.logic';
import type { AssistantLesson } from '../assistant-ops.types';

/** The review in progress: which lesson, which decision, and the dialog's fields. */
interface Review {
  lesson: AssistantLesson;
  kind: LessonActionKind;
  action: LessonAction;
}

/**
 * The assistant's lessons: rules it learned from rejected cards, corrections and answers its
 * checks could not verify. Only approved lessons reach its prompt, so the default view is the
 * review queue. Approve (with edits) / reject / retire call `POST assistant/lessons/{id}/{action}`.
 */
@Component({
  selector: 'app-assistant-lessons-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    RouterLink,
    LscCanDirective,
    ConfirmDialogComponent,
    CardSkeletonComponent,
    ErrorStateComponent,
    FeatureStateComponent,
    RefreshButtonComponent,
    RelativeTimePipe,
    LessonEvalStatusComponent,
  ],
  template: `
    <div class="panel">
      <div class="toolbar">
        <div class="seg" role="group" aria-label="Status">
          @for (f of statusFilters; track f.value) {
            <button
              type="button"
              [class.on]="status() === f.value"
              [attr.aria-pressed]="status() === f.value"
              (click)="setStatus(f.value)"
            >
              {{ f.label }}
            </button>
          }
        </div>
        <label class="field">
          <span>Learned from</span>
          <select [value]="source()" (change)="setSource($any($event.target).value)">
            <option value="">Any source</option>
            @for (s of sources; track s.value) {
              <option [value]="s.value">{{ s.label }}</option>
            }
          </select>
        </label>
        <span class="spacer"></span>
        <app-refresh-button [refreshing]="refreshing()" (refresh)="load()" />
      </div>

      <p class="intro muted">
        The assistant proposes a lesson when an operator rejects one of its approval cards, corrects
        it, or when an answer goes out that its own checks could not verify. A lesson reaches the
        assistant only once someone approves it here.
      </p>

      @if (loading()) {
        <app-card-skeleton [lines]="6" />
      } @else if (loadError(); as err) {
        <app-error-state
          title="Could not load the assistant's lessons"
          [message]="err"
          (retry)="load()"
        />
      } @else if (lessons().length === 0) {
        <app-feature-state
          [kind]="status() === 'Candidate' ? 'on' : 'waiting'"
          [title]="emptyTitle()"
          [summary]="emptySummary()"
          [links]="[{ label: 'Open Conversations', route: '/conversations' }]"
        />
      } @else {
        <p class="muted small count">
          {{ lessons().length }} lesson{{ lessons().length === 1 ? '' : 's' }}
          @if (hasMore()) {
            shown — newest first, more below
          }
        </p>
        <ul class="lessons">
          @for (l of lessons(); track l.id) {
            <li class="lesson" [attr.data-tone]="tone(l.status)">
              <header class="lesson-head">
                <span class="status" [attr.data-tone]="tone(l.status)">{{
                  statusText(l.status)
                }}</span>
                <span class="id">#{{ l.id }}</span>
                <span class="scope" title="Where the lesson applies">{{ scope(l) }}</span>
                <span class="spacer"></span>
                @if (l.status === 'Approved' || l.injectedCount > 0) {
                  <span
                    class="muted small"
                    title="How many times the lesson was given to the assistant"
                    >Used {{ l.injectedCount }}×
                    @if (l.lastInjectedAtUtc) {
                      · last {{ l.lastInjectedAtUtc | relativeTime }}
                    }
                  </span>
                }
              </header>

              <p class="text">{{ l.text }}</p>

              <!-- Its measured effect: replay with / without it, and Evaluate. -->
              <app-lesson-eval-status [lesson]="l" />

              @if (l.evidence) {
                <details class="evidence">
                  <summary>What it was learned from</summary>
                  <pre>{{ l.evidence }}</pre>
                </details>
              }

              <dl class="meta">
                <dt>Source</dt>
                <dd>
                  {{ sourceText(l.source) }}
                  @for (c of l.sourceConversationIds; track c) {
                    ·
                    <a routerLink="/conversations" [queryParams]="{ conversation: c }"
                      >conversation #{{ c }}</a
                    >
                  }
                  @if (l.sourceTurnId) {
                    <span class="muted"> · message #{{ l.sourceTurnId }}</span>
                  }
                  @if (l.sourceRef) {
                    <span class="muted"> · {{ l.sourceRef }}</span>
                  }
                </dd>
                <dt>Created</dt>
                <dd>
                  <span [title]="l.createdAtUtc | date: 'yyyy-MM-dd HH:mm' : 'UTC'">{{
                    l.createdAtUtc | relativeTime
                  }}</span>
                  @if (l.createdBy) {
                    by {{ person(l.createdBy, l.createdByName) }}
                  } @else {
                    by the assistant
                  }
                </dd>
                @if (l.reviewedAtUtc) {
                  <dt>Decided</dt>
                  <dd>
                    <span [title]="l.reviewedAtUtc | date: 'yyyy-MM-dd HH:mm' : 'UTC'">{{
                      l.reviewedAtUtc | relativeTime
                    }}</span>
                    by {{ person(l.reviewedBy, l.reviewedByName) }}
                    @if (l.reviewNote) {
                      — “{{ l.reviewNote }}”
                    }
                  </dd>
                }
              </dl>

              <div class="actions" *lscCan="operatorKey">
                @for (a of actionsFor(l); track a.kind) {
                  <button
                    type="button"
                    class="act"
                    [class.primary]="a.kind === 'approve'"
                    [class.danger]="a.danger"
                    [disabled]="busy()"
                    (click)="open(l, a)"
                  >
                    {{ a.label }}
                  </button>
                }
              </div>
            </li>
          }
        </ul>
        @if (hasMore()) {
          <div class="more">
            <button type="button" class="act" [disabled]="loadingMore()" (click)="loadMore()">
              {{ loadingMore() ? 'Loading…' : 'Load ' + pageSize + ' more' }}
            </button>
          </div>
        }
        @if (moreNote(); as note) {
          <p class="muted small more-note" role="status">{{ note }}</p>
        }
      }

      <app-confirm-dialog
        [open]="review() !== null"
        [title]="reviewTitle()"
        [message]="reviewMessage()"
        [confirmLabel]="review()?.action?.label ?? 'Confirm'"
        [confirmVariant]="review()?.action?.danger ? 'destructive' : 'primary'"
        [loading]="busy()"
        (confirm)="submit()"
        (cancelled)="close()"
      >
        @if (review(); as r) {
          <div class="form">
            @if (editsTextFor(r.kind)) {
              <label class="field block">
                <span>Lesson ({{ form().text.length }} / {{ textMax }})</span>
                <textarea
                  rows="5"
                  [attr.maxlength]="textMax"
                  [value]="form().text"
                  (input)="patch({ text: $any($event.target).value })"
                ></textarea>
              </label>
              <div class="row">
                <label class="field">
                  <span>Applies</span>
                  <select
                    [value]="form().scopeKind"
                    (change)="patch({ scopeKind: $any($event.target).value })"
                  >
                    @for (s of scopes; track s.value) {
                      <option [value]="s.value">{{ s.label }}</option>
                    }
                  </select>
                </label>
                @if (form().scopeKind !== 'global') {
                  <label class="field grow">
                    <span>{{ scopeHint(form().scopeKind) }}</span>
                    <input
                      type="text"
                      [attr.maxlength]="scopeMax"
                      [value]="form().scopeValue"
                      (input)="patch({ scopeValue: $any($event.target).value })"
                    />
                  </label>
                }
              </div>
            }
            <label class="field block">
              <span>{{
                needsReasonFor(r.kind) ? 'Reason (required, kept on the lesson)' : 'Note (optional)'
              }}</span>
              <textarea
                rows="2"
                [attr.maxlength]="noteMax"
                [value]="form().note"
                (input)="patch({ note: $any($event.target).value })"
              ></textarea>
            </label>
            @if (shownProblem(); as p) {
              <p class="problem" role="alert">{{ p }}</p>
            }
          </div>
        }
      </app-confirm-dialog>
    </div>
  `,
  styles: [
    `
      .panel {
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .toolbar {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--space-2) var(--space-3);
      }
      .spacer {
        flex: 1;
      }
      .seg {
        display: inline-flex;
        flex-wrap: wrap;
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: hidden;
      }
      .seg button {
        border: none;
        background: transparent;
        color: var(--text-secondary);
        padding: 5px 10px;
        font-size: var(--text-sm);
        cursor: pointer;
      }
      .seg button + button {
        border-left: 1px solid var(--border);
      }
      .seg button.on {
        background: color-mix(in srgb, var(--accent) 14%, transparent);
        color: var(--text-primary);
        font-weight: var(--font-semibold);
      }
      .field {
        display: inline-flex;
        align-items: center;
        gap: var(--space-2);
        font-size: var(--text-sm);
        color: var(--text-secondary);
      }
      .field.block {
        display: flex;
        flex-direction: column;
        align-items: stretch;
        gap: 4px;
      }
      .field.grow {
        flex: 1;
      }
      .field select,
      .field input,
      .field textarea {
        font: inherit;
        color: var(--text-primary);
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        padding: 5px 8px;
      }
      .field.grow input {
        width: 100%;
        box-sizing: border-box;
      }
      .field textarea {
        resize: vertical;
        width: 100%;
        box-sizing: border-box;
      }
      .intro {
        margin: 0;
        font-size: var(--text-sm);
        max-width: 100ch;
      }
      .muted {
        color: var(--text-tertiary);
      }
      .small {
        font-size: var(--text-xs);
      }
      .count {
        margin: 0;
      }
      .lessons {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
        gap: var(--space-3);
      }
      .lesson {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-left: 4px solid var(--text-tertiary);
        border-radius: var(--radius-md);
        padding: var(--space-3) var(--space-4);
      }
      .lesson[data-tone='warn'] {
        border-left-color: var(--warning);
      }
      .lesson[data-tone='ok'] {
        border-left-color: var(--profit);
      }
      .lesson[data-tone='bad'] {
        border-left-color: var(--loss);
      }
      .lesson-head {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--space-1) var(--space-3);
      }
      .status {
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        padding: 1px 8px;
        border-radius: 999px;
        background: var(--bg-tertiary);
        color: var(--text-secondary);
      }
      .status[data-tone='warn'] {
        background: color-mix(in srgb, var(--warning) 15%, transparent);
        color: var(--warning);
      }
      .status[data-tone='ok'] {
        background: color-mix(in srgb, var(--profit) 15%, transparent);
        color: var(--profit);
      }
      .status[data-tone='bad'] {
        background: color-mix(in srgb, var(--loss) 12%, transparent);
        color: var(--loss);
      }
      .id {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
      }
      .scope {
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .text {
        margin: var(--space-2) 0;
        white-space: pre-wrap;
        line-height: 1.5;
      }
      .evidence summary {
        cursor: pointer;
        font-size: var(--text-xs);
        color: var(--text-tertiary);
      }
      .evidence pre {
        white-space: pre-wrap;
        font-size: var(--text-xs);
        background: var(--bg-tertiary);
        padding: var(--space-2);
        border-radius: var(--radius-sm);
        max-height: 240px;
        overflow: auto;
      }
      .meta {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 2px var(--space-3);
        margin: var(--space-2) 0 0;
        font-size: var(--text-xs);
      }
      .meta dt {
        color: var(--text-tertiary);
      }
      .meta dd {
        margin: 0;
        color: var(--text-secondary);
      }
      .meta a {
        color: var(--accent);
      }
      .actions {
        display: flex;
        gap: var(--space-2);
        margin-top: var(--space-3);
      }
      .act {
        font: inherit;
        font-size: var(--text-sm);
        padding: 4px 12px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-primary);
        color: var(--text-primary);
        cursor: pointer;
      }
      .act:hover:not(:disabled) {
        border-color: var(--accent);
      }
      .act.primary {
        background: var(--accent);
        border-color: var(--accent);
        color: var(--accent-contrast, #fff);
      }
      .act.danger {
        color: var(--loss);
        border-color: color-mix(in srgb, var(--loss) 50%, var(--border));
      }
      .act:disabled {
        opacity: 0.5;
        cursor: default;
      }
      .more {
        display: flex;
        justify-content: center;
      }
      .more-note {
        margin: 0;
        text-align: center;
      }
      .form {
        display: grid;
        gap: var(--space-3);
        margin-top: var(--space-2);
      }
      .row {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-2) var(--space-3);
        align-items: center;
      }
      .problem {
        margin: 0;
        color: var(--loss);
        font-size: var(--text-sm);
      }
    `,
  ],
})
export class AssistantLessonsPanelComponent {
  private readonly api = inject(AssistantOpsApiService);
  private readonly notify = inject(NotificationService);

  protected readonly statusFilters = LESSON_STATUS_FILTERS;
  protected readonly sources = LESSON_SOURCES;
  protected readonly scopes = LESSON_SCOPES;
  protected readonly textMax = TEXT_MAX;
  protected readonly scopeMax = SCOPE_VALUE_MAX;
  protected readonly noteMax = NOTE_MAX;
  protected readonly operatorKey = Permission.AccessOperator;
  /** Lessons per page ("Load more" asks for the next page with `skip`). */
  readonly pageSize = 100;
  /** The engine's cap on one request (`take` clamps to 1..500). */
  private static readonly MaxTake = 500;

  /** '' = every status. Defaults to the review queue. */
  readonly status = signal('Candidate');
  readonly source = signal('');

  readonly lessons = signal<AssistantLesson[]>([]);
  /** The last page came back full, so there may be more. */
  readonly hasMore = signal(false);
  readonly loadingMore = signal(false);
  /** Why "Load more" stopped short (a failed page, or an engine that ignores `skip`). */
  readonly moreNote = signal<string | null>(null);
  readonly loading = signal(true);
  readonly refreshing = signal(false);
  readonly loadError = signal<string | null>(null);

  readonly review = signal<Review | null>(null);
  readonly form = signal<ReviewForm>({ text: '', scopeKind: 'global', scopeValue: '', note: '' });
  readonly busy = signal(false);
  /** Shown after a submit attempt: the form's own problem, or the engine's refusal. */
  readonly submitError = signal<string | null>(null);
  private readonly tried = signal(false);

  readonly problem = computed(() => {
    const r = this.review();
    return r ? reviewProblem(r.kind, this.form()) : null;
  });
  readonly shownProblem = computed(
    () => this.submitError() ?? (this.tried() ? this.problem() : null),
  );

  readonly reviewTitle = computed(() => {
    const r = this.review();
    return r ? dialogTitle(r.kind, r.lesson) : '';
  });
  readonly reviewMessage = computed(() => {
    const r = this.review();
    return r ? dialogMessage(r.kind) : '';
  });

  readonly emptyTitle = computed(() =>
    this.status() === 'Candidate'
      ? 'Nothing waiting for review'
      : this.status() === ''
        ? 'The assistant has no lessons yet'
        : `No ${statusLabel(this.status()).toLowerCase()} lessons`,
  );
  readonly emptySummary = computed(() =>
    this.status() === 'Candidate'
      ? 'Every lesson the assistant proposed has been decided. New ones appear here when an operator rejects an approval card with a reason, corrects the assistant, or an answer goes out that its checks could not verify.'
      : 'None match this filter. Lessons are proposed from rejected approval cards, operator corrections and unverified answers, and reach the assistant only once approved.',
  );

  private inflight: Subscription | null = null;

  constructor() {
    this.load();
  }

  /** (Re)load from the newest, keeping as many rows as are on screen (up to the engine's cap). */
  load(): void {
    this.inflight?.unsubscribe();
    if (this.lessons().length > 0) this.refreshing.set(true);
    const take = Math.min(
      AssistantLessonsPanelComponent.MaxTake,
      Math.max(this.pageSize, this.lessons().length),
    );
    this.inflight = this.api
      .lessons(this.status() || null, this.source() || null, take, 0)
      .subscribe({
        next: (rows) => {
          this.lessons.set(rows);
          this.hasMore.set(rows.length >= take);
          this.moreNote.set(null);
          this.loadError.set(null);
          this.loading.set(false);
          this.refreshing.set(false);
        },
        error: (e: unknown) => {
          this.loadError.set(errorText(e, 'The engine did not answer GET assistant/lessons.'));
          this.loading.set(false);
          this.refreshing.set(false);
        },
      });
  }

  /** The next page, after the rows on screen. */
  loadMore(): void {
    if (this.loadingMore() || !this.hasMore()) return;
    this.loadingMore.set(true);
    this.moreNote.set(null);
    const shown = this.lessons();
    const filters = `${this.status()}|${this.source()}`;
    this.api
      .lessons(this.status() || null, this.source() || null, this.pageSize, shown.length)
      .subscribe({
        next: (rows) => {
          this.loadingMore.set(false);
          // The filters changed while this page was on its way: it belongs to another list.
          if (`${this.status()}|${this.source()}` !== filters) return;
          const seen = new Set(shown.map((l) => l.id));
          const fresh = rows.filter((r) => !seen.has(r.id));
          if (rows.length > 0 && fresh.length === 0) {
            // The same page again: an engine that does not take `skip` yet.
            this.hasMore.set(false);
            this.moreNote.set(
              `This engine can only list the newest ${shown.length} lessons; narrow the filters to see older ones.`,
            );
            return;
          }
          this.lessons.set([...shown, ...fresh]);
          this.hasMore.set(rows.length >= this.pageSize);
        },
        error: (e: unknown) => {
          this.loadingMore.set(false);
          this.moreNote.set(errorText(e, 'Could not load more lessons.'));
        },
      });
  }

  setStatus(value: string): void {
    if (this.status() === value) return;
    this.status.set(value);
    this.loading.set(true);
    this.lessons.set([]);
    this.load();
  }

  setSource(value: string): void {
    if (this.source() === value) return;
    this.source.set(value);
    this.loading.set(true);
    this.lessons.set([]);
    this.load();
  }

  open(lesson: AssistantLesson, action: LessonAction): void {
    this.form.set(reviewFormFor(lesson));
    this.submitError.set(null);
    this.tried.set(false);
    this.review.set({ lesson, kind: action.kind, action });
  }

  close(): void {
    if (this.busy()) return;
    this.review.set(null);
  }

  patch(p: Partial<ReviewForm>): void {
    this.form.update((f) => ({ ...f, ...p }));
    this.submitError.set(null);
  }

  submit(): void {
    const r = this.review();
    if (!r || this.busy()) return;
    this.tried.set(true);
    if (this.problem()) return;
    this.busy.set(true);
    this.api
      .review(r.lesson.id, r.action.action, reviewBody(r.kind, this.form(), r.lesson))
      .subscribe({
        next: (updated) => {
          this.busy.set(false);
          this.review.set(null);
          this.notify.success(reviewDoneMessage(r.kind, updated ?? r.lesson));
          this.load();
        },
        error: (e: unknown) => {
          this.busy.set(false);
          this.submitError.set(
            errorText(
              e,
              'The change was not saved: the engine refused it or could not be reached.',
            ),
          );
        },
      });
  }

  protected actionsFor(l: AssistantLesson): LessonAction[] {
    return lessonActions(l.status);
  }
  protected editsTextFor(kind: LessonActionKind): boolean {
    return editsText(kind);
  }
  protected needsReasonFor(kind: LessonActionKind): boolean {
    return needsReason(kind);
  }
  protected tone(status: string): string {
    return statusTone(status);
  }
  protected statusText(status: string): string {
    return statusLabel(status);
  }
  protected scope(l: AssistantLesson): string {
    return scopeLabel(l.scopeKind, l.scopeValue);
  }
  protected sourceText(s: string): string {
    return sourceLabel(s);
  }
  protected person(who: string | null, name?: string | null): string {
    return personLabel(who, name);
  }
  protected scopeHint(kind: string): string {
    return (
      {
        route: 'Page address starts with (e.g. /chart-analysis)',
        tool: 'Tool name (e.g. call_endpoint)',
        operation: 'Operation id (e.g. TradeRecommendation_ArmOco)',
        symbol: 'Symbol (e.g. EURUSD)',
      }[kind] ?? 'Value'
    );
  }
}
