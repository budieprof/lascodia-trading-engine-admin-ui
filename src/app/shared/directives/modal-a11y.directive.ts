import {
  AfterViewInit,
  Directive,
  ElementRef,
  OnDestroy,
  inject,
  input,
  output,
} from '@angular/core';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

/**
 * The keyboard behaviour every hand-rolled dialog, drawer and menu owes the operator, in one place:
 *
 * - focus moves INTO it when it opens — the first `[data-autofocus]` / `[autofocus]` element, else
 *   the first focusable one, else the host itself;
 * - Escape dismisses the topmost open one, wherever focus is (a document listener);
 * - Tab cycles inside a modal one (`appModalA11yTrap` false for menus/popovers);
 * - focus returns to whatever had it before — normally the trigger — when it closes.
 *
 * The 2026-10-19 review found Escape closed 1 of 7 dialogs. Most bound `(keydown.escape)` on the
 * dialog element, but focus stayed on the trigger outside it, so the key never got there; and
 * `autofocus` does nothing on an element inserted after the page loaded.
 *
 * Put it on an element that exists only while the dialog is open (inside its `@if`):
 *
 *   <div class="modal" role="dialog" aria-modal="true" appModalA11y (dismiss)="close()">
 *
 * and drop any element-level `(keydown.escape)` it replaces, or close runs twice. For a destructive
 * confirmation mark the SAFE button `data-autofocus` — Enter must never confirm by default.
 */
@Directive({ selector: '[appModalA11y]', standalone: true })
export class ModalA11yDirective implements AfterViewInit, OnDestroy {
  /** Trap Tab inside the host. Off for non-modal menus and popovers. */
  readonly trap = input(true, { alias: 'appModalA11yTrap' });
  /** Escape was pressed while this was the topmost open dialog. */
  readonly dismiss = output<void>();

  /** Open dialogs, innermost last: only the top one answers Escape and traps Tab. */
  private static readonly stack: ModalA11yDirective[] = [];
  /**
   * Keydowns already acted on. The listener sits on the host (dialogs that `stopPropagation()`
   * keydowns inside themselves would starve a document listener) AND on the document (focus may
   * be outside a non-modal menu); an event inside the host reaches both.
   */
  private static readonly handled = new WeakSet<KeyboardEvent>();

  private readonly host: HTMLElement = inject(ElementRef<HTMLElement>).nativeElement;
  private returnTo: HTMLElement | null = null;
  private focusTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly onKeydown = (e: KeyboardEvent): void => {
    if (ModalA11yDirective.stack.at(-1) !== this || ModalA11yDirective.handled.has(e)) return;
    ModalA11yDirective.handled.add(e);
    if (e.key === 'Escape' && !e.defaultPrevented) {
      e.preventDefault();
      e.stopPropagation();
      this.dismiss.emit();
    } else if (e.key === 'Tab' && this.trap()) {
      this.cycleFocus(e);
    }
  };

  ngAfterViewInit(): void {
    const active = document.activeElement;
    this.returnTo = active instanceof HTMLElement && active !== document.body ? active : null;
    ModalA11yDirective.stack.push(this);
    this.host.addEventListener('keydown', this.onKeydown);
    document.addEventListener('keydown', this.onKeydown);
    // After this change-detection pass: the dialog's own @if/@for content may not exist yet.
    this.focusTimer = setTimeout(() => this.focusInitial(), 0);
  }

  ngOnDestroy(): void {
    if (this.focusTimer) clearTimeout(this.focusTimer);
    this.host.removeEventListener('keydown', this.onKeydown);
    document.removeEventListener('keydown', this.onKeydown);
    const i = ModalA11yDirective.stack.indexOf(this);
    if (i >= 0) ModalA11yDirective.stack.splice(i, 1);
    // Hand focus back only if it was inside the dialog (or lost to <body> when the dialog left the
    // DOM) — never steal it from something the operator has since clicked.
    const active = document.activeElement;
    const lost = !active || active === document.body || this.host.contains(active);
    if (lost && this.returnTo?.isConnected) this.returnTo.focus({ preventScroll: true });
  }

  private focusables(): HTMLElement[] {
    return [...this.host.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (el) => el.getClientRects().length > 0,
    );
  }

  private focusInitial(): void {
    this.focusTimer = null;
    if (this.host.contains(document.activeElement)) return;
    const preferred = this.host.querySelector<HTMLElement>('[data-autofocus], [autofocus]');
    const target = preferred ?? this.focusables()[0] ?? this.host;
    if (target === this.host && !this.host.hasAttribute('tabindex')) {
      this.host.setAttribute('tabindex', '-1');
    }
    target.focus({ preventScroll: true });
  }

  private cycleFocus(e: KeyboardEvent): void {
    const items = this.focusables();
    if (items.length === 0) {
      e.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement as HTMLElement | null;
    const inside = !!active && this.host.contains(active);
    if (e.shiftKey && (active === first || !inside)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !inside)) {
      e.preventDefault();
      first.focus();
    }
  }
}
