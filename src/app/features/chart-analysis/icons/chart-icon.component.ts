import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { DomSanitizer } from '@angular/platform-browser';
import { UI_ICONS } from './ui-icons';
import { TOOL_ICONS } from './tool-icons';
import { CHART_TYPE_ICONS } from './chart-type-icons';

/**
 * Line icon in the chart's visual language: 28×28 grid, 1px strokes in
 * `currentColor`, no fill except small solid accents — so every icon inherits
 * the button's text colour, hover and active states, in both themes.
 *
 * Looks the name up in the UI set, then the drawing-tool set (keyed by
 * `DrawingKind`). The markup is static source in this folder, never user data,
 * which is why it is marked trusted.
 */
@Component({
  selector: 'app-chart-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'chart-icon', '[style.width.px]': 'size()', '[style.height.px]': 'size()' },
  template: `<svg
    viewBox="0 0 28 28"
    [attr.width]="size()"
    [attr.height]="size()"
    fill="none"
    stroke="currentColor"
    stroke-width="1"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
    [innerHTML]="markup()"
  ></svg>`,
  styles: `
    :host {
      display: inline-flex;
      flex: none;
      align-items: center;
      justify-content: center;
      line-height: 0;
    }
    svg {
      display: block;
      overflow: visible;
    }
  `,
})
export class ChartIconComponent {
  private readonly sanitizer = inject(DomSanitizer);
  readonly name = input.required<string>();
  readonly size = input(28);

  readonly markup = computed(() =>
    this.sanitizer.bypassSecurityTrustHtml(
      UI_ICONS[this.name()] ??
        CHART_TYPE_ICONS[this.name()] ??
        (TOOL_ICONS as Record<string, string>)[this.name()] ??
        UI_ICONS['fallback'],
    ),
  );
}

export function hasChartIcon(name: string): boolean {
  return name in UI_ICONS || name in TOOL_ICONS || name in CHART_TYPE_ICONS;
}
