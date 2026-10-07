import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  effect,
  inject,
  input,
  output,
  untracked,
} from '@angular/core';

/** How long a notice stays up, unless the pointer or the focus is on it. */
export const UNDO_NOTICE_MS = 8_000;

/**
 * A one-line notice over the chart with an action — "Replaced X with Y: one strategy at a time on the
 * chart · Undo" — for a change the operator may not have meant. The app's toasts take no action, so
 * the chart keeps its own.
 *
 * The live region is always in the page and only its text comes and goes, so a screen reader
 * announces each notice (`role="status"`, polite). It dismisses itself after {@link UNDO_NOTICE_MS}
 * — the time stands still while the pointer is over it or the focus is in it, so nobody is raced to
 * the button — and a new message starts the time again. Both buttons are 40 px touch targets.
 */
@Component({
  selector: 'app-undo-notice',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="un-region" role="status" aria-live="polite">
      @if (message(); as text) {
        <div
          class="un"
          (pointerenter)="hold()"
          (pointerleave)="release()"
          (focusin)="hold()"
          (focusout)="onFocusOut($event)"
        >
          <span class="un-text">{{ text }}</span>
          <button type="button" class="un-action" (click)="act()">{{ actionLabel() }}</button>
          <button type="button" class="un-x" aria-label="Dismiss" (click)="dismiss()">×</button>
        </div>
      }
    </div>
  `,
  styles: `
    :host {
      position: absolute;
      left: 50%;
      bottom: 40px;
      z-index: 30;
      transform: translateX(-50%);
      width: max-content;
      max-width: min(560px, calc(100% - 32px));
      pointer-events: none;
    }
    .un {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 4px 4px 4px 14px;
      border-radius: 6px;
      background: var(--tv-ink, #131722);
      color: var(--tv-bg, #ffffff);
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.28);
      font-size: 13px;
      line-height: 1.35;
      pointer-events: auto;
    }
    .un-text {
      flex: 1 1 auto;
      min-width: 0;
    }
    .un-action,
    .un-x {
      flex: none;
      min-height: 40px;
      border: 0;
      border-radius: 4px;
      background: transparent;
      color: inherit;
      font: inherit;
      cursor: pointer;
    }
    .un-action {
      min-width: 64px;
      padding: 0 12px;
      font-weight: 600;
      text-decoration: underline;
      text-underline-offset: 3px;
    }
    .un-x {
      width: 40px;
      font-size: 20px;
      line-height: 1;
    }
    .un-action:hover,
    .un-x:hover {
      background: color-mix(in srgb, currentColor 14%, transparent);
    }
    .un-action:focus-visible,
    .un-x:focus-visible {
      outline: 2px solid currentColor;
      outline-offset: -2px;
    }
  `,
})
export class UndoNoticeComponent implements OnDestroy {
  /** What happened; null: no notice. */
  readonly message = input<string | null>(null);
  readonly actionLabel = input('Undo');
  /** The action was taken; the notice is over. */
  readonly action = output<void>();
  /** Closed by its × or by the time running out. */
  readonly dismissed = output<void>();

  private readonly host: ElementRef<HTMLElement> = inject(ElementRef);
  private timer: ReturnType<typeof setTimeout> | null = null;
  private held = false;

  constructor() {
    effect(() => {
      const text = this.message();
      untracked(() => {
        this.held = false;
        if (text) this.start();
        else this.stop();
      });
    });
  }

  ngOnDestroy(): void {
    this.stop();
  }

  protected act(): void {
    this.stop();
    this.action.emit();
  }

  protected dismiss(): void {
    this.stop();
    this.dismissed.emit();
  }

  /** The pointer or the focus came onto it: the time stands still. */
  protected hold(): void {
    this.held = true;
    this.stop();
  }

  /** …and left: the full time again. */
  protected release(): void {
    if (!this.held) return;
    this.held = false;
    if (this.message()) this.start();
  }

  /** Focus moving between its own two buttons is still on it. */
  protected onFocusOut(ev: FocusEvent): void {
    const next = ev.relatedTarget as Node | null;
    if (next && this.host.nativeElement.contains(next)) return;
    this.release();
  }

  private start(): void {
    this.stop();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.dismissed.emit();
    }, UNDO_NOTICE_MS);
  }

  private stop(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
