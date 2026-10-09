import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  input,
  output,
  signal,
} from '@angular/core';
import type { ActiveIndicator } from '../chart/chart-host.component';
import {
  INTERVAL_GROUPS,
  visibilityFromList,
  visibilityToList,
  type IntervalUnit,
  type IntervalVisibility,
} from '../drawings/drawing-ops';
import { parseColor } from '../drawings/ui/colors';
import { studyDefaults, studyLabel, studyMeta } from '../studies';
import { indicatorById, indicatorLabel, type IndicatorInput, type PlotKind } from './registry';
import {
  effectivePlot,
  mtfCapable,
  parseStudyInput,
  parseStudySource,
  sourceGroups,
  timeframeChoices,
  type PlotStyle,
  type StudyLevelStyle,
} from './study-settings';

type Tab = 'inputs' | 'style' | 'visibility';

/** What the page is asked to pick on the chart for the dialog (the dialog steps aside meanwhile). */
export interface StudyPick {
  key: string;
  kind: 'time';
}

/**
 * A built-in study's Settings (DR-I4 / DR-I5 / DR-16 / DR-22) — TradingView's Inputs | Style | Visibility:
 *
 * - **Inputs**: every input by its type — numbers, choices, the Source (price or another study's plot), sessions as
 *   `HHMM-HHMM`, times picked on the chart (never typed as milliseconds) — and the Timeframe a study is computed on.
 * - **Style**: per plot drawn or not, colour, width, line / dots / histogram; the levels; the band / cloud fill.
 * - **Visibility**: the timeframes it shows on, as for drawings.
 *
 * Edits preview live (`changed` carries the whole study each time); Ok keeps them, Cancel (Esc, the backdrop, ×)
 * puts back the study as it was when the dialog opened.
 */
@Component({
  selector: 'app-study-settings-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let s = study();
    <div class="ss-backdrop" [hidden]="picking() !== null" (pointerdown)="cancel()"></div>
    <div
      class="ss"
      role="dialog"
      aria-modal="true"
      [attr.aria-label]="title()"
      [hidden]="picking() !== null"
      (keydown.escape)="cancel()"
      (keydown.enter)="onEnter($event)"
    >
      <header class="ss-head">
        <span class="ss-title">{{ title() }}</span>
        <button type="button" class="ss-x" aria-label="Close" (click)="cancel()">×</button>
      </header>
      <nav class="ss-tabs">
        @for (t of tabs(); track t.id) {
          <button type="button" class="ss-tab" [class.on]="tab() === t.id" (click)="tab.set(t.id)">
            {{ t.label }}
          </button>
        }
      </nav>

      <div class="ss-body">
        @switch (tab()) {
          @case ('inputs') {
            @for (inp of inputs(); track inp.key) {
              <div class="ss-row">
                <span class="ss-label">{{ inp.label }}</span>
                <span class="ss-ctl">
                  @switch (inp.type) {
                    @case ('select') {
                      <select
                        [attr.aria-label]="inp.label"
                        (change)="setInput(inp, $any($event.target).value)"
                      >
                        @for (o of inp.options ?? []; track o) {
                          <option [value]="o" [selected]="s.params[inp.key] === o">{{ o }}</option>
                        }
                      </select>
                    }
                    @case ('source') {
                      <select
                        class="ss-source"
                        [attr.aria-label]="inp.label"
                        (change)="setInput(inp, $any($event.target).value)"
                      >
                        @for (g of sources(); track g.label) {
                          <optgroup [label]="g.label">
                            @for (c of g.choices; track c.value) {
                              <option [value]="c.value" [selected]="s.params[inp.key] === c.value">
                                {{ c.label }}
                              </option>
                            }
                          </optgroup>
                        }
                      </select>
                    }
                    @case ('symbol') {
                      <input
                        type="text"
                        class="ss-text"
                        [attr.aria-label]="inp.label"
                        [value]="s.params[inp.key]"
                        (change)="setInput(inp, $any($event.target).value)"
                      />
                    }
                    @case ('session') {
                      <input
                        type="text"
                        class="ss-text"
                        placeholder="0800-1700"
                        [attr.aria-label]="inp.label"
                        [class.invalid]="invalid() === inp.key"
                        [value]="s.params[inp.key]"
                        (change)="setInput(inp, $any($event.target).value)"
                      />
                    }
                    @case ('time') {
                      <input
                        type="datetime-local"
                        class="ss-date"
                        [attr.aria-label]="inp.label"
                        [value]="timeValue(s.params[inp.key])"
                        (change)="setTime(inp, $any($event.target).value)"
                      />
                      @if (canPick()) {
                        <button type="button" class="ss-btn" (click)="startPick(inp.key)">
                          Pick on chart
                        </button>
                      }
                      @if (isSet(s.params[inp.key])) {
                        <button type="button" class="ss-link" (click)="setInput(inp, '')">
                          Clear
                        </button>
                      }
                    }
                    @default {
                      <input
                        type="number"
                        class="ss-num"
                        step="any"
                        [attr.aria-label]="inp.label"
                        [attr.min]="inp.min ?? null"
                        [attr.max]="inp.max ?? null"
                        [class.invalid]="invalid() === inp.key"
                        [value]="s.params[inp.key]"
                        (change)="setInput(inp, $any($event.target).value)"
                      />
                    }
                  }
                </span>
              </div>
            }
            @if (mtf()) {
              <div class="ss-row">
                <span class="ss-label">Timeframe</span>
                <span class="ss-ctl">
                  <select aria-label="Timeframe" (change)="setTimeframe($any($event.target).value)">
                    <option value="" [selected]="!s.timeframe">Chart</option>
                    @for (r of timeframes(); track r) {
                      <option [value]="r" [selected]="s.timeframe === r">{{ r }}</option>
                    }
                  </select>
                </span>
              </div>
              <p class="ss-hint">
                On a higher timeframe a value shows once that bar has closed, so it never repaints.
              </p>
            }
            @if (hasTimes()) {
              <p class="ss-hint">Times are UTC.</p>
            }
            @if (!inputs().length && !mtf()) {
              <p class="ss-hint">This study has no inputs.</p>
            }
          }
          @case ('style') {
            @for (p of plots(); track p.key) {
              <div class="ss-row">
                <label class="ss-label ss-check">
                  <input
                    type="checkbox"
                    [checked]="p.visible"
                    (change)="setPlot(p.key, { visible: $any($event.target).checked })"
                  />
                  {{ p.title }}
                </label>
                <span class="ss-ctl">
                  <input
                    type="color"
                    class="ss-mini"
                    [attr.aria-label]="p.title + ' colour'"
                    [value]="hex(p.color)"
                    (input)="setPlot(p.key, { color: $any($event.target).value })"
                  />
                  @if (p.kind !== 'markers') {
                    <select
                      [attr.aria-label]="p.title + ' width'"
                      (change)="setPlot(p.key, { width: +$any($event.target).value })"
                    >
                      @for (w of widths; track w) {
                        <option [value]="w" [selected]="(p.lineWidth ?? 2) === w">{{ w }}px</option>
                      }
                    </select>
                    <select
                      [attr.aria-label]="p.title + ' style'"
                      (change)="setPlot(p.key, { kind: $any($event.target).value })"
                    >
                      @for (k of kinds; track k.id) {
                        <option [value]="k.id" [selected]="p.kind === k.id">{{ k.label }}</option>
                      }
                    </select>
                  }
                </span>
              </div>
            }
            @if (levels().length || hasLevels()) {
              <div class="ss-levels">
                <div class="ss-levels-head">Levels</div>
                @for (lv of levels(); track $index; let i = $index) {
                  <span class="ss-level">
                    <input
                      type="checkbox"
                      [attr.aria-label]="'Level ' + (i + 1)"
                      [checked]="lv.visible !== false"
                      (change)="setLevel(i, { visible: $any($event.target).checked })"
                    />
                    <input
                      type="number"
                      step="any"
                      class="ss-num"
                      [attr.aria-label]="'Level ' + (i + 1) + ' value'"
                      [value]="lv.value"
                      (change)="setLevel(i, { value: +$any($event.target).value })"
                    />
                    <input
                      type="color"
                      class="ss-mini"
                      [attr.aria-label]="'Level ' + (i + 1) + ' colour'"
                      [value]="hex(lv.color)"
                      (input)="setLevel(i, { color: $any($event.target).value })"
                    />
                  </span>
                }
                <button type="button" class="ss-link" (click)="addLevel()">+ Add level</button>
              </div>
            }
            @if (fillable()) {
              <div class="ss-row">
                <label class="ss-label ss-check">
                  <input
                    type="checkbox"
                    [checked]="s.style?.fill !== false"
                    (change)="setFill($any($event.target).checked)"
                  />
                  Background fill
                </label>
              </div>
            }
          }
          @case ('visibility') {
            @for (g of groups; track g.unit) {
              @let v = vis()[g.unit];
              <div class="ss-row ss-vis" [class.disabled]="!g.available">
                <label class="ss-label ss-check">
                  <input
                    type="checkbox"
                    [checked]="g.available && v.on"
                    [disabled]="!g.available"
                    (change)="setVis(g.unit, { on: $any($event.target).checked })"
                  />
                  {{ g.label }}
                </label>
                <span class="ss-ctl">
                  <input
                    type="number"
                    class="ss-num"
                    [attr.aria-label]="g.label + ' from'"
                    [min]="g.min"
                    [max]="g.max"
                    [value]="v.from"
                    [disabled]="!g.available || !v.on"
                    (change)="setVis(g.unit, { from: +$any($event.target).value })"
                  />
                  <input
                    type="number"
                    class="ss-num"
                    [attr.aria-label]="g.label + ' to'"
                    [min]="g.min"
                    [max]="g.max"
                    [value]="v.to"
                    [disabled]="!g.available || !v.on"
                    (change)="setVis(g.unit, { to: +$any($event.target).value })"
                  />
                </span>
              </div>
            }
          }
        }
      </div>

      <footer class="ss-foot">
        <button type="button" class="ss-btn" (click)="reset()" title="Back to the study's defaults">
          Defaults
        </button>
        <span class="ss-spacer"></span>
        <button type="button" class="ss-btn" (click)="cancel()">Cancel</button>
        <button type="button" class="ss-btn primary" (click)="ok()">Ok</button>
      </footer>
    </div>
  `,
  styles: `
    .ss-backdrop {
      position: fixed;
      inset: 0;
      z-index: 1000;
      background: rgba(0, 0, 0, 0.2);
    }
    .ss {
      position: fixed;
      z-index: 1001;
      left: 50%;
      top: 50%;
      transform: translate(-50%, -50%);
      width: min(480px, calc(100vw - 32px));
      max-height: calc(100vh - 64px);
      display: flex;
      flex-direction: column;
      background: var(--tv-bg, #fff);
      color: var(--tv-ink, #131722);
      border-radius: 6px;
      box-shadow: 0 2px 24px rgba(0, 0, 0, 0.3);
      font-size: 14px;
    }
    [hidden] {
      display: none !important;
    }
    .ss-head {
      display: flex;
      align-items: center;
      padding: 16px 20px 10px;
    }
    .ss-title {
      font-size: 20px;
      font-weight: 600;
      flex: 1;
    }
    .ss-x {
      border: 0;
      background: none;
      color: var(--tv-muted, #787b86);
      font-size: 24px;
      cursor: pointer;
      line-height: 1;
    }
    .ss-tabs {
      display: flex;
      gap: 18px;
      padding: 0 20px;
      border-bottom: 1px solid var(--tv-line, #e0e3eb);
    }
    .ss-tab {
      border: 0;
      background: none;
      color: var(--tv-muted, #787b86);
      font: inherit;
      padding: 8px 0;
      border-bottom: 3px solid transparent;
      cursor: pointer;
      margin-bottom: -1px;
    }
    .ss-tab.on {
      color: var(--tv-ink, #131722);
      border-bottom-color: var(--tv-ink, #131722);
    }
    .ss-body {
      padding: 14px 20px;
      overflow: auto;
      min-height: 200px;
    }
    .ss-row {
      display: flex;
      align-items: center;
      gap: 12px;
      min-height: 36px;
    }
    .ss-label {
      flex: 0 0 150px;
    }
    .ss-check {
      display: flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
      flex: 1;
    }
    .ss-check input,
    .ss-level input[type='checkbox'] {
      accent-color: var(--tv-blue, #2962ff);
      width: 16px;
      height: 16px;
    }
    .ss-ctl {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    select,
    .ss-num,
    .ss-date,
    .ss-text {
      height: 32px;
      padding: 0 8px;
      border: 1px solid var(--tv-line, #e0e3eb);
      border-radius: 4px;
      background: var(--tv-bg, #fff);
      color: inherit;
      font: inherit;
      font-size: 13px;
    }
    .ss-num {
      width: 80px;
    }
    .ss-date {
      width: 190px;
    }
    .ss-text {
      width: 140px;
    }
    .ss-source {
      max-width: 240px;
    }
    .invalid {
      border-color: var(--tv-red, #f23645);
    }
    .ss-mini {
      width: 32px;
      height: 26px;
      padding: 0;
      border: 1px solid var(--tv-line, #e0e3eb);
      border-radius: 4px;
      background: none;
    }
    .ss-levels {
      padding: 6px 0;
      display: flex;
      flex-wrap: wrap;
      gap: 6px 16px;
    }
    .ss-levels-head {
      width: 100%;
      color: var(--tv-muted, #787b86);
    }
    .ss-level {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .ss-link {
      border: 0;
      background: none;
      color: var(--tv-blue, #2962ff);
      cursor: pointer;
      padding: 8px 0;
      font: inherit;
    }
    .ss-vis.disabled {
      color: var(--tv-muted, #787b86);
    }
    .ss-hint {
      color: var(--tv-muted, #787b86);
      font-size: 12px;
      margin: 8px 0 0;
    }
    .ss-foot {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 14px 20px;
      border-top: 1px solid var(--tv-line, #e0e3eb);
    }
    .ss-spacer {
      flex: 1;
    }
    .ss-btn {
      height: 32px;
      padding: 0 14px;
      border-radius: 6px;
      border: 1px solid var(--tv-line, #e0e3eb);
      background: var(--tv-bg, #fff);
      color: inherit;
      font: inherit;
      cursor: pointer;
    }
    .ss-btn:hover {
      background: var(--tv-hover, #f0f3fa);
    }
    .ss-btn.primary {
      background: var(--tv-ink, #131722);
      color: var(--tv-bg, #fff);
      border-color: var(--tv-ink, #131722);
    }
    @media (max-width: 480px) {
      .ss-label {
        flex-basis: 110px;
      }
      .ss-date {
        width: 160px;
      }
    }
  `,
})
export class StudySettingsDialogComponent implements OnInit {
  /** The study as it is now (the page passes the live one back after each `changed`). */
  readonly study = input.required<ActiveIndicator>();
  /** Every study on the chart: the Source dropdown offers their plots. */
  readonly studies = input.required<readonly ActiveIndicator[]>();
  /** Resolutions this chart offers (Visibility, Timeframe). */
  readonly resolutions = input.required<readonly string[]>();
  readonly chartResolution = input('');
  /** A time can be picked on the chart (there is one). */
  readonly canPick = input(false);

  readonly changed = output<ActiveIndicator>();
  readonly closed = output<void>();
  /** Pick this input's time on the chart; the page answers with {@link finishPick}. */
  readonly pick = output<StudyPick>();

  readonly tab = signal<Tab>('inputs');
  readonly tabs = signal<{ id: Tab; label: string }[]>([
    { id: 'inputs', label: 'Inputs' },
    { id: 'style', label: 'Style' },
    { id: 'visibility', label: 'Visibility' },
  ]);
  readonly groups = INTERVAL_GROUPS;
  readonly widths = [1, 2, 3, 4];
  readonly kinds: { id: PlotKind; label: string }[] = [
    { id: 'line', label: 'Line' },
    { id: 'points', label: 'Dots' },
    { id: 'histogram', label: 'Histogram' },
  ];
  /** The input a time is being picked for on the chart; the dialog steps aside meanwhile. */
  readonly picking = signal<string | null>(null);
  /** The input whose last edit was not a value it takes. */
  readonly invalid = signal<string | null>(null);
  readonly vis = signal<IntervalVisibility>(visibilityFromList(undefined, []));

  private original: ActiveIndicator | null = null;
  private closedOnce = false;

  readonly def = computed(() => indicatorById(this.study().defId) ?? null);
  readonly title = computed(() => studyLabel(this.study().defId, this.study().params));
  readonly inputs = computed<readonly IndicatorInput[]>(
    () => studyMeta(this.study().defId)?.inputs ?? [],
  );
  readonly hasTimes = computed(() => this.inputs().some((i) => i.type === 'time'));
  readonly mtf = computed(() => {
    const def = this.def();
    return !!def && mtfCapable(def) && !parseStudySource(this.study().params['source']);
  });
  readonly timeframes = computed(() =>
    timeframeChoices(this.resolutions(), this.chartResolution(), this.study().timeframe),
  );
  readonly sources = computed(() =>
    sourceGroups(this.study(), this.studies(), (s) => {
      const def = indicatorById(s.defId);
      return def ? { label: indicatorLabel(def, s.params), plots: def.plots } : null;
    }),
  );
  readonly plots = computed(() => {
    const def = this.def();
    return def ? def.plots.map((p) => effectivePlot(p, this.study().style)) : [];
  });
  readonly hasLevels = computed(() => !!this.def()?.levels?.length);
  readonly levels = computed<StudyLevelStyle[]>(() => {
    const own = this.study().style?.levels;
    if (own) return own;
    return (this.def()?.levels ?? []).map((l) => ({
      value: l.value,
      color: l.color,
      visible: true,
    }));
  });
  readonly fillable = computed(() => !!this.def()?.fills?.length);

  ngOnInit(): void {
    this.original = structuredClone(this.study());
    this.vis.set(visibilityFromList(this.study().visibleOn, this.resolutions()));
    // Profiles, patterns: inputs and visibility only (they draw their own way).
    if (!this.def()) this.tabs.set(this.tabs().filter((t) => t.id !== 'style'));
  }

  private emit(next: ActiveIndicator): void {
    this.changed.emit(next);
  }

  setInput(input: IndicatorInput, raw: string): void {
    const value = parseStudyInput(input, raw);
    if (value === null) {
      this.invalid.set(input.key);
      return;
    }
    this.invalid.set(null);
    const s = this.study();
    const next: ActiveIndicator = { ...s, params: { ...s.params, [input.key]: value } };
    // A study read from another study's plot is on that one's bars: no timeframe of its own.
    if (input.type === 'source' && parseStudySource(value)) delete next.timeframe;
    this.emit(next);
  }

  /** A `datetime-local` value (UTC) as the time input's ms. */
  setTime(input: IndicatorInput, value: string): void {
    const t = value ? Date.parse(value + 'Z') : 0;
    if (!Number.isFinite(t)) return;
    this.setInput(input, String(t));
  }

  timeValue(v: number | string | undefined): string {
    const ms = Number(v);
    return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString().slice(0, 16) : '';
  }

  isSet(v: number | string | undefined): boolean {
    return Number(v) > 0;
  }

  startPick(key: string): void {
    this.picking.set(key);
    this.pick.emit({ key, kind: 'time' });
  }

  /** The page's answer to {@link pick}: the picked bar's open (UTC ms), or null (Esc). */
  finishPick(time: number | null): void {
    const key = this.picking();
    this.picking.set(null);
    if (key === null || time === null) return;
    const input = this.inputs().find((i) => i.key === key);
    if (input) this.setInput(input, String(time));
  }

  setTimeframe(tf: string): void {
    const s = this.study();
    const next: ActiveIndicator = { ...s };
    if (tf) next.timeframe = tf;
    else delete next.timeframe;
    this.emit(next);
  }

  setPlot(key: string, patch: PlotStyle): void {
    const s = this.study();
    const style = s.style ?? {};
    const plots = { ...(style.plots ?? {}), [key]: { ...(style.plots?.[key] ?? {}), ...patch } };
    this.emit({ ...s, style: { ...style, plots } });
  }

  setLevel(i: number, patch: Partial<StudyLevelStyle>): void {
    const s = this.study();
    const levels = this.levels().map((l, j) => (j === i ? { ...l, ...patch } : l));
    this.emit({ ...s, style: { ...(s.style ?? {}), levels } });
  }

  addLevel(): void {
    const s = this.study();
    const cur = this.levels();
    const last = cur.at(-1);
    const levels = [
      ...cur,
      { value: (last?.value ?? 0) + 10, color: last?.color ?? '#787B86', visible: true },
    ];
    this.emit({ ...s, style: { ...(s.style ?? {}), levels } });
  }

  setFill(on: boolean): void {
    const s = this.study();
    this.emit({ ...s, style: { ...(s.style ?? {}), fill: on } });
  }

  setVis(unit: IntervalUnit, patch: Partial<{ on: boolean; from: number; to: number }>): void {
    const g = { ...this.vis()[unit], ...patch };
    if (g.from > g.to) {
      if (patch.from !== undefined) g.to = g.from;
      else g.from = g.to;
    }
    const next = { ...this.vis(), [unit]: g };
    this.vis.set(next);
    const list = visibilityToList(next, this.resolutions());
    const s = { ...this.study() };
    // Every timeframe = the default (absent), so a study saved before Visibility existed and one never edited agree.
    if (list === undefined) delete s.visibleOn;
    else s.visibleOn = list;
    this.emit(s);
  }

  /** TradingView's "Reset settings": the catalogue's inputs, style and visibility. */
  reset(): void {
    const s = this.study();
    const next: ActiveIndicator = {
      uid: s.uid,
      defId: s.defId,
      visible: s.visible,
      params: studyDefaults(s.defId),
    };
    this.vis.set(visibilityFromList(undefined, this.resolutions()));
    this.invalid.set(null);
    this.emit(next);
  }

  hex(c: string | undefined): string {
    return parseColor(c).hex.toLowerCase();
  }

  onEnter(ev: Event): void {
    ev.preventDefault();
    this.ok();
  }

  ok(): void {
    if (this.closedOnce) return;
    this.closedOnce = true;
    this.closed.emit();
  }

  cancel(): void {
    if (this.closedOnce) return;
    this.closedOnce = true;
    if (this.original) this.emit(this.original);
    this.closed.emit();
  }
}
