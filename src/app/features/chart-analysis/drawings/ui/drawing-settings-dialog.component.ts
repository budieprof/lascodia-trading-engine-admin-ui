import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { DrawingStore } from '../drawing-store.service';
import {
  INTERVAL_GROUPS,
  visibilityFromList,
  visibilityToList,
  type IntervalUnit,
  type IntervalVisibility,
} from '../drawing-ops';
import type { DrawingTemplate } from '../drawing-templates';
import { toolFor, type DashStyle, type DrawingPoint, type DrawingStyle } from '../model';
import { behaviorFor } from '../tools/registry';
import { optionsOf, type ToolOption } from '../tools/types';
import { ColorPopoverComponent } from './color-popover.component';
import { TemplateMenuComponent } from './template-menu.component';
import { hasFill, hasText, parseColor } from './colors';

type Tab = 'style' | 'text' | 'coords' | 'visibility';
type Level = { value: number; color: string; visible: boolean };

/**
 * TradingView's drawing Settings dialog: Style | Text | Coordinates |
 * Visibility, Template ▾ / Cancel / Ok.
 *
 * Edits preview live on the chart. Opening snapshots the store
 * (`beginGesture`), every edit is applied without its own undo entry, Ok keeps
 * the lot as ONE undo step and Cancel restores the snapshot.
 */
@Component({
  selector: 'app-drawing-settings-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ColorPopoverComponent, TemplateMenuComponent],
  template: `
    @if (live(); as d) {
      <div class="sd-backdrop" (pointerdown)="cancel()"></div>
      <div class="sd" role="dialog" aria-modal="true" [attr.aria-label]="title()" (keydown.escape)="cancel()" (keydown.enter)="onEnter($event)">
        <header class="sd-head">
          <span class="sd-title">{{ title() }}</span>
          <button type="button" class="sd-x" aria-label="Close" (click)="cancel()">×</button>
        </header>
        <nav class="sd-tabs">
          @for (t of tabs(); track t.id) {
            <button type="button" class="sd-tab" [class.on]="tab() === t.id" (click)="tab.set(t.id); colorOpen.set(null)">{{ t.label }}</button>
          }
        </nav>

        <div class="sd-body">
          @switch (tab()) {
            @case ('style') {
              <div class="sd-row">
                <span class="sd-label">Line</span>
                <span class="sd-ctl">
                  <span class="sd-anchor">
                    <button type="button" class="sd-swatch" [style.background]="d.style.color" (click)="toggleColor('line')"></button>
                    @if (colorOpen() === 'line') {
                      <app-color-popover class="sd-pop" [value]="d.style.color" (changed)="style({ color: $event })" />
                    }
                  </span>
                  <select [value]="d.style.width" (change)="style({ width: +$any($event.target).value })" aria-label="Line width">
                    @for (w of [1, 2, 3, 4]; track w) {
                      <option [value]="w" [selected]="d.style.width === w">{{ w }}px</option>
                    }
                  </select>
                  <select (change)="style({ dash: $any($event.target).value })" aria-label="Line style">
                    @for (s of dashes; track s) {
                      <option [value]="s" [selected]="d.style.dash === s">{{ s }}</option>
                    }
                  </select>
                </span>
              </div>
              @if (fillable()) {
                <div class="sd-row">
                  <label class="sd-label sd-check">
                    <input type="checkbox" [checked]="d.style.fill !== null" (change)="toggleFill($any($event.target).checked)" />
                    Background
                  </label>
                  <span class="sd-ctl">
                    <span class="sd-anchor">
                      <button
                        type="button"
                        class="sd-swatch"
                        [disabled]="d.style.fill === null"
                        [style.background]="d.style.fill ?? 'transparent'"
                        (click)="toggleColor('fill')"
                      ></button>
                      @if (colorOpen() === 'fill') {
                        <app-color-popover class="sd-pop" [value]="d.style.fill" (changed)="style({ fill: $event })" />
                      }
                    </span>
                  </span>
                </div>
              }
              <div class="sd-row">
                <label class="sd-label sd-check">
                  <input type="checkbox" [checked]="d.style.showLabels" (change)="style({ showLabels: $any($event.target).checked })" />
                  Labels
                </label>
              </div>
              @for (o of styleOptions(); track o.key) {
                <div class="sd-row" [class.sd-levels-row]="o.type === 'levels'">
                  @switch (o.type) {
                    @case ('bool') {
                      <label class="sd-label sd-check">
                        <input type="checkbox" [checked]="!!opts()[o.key]" (change)="option(o.key, $any($event.target).checked)" />
                        {{ o.label }}
                      </label>
                    }
                    @case ('levels') {
                      <div class="sd-levels">
                        <div class="sd-levels-head">{{ o.label }}</div>
                        <div class="sd-levels-grid">
                          @for (lv of levelsOf(o.key); track $index; let i = $index) {
                            <span class="sd-level">
                              <input type="checkbox" [checked]="lv.visible" (change)="setLevel(o.key, i, { visible: $any($event.target).checked })" />
                              <input
                                type="number"
                                step="0.001"
                                class="sd-num"
                                [value]="lv.value"
                                (change)="setLevel(o.key, i, { value: +$any($event.target).value })"
                              />
                              <input type="color" class="sd-mini" [value]="hex(lv.color)" (input)="setLevel(o.key, i, { color: $any($event.target).value })" />
                            </span>
                          }
                        </div>
                        <button type="button" class="sd-link" (click)="addLevel(o.key)">+ Add level</button>
                      </div>
                    }
                    @default {
                      <span class="sd-label">{{ o.label }}</span>
                      <span class="sd-ctl">
                        @switch (o.type) {
                          @case ('number') {
                            <input
                              type="number"
                              class="sd-num"
                              [attr.min]="$any(o).min ?? null"
                              [attr.max]="$any(o).max ?? null"
                              [attr.step]="$any(o).step ?? 'any'"
                              [value]="opts()[o.key]"
                              (change)="option(o.key, +$any($event.target).value)"
                            />
                          }
                          @case ('color') {
                            <input type="color" class="sd-mini" [value]="hex($any(opts()[o.key]))" (input)="option(o.key, $any($event.target).value)" />
                          }
                          @case ('select') {
                            <select (change)="option(o.key, $any($event.target).value)">
                              @for (c of $any(o).choices; track c) {
                                <option [value]="c" [selected]="opts()[o.key] === c">{{ c }}</option>
                              }
                            </select>
                          }
                          @case ('text') {
                            <input type="text" class="sd-text" [value]="opts()[o.key] ?? ''" (input)="option(o.key, $any($event.target).value)" />
                          }
                        }
                      </span>
                    }
                  }
                </div>
              }
            }
            @case ('text') {
              <div class="sd-row sd-textrow">
                <span class="sd-anchor">
                  <button type="button" class="sd-swatch" [style.background]="d.style.textColor ?? d.style.color" (click)="toggleColor('text')"></button>
                  @if (colorOpen() === 'text') {
                    <app-color-popover class="sd-pop" [value]="d.style.textColor ?? d.style.color" (changed)="style({ textColor: $event })" />
                  }
                </span>
                <select (change)="style({ fontSize: +$any($event.target).value })" aria-label="Font size">
                  @for (s of fontSizes; track s) {
                    <option [value]="s" [selected]="d.style.fontSize === s">{{ s }}</option>
                  }
                </select>
                <button type="button" class="sd-toggle" [class.on]="d.style.bold" (click)="style({ bold: !d.style.bold })"><b>B</b></button>
                <button type="button" class="sd-toggle" [class.on]="d.style.italic" (click)="style({ italic: !d.style.italic })"><i>I</i></button>
              </div>
              <textarea class="sd-area" rows="4" placeholder="Add text" [value]="d.style.text" (input)="style({ text: $any($event.target).value })"></textarea>
              @for (o of textOptions(); track o.key) {
                <div class="sd-row">
                  @if (o.type === 'bool') {
                    <label class="sd-label sd-check">
                      <input type="checkbox" [checked]="!!opts()[o.key]" (change)="option(o.key, $any($event.target).checked)" />
                      {{ o.label }}
                    </label>
                  } @else {
                    <span class="sd-label">{{ o.label }}</span>
                    <input class="sd-text" [value]="opts()[o.key] ?? ''" (change)="option(o.key, o.type === 'number' ? +$any($event.target).value : $any($event.target).value)" />
                  }
                </div>
              }
            }
            @case ('coords') {
              @for (p of d.points; track $index; let i = $index) {
                @if (i < 12) {
                  <div class="sd-row">
                    <span class="sd-label">#{{ i + 1 }} (price, bar)</span>
                    <span class="sd-ctl">
                      <input
                        type="number"
                        class="sd-price"
                        step="any"
                        [value]="p.price"
                        [attr.aria-label]="'Point ' + (i + 1) + ' price'"
                        (change)="setPoint(i, { price: +$any($event.target).value })"
                      />
                      <input
                        type="datetime-local"
                        class="sd-date"
                        [value]="toLocalInput(p.time)"
                        [attr.aria-label]="'Point ' + (i + 1) + ' time'"
                        (change)="setPointTime(i, $any($event.target).value)"
                      />
                    </span>
                  </div>
                }
              }
              <p class="sd-hint">Times are UTC.</p>
            }
            @case ('visibility') {
              @for (g of groups; track g.unit) {
                @let v = vis()[g.unit];
                <div class="sd-row sd-vis" [class.disabled]="!g.available">
                  <label class="sd-label sd-check">
                    <input type="checkbox" [checked]="g.available && v.on" [disabled]="!g.available" (change)="setVis(g.unit, { on: $any($event.target).checked })" />
                    {{ g.label }}
                  </label>
                  <span class="sd-ctl">
                    <input type="number" class="sd-num" [min]="g.min" [max]="g.max" [value]="v.from" [disabled]="!g.available || !v.on" (change)="setVis(g.unit, { from: +$any($event.target).value })" />
                    <input type="range" class="sd-range" [min]="g.min" [max]="g.max" [value]="v.to" [disabled]="!g.available || !v.on" (input)="setVis(g.unit, { to: +$any($event.target).value })" />
                    <input type="number" class="sd-num" [min]="g.min" [max]="g.max" [value]="v.to" [disabled]="!g.available || !v.on" (change)="setVis(g.unit, { to: +$any($event.target).value })" />
                  </span>
                </div>
              }
            }
          }
        </div>

        <footer class="sd-foot">
          <span class="sd-anchor">
            <button type="button" class="sd-btn" (click)="toggleColor('template')">Template ▾</button>
            @if (colorOpen() === 'template') {
              <app-template-menu class="sd-pop sd-up" [drawing]="d" (apply)="applyTemplate($event)" />
            }
          </span>
          <span class="sd-spacer"></span>
          <button type="button" class="sd-btn" (click)="cancel()">Cancel</button>
          <button type="button" class="sd-btn primary" (click)="ok()">Ok</button>
        </footer>
      </div>
    }
  `,
  styles: `
    .sd-backdrop { position: fixed; inset: 0; z-index: 1000; background: rgba(0, 0, 0, 0.2); }
    .sd {
      position: fixed; z-index: 1001; left: 50%; top: 50%; transform: translate(-50%, -50%);
      width: min(460px, calc(100vw - 32px)); max-height: calc(100vh - 64px); display: flex; flex-direction: column;
      background: var(--tv-bg, #fff); color: var(--tv-ink, #131722); border-radius: 6px;
      box-shadow: 0 2px 24px rgba(0, 0, 0, 0.3); font-size: 14px;
    }
    .sd-head { display: flex; align-items: center; padding: 16px 20px 10px; }
    .sd-title { font-size: 20px; font-weight: 600; flex: 1; }
    .sd-x { border: 0; background: none; color: var(--tv-muted, #787b86); font-size: 24px; cursor: pointer; line-height: 1; }
    .sd-tabs { display: flex; gap: 18px; padding: 0 20px; border-bottom: 1px solid var(--tv-line, #e0e3eb); }
    .sd-tab {
      border: 0; background: none; color: var(--tv-muted, #787b86); font: inherit; padding: 8px 0;
      border-bottom: 3px solid transparent; cursor: pointer; margin-bottom: -1px;
    }
    .sd-tab.on { color: var(--tv-ink, #131722); border-bottom-color: var(--tv-ink, #131722); }
    .sd-body { padding: 14px 20px; overflow: auto; min-height: 200px; }
    .sd-row { display: flex; align-items: center; gap: 12px; min-height: 36px; }
    .sd-label { flex: 0 0 140px; }
    .sd-check { display: flex; align-items: center; gap: 8px; cursor: pointer; flex: 1; }
    .sd-check input, .sd-level input[type='checkbox'] { accent-color: var(--tv-blue, #2962ff); width: 16px; height: 16px; }
    .sd-ctl { display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .sd-anchor { position: relative; display: inline-flex; }
    .sd-pop { position: absolute; top: calc(100% + 4px); left: 0; z-index: 5; }
    .sd-up { top: auto; bottom: calc(100% + 4px); }
    .sd-swatch {
      width: 32px; height: 32px; border-radius: 4px; cursor: pointer;
      border: 1px solid var(--tv-line, #e0e3eb); box-shadow: inset 0 0 0 3px var(--tv-bg, #fff);
    }
    .sd-swatch:disabled { opacity: 0.4; cursor: default; }
    select, .sd-num, .sd-price, .sd-date, .sd-text, .sd-area {
      height: 32px; padding: 0 8px; border: 1px solid var(--tv-line, #e0e3eb); border-radius: 4px;
      background: var(--tv-bg, #fff); color: inherit; font: inherit; font-size: 13px;
    }
    .sd-num { width: 64px; }
    .sd-price { width: 110px; }
    .sd-date { width: 190px; }
    .sd-text { flex: 1; }
    .sd-area { width: 100%; height: auto; padding: 8px; resize: vertical; box-sizing: border-box; margin-top: 8px; }
    .sd-mini { width: 32px; height: 26px; padding: 0; border: 1px solid var(--tv-line, #e0e3eb); border-radius: 4px; background: none; }
    .sd-toggle {
      width: 32px; height: 32px; border: 1px solid var(--tv-line, #e0e3eb); border-radius: 4px;
      background: none; color: inherit; cursor: pointer;
    }
    .sd-toggle.on { background: var(--tv-active-bg, #e3effd); color: var(--tv-blue, #2962ff); border-color: var(--tv-blue, #2962ff); }
    .sd-textrow { gap: 8px; }
    .sd-levels-row { align-items: flex-start; }
    .sd-levels { width: 100%; padding: 6px 0; }
    .sd-levels-head { margin-bottom: 6px; color: var(--tv-muted, #787b86); }
    .sd-levels-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 16px; }
    .sd-level { display: inline-flex; align-items: center; gap: 6px; }
    .sd-link { border: 0; background: none; color: var(--tv-blue, #2962ff); cursor: pointer; padding: 8px 0; font: inherit; }
    .sd-vis.disabled { color: var(--tv-muted, #787b86); }
    .sd-range { width: 110px; accent-color: var(--tv-blue, #2962ff); }
    .sd-hint { color: var(--tv-muted, #787b86); font-size: 12px; margin: 8px 0 0; }
    .sd-foot { display: flex; align-items: center; gap: 8px; padding: 14px 20px; border-top: 1px solid var(--tv-line, #e0e3eb); }
    .sd-spacer { flex: 1; }
    .sd-btn {
      height: 34px; padding: 0 16px; border-radius: 6px; border: 1px solid var(--tv-line, #e0e3eb);
      background: var(--tv-bg, #fff); color: inherit; font: inherit; cursor: pointer;
    }
    .sd-btn:hover { background: var(--tv-hover, #f0f3fa); }
    .sd-btn.primary { background: var(--tv-ink, #131722); color: var(--tv-bg, #fff); border-color: var(--tv-ink, #131722); }
    @media (max-width: 480px) { .sd-label { flex-basis: 100px; } .sd-date { width: 160px; } }
  `,
})
export class DrawingSettingsDialogComponent implements OnInit {
  private readonly store = inject(DrawingStore);

  readonly drawingId = input.required<string>();
  /** Resolutions this chart offers (visibility tab). */
  readonly resolutions = input.required<readonly string[]>();
  readonly closed = output<void>();

  readonly tab = signal<Tab>('style');
  readonly colorOpen = signal<'line' | 'fill' | 'text' | 'template' | null>(null);
  readonly dashes: DashStyle[] = ['solid', 'dashed', 'dotted'];
  readonly fontSizes = [10, 11, 12, 14, 16, 20, 24, 28, 32, 40];
  readonly groups = INTERVAL_GROUPS;

  readonly live = computed(() => this.store.allDrawings().find((d) => d.id === this.drawingId()) ?? null);
  readonly title = computed(() => {
    const d = this.live();
    return d ? (toolFor(d.kind)?.label ?? d.kind) : '';
  });
  readonly fillable = computed(() => (this.live() ? hasFill(this.live()!) : false));
  readonly tabs = computed(() => {
    const d = this.live();
    const out: { id: Tab; label: string }[] = [{ id: 'style', label: 'Style' }];
    if (d && hasText(d)) out.push({ id: 'text', label: 'Text' });
    out.push({ id: 'coords', label: 'Coordinates' }, { id: 'visibility', label: 'Visibility' });
    return out;
  });
  private readonly behaviorOptions = computed<readonly ToolOption[]>(() => {
    const d = this.live();
    return d ? (behaviorFor(d.kind)?.options ?? []) : [];
  });
  readonly styleOptions = computed(() => this.behaviorOptions().filter((o) => o.tab !== 'text'));
  readonly textOptions = computed(() => this.behaviorOptions().filter((o) => o.tab === 'text'));
  readonly opts = computed(() => {
    const d = this.live();
    return d ? optionsOf(behaviorFor(d.kind), d) : {};
  });
  readonly vis = signal<IntervalVisibility>(visibilityFromList(undefined, []));

  private closedOnce = false;

  ngOnInit(): void {
    // One snapshot for the whole dialog: Ok = one undo step, Cancel = restore.
    this.store.beginGesture();
    this.vis.set(visibilityFromList(this.live()?.visibleOn, this.resolutions()));
  }

  toggleColor(k: 'line' | 'fill' | 'text' | 'template'): void {
    this.colorOpen.set(this.colorOpen() === k ? null : k);
  }

  style(patch: Partial<DrawingStyle>): void {
    this.store.updateStyle(this.drawingId(), patch, false);
  }

  toggleFill(on: boolean): void {
    const d = this.live();
    if (!d) return;
    this.style({ fill: on ? `${parseColor(d.style.color).hex}33` : null });
  }

  option(key: string, value: unknown): void {
    this.store.updateOptions(this.drawingId(), { [key]: value }, false);
  }

  levelsOf(key: string): Level[] {
    const v = this.opts()[key];
    return Array.isArray(v) ? (v as Level[]) : [];
  }

  setLevel(key: string, i: number, patch: Partial<Level>): void {
    const next = this.levelsOf(key).map((l, j) => (j === i ? { ...l, ...patch } : l));
    this.option(key, next);
  }

  addLevel(key: string): void {
    const cur = this.levelsOf(key);
    const last = cur.at(-1);
    this.option(key, [...cur, { value: (last?.value ?? 0) + 0.5, color: last?.color ?? '#2962FF', visible: true }]);
  }

  hex(c: string | undefined): string {
    return parseColor(c).hex.toLowerCase();
  }

  setPoint(i: number, patch: Partial<DrawingPoint>): void {
    const d = this.live();
    if (!d || !Number.isFinite(patch.price ?? 0)) return;
    const points = d.points.map((p, j) => (j === i ? { ...p, ...patch } : p));
    this.store.update(d.id, { points }, false);
  }

  setPointTime(i: number, value: string): void {
    const t = Date.parse(value + 'Z');
    if (Number.isFinite(t)) this.setPoint(i, { time: t });
  }

  toLocalInput(ms: number): string {
    return new Date(ms).toISOString().slice(0, 16);
  }

  setVis(unit: IntervalUnit, patch: Partial<{ on: boolean; from: number; to: number }>): void {
    const g = { ...this.vis()[unit], ...patch };
    if (g.from > g.to) {
      if (patch.from !== undefined) g.to = g.from;
      else g.from = g.to;
    }
    const next = { ...this.vis(), [unit]: g };
    this.vis.set(next);
    this.store.update(this.drawingId(), { visibleOn: visibilityToList(next, this.resolutions()) }, false);
  }

  applyTemplate(t: DrawingTemplate): void {
    const d = this.live();
    if (!d) return;
    this.store.update(
      d.id,
      {
        style: { ...d.style, ...t.style, text: d.style.text },
        options: t.options && Object.keys(t.options).length ? { ...t.options } : undefined,
      },
      false,
    );
    this.colorOpen.set(null);
  }

  onEnter(ev: Event): void {
    if ((ev.target as HTMLElement).tagName === 'TEXTAREA') return;
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
    this.store.cancelGesture();
    this.closed.emit();
  }
}

