import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';

import {
  MAX_REASON_LENGTH,
  changedFields,
  validateAmendEdits,
  type AmendEdits,
  type AmendField,
} from './approval-resolution';

/** What the operator is sending with their decision. `edits` is null unless they changed values. */
export interface ApprovalComposerResult {
  reason: string | null;
  edits: AmendEdits | null;
}

/**
 * The words that go with a decision on an approval card — and, on a card that binds to an engine
 * operation, the values the operator wants changed before it runs.
 *
 * <p>Rejecting used to be a bare button, and the agent received the single word "rejected": the one
 * thing it needed to act on — what was wrong — was the one thing it never got. So this is deliberately
 * the DEFAULT path rather than a hidden one. Pressing Reject opens this; sending it without writing
 * anything is still possible, but it is the secondary action, spelled out in words.</p>
 *
 * <p>On an approval the same box reads as a condition ("yes, but watch it for a week"), and there the
 * note is plainly optional — the primary button sends with or without it.</p>
 *
 * <p>Purely presentational: it validates what it can see and emits. The host owns the HTTP call, the
 * in-flight flag and the server's message, which is why a refusal never costs the operator what they
 * typed — the composer is not torn down by a failure.</p>
 */
@Component({
  selector: 'app-engineer-approval-composer',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="cmp"
      [attr.data-mode]="mode()"
      role="group"
      [attr.aria-label]="mode() === 'reject' ? 'Reject with a reason' : 'Approve with a note'"
      (keydown)="onKeydown($event)"
    >
      <label class="lbl" [attr.for]="taId">{{
        mode() === 'reject'
          ? 'Why? The engineer will act on this — an instruction is better than a verdict'
          : 'A condition, if any — the engineer reads it the same way'
      }}</label>
      <textarea
        #ta
        class="ta"
        [id]="taId"
        rows="3"
        [attr.maxlength]="MAX"
        [disabled]="busy()"
        [value]="reason()"
        [attr.aria-describedby]="hintId"
        [placeholder]="
          mode() === 'reject'
            ? 'e.g. the stop is inside the spread on this pair — re-propose with 1.2×ATR'
            : 'e.g. yes, but watch it for a week and report the realised slippage'
        "
        (input)="onReason($event)"
      ></textarea>

      @if (canAmend()) {
        <div class="amend">
          @if (!amending()) {
            <button type="button" class="link" [disabled]="busy()" (click)="startAmend()">
              Edit the values first
            </button>
          } @else {
            <div class="amend-head">
              <span class="amend-title">Values on this card</span>
              <button type="button" class="link" [disabled]="busy()" (click)="resetAmend()">
                reset
              </button>
            </div>
            <p class="amend-note">
              Only these values may change — the operation, its target and the account are fixed.
            </p>
            <div class="grid">
              @for (f of fields(); track f.path) {
                <label class="field" [class.changed]="isChanged(f)">
                  <span class="flabel">{{ f.label }}</span>
                  @if (f.kind === 'boolean') {
                    <select
                      class="input"
                      [disabled]="busy()"
                      [value]="valueOf(f)"
                      (change)="onEdit(f, $event)"
                    >
                      <option value="true">true</option>
                      <option value="false">false</option>
                    </select>
                  } @else {
                    <input
                      class="input"
                      [class.mono]="f.kind === 'number'"
                      [type]="f.kind === 'number' ? 'number' : 'text'"
                      step="any"
                      [disabled]="busy()"
                      [value]="valueOf(f)"
                      (input)="onEdit(f, $event)"
                    />
                  }
                  @if (isChanged(f)) {
                    <span class="was">was {{ f.value || '∅' }}</span>
                  }
                </label>
              }
            </div>
          }
        </div>
      }

      @if (validationError(); as ve) {
        <p class="err" role="alert">{{ ve }}</p>
      }
      @if (error(); as e) {
        <p class="err" role="alert">{{ e }}</p>
      }

      <div class="row">
        <button
          type="button"
          class="send"
          [class.reject]="mode() === 'reject'"
          [class.danger]="mode() === 'approve' && live()"
          [disabled]="busy() || !canSend()"
          (click)="send()"
        >
          {{ primaryLabel() }}
        </button>
        <button type="button" class="cancel" [disabled]="busy()" (click)="cancelled.emit()">
          Cancel
        </button>
        @if (mode() === 'reject') {
          <button type="button" class="link bare" [disabled]="busy()" (click)="sendBare()">
            reject without a reason
          </button>
        }
        <span class="count" [class.near]="remaining() < 200">{{ remaining() }}</span>
      </div>
      <p class="hint" [id]="hintId">Enter sends · Shift+Enter for a new line · Esc closes</p>
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .cmp {
        margin-top: 10px;
        padding: 9px 10px;
        border: 1px solid var(--border);
        border-radius: 9px;
        background: var(--bg-secondary);
        display: flex;
        flex-direction: column;
        gap: 7px;
        animation: cmp-in var(--dur-fast, 0.15s) ease-out;
      }
      .cmp[data-mode='reject'] {
        border-color: color-mix(in srgb, var(--loss) 35%, var(--border));
      }
      @keyframes cmp-in {
        from {
          opacity: 0;
          transform: translateY(-2px);
        }
        to {
          opacity: 1;
          transform: none;
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .cmp {
          animation: none;
        }
      }
      .lbl {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        line-height: 1.4;
      }
      .ta {
        font: inherit;
        font-size: var(--text-sm);
        line-height: 1.45;
        width: 100%;
        box-sizing: border-box;
        padding: 7px 9px;
        border: 1px solid var(--border);
        border-radius: 7px;
        background: var(--bg-primary);
        color: var(--text-primary);
        resize: vertical;
      }
      .ta:focus-visible,
      .input:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: 1px;
      }
      .ta:disabled,
      .input:disabled {
        opacity: 0.6;
      }
      .amend {
        display: flex;
        flex-direction: column;
        gap: 5px;
      }
      .amend-head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 8px;
      }
      .amend-title {
        font-size: 10px;
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-secondary);
      }
      .amend-note {
        margin: 0;
        font-size: var(--text-xs);
        color: var(--text-tertiary);
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
        gap: 6px;
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
      }
      .flabel {
        font-size: 10px;
        letter-spacing: 0.03em;
        color: var(--text-tertiary);
        overflow-wrap: anywhere;
      }
      .field.changed .flabel {
        color: var(--accent);
        font-weight: var(--font-semibold);
      }
      .input {
        font: inherit;
        font-size: var(--text-xs);
        width: 100%;
        box-sizing: border-box;
        padding: 4px 6px;
        border: 1px solid var(--border);
        border-radius: 5px;
        background: var(--bg-primary);
        color: var(--text-primary);
      }
      .field.changed .input {
        border-color: var(--accent);
      }
      .mono {
        font-family: var(--font-mono, monospace);
      }
      .was {
        font-size: 10px;
        color: var(--text-tertiary);
        overflow-wrap: anywhere;
      }
      .err {
        margin: 0;
        font-size: var(--text-xs);
        color: color-mix(in srgb, var(--loss) 82%, var(--text-primary));
      }
      .row {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 8px;
      }
      .row button {
        font: inherit;
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
        cursor: pointer;
      }
      .send,
      .cancel {
        padding: 6px 14px;
        border-radius: var(--radius-full);
      }
      .send {
        border: 1px solid var(--accent);
        background: var(--accent);
        color: #fff;
      }
      .send.reject,
      .send.danger {
        border-color: var(--loss);
        background: var(--loss);
      }
      .cancel {
        border: 1px solid var(--border);
        background: var(--bg-primary);
        color: var(--text-secondary);
      }
      .link {
        border: 0;
        background: none;
        padding: 0;
        color: var(--text-secondary);
        text-decoration: underline;
        text-underline-offset: 2px;
      }
      .bare {
        color: var(--text-tertiary);
      }
      .row button:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .count {
        margin-left: auto;
        font-size: 10px;
        color: var(--text-tertiary);
        font-variant-numeric: tabular-nums;
      }
      .count.near {
        color: var(--eng-warn, var(--warning));
      }
      .hint {
        margin: 0;
        font-size: 10px;
        color: var(--text-tertiary);
      }
    `,
  ],
})
export class EngineerApprovalComposerComponent implements AfterViewInit {
  /** Which decision is being composed. Reject makes the note the expected path; approve does not. */
  readonly mode = input.required<'approve' | 'reject'>();
  /** The values this card allows an operator to change. Empty = no amend affordance at all. */
  readonly fields = input<readonly AmendField[]>([]);
  /** The card goes live on approval — the primary button carries the warning colour. */
  readonly live = input(false);
  /** Host-owned in-flight flag. */
  readonly busy = input(false);
  /** The server's message from a failed attempt. Shown without clearing what was typed. */
  readonly error = input<string | null>(null);

  readonly sent = output<ApprovalComposerResult>();
  readonly cancelled = output<void>();

  protected readonly MAX = MAX_REASON_LENGTH;
  /** Unique enough for a thread of cards, and stable for the life of this composer. */
  protected readonly taId = `apc-${Math.random().toString(36).slice(2, 9)}`;
  protected readonly hintId = `${this.taId}-hint`;

  private readonly ta = viewChild<ElementRef<HTMLTextAreaElement>>('ta');

  protected readonly reason = signal('');
  protected readonly amending = signal(false);
  protected readonly edits = signal<Record<string, string>>({});

  /** Approve-with-an-edit only: an amendment IS an approval, and the engine refuses it on a reject. */
  protected readonly canAmend = computed(
    () => this.mode() === 'approve' && this.fields().length > 0,
  );

  protected readonly changed = computed(() =>
    this.amending() ? changedFields(this.fields(), this.edits()) : [],
  );

  protected readonly validationError = computed(() =>
    this.amending() && Object.keys(this.edits()).length > 0
      ? validateAmendEdits(this.fields(), this.edits())
      : null,
  );

  protected readonly remaining = computed(() => this.MAX - this.reason().length);

  /**
   * A rejection needs words to be worth sending — that is the whole point of the composer, and the
   * "reject without a reason" escape below covers the case where there genuinely are none. An
   * approval sends either way; its note is optional.
   */
  protected readonly canSend = computed(() => {
    if (this.validationError() !== null) return false;
    return this.mode() === 'approve' || this.reason().trim().length > 0;
  });

  protected readonly primaryLabel = computed(() => {
    if (this.busy()) return 'Sending…';
    if (this.mode() === 'reject') return 'Send rejection';
    if (this.changed().length > 0) return 'Approve with these values';
    return this.reason().trim() ? 'Approve with note' : 'Approve';
  });

  ngAfterViewInit(): void {
    // The composer opens in response to a click, so the caret belongs in it — an operator who has
    // just pressed Reject should be typing, not hunting for the box.
    this.ta()?.nativeElement.focus();
  }

  protected onReason(ev: Event): void {
    this.reason.set((ev.target as HTMLTextAreaElement).value);
  }

  /**
   * Enter sends, Shift+Enter is a newline, Escape closes — handled here rather than with Angular's
   * `keydown.enter` binding so the rules are explicit and so Escape works from the amend inputs too.
   * Enter only sends from the textarea: pressing it in a value field must not fire the decision.
   */
  protected onKeydown(ev: Event): void {
    const e = ev as KeyboardEvent;
    if (e.key === 'Escape') {
      if (this.busy()) return;
      e.stopPropagation();
      this.cancelled.emit();
      return;
    }
    if (e.key !== 'Enter' || e.shiftKey) return;
    const fromTextarea = (e.target as HTMLElement | null)?.tagName === 'TEXTAREA';
    if (!fromTextarea && !e.metaKey && !e.ctrlKey) return;
    e.preventDefault();
    if (!this.busy() && this.canSend()) this.send();
  }

  protected startAmend(): void {
    this.amending.set(true);
  }

  protected resetAmend(): void {
    this.edits.set({});
  }

  protected valueOf(f: AmendField): string {
    return this.edits()[f.path] ?? f.value;
  }

  protected isChanged(f: AmendField): boolean {
    return this.changed().some((c) => c.path === f.path);
  }

  protected onEdit(f: AmendField, ev: Event): void {
    const value = (ev.target as HTMLInputElement | HTMLSelectElement).value;
    this.edits.update((e) => ({ ...e, [f.path]: value }));
  }

  protected send(): void {
    if (this.busy() || !this.canSend()) return;
    const reason = this.reason().trim();
    const changed = this.changed();
    this.sent.emit({
      reason: reason ? reason : null,
      edits: changed.length > 0 ? this.edits() : null,
    });
  }

  /** The deliberate silent path: a rejection with nothing said is still a valid rejection. */
  protected sendBare(): void {
    if (this.busy()) return;
    this.sent.emit({ reason: null, edits: null });
  }
}
