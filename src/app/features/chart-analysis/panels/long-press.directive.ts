import { Directive, ElementRef, inject, input, output } from '@angular/core';

/**
 * `(appLongPress)` fires on RELEASE after the pointer was held still for at least
 * `longPressMs` — release, not the timer, because the release is a user gesture and a
 * timer is not: browsers block `window.open` from a timeout, so a long press that
 * opens a tab must act on pointerup. The
 * click that ends a long press is swallowed (capture phase), so long-pressing a
 * link opens the long-press UI instead of also following the link. Moving more
 * than a few pixels — a scroll on touch — cancels.
 */
@Directive({
  selector: '[appLongPress]',
  standalone: true,
  host: {
    '(pointerdown)': 'start($event)',
    '(pointerup)': 'release($event)',
    '(pointerleave)': 'cancel()',
    '(pointercancel)': 'cancel()',
    '(pointermove)': 'move($event)',
    '(contextmenu)': 'onContextMenu($event)',
  },
})
export class LongPressDirective {
  readonly longPressMs = input(500);
  readonly appLongPress = output<PointerEvent>();

  private timer: ReturnType<typeof setTimeout> | null = null;
  private origin: { x: number; y: number } | null = null;
  private fired = false;

  constructor() {
    // Capture, so the click is stopped before the anchor (or any handler) sees it.
    inject(ElementRef<HTMLElement>).nativeElement.addEventListener(
      'click',
      (e: MouseEvent) => {
        if (!this.fired) return;
        this.fired = false;
        e.preventDefault();
        e.stopPropagation();
      },
      true,
    );
  }

  protected start(e: PointerEvent): void {
    if (e.button !== 0) return;
    this.cancel();
    this.fired = false;
    this.origin = { x: e.clientX, y: e.clientY };
    this.timer = setTimeout(() => {
      this.timer = null;
      this.fired = true;
    }, this.longPressMs());
  }

  protected release(e: PointerEvent): void {
    const long = this.fired;
    this.cancel();
    if (long) this.appLongPress.emit(e);
  }

  protected move(e: PointerEvent): void {
    if (this.origin && Math.hypot(e.clientX - this.origin.x, e.clientY - this.origin.y) > 8)
      this.cancel();
  }

  /** Touch long-press raises the context menu on most browsers; it would cover the modal. */
  protected onContextMenu(e: Event): void {
    if (this.fired || this.timer) e.preventDefault();
  }

  protected cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.origin = null;
  }
}
