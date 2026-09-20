import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  input,
  signal,
} from '@angular/core';
import { ApiService } from '@core/api/api.service';

/**
 * The screenshot the assistant was shown for one turn.
 *
 * <p>Without this the operator has to take the answer on trust: there is no way to tell a
 * correct reading from a confident one, or to notice that something was covering half the
 * chart. Seeing the frame is what makes the rest checkable.</p>
 *
 * <p>Fetched lazily, once per turn, through the API service so the request carries the
 * operator's token — an `<img src>` cannot send an Authorization header, so the bytes are
 * pulled as a blob and shown from an object URL.</p>
 */
@Component({
  selector: 'app-turn-screenshot',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (url(); as src) {
      <figure class="shot" [class.expanded]="expanded()">
        <img
          [src]="src"
          alt="What the assistant was shown for this message"
          (click)="expanded.set(!expanded())"
          (keydown.enter)="expanded.set(!expanded())"
          tabindex="0"
          [title]="expanded() ? 'Click to shrink' : 'Click to enlarge'"
        />
        <figcaption>
          What the assistant saw · click to {{ expanded() ? 'shrink' : 'enlarge' }}
        </figcaption>
      </figure>
    } @else if (failed()) {
      <div class="shot-missing">The screenshot for this message could not be loaded.</div>
    }
  `,
  styles: [
    `
      .shot {
        margin: 6px 0 0;
        padding: 0;
      }
      .shot img {
        display: block;
        /* Thumbnail by default: the frame is the operator's whole screen, and full size in
           a chat column would push the conversation off the page. */
        max-width: 260px;
        width: 100%;
        border: 1px solid var(--border, #e0e3eb);
        border-radius: 6px;
        cursor: zoom-in;
      }
      .shot.expanded img {
        max-width: 100%;
        cursor: zoom-out;
      }
      figcaption {
        margin-top: 2px;
        font-size: 11px;
        color: var(--text-muted, #787b86);
      }
      .shot-missing {
        margin-top: 6px;
        font-size: 11px;
        color: var(--text-muted, #787b86);
      }
    `,
  ],
})
export class TurnScreenshotComponent {
  private readonly api = inject(ApiService);
  private readonly destroyRef = inject(DestroyRef);

  /** The chat turn this image belongs to. */
  readonly turnId = input.required<number>();

  protected readonly url = signal<string | null>(null);
  protected readonly failed = signal(false);
  protected readonly expanded = signal(false);

  constructor() {
    this.destroyRef.onDestroy(() => {
      const current = this.url();
      // An object URL pins the blob in memory until it is revoked; a long thread of these
      // would hold every screenshot for the life of the tab.
      if (current) URL.revokeObjectURL(current);
    });

    queueMicrotask(() => void this.load());
  }

  private async load(): Promise<void> {
    try {
      const blob = await this.api.getBlob(
        `/market-data/analyze/follow-up/${this.turnId()}/screenshot`,
      );
      if (!blob) {
        this.failed.set(true);
        return;
      }
      this.url.set(URL.createObjectURL(blob));
    } catch {
      this.failed.set(true);
    }
  }
}
