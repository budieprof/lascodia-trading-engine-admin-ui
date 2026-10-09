import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  afterNextRender,
  computed,
  effect,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';

import type { ScriptInputDto, ScriptInputValues } from '@core/api/scripting.types';
import { InputsFormComponent } from '@features/scripting/components/inputs-form/inputs-form.component';
import {
  coerceInputValue,
  inputOverrides,
  resolveInputValues,
  sameInputValues,
} from '@features/scripting/pine/pine-inputs';
import { MAX_TEMPLATE_NAME, type ScriptInputTemplate } from './script-input-templates';
import { PineColorPickerComponent } from '@shared/pine-chart/components/pine-color-picker.component';
import { parsePineColor, toCss } from '@shared/pine-chart/core/color';
import type { PinePlotStyle } from '@shared/pine-chart/model/pine-outputs.types';
import {
  DEFAULT_DISPLAY,
  TIMEFRAME_UNITS,
  type OutputStyle,
  type ScriptDisplaySettings,
  type StyleOutput,
  type TimeframeRange,
  type TimeframeUnit,
  type TimeframeVisibility,
} from './script-display';

/** Edits apply live; a burst of them (a colour being dragged) settles into one re-run. */
export const SCRIPT_SETTINGS_APPLY_MS = 200;

/** A time or price input picked on the chart (PC-I12). */
export interface InputPick {
  inputId: string;
  kind: 'time' | 'price';
}

/**
 * TradingView's study Settings dialog for a Pine script on the chart: its inputs laid out as the
 * script declares them (the shared inputs form — `group` headings, `inline` rows, tooltips), its
 * Style (each output's visibility, colours, width and plot style; precision, labels on the price
 * scale, values in the status line, trades on chart, behind or in front of the bars, tables) and
 * its Visibility (the timeframes it shows on), with Defaults ▾ (reset, save as default, named
 * templates) / Cancel / Ok.
 *
 * Edits preview live on the chart, as in TradingView: each input edit is emitted as `changed` (only
 * the inputs that differ from their defaults) once the edits pause for
 * {@link SCRIPT_SETTINGS_APPLY_MS} — it re-runs the script; a Style or Visibility edit is emitted
 * at once as `displayChange` — it is applied on the client, no re-run. Ok keeps them; Cancel, × and
 * Esc put back what the dialog opened with.
 *
 * <p>A time or price input is picked on the chart (PC-I12): the dialog steps aside, emits
 * `pickOnChart`, and the page hands the picked value back through {@link finishPick}. Opened as
 * the script is added with `confirm = true` inputs (`confirm`), it asks for those only — the time
 * and price ones on the chart first — and Cancel takes the script off the chart.</p>
 */
@Component({
  selector: 'app-script-settings-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [InputsFormComponent, PineColorPickerComponent],
  template: `
    <!-- A click beside the confirm prompt does not take the script just added off the chart. -->
    <div
      class="sd-backdrop"
      [class.sd-off]="!!picking()"
      (pointerdown)="confirm() ? null : cancel()"
    ></div>
    <div
      #box
      class="sd"
      [class.sd-off]="!!picking()"
      role="dialog"
      aria-modal="true"
      tabindex="-1"
      [attr.aria-label]="title() + (confirm() ? ' — confirm inputs' : ' settings')"
      (keydown)="$event.stopPropagation()"
      (keydown.escape)="cancel()"
    >
      <header class="sd-head">
        <span class="sd-title" [title]="title()">{{ title() }}</span>
        <button type="button" class="sd-x" aria-label="Close" (click)="cancel()">×</button>
      </header>
      @if (confirm()) {
        <p class="sd-confirm" data-testid="script-confirm">
          Confirm the inputs to add it to the chart.
        </p>
      }
      <nav class="sd-tabs" role="tablist">
        @for (t of tabs(); track t.id) {
          <button
            type="button"
            role="tab"
            class="sd-tab"
            [class.on]="tab() === t.id"
            [attr.aria-selected]="tab() === t.id"
            (click)="tab.set(t.id)"
          >
            {{ t.label }}
          </button>
        }
      </nav>
      <div class="sd-body">
        @switch (tab()) {
          @case ('style') {
            @let d = draftDisplay();
            <div class="sd-style" data-testid="script-style-tab">
              @for (o of styleOutputs(); track o.key) {
                <div class="sd-out">
                  <label class="sd-check">
                    <input
                      type="checkbox"
                      [checked]="outputShown(o.key)"
                      (change)="setOutput(o.key, { visible: $any($event.target).checked })"
                    />
                    <span class="sd-out-title" [title]="o.title">{{ o.title }}</span>
                  </label>
                  <span class="sd-out-tools">
                    @for (c of o.colors; track c) {
                      <app-pine-color-picker
                        [value]="colorOf(o.key, c)"
                        [label]="o.title + ' colour'"
                        (valueChange)="setColor(o.key, c, $event)"
                      />
                    }
                    @if (o.lineWidth !== null) {
                      <select
                        class="sd-sel"
                        [attr.aria-label]="o.title + ' line width'"
                        (change)="setOutput(o.key, { lineWidth: +$any($event.target).value })"
                      >
                        @for (w of widths; track w) {
                          <option [value]="w" [selected]="w === widthOf(o)">{{ w }} px</option>
                        }
                      </select>
                    }
                    @if (o.plotStyle) {
                      <select
                        class="sd-sel"
                        [attr.aria-label]="o.title + ' style'"
                        (change)="setOutput(o.key, { plotStyle: $any($event.target).value })"
                      >
                        @for (s of plotStyles; track s.id) {
                          <option [value]="s.id" [selected]="s.id === styleOf(o)">
                            {{ s.label }}
                          </option>
                        }
                      </select>
                    }
                  </span>
                </div>
              } @empty {
                <p class="sd-hint">This script draws nothing to style.</p>
              }
              <h4 class="sd-h">Values</h4>
              <label class="sd-line">
                <span>Precision</span>
                <select
                  class="sd-sel"
                  aria-label="Precision"
                  (change)="setPrecision($any($event.target).value)"
                >
                  <option value="" [selected]="d.precision === null">Default</option>
                  @for (p of precisions; track p) {
                    <option [value]="p" [selected]="d.precision === p">{{ p }}</option>
                  }
                </select>
              </label>
              <label class="sd-check">
                <input
                  type="checkbox"
                  [checked]="d.labelsOnScale"
                  (change)="setDisplay({ labelsOnScale: $any($event.target).checked })"
                />
                <span>Labels on price scale</span>
              </label>
              <label class="sd-check">
                <input
                  type="checkbox"
                  [checked]="d.valuesInStatusLine"
                  (change)="setDisplay({ valuesInStatusLine: $any($event.target).checked })"
                />
                <span>Values in status line</span>
              </label>
              @if (scriptKind() === 'strategy') {
                <label class="sd-check">
                  <input
                    type="checkbox"
                    [checked]="d.showTrades"
                    (change)="setDisplay({ showTrades: $any($event.target).checked })"
                  />
                  <span>Trades on chart</span>
                </label>
              }
              @if (overlay()) {
                <label class="sd-line">
                  <span>Draw</span>
                  <select
                    class="sd-sel"
                    aria-label="Draw behind or in front of the bars"
                    (change)="setBehind($any($event.target).value)"
                  >
                    <option value="" [selected]="d.behindChart === null">As the script says</option>
                    <option value="behind" [selected]="d.behindChart === true">
                      Behind the bars
                    </option>
                    <option value="front" [selected]="d.behindChart === false">
                      In front of the bars
                    </option>
                  </select>
                </label>
              }
              @if (hasTables()) {
                <label class="sd-check">
                  <input
                    type="checkbox"
                    [checked]="d.showTables"
                    (change)="setDisplay({ showTables: $any($event.target).checked })"
                  />
                  <span>Tables</span>
                </label>
                <label
                  class="sd-check"
                  title="Text that reads poorly on its cell turns black or white"
                >
                  <input
                    type="checkbox"
                    [checked]="d.tableContrast"
                    [disabled]="!d.showTables"
                    (change)="setDisplay({ tableContrast: $any($event.target).checked })"
                  />
                  <span>Keep table text readable</span>
                </label>
              }
            </div>
          }
          @case ('visibility') {
            <div class="sd-vis" data-testid="script-visibility-tab">
              @for (u of units; track u.unit) {
                @let row = rowOf(u.unit, u.max);
                <div class="sd-vrow">
                  <label class="sd-check">
                    <input
                      type="checkbox"
                      [checked]="row.on"
                      (change)="setRow(u.unit, u.max, { on: $any($event.target).checked })"
                    />
                    <span>{{ u.label }}</span>
                  </label>
                  <input
                    type="number"
                    class="sd-num"
                    min="1"
                    [max]="u.max"
                    [value]="row.from"
                    [disabled]="!row.on"
                    [attr.aria-label]="u.label + ' from'"
                    (change)="setRow(u.unit, u.max, { from: +$any($event.target).value })"
                  />
                  <span class="sd-dash">–</span>
                  <input
                    type="number"
                    class="sd-num"
                    min="1"
                    [max]="u.max"
                    [value]="row.to"
                    [disabled]="!row.on"
                    [attr.aria-label]="u.label + ' to'"
                    (change)="setRow(u.unit, u.max, { to: +$any($event.target).value })"
                  />
                </div>
              }
            </div>
          }
          @default {
            @if (formInputs(); as list) {
              <app-inputs-form
                [inputs]="list"
                [overrides]="draft()"
                (overridesChange)="edit($event)"
                [showReset]="false"
                [symbols]="symbols()"
                [pickOnChartEnabled]="pickEnabled()"
                (pickOnChart)="startPick($event)"
                emptyText="This script has no inputs."
              />
            } @else {
              <p class="sd-hint" role="status">Loading the strategy's saved inputs…</p>
            }
          }
        }
      </div>
      <footer class="sd-foot">
        @if (!confirm()) {
          <span class="sd-anchor">
            <button
              type="button"
              class="sd-btn"
              aria-haspopup="menu"
              [attr.aria-expanded]="menuOpen()"
              (click)="toggleMenu()"
            >
              Defaults ▾
            </button>
            @if (menuOpen()) {
              <div class="sd-menu" role="menu" data-testid="script-defaults-menu">
                <button
                  type="button"
                  role="menuitem"
                  [disabled]="!changedCount()"
                  (click)="reset()"
                  title="Put every input back to the script's own defaults"
                >
                  Reset to defaults
                </button>
                @if (canSaveDefault()) {
                  <button
                    type="button"
                    role="menuitem"
                    [disabled]="savingDefault() || !inputs()"
                    (click)="saveAsDefault()"
                    title="A copy of this script added to a chart starts with these inputs"
                  >
                    {{ savingDefault() ? 'Saving…' : 'Save as default' }}
                  </button>
                }
                <!-- Named templates (PC-I12): saved with the chart preferences, on every chart. -->
                <div class="sd-sep" role="separator"></div>
                @if (naming()) {
                  <form class="sd-name" (submit)="$event.preventDefault(); saveAsTemplate(name.value)">
                    <input
                      #name
                      class="sd-sel"
                      type="text"
                      [attr.maxlength]="maxName"
                      placeholder="Template name"
                      aria-label="Template name"
                      (keydown.escape)="naming.set(false); $event.stopPropagation()"
                    />
                    <button type="submit" class="sd-btn sd-small">Save</button>
                  </form>
                } @else {
                  <button
                    type="button"
                    role="menuitem"
                    [disabled]="!inputs()"
                    (click)="startNaming()"
                    title="Keep these inputs under a name, to apply to this script on any chart"
                  >
                    Save as template…
                  </button>
                }
                @for (t of templates(); track t.name) {
                  <div class="sd-tpl">
                    <button
                      type="button"
                      role="menuitem"
                      class="sd-tpl-name"
                      [title]="'Apply the inputs saved as “' + t.name + '”'"
                      (click)="applyTemplate(t)"
                    >
                      {{ t.name }}
                    </button>
                    <button
                      type="button"
                      class="sd-tpl-x"
                      [attr.aria-label]="'Delete the template ' + t.name"
                      title="Delete this template"
                      (click)="deleteTemplate.emit(t.name)"
                    >
                      ×
                    </button>
                  </div>
                }
              </div>
            }
          </span>
        }
        @if (changedCount(); as n) {
          <span class="sd-note">{{ n }} changed from default</span>
        }
        <span class="sd-spacer"></span>
        <button type="button" class="sd-btn" (click)="cancel()">Cancel</button>
        <button type="button" class="sd-btn primary" (click)="ok()">Ok</button>
      </footer>
    </div>
  `,
  styles: `
    /* No box of its own: the page lays its panes out with gaps, and a modal is not one of them. */
    :host {
      display: contents;
    }
    .sd-backdrop {
      position: fixed;
      inset: 0;
      z-index: 1000;
      background: rgba(0, 0, 0, 0.2);
    }
    .sd {
      position: fixed;
      z-index: 1001;
      left: 50%;
      top: 50%;
      transform: translate(-50%, -50%);
      width: min(540px, calc(100vw - 32px));
      max-height: calc(100vh - 64px);
      display: flex;
      flex-direction: column;
      background: var(--tv-bg, #fff);
      color: var(--tv-ink, #131722);
      border-radius: 6px;
      box-shadow: 0 2px 24px rgba(0, 0, 0, 0.3);
      font-size: 14px;
      outline: none;
    }
    .sd-head {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 16px 20px 10px;
    }
    .sd-title {
      flex: 1;
      min-width: 0;
      font-size: 20px;
      font-weight: 600;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .sd-x {
      border: 0;
      background: none;
      color: var(--tv-muted, #787b86);
      font-size: 24px;
      cursor: pointer;
      line-height: 1;
    }
    .sd-tabs {
      display: flex;
      gap: 18px;
      padding: 0 20px;
      border-bottom: 1px solid var(--tv-line, #e0e3eb);
    }
    .sd-tab {
      padding: 8px 0;
      margin-bottom: -1px;
      border: 0;
      border-bottom: 3px solid transparent;
      background: none;
      color: var(--tv-muted, #787b86);
      font: inherit;
      cursor: pointer;
    }
    .sd-tab.on {
      color: var(--tv-ink, #131722);
      border-bottom-color: var(--tv-ink, #131722);
    }
    .sd-style,
    .sd-vis {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .sd-out {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      min-width: 0;
    }
    .sd-out-tools {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      flex: none;
    }
    .sd-out-title {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .sd-check {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }
    .sd-line {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .sd-h {
      margin: 10px 0 0;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--tv-muted, #787b86);
    }
    .sd-sel,
    .sd-num {
      height: 28px;
      padding: 0 6px;
      border: 1px solid var(--tv-line, #e0e3eb);
      border-radius: 4px;
      background: var(--tv-bg, #fff);
      color: inherit;
      font: inherit;
    }
    .sd-num {
      width: 64px;
    }
    .sd-vrow {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .sd-vrow .sd-check {
      width: 110px;
    }
    .sd-dash {
      color: var(--tv-muted, #787b86);
    }
    .sd-body {
      flex: 1;
      min-height: 120px;
      padding: 14px 20px;
      overflow: auto;
    }
    .sd-hint {
      margin: 0;
      color: var(--tv-muted, #787b86);
      font-size: 13px;
    }
    .sd-foot {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 14px 20px;
      border-top: 1px solid var(--tv-line, #e0e3eb);
    }
    .sd-spacer {
      flex: 1;
    }
    .sd-note {
      color: var(--tv-muted, #787b86);
      font-size: 12px;
      white-space: nowrap;
    }
    .sd-anchor {
      position: relative;
      display: inline-flex;
    }
    .sd-btn {
      height: 34px;
      padding: 0 16px;
      border-radius: 6px;
      border: 1px solid var(--tv-line, #e0e3eb);
      background: var(--tv-bg, #fff);
      color: inherit;
      font: inherit;
      cursor: pointer;
      white-space: nowrap;
    }
    .sd-btn:hover {
      background: var(--tv-hover, #f0f3fa);
    }
    .sd-btn.primary {
      background: var(--tv-ink, #131722);
      color: var(--tv-bg, #fff);
      border-color: var(--tv-ink, #131722);
    }
    .sd-menu {
      position: absolute;
      bottom: calc(100% + 4px);
      left: 0;
      z-index: 5;
      min-width: 200px;
      padding: 6px 0;
      background: var(--tv-bg, #fff);
      border-radius: 6px;
      box-shadow:
        var(--tv-menu-shadow, 0 2px 4px rgba(0, 0, 0, 0.2)),
        0 0 0 1px var(--tv-line, #e0e3eb);
    }
    .sd-menu button {
      display: block;
      width: 100%;
      padding: 8px 14px;
      border: 0;
      background: none;
      color: inherit;
      font: inherit;
      text-align: left;
      cursor: pointer;
    }
    .sd-menu button:hover:not(:disabled) {
      background: var(--tv-hover, #f0f3fa);
    }
    .sd-menu button:disabled {
      color: var(--tv-muted, #787b86);
      cursor: default;
    }
    /* Picking a time or price on the chart: the dialog steps aside until the click. */
    .sd-off {
      display: none !important;
    }
    .sd-confirm {
      margin: 0 20px 6px;
      color: var(--tv-muted, #787b86);
      font-size: 13px;
    }
    .sd-sep {
      height: 1px;
      margin: 6px 0;
      background: var(--tv-line, #e0e3eb);
    }
    .sd-name {
      display: flex;
      gap: 6px;
      padding: 4px 10px;
    }
    .sd-name .sd-sel {
      flex: 1;
      min-width: 0;
    }
    .sd-menu .sd-name button.sd-small {
      width: auto;
      height: 28px;
      padding: 0 10px;
      border: 1px solid var(--tv-line, #e0e3eb);
      border-radius: 4px;
    }
    .sd-tpl {
      display: flex;
      align-items: center;
    }
    .sd-menu .sd-tpl .sd-tpl-name {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .sd-menu .sd-tpl .sd-tpl-x {
      width: auto;
      padding: 8px 12px;
      color: var(--tv-muted, #787b86);
    }
    @media (max-width: 480px) {
      .sd-note {
        display: none;
      }
      .sd-btn {
        padding: 0 12px;
      }
    }
    /* A finger needs ~40px: Ok, Cancel, Defaults and the Defaults menu are sized for a mouse (34px
       buttons, ~35px items). The chart page gives its own controls the same room on touch. */
    @media (pointer: coarse) {
      .sd-btn {
        height: 40px;
      }
      .sd-menu button {
        min-height: 40px;
      }
    }
  `,
})
export class ScriptSettingsDialogComponent implements OnDestroy {
  /** The script's name, as its chip shows it. */
  readonly title = input('');
  /** The script's inputs; null while the defaults are still being read (an engine strategy's). */
  readonly inputs = input<readonly ScriptInputDto[] | null>(null);
  /** The overrides the script runs with on the chart. */
  readonly values = input<ScriptInputValues>({});
  /** The script is saved in the engine ("My scripts"), so it can keep default inputs. */
  readonly canSaveDefault = input(false);
  readonly savingDefault = input(false);
  /**
   * How the script is shown (PC-01, PC-I4): its Style and Visibility tabs edit it, applied on the
   * client — no re-run. Null: the dialog shows its Inputs only.
   */
  readonly display = input<ScriptDisplaySettings | null>(null);
  /** The outputs its Style tab lists, with the colours they draw in now. */
  readonly styleOutputs = input<readonly StyleOutput[]>([]);
  readonly scriptKind = input<'indicator' | 'strategy' | 'library'>('indicator');
  /** Drawn on the price pane: "behind the bars" applies. */
  readonly overlay = input(true);
  readonly hasTables = input(false);
  /** The symbols an `input.symbol` field suggests (the console's currency pairs). */
  readonly symbols = input<readonly string[]>([]);
  /** Time and price inputs can be picked on the chart (the page answers {@link pickOnChart}). */
  readonly pickEnabled = input(false);
  /**
   * The script was just added and declares `confirm = true` inputs: the dialog asks for those
   * only, the time and price ones on the chart first, and Cancel takes the script off the chart.
   */
  readonly confirm = input(false);
  /** The script's named input templates (Defaults ▾), newest first. */
  readonly templates = input<readonly ScriptInputTemplate[]>([]);

  /** New overrides to run the script with (only the inputs that differ from their defaults). */
  readonly changed = output<ScriptInputValues>();
  /** "Save as default" with these overrides. */
  readonly saveDefault = output<ScriptInputValues>();
  /** New display settings, applied at once (Cancel puts back those the dialog opened with). */
  readonly displayChange = output<ScriptDisplaySettings>();
  readonly closed = output<void>();
  /** Pick this input on the chart; the page answers with {@link finishPick}. */
  readonly pickOnChart = output<InputPick>();
  /** Cancel on the confirm prompt: the script just added leaves the chart. */
  readonly confirmCancelled = output<void>();
  /** "Save as template…" with this name and these overrides. */
  readonly saveTemplate = output<{ name: string; values: ScriptInputValues }>();
  readonly deleteTemplate = output<string>();

  /** TradingView's tabs: Inputs, Style, Visibility — the confirm prompt has its inputs only. */
  readonly tab = signal<'inputs' | 'style' | 'visibility'>('inputs');
  readonly tabs = computed(() =>
    this.display() === null || this.confirm()
      ? [{ id: 'inputs' as const, label: 'Inputs' }]
      : [
          { id: 'inputs' as const, label: 'Inputs' },
          { id: 'style' as const, label: 'Style' },
          { id: 'visibility' as const, label: 'Visibility' },
        ],
  );
  /** The inputs the form shows: the `confirm = true` ones on the confirm prompt; null while read. */
  readonly formInputs = computed<readonly ScriptInputDto[] | null>(() => {
    const list = this.inputs();
    if (!list || !this.confirm()) return list;
    return list.filter((i) => i.confirm);
  });
  /** The input being picked on the chart: the dialog steps aside meanwhile. */
  readonly picking = signal<InputPick | null>(null);
  /** "Save as template…" asks for a name. */
  readonly naming = signal(false);
  protected readonly maxName = MAX_TEMPLATE_NAME;
  /** The confirm prompt's time and price inputs still to pick, in order. */
  private pickQueue: ScriptInputDto[] = [];
  private autoPicked = false;
  /** The display settings the tabs show — what the chart shows (they apply at once). */
  readonly draftDisplay = signal<ScriptDisplaySettings>(DEFAULT_DISPLAY);
  /** The display settings the dialog opened with: what Cancel puts back. */
  private openedDisplay: ScriptDisplaySettings | null = null;
  protected readonly widths = [1, 2, 3, 4];
  protected readonly precisions = [0, 1, 2, 3, 4, 5, 6, 7, 8];
  protected readonly units = TIMEFRAME_UNITS;
  protected readonly plotStyles: { id: PinePlotStyle; label: string }[] = [
    { id: 'line', label: 'Line' },
    { id: 'linebr', label: 'Line with breaks' },
    { id: 'stepline', label: 'Step line' },
    { id: 'steplinebr', label: 'Step line with breaks' },
    { id: 'stepline_diamond', label: 'Step line with diamonds' },
    { id: 'histogram', label: 'Histogram' },
    { id: 'columns', label: 'Columns' },
    { id: 'area', label: 'Area' },
    { id: 'areabr', label: 'Area with breaks' },
    { id: 'circles', label: 'Circles' },
    { id: 'cross', label: 'Cross' },
  ];

  /** The overrides the form shows — ahead of `values` while an edit waits to apply. */
  readonly draft = signal<ScriptInputValues>({});
  readonly menuOpen = signal(false);
  readonly changedCount = computed(() => Object.keys(this.overridesOf(this.draft())).length);

  private readonly box = viewChild<ElementRef<HTMLElement>>('box');
  /** The values the dialog opened with: what Cancel puts back. */
  private opened: ScriptInputValues | null = null;
  /** The newest values the chart runs with, as far as this dialog knows (emitted or received). */
  private applied: ScriptInputValues = {};
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closedOnce = false;

  constructor() {
    effect(() => {
      const values = this.values();
      untracked(() => this.receive(values));
    });
    effect(() => {
      const display = this.display();
      untracked(() => this.receiveDisplay(display));
    });
    // The confirm prompt asks for its time and price inputs on the chart first, one after the
    // other, as TradingView does when such a script is added — once its inputs are known.
    effect(() => {
      const shown = this.formInputs();
      const enabled = this.pickEnabled();
      untracked(() => {
        if (this.autoPicked || !shown || !this.confirm() || !enabled) return;
        this.autoPicked = true;
        this.pickQueue = shown.filter((i) => i.kind === 'time' || i.kind === 'price');
        const first = this.pickQueue.shift();
        if (first) this.startPick({ inputId: first.id, kind: first.kind as InputPick['kind'] });
      });
    });
    // Esc works at once, without a click into the dialog first.
    afterNextRender(() => this.box()?.nativeElement.focus());
  }

  /**
   * Pick an input on the chart: the dialog steps aside (it keeps every edit) and the page takes
   * the next click on the chart — or Esc — and answers with {@link finishPick}.
   */
  startPick(req: InputPick): void {
    if (!this.pickEnabled() || this.picking()) return;
    this.picking.set(req);
    // Focus leaves the hidden dialog: Esc then reaches the chart, which cancels the pick.
    const active = document.activeElement as HTMLElement | null;
    if (active && this.box()?.nativeElement.contains(active)) active.blur();
    this.pickOnChart.emit(req);
  }

  /**
   * The value picked on the chart (bar open, UTC ms, for a time; the price for a price), or null
   * when the pick was cancelled. The input takes it — applied as any edit is — and the confirm
   * prompt goes on to its next time or price input; a cancelled pick ends that round.
   */
  finishPick(value: number | null): void {
    const req = this.picking();
    if (!req) return;
    this.picking.set(null);
    const list = this.inputs();
    const inp = list?.find((i) => i.id === req.inputId);
    if (value !== null && list && inp) {
      const next = { ...resolveInputValues(list, this.draft()), [inp.id]: coerceInputValue(inp, value) };
      this.edit(inputOverrides(list, next));
    }
    if (value === null) this.pickQueue = [];
    const after = this.pickQueue.shift();
    if (after) {
      this.startPick({ inputId: after.id, kind: after.kind as InputPick['kind'] });
      return;
    }
    setTimeout(() => this.box()?.nativeElement.focus());
  }

  toggleMenu(): void {
    this.naming.set(false);
    this.menuOpen.set(!this.menuOpen());
  }

  startNaming(): void {
    this.naming.set(true);
    setTimeout(() =>
      (this.box()?.nativeElement.querySelector('.sd-name input') as HTMLInputElement | null)?.focus(),
    );
  }

  /** "Save as template…": the inputs as the form shows them, under `name`. */
  saveAsTemplate(name: string): void {
    const clean = name.trim();
    if (!clean) return;
    this.naming.set(false);
    this.menuOpen.set(false);
    this.saveTemplate.emit({ name: clean, values: this.overridesOf(this.draft()) });
  }

  /** A template's inputs, applied as an edit (Cancel still puts back what the dialog opened with). */
  applyTemplate(t: ScriptInputTemplate): void {
    this.menuOpen.set(false);
    const list = this.inputs();
    this.edit(list ? inputOverrides(list, resolveInputValues(list, t.values)) : { ...t.values });
  }

  /**
   * The display settings the chart shows: the first are what Cancel puts back; later ones (the
   * chip's eye, the assistant) replace the tabs' unless they are the ones this dialog sent.
   */
  receiveDisplay(display: ScriptDisplaySettings | null): void {
    if (!display) return;
    if (this.openedDisplay === null) this.openedDisplay = display;
    if (JSON.stringify(display) !== JSON.stringify(this.draftDisplay()))
      this.draftDisplay.set(display);
  }

  /** A change on the Style or Visibility tab: shown on the chart at once. */
  setDisplay(patch: Partial<ScriptDisplaySettings>): void {
    const next = { ...this.draftDisplay(), ...patch };
    this.draftDisplay.set(next);
    this.displayChange.emit(next);
  }

  protected outputShown(key: string): boolean {
    return this.draftDisplay().outputs[key]?.visible !== false;
  }

  /** One output's style, merged with what it had. */
  setOutput(key: string, patch: OutputStyle): void {
    const outputs = this.draftDisplay().outputs;
    const merged: OutputStyle = { ...outputs[key], ...patch };
    // A checked box is the default: it needs no entry.
    if (merged.visible === true) delete merged.visible;
    const next = { ...outputs };
    if (Object.keys(merged).length) next[key] = merged;
    else delete next[key];
    this.setDisplay({ outputs: next });
  }

  /** The colour an output draws `original` in now. */
  protected colorOf(key: string, original: string): string {
    return this.draftDisplay().outputs[key]?.colors?.[original] ?? original;
  }

  /** A swatch's new colour (Pine `#RRGGBBAA` from the palette) for the output's `original`. */
  setColor(key: string, original: string, pine: string): void {
    const rgba = parsePineColor(pine);
    if (!rgba) return;
    const colors = { ...this.draftDisplay().outputs[key]?.colors };
    const css = toCss(rgba);
    if (css === original) delete colors[original];
    else colors[original] = css;
    this.setOutput(key, { colors });
  }

  protected widthOf(o: StyleOutput): number {
    return this.draftDisplay().outputs[o.key]?.lineWidth ?? o.lineWidth ?? 1;
  }

  protected styleOf(o: StyleOutput): PinePlotStyle | null {
    return this.draftDisplay().outputs[o.key]?.plotStyle ?? o.plotStyle;
  }

  setPrecision(raw: string): void {
    this.setDisplay({ precision: raw === '' ? null : Math.max(0, Math.min(8, Number(raw))) });
  }

  setBehind(raw: string): void {
    this.setDisplay({ behindChart: raw === 'behind' ? true : raw === 'front' ? false : null });
  }

  /** A Visibility row, with every interval of its unit when the script sets none. */
  protected rowOf(unit: TimeframeUnit, max: number): TimeframeRange {
    return this.draftDisplay().timeframes?.[unit] ?? { on: true, from: 1, to: max };
  }

  setRow(unit: TimeframeUnit, max: number, patch: Partial<TimeframeRange>): void {
    const row = { ...this.rowOf(unit, max), ...patch };
    row.from = Math.max(1, Math.min(max, Math.round(row.from) || 1));
    row.to = Math.max(row.from, Math.min(max, Math.round(row.to) || max));
    const timeframes: TimeframeVisibility = { ...this.draftDisplay().timeframes };
    if (row.on && row.from === 1 && row.to === max) delete timeframes[unit];
    else timeframes[unit] = row;
    this.setDisplay({ timeframes: Object.keys(timeframes).length ? timeframes : null });
  }

  /**
   * The values the script runs with: the first are what Cancel puts back. Later ones changed
   * elsewhere (the strategy tester, the assistant) replace the form's — unless an edit here is
   * still waiting to apply, or they are the ones this dialog sent.
   */
  receive(values: ScriptInputValues): void {
    if (this.opened === null) {
      this.opened = values;
      this.applied = values;
      this.draft.set(values);
      return;
    }
    if (this.timer !== null || sameInputValues(values, this.applied)) return;
    this.applied = values;
    this.draft.set(values);
  }

  /**
   * An edit in the form: shown at once, applied when the edits pause. The confirm prompt's form
   * shows some of the inputs only: the others keep their values.
   */
  edit(overrides: ScriptInputValues): void {
    const shown = this.formInputs();
    let next = overrides;
    if (this.confirm() && shown) {
      const ids = new Set(shown.map((i) => i.id));
      const kept = Object.entries(this.draft()).filter(([id]) => !ids.has(id));
      next = { ...Object.fromEntries(kept), ...overrides };
    }
    this.draft.set(next);
    this.clearTimer();
    this.timer = setTimeout(() => this.apply(), SCRIPT_SETTINGS_APPLY_MS);
  }

  /** Apply the form's values now, if the chart does not run with them already. */
  apply(): void {
    this.clearTimer();
    const draft = this.draft();
    if (sameInputValues(draft, this.applied)) return;
    this.applied = draft;
    this.changed.emit(draft);
  }

  reset(): void {
    this.menuOpen.set(false);
    this.draft.set({});
    this.apply();
  }

  saveAsDefault(): void {
    this.menuOpen.set(false);
    this.apply();
    this.saveDefault.emit(this.overridesOf(this.draft()));
  }

  ok(): void {
    if (this.closedOnce) return;
    this.closedOnce = true;
    this.apply();
    this.closed.emit();
  }

  cancel(): void {
    if (this.closedOnce) return;
    this.closedOnce = true;
    this.clearTimer();
    if (this.confirm()) {
      // The script was added for these inputs: without them it leaves the chart.
      this.confirmCancelled.emit();
      this.closed.emit();
      return;
    }
    const opened = this.opened ?? {};
    if (!sameInputValues(opened, this.applied)) {
      this.applied = opened;
      this.changed.emit(opened);
    }
    // The Style and Visibility tabs' changes, put back too.
    const shown = this.openedDisplay;
    if (shown && JSON.stringify(shown) !== JSON.stringify(this.draftDisplay()))
      this.displayChange.emit(shown);
    this.closed.emit();
  }

  ngOnDestroy(): void {
    // Closed from outside (the script left the chart, the layout was replaced): an edit still
    // waiting is dropped — its script may not be the one on the chart any more.
    this.clearTimer();
  }

  /** Only the values that differ from the inputs' defaults (and still apply to them). */
  private overridesOf(values: ScriptInputValues): ScriptInputValues {
    const list = this.inputs();
    return list ? inputOverrides(list, resolveInputValues(list, values)) : {};
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
