import { DestroyRef, Directive, ElementRef, inject, output } from '@angular/core';

/**
 * Reports where an element's bottom edge is in its offset parent (px), now and whenever its size changes — the
 * chart's floating legend tells the chart how far down it reaches, so the scripts' top-left tables sit below it
 * without the chart reading the page's DOM (pine-chart follow-up).
 */
@Directive({ selector: '[appMeasuredBottom]' })
export class MeasuredBottomDirective {
  readonly bottomChange = output<number>();

  constructor() {
    const el = inject(ElementRef<HTMLElement>).nativeElement as HTMLElement;
    let last = -1;
    const report = (): void => {
      const bottom = el.offsetTop + el.offsetHeight;
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
