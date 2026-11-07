import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { kindVar, linePath, shortKey, signed as signedText } from './ni-viz';

/**
 * Small building blocks for the dense News Intel cockpit (DESIGN.md). Every colour is a `--ni-*` variable
 * inherited from the page host, so these follow the theme. Fallbacks keep them legible if used elsewhere.
 */

// ── ⓘ tooltip ────────────────────────────────────────────────────────────────
@Component({
  selector: 'app-ni-info',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span
      class="i"
      tabindex="0"
      role="note"
      [attr.aria-label]="text()"
      (mouseenter)="place($event)"
      (focus)="place($event)"
    >
      <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
        <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.3" />
        <rect x="7.3" y="7" width="1.4" height="4.6" rx="0.7" fill="currentColor" />
        <circle cx="8" cy="4.9" r="0.85" fill="currentColor" />
      </svg>
      <span class="tip" [style.left.px]="left()" [class.measuring]="measuring()">{{ text() }}</span>
    </span>
  `,
  styles: [
    `
      :host {
        display: inline-flex;
        vertical-align: middle;
      }
      .i {
        position: relative;
        display: inline-flex;
        color: var(--text-tertiary);
        cursor: help;
        outline: none;
      }
      .i:hover,
      .i:focus-visible {
        color: var(--text-primary);
      }
      .tip {
        /* Hidden = display:none so a closed tooltip takes no room (an invisible 320px box beside an icon near
           the right edge used to make the whole page scroll sideways). place() keeps an open one on screen. */
        display: none;
        position: absolute;
        z-index: 40;
        left: -8px;
        top: calc(100% + 6px);
        width: max-content;
        max-width: min(320px, calc(100vw - 16px));
        padding: 8px 10px;
        border-radius: 8px;
        background: var(--text-primary);
        color: var(--bg-primary);
        font-size: 11.5px;
        line-height: 1.45;
        font-weight: 400;
        letter-spacing: 0;
        text-transform: none;
        white-space: normal;
        box-shadow: var(--shadow-lg);
        pointer-events: none;
      }
      .i:hover .tip,
      .i:focus-visible .tip {
        display: block;
        animation: ni-tip-in 0.12s ease;
      }
      .tip.measuring {
        visibility: hidden;
        animation: none;
      }
      @keyframes ni-tip-in {
        from {
          opacity: 0;
          transform: translateY(-2px);
        }
      }
    `,
  ],
})
export class NiInfoComponent {
  readonly text = input.required<string>();
  /** 'left' hangs the tooltip rightwards from the icon, 'right' leftwards; either way it is kept inside the window. */
  readonly align = input<'left' | 'right'>('left');
  /** Tooltip left offset in px, relative to the icon. */
  protected readonly left = signal(-8);
  protected readonly measuring = signal(false);

  protected place(ev: Event): void {
    const host = ev.currentTarget as HTMLElement;
    const icon = host.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    // Measure while hidden, parked at the window's left edge so even the measuring frame cannot widen the page.
    this.measuring.set(true);
    this.left.set(Math.round(8 - icon.left));
    requestAnimationFrame(() => {
      const tip = host.querySelector<HTMLElement>('.tip');
      const width = tip?.offsetWidth || Math.min(320, vw - 16);
      let start = this.align() === 'right' ? icon.right + 8 - width : icon.left - 8; // viewport x
      start = Math.max(8, Math.min(start, vw - 8 - width));
      this.left.set(Math.round(start - icon.left));
      this.measuring.set(false);
    });
  }
}

// ── Panel shell ──────────────────────────────────────────────────────────────
@Component({
  selector: 'app-ni-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NiInfoComponent],
  template: `
    <section class="panel" [class.flush]="flush()">
      @if (title()) {
        <header class="ph">
          <div class="pt">
            <h2>{{ title() }}</h2>
            @if (info()) {
              <app-ni-info [text]="info()!" />
            }
            <span class="meta"><ng-content select="[meta]" /></span>
          </div>
          <div class="pa"><ng-content select="[actions]" /></div>
        </header>
      }
      <div class="pb"><ng-content /></div>
    </section>
  `,
  styles: [
    `
      :host {
        display: block;
        min-width: 0;
      }
      .panel {
        background: var(--ni-panel, var(--bg-primary));
        border: 1px solid var(--border);
        border-radius: var(--radius-md, 12px);
        box-shadow: var(--shadow-sm);
        padding: 10px 12px 12px;
        display: flex;
        flex-direction: column;
        gap: 8px;
        min-width: 0;
        height: 100%;
        box-sizing: border-box;
      }
      .ph {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        min-height: 24px;
        flex-wrap: wrap;
      }
      .pt {
        display: flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
      }
      h2 {
        margin: 0;
        font-size: 12px;
        font-weight: 600;
        letter-spacing: 0.01em;
        white-space: nowrap;
      }
      .meta {
        font-size: 11px;
        color: var(--text-tertiary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .pa {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-wrap: wrap;
      }
      .pb {
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 8px;
        flex: 1;
      }
      .flush .pb {
        margin: 0 -12px -12px;
      }
    `,
  ],
})
export class NiPanelComponent {
  readonly title = input<string | null>(null);
  readonly info = input<string | null>(null);
  /** Body runs edge to edge (tables). */
  readonly flush = input(false);
}

// ── Sparkline ────────────────────────────────────────────────────────────────
@Component({
  selector: 'app-ni-spark',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg
      class="sp"
      [attr.viewBox]="'0 0 ' + W + ' ' + H"
      preserveAspectRatio="none"
      [style.height.px]="height()"
      (mousemove)="move($event)"
      (mouseleave)="hover.set(null)"
      role="img"
      [attr.aria-label]="ariaText()"
    >
      @if (zero() !== null) {
        <line x1="0" [attr.x2]="W" [attr.y1]="zero()" [attr.y2]="zero()" class="z" />
      }
      @if (kind() === 'bars') {
        @for (b of bars(); track $index) {
          <rect
            [attr.x]="b.x"
            [attr.y]="b.y"
            [attr.width]="b.w"
            [attr.height]="b.h"
            rx="1"
            [attr.fill]="b.fill"
            [attr.opacity]="hover() === null || hover() === $index ? 1 : 0.55"
          />
        }
      } @else {
        @if (area()) {
          <path [attr.d]="areaPath()" [attr.fill]="stroke()" opacity="0.12" />
        }
        <path [attr.d]="path()" fill="none" [attr.stroke]="stroke()" stroke-width="1.5" vector-effect="non-scaling-stroke" stroke-linejoin="round" />
        @if (hover() !== null) {
          <line [attr.x1]="hx()" [attr.x2]="hx()" y1="0" [attr.y2]="H" class="cross" />
        }
      }
    </svg>
    @if (hover() !== null && tipText()) {
      <span class="tip" [style.left.%]="(hx() / W) * 100">{{ tipText() }}</span>
    }
  `,
  styles: [
    `
      :host {
        display: block;
        position: relative;
        width: 100%;
        min-width: 0;
      }
      .sp {
        display: block;
        width: 100%;
        overflow: visible;
      }
      .z {
        stroke: var(--ni-grid, rgba(0, 0, 0, 0.1));
        stroke-width: 1;
        vector-effect: non-scaling-stroke;
      }
      .cross {
        stroke: var(--text-tertiary);
        stroke-width: 1;
        vector-effect: non-scaling-stroke;
        stroke-dasharray: 2 2;
      }
      .tip {
        position: absolute;
        bottom: calc(100% + 4px);
        transform: translateX(-50%);
        background: var(--text-primary);
        color: var(--bg-primary);
        font-size: 10.5px;
        padding: 2px 6px;
        border-radius: 5px;
        white-space: nowrap;
        pointer-events: none;
        z-index: 30;
        font-variant-numeric: tabular-nums;
      }
    `,
  ],
})
export class NiSparkComponent {
  readonly values = input<readonly (number | null)[]>([]);
  readonly labels = input<readonly string[] | null>(null);
  readonly kind = input<'line' | 'bars'>('line');
  readonly height = input(24);
  /** Fixed domain; default = data min/max (bars: 0..max, or symmetric when signed). */
  readonly domain = input<[number, number] | null>(null);
  readonly color = input<string | null>(null);
  readonly area = input(false);
  /** Bars below zero use --ni-down, above --ni-up (signed series). */
  readonly signed = input(false);
  readonly format = input<(v: number) => string>((v) => (Math.abs(v) >= 10 ? Math.round(v).toString() : v.toFixed(2)));

  readonly W = 100;
  readonly H = 30;
  readonly hover = signal<number | null>(null);

  private readonly dom = computed<[number, number]>(() => {
    const d = this.domain();
    if (d) return d;
    const xs = this.values().filter((v): v is number => v != null && Number.isFinite(v));
    if (!xs.length) return [0, 1];
    let lo = Math.min(...xs);
    let hi = Math.max(...xs);
    if (this.kind() === 'bars' && !this.signed()) lo = Math.min(0, lo);
    if (this.signed()) {
      const m = Math.max(Math.abs(lo), Math.abs(hi)) || 1;
      return [-m, m];
    }
    if (hi === lo) hi = lo + 1;
    return [lo, hi];
  });

  readonly stroke = computed(() => this.color() ?? 'var(--accent)');
  readonly path = computed(() => {
    const [lo, hi] = this.dom();
    // The svg overflows visibly, so a stroke on the top/bottom edge is not clipped.
    return linePath(this.values(), this.W, this.H, lo, hi);
  });
  readonly areaPath = computed(() => {
    const p = this.path();
    if (!p) return '';
    const n = this.values().length;
    const lastX = n <= 1 ? this.W / 2 : this.W;
    const firstX = n <= 1 ? this.W / 2 : 0;
    return `${p}L${lastX},${this.H}L${firstX},${this.H}Z`;
  });
  readonly zero = computed(() => {
    const [lo, hi] = this.dom();
    if (lo >= 0 || hi <= 0) return null;
    return this.H - ((0 - lo) / (hi - lo)) * this.H;
  });
  readonly bars = computed(() => {
    const vs = this.values();
    const n = vs.length || 1;
    const [lo, hi] = this.dom();
    const span = hi - lo || 1;
    const slot = this.W / n;
    const w = Math.max(0.6, slot - Math.min(1.2, slot * 0.25));
    const zeroY = this.H - ((Math.max(lo, Math.min(hi, 0)) - lo) / span) * this.H;
    return vs.map((v, i) => {
      const val = v ?? 0;
      const y = this.H - ((Math.max(lo, Math.min(hi, val)) - lo) / span) * this.H;
      const top = Math.min(y, zeroY);
      const h = Math.max(val === 0 ? 0 : 0.8, Math.abs(zeroY - y));
      const fill = this.signed()
        ? val >= 0
          ? 'var(--ni-up)'
          : 'var(--ni-down)'
        : this.stroke();
      return { x: i * slot + (slot - w) / 2, y: top, w, h, fill };
    });
  });
  readonly hx = computed(() => {
    const i = this.hover();
    const n = this.values().length;
    if (i === null || n === 0) return 0;
    if (this.kind() === 'bars') return (i + 0.5) * (this.W / n);
    return n === 1 ? this.W / 2 : (i / (n - 1)) * this.W;
  });
  readonly tipText = computed(() => {
    const i = this.hover();
    if (i === null) return '';
    const v = this.values()[i];
    const l = this.labels()?.[i];
    const vt = v == null ? '—' : this.format()(v);
    return l ? `${l} · ${vt}` : vt;
  });
  readonly ariaText = computed(() => {
    const xs = this.values().filter((v): v is number => v != null);
    if (!xs.length) return 'no data';
    return `${xs.length} points, last ${this.format()(xs[xs.length - 1])}`;
  });

  move(e: MouseEvent): void {
    const el = e.currentTarget as SVGElement;
    const r = el.getBoundingClientRect();
    const n = this.values().length;
    if (!n || r.width === 0) return;
    const f = (e.clientX - r.left) / r.width;
    const i = this.kind() === 'bars' ? Math.floor(f * n) : Math.round(f * (n - 1));
    this.hover.set(Math.max(0, Math.min(n - 1, i)));
  }
}

// ── KPI tile ─────────────────────────────────────────────────────────────────
@Component({
  selector: 'app-ni-stat',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NiInfoComponent, NiSparkComponent],
  template: `
    <div class="st" [class]="'st ' + (tone() ?? '')">
      <div class="lab">
        <span [title]="label()">{{ label() }}</span>
        @if (info()) {
          <app-ni-info [text]="info()!" />
        }
      </div>
      <div class="row">
        <span class="v" [title]="value() ?? ''">{{ value() }}</span>
        @if (unit()) {
          <span class="u">{{ unit() }}</span>
        }
      </div>
      @if (spark()?.length) {
        <app-ni-spark
          class="sk"
          [values]="spark()!"
          [labels]="sparkLabels()"
          [kind]="sparkKind()"
          [height]="20"
          [signed]="sparkSigned()"
          [area]="sparkKind() === 'line'"
          [color]="sparkColor()"
        />
      }
      @if (sub()) {
        <div class="sub" [title]="sub()">{{ sub() }}</div>
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
        min-width: 0;
      }
      .st {
        height: 100%;
        box-sizing: border-box;
        background: var(--ni-panel, var(--bg-primary));
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 8px 10px;
        display: flex;
        flex-direction: column;
        gap: 2px;
        box-shadow: var(--shadow-sm);
        position: relative;
        overflow: visible;
      }
      .st::before {
        content: '';
        position: absolute;
        left: -1px;
        top: 8px;
        bottom: 8px;
        width: 2px;
        border-radius: 2px;
        background: transparent;
      }
      .st.ok::before {
        background: var(--ni-ok);
      }
      .st.warn::before {
        background: var(--ni-warn);
      }
      .st.bad::before {
        background: var(--ni-bad);
      }
      .lab {
        display: flex;
        align-items: center;
        gap: 4px;
        font-size: 10.5px;
        font-weight: 500;
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        white-space: nowrap;
      }
      .lab span {
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .row {
        display: flex;
        align-items: baseline;
        gap: 4px;
      }
      .v {
        font-size: 19px;
        font-weight: 600;
        letter-spacing: -0.01em;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }
      .u {
        font-size: 11px;
        color: var(--text-secondary);
      }
      .ok .v {
        color: var(--text-primary);
      }
      .warn .v {
        color: var(--ni-warn);
      }
      .bad .v {
        color: var(--ni-bad);
      }
      .sk {
        margin-top: 2px;
      }
      .sub {
        font-size: 11px;
        color: var(--text-secondary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
    `,
  ],
})
export class NiStatComponent {
  readonly label = input.required<string>();
  readonly value = input<string | number | null>('—');
  readonly unit = input<string | null>(null);
  readonly sub = input<string | null>(null);
  readonly info = input<string | null>(null);
  readonly tone = input<'ok' | 'warn' | 'bad' | null>(null);
  readonly spark = input<readonly (number | null)[] | null>(null);
  readonly sparkLabels = input<readonly string[] | null>(null);
  readonly sparkKind = input<'line' | 'bars'>('bars');
  readonly sparkSigned = input(false);
  readonly sparkColor = input<string | null>(null);
}

// ── Exposure key chip ───────────────────────────────────────────────────────
@Component({
  selector: 'app-ni-key',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<span
    class="k"
    [class.untracked]="untracked()"
    [class.sel]="selected()"
    [style.--kc]="color()"
    [title]="title()"
    ><i></i>{{ short() ? shortText() : key() }}@if (value() !== null) {
      <b [class.pos]="value()! > 0" [class.neg]="value()! < 0">{{ valueText() }}</b>
    }</span
  >`,
  styles: [
    `
      :host {
        display: inline-flex;
        min-width: 0;
      }
      .k {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        height: 20px;
        padding: 0 7px 0 6px;
        border-radius: 6px;
        border: 1px solid var(--border);
        background: var(--ni-panel, var(--bg-primary));
        font-family: var(--ni-mono, ui-monospace, Menlo, monospace);
        font-size: 11px;
        white-space: nowrap;
        color: var(--text-primary);
      }
      .k.sel {
        border-color: var(--kc);
        box-shadow: inset 0 0 0 1px var(--kc);
      }
      i {
        width: 7px;
        height: 7px;
        border-radius: 2px;
        background: var(--kc);
        flex: none;
      }
      .untracked {
        border-style: dashed;
        color: var(--text-secondary);
        background: transparent;
      }
      .untracked i {
        background: transparent;
        box-shadow: inset 0 0 0 1.5px var(--kc);
      }
      b {
        font-weight: 600;
        font-variant-numeric: tabular-nums;
      }
      .pos {
        color: var(--ni-up);
      }
      .neg {
        color: var(--ni-down);
      }
    `,
  ],
})
export class NiKeyComponent {
  readonly key = input.required<string>();
  readonly value = input<number | null>(null);
  readonly digits = input(2);
  readonly untracked = input(false);
  readonly selected = input(false);
  /** Drop the IDX:/EQ:/CR:/F: prefix (the kind colour carries it). */
  readonly short = input(false);
  readonly color = computed(() => kindVar(this.key()));
  readonly shortText = computed(() => shortKey(this.key()));
  readonly valueText = computed(() => signedText(this.value(), this.digits()));
  readonly title = computed(() => (this.untracked() ? `${this.key()} — not tracked` : this.key()));
}

// ── Inline diverging bar (table cells) ──────────────────────────────────────
@Component({
  selector: 'app-ni-dbar',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span class="db" [title]="text()">
      <span class="track"><i class="mid"></i><i class="fill" [style.left.%]="left()" [style.width.%]="width()" [class.up]="(value() ?? 0) >= 0"></i></span>
      @if (showValue()) {
        <span class="v" [class.pos]="(value() ?? 0) > 0" [class.neg]="(value() ?? 0) < 0">{{ text() }}</span>
      }
    </span>
  `,
  styles: [
    `
      :host {
        display: inline-flex;
        width: 100%;
        min-width: 70px;
      }
      .db {
        display: flex;
        align-items: center;
        gap: 6px;
        width: 100%;
      }
      .track {
        position: relative;
        flex: 1;
        height: 6px;
        border-radius: 3px;
        background: var(--ni-sunken, var(--bg-secondary));
        min-width: 36px;
      }
      .mid {
        position: absolute;
        left: 50%;
        top: -2px;
        bottom: -2px;
        width: 1px;
        background: var(--text-tertiary);
        opacity: 0.6;
      }
      .fill {
        position: absolute;
        top: 0;
        bottom: 0;
        border-radius: 3px;
        background: var(--ni-down);
      }
      .fill.up {
        background: var(--ni-up);
      }
      .v {
        font-size: 11.5px;
        font-variant-numeric: tabular-nums;
        min-width: 42px;
        text-align: right;
      }
      .pos {
        color: var(--ni-up);
      }
      .neg {
        color: var(--ni-down);
      }
    `,
  ],
})
export class NiDbarComponent {
  readonly value = input<number | null>(null);
  readonly max = input(1);
  readonly digits = input(2);
  readonly showValue = input(true);
  private readonly frac = computed(() => {
    const v = this.value();
    if (v == null || !Number.isFinite(v)) return 0;
    return Math.max(-1, Math.min(1, v / (this.max() || 1)));
  });
  readonly left = computed(() => (this.frac() >= 0 ? 50 : 50 + this.frac() * 50));
  readonly width = computed(() => Math.abs(this.frac()) * 50);
  readonly text = computed(() => signedText(this.value(), this.digits()));
}

// ── Inline magnitude meter (0..1) ───────────────────────────────────────────
@Component({
  selector: 'app-ni-meter',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span class="m">
      <span class="track"><i [style.width.%]="pct()" [class]="tone() ?? ''"></i></span>
      @if (label() !== null) {
        <span class="v">{{ label() }}</span>
      }
    </span>
  `,
  styles: [
    `
      :host {
        display: inline-flex;
        width: 100%;
        min-width: 60px;
      }
      .m {
        display: flex;
        align-items: center;
        gap: 6px;
        width: 100%;
      }
      .track {
        flex: 1;
        height: 6px;
        border-radius: 3px;
        background: var(--ni-sunken, var(--bg-secondary));
        overflow: hidden;
        min-width: 30px;
      }
      i {
        display: block;
        height: 100%;
        border-radius: 3px;
        background: var(--accent);
      }
      i.ok {
        background: var(--ni-ok);
      }
      i.warn {
        background: var(--ni-warn);
      }
      i.bad {
        background: var(--ni-bad);
      }
      i.muted {
        background: var(--text-tertiary);
      }
      .v {
        font-size: 11.5px;
        font-variant-numeric: tabular-nums;
        min-width: 34px;
        text-align: right;
        color: var(--text-secondary);
      }
    `,
  ],
})
export class NiMeterComponent {
  /** 0..1 */
  readonly value = input<number | null>(null);
  readonly label = input<string | null>(null);
  readonly tone = input<'ok' | 'warn' | 'bad' | 'muted' | null>(null);
  readonly pct = computed(() => {
    const v = this.value();
    return v == null || !Number.isFinite(v) ? 0 : Math.max(0, Math.min(1, v)) * 100;
  });
}
