import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { exposureKindOf } from '@features/news-intel/news-intel.logic';
import { ExposureKindName } from '@features/news-intel/news-intel.types';
import {
  divergingFill,
  divergingInk,
  KIND_ORDER,
  kindColor,
  kindLabel,
  linePath,
  shortKey,
  signed,
} from './ni-viz';

// ═════════════════════════════════════════════════════════════════════════════
// Pressure map — every tracked exposure as a cell, grouped by kind in the fixed kind order.
// Fill = diverging (desk up/down around a neutral midpoint) by signed score; the number and its sign are
// printed in the cell, so polarity is never colour alone. Bottom bar = absolute pressure (how much news is
// in play at all). A thin line = the score's recent path.
// ═════════════════════════════════════════════════════════════════════════════

export interface PressureCell {
  key: string;
  score: number;
  absolute: number;
  articles: number;
  stories: number;
  category: string | null;
  liveShare: number | null;
  asOfUtc: string | null;
  spark?: readonly number[];
  headline?: string | null;
}

interface CellGroup {
  kind: ExposureKindName;
  label: string;
  color: string;
  cells: PressureCell[];
  net: number;
}

@Component({
  selector: 'app-ni-pressure-map',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="pm">
      @for (g of groups(); track g.kind) {
        <div class="grp">
          <div class="gh">
            <i [style.background]="g.color"></i>
            <span class="gl">{{ g.label }}</span>
            <span class="gc">{{ g.cells.length }}</span>
          </div>
          <div class="cells">
            @for (c of g.cells; track c.key) {
              <button
                type="button"
                class="cell"
                [class.sel]="selectedIndex(c.key) >= 0"
                [style.background]="fill(c.score)"
                [style.color]="ink(c.score)"
                (click)="pick.emit(c.key)"
                [attr.aria-label]="c.key + ' pressure ' + sign(c.score)"
              >
                <span class="top">
                  <span class="key">{{ short(c.key) }}</span>
                  <span class="sc">{{ sign(c.score) }}</span>
                </span>
                @if (c.spark && c.spark.length > 1) {
                  <svg class="spk" viewBox="0 0 100 18" preserveAspectRatio="none" aria-hidden="true">
                    <line x1="0" x2="100" y1="9" y2="9" class="zl" />
                    <path [attr.d]="sparkPath(c.spark)" />
                  </svg>
                } @else {
                  <span class="spk-empty"></span>
                }
                <span class="abs"><i [style.width.%]="Math.min(100, c.absolute * 100)"></i></span>
                @if (selectedIndex(c.key) >= 0) {
                  <span class="dot" [style.background]="seriesColors()[selectedIndex(c.key)]"></span>
                }
                <span class="tip" role="tooltip">
                  <span class="th"><b>{{ c.key }}</b><span [class.pos]="c.score > 0" [class.neg]="c.score < 0">{{ sign(c.score, 3) }}</span></span>
                  <span class="tr"><span>In play</span><b>{{ c.absolute.toFixed(3) }}</b></span>
                  <span class="tr"><span>Articles · stories</span><b>{{ c.articles }} · {{ c.stories }}</b></span>
                  @if (c.category) {
                    <span class="tr"><span>Dominant</span><b>{{ c.category }}</b></span>
                  }
                  @if (c.liveShare !== null) {
                    <span class="tr"><span>Live edge</span><b>{{ (c.liveShare * 100).toFixed(0) }}%</b></span>
                  }
                  @if (c.headline) {
                    <span class="hl">“{{ c.headline }}”</span>
                  }
                  <span class="hint">Click to focus · adds to compare</span>
                </span>
              </button>
            }
          </div>
        </div>
      } @empty {
        <div class="empty">No pressure readings yet.</div>
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .pm {
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .gh {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-bottom: 5px;
        font-size: 10.5px;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--text-tertiary);
        font-weight: 600;
      }
      .gh i {
        width: 8px;
        height: 8px;
        border-radius: 2px;
      }
      .gc {
        font-weight: 500;
        opacity: 0.8;
      }
      .cells {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(92px, 1fr));
        gap: 4px;
      }
      .cell {
        position: relative;
        border: 0;
        border-radius: 7px;
        padding: 5px 7px 4px;
        height: 52px;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        cursor: pointer;
        text-align: left;
        font: inherit;
        outline: none;
        box-shadow: inset 0 0 0 1px var(--border);
        transition: transform 0.1s ease, box-shadow 0.1s ease;
      }
      .cell:hover,
      .cell:focus-visible {
        transform: translateY(-1px);
        box-shadow: inset 0 0 0 1px var(--text-tertiary), var(--shadow-md);
        z-index: 5;
      }
      .cell.sel {
        box-shadow: inset 0 0 0 1.5px color-mix(in oklab, var(--text-primary) 70%, transparent);
      }
      .top {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        gap: 4px;
      }
      .key {
        font-family: var(--ni-mono, ui-monospace, Menlo, monospace);
        font-size: 11px;
        font-weight: 600;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .sc {
        font-size: 11px;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }
      .spk {
        width: 100%;
        height: 14px;
        display: block;
        overflow: visible;
      }
      .spk path {
        fill: none;
        stroke: currentColor;
        stroke-width: 1.3;
        vector-effect: non-scaling-stroke;
        opacity: 0.85;
      }
      .zl {
        stroke: currentColor;
        opacity: 0.18;
        stroke-width: 1;
        vector-effect: non-scaling-stroke;
      }
      .spk-empty {
        height: 14px;
      }
      .abs {
        height: 3px;
        border-radius: 2px;
        background: color-mix(in oklab, currentColor 14%, transparent);
        overflow: hidden;
      }
      .abs i {
        display: block;
        height: 100%;
        background: currentColor;
        opacity: 0.55;
        border-radius: 2px;
      }
      .dot {
        position: absolute;
        top: -3px;
        right: -3px;
        width: 9px;
        height: 9px;
        border-radius: 50%;
        box-shadow: 0 0 0 2px var(--ni-panel, #fff);
      }
      .tip {
        position: absolute;
        left: 0;
        bottom: calc(100% + 6px);
        z-index: 50;
        width: 240px;
        display: flex;
        flex-direction: column;
        gap: 3px;
        padding: 8px 10px;
        border-radius: 9px;
        background: var(--ni-panel, #fff);
        color: var(--text-primary);
        border: 1px solid var(--border);
        box-shadow: var(--shadow-lg);
        font-size: 11.5px;
        opacity: 0;
        pointer-events: none;
        transform: translateY(3px);
        transition:
          opacity 0.1s ease,
          transform 0.1s ease;
      }
      .cell:hover .tip,
      .cell:focus-visible .tip {
        opacity: 1;
        transform: none;
      }
      .th,
      .tr {
        display: flex;
        justify-content: space-between;
        gap: 8px;
      }
      .th {
        font-family: var(--ni-mono, monospace);
        margin-bottom: 2px;
      }
      .tr span {
        color: var(--text-secondary);
      }
      .tr b,
      .th span {
        font-variant-numeric: tabular-nums;
      }
      .hl {
        margin-top: 3px;
        color: var(--text-secondary);
        line-height: 1.35;
        display: -webkit-box;
        -webkit-line-clamp: 3;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      .hint {
        margin-top: 3px;
        font-size: 10.5px;
        color: var(--text-tertiary);
      }
      .pos {
        color: var(--ni-up);
      }
      .neg {
        color: var(--ni-down);
      }
      .empty {
        color: var(--text-tertiary);
        font-size: 12px;
        padding: 10px 0;
      }
    `,
  ],
})
export class NiPressureMapComponent {
  readonly cells = input<readonly PressureCell[]>([]);
  /** Keys currently in the compare set, in selection order (their dot uses the series colour). */
  readonly selected = input<readonly string[]>([]);
  readonly seriesColors = input<readonly string[]>([]);
  /** Score magnitude that reaches the full pole colour. */
  readonly full = input(0.6);
  readonly pick = output<string>();
  readonly Math = Math;

  readonly groups = computed<CellGroup[]>(() => {
    const by = new Map<ExposureKindName, PressureCell[]>();
    for (const c of this.cells()) {
      const k = exposureKindOf(c.key);
      if (!k) continue;
      (by.get(k) ?? by.set(k, []).get(k)!).push(c);
    }
    return KIND_ORDER.filter((k) => by.has(k)).map((k) => {
      const cells = [...by.get(k)!].sort((a, b) => Math.abs(b.score) - Math.abs(a.score) || a.key.localeCompare(b.key));
      return {
        kind: k,
        label: k === 'Currency' ? 'Currencies' : k === 'EquityIndex' ? 'Indices' : k === 'Equity' ? 'Stocks' : k === 'Commodity' ? 'Commodities' : k === 'Factor' ? 'Factors' : kindLabel(k),
        color: kindColor(k),
        cells,
        net: cells.reduce((s, c) => s + c.score, 0),
      };
    });
  });

  selectedIndex(key: string): number {
    return this.selected().indexOf(key);
  }
  fill(v: number): string {
    return divergingFill(v, this.full());
  }
  ink(v: number): string {
    return divergingInk(v, this.full());
  }
  sign(v: number, d = 2): string {
    return signed(v, d);
  }
  short(k: string): string {
    return shortKey(k);
  }
  sparkPath(xs: readonly number[]): string {
    const m = Math.max(0.05, ...xs.map((x) => Math.abs(x)));
    return linePath(xs, 100, 18, -m, m);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Multi-series line chart (≤ 6 series, selection-ordered colours) with crosshair + tooltip and direct end
// labels. One y-axis only.
// ═════════════════════════════════════════════════════════════════════════════

export interface LineSeries {
  key: string;
  color: string;
  points: readonly { t: number; v: number }[];
}

@Component({
  selector: 'app-ni-lines',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="lc" (mouseleave)="hx.set(null)">
      <svg
        [attr.viewBox]="'0 0 ' + W + ' ' + H"
        [style.height.px]="height()"
        preserveAspectRatio="none"
        (mousemove)="move($event)"
        role="img"
        [attr.aria-label]="'Line chart of ' + series().length + ' series'"
      >
        @for (g of yTicks(); track g.v) {
          <line [attr.x1]="0" [attr.x2]="PW" [attr.y1]="g.y" [attr.y2]="g.y" [class.zero]="g.v === 0" class="grid" />
        }
        @for (s of drawn(); track s.key) {
          <path [attr.d]="s.d" [attr.stroke]="s.color" class="ln" [class.dim]="focusKey() !== null && focusKey() !== s.key" />
        }
        @if (cross(); as c) {
          <line [attr.x1]="c.x" [attr.x2]="c.x" y1="0" [attr.y2]="PH" class="xh" />
          @for (p of c.points; track p.key) {
            <circle [attr.cx]="c.x" [attr.cy]="p.y" r="3.2" [attr.fill]="p.color" class="pt" />
          }
        }
      </svg>
      <div class="ylab">
        @for (g of yTicks(); track g.v) {
          <span [style.top.%]="(g.y / H) * 100">{{ fmtY(g.v) }}</span>
        }
      </div>
      <div class="ends">
        @for (e of endLabels(); track e.key) {
          <span [style.top.%]="(e.y / H) * 100" [style.color]="'var(--text-primary)'" (mouseenter)="focusKey.set(e.key)" (mouseleave)="focusKey.set(null)">
            <i [style.background]="e.color"></i>{{ e.label }} <b>{{ e.value }}</b>
          </span>
        }
      </div>
      <div class="xlab">
        <span>{{ xStart() }}</span><span>{{ xMid() }}</span><span>now</span>
      </div>
      @if (cross(); as c) {
        <div class="tip" [style.left.%]="(c.x / W) * 100" [class.flip]="c.x > PW * 0.6">
          <div class="tt">{{ c.time }}</div>
          @for (p of c.points; track p.key) {
            <div class="tr"><i [style.background]="p.color"></i><span>{{ p.label }}</span><b>{{ p.text }}</b></div>
          }
        </div>
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
        min-width: 0;
      }
      .lc {
        position: relative;
        padding: 0 96px 16px 26px;
      }
      svg {
        display: block;
        width: 100%;
        overflow: visible;
      }
      .grid {
        stroke: var(--ni-grid);
        stroke-width: 1;
        vector-effect: non-scaling-stroke;
      }
      .grid.zero {
        stroke: var(--text-tertiary);
        opacity: 0.5;
      }
      .ln {
        fill: none;
        stroke-width: 2;
        vector-effect: non-scaling-stroke;
        stroke-linejoin: round;
        transition: opacity 0.12s ease;
      }
      .ln.dim {
        opacity: 0.18;
      }
      .xh {
        stroke: var(--text-tertiary);
        stroke-width: 1;
        stroke-dasharray: 3 3;
        vector-effect: non-scaling-stroke;
      }
      .pt {
        stroke: var(--ni-panel, #fff);
        stroke-width: 2;
        vector-effect: non-scaling-stroke;
      }
      .ylab {
        position: absolute;
        left: 0;
        top: 0;
        bottom: 16px;
        width: 22px;
      }
      .ylab span {
        position: absolute;
        right: 0;
        transform: translateY(-50%);
        font-size: 10px;
        color: var(--text-tertiary);
        font-variant-numeric: tabular-nums;
      }
      .ends {
        position: absolute;
        right: 0;
        top: 0;
        bottom: 16px;
        width: 92px;
      }
      .ends span {
        position: absolute;
        left: 4px;
        transform: translateY(-50%);
        display: flex;
        align-items: center;
        gap: 4px;
        font-size: 10.5px;
        font-family: var(--ni-mono, monospace);
        white-space: nowrap;
        cursor: default;
      }
      .ends i {
        width: 8px;
        height: 2px;
        border-radius: 1px;
      }
      .ends b {
        font-weight: 600;
        font-variant-numeric: tabular-nums;
      }
      .xlab {
        position: absolute;
        left: 26px;
        right: 96px;
        bottom: 0;
        display: flex;
        justify-content: space-between;
        font-size: 10px;
        color: var(--text-tertiary);
      }
      .tip {
        position: absolute;
        top: 4px;
        margin-left: 34px;
        background: var(--ni-panel, #fff);
        border: 1px solid var(--border);
        border-radius: 8px;
        box-shadow: var(--shadow-lg);
        padding: 6px 8px;
        font-size: 11px;
        pointer-events: none;
        z-index: 20;
        min-width: 130px;
      }
      .tip.flip {
        transform: translateX(calc(-100% - 20px));
      }
      .tt {
        color: var(--text-tertiary);
        margin-bottom: 3px;
      }
      .tr {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .tr i {
        width: 8px;
        height: 8px;
        border-radius: 50%;
      }
      .tr span {
        font-family: var(--ni-mono, monospace);
        flex: 1;
      }
      .tr b {
        font-variant-numeric: tabular-nums;
      }
    `,
  ],
})
export class NiLinesComponent {
  readonly series = input<readonly LineSeries[]>([]);
  readonly height = input(200);
  readonly domain = input<[number, number]>([-1, 1]);
  readonly fromMs = input<number | null>(null);
  readonly digits = input(2);

  readonly W = 600;
  readonly H = 200;
  readonly PW = 600;
  readonly PH = 200;
  readonly hx = signal<number | null>(null);
  readonly focusKey = signal<string | null>(null);

  private readonly tRange = computed<[number, number]>(() => {
    const now = Date.now();
    let lo = this.fromMs() ?? Infinity;
    if (!Number.isFinite(lo)) {
      for (const s of this.series()) if (s.points.length) lo = Math.min(lo, s.points[0].t);
    }
    if (!Number.isFinite(lo)) lo = now - 48 * 3600_000;
    return [lo, now];
  });
  private x(t: number): number {
    const [a, b] = this.tRange();
    return ((t - a) / (b - a || 1)) * this.PW;
  }
  private y(v: number): number {
    const [lo, hi] = this.domain();
    const c = Math.max(lo, Math.min(hi, v));
    return this.PH - ((c - lo) / (hi - lo || 1)) * this.PH;
  }
  readonly yTicks = computed(() => {
    const [lo, hi] = this.domain();
    const vs = lo < 0 && hi > 0 ? [hi, hi / 2, 0, lo / 2, lo] : [hi, (hi + lo) / 2, lo];
    return vs.map((v) => ({ v, y: this.y(v) }));
  });
  readonly drawn = computed(() =>
    this.series().map((s) => ({
      key: s.key,
      color: s.color,
      d: s.points.map((p, i) => `${i ? 'L' : 'M'}${this.x(p.t).toFixed(1)},${this.y(p.v).toFixed(1)}`).join(''),
    })),
  );
  readonly endLabels = computed(() => {
    const items = this.series()
      .filter((s) => s.points.length)
      .map((s) => {
        const last = s.points[s.points.length - 1];
        return { key: s.key, label: shortKey(s.key), color: s.color, y: this.y(last.v), value: signed(last.v, this.digits()) };
      })
      .sort((a, b) => a.y - b.y);
    const gap = 13;
    for (let i = 1; i < items.length; i++) if (items[i].y - items[i - 1].y < gap) items[i].y = items[i - 1].y + gap;
    return items;
  });
  readonly cross = computed(() => {
    const hx = this.hx();
    if (hx === null || !this.series().length) return null;
    const [a, b] = this.tRange();
    const t = a + (hx / this.PW) * (b - a);
    const points = this.series()
      .map((s) => {
        const p = nearest(s.points, t);
        return p ? { key: s.key, label: shortKey(s.key), color: s.color, y: this.y(p.v), text: signed(p.v, this.digits()) } : null;
      })
      .filter((p): p is NonNullable<typeof p> => p !== null);
    const d = new Date(t);
    return { x: hx, points, time: d.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' }) };
  });
  readonly xStart = computed(() => rel(this.tRange()[0]));
  readonly xMid = computed(() => rel((this.tRange()[0] + this.tRange()[1]) / 2));

  fmtY(v: number): string {
    return v === 0 ? '0' : signed(v, Math.abs(v) < 1 ? 1 : 0);
  }
  move(e: MouseEvent): void {
    const r = (e.currentTarget as SVGElement).getBoundingClientRect();
    if (!r.width) return;
    this.hx.set(Math.max(0, Math.min(this.PW, ((e.clientX - r.left) / r.width) * this.W)));
  }
}

function nearest(pts: readonly { t: number; v: number }[], t: number): { t: number; v: number } | null {
  if (!pts.length) return null;
  let lo = 0;
  let hi = pts.length - 1;
  if (t <= pts[0].t) return pts[0];
  if (t >= pts[hi].t) return pts[hi];
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (pts[m].t <= t) lo = m;
    else hi = m;
  }
  return t - pts[lo].t <= pts[hi].t - t ? pts[lo] : pts[hi];
}

function rel(t: number): string {
  const h = Math.round((Date.now() - t) / 3600_000);
  return h <= 0 ? 'now' : `−${h}h`;
}

// ═════════════════════════════════════════════════════════════════════════════
// Stacked bars over time by category (fixed category order; extras fold into "Other").
// ═════════════════════════════════════════════════════════════════════════════

export interface StackBucket {
  label: string;
  parts: Readonly<Record<string, number>>;
}

@Component({
  selector: 'app-ni-stacked',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="sb" (mouseleave)="hover.set(null)">
      <div class="plot" [style.height.px]="height()">
        @for (b of bars(); track $index) {
          <div class="col" (mouseenter)="hover.set($index)" [class.dim]="hover() !== null && hover() !== $index">
            <div class="stack" [style.height.%]="b.pct">
              @for (s of b.segs; track s.cat) {
                <i [style.flex-grow]="s.v" [style.background]="s.color"></i>
              }
            </div>
          </div>
        }
        @if (hover() !== null && bars()[hover()!]; as b) {
          <div class="tip" [style.left.%]="((hover()! + 0.5) / bars().length) * 100" [class.flip]="hover()! > bars().length * 0.6">
            <div class="tt">{{ b.label }} · <b>{{ b.total }}</b></div>
            @for (s of b.segsDesc; track s.cat) {
              <div class="tr"><i [style.background]="s.color"></i><span>{{ s.cat }}</span><b>{{ s.v }}</b></div>
            }
          </div>
        }
      </div>
      <div class="axis"><span>{{ bars()[0]?.label }}</span><span>peak {{ peak() }}/bucket</span><span>{{ bars()[bars().length - 1]?.label }}</span></div>
      @if (showLegend()) {
      <div class="legend">
        @for (c of legend(); track c.cat) {
          <span><i [style.background]="c.color"></i>{{ c.cat }} <b>{{ c.total }}</b></span>
        }
      </div>
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
        min-width: 0;
      }
      .plot {
        position: relative;
        display: flex;
        align-items: flex-end;
        gap: 2px;
        border-bottom: 1px solid var(--ni-grid);
      }
      .col {
        flex: 1;
        height: 100%;
        display: flex;
        align-items: flex-end;
        min-width: 0;
        transition: opacity 0.1s ease;
      }
      .col.dim {
        opacity: 0.45;
      }
      .stack {
        width: 100%;
        display: flex;
        flex-direction: column-reverse;
        gap: 1px;
        border-radius: 3px 3px 0 0;
        overflow: hidden;
        min-height: 1px;
      }
      .stack i {
        display: block;
        flex-basis: 0;
        min-height: 1px;
      }
      .axis {
        display: flex;
        justify-content: space-between;
        font-size: 10px;
        color: var(--text-tertiary);
        margin-top: 3px;
      }
      .legend {
        display: flex;
        flex-wrap: wrap;
        gap: 4px 12px;
        margin-top: 6px;
        font-size: 11px;
        color: var(--text-secondary);
      }
      .legend span {
        display: inline-flex;
        align-items: center;
        gap: 5px;
      }
      .legend i {
        width: 8px;
        height: 8px;
        border-radius: 2px;
      }
      .legend b {
        color: var(--text-primary);
        font-weight: 600;
        font-variant-numeric: tabular-nums;
      }
      .tip {
        position: absolute;
        bottom: calc(100% + 4px);
        transform: translateX(-50%);
        background: var(--ni-panel, #fff);
        border: 1px solid var(--border);
        border-radius: 8px;
        box-shadow: var(--shadow-lg);
        padding: 6px 8px;
        font-size: 11px;
        pointer-events: none;
        z-index: 20;
        min-width: 140px;
      }
      .tt {
        color: var(--text-tertiary);
        margin-bottom: 3px;
      }
      .tr {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .tr i {
        width: 8px;
        height: 8px;
        border-radius: 2px;
      }
      .tr span {
        flex: 1;
      }
      .tr b,
      .tt b {
        font-variant-numeric: tabular-nums;
        color: var(--text-primary);
      }
    `,
  ],
})
export class NiStackedComponent {
  readonly buckets = input<readonly StackBucket[]>([]);
  /** Fixed category order; categories beyond `colors.length` fold into "Other". */
  readonly categories = input<readonly string[]>([]);
  readonly colors = input<readonly string[]>([]);
  readonly height = input(90);
  readonly showLegend = input(true);
  readonly hover = signal<number | null>(null);

  private readonly shown = computed(() => this.categories().slice(0, this.colors().length));
  private colorOf(cat: string): string {
    const i = this.shown().indexOf(cat);
    return i >= 0 ? this.colors()[i] : 'var(--text-tertiary)';
  }
  private fold(parts: Readonly<Record<string, number>>): { cat: string; v: number }[] {
    const shown = new Set(this.shown());
    const out = this.shown().map((cat) => ({ cat, v: parts[cat] ?? 0 }));
    const other = Object.entries(parts).filter(([k]) => !shown.has(k)).reduce((s, [, v]) => s + v, 0);
    if (other > 0) out.push({ cat: 'Other', v: other });
    return out;
  }
  readonly peak = computed(() =>
    Math.max(1, ...this.buckets().map((b) => Object.values(b.parts).reduce((s, v) => s + v, 0))),
  );
  readonly bars = computed(() =>
    this.buckets().map((b) => {
      const segs = this.fold(b.parts)
        .filter((s) => s.v > 0)
        .map((s) => ({ ...s, color: this.colorOf(s.cat) }));
      const total = segs.reduce((s, x) => s + x.v, 0);
      return { label: b.label, total, pct: (total / this.peak()) * 100, segs, segsDesc: [...segs].reverse() };
    }),
  );
  readonly legend = computed(() => {
    const totals = new Map<string, number>();
    for (const b of this.buckets()) for (const s of this.fold(b.parts)) totals.set(s.cat, (totals.get(s.cat) ?? 0) + s.v);
    return [...totals.entries()].filter(([, v]) => v > 0).map(([cat, total]) => ({ cat, total, color: this.colorOf(cat) }));
  });
}
