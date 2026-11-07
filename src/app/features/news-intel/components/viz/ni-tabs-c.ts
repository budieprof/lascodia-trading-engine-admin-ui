import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { signed } from './ni-viz';

/**
 * Widgets for the Gold set & evals and Event study tabs (dense redesign, DESIGN.md). Colours are the
 * inherited --ni-* variables; every mark has a hover read-out and every value is also printed, so colour is
 * never the only carrier.
 */

// ── Score across runs: one small multiple per field ─────────────────────────
export interface RunScore {
  id: number;
  value: number | null;
}

@Component({
  selector: 'app-ni-run-bars',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="rb" (mouseleave)="hover.set(null)">
      <div class="hd">
        <span class="t">{{ label() }}</span>
        <span class="v">{{ headline() }}</span>
      </div>
      <div class="plot">
        <i class="ref" [style.bottom.%]="ref() * 100" [title]="'reference ' + ref()"></i>
        @for (r of bars(); track r.id) {
          <button
            type="button"
            class="col"
            [class.sel]="r.id === selected()"
            [class.dim]="hover() !== null && hover() !== r.id"
            (mouseenter)="hover.set(r.id)"
            (click)="pick.emit(r.id)"
            [attr.aria-label]="label() + ' run ' + r.id + ' ' + r.text"
          >
            <span class="bar" [class.none]="r.value === null" [class.low]="r.low" [style.height.%]="r.h"></span>
          </button>
        }
        @if (hoverBar(); as h) {
          <span class="tip">#{{ h.id }} · {{ h.text }}</span>
        }
      </div>
      <div class="ax">
        <span>#{{ bars()[0]?.id }}</span><span>#{{ bars()[bars().length - 1]?.id }}</span>
      </div>
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
        min-width: 0;
      }
      .hd {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        gap: 6px;
        margin-bottom: 4px;
      }
      .t {
        font-size: 10.5px;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-tertiary);
        font-weight: 600;
        white-space: nowrap;
      }
      .v {
        font-size: 15px;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
      }
      .plot {
        position: relative;
        height: 54px;
        display: flex;
        align-items: flex-end;
        gap: 3px;
        border-bottom: 1px solid var(--ni-grid);
      }
      .ref {
        position: absolute;
        left: 0;
        right: 0;
        height: 0;
        border-top: 1px dashed var(--text-tertiary);
        opacity: 0.45;
        pointer-events: none;
      }
      .col {
        flex: 1;
        max-width: 26px;
        height: 100%;
        display: flex;
        align-items: flex-end;
        border: 0;
        padding: 0;
        background: transparent;
        cursor: pointer;
        transition: opacity 0.1s ease;
      }
      .col.dim {
        opacity: 0.5;
      }
      .bar {
        width: 100%;
        min-height: 2px;
        border-radius: 3px 3px 0 0;
        background: color-mix(in oklab, var(--ni-s1) 55%, transparent);
      }
      .col.sel .bar {
        background: var(--ni-s1);
      }
      .bar.low {
        background: color-mix(in oklab, var(--ni-warn) 60%, transparent);
      }
      .col.sel .bar.low {
        background: var(--ni-warn);
      }
      .bar.none {
        background: var(--ni-sunken);
        height: 100% !important;
        border: 1px dashed var(--border);
      }
      .tip {
        position: absolute;
        top: -20px;
        right: 0;
        font-size: 10.5px;
        background: var(--text-primary);
        color: var(--bg-primary);
        padding: 1px 6px;
        border-radius: 5px;
        pointer-events: none;
        font-variant-numeric: tabular-nums;
      }
      .ax {
        display: flex;
        justify-content: space-between;
        font-size: 10px;
        color: var(--text-tertiary);
        margin-top: 2px;
      }
    `,
  ],
})
export class NiRunBarsComponent {
  readonly label = input.required<string>();
  /** Oldest first. */
  readonly runs = input<readonly RunScore[]>([]);
  readonly selected = input<number | null>(null);
  /** Dashed reference line (e.g. 0.8) — values below it are amber. */
  readonly ref = input(0.8);
  readonly percent = input(false);
  readonly pick = output<number>();
  readonly hover = signal<number | null>(null);

  private text(v: number | null): string {
    if (v === null) return '—';
    return this.percent() ? `${Math.round(v * 100)}%` : v.toFixed(3);
  }
  readonly bars = computed(() =>
    this.runs().map((r) => ({
      id: r.id,
      value: r.value,
      h: r.value === null ? 100 : Math.max(2, Math.min(1, r.value) * 100),
      low: r.value !== null && r.value < this.ref(),
      text: this.text(r.value),
    })),
  );
  readonly headline = computed(() => {
    const sel = this.selected();
    const r = (sel !== null ? this.runs().find((x) => x.id === sel) : null) ?? this.runs()[this.runs().length - 1];
    return r ? this.text(r.value) : '—';
  });
  readonly hoverBar = computed(() => {
    const h = this.hover();
    return h === null ? null : (this.bars().find((b) => b.id === h) ?? null);
  });
}

// ── Per-class F1 heat strip ─────────────────────────────────────────────────
@Component({
  selector: 'app-ni-f1-strip',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="fs">
      <div class="hd">
        <span class="t">{{ label() }}</span>
        @if (macro() !== null) {
          <span class="m">macro F1 <b>{{ macro()!.toFixed(2) }}</b></span>
        }
      </div>
      <div class="cells">
        @for (c of cells(); track c.k) {
          <span
            class="cell"
            [class.zero]="c.v === 0"
            [style.background]="fill(c.v)"
            [style.color]="c.v >= 0.62 ? '#fff' : 'var(--text-primary)'"
            [title]="c.k + ': F1 ' + c.v.toFixed(3) + (c.v === 0 ? ' — never right' : '')"
          >
            <span class="k">{{ c.k }}</span>
            <span class="v">{{ c.v.toFixed(2) }}</span>
          </span>
        } @empty {
          <span class="empty">No per-class scores.</span>
        }
      </div>
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
        min-width: 0;
      }
      .hd {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        margin-bottom: 4px;
      }
      .t {
        font-size: 10.5px;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-tertiary);
        font-weight: 600;
      }
      .m {
        font-size: 11px;
        color: var(--text-secondary);
      }
      .m b {
        color: var(--text-primary);
        font-variant-numeric: tabular-nums;
      }
      .cells {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(98px, 1fr));
        gap: 3px;
      }
      .cell {
        display: flex;
        justify-content: space-between;
        gap: 4px;
        padding: 3px 6px;
        border-radius: 5px;
        font-size: 10.5px;
        box-shadow: inset 0 0 0 1px var(--border);
        min-width: 0;
      }
      .cell.zero {
        box-shadow: inset 0 0 0 1.5px var(--ni-bad);
      }
      .k {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .v {
        font-variant-numeric: tabular-nums;
        font-weight: 600;
      }
      .empty {
        font-size: 11px;
        color: var(--text-tertiary);
      }
    `,
  ],
})
export class NiF1StripComponent {
  readonly label = input.required<string>();
  readonly perClass = input<Readonly<Record<string, number>>>({});
  readonly macro = input<number | null>(null);
  readonly cells = computed(() =>
    Object.entries(this.perClass())
      .map(([k, v]) => ({ k, v }))
      .sort((a, b) => a.v - b.v || a.k.localeCompare(b.k)),
  );
  /** Sequential single hue (magnitude): light → dark accent. */
  fill(v: number): string {
    const t = Math.max(0, Math.min(1, v));
    return `color-mix(in oklab, var(--ni-s1) ${Math.round(8 + t * 82)}%, var(--ni-panel))`;
  }
}

// ── Stacked meter (parts of a whole, fixed order) ───────────────────────────
export interface MeterPart {
  label: string;
  value: number;
  color: string;
}

@Component({
  selector: 'app-ni-stack-meter',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="sm">
      <div class="bar" role="img" [attr.aria-label]="aria()">
        @for (p of parts(); track p.label) {
          @if (p.value > 0) {
            <i [style.flex-grow]="p.value" [style.background]="p.color" [title]="p.label + ': ' + p.value"></i>
          }
        }
      </div>
      <div class="lg">
        @for (p of parts(); track p.label) {
          <span><i [style.background]="p.color"></i>{{ p.label }} <b>{{ p.value }}</b></span>
        }
      </div>
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
        min-width: 0;
      }
      .bar {
        display: flex;
        gap: 2px;
        height: 8px;
        border-radius: 4px;
        overflow: hidden;
        background: var(--ni-sunken);
      }
      .bar i {
        flex-basis: 0;
        min-width: 3px;
      }
      .lg {
        display: flex;
        flex-wrap: wrap;
        gap: 2px 12px;
        margin-top: 5px;
        font-size: 11px;
        color: var(--text-secondary);
      }
      .lg span {
        display: inline-flex;
        align-items: center;
        gap: 5px;
      }
      .lg i {
        width: 8px;
        height: 8px;
        border-radius: 2px;
      }
      .lg b {
        color: var(--text-primary);
        font-variant-numeric: tabular-nums;
      }
    `,
  ],
})
export class NiStackMeterComponent {
  readonly parts = input<readonly MeterPart[]>([]);
  readonly aria = computed(() => this.parts().map((p) => `${p.label} ${p.value}`).join(', '));
}

// ── Forest plot: mean + CI per bucket on one zero-centred axis ──────────────
export interface ForestRow {
  bucket: string;
  n: number;
  clusters: number;
  mean: number;
  ciLow: number | null;
  ciHigh: number | null;
  hitRate: number | null;
  tStat: number | null;
  /** positive | negative | none | thin */
  verdict: string;
}

@Component({
  selector: 'app-ni-forest',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="fp" [class.compact]="compact()">
      <div class="row head">
        <span>{{ dimLabel() }}</span>
        <span class="num">n</span>
        <span class="axis">
          <span>−{{ extentText() }}</span>@if (!compact()) {<span>← against · 0 · with label →</span>}<span>+{{ extentText() }}</span>
        </span>
        <span class="num">mean</span>
        @if (!compact()) {
          <span class="num">hit</span>
        }
      </div>
      @for (r of rows(); track r.bucket) {
        <div class="row" [class.thin]="r.verdict === 'thin'" [title]="tip(r)">
          <span class="b" [title]="r.bucket">{{ r.bucket }}</span>
          <span class="num n">{{ compactN(r.n) }}</span>
          <svg class="ci" viewBox="0 0 400 18" preserveAspectRatio="none" aria-hidden="true">
            <line class="zero" [attr.x1]="x(0)" [attr.x2]="x(0)" y1="0" y2="18" />
            @if (r.ciLow !== null && r.ciHigh !== null) {
              <line class="wh" [class]="'wh ' + r.verdict" [attr.x1]="x(r.ciLow)" [attr.x2]="x(r.ciHigh)" y1="9" y2="9" />
            }
            <circle [class]="'dot ' + r.verdict" [attr.cx]="x(r.mean)" cy="9" [attr.r]="radius(r.n)" />
          </svg>
          <span class="num m" [class.pos]="r.verdict === 'positive'" [class.neg]="r.verdict === 'negative'">{{ sg(r.mean) }}</span>
          @if (!compact()) {
            <span class="num h">{{ r.hitRate === null ? '—' : (r.hitRate * 100).toFixed(0) + '%' }}</span>
          }
        </div>
      } @empty {
        <p class="empty">No result rows for this grouping and horizon.</p>
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
        min-width: 0;
      }
      .row {
        display: grid;
        grid-template-columns: minmax(90px, 1.1fr) 48px minmax(160px, 3fr) 62px 40px;
        align-items: center;
        gap: 8px;
        padding: 2px 0;
        font-size: 11.5px;
        border-bottom: 1px solid var(--border);
      }
      .compact .row {
        grid-template-columns: 58px 36px minmax(80px, 1fr) 54px;
      }
      .row:last-child {
        border-bottom: 0;
      }
      .row.head {
        font-size: 10.5px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-tertiary);
        font-weight: 500;
      }
      .row.thin {
        color: var(--text-tertiary);
      }
      .axis {
        display: flex;
        justify-content: space-between;
        text-transform: none;
        letter-spacing: 0;
        font-variant-numeric: tabular-nums;
      }
      .b {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .n,
      .h {
        color: var(--text-secondary);
      }
      .m {
        font-weight: 600;
      }
      .pos {
        color: var(--ni-up);
      }
      .neg {
        color: var(--ni-down);
      }
      .ci {
        width: 100%;
        height: 18px;
        display: block;
        overflow: visible;
      }
      .zero {
        stroke: var(--text-tertiary);
        stroke-width: 1;
        vector-effect: non-scaling-stroke;
      }
      .wh {
        stroke: var(--text-secondary);
        stroke-width: 2;
        stroke-linecap: round;
        vector-effect: non-scaling-stroke;
      }
      .wh.positive {
        stroke: var(--ni-up);
      }
      .wh.negative {
        stroke: var(--ni-down);
      }
      .wh.thin {
        opacity: 0.35;
      }
      .dot {
        fill: var(--text-secondary);
        stroke: var(--ni-panel, #fff);
        stroke-width: 1.5;
        vector-effect: non-scaling-stroke;
      }
      .dot.positive {
        fill: var(--ni-up);
      }
      .dot.negative {
        fill: var(--ni-down);
      }
      .dot.thin {
        opacity: 0.35;
      }
      .empty {
        font-size: 12px;
        color: var(--text-tertiary);
        padding: 8px 0;
      }
    `,
  ],
})
export class NiForestComponent {
  readonly rows = input<readonly ForestRow[]>([]);
  readonly dimLabel = input('bucket');
  readonly digits = input(3);
  /** Narrow column: no hit-rate column, short axis header. */
  readonly compact = input(false);

  /**
   * Symmetric extent so "with the label" always reads on the right. Set by the well-sampled rows (n ≥ 200)
   * when there are at least three, so one small, wild bucket cannot squash every other row; a whisker
   * beyond the axis is drawn to the edge and its numbers stay in the tooltip and the mean column.
   */
  private readonly extent = computed(() => {
    let e = 0;
    const big = this.rows().filter((r) => r.n >= 200);
    for (const r of big.length >= 3 ? big : this.rows())
      for (const v of [r.mean, r.ciLow, r.ciHigh]) if (v !== null && Number.isFinite(v)) e = Math.max(e, Math.abs(v));
    return (e || 1) * 1.1;
  });
  private readonly maxN = computed(() => Math.max(1, ...this.rows().map((r) => r.n)));
  readonly extentText = computed(() => this.extent().toFixed(this.extent() < 0.1 ? 3 : 2));

  x(v: number): number {
    const e = this.extent();
    return ((Math.max(-e, Math.min(e, v)) + e) / (2 * e)) * 400;
  }
  /** Area ∝ n (sqrt), 2.5–6 px. */
  radius(n: number): number {
    return 2.5 + 3.5 * Math.sqrt(n / this.maxN());
  }
  sg(v: number | null): string {
    return signed(v, this.digits());
  }
  compactN(n: number): string {
    return n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
  }
  tip(r: ForestRow): string {
    const ci = r.ciLow === null || r.ciHigh === null ? 'no CI' : `CI [${this.sg(r.ciLow)}, ${this.sg(r.ciHigh)}]`;
    const verdict =
      r.verdict === 'positive'
        ? 'helps (CI > 0)'
        : r.verdict === 'negative'
          ? 'hurts (CI < 0)'
          : r.verdict === 'thin'
            ? 'too few observations'
            : 'no effect shown';
    return `${r.bucket}: mean ${this.sg(r.mean)} ATR, ${ci}, n ${r.n} / ${r.clusters} clusters, t ${r.tStat?.toFixed(2) ?? '—'} — ${verdict}`;
  }
}
