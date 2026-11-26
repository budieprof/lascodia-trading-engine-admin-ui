import { DestroyRef, Directive, ElementRef, inject, output } from '@angular/core';

/**
 * Reports where an element's bottom and right edges are in its offset parent (px), now and whenever its size
 * changes — the chart's floating legend tells the chart how far down and across it reaches, so the scripts' top
 * tables sit below it where they would cover it, without the chart reading the page's DOM (pine-chart follow-up).
 */
@Directive({ selector: '[appMeasuredBottom]' })
export class MeasuredBottomDirective {
  readonly bottomChange = output<number>();
  readonly rightChange = output<number>();

  constructor() {
    const el = inject(ElementRef<HTMLElement>).nativeElement as HTMLElement;
    let last = -1;
    let lastRight = -1;
    const report = (): void => {
      const bottom = el.offsetTop + el.offsetHeight;
      const right = el.offsetLeft + el.offsetWidth;
      if (right !== lastRight) {
        lastRight = right;
        this.rightChange.emit(right);
      }
      if (bottom === last) return;
      last = bottom;
      this.bottomChange.emit(bottom);
    };
    if (typeof ResizeObserver === 'undefined') {
      queueMicrotask(report);
      return;
    }
    const observer = new ResizeObserver(report);
    observer.observe(el);
    inject(DestroyRef).onDestroy(() => observer.disconnect());
  }
}
