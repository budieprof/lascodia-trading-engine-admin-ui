import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';

import { parseCssRgb, parsePineColor, toCss, type Rgba } from '../core/color';

/** TradingView's hue columns. */
const HUES = [
  '#F23645', // red
  '#FF9800', // orange
  '#FFEB3B', // yellow
  '#4CAF50', // green
  '#089981', // teal
  '#00BCD4', // cyan
  '#2962FF', // blue
  '#673AB7', // indigo
  '#9C27B0', // purple
  '#E91E63', // pink
];

const GREYS = [
  '#FFFFFF',
  '#D1D4DC',
  '#B2B5BE',
  '#9598A1',
  '#787B86',
  '#5D606B',
  '#434651',
  '#2A2E39',
  '#131722',
  '#000000',
];

const hex2 = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0');

/** `#RRGGBB` of a colour mixed toward `toward` by `k` (0 = itself, 1 = `toward`). */
function mix(base: string, toward: number, k: number): string {
  const c = parsePineColor(base)!;
  const m = (v: number) => v + (toward - v) * k;
  return `#${hex2(m(c.r))}${hex2(m(c.g))}${hex2(m(c.b))}`.toUpperCase();
}

/**
 * The palette as TradingView lays it out: a row of greys, then each hue from its lightest tint to
 * its darkest shade, one column per hue.
 */
export const PINE_PALETTE: readonly (readonly string[])[] = [
  GREYS,
  ...[0.8, 0.6, 0.4, 0.2].map((k) => HUES.map((h) => mix(h, 255, k))),
  HUES.map((h) => h.toUpperCase()),
  ...[0.25, 0.5].map((k) => HUES.map((h) => mix(h, 0, k))),
];

/** Any colour this console passes around (Pine `#RRGGBB[AA]`, CSS `rgb()`/`rgba()`), parsed. */
export function readColor(value: string | null | undefined): Rgba | null {
  if (!value) return null;
  return parsePineColor(value) ?? parseCssRgb(value);
}

/** Pine `#RRGGBBAA` of a colour. */
export function pineHex(c: Rgba): string {
  return `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}${hex2(c.a * 255)}`.toUpperCase();
}

/**
 * A colour picker for Pine colours (PC-I12): a swatch that opens TradingView's palette — greys and
 * ten hues in tints and shades — with an opacity slider and a custom colour. Picking keeps the
 * opacity the colour had; the slider changes only the opacity. Emits Pine `#RRGGBBAA`.
 */
@Component({
  selector: 'app-pine-color-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:pointerdown)': 'onOutside($event)',
  },
  template: `
    <span class="cp">
      <button
        type="button"
        class="cp-swatch"
        [style.--swatch]="css()"
        [disabled]="disabled()"
        (click)="toggle()"
        [attr.aria-label]="label()"
        [attr.aria-expanded]="open()"
        aria-haspopup="dialog"
        [title]="label()"
        data-testid="color-swatch"
      ></button>
      @if (open()) {
        <div
          class="cp-pop"
          role="dialog"
          [attr.aria-label]="label()"
          (keydown.escape)="close(); $event.stopPropagation()"
        >
          <div class="cp-grid" role="listbox" [attr.aria-label]="label() + ' palette'">
            @for (row of palette; track $index) {
              <div class="cp-row">
                @for (c of row; track c) {
                  <button
                    type="button"
                    class="cp-cell"
                    role="option"
                    [style.background]="c"
                    [class.on]="isCurrent(c)"
                    [attr.aria-selected]="isCurrent(c)"
                    [attr.aria-label]="c"
                    [title]="c"
                    (click)="pick(c)"
                  ></button>
                }
              </div>
            }
          </div>
          <label class="cp-line">
            <span>Opacity</span>
            <input
              type="range"
              min="0"
              max="100"
              step="1"
              [value]="opacity()"
              (input)="setOpacity(+$any($event.target).value)"
              [attr.aria-label]="label() + ' opacity'"
            />
            <span class="cp-num">{{ opacity() }}%</span>
          </label>
          <label class="cp-line">
            <span>Custom</span>
            <input
              type="color"
              [value]="hex()"
              (input)="pick($any($event.target).value)"
              [attr.aria-label]="label() + ' custom colour'"
            />
          </label>
        </div>
      }
    </span>
  `,
  styles: `
    :host {
      display: inline-flex;
      position: relative;
    }
    .cp {
      display: inline-flex;
      position: relative;
    }
    .cp-swatch {
      width: 26px;
      height: 22px;
      padding: 0;
      border: 1px solid var(--tv-line, var(--border, #d6dcde));
      border-radius: 4px;
      cursor: pointer;
      /* The colour over a checkerboard, so opacity shows. */
      background:
        linear-gradient(var(--swatch, transparent), var(--swatch, transparent)),
        repeating-conic-gradient(#d1d4dc 0% 25%, #ffffff 0% 50%) 0 0 / 8px 8px;
    }
    .cp-swatch:disabled {
      cursor: default;
      opacity: 0.5;
    }
    .cp-pop {
      position: absolute;
      top: calc(100% + 4px);
      left: 0;
      z-index: 20;
      padding: 8px;
      background: var(--tv-bg, var(--surface, #fff));
      border-radius: 6px;
      box-shadow:
        0 2px 10px rgba(0, 0, 0, 0.2),
        0 0 0 1px var(--tv-line, #e0e3eb);
    }
    .cp-grid {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .cp-row {
      display: flex;
      gap: 2px;
    }
    .cp-cell {
      width: 18px;
      height: 18px;
      padding: 0;
      border: 1px solid rgba(0, 0, 0, 0.12);
      border-radius: 3px;
      cursor: pointer;
    }
    .cp-cell.on {
      outline: 2px solid var(--accent, #2962ff);
      outline-offset: 1px;
    }
    .cp-line {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 8px;
      font-size: 12px;
      color: var(--tv-muted, #787b86);
    }
    .cp-line input[type='range'] {
      flex: 1;
    }
    .cp-num {
      min-width: 36px;
      text-align: right;
      font-variant-numeric: tabular-nums;
    }
    @media (pointer: coarse) {
      .cp-cell {
        width: 26px;
        height: 26px;
      }
    }
  `,
})
export class PineColorPickerComponent {
  private readonly el = inject(ElementRef<HTMLElement>);

  /** The colour: Pine `#RRGGBB[AA]` or CSS `rgb()` / `rgba()`. */
  readonly value = input<string | null>(null);
  readonly disabled = input(false);
  readonly label = input('Colour');
  /** A new colour, as Pine `#RRGGBBAA`. */
  readonly valueChange = output<string>();

  readonly open = signal(false);
  protected readonly palette = PINE_PALETTE;

  private readonly rgba = computed<Rgba>(
    () => readColor(this.value()) ?? { r: 41, g: 98, b: 255, a: 1 },
  );
  protected readonly css = computed(() => toCss(this.rgba()));
  protected readonly hex = computed(() => pineHex(this.rgba()).slice(0, 7).toLowerCase());
  protected readonly opacity = computed(() => Math.round(this.rgba().a * 100));

  toggle(): void {
    if (!this.disabled()) this.open.set(!this.open());
  }

  close(): void {
    this.open.set(false);
  }

  /** A palette cell or the custom colour: its hue, at the opacity the colour has now. */
  pick(color: string): void {
    const c = readColor(color);
    if (!c) return;
    this.valueChange.emit(pineHex({ ...c, a: this.rgba().a }));
  }

  setOpacity(percent: number): void {
    const a = Math.max(0, Math.min(100, percent)) / 100;
    this.valueChange.emit(pineHex({ ...this.rgba(), a }));
  }

  protected isCurrent(color: string): boolean {
    const c = readColor(color);
    const v = this.rgba();
    return !!c && c.r === v.r && c.g === v.g && c.b === v.b;
  }

  protected onOutside(ev: Event): void {
    if (this.open() && !this.el.nativeElement.contains(ev.target as Node)) this.close();
  }
}
