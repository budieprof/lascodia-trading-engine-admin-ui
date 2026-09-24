import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';

import { matchesConfirmation } from './execution.model';

let nextDialogUid = 0;

/**
 * A confirmation dialog for live-capital changes. With `expected` phrases set, the confirm button
 * stays disabled until the operator types one of them (an account number or name); with none it
 * is a plain confirm that still spells the consequence out.
 *
 * Modal semantics: `alertdialog`, focus moves in on open (the phrase field, else Cancel — the
 * safe choice) and back to the opener on close, Tab cycles inside, Escape cancels.
 */
@Component({
  selector: 'app-typed-confirm-dialog',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (open()) {
      <div class="overlay" role="presentation" (click)="cancel()">
        <div
          class="dialog"
          role="alertdialog"
          aria-modal="true"
          [attr.aria-labelledby]="uid + '-title'"
          [attr.aria-describedby]="uid + '-body'"
          [attr.data-tone]="tone()"
          (click)="$event.stopPropagation()"
          (keydown)="onKeydown($event)"
        >
          <h3 class="title" [id]="uid + '-title'">{{ title() }}</h3>
          <div class="body" [id]="uid + '-body'">
            <p class="message">{{ message() }}</p>
            @if (details().length > 0) {
              <ul class="details">
                @for (d of details(); track $index) {
                  <li>{{ d }}</li>
                }
              </ul>
            }
          </div>
          @if (requireTyping()) {
            <label class="field">
              <span class="field-label">{{ promptLabel() }}</span>
              <input
                class="phrase"
                type="text"
                autocomplete="off"
                spellcheck="false"
                [value]="typed()"
                [attr.aria-invalid]="typed() !== '' && !matches()"
                (input)="typed.set($any($event.target).value)"
                (keydown.enter)="confirm()"
              />
            </label>
            @if (typed() !== '' && !matches()) {
              <p class="mismatch" role="status">That does not match yet.</p>
            }
          }
          <div class="actions">
            <button type="button" class="btn secondary" [disabled]="busy()" (click)="cancel()">
              Cancel
            </button>
            <button
              type="button"
              class="btn confirm"
              [class.danger]="tone() === 'danger'"
              [disabled]="!matches() || busy()"
              (click)="confirm()"
            >
              {{ busy() ? 'Working…' : confirmLabel() }}
            </button>
          </div>
        </div>
      </div>
    }
  `,
  styles: [
    `
      .overlay {
        position: fixed;
        inset: 0;
        z-index: 1000;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: var(--space-4);
        background: var(--backdrop-scrim, rgba(0, 0, 0, 0.4));
        backdrop-filter: blur(6px);
      }
      .dialog {
        width: min(520px, 100%);
        max-height: calc(100vh - 32px);
        overflow: auto;
        padding: var(--space-5) var(--space-6);
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-lg);
        box-shadow: var(--shadow-lg);
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .dialog[data-tone='danger'] {
        border-top: 4px solid var(--loss);
      }
      .title {
        margin: 0;
        font-size: var(--text-lg);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
      }
      .message {
        margin: 0;
        font-size: var(--text-sm);
        line-height: 1.5;
        color: var(--text-primary);
      }
      .details {
        list-style: disc;
        margin: var(--space-2) 0 0;
        padding-left: var(--space-5);
        font-size: var(--text-sm);
        line-height: 1.5;
        color: var(--text-secondary);
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
      .phrase {
        height: 36px;
        padding: 0 var(--space-3);
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-secondary);
        color: var(--text-primary);
        font: inherit;
        font-family: 'SF Mono', 'Fira Code', monospace;
      }
      .phrase[aria-invalid='true'] {
        border-color: var(--warning);
      }
      .mismatch {
        margin: 0;
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .actions {
        display: flex;
        justify-content: flex-end;
        gap: var(--space-2);
        margin-top: var(--space-2);
      }
      .btn {
        height: 36px;
        padding: 0 var(--space-5);
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
    `,
  ],
})
export class TypedConfirmDialogComponent {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly open = input(false);
  readonly title = input('Confirm');
  readonly message = input('');
  readonly details = input<readonly string[]>([]);
  /** Phrases the operator may type to confirm; empty = no typing required. */
  readonly expected = input<readonly string[]>([]);
  readonly promptLabel = input('Type to confirm');
  readonly confirmLabel = input('Confirm');
  readonly tone = input<'danger' | 'primary'>('danger');
  readonly busy = input(false);

  readonly confirmed = output<void>();
  readonly cancelled = output<void>();

  readonly uid = `tcd-${nextDialogUid++}`;
  readonly typed = signal('');
  readonly requireTyping = computed(() => this.expected().length > 0);
  readonly matches = computed(
    () => !this.requireTyping() || matchesConfirmation(this.typed(), this.expected()),
  );

  private opener: HTMLElement | null = null;

  constructor() {
    effect(() => {
      const isOpen = this.open();
      untracked(() => {
        if (isOpen) {
          this.typed.set('');
          this.opener =
            typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
              ? document.activeElement
              : null;
          setTimeout(() => this.focusInitial());
        } else if (this.opener) {
          const back = this.opener;
          this.opener = null;
          setTimeout(() => back.focus?.());
        }
      });
    });
  }

  confirm(): void {
    if (!this.matches() || this.busy()) return;
    this.confirmed.emit();
  }

  cancel(): void {
    if (this.busy()) return;
    this.cancelled.emit();
  }

  onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.cancel();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusables = this.focusables();
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  private focusables(): HTMLElement[] {
    return [
      ...this.host.nativeElement.querySelectorAll<HTMLElement>(
        '.dialog input:not([disabled]), .dialog button:not([disabled])',
      ),
    ];
  }

  private focusInitial(): void {
    const root = this.host.nativeElement;
    const target =
      root.querySelector<HTMLElement>('.dialog .phrase') ??
      root.querySelector<HTMLElement>('.dialog .btn.secondary');
    target?.focus();
  }
}
