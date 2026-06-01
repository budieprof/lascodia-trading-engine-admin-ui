import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';

/**
 * Thin indeterminate progress bar.  Render it at the top of a page or panel
 * and toggle its `[active]` input to give an always-visible loading hint —
 * useful when the actual fetch is sub-100ms and the per-section shimmer
 * placeholders flash too briefly to register.
 *
 * **Minimum display time.**  When `[active]` flips to true the bar shows
 * immediately, but it then refuses to hide until at least `minVisibleMs`
 * (default 500ms) has elapsed since it became visible.  Without this
 * floor a localhost fetch resolving in 60–90ms would render the bar for
 * a frame or two and be gone — invisible to the eye.  The floor is large
 * enough to register but short enough to feel responsive to a real reply.
 *
 * The bar stays in the DOM (occupying its height) at all times so adjacent
 * content doesn't jump when it appears; `visibility` toggles instead of
 * `display`, and the gradient stripe only animates while visible.
 */
@Component({
  selector: 'ui-progress-bar',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="track"
      role="progressbar"
      aria-valuemin="0"
      aria-valuemax="100"
      [attr.aria-busy]="visible()"
      [attr.aria-hidden]="!visible()"
      [class.active]="visible()"
    >
      <div class="stripe"></div>
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
        width: 100%;
        /* Always reserve the bar's vertical slot so adjacent content
         * doesn't shift when active flips.  6px = visible enough to
         * register but not enough to feel like a header element. */
        padding-block: 2px;
      }
      .track {
        position: relative;
        width: 100%;
        height: 6px;
        background: color-mix(in srgb, var(--border) 70%, transparent);
        overflow: hidden;
        border-radius: 3px;
        transition: background 200ms ease;
      }
      .track.active {
        background: color-mix(in srgb, var(--accent) 25%, transparent);
        box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 35%, transparent);
      }
      .stripe {
        position: absolute;
        inset: 0;
        background: linear-gradient(
          90deg,
          transparent 0%,
          color-mix(in srgb, var(--accent) 60%, transparent) 30%,
          var(--accent) 50%,
          color-mix(in srgb, var(--accent) 60%, transparent) 70%,
          transparent 100%
        );
        transform: translateX(-100%);
        opacity: 0;
      }
      .track.active .stripe {
        opacity: 1;
        animation: ui-progress-slide 1.1s ease-in-out infinite;
      }
      @keyframes ui-progress-slide {
        0% {
          transform: translateX(-100%);
        }
        100% {
          transform: translateX(100%);
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .track.active .stripe {
          animation: none;
          transform: translateX(0);
          opacity: 0.7;
        }
      }
    `,
  ],
})
export class ProgressBarComponent {
  /** When true the stripe slides across the track; otherwise the bar is invisible. */
  readonly active = input(false);
  /**
   * Minimum milliseconds the bar must remain visible once it becomes
   * active.  Defaults to 500ms — long enough for a localhost reply to
   * register, short enough to feel responsive.  Set to 0 to disable.
   */
  readonly minVisibleMs = input(500);

  private readonly destroyRef = inject(DestroyRef);
  private readonly heldUntil = signal<number | null>(null);
  private readonly tick = signal(0);
  private hideTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * The actual visibility flag — true while the input is true OR while the
   * minimum-display window is still open.  The component renders this
   * instead of the raw `active` input so quick fetches stay perceptible.
   */
  protected readonly visible = computed(() => {
    // touch tick() so re-evaluation fires when the timer expires
    this.tick();
    if (this.active()) return true;
    const held = this.heldUntil();
    return held !== null && performance.now() < held;
  });

  // Watch `active` going true and schedule a release once the minimum has elapsed.
  private readonly syncEffect = effect(() => {
    if (this.active()) {
      const floor = this.minVisibleMs();
      this.heldUntil.set(performance.now() + floor);
      if (this.hideTimer !== null) {
        clearTimeout(this.hideTimer);
        this.hideTimer = null;
      }
    } else if (this.heldUntil() !== null && this.hideTimer === null) {
      // active just went false — schedule the visible recompute for when
      // the floor expires.  Bumping `tick` forces the computed to re-run.
      const remaining = (this.heldUntil() ?? 0) - performance.now();
      if (remaining <= 0) {
        this.heldUntil.set(null);
        this.tick.update((n) => n + 1);
      } else {
        this.hideTimer = setTimeout(() => {
          this.hideTimer = null;
          this.heldUntil.set(null);
          this.tick.update((n) => n + 1);
        }, remaining);
      }
    }
  });

  constructor() {
    this.destroyRef.onDestroy(() => {
      if (this.hideTimer !== null) clearTimeout(this.hideTimer);
    });
  }
}
