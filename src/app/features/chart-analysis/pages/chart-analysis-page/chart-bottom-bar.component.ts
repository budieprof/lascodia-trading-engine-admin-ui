import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { ChartIconComponent } from '../../icons/chart-icon.component';

/** The bottom bar's menus. Their open state is the page's, so one menu is open at a time. */
export type BottomBarMenu = 'range' | 'tz';
type ScaleMode = 'normal' | 'log' | 'percent';

/**
 * The chart's bottom bar, as TradingView lays it out: date-range presets, go to date, the dock's
 * tabs (Pine Editor, Strategy Tester), the bars loaded, the clock on the chart's time zone, and the
 * price scale's modes. It holds no state of its own; the page owns every value and acts on every
 * event.
 *
 * <p>Narrow, it gives up what matters least first (TradingView's narrow layout): the bar count,
 * then the nine presets, which fold behind one "Range" button. The bar itself is the container, so
 * its own width decides — the sidebar takes 0, 72 or 260px of the window.</p>
 */
@Component({
  selector: 'app-chart-bottom-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ChartIconComponent],
  template: `
    <footer class="bottom-bar">
      <div class="bb-ranges" role="group" aria-label="Date range">
        @for (r of presets(); track r.id) {
          <button type="button" class="bb-btn" (click)="range.emit(r.id)" [title]="r.title">
            {{ r.id }}
          </button>
        }
      </div>
      <div class="bb-anchor bb-range-anchor">
        <button
          type="button"
          class="bb-btn bb-range-btn"
          [class.open]="menu() === 'range'"
          (click)="menuToggle.emit({ menu: 'range', event: $event })"
          title="Date range"
          aria-haspopup="menu"
          [attr.aria-expanded]="menu() === 'range'"
        >
          Range <app-chart-icon name="caret" [size]="16" />
        </button>
        @if (menu() === 'range') {
          <div class="bb-menu" role="menu" (click)="$event.stopPropagation()">
            @for (r of presets(); track r.id) {
              <button type="button" role="menuitem" class="bb-menu-item" (click)="range.emit(r.id)">
                <b>{{ r.id }}</b
                ><span>{{ r.title }}</span>
              </button>
            }
          </div>
        }
      </div>
      <div class="bb-sep"></div>
      <label class="bb-btn bb-goto" title="Go to date">
        <app-chart-icon name="goto-date" [size]="22" />
        <input
          type="date"
          (change)="goToDate.emit($any($event.target).value)"
          aria-label="Go to date"
        />
      </label>
      <div class="bb-sep"></div>
      <button
        type="button"
        class="bb-btn bb-tab"
        [class.active]="dockTab() === 'editor'"
        (click)="editor.emit()"
      >
        Pine Editor
      </button>
      <button
        type="button"
        class="bb-btn bb-tab"
        [class.active]="dockTab() === 'tester'"
        (click)="tester.emit()"
        [title]="hasStrategy() ? 'Strategy Tester' : 'Add a strategy to the chart to test it'"
      >
        Strategy Tester
      </button>
      <span class="bb-spacer"></span>
      <span class="bb-status">{{ barCount() }} bars</span>
      <div class="bb-anchor">
        <button
          type="button"
          class="bb-btn bb-clock"
          (click)="menuToggle.emit({ menu: 'tz', event: $event })"
          title="Timezone"
        >
          {{ clock() }} {{ zone() }}
        </button>
        @if (menu() === 'tz') {
          <div class="bb-menu bb-menu-tz" role="menu" (click)="$event.stopPropagation()">
            @for (tz of timezones(); track tz.id) {
              <button
                type="button"
                class="bb-menu-item"
                [class.selected]="timezone() === tz.id"
                (click)="timezoneChange.emit(tz.id)"
              >
                {{ tz.label }}
              </button>
            }
          </div>
        }
      </div>
      <div class="bb-sep"></div>
      <button
        type="button"
        class="bb-btn"
        [class.on]="scaleMode() === 'percent'"
        (click)="scaleModeChange.emit(scaleMode() === 'percent' ? 'normal' : 'percent')"
        title="Percentage scale"
      >
        %
      </button>
      <button
        type="button"
        class="bb-btn"
        [class.on]="scaleMode() === 'log'"
        (click)="scaleModeChange.emit(scaleMode() === 'log' ? 'normal' : 'log')"
        title="Logarithmic scale"
      >
        log
      </button>
      <button
        type="button"
        class="bb-btn"
        [class.on]="scaleMode() === 'normal'"
        (click)="autoScale.emit()"
        title="Auto (fits data to screen)"
      >
        auto
      </button>
    </footer>
  `,
  styles: `
    :host {
      display: block;
      flex: none;
      container: bottom-bar / inline-size;
    }

    /* With a mouse at 1280px and up the shell keeps the page under the floating Ask button
       (layout.component.ts lifts it only for touch or narrow screens), and Ask covered the lower
       half of "log" and "auto". Keep the bar's right end clear of it rather than give up chart
       height: Ask is ~76px wide and 20px off the window's edge, the page ends ~33px from it, plus
       an 8px gap. On the host, so the container queries below measure what is left. */
    @media (min-width: 1280px) and (not (pointer: coarse)) {
      :host {
        padding-right: 68px;
        background: var(--tv-bg);
      }
    }

    .bottom-bar {
      display: flex;
      align-items: center;
      height: 32px;
      padding: 0 4px;
      background: var(--tv-bg);
      font-size: 12px;
    }

    .bb-ranges {
      display: flex;
      flex: none;
    }

    .bb-sep {
      flex: none;
      width: 1px;
      height: 18px;
      margin: 0 4px;
      background: var(--tv-line);
    }

    // Never squeezed: below their size the labels ran into each other. Narrow, items go instead.
    .bb-btn {
      display: inline-flex;
      align-items: center;
      flex: none;
      height: 26px;
      padding: 0 7px;
      border: 0;
      border-radius: 4px;
      background: transparent;
      color: var(--tv-ink);
      font: inherit;
      white-space: nowrap;
      cursor: pointer;

      &:hover:not(:disabled),
      &.open {
        background: var(--tv-hover);
      }

      &.on,
      &.active {
        color: var(--tv-blue);
      }

      &:disabled {
        opacity: 0.4;
        cursor: default;
      }
    }

    .bb-tab.active {
      background: var(--tv-active-bg);
    }

    // The calendar icon is an invisible date input laid over it. Chrome on Android gives date inputs
    // a width of their own (10em), which beats \`inset: 0\`: the input ran ~130px right, over the
    // separator and the Pine Editor tab, so tapping the tab opened the date picker. Size it to the
    // icon AND clip it.
    .bb-goto {
      position: relative;
      // Clipping drops a flex item's content-sized minimum: without this a crowded bar squeezed the
      // label to its padding and hid the icon.
      flex: none;
      padding: 0 4px;
      overflow: hidden;

      input {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        min-width: 0;
        margin: 0;
        padding: 0;
        border: 0;
        opacity: 0;
        cursor: pointer;
      }
    }

    .bb-clock {
      font-variant-numeric: tabular-nums;
    }

    .bb-spacer {
      flex: 1 1 auto;
    }

    .bb-status {
      margin-right: 8px;
      color: var(--tv-muted);
      white-space: nowrap;
    }

    .bb-anchor {
      position: relative;
      display: inline-flex;
      flex: none;
    }

    // Menus open upwards, over the chart.
    .bb-menu {
      position: absolute;
      bottom: calc(100% + 2px);
      left: 0;
      z-index: 60;
      min-width: 200px;
      max-height: min(560px, 75vh);
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      padding: 6px 0;
      background: var(--tv-bg);
      border-radius: 6px;
      box-shadow:
        var(--tv-menu-shadow),
        0 0 0 1px var(--tv-line);
    }

    .bb-menu-tz {
      left: auto;
      right: 0;
      min-width: 180px;
    }

    .bb-menu-item {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      min-height: 32px;
      padding: 0 16px;
      border: 0;
      background: transparent;
      color: var(--tv-ink);
      font: inherit;
      text-align: left;
      white-space: nowrap;
      cursor: pointer;

      &:hover {
        background: var(--tv-hover);
      }

      &.selected {
        background: var(--tv-ink);
        color: var(--tv-bg);
      }

      b {
        min-width: 28px;
        font-weight: 600;
      }

      span {
        color: var(--tv-muted);
      }
    }

    .bb-range-anchor {
      display: none;
    }

    // The full bar needs ~770px (the host, the container, has no padding of its own); the
    // thresholds leave room for a longer zone label.
    @container bottom-bar (max-width: 799px) {
      .bb-status {
        display: none;
      }
    }

    @container bottom-bar (max-width: 739px) {
      .bb-ranges {
        display: none;
      }

      .bb-range-anchor {
        display: inline-flex;
      }
    }

    // A finger needs ~40px; the buttons are 26px for a mouse. Desktop is unchanged.
    @media (pointer: coarse) {
      .bottom-bar {
        height: 40px;
      }

      .bb-btn,
      .bb-menu-item {
        min-height: 40px;
      }
    }
  `,
})
export class ChartBottomBarComponent {
  readonly presets = input<ReadonlyArray<{ id: string; title: string }>>([]);
  readonly barCount = input(0);
  /** The clock, on the chart's time zone, and the zone's short name. */
  readonly clock = input('');
  readonly zone = input('');
  readonly timezone = input('UTC');
  readonly timezones = input<ReadonlyArray<{ id: string; label: string }>>([]);
  readonly scaleMode = input<ScaleMode>('normal');
  /** The dock's tab in front, if it is open. */
  readonly dockTab = input<'editor' | 'tester' | null>(null);
  /** A strategy is on the chart (the Strategy Tester's tooltip). */
  readonly hasStrategy = input(false);
  /** The page's open menu, whichever bar it belongs to. */
  readonly menu = input<string | null>(null);

  /** A date-range preset, by id. */
  readonly range = output<string>();
  /** A day to centre the chart on (`yyyy-mm-dd`). */
  readonly goToDate = output<string>();
  readonly editor = output<void>();
  readonly tester = output<void>();
  /** Open or close one of the bar's menus (the click is the page's to stop). */
  readonly menuToggle = output<{ menu: BottomBarMenu; event: Event }>();
  readonly timezoneChange = output<string>();
  readonly scaleModeChange = output<ScaleMode>();
  readonly autoScale = output<void>();
}
