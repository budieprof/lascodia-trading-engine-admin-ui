import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  model,
  output,
} from '@angular/core';

import type {
  ScriptInputDto,
  ScriptInputValue,
  ScriptInputValues,
} from '@core/api/scripting.types';
import {
  SESSION_DAYS,
  alphaToOpacity,
  coerceInputValue,
  colorToCss,
  formatColor,
  formatSession,
  inputOptions,
  inputOverrides,
  isInputActive,
  layoutInputs,
  msToUtcInput,
  opacityToAlpha,
  parseColor,
  parseSession,
  resolveInputValues,
  type SessionParts,
} from '../../pine/pine-inputs';
import { SCRIPTING_UI_STYLES } from '../scripting-ui.styles';

let nextFormId = 0;

/** Kinds whose `options` turn the widget into a dropdown. */
const OPTION_KINDS = new Set(['int', 'float', 'string', 'enum', 'source', 'timeframe']);

/**
 * A script's inputs rendered the way Pine's "Settings / Inputs" tab renders them: sections per
 * `group`, `inline` inputs on one line, the line's tooltip as a `?` at its end, dropdowns for
 * `options`, and inputs switched off by their `active` bool greyed out.
 *
 * The value it binds is what a strategy stores: only the inputs that differ from their defaults,
 * in §9 wire form (`#RRGGBBAA` colours, ms times, series names, enum member names).
 */
@Component({
  selector: 'app-inputs-form',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (inputs().length === 0) {
      <p class="empty">{{ emptyText() }}</p>
    } @else {
      <div class="inputs" [class.is-disabled]="disabled()">
        @for (section of sections(); track $index) {
          <section class="in-section">
            @if (section.group) {
              <h4 class="in-group">{{ section.group }}</h4>
            }
            @for (row of section.rows; track $index) {
              <div class="in-row" [class.is-inline]="row.inline !== null">
                @for (inp of row.inputs; track inp.id) {
                  <div
                    class="in-field"
                    [class.is-inactive]="!isActive(inp)"
                    [class.is-bool]="inp.kind === 'bool'"
                    [attr.data-kind]="inp.kind"
                    [attr.data-input-id]="inp.id"
                  >
                    @if (inp.kind !== 'bool') {
                      <label class="in-label" [for]="fieldId(inp)" [title]="inp.title">
                        {{ inp.title }}
                        @if (inp.confirm) {
                          <span class="chip" title="Asked for when the script is added to a chart"
                            >confirm</span
                          >
                        }
                      </label>
                    }
                    <span class="in-widget">
                      @switch (widgetOf(inp)) {
                        @case ('bool') {
                          <label class="in-check">
                            <input
                              type="checkbox"
                              [id]="fieldId(inp)"
                              [checked]="values()[inp.id] === true"
                              [disabled]="locked(inp)"
                              (change)="set(inp, $any($event.target).checked)"
                            />
                            <span>{{ inp.title }}</span>
                          </label>
                        }
                        @case ('select') {
                          <select
                            class="field-input"
                            [id]="fieldId(inp)"
                            [disabled]="locked(inp)"
                            (change)="set(inp, $any($event.target).value)"
                          >
                            @for (o of optionsOf(inp); track o.value) {
                              <option [value]="o.value" [selected]="o.value === text(inp)">
                                {{ o.label }}
                              </option>
                            }
                          </select>
                        }
                        @case ('number') {
                          <input
                            type="number"
                            class="field-input num"
                            [id]="fieldId(inp)"
                            [attr.min]="inp.minValue ?? null"
                            [attr.max]="inp.maxValue ?? null"
                            [attr.step]="inp.step ?? (inp.kind === 'int' ? 1 : 'any')"
                            [value]="values()[inp.id]"
                            [disabled]="locked(inp)"
                            (change)="set(inp, $any($event.target).value); $any($event.target).value = values()[inp.id]"
                          />
                          @if (inp.kind === 'price') {
                            <button
                              type="button"
                              class="pick"
                              [disabled]="!pickOnChartEnabled() || locked(inp)"
                              (click)="pickOnChart.emit({ inputId: inp.id, kind: 'price' })"
                              title="Pick the price on the chart"
                              aria-label="Pick the price on the chart"
                            >
                              ⌖
                            </button>
                          }
                        }
                        @case ('text') {
                          <input
                            type="text"
                            class="field-input"
                            [id]="fieldId(inp)"
                            [value]="text(inp)"
                            [disabled]="locked(inp)"
                            (change)="set(inp, $any($event.target).value)"
                          />
                        }
                        @case ('textArea') {
                          <textarea
                            class="field-input in-textarea"
                            rows="4"
                            [id]="fieldId(inp)"
                            [value]="text(inp)"
                            [disabled]="locked(inp)"
                            (change)="set(inp, $any($event.target).value)"
                          ></textarea>
                        }
                        @case ('symbol') {
                          <input
                            type="text"
                            class="field-input"
                            placeholder="Chart symbol"
                            [id]="fieldId(inp)"
                            [attr.list]="listId"
                            [value]="text(inp)"
                            [disabled]="locked(inp)"
                            (change)="set(inp, $any($event.target).value.trim().toUpperCase())"
                          />
                        }
                        @case ('session') {
                          <span class="in-session">
                            <input
                              type="time"
                              class="field-input"
                              [id]="fieldId(inp)"
                              [value]="session(inp).start"
                              [disabled]="locked(inp)"
                              (change)="setSession(inp, { start: $any($event.target).value })"
                              aria-label="Session start"
                            />
                            <span class="muted">–</span>
                            <input
                              type="time"
                              class="field-input"
                              [value]="session(inp).end"
                              [disabled]="locked(inp)"
                              (change)="setSession(inp, { end: $any($event.target).value })"
                              aria-label="Session end"
                            />
                            <span class="in-days" role="group" aria-label="Session days">
                              @for (d of sessionDays; track d.digit) {
                                <button
                                  type="button"
                                  class="day"
                                  [class.is-on]="dayOn(inp, d.digit)"
                                  [attr.aria-pressed]="dayOn(inp, d.digit)"
                                  [disabled]="locked(inp)"
                                  (click)="toggleDay(inp, d.digit)"
                                >
                                  {{ d.label }}
                                </button>
                              }
                            </span>
                          </span>
                        }
                        @case ('color') {
                          <span class="in-color">
                            <span class="swatch" [style.--swatch]="colorCss(inp)">
                              <input
                                type="color"
                                [id]="fieldId(inp)"
                                [value]="colorHex(inp)"
                                [disabled]="locked(inp)"
                                (input)="setColorHex(inp, $any($event.target).value)"
                                [attr.aria-label]="inp.title + ' colour'"
                              />
                            </span>
                            <input
                              type="range"
                              min="0"
                              max="100"
                              step="1"
                              class="opacity"
                              [value]="colorOpacity(inp)"
                              [disabled]="locked(inp)"
                              (input)="setOpacity(inp, +$any($event.target).value)"
                              [attr.aria-label]="inp.title + ' opacity'"
                            />
                            <span class="mono small">{{ colorOpacity(inp) }}%</span>
                          </span>
                        }
                        @case ('time') {
                          <input
                            type="datetime-local"
                            class="field-input"
                            [id]="fieldId(inp)"
                            [value]="timeText(inp)"
                            [disabled]="locked(inp)"
                            (change)="set(inp, $any($event.target).value)"
                          />
                          <span class="muted small">UTC</span>
                          <button
                            type="button"
                            class="pick"
                            [disabled]="!pickOnChartEnabled() || locked(inp)"
                            (click)="pickOnChart.emit({ inputId: inp.id, kind: 'time' })"
                            title="Pick the time on the chart"
                            aria-label="Pick the time on the chart"
                          >
                            ⌖
                          </button>
                        }
                      }
                    </span>
                  </div>
                }
                @if (row.tooltip) {
                  <span class="in-tip" tabindex="0" [title]="row.tooltip" [attr.aria-label]="row.tooltip"
                    >?</span
                  >
                }
              </div>
            }
          </section>
        }
        @if (symbols().length) {
          <datalist [id]="listId">
            @for (s of symbols(); track s) {
              <option [value]="s"></option>
            }
          </datalist>
        }
        @if (!disabled() && showReset()) {
          <div class="in-actions">
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              (click)="reset()"
              [disabled]="!hasOverrides()"
              title="Put every input back to the script's defaults"
            >
              Reset to defaults
            </button>
            @if (hasOverrides()) {
              <span class="muted small">{{ overrideCount() }} changed from default</span>
            }
          </div>
        }
      </div>
    }
  `,
  styles: [
    SCRIPTING_UI_STYLES,
    `
      :host {
        display: block;
      }
      .empty {
        margin: 0;
        padding: 12px 0;
        font-size: 12px;
        color: var(--text-tertiary);
      }
      .inputs {
        display: flex;
        flex-direction: column;
        gap: 10px;
        font-size: 13px;
      }
      .in-group {
        margin: 4px 0 6px;
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--text-secondary);
      }
      .in-row {
        display: grid;
        grid-template-columns: minmax(110px, 40%) minmax(0, 1fr) auto;
        align-items: center;
        gap: 6px 10px;
        padding: 2px 0;
      }
      .in-row > .in-field {
        display: contents;
      }
      .in-row > .in-field.is-bool .in-widget {
        grid-column: 1 / 3;
      }
      .in-row.is-inline {
        display: flex;
        flex-wrap: wrap;
      }
      .in-row.is-inline > .in-field {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .in-label {
        color: var(--text-primary);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .in-widget {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
      }
      .in-widget > .field-input:not(.num) {
        width: 100%;
      }
      .in-row.is-inline .in-widget > .field-input:not(.num) {
        width: auto;
        min-width: 120px;
      }
      .num {
        width: 110px;
      }
      .is-inactive {
        opacity: 0.45;
      }
      .in-check {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        cursor: pointer;
      }
      .in-textarea {
        height: auto;
        padding: 6px 8px;
        resize: vertical;
        font-family: inherit;
      }
      .in-session {
        display: inline-flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 4px;
      }
      .in-days {
        display: inline-flex;
        gap: 2px;
      }
      .day {
        height: 24px;
        min-width: 26px;
        padding: 0 4px;
        border: 1px solid var(--border);
        border-radius: 5px;
        background: var(--bg-primary);
        color: var(--text-tertiary);
        font-size: 11px;
        cursor: pointer;
      }
      .day.is-on {
        background: rgba(0, 113, 227, 0.12);
        color: var(--accent);
        border-color: rgba(0, 113, 227, 0.3);
      }
      .in-color {
        display: inline-flex;
        align-items: center;
        gap: 8px;
      }
      .swatch {
        position: relative;
        width: 30px;
        height: 22px;
        border-radius: 5px;
        border: 1px solid var(--border);
        overflow: hidden;
        background-image: linear-gradient(var(--swatch), var(--swatch)),
          repeating-conic-gradient(#c8c8c8 0% 25%, #fff 0% 50%);
        background-size: auto, 8px 8px;
      }
      .swatch input {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        opacity: 0;
        cursor: pointer;
        border: none;
        padding: 0;
      }
      .opacity {
        width: 90px;
      }
      .pick {
        height: 26px;
        width: 26px;
        border: 1px solid var(--border);
        border-radius: 6px;
        background: var(--bg-primary);
        color: var(--text-secondary);
        cursor: pointer;
      }
      .pick:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
      .in-tip {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 16px;
        height: 16px;
        border-radius: 50%;
        border: 1px solid var(--text-tertiary);
        color: var(--text-tertiary);
        font-size: 10px;
        font-weight: 700;
        cursor: help;
      }
      .in-actions {
        display: flex;
        align-items: center;
        gap: 8px;
        padding-top: 4px;
        border-top: 1px solid var(--border);
      }
    `,
  ],
})
export class InputsFormComponent {
  readonly inputs = input<readonly ScriptInputDto[]>([]);
  /** Overrides `{ inputId: value }` — only values that differ from the defaults (two-way). */
  readonly overrides = model<ScriptInputValues>({});
  /** Read-only view (e.g. a saved strategy's settings). */
  readonly disabled = input(false);
  /** Symbols offered by `input.symbol` fields. */
  readonly symbols = input<readonly string[]>([]);
  readonly showReset = input(true);
  readonly emptyText = input('This script declares no inputs.');
  /** Enables the "pick on chart" buttons of time/price inputs (the chart overlay provides it). */
  readonly pickOnChartEnabled = input(false);
  readonly pickOnChart = output<{ inputId: string; kind: 'time' | 'price' }>();

  readonly sections = computed(() => layoutInputs(this.inputs()));
  /** Every input's current value (override or default). */
  readonly values = computed(() => resolveInputValues(this.inputs(), this.overrides()));
  private readonly normalisedOverrides = computed(() => inputOverrides(this.inputs(), this.values()));
  readonly hasOverrides = computed(() => Object.keys(this.normalisedOverrides()).length > 0);
  readonly overrideCount = computed(() => Object.keys(this.normalisedOverrides()).length);
  private readonly options = computed(() => {
    const map = new Map<string, { value: string; label: string }[]>();
    for (const i of this.inputs()) map.set(i.id, inputOptions(i));
    return map;
  });

  readonly sessionDays = SESSION_DAYS;
  private readonly formId = nextFormId++;
  readonly listId = `pine-symbols-${this.formId}`;

  fieldId(inp: ScriptInputDto): string {
    return `pine-in-${this.formId}-${inp.id}`;
  }

  /** Which widget renders the input. */
  widgetOf(inp: ScriptInputDto): string {
    const hasOptions = !!inp.options?.length;
    if (inp.kind === 'bool') return 'bool';
    if (inp.kind === 'source' || inp.kind === 'timeframe' || inp.kind === 'enum') return 'select';
    if (hasOptions && OPTION_KINDS.has(inp.kind)) return 'select';
    if (inp.kind === 'int' || inp.kind === 'float' || inp.kind === 'price') return 'number';
    if (inp.kind === 'string') return 'text';
    return inp.kind;
  }

  optionsOf(inp: ScriptInputDto): { value: string; label: string }[] {
    return this.options().get(inp.id) ?? [];
  }

  isActive(inp: ScriptInputDto): boolean {
    return isInputActive(inp, this.values());
  }

  locked(inp: ScriptInputDto): boolean {
    return this.disabled() || !this.isActive(inp);
  }

  text(inp: ScriptInputDto): string {
    const v = this.values()[inp.id];
    return v === undefined || v === null ? '' : String(v);
  }

  set(inp: ScriptInputDto, raw: unknown): void {
    if (this.disabled()) return;
    const next: ScriptInputValues = { ...this.values(), [inp.id]: coerceInputValue(inp, raw) };
    this.overrides.set(inputOverrides(this.inputs(), next));
  }

  reset(): void {
    this.overrides.set({});
  }

  // ── colour ──
  colorHex(inp: ScriptInputDto): string {
    return (parseColor(this.values()[inp.id])?.hex ?? '#000000').toLowerCase();
  }

  colorOpacity(inp: ScriptInputDto): number {
    return alphaToOpacity(parseColor(this.values()[inp.id])?.alpha ?? 255);
  }

  colorCss(inp: ScriptInputDto): string {
    return colorToCss(this.values()[inp.id]);
  }

  setColorHex(inp: ScriptInputDto, hex: string): void {
    const alpha = parseColor(this.values()[inp.id])?.alpha ?? 255;
    this.set(inp, formatColor({ hex: hex.toUpperCase(), alpha }));
  }

  setOpacity(inp: ScriptInputDto, opacity: number): void {
    const hex = parseColor(this.values()[inp.id])?.hex ?? '#000000';
    this.set(inp, formatColor({ hex, alpha: opacityToAlpha(opacity) }));
  }

  // ── session ──
  session(inp: ScriptInputDto): SessionParts {
    return parseSession(this.values()[inp.id]);
  }

  setSession(inp: ScriptInputDto, patch: Partial<SessionParts>): void {
    this.set(inp, formatSession({ ...this.session(inp), ...patch }));
  }

  dayOn(inp: ScriptInputDto, digit: string): boolean {
    const days = this.session(inp).days;
    return days === null || days.includes(digit);
  }

  toggleDay(inp: ScriptInputDto, digit: string): void {
    const current = this.session(inp).days ?? '1234567';
    let next = current.includes(digit) ? current.replace(digit, '') : current + digit;
    if (!next) return; // at least one day
    next = [...next].sort().join('');
    this.setSession(inp, { days: next.length === 7 ? null : next });
  }

  // ── time ──
  timeText(inp: ScriptInputDto): string {
    return msToUtcInput(this.values()[inp.id] as ScriptInputValue);
  }
}
