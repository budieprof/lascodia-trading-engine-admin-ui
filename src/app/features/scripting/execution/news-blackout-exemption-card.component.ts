import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';

import {
  NEWS_BLACKOUT_EXEMPT_REASON_MAX,
  NEWS_BLACKOUT_EXEMPT_REASON_MIN,
} from '@core/api/api.types';
import { NotificationService } from '@core/notifications/notification.service';
import { StrategiesService } from '@core/services/strategies.service';

import { describeFailure, isOk } from '../shared/api-error';
import {
  BLACKOUT_EXPLAINER,
  EXEMPTION_EFFECT,
  GRANT_DETAILS,
  REVOKE_DETAILS,
  exemptionReasonProblem,
  exemptionUpdateRequest,
} from './news-blackout-exemption.model';
import { TypedConfirmDialogComponent } from './typed-confirm-dialog.component';

let nextExemptionUid = 0;

/**
 * A script strategy's opt-out of the engine's high-impact news blackout (engine
 * `Strategy.NewsBlackoutExempt`). The switch shows the state the engine last confirmed; flipping it
 * opens a pending change — a grant needs a reason of at least ten characters, a revoke takes an
 * optional one — and nothing is sent until the operator reviews and confirms what the change does.
 * The card only shows the new state once the engine has accepted it (`PUT strategy/{id}`).
 */
@Component({
  selector: 'app-news-blackout-exemption-card',
  standalone: true,
  imports: [TypedConfirmDialogComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section
      class="card"
      [attr.aria-labelledby]="uid + '-title'"
      [attr.data-state]="saved() ? 'exempt' : 'applies'"
    >
      <header>
        <h3 class="card-title" [id]="uid + '-title'">News-blackout exemption</h3>
        <p class="card-sub">{{ explainer }}</p>
      </header>

      <div class="state-row">
        <button
          type="button"
          role="switch"
          class="switch"
          data-testid="exemption-switch"
          [attr.aria-checked]="shown()"
          [attr.aria-describedby]="uid + '-state'"
          [disabled]="saving() || readOnly()"
          [title]="readOnly() ? 'Changing the exemption needs operator access' : ''"
          (click)="toggle()"
        >
          <span class="track" aria-hidden="true"><span class="thumb"></span></span>
          <span class="switch-label">Exempt from the news blackout</span>
        </button>
        @if (draft() !== null) {
          <span class="pending-tag" data-testid="exemption-unsaved">Not saved</span>
        }
      </div>

      <p
        class="state-line"
        [id]="uid + '-state'"
        data-testid="exemption-state"
        [attr.data-state]="saved() ? 'exempt' : 'applies'"
      >
        @if (saved()) {
          <strong>Exempt.</strong> The engine lets this strategy’s entries through inside the window
          — live, paper, backtests and the EA’s own blackout.
        } @else {
          <strong>Not exempt.</strong> The blackout applies to this strategy’s entries like any
          other’s.
        }
      </p>

      @if (draft() === true) {
        <div class="pending" data-testid="exemption-pending">
          <label class="field">
            <span class="field-label">
              Why is this strategy designed to trade around releases?
              <span class="required">(required)</span>
            </span>
            <textarea
              class="reason"
              rows="3"
              data-testid="exemption-reason"
              [attr.maxlength]="reasonMax"
              [attr.aria-invalid]="showProblem()"
              [attr.aria-describedby]="uid + '-hint'"
              [value]="reason()"
              (input)="reason.set($any($event.target).value)"
            ></textarea>
            <span class="hint" [id]="uid + '-hint'" [class.problem]="showProblem()">
              {{ showProblem() ? problem() : grantHint }}
            </span>
          </label>
          <div class="actions">
            <button type="button" class="btn secondary" [disabled]="saving()" (click)="cancel()">
              Cancel
            </button>
            <button
              type="button"
              class="btn confirm danger"
              data-testid="exemption-review"
              [disabled]="!!problem() || saving()"
              (click)="review()"
            >
              Review grant…
            </button>
          </div>
        </div>
      } @else if (draft() === false) {
        <div class="pending" data-testid="exemption-pending">
          <label class="field">
            <span class="field-label">Why revoke it? <span class="optional">(optional)</span></span>
            <textarea
              class="reason"
              rows="2"
              data-testid="exemption-reason"
              [attr.maxlength]="reasonMax"
              [attr.aria-invalid]="showProblem()"
              [attr.aria-describedby]="uid + '-hint'"
              [value]="reason()"
              (input)="reason.set($any($event.target).value)"
            ></textarea>
            <span class="hint" [id]="uid + '-hint'" [class.problem]="showProblem()">
              {{ showProblem() ? problem() : 'Recorded on the audit row.' }}
            </span>
          </label>
          <div class="actions">
            <button type="button" class="btn secondary" [disabled]="saving()" (click)="cancel()">
              Cancel
            </button>
            <button
              type="button"
              class="btn confirm"
              data-testid="exemption-review"
              [disabled]="!!problem() || saving()"
              (click)="review()"
            >
              Review revoke…
            </button>
          </div>
        </div>
      }

      @if (error()) {
        <p class="error" role="alert">{{ error() }}</p>
      }
    </section>

    <app-typed-confirm-dialog
      [open]="confirmOpen()"
      [title]="
        draft()
          ? 'Exempt this strategy from the news blackout?'
          : 'Restore the news blackout for this strategy?'
      "
      [message]="confirmMessage()"
      [details]="confirmDetails()"
      [confirmLabel]="draft() ? 'Grant exemption' : 'Revoke exemption'"
      [tone]="draft() ? 'danger' : 'primary'"
      [busy]="saving()"
      (confirmed)="save()"
      (cancelled)="confirmOpen.set(false)"
    />
  `,
  styles: [
    `
      .card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-5);
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .card[data-state='exempt'] {
        border-color: rgba(255, 149, 0, 0.55);
      }
      .card-title {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .card-sub {
        margin: 2px 0 0;
        font-size: var(--text-xs);
        line-height: 1.5;
        color: var(--text-secondary);
      }
      .state-row {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: var(--space-3);
      }
      .switch {
        display: inline-flex;
        align-items: center;
        gap: var(--space-2);
        padding: 0;
        border: 0;
        background: none;
        color: var(--text-primary);
        font: inherit;
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        cursor: pointer;
      }
      .switch:disabled {
        opacity: 0.45;
        cursor: not-allowed;
      }
      .switch:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: 3px;
        border-radius: var(--radius-sm);
      }
      .track {
        position: relative;
        width: 36px;
        height: 20px;
        flex: none;
        border-radius: var(--radius-full);
        background: var(--bg-tertiary);
        border: 1px solid var(--border);
        transition: background 0.15s ease;
      }
      .thumb {
        position: absolute;
        top: 2px;
        left: 2px;
        width: 14px;
        height: 14px;
        border-radius: 50%;
        background: var(--text-secondary);
        transition:
          transform 0.15s ease,
          background 0.15s ease;
      }
      .switch[aria-checked='true'] .track {
        background: var(--warning);
        border-color: var(--warning);
      }
      .switch[aria-checked='true'] .thumb {
        transform: translateX(16px);
        background: #fff;
      }
      .pending-tag {
        padding: 2px 8px;
        border-radius: var(--radius-full);
        border: 1px dashed var(--border);
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .state-line {
        margin: 0;
        font-size: var(--text-sm);
        line-height: 1.5;
        color: var(--text-primary);
      }
      .pending {
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
        padding: var(--space-4);
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-primary);
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: var(--space-1);
      }
      .field-label {
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        color: var(--text-primary);
      }
      .required,
      .optional {
        font-weight: var(--font-regular);
        color: var(--text-secondary);
      }
      .reason {
        min-height: 60px;
        padding: var(--space-2) var(--space-3);
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-secondary);
        color: var(--text-primary);
        font: inherit;
        font-size: var(--text-sm);
        resize: vertical;
      }
      .reason[aria-invalid='true'] {
        border-color: var(--warning);
      }
      .reason:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: 1px;
      }
      .hint {
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .hint.problem {
        color: var(--warning);
      }
      .actions {
        display: flex;
        justify-content: flex-end;
        gap: var(--space-2);
      }
      .btn {
        height: 32px;
        padding: 0 var(--space-4);
        border-radius: var(--radius-full);
        border: 1px solid transparent;
        font: inherit;
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        cursor: pointer;
      }
      .btn.secondary {
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }
      .btn.confirm {
        background: var(--accent);
        color: #fff;
      }
      .btn.confirm.danger {
        background: var(--loss);
      }
      .btn:disabled {
        opacity: 0.45;
        cursor: not-allowed;
      }
      .btn:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: 2px;
      }
      .error {
        margin: 0;
        padding: var(--space-2) var(--space-3);
        border-radius: var(--radius-sm);
        background: rgba(255, 59, 48, 0.08);
        color: var(--loss);
        font-size: var(--text-sm);
      }
    `,
  ],
})
export class NewsBlackoutExemptionCardComponent {
  private readonly strategies = inject(StrategiesService);
  private readonly notifications = inject(NotificationService);

  readonly strategyId = input.required<number>();
  readonly strategyName = input<string | null>(null);
  /** Whether the engine reports the strategy exempt. */
  readonly exempt = input(false);
  /** Without operator access the exemption is shown, not changed (PE-I13). */
  readonly readOnly = input(false);

  /** The engine accepted a change — the new exemption state. */
  readonly changed = output<boolean>();

  readonly uid = `nbx-${nextExemptionUid++}`;
  readonly explainer = BLACKOUT_EXPLAINER;
  readonly reasonMax = NEWS_BLACKOUT_EXEMPT_REASON_MAX;
  readonly grantHint = `At least ${NEWS_BLACKOUT_EXEMPT_REASON_MIN} characters — recorded, with your name, on the audit row.`;

  /** What the engine last confirmed (the input, then any change this card applied). */
  readonly saved = signal(false);
  /** The pending change: true = grant, false = revoke, null = none. */
  readonly draft = signal<boolean | null>(null);
  readonly reason = signal('');
  readonly confirmOpen = signal(false);
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);

  /** What the switch shows: the pending change when there is one, else the saved state. */
  readonly shown = computed(() => this.draft() ?? this.saved());

  readonly problem = computed(() => {
    const grant = this.draft();
    return grant === null ? null : exemptionReasonProblem(grant, this.reason());
  });
  /** Say what is wrong once the operator has typed something (an empty field just shows the hint). */
  readonly showProblem = computed(() => !!this.problem() && this.reason().trim() !== '');

  readonly confirmMessage = computed(() =>
    this.draft()
      ? EXEMPTION_EFFECT
      : 'This strategy’s live, paper and backtest entries will again be refused inside the engine’s high-impact news window.',
  );

  readonly confirmDetails = computed<string[]>(() => {
    const grant = this.draft();
    if (grant === null) return [];
    const why = this.reason().trim();
    return grant
      ? [...GRANT_DETAILS, `Reason: “${why}”`]
      : [...REVOKE_DETAILS, why ? `Reason: “${why}”` : 'No reason given.'];
  });

  constructor() {
    // Another strategy: drop anything pending for the previous one.
    effect(() => {
      this.strategyId();
      untracked(() => this.reset());
    });
    effect(() => {
      const exempt = this.exempt();
      untracked(() => {
        this.saved.set(exempt);
        // A pending change the engine now already reports is moot.
        if (this.draft() === exempt) this.reset();
      });
    });
  }

  /** Flip the switch: open a pending change, or abandon the one that is open. */
  toggle(): void {
    if (this.saving()) return;
    if (this.draft() !== null) {
      this.reset();
      return;
    }
    this.error.set(null);
    this.reason.set('');
    this.draft.set(!this.saved());
  }

  cancel(): void {
    if (this.saving()) return;
    this.reset();
  }

  review(): void {
    if (this.draft() === null || this.problem() || this.saving()) return;
    this.error.set(null);
    this.confirmOpen.set(true);
  }

  save(): void {
    const grant = this.draft();
    if (grant === null || this.problem() || this.saving()) return;
    this.saving.set(true);
    const name = this.strategyName() || `strategy #${this.strategyId()}`;
    this.strategies
      .update(this.strategyId(), exemptionUpdateRequest(grant, this.reason()), { silent: true })
      .subscribe({
        next: (res) => {
          this.saving.set(false);
          this.confirmOpen.set(false);
          if (!isOk(res)) {
            this.fail(describeFailure(res, 'The engine did not change the exemption.'));
            return;
          }
          this.saved.set(grant);
          this.reset();
          this.notifications.success(
            grant
              ? `News-blackout exemption granted for ${name}`
              : `News-blackout exemption revoked for ${name} — the blackout applies again`,
          );
          this.changed.emit(grant);
        },
        error: (err: unknown) => {
          this.saving.set(false);
          this.confirmOpen.set(false);
          this.fail(describeFailure(err, 'Changing the exemption failed.'));
        },
      });
  }

  /** Keep the pending change (and its reason) so the operator can correct it and retry. */
  private fail(message: string): void {
    this.error.set(message);
    this.notifications.error(message);
  }

  private reset(): void {
    this.draft.set(null);
    this.reason.set('');
    this.confirmOpen.set(false);
    this.error.set(null);
  }
}
