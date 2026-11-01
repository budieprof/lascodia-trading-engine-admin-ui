import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  effect,
  input,
  output,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

/**
 * Confirm step for the self-heal actions (terminal start/stop/restart,
 * update EA, force recovery, the health card's fixes). A native `<dialog>`
 * opened with `showModal()` sits in the browser's top layer, so the page's
 * entry transform cannot misplace it (the `.page > *` modal bug).
 *
 * Focus starts on Cancel: Enter never confirms a live-money action by default.
 */
@Component({
  selector: 'app-ea-action-dialog',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `
    <dialog
      #dlg
      class="dlg"
      [attr.aria-labelledby]="'ea-action-dialog-title'"
      (cancel)="$event.preventDefault(); onCancel()"
    >
      @if (open()) {
        <div class="box" [attr.data-tone]="tone()">
          <h2 id="ea-action-dialog-title">{{ title() }}</h2>
          @for (para of paragraphs(); track $index) {
            <p class="desc">{{ para }}</p>
          }
          @if (warning()) {
            <p class="warning" role="note">{{ warning() }}</p>
          }
          <ng-content />
          @if (askReason()) {
            <label class="field">
              <span>Reason {{ reasonRequired() ? '(required)' : '(optional)' }}</span>
              <textarea
                rows="2"
                [(ngModel)]="reason"
                placeholder="What prompted this? (kept in the audit log)"
              ></textarea>
            </label>
          }
          <footer class="foot">
            @if (showCancel()) {
              <button
                type="button"
                class="btn btn-secondary"
                (click)="onCancel()"
                [disabled]="busy()"
                autofocus
              >
                Cancel
              </button>
            }
            <button
              type="button"
              class="btn"
              [class.btn-primary]="tone() !== 'bad'"
              [class.btn-danger]="tone() === 'bad'"
              (click)="onConfirm()"
              [disabled]="busy() || confirmDisabled() || (reasonRequired() && !reason.trim())"
            >
              {{ busy() ? 'Sending…' : confirmLabel() }}
            </button>
          </footer>
        </div>
      }
    </dialog>
  `,
  styles: [
    `
      .dlg {
        width: min(92vw, 540px);
        max-height: 90vh;
        padding: 0;
        border: none;
        border-radius: var(--radius-lg);
        background: var(--bg-primary);
        color: inherit;
        box-shadow: var(--shadow-lg, 0 10px 30px rgba(0, 0, 0, 0.18));
      }
      .dlg::backdrop {
        background: rgba(0, 0, 0, 0.45);
      }
      .box {
        padding: var(--space-5);
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      h2 {
        margin: 0;
        font-size: var(--text-lg);
        font-weight: var(--font-semibold);
      }
      .desc {
        margin: 0;
        font-size: var(--text-sm);
        color: var(--text-primary);
      }
      .warning {
        margin: 0;
        padding: 10px 12px;
        background: rgba(255, 149, 0, 0.1);
        border-left: 3px solid var(--tone-amber, #ff9500);
        border-radius: var(--radius-sm);
        font-size: var(--text-xs);
        color: var(--text-primary);
      }
      .box[data-tone='bad'] .warning {
        background: rgba(255, 59, 48, 0.08);
        border-left-color: var(--tone-red, #ff3b30);
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .field > span {
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      textarea {
        padding: 6px 10px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-primary);
        color: var(--text-primary);
        font: inherit;
        font-size: var(--text-sm);
        resize: vertical;
      }
      .foot {
        display: flex;
        justify-content: flex-end;
        gap: var(--space-3);
        padding-top: var(--space-2);
        border-top: 1px solid var(--border);
      }
      .btn-danger {
        background: var(--tone-red, #ff3b30);
        color: #fff;
        border: 1px solid transparent;
      }
    `,
  ],
})
export class EaActionDialogComponent {
  readonly open = input(false);
  readonly title = input('Confirm');
  /** Body text; blank lines split paragraphs. */
  readonly description = input('');
  readonly warning = input<string | null>(null);
  readonly confirmLabel = input('Confirm');
  readonly tone = input<'ok' | 'warn' | 'bad'>('warn');
  readonly askReason = input(true);
  readonly reasonRequired = input(false);
  readonly busy = input(false);
  /** Extra gate from projected content (e.g. a typed confirmation). */
  readonly confirmDisabled = input(false);
  /** False for a step whose only button is "Close" (Escape still cancels). */
  readonly showCancel = input(true);

  readonly confirmed = output<string>();
  readonly cancelled = output<void>();

  protected reason = '';
  private readonly dlg = viewChild<ElementRef<HTMLDialogElement>>('dlg');

  protected paragraphs(): string[] {
    return this.description()
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter(Boolean);
  }

  constructor() {
    effect(() => {
      const el = this.dlg()?.nativeElement;
      if (!el) return;
      if (this.open()) {
        this.reason = '';
        if (!el.open) el.showModal?.();
      } else if (el.open) {
        el.close();
      }
    });
  }

  protected onCancel(): void {
    if (this.busy()) return;
    this.cancelled.emit();
  }

  protected onConfirm(): void {
    if (this.busy() || this.confirmDisabled()) return;
    if (this.reasonRequired() && !this.reason.trim()) return;
    this.confirmed.emit(this.reason.trim());
  }
}
