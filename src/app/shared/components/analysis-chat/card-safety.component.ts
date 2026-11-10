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
} from '@angular/core';
import { DatePipe } from '@angular/common';

import type { SpotAnalysisFollowUpTurnDto } from '@core/api/api.types';
import { MarketDataService } from '@core/services/market-data.service';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';

import {
  ACK_LABEL,
  countdownText,
  errorEnvelope,
  provenanceOf,
  undoFailureText,
  undoOf,
  UNDO_PARTLY_FAILED_CODE,
  whoText,
} from './card-safety';

/**
 * The safety strip of one approval card: where its idea came from (outside text the assistant
 * read — with the acknowledgement tick a high-impact card needs before Approve), and, once the
 * card is confirmed, its undo (button + live countdown, or what happened to the undo).
 *
 * The tick is owned by the host (it gates the host's Approve button); this component only shows
 * it and reports changes. Undo calls the engine itself and hands the refreshed thread back.
 */
@Component({
  selector: 'app-card-safety',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, ConfirmDialogComponent],
  template: `
    @if (prov(); as p) {
      <div class="prov">
        <span class="pill" [title]="p.title" tabindex="0" [attr.aria-label]="p.title"
          >⚠ {{ p.label }}</span
        >
        @if (pending() && p.requiresAck) {
          <label class="ack">
            <input
              type="checkbox"
              [checked]="acknowledged()"
              (change)="ackChange.emit($any($event.target).checked)"
            />
            <span>{{ ackLabel }}</span>
          </label>
        }
      </div>
    }
    @if (refusal(); as r) {
      <p class="bad refusal" role="alert">{{ r }}</p>
    }
    @if (undo(); as u) {
      <div class="undo" [attr.data-kind]="u.kind">
        @switch (u.kind) {
          @case ('offer') {
            <button type="button" class="undo-btn" [disabled]="busy()" (click)="openUndo()">
              ↶ {{ u.label }}
            </button>
            @if (u.remainingMs !== null) {
              <span
                class="muted"
                [title]="'Undo is possible until ' + (u.expiresAt | date: 'HH:mm:ss')"
              >
                {{ countdown(u.remainingMs) }}
              </span>
            }
          }
          @case ('expired') {
            <span class="muted">The undo window for this change has passed.</span>
          }
          @case ('running') {
            <span class="muted"><span class="spinner"></span> Undoing…</span>
          }
          @case ('done') {
            <span class="done"
              >↶ Undone
              @if (u.at) {
                at {{ u.at | date: 'HH:mm:ss' }}
              }
              by {{ who(u.by) }}</span
            >
            @if (u.reason) {
              <span class="muted"> — “{{ u.reason }}”</span>
            }
          }
          @case ('failed') {
            <span class="bad">The undo did not complete{{ u.error ? ': ' + u.error : '.' }}</span>
          }
          @case ('none') {
            <span class="muted small">{{ noneText(u.reason) }}</span>
          }
        }
        @if (error(); as e) {
          <div class="bad" role="alert">{{ e }}</div>
        }
      </div>
    }

    <app-confirm-dialog
      [open]="confirming()"
      [title]="'Undo this change?'"
      [message]="dialogMessage()"
      confirmLabel="Undo it"
      confirmVariant="destructive"
      [loading]="busy()"
      (confirm)="submitUndo()"
      (cancelled)="confirming.set(false)"
    >
      <label class="reason">
        <span>Why (optional — kept with the undo and in the audit log)</span>
        <textarea
          rows="2"
          maxlength="2000"
          [value]="reason()"
          (input)="reason.set($any($event.target).value)"
        ></textarea>
      </label>
    </app-confirm-dialog>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .prov {
        margin: 0 0 var(--space-2);
        font-size: var(--text-xs);
      }
      .pill {
        display: inline-block;
        padding: 1px 8px;
        border-radius: 9px;
        border: 1px solid color-mix(in srgb, var(--warning) 55%, transparent);
        background: color-mix(in srgb, var(--warning) 10%, transparent);
        color: var(--warning);
        cursor: help;
      }
      .ack {
        display: flex;
        gap: 6px;
        align-items: flex-start;
        margin-top: 6px;
        color: var(--text-primary);
        cursor: pointer;
      }
      .ack input {
        margin-top: 2px;
      }
      .undo {
        display: flex;
        flex-wrap: wrap;
        gap: 4px 10px;
        align-items: center;
        margin-top: var(--space-2);
        font-size: var(--text-xs);
      }
      .undo-btn {
        border: 1px solid var(--border);
        background: var(--bg-tertiary);
        color: var(--text-primary);
        border-radius: var(--radius-sm);
        padding: 3px 10px;
        font-size: var(--text-xs);
        cursor: pointer;
      }
      .undo-btn:disabled {
        opacity: 0.6;
        cursor: default;
      }
      .muted {
        color: var(--text-tertiary);
      }
      .done {
        color: var(--text-secondary);
      }
      .bad {
        color: var(--loss);
        width: 100%;
      }
      .refusal {
        margin: 0 0 var(--space-2);
        font-size: var(--text-xs);
      }
      .spinner {
        display: inline-block;
        width: 9px;
        height: 9px;
        border: 2px solid var(--border);
        border-top-color: var(--accent);
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
        vertical-align: -1px;
      }
      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }
      .reason {
        display: flex;
        flex-direction: column;
        gap: 4px;
        font-size: var(--text-sm);
        color: var(--text-secondary);
      }
      .reason textarea {
        font: inherit;
        padding: 6px;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        color: var(--text-primary);
      }
    `,
  ],
})
export class CardSafetyComponent {
  private readonly marketData = inject(MarketDataService);

  readonly turn = input.required<SpotAnalysisFollowUpTurnDto>();
  /** The host's acknowledgement tick for this card. */
  readonly acknowledged = input(false);
  /** The host's last refusal of this card (e.g. the engine's -23), shown under it. */
  readonly refusal = input<string | null>(null);
  readonly ackChange = output<boolean>();
  /** The undo answered with the refreshed thread. */
  readonly threadChanged = output<SpotAnalysisFollowUpTurnDto[]>();
  /** The undo partly ran (-25): the card's record changed, so the host should re-read the thread. */
  readonly reload = output<void>();

  protected readonly ackLabel = ACK_LABEL;
  protected readonly now = signal(Date.now());
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly confirming = signal(false);
  protected readonly reason = signal('');

  protected readonly pending = computed(
    () => (this.turn().actionStatus ?? 'Pending').toLowerCase() === 'pending',
  );
  protected readonly prov = computed(() => provenanceOf(this.turn().toolArgsJson));
  protected readonly undo = computed(() => undoOf(this.turn(), this.now()));
  protected readonly dialogMessage = computed(() => {
    const u = this.undo();
    return u && u.kind === 'offer'
      ? `${u.label}. The engine puts things back the way they were before this card ran, and refuses if they have changed since.`
      : '';
  });

  private timer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Tick once a second only while an undo is on offer, so the countdown (and the expiry) is live.
    effect(() => {
      const offering = undoOf(this.turn(), Date.now())?.kind === 'offer';
      if (offering && !this.timer) {
        this.timer = setInterval(() => this.now.set(Date.now()), 1000);
      } else if (!offering && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    });
    inject(DestroyRef).onDestroy(() => {
      if (this.timer) clearInterval(this.timer);
    });
  }

  protected countdown(ms: number | null): string {
    return countdownText(ms);
  }

  protected who(by: string | null): string {
    return whoText(by);
  }

  protected noneText(reason: string): string {
    return /^no undo/i.test(reason) ? reason : `No undo for this change: ${reason}`;
  }

  protected openUndo(): void {
    this.error.set(null);
    this.reason.set('');
    this.confirming.set(true);
  }

  protected submitUndo(): void {
    if (this.busy()) return;
    const t = this.turn();
    this.busy.set(true);
    this.error.set(null);
    this.marketData.undoFollowUpAction(t.id, this.reason()).subscribe({
      next: (res) => {
        this.busy.set(false);
        this.confirming.set(false);
        if (res?.status && res.data) this.threadChanged.emit(res.data);
        else {
          this.error.set(undoFailureText(res?.responseCode, res?.message));
          if (res?.responseCode === UNDO_PARTLY_FAILED_CODE) this.reload.emit();
        }
      },
      error: (err: unknown) => {
        this.busy.set(false);
        this.confirming.set(false);
        const e = errorEnvelope(err);
        this.error.set(undoFailureText(e.code, e.message));
        if (e.code === UNDO_PARTLY_FAILED_CODE) this.reload.emit();
      },
    });
  }
}
