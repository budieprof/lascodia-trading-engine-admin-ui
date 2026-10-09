import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { DomSanitizer, type SafeHtml } from '@angular/platform-browser';

/**
 * TradingView's FX icon: the pair's two currencies as overlapping circle flags — the base in front at the top left,
 * the quote behind at the bottom right. Flags are simplified inline SVG (32×32, clipped to a circle by CSS) so they
 * render the same on every OS — emoji flags show as two letters on Windows.
 */

/** A five-point star centred on (cx, cy). */
function star(cx: number, cy: number, r: number, fill: string, stroke = ''): string {
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 === 0 ? r : r * 0.42;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    pts.push(`${(cx + rad * Math.cos(a)).toFixed(2)},${(cy + rad * Math.sin(a)).toFixed(2)}`);
  }
  const s = stroke ? ` stroke="${stroke}" stroke-width="0.8"` : '';
  return `<polygon points="${pts.join(' ')}" fill="${fill}"${s}/>`;
}

const UNION =
  '<rect width="32" height="32" fill="#012169"/>' +
  '<path d="M0 0L32 32M32 0L0 32" stroke="#fff" stroke-width="6"/>' +
  '<path d="M0 0L32 32M32 0L0 32" stroke="#C8102E" stroke-width="2"/>' +
  '<path d="M16 0V32M0 16H32" stroke="#fff" stroke-width="9"/>' +
  '<path d="M16 0V32M0 16H32" stroke="#C8102E" stroke-width="5"/>';

const EU_STARS = Array.from({ length: 12 }, (_, i) => {
  const a = (i * Math.PI) / 6;
  return star(16 + 9.5 * Math.cos(a), 16 + 9.5 * Math.sin(a), 1.9, '#FFCC00');
}).join('');

const US_STRIPES = Array.from({ length: 7 }, (_, i) =>
  `<rect y="${(i * 64) / 13}" width="32" height="${32 / 13}" fill="#B22234"/>`,
).join('');

/** The flag artwork per ISO currency code (XAU: a gold coin, as TradingView shows metals). */
export const CURRENCY_FLAG_SVG: Readonly<Record<string, string>> = {
  USD:
    `<rect width="32" height="32" fill="#fff"/>${US_STRIPES}` +
    '<rect width="15" height="17.2" fill="#3C3B6E"/>' +
    [3.5, 7.5, 11.5].flatMap((x) => [3.5, 8.6, 13.7].map((y) => `<circle cx="${x}" cy="${y}" r="1" fill="#fff"/>`)).join(''),
  EUR: `<rect width="32" height="32" fill="#003399"/>${EU_STARS}`,
  GBP: UNION,
  JPY: '<rect width="32" height="32" fill="#fff"/><circle cx="16" cy="16" r="8" fill="#BC002D"/>',
  CHF: '<rect width="32" height="32" fill="#DA291C"/><path d="M13 7h6v18h-6zM7 13h18v6H7z" fill="#fff"/>',
  CAD:
    '<rect width="32" height="32" fill="#fff"/><path d="M0 0h8v32H0zM24 0h8v32h-8z" fill="#D80621"/>' +
    '<path d="M16 7.5l1.6 3.4 2.4-1-1 5.2 3.2-1.8-.8 3.2 2.6.7-4.8 3.3.6 1.8-3-.5V24h-1.6v-3.2l-3 .5.6-1.8-4.8-3.3 2.6-.7-.8-3.2 3.2 1.8-1-5.2 2.4 1z" fill="#D80621"/>',
  AUD:
    `<rect width="32" height="32" fill="#012169"/><g transform="scale(.5)">${UNION}</g>` +
    star(8, 24, 3.4, '#fff') +
    star(24, 7, 1.7, '#fff') +
    star(19.5, 15, 1.7, '#fff') +
    star(27, 13, 1.7, '#fff') +
    star(24, 26, 1.9, '#fff'),
  NZD:
    `<rect width="32" height="32" fill="#012169"/><g transform="scale(.5)">${UNION}</g>` +
    star(24, 7, 2, '#C8102E', '#fff') +
    star(19.5, 15, 2, '#C8102E', '#fff') +
    star(27, 13.5, 1.8, '#C8102E', '#fff') +
    star(24, 26, 2.2, '#C8102E', '#fff'),
  CNH:
    '<rect width="32" height="32" fill="#EE1C25"/>' +
    star(9, 10, 5, '#FFFF00') +
    star(16, 5, 1.6, '#FFFF00') +
    star(19, 8.5, 1.6, '#FFFF00') +
    star(19, 13, 1.6, '#FFFF00') +
    star(16, 16, 1.6, '#FFFF00'),
  NGN: '<rect width="32" height="32" fill="#fff"/><path d="M0 0h10.67v32H0zM21.33 0H32v32H21.33z" fill="#008751"/>',
  XAU:
    '<rect width="32" height="32" fill="#B8860B"/><circle cx="16" cy="16" r="12" fill="#E6BE3A"/>' +
    '<circle cx="16" cy="16" r="9" fill="none" stroke="#B8860B" stroke-width="1.2"/>' +
    '<path d="M11 19.5l3-8h4l3 8" fill="none" stroke="#8B6508" stroke-width="1.6" stroke-linejoin="round"/>',
};

/** Currency names as TradingView titles a pair ("Euro / U.S. Dollar"). */
export const CURRENCY_NAME: Readonly<Record<string, string>> = {
  USD: 'U.S. Dollar',
  EUR: 'Euro',
  GBP: 'British Pound',
  JPY: 'Japanese Yen',
  CHF: 'Swiss Franc',
  CAD: 'Canadian Dollar',
  AUD: 'Australian Dollar',
  NZD: 'New Zealand Dollar',
  CNH: 'Chinese Yuan (offshore)',
  NGN: 'Nigerian Naira',
  XAU: 'Gold',
};

/** "Euro / U.S. Dollar" for a pair whose two currencies are named, else null (the caller keeps its own label). */
export function pairName(base: string | null, quote: string | null): string | null {
  const b = base ? CURRENCY_NAME[base.toUpperCase()] : undefined;
  const q = quote ? CURRENCY_NAME[quote.toUpperCase()] : undefined;
  return b && q ? `${b} / ${q}` : null;
}

/** The two currencies of an FX / metal symbol both with flag artwork, else null (the caller shows its letter badge). */
export function pairFlags(symbol: string): [string, string] | null {
  const s = symbol.toUpperCase().replace(/[^A-Z]/g, '');
  if (s.length < 6) return null;
  const base = s.slice(0, 3);
  const quote = s.slice(3, 6);
  return CURRENCY_FLAG_SVG[base] && CURRENCY_FLAG_SVG[quote] ? [base, quote] : null;
}

@Component({
  selector: 'app-pair-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (svgs(); as s) {
      <span class="pi" [class.big]="big()" [attr.aria-label]="s.label" role="img">
        <span class="pi-f pi-quote" [innerHTML]="s.quote"></span>
        <span class="pi-f pi-base" [innerHTML]="s.base"></span>
      </span>
    }
  `,
  styles: `
    :host {
      display: inline-flex;
      flex: none;
    }
    .pi {
      position: relative;
      display: inline-block;
      width: 18px;
      height: 18px;
    }
    .pi.big {
      width: 28px;
      height: 28px;
    }
    .pi-f {
      position: absolute;
      width: 72%;
      height: 72%;
      border-radius: 50%;
      overflow: hidden;
      box-shadow: 0 0 0 1px var(--surface, #fff);
    }
    .pi-quote {
      right: 0;
      bottom: 0;
    }
    .pi-base {
      left: 0;
      top: 0;
    }
  `,
})
export class PairIconComponent {
  private readonly sanitizer = inject(DomSanitizer);
  readonly symbol = input.required<string>();
  readonly big = input(false);

  /** Trusted static artwork from {@link CURRENCY_FLAG_SVG} only — never user input. */
  readonly svgs = computed<{ base: SafeHtml; quote: SafeHtml; label: string } | null>(() => {
    const pair = pairFlags(this.symbol());
    if (!pair) return null;
    const wrap = (ccy: string): SafeHtml =>
      this.sanitizer.bypassSecurityTrustHtml(`<svg viewBox="0 0 32 32" width="100%" height="100%" style="display:block" aria-hidden="true">${CURRENCY_FLAG_SVG[ccy]}</svg>`);
    return { base: wrap(pair[0]), quote: wrap(pair[1]), label: `${pair[0]} / ${pair[1]}` };
  });
}
