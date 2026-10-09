import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  output,
  signal,
  viewChild,
} from '@angular/core';

import { ScriptDiffComponent } from './script-diff.component';

export type ScriptDialogTone = 'primary' | 'danger' | 'neutral';

export interface ScriptDialogChoice<T extends string = string> {
  id: T;
  label: string;
  tone?: ScriptDialogTone;
  /** This choice needs the text field filled in (e.g. "Save as a new name"). */
  needsText?: boolean;
}

export interface ScriptDialogCompare {
  before: string;
  after: string;
  beforeLabel: string;
  afterLabel: string;
  beforeInputs?: Readonly<Record<string, unknown>> | null;
  afterInputs?: Readonly<Record<string, unknown>> | null;
  beforeName?: string | null;
  afterName?: string | null;
}

export interface ScriptDialogOptions<T extends string = string> {
  title: string;
  message: string;
  details?: readonly string[];
  choices: readonly ScriptDialogChoice<T>[];
  /** The button that closes without choosing (Escape and the backdrop do the same). */
  cancelLabel?: string;
  /** A text field whose value comes back with the choice (a new name, a note). */
  field?: { label: string; value: string; placeholder?: string; maxLength?: number };
  /** Two versions side by side (save conflicts, overwrites). */
  compare?: ScriptDialogCompare;
  /** A red top edge: the choice can lose work or touch live trading. */
  tone?: 'primary' | 'danger';
}

export interface ScriptDialogResult<T extends string = string> {
  /** Null when the dialog was cancelled (button, Escape or backdrop). */
  choice: T | null;
  text: string;
}

let nextUid = 0;

/**
 * The dialog behind {@link ScriptDialogService}: a native `<dialog>` opened with `showModal()`, so
 * it sits in the browser's top layer above every page, drawer and modal (no transformed ancestor
 * can trap it), traps focus and closes on Escape. Emits exactly one result.
 */
@Component({
  selector: 'app-script-choice-dialog',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ScriptDiffComponent],
  template: `
    @if (options(); as o) {
      <dialog
        #dlg
        class="scd"
        [class.is-wide]="!!o.compare"
        [attr.data-tone]="o.tone ?? 'primary'"
        [attr.aria-labelledby]="uid + '-title'"
        [attr.aria-describedby]="uid + '-message'"
        (cancel)="onCancel($event)"
        (click)="onBackdrop($event)"
      >
        <div class="scd-body">
          <h3 class="scd-title" [id]="uid + '-title'">{{ o.title }}</h3>
          <p class="scd-message" [id]="uid + '-message'">{{ o.message }}</p>
          @if (o.details?.length) {
            <ul class="scd-details">
              @for (d of o.details; track $index) {
                <li>{{ d }}</li>
              }
            </ul>
          }
          @if (o.compare; as c) {
            <app-script-diff
              [before]="c.before"
              [after]="c.after"
              [beforeLabel]="c.beforeLabel"
              [afterLabel]="c.afterLabel"
              [beforeInputs]="c.beforeInputs ?? null"
              [afterInputs]="c.afterInputs ?? null"
              [beforeName]="c.beforeName ?? null"
              [afterName]="c.afterName ?? null"
              maxHeight="min(52vh, 520px)"
            />
          }
          @if (o.field; as f) {
            <label class="scd-field">
              <span>{{ f.label }}</span>
              <input
                class="scd-input"
                type="text"
                autocomplete="off"
                [value]="text()"
                [attr.maxlength]="f.maxLength ?? null"
                [attr.placeholder]="f.placeholder ?? null"
                (input)="text.set($any($event.target).value)"
              />
            </label>
          }
          <div class="scd-actions">
            <button type="button" class="scd-btn secondary" (click)="choose(null)">
              {{ o.cancelLabel ?? 'Cancel' }}
            </button>
            @for (c of o.choices; track c.id) {
              <button
                type="button"
                class="scd-btn"
                [attr.data-tone]="c.tone ?? 'neutral'"
                [disabled]="c.needsText && !text().trim()"
                (click)="choose(c.id)"
              >
                {{ c.label }}
              </button>
            }
          </div>
        </div>
      </dialog>
    }
  `,
  styles: [
    `
      dialog.scd {
        width: min(560px, calc(100vw - 32px));
        max-height: calc(100vh - 32px);
        padding: 0;
        border: 1px solid var(--border);
        border-radius: var(--radius-lg, 14px);
        background: var(--bg-primary);
        color: var(--text-primary);
        box-shadow: var(--shadow-lg, 0 20px 50px rgba(0, 0, 0, 0.25));
      }
      dialog.scd.is-wide {
        width: min(1180px, calc(100vw - 32px));
      }
      dialog.scd[data-tone='danger'] {
        border-top: 4px solid var(--loss);
      }
      dialog.scd::backdrop {
        background: var(--backdrop-scrim, rgba(0, 0, 0, 0.45));
        backdrop-filter: blur(4px);
      }
      .scd-body {
        display: flex;
        flex-direction: column;
        gap: 10px;
        padding: 18px 22px;
        max-height: calc(100vh - 34px);
        overflow: auto;
        box-sizing: border-box;
      }
      .scd-title {
        margin: 0;
        font-size: var(--text-lg, 17px);
        font-weight: var(--font-semibold, 600);
      }
      .scd-message {
        margin: 0;
        font-size: var(--text-sm, 13px);
        line-height: 1.5;
      }
      .scd-details {
        margin: 0;
        padding-left: 18px;
        font-size: var(--text-sm, 13px);
        line-height: 1.5;
        color: var(--text-secondary);
      }
      .scd-field {
        display: flex;
        flex-direction: column;
        gap: 4px;
        font-size: 12px;
        color: var(--text-secondary);
      }
      .scd-input {
        height: 34px;
        padding: 0 10px;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm, 6px);
        background: var(--bg-secondary);
        color: var(--text-primary);
        font: inherit;
        font-size: 13px;
      }
      .scd-actions {
        display: flex;
        flex-wrap: wrap;
        justify-content: flex-end;
        gap: 8px;
        margin-top: 4px;
      }
      .scd-btn {
        height: 34px;
        padding: 0 16px;
        border-radius: var(--radius-full, 999px);
        border: 1px solid var(--border);
        background: var(--bg-secondary);
        color: var(--text-primary);
        font: inherit;
        font-size: 13px;
        font-weight: var(--font-medium, 500);
        cursor: pointer;
      }
      .scd-btn.secondary {
        background: var(--bg-tertiary);
      }
      .scd-btn[data-tone='primary'] {
        background: var(--accent);
        border-color: var(--accent);
        color: #fff;
      }
      .scd-btn[data-tone='danger'] {
        background: var(--loss);
        border-color: var(--loss);
        color: #fff;
      }
      .scd-btn:disabled {
        opacity: 0.45;
        cursor: not-allowed;
      }
      .scd-btn:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: 2px;
      }
    `,
  ],
})
export class ScriptChoiceDialogComponent {
  /** Set by the service before the first render. */
  readonly options = signal<ScriptDialogOptions | null>(null);
  readonly text = signal('');
  readonly closed = output<ScriptDialogResult>();

  readonly uid = `scd-${nextUid++}`;
  readonly hasField = computed(() => !!this.options()?.field);

  private readonly dialogRef = viewChild<ElementRef<HTMLDialogElement>>('dlg');
  private done = false;

  /** Opens the dialog (after the first render); focus lands on the field, else on Cancel. */
  show(): void {
    const el = this.dialogRef()?.nativeElement;
    if (!el) return;
    if (typeof el.showModal === 'function') el.showModal();
    else el.setAttribute('open', '');
    const target =
      el.querySelector<HTMLElement>('.scd-input') ?? el.querySelector<HTMLElement>('.scd-btn.secondary');
    target?.focus();
  }

  choose(choice: string | null): void {
    if (this.done) return;
    const c = this.options()?.choices.find((x) => x.id === choice);
    if (c?.needsText && !this.text().trim()) return;
    this.done = true;
    const el = this.dialogRef()?.nativeElement;
    if (el?.open && typeof el.close === 'function') el.close();
    this.closed.emit({ choice, text: this.text() });
  }

  /** Escape: the browser would close the dialog itself — close it as a cancel instead. */
  onCancel(event: Event): void {
    event.preventDefault();
    this.choose(null);
  }

  /** A click on the backdrop lands on the dialog element itself (its body covers the rest). */
  onBackdrop(event: MouseEvent): void {
    if (event.target === this.dialogRef()?.nativeElement) this.choose(null);
  }
}
