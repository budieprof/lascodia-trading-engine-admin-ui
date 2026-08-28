import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/**
 * The Lascodia mark: chart axes forming an "L" with two candlesticks rising
 * inside, so the monogram and the instrument are the same figure. Drawn inline
 * rather than loaded from `public/logo-mark.svg` — the sidebar and login card
 * both render it above the fold, and inline shapes cost no request and stay
 * crisp at any size.
 *
 * The geometry mirrors `scripts/generate-icons.mjs`, which produces the
 * favicon and PWA rasters from the same coordinates. Change one, change both.
 * That file carries the reasoning behind the two-candle composition.
 */

/**
 * Gradient ids must be unique per document: SVG resolves `url(#id)` globally,
 * so two instances sharing an id would both paint from whichever was parsed
 * first. Harmless while the definitions are identical, but it silently breaks
 * the moment one instance is themed differently.
 */
let instanceCount = 0;

@Component({
  selector: 'app-logo',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg
      [attr.width]="size()"
      [attr.height]="size()"
      viewBox="0 0 512 512"
      xmlns="http://www.w3.org/2000/svg"
      [attr.role]="label() ? 'img' : null"
      [attr.aria-label]="label() || null"
      [attr.aria-hidden]="label() ? null : 'true'"
    >
      <defs>
        <linearGradient [attr.id]="fillId" x1="0" y1="0" x2="0.4" y2="1">
          <stop offset="0" stop-color="#3B9DFF" />
          <stop offset="1" stop-color="#0057D8" />
        </linearGradient>
        <linearGradient [attr.id]="sheenId" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#fff" stop-opacity="0.1" />
          <stop offset="0.55" stop-color="#fff" stop-opacity="0" />
        </linearGradient>
      </defs>
      <rect width="512" height="512" rx="114" [attr.fill]="fillRef()" />
      <rect width="512" height="512" rx="114" [attr.fill]="sheenRef()" />
      <path
        d="M80 80 V432 H432"
        fill="none"
        stroke="#fff"
        stroke-width="64"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <path d="M208 240 V408" stroke="#fff" stroke-width="40" stroke-linecap="round" />
      <rect x="160" y="288" width="96" height="104" rx="22" fill="#fff" />
      <path d="M352 96 V360" stroke="#fff" stroke-width="40" stroke-linecap="round" />
      <rect x="304" y="144" width="96" height="168" rx="22" fill="#fff" />
    </svg>
  `,
  styles: [
    `
      :host {
        display: inline-flex;
        line-height: 0;
      }

      svg {
        display: block;
      }
    `,
  ],
})
export class LogoComponent {
  /** Rendered edge length in px. The mark is square. */
  readonly size = input(32);

  /**
   * Accessible name. Leave unset wherever the mark sits next to the wordmark
   * or a heading that already names the product — a second announcement of
   * "Lascodia" is noise to a screen reader, so the mark goes `aria-hidden`.
   */
  readonly label = input('');

  private readonly uid = `lascodia-logo-${instanceCount++}`;
  protected readonly fillId = `${this.uid}-fill`;
  protected readonly sheenId = `${this.uid}-sheen`;
  protected readonly fillRef = computed(() => `url(#${this.fillId})`);
  protected readonly sheenRef = computed(() => `url(#${this.sheenId})`);
}
