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

import { NotificationService } from '@core/notifications/notification.service';

import { StrategyExecutionApiService } from '../api/strategy-execution-api.service';
import type { ExecutionPolicy } from '../api/scripting-api.types';
import { describeFailure, isOk } from '../shared/api-error';
import {
  DIRECT_KEEPS,
  DIRECT_SKIPS,
  EXITS_NEVER_BLOCKED,
  POLICY_DESCRIPTIONS,
} from './execution.model';
import { TypedConfirmDialogComponent } from './typed-confirm-dialog.component';

const POLICIES: readonly ExecutionPolicy[] = ['Standard', 'Direct'];

let nextPolicyUid = 0;

/**
 * The strategy's execution policy (ADR-0027 DEC-06) — which signal-pipeline gates its entries
 * pass — with a plain-language account of what Direct skips and what it keeps. Switching asks for
 * confirmation first; the card only shows the new policy once the engine has accepted it.
 */
@Component({
  selector: 'app-execution-policy-card',
  standalone: true,
  imports: [TypedConfirmDialogComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card" [attr.aria-labelledby]="uid + '-title'">
      <header>
        <h3 class="card-title" [id]="uid + '-title'">Execution policy</h3>
        <p class="card-sub">
          Which gates this strategy's entries must pass before they reach an account.
          @if (current() === null) {
            <strong>The engine did not report this strategy's policy.</strong>
          }
        </p>
      </header>

      <div class="options">
        @for (p of policies; track p) {
          <div class="option" [class.current]="current() === p" [attr.data-policy]="p">
            <div class="option-head">
              <span class="option-title">{{ describe(p).title }}</span>
              @if (current() === p) {
                <span class="badge">Current</span>
              } @else {
                <button type="button" class="btn" [disabled]="saving()" (click)="requestChange(p)">
                  {{ current() === null ? 'Set' : 'Switch to' }} {{ describe(p).title }}…
                </button>
              }
            </div>
            <p class="option-summary">{{ describe(p).summary }}</p>
          </div>
        }
      </div>

      <div class="lists">
        <div>
          <h4 class="list-title">Direct skips</h4>
          <ul>
            @for (s of skips; track s) {
              <li>{{ s }}</li>
            }
          </ul>
        </div>
        <div>
          <h4 class="list-title">Direct keeps (Standard applies these too)</h4>
          <ul>
            @for (k of keeps; track k) {
              <li>{{ k }}</li>
            }
          </ul>
        </div>
      </div>
      <p class="exits">{{ exitsNote }}</p>

      @if (error()) {
        <p class="error" role="alert">{{ error() }}</p>
      }
    </section>

    <app-typed-confirm-dialog
      [open]="pendingPolicy() !== null"
      [title]="'Switch to ' + (pendingPolicy() ?? '') + '?'"
      [message]="confirmMessage()"
      [details]="confirmDetails()"
      [confirmLabel]="'Switch to ' + (pendingPolicy() ?? '')"
      [tone]="pendingPolicy() === 'Direct' ? 'danger' : 'primary'"
      [busy]="saving()"
      (confirmed)="applyChange()"
      (cancelled)="pendingPolicy.set(null)"
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
        gap: var(--space-4);
      }
      .card-title {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .card-sub {
        margin: 2px 0 0;
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .options {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr));
        gap: var(--space-3);
      }
      .option {
        padding: var(--space-4);
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-primary);
      }
      .option.current {
        border-color: var(--accent);
        box-shadow: inset 0 0 0 1px var(--accent);
      }
      .option-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-2);
      }
      .option-title {
        font-weight: var(--font-semibold);
      }
      .option-summary {
        margin: var(--space-2) 0 0;
        font-size: var(--text-sm);
        color: var(--text-secondary);
        line-height: 1.45;
      }
      .badge {
        padding: 2px 8px;
        border-radius: var(--radius-full);
        background: var(--accent);
        color: #fff;
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
      }
      .lists {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr));
        gap: var(--space-4);
      }
      .list-title {
        margin: 0 0 var(--space-1);
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-secondary);
      }
      ul {
        margin: 0;
        padding-left: var(--space-5);
        font-size: var(--text-sm);
        line-height: 1.5;
      }
      .exits {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
      }
      .btn {
        height: 30px;
        padding: 0 var(--space-3);
        border-radius: var(--radius-full);
        border: 1px solid var(--border);
        background: var(--bg-secondary);
        color: var(--text-primary);
        font: inherit;
        font-size: var(--text-xs);
        cursor: pointer;
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
export class ExecutionPolicyCardComponent {
  private readonly api = inject(StrategyExecutionApiService);
  private readonly notifications = inject(NotificationService);

  readonly strategyId = input.required<number>();
  /** The policy the engine reported; null when it did not. */
  readonly policy = input<ExecutionPolicy | null>(null);
  readonly isScript = input(false);

  readonly policyChanged = output<ExecutionPolicy>();

  readonly uid = `policy-${nextPolicyUid++}`;
  readonly policies = POLICIES;
  readonly skips = DIRECT_SKIPS;
  readonly keeps = DIRECT_KEEPS;
  readonly exitsNote = EXITS_NEVER_BLOCKED;

  /** What the engine last confirmed (the input, then any change this card applied). */
  readonly current = signal<ExecutionPolicy | null>(null);
  readonly pendingPolicy = signal<ExecutionPolicy | null>(null);
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);

  readonly confirmMessage = computed(() => {
    const p = this.pendingPolicy();
    if (p === 'Direct') {
      return 'New entries will skip the discretionary filters and pass only the hard safety and risk gates — live trading follows the script the way the backtest did.';
    }
    if (p === 'Standard') {
      return this.isScript()
        ? 'New entries will also pass every discretionary filter. Live trading can then diverge from the backtest: entries the script takes may be filtered out.'
        : 'New entries will pass every gate in the signal pipeline, the discretionary filters included.';
    }
    return '';
  });

  readonly confirmDetails = computed<string[]>(() => {
    const p = this.pendingPolicy();
    if (!p) return [];
    const details =
      p === 'Direct'
        ? [`Skipped: ${DIRECT_SKIPS.join('; ')}.`, `Still enforced: ${DIRECT_KEEPS.join('; ')}.`]
        : ['Every discretionary filter and every hard gate applies.'];
    return [
      ...details,
      EXITS_NEVER_BLOCKED,
      'Takes effect on the next signal; open positions are not touched.',
    ];
  });

  constructor() {
    effect(() => {
      const p = this.policy();
      untracked(() => {
        this.current.set(p);
        this.error.set(null);
      });
    });
  }

  describe(p: ExecutionPolicy) {
    return POLICY_DESCRIPTIONS[p];
  }

  requestChange(p: ExecutionPolicy): void {
    if (this.saving() || p === this.current()) return;
    this.error.set(null);
    this.pendingPolicy.set(p);
  }

  applyChange(): void {
    const p = this.pendingPolicy();
    if (!p || this.saving()) return;
    this.saving.set(true);
    this.api.setExecutionPolicy(this.strategyId(), p).subscribe({
      next: (res) => {
        this.saving.set(false);
        this.pendingPolicy.set(null);
        if (!isOk(res)) {
          this.error.set(describeFailure(res, 'The engine did not change the policy.'));
          return;
        }
        this.current.set(p);
        this.notifications.success(`Execution policy set to ${p}`);
        this.policyChanged.emit(p);
      },
      error: (err: unknown) => {
        this.saving.set(false);
        this.pendingPolicy.set(null);
        this.error.set(describeFailure(err, 'Changing the policy failed.'));
      },
    });
  }
}
