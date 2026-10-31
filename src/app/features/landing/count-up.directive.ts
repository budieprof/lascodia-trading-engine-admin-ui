import { DestroyRef, Directive, ElementRef, effect, inject, input } from '@angular/core';

import { countUpFrame } from './landing.logic';

const DURATION_MS = 1400;

/**
 * Writes `lpCountUp` ("< 3 s", "7") into the element, counting its number up from zero the first time it scrolls
 * into view. The final text is in the DOM from the start for screen readers and no-JS crawlers' snapshots; under
 * `prefers-reduced-motion`, or without IntersectionObserver, it simply stays there.
 */
@Directive({ selector: '[lpCountUp]', standalone: true })
export class CountUpDirective {
  readonly lpCountUp = input.required<string>();

  constructor() {
    const el = inject(ElementRef<HTMLElement>).nativeElement as HTMLElement;
    let raf = 0;
    let io: IntersectionObserver | null = null;

    effect(() => {
      const target = this.lpCountUp();
      el.textContent = target;
      io?.disconnect();
      const reduce =
        typeof window === 'undefined' ||
        window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      if (reduce || typeof IntersectionObserver === 'undefined' || !/\d/.test(target)) return;

      io = new IntersectionObserver(
        (entries) => {
          if (!entries.some((e) => e.isIntersecting)) return;
          io?.disconnect();
          const start = performance.now();
          const step = (now: number) => {
            const t = Math.min(1, (now - start) / DURATION_MS);
            el.textContent = countUpFrame(target, t);
            if (t < 1) raf = requestAnimationFrame(step);
          };
          raf = requestAnimationFrame(step);
        },
        { threshold: 0.4 },
      );
      io.observe(el);
    });

    inject(DestroyRef).onDestroy(() => {
      cancelAnimationFrame(raf);
      io?.disconnect();
    });
  }
}
