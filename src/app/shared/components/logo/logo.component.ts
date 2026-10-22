import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/**
 * The Lascodia mark: chart axes forming an "L" with two candlesticks rising
 * inside, so the monogram and the instrument are the same figure. Drawn inline
 * rather than loaded from `public/logo-mark.svg` — the sidebar and login card
 * both render it above the fold, and inline shapes cost no request and stay
 * crisp at any size.
 *
 * Same composition and blues as the favicon (`scripts/generate-icons.mjs`, which
 * carries the reasoning behind the two candles), but a different drawing: that
 * one is fitted to a 16px browser tab, this one to the 32px sidebar, where the
 * favicon's heavy strokes read as a white block on the tile. Here 1px = 16 grid
 * units and every edge sits on a multiple of 16: axis 3px, candle bodies 4px
 * wide, wicks 1px, with the glyph centred in 112..400 x 96..416 (about 60% of
 * the plate). A hairline inner edge and a top highlight give the tile depth.
 * Keycloak's sign-in theme carries a copy (engine repo,
 * deploy/keycloak/themes/lascodia/login/resources/img/logo-mark.svg): change both.
 * Check changes with a true 1x render magnified, not the 512 artwork.
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
        <linearGradient [attr.id]="fillId" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#4DA6FF" />
          <stop offset="1" stop-color="#0A4FD1" />
        </linearGradient>
        <linearGradient [attr.id]="sheenId" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#fff" stop-opacity="0.22" />
          <stop offset="0.5" stop-color="#fff" stop-opacity="0" />
        </linearGradient>
      </defs>
      <rect width="512" height="512" rx="120" [attr.fill]="fillRef()" />
      <rect width="512" height="512" rx="120" [attr.fill]="sheenRef()" />
      <rect
        x="8"
        y="8"
        width="496"
        height="496"
        rx="112"
        fill="none"
        stroke="#fff"
        stroke-opacity="0.18"
        stroke-width="16"
      />
      <path
        d="M136 120 V392 H376"
        fill="none"
        stroke="#fff"
        stroke-width="48"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <path d="M240 224 V352" stroke="#fff" stroke-width="16" stroke-linecap="round" />
      <rect x="208" y="256" width="64" height="80" rx="12" fill="#fff" />
      <path d="M336 112 V288" stroke="#fff" stroke-width="16" stroke-linecap="round" />
      <rect x="304" y="144" width="64" height="112" rx="12" fill="#fff" />
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
