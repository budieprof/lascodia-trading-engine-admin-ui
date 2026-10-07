import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { TV_PALETTE, formatColor, parseColor } from './colors';

/**
 * TradingView's colour popover: palette grid, "+" custom colour, and an
 * opacity slider. Emits the stored colour string on every change, so callers
 * can preview live.
 */
@Component({
  selector: 'app-color-popover',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="cp" (click)="$event.stopPropagation()" (pointerdown)="$event.stopPropagation()">
      @for (row of palette; track $index) {
        <div class="cp-row" [class.cp-gap]="$index === 2">
          @for (c of row; track c) {
            <button
              type="button"
              class="cp-swatch"
              [class.on]="c === parsed().hex"
              [style.background]="c"
              [attr.aria-label]="c"
              [title]="c"
              (click)="pick(c)"
            ></button>
          }
        </div>
      }
      <div class="cp-sep"></div>
      <div class="cp-custom">
        <label class="cp-plus" title="Custom colour">
          <input type="color" [value]="parsed().hex" (input)="pick($any($event.target).value)" />
          <span>+</span>
        </label>
        <span class="cp-current" [style.background]="value() ?? 'transparent'"></span>
      </div>
      @if (showOpacity()) {
        <div class="cp-opacity">
          <span class="cp-label">Opacity</span>
          <input
            type="range"
            min="0"
            max="100"
            [value]="opacityPct()"
            [style.--cp-color]="parsed().hex"
            (input)="setOpacity(+$any($event.target).value)"
          />
          <span class="cp-pct">{{ opacityPct() }}%</span>
        </div>
      }
    </div>
  `,
  styles: `
    .cp {
      width: 218px;
      padding: 12px;
      background: var(--tv-bg, #fff);
      color: var(--tv-ink, #131722);
      border-radius: 6px;
      box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2), 0 0 0 1px var(--tv-line, #e0e3eb);
    }
    .cp-row { display: flex; gap: 2px; margin-bottom: 2px; }
    .cp-gap { margin-top: 8px; }
    .cp-swatch {
      width: 18px; height: 18px; padding: 0; border-radius: 2px;
      border: 1px solid rgba(0, 0, 0, 0.08); cursor: pointer;
    }
    .cp-swatch:hover { transform: scale(1.15); }
    .cp-swatch.on { outline: 2px solid var(--tv-blue, #2962ff); outline-offset: 1px; }
    .cp-sep { height: 1px; background: var(--tv-line, #e0e3eb); margin: 10px 0; }
    .cp-custom { display: flex; align-items: center; gap: 8px; }
    .cp-plus {
      position: relative; width: 22px; height: 22px; border-radius: 4px;
      border: 1px dashed var(--tv-muted, #787b86); display: inline-flex;
      align-items: center; justify-content: center; cursor: pointer; color: var(--tv-muted, #787b86);
      /* the invisible colour input must not reach past the "+": mobile browsers size form inputs themselves */
      overflow: hidden;
    }
    .cp-plus input {
      position: absolute; inset: 0; width: 100%; height: 100%; min-width: 0;
      margin: 0; padding: 0; border: 0; opacity: 0; cursor: pointer;
    }
    .cp-current { width: 22px; height: 22px; border-radius: 4px; border: 1px solid var(--tv-line, #e0e3eb); }
    .cp-opacity { display: flex; align-items: center; gap: 8px; margin-top: 10px; font-size: 12px; }
    .cp-opacity input { flex: 1; accent-color: var(--cp-color); }
    .cp-label, .cp-pct { color: var(--tv-muted, #787b86); }
    .cp-pct { width: 34px; text-align: right; }
  `,
})
export class ColorPopoverComponent {
  readonly value = input<string | null>(null);
  readonly showOpacity = input(true);
  readonly changed = output<string>();

  readonly palette = TV_PALETTE;
  readonly parsed = computed(() => parseColor(this.value()));
  readonly opacityPct = computed(() => Math.round(this.parsed().alpha * 100));

  pick(hex: string): void {
    this.changed.emit(formatColor(hex, this.parsed().alpha));
  }

  setOpacity(pct: number): void {
    this.changed.emit(formatColor(this.parsed().hex, pct / 100));
  }
}
