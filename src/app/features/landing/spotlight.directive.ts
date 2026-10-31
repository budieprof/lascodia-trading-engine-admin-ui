import { Directive, ElementRef, inject } from '@angular/core';

/**
 * Tracks the pointer over an element as `--mx` / `--my` (px from its top-left), so CSS can paint a glow that
 * follows the cursor (`.lp-spot` in `styles/_landing.scss`). Mouse and pen only — a touch has no hover to follow.
 */
@Directive({
  selector: '[lpSpot]',
  standalone: true,
  host: { class: 'lp-spot', '(pointermove)': 'move($event)' },
})
export class SpotlightDirective {
  private readonly el = inject(ElementRef<HTMLElement>).nativeElement as HTMLElement;

  protected move(e: PointerEvent): void {
    if (e.pointerType === 'touch') return;
    const r = this.el.getBoundingClientRect();
    this.el.style.setProperty('--mx', `${e.clientX - r.left}px`);
    this.el.style.setProperty('--my', `${e.clientY - r.top}px`);
  }
}
