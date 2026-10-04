import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { DailyBarsService } from './daily-bars.service';
import {
  pctOnDay,
  seasonalAverage,
  seasonalColor,
  seasonalYears,
  type DailyBar,
  type SeasonalPoint,
  type SeasonalYear,
} from './performance';

const H = 400;
const PAD = { l: 8, r: 150, t: 12, b: 26 };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_DAYS = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
/** The engine's H1 history starts in 2010, so 15 prior years is "all". */
const RANGES = [
  { years: 3, label: '3 years' },
  { years: 5, label: '5 years' },
  { years: 10, label: '10 years' },
  { years: 15, label: 'All (2011+)' },
];
const LABEL_GAP = 15;

const CURRENCY_NAMES: Readonly<Record<string, string>> = {
  AUD: 'Australian Dollar',
  CAD: 'Canadian Dollar',
  CHF: 'Swiss Franc',
  EUR: 'Euro',
  GBP: 'British Pound',
  JPY: 'Japanese Yen',
  NZD: 'New Zealand Dollar',
  USD: 'U.S. Dollar',
  XAU: 'Gold',
  XAG: 'Silver',
  NGN: 'Nigerian Naira',
};

/**
 * TradingView's Seasonals page, opened by "More seasonals": every year's
 * cumulative % path on one January–December axis, coloured by age as the side
 * panel colours them, with labels at each line's end, an optional average of
 * the prior years, and a crosshair reading every year on the hovered date.
 */
@Component({
  selector: 'app-seasonals-view',
  standalone: true,
  imports: [DecimalPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { role: 'region', 'aria-label': 'Seasonals' },
  template: `
    <div class="sv-inner">
      <header class="sv-head">
        <h2 class="sv-title">
          <span class="sv-name">{{ pairName() }}</span
          ><span class="sv-sub">· Seasonals</span>
        </h2>
        <button type="button" class="sv-btn" (click)="closed.emit()">Back to chart</button>
      </header>

      <div class="sv-controls">
        <div class="sv-seg" role="group" aria-label="Years">
          @for (r of ranges; track r.years) {
            <button type="button" [class.on]="years() === r.years" (click)="years.set(r.years)">
              {{ r.label }}
            </button>
          }
        </div>
        <span class="sv-spacer"></span>
        <button
          type="button"
          class="sv-btn"
          [class.on]="showAverage()"
          (click)="showAverage.set(!showAverage())"
        >
          Average
        </button>
      </div>

      <div class="sv-chart" #box (pointerleave)="hoverDay.set(null)" (pointermove)="onMove($event)">
        @if (loading() && !lines().length) {
          <div class="sv-empty">Loading {{ years() }} years of history…</div>
        } @else if (!lines().length) {
          <div class="sv-empty">No daily history for {{ symbol() }}.</div>
        } @else {
          <svg
            [attr.width]="w()"
            [attr.height]="H"
            role="img"
            aria-label="Cumulative change by year"
          >
            @for (t of ticks(); track t) {
              <line
                class="grid"
                [attr.x1]="PAD.l"
                [attr.x2]="w() - PAD.r"
                [attr.y1]="y(t)"
                [attr.y2]="y(t)"
                [class.zero]="t === 0"
              />
              <text class="tick" [attr.x]="w() - 4" [attr.y]="y(t) + 4">
                {{ t | number: '1.2-2' }}%
              </text>
            }
            @for (m of months; track m.label; let i = $index) {
              @if (i % 3 === 2) {
                <line
                  class="quarter"
                  [attr.x1]="x(m.day)"
                  [attr.x2]="x(m.day)"
                  [attr.y1]="PAD.t"
                  [attr.y2]="H - PAD.b"
                />
              }
              <text class="month" [attr.x]="x(m.day)" [attr.y]="H - 6">{{ m.label }}</text>
            }
            @for (l of drawOrder(); track l.key) {
              <polyline
                [attr.points]="path(l.points)"
                [attr.stroke]="l.color"
                [attr.stroke-width]="l.current ? 2.2 : 1.3"
                [attr.stroke-dasharray]="l.key === 'avg' ? '5 4' : null"
                fill="none"
              />
            }
            @if (endDot(); as e) {
              <circle [attr.cx]="e.x" [attr.cy]="e.y" r="3.5" [attr.fill]="e.color" />
            }
            @for (lb of endLabels(); track lb.key) {
              <g [attr.transform]="'translate(' + (w() - PAD.r + 6) + ' ' + (lb.y - 7) + ')'">
                <rect width="96" height="14" rx="2" [attr.fill]="lb.color" />
                <text class="end" x="4" y="10.5">{{ lb.label }}</text>
                <text class="end" x="92" y="10.5" text-anchor="end">
                  {{ lb.pct | number: '1.2-2' }}%
                </text>
              </g>
            }
            @if (hover(); as h) {
              <line
                class="cross"
                [attr.x1]="h.x"
                [attr.x2]="h.x"
                [attr.y1]="PAD.t"
                [attr.y2]="H - PAD.b"
              />
              @for (r of h.rows; track r.key) {
                @if (r.pct !== null) {
                  <circle [attr.cx]="h.x" [attr.cy]="y(r.pct)" r="3" [attr.fill]="r.color" />
                }
              }
            }
          </svg>
          @if (hover(); as h) {
            <div class="sv-tip" [style.left.px]="h.tipX" [style.top.px]="PAD.t + 8">
              @for (r of h.rows; track r.key) {
                <div class="row">
                  <i [style.background]="r.color"></i><span>{{ r.label }}</span>
                  <b>{{ r.pct === null ? '—' : (r.pct | number: '1.2-2') + '%' }}</b>
                </div>
              }
              <div class="date">{{ h.date }}</div>
            </div>
          }
        }
      </div>
      <p class="sv-foot">
        Cumulative % change from each year's previous close, from the engine's candles (days before
        its first daily bar are built from hourly bars).
        @if (showAverage()) {
          The dashed line averages the prior years shown.
        }
      </p>
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
        overflow-y: auto;
        background: var(--tv-bg, #fff);
        color: var(--tv-ink, #131722);
        font-size: 13px;
      }
      .sv-inner {
        max-width: 1400px;
        margin: 0 auto;
        padding: 14px 28px 32px;
      }
      .sv-head,
      .sv-controls {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .sv-title {
        margin: 0;
        font-size: 15px;
        font-weight: 400;
        display: flex;
        gap: 6px;
      }
      .sv-name {
        font-weight: 600;
      }
      .sv-sub {
        color: var(--tv-muted, #787b86);
      }
      .sv-head .sv-btn {
        margin-left: auto;
      }
      .sv-controls {
        margin: 14px 0 6px;
      }
      .sv-spacer {
        flex: 1;
      }
      .sv-btn,
      .sv-seg button {
        padding: 5px 10px;
        border: 1px solid var(--tv-line, #e0e3eb);
        border-radius: 6px;
        background: transparent;
        color: inherit;
        font: inherit;
        cursor: pointer;
      }
      .sv-head .sv-btn {
        border-color: transparent;
      }
      .sv-btn:hover,
      .sv-seg button:hover {
        background: var(--tv-hover, #f0f3fa);
      }
      .sv-btn.on,
      .sv-seg button.on {
        border-color: var(--tv-ink, #131722);
        font-weight: 600;
      }
      .sv-seg {
        display: flex;
        gap: 4px;
      }
      .sv-chart {
        position: relative;
        min-height: 400px;
      }
      .sv-empty {
        padding: 120px 0;
        text-align: center;
        color: var(--tv-muted, #787b86);
      }
      svg {
        display: block;
      }
      .grid {
        stroke: var(--tv-line, #e0e3eb);
        stroke-width: 1;
        opacity: 0.6;
      }
      .grid.zero {
        opacity: 1;
        stroke: var(--tv-muted, #787b86);
        stroke-width: 0.6;
      }
      .quarter {
        stroke: var(--tv-line, #e0e3eb);
        stroke-dasharray: 3 3;
      }
      .tick,
      .month {
        font-size: 11px;
        fill: var(--tv-ink, #131722);
      }
      .tick {
        text-anchor: end;
      }
      .month {
        text-anchor: start;
      }
      .end {
        font-size: 10px;
        fill: #fff;
        font-variant-numeric: tabular-nums;
      }
      .cross {
        stroke: var(--tv-muted, #787b86);
        stroke-dasharray: 2 2;
      }
      .sv-tip {
        position: absolute;
        pointer-events: none;
        min-width: 120px;
        padding: 6px 8px;
        border-radius: 4px;
        background: #2a2e39;
        color: #fff;
        font-size: 11px;
        font-variant-numeric: tabular-nums;
      }
      .sv-tip .row {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .sv-tip i {
        width: 6px;
        height: 6px;
        border-radius: 50%;
      }
      .sv-tip b {
        margin-left: auto;
        font-weight: 400;
      }
      .sv-tip .date {
        margin-top: 4px;
        text-align: center;
        color: #b2b5be;
      }
      .sv-foot {
        margin: 12px 0 0;
        font-size: 12px;
        color: var(--tv-muted, #787b86);
      }
    `,
  ],
})
export class SeasonalsViewComponent {
  readonly symbol = input.required<string>();
  readonly base = input<string | null>(null);
  readonly quote = input<string | null>(null);
  readonly closed = output<void>();

  private readonly daily = inject(DailyBarsService);
  private readonly box = viewChild<ElementRef<HTMLElement>>('box');

  protected readonly H = H;
  protected readonly PAD = PAD;
  protected readonly ranges = RANGES;
  protected readonly months = MONTHS.map((label, i) => ({ label, day: MONTH_DAYS[i] }));

  readonly years = signal(5);
  readonly showAverage = signal(false);
  readonly loading = signal(false);
  readonly w = signal(900);
  readonly hoverDay = signal<number | null>(null);
  private readonly bars = signal<readonly DailyBar[]>([]);

  readonly pairName = computed(() => {
    const b = this.base();
    const q = this.quote();
    return b && q ? `${CURRENCY_NAMES[b] ?? b} / ${CURRENCY_NAMES[q] ?? q}` : this.symbol();
  });

  private readonly seasonal = computed(() => seasonalYears(this.bars(), this.years()));

  /** Every line to draw, newest first; the average (when on) is computed from the prior years only. */
  readonly lines = computed(() => {
    const ys = this.seasonal();
    const latest = ys[0]?.year ?? 0;
    const out: {
      key: string;
      label: string;
      points: SeasonalPoint[];
      color: string;
      current: boolean;
    }[] = ys.map((y: SeasonalYear) => ({
      key: String(y.year),
      label: String(y.year),
      points: y.points,
      color: seasonalColor(latest, y.year),
      current: y.year === latest,
    }));
    if (this.showAverage() && ys.length > 1) {
      out.push({
        key: 'avg',
        label: 'Average',
        points: seasonalAverage(ys.slice(1)),
        color: 'var(--tv-ink, #131722)',
        current: false,
      });
    }
    return out;
  });

  /** Oldest first, so the current year is drawn on top. */
  readonly drawOrder = computed(() => [...this.lines()].reverse());

  private readonly range = computed(() => {
    let lo = 0;
    let hi = 0;
    for (const l of this.lines())
      for (const p of l.points) {
        lo = Math.min(lo, p.pct);
        hi = Math.max(hi, p.pct);
      }
    const pad = (hi - lo || 1) * 0.06;
    return { lo: lo - pad, hi: hi + pad };
  });

  /** Round % gridlines, about eight of them. */
  readonly ticks = computed(() => {
    const { lo, hi } = this.range();
    const raw = (hi - lo) / 8;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
    const out: number[] = [];
    for (let t = Math.ceil(lo / step) * step; t <= hi; t += step)
      out.push(Math.round(t * 1e6) / 1e6);
    return out;
  });

  readonly endDot = computed(() => {
    const cur = this.lines().find((l) => l.current);
    const last = cur?.points[cur.points.length - 1];
    return cur && last ? { x: this.x(last.day), y: this.y(last.pct), color: cur.color } : null;
  });

  /** Year labels at the right edge, at each line's last value, pushed apart so none overlap. */
  readonly endLabels = computed(() => {
    const labels = this.lines()
      .filter((l) => l.points.length)
      .map((l) => {
        const pct = l.points[l.points.length - 1].pct;
        return { key: l.key, label: l.label, pct, color: l.color, y: this.y(pct) };
      })
      .sort((a, b) => a.y - b.y);
    for (let i = 1; i < labels.length; i++) {
      labels[i].y = Math.max(labels[i].y, labels[i - 1].y + LABEL_GAP);
    }
    const overflow = labels.length ? labels[labels.length - 1].y - (H - PAD.b - 7) : 0;
    if (overflow > 0) for (const l of labels) l.y -= overflow;
    return labels;
  });

  readonly hover = computed(() => {
    const day = this.hoverDay();
    if (day === null) return null;
    const x = this.x(day);
    const date = new Date(Date.UTC(2025, 0, 1) + day * 86_400_000).toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      timeZone: 'UTC',
    });
    const rows = this.lines().map((l) => ({
      key: l.key,
      label: l.label,
      color: l.color,
      pct: pctOnDay({ year: 0, points: l.points }, day),
    }));
    const tipX = x + 140 > this.w() - PAD.r ? x - 140 : x + 12;
    return { x, rows, date, tipX };
  });

  constructor() {
    effect((onCleanup) => {
      const sym = this.symbol();
      const years = this.years();
      let live = true;
      onCleanup(() => (live = false));
      untracked(() => this.loading.set(true));
      void this.daily.daily(sym, years).then((b) => {
        if (!live) return;
        this.bars.set(b);
        this.loading.set(false);
      });
    });
    afterNextRender(() => {
      const el = this.box()?.nativeElement;
      if (!el) return;
      const ro = new ResizeObserver(() => this.w.set(Math.max(480, el.clientWidth)));
      ro.observe(el);
      this.destroyRef.onDestroy(() => ro.disconnect());
    });
  }

  private readonly destroyRef = inject(DestroyRef);

  protected onMove(ev: PointerEvent): void {
    const el = this.box()?.nativeElement;
    if (!el) return;
    const px = ev.clientX - el.getBoundingClientRect().left;
    const span = this.w() - PAD.l - PAD.r;
    const day = Math.round(((px - PAD.l) / span) * 365);
    this.hoverDay.set(day >= 0 && day <= 365 ? day : null);
  }

  protected x(day: number): number {
    return PAD.l + (day / 365) * (this.w() - PAD.l - PAD.r);
  }

  protected y(pct: number): number {
    const { lo, hi } = this.range();
    return PAD.t + ((hi - pct) / (hi - lo)) * (H - PAD.t - PAD.b);
  }

  protected path(points: readonly SeasonalPoint[]): string {
    return points.map((p) => `${this.x(p.day).toFixed(1)},${this.y(p.pct).toFixed(1)}`).join(' ');
  }
}
