import { DestroyRef, Directive, ElementRef, inject, input } from '@angular/core';

/**
 * Fades an element up the first time it scrolls into view (adds `is-in`). The styles live in
 * `styles/_landing.scss` and do nothing under `prefers-reduced-motion`; without IntersectionObserver the element
 * is shown at once, so content never stays hidden.
 */
@Directive({
  selector: '[lpReveal]',
  standalone: true,
  host: { class: 'lp-reveal', '[style.--lp-delay]': 'delayMs()' },
})
export class RevealDirective {
  /** Stagger, in ms, for items revealed together (`lpReveal="120"` or `[lpReveal]="i * 90"`; bare = none). */
  readonly lpReveal = input<number | string>('');

  protected delayMs(): string {
    const d = Number(this.lpReveal());
    return `${Number.isFinite(d) ? d : 0}ms`;
  }

  constructor() {
    const el = inject(ElementRef<HTMLElement>).nativeElement as HTMLElement;
    if (typeof IntersectionObserver === 'undefined') {
      el.classList.add('is-in');
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            el.classList.add('is-in');
            io.disconnect();
          }
        }
      },
      // The root reaches far above the viewport: a jump that carries an element from below the viewport to
      // above it never crosses the viewport itself, and would otherwise leave it hidden behind the reader.
      { rootMargin: '10000% 0px -8% 0px', threshold: 0.05 },
    );
    io.observe(el);
    inject(DestroyRef).onDestroy(() => io.disconnect());
  }
}
