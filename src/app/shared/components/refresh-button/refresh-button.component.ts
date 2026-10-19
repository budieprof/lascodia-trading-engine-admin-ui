import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  input,
  output,
  signal,
} from '@angular/core';

/** Shortest time the busy state stays up, so a 60 ms refetch still reads as "it did something". */
const MIN_BUSY_MS = 450;

/**
 * Manual "Refresh" for a page backed by a polled resource.
 *
 * The ML and CompositeML pages bound their Refresh buttons to `resource.loading()`, which is true
 * only until the first value lands — so a click changed nothing on screen at all (the 2026-10-19
 * review measured zero DOM mutations). This button owns its own "a refresh I started is in flight"
 * state: it goes busy on click and settles once the bound `refreshing` flag (the resource's
 * `refreshing()`, true while any fetch runs) drops, held for at least {@link MIN_BUSY_MS}.
 * Background polls never light it up — only the operator's own click does.
 *
 * Shared (from ml-models): any page whose Refresh is bound to `resource.loading()` — or to nothing
 * — has the same "click, nothing happens" defect; drop this in with `[refreshing]` and `(refresh)`.
 */
@Component({
  selector: 'app-refresh-button',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button
      type="button"
      class="refresh-btn"
      [class.outline]="variant() === 'outline'"
      [class.secondary]="variant() === 'secondary'"
      [disabled]="busy()"
      [attr.aria-busy]="busy()"
      [title]="busy() ? 'Refreshing…' : 'Fetch the latest data now'"
      (click)="onClick()"
    >
      <span class="glyph" [class.spin]="busy()" aria-hidden="true">↻</span>
      <span>{{ busy() ? 'Refreshing…' : label() }}</span>
    </button>
  `,
  styles: [
    `
      :host {
        display: inline-flex;
        flex-shrink: 0;
      }
      .refresh-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        border-radius: var(--radius-full);
        font: inherit;
        font-size: var(--text-sm, 13px);
        font-weight: var(--font-medium, 500);
        line-height: 1;
        white-space: nowrap;
        cursor: pointer;
        color: var(--text-primary);
      }
      .refresh-btn.outline {
        height: 32px;
        padding: 0 var(--space-4);
        border: 1px solid var(--border);
        background: var(--bg-primary);
        font-size: 13px;
      }
      .refresh-btn.secondary {
        height: 36px;
        padding: 0 var(--space-4);
        border: none;
        background: var(--bg-tertiary);
      }
      .refresh-btn:hover:not(:disabled) {
        background: var(--bg-tertiary);
      }
      .refresh-btn.secondary:hover:not(:disabled) {
        filter: brightness(1.12);
      }
      .refresh-btn:disabled {
        cursor: progress;
        color: var(--text-secondary);
      }
      .refresh-btn:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: 2px;
      }
      .glyph {
        display: inline-block;
        line-height: 1;
      }
      .glyph.spin {
        animation: refresh-spin 0.8s linear infinite;
      }
      @keyframes refresh-spin {
        to {
          transform: rotate(360deg);
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .glyph.spin {
          animation: none;
        }
      }
    `,
  ],
})
export class RefreshButtonComponent {
  /** The resource's `refreshing()` (any fetch in flight) — OR several when one click refreshes many. */
  readonly refreshing = input(false);
  readonly label = input('Refresh');
  /** `outline` = the CompositeML toolbar pill; `secondary` = the ML sub-page header pill. */
  readonly variant = input<'outline' | 'secondary'>('secondary');
  readonly refresh = output<void>();

  private readonly pending = signal(false);
  private busyUntil = 0;
  protected readonly busy = computed(() => this.pending());

  constructor() {
    // Settle once the fetch this click started has finished (and the minimum display time is up).
    // The click handler raises `refreshing` synchronously through resource.refresh(), so by the
    // time this runs a real request is already in flight; a refresh the resource skipped (hidden
    // tab) leaves `refreshing` false and the button settles after the minimum.
    effect((onCleanup) => {
      if (!this.pending() || this.refreshing()) return;
      const t = setTimeout(() => this.pending.set(false), Math.max(0, this.busyUntil - Date.now()));
      onCleanup(() => clearTimeout(t));
    });
  }

  protected onClick(): void {
    if (this.pending()) return;
    this.busyUntil = Date.now() + MIN_BUSY_MS;
    this.pending.set(true);
    this.refresh.emit();
  }
}
