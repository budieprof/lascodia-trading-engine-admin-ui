import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { DailyBarsService } from './daily-bars.service';
import { seasonalColor, seasonalYears, type DailyBar, type SeasonalYear } from './performance';

const W = 236;
const H = 120;
const PAD = { l: 4, r: 4, t: 6, b: 14 };
/** TradingView's panel labels three months only. */
const MONTH_TICKS = [
  { label: 'Jan', day: 0 },
  { label: 'May', day: 120 },
  { label: 'Sep', day: 243 },
];

/**
 * Seasonals mini-chart: cumulative % change through each calendar year for the
 * current year and the two before it, overlaid on a shared day-of-year axis.
 * Plain SVG — three short polylines do not justify a Lightweight Charts instance.
 */
@Component({
  selector: 'app-seasonals',
  standalone: true,
  imports: [],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="tree-title">Seasonals</div>
    @if (loading()) {
      <div class="pane-empty">Loading…</div>
    } @else if (years().length === 0) {
      <div class="pane-empty">No daily history.</div>
    } @else {
      <svg
        [attr.viewBox]="'0 0 ' + W + ' ' + H"
        class="chart"
        role="img"
        aria-label="Year-over-year cumulative change"
      >
        <line
          class="zero"
          [attr.x1]="PAD.l"
          [attr.x2]="W - PAD.r"
          [attr.y1]="y(0)"
          [attr.y2]="y(0)"
        />
        @for (m of months; track m.label) {
          <text class="axis" [attr.x]="x(m.day)" [attr.y]="H - 2">{{ m.label }}</text>
        }
        @for (yr of drawOrder(); track yr.year) {
          <polyline
            [attr.points]="path(yr)"
            [attr.stroke]="color(yr)"
            [attr.stroke-width]="yr.year === latest() ? 1.8 : 1.2"
            fill="none"
          />
        }
        @if (endPoint(); as e) {
          <circle [attr.cx]="e.x" [attr.cy]="e.y" r="2.4" [attr.fill]="e.color" />
        }
      </svg>
      <div class="legend">
        @for (yr of years(); track yr.year) {
          <span class="key"><i [style.background]="color(yr)"></i>{{ yr.year }}</span>
        }
      </div>
      <button type="button" class="more" (click)="more.emit()">More seasonals</button>
    }
  `,
  styles: [
    `
      :host {
        display: block;
        font-size: 12px;
      }
      .tree-title {
        padding: 2px 10px 6px;
        font-weight: 600;
        color: var(--text-muted, #787b86);
      }
      .pane-empty {
        padding: 10px 12px;
        color: var(--text-muted, #787b86);
      }
      .chart {
        display: block;
        width: calc(100% - 24px);
        margin: 0 12px;
        height: auto;
      }
      .zero {
        stroke: var(--border, #e6e9ef);
        stroke-dasharray: 2 2;
      }
      .axis {
        font-size: 8px;
        fill: var(--text-muted, #787b86);
      }
      .legend {
        display: flex;
        justify-content: center;
        gap: 10px;
        padding: 4px 12px 0;
        font-size: 11px;
        color: var(--text-muted, #787b86);
      }
      .key i {
        display: inline-block;
        width: 6px;
        height: 6px;
        margin-right: 3px;
        border-radius: 50%;
        vertical-align: 1px;
      }
      .more {
        display: block;
        height: 22px;
        margin: 10px auto 0;
        padding: 0 14px;
        border: 0;
        border-radius: 11px;
        background: var(--tg-pill, #f2f2f2);
        color: inherit;
        font: inherit;
        font-size: 12px;
        cursor: pointer;
      }
      :host-context([data-theme='dark']) .more {
        background: #2e2e2e;
      }
    `,
  ],
})
export class SeasonalsComponent {
  private readonly daily = inject(DailyBarsService);

  readonly symbol = input<string | null>(null);
  /** Optional pre-loaded ascending daily bars; when set, no fetch happens. */
  readonly bars = input<readonly DailyBar[] | null>(null);
  /** Prior years overlaid beside the current one. */
  readonly priorYears = input(2);

  protected readonly W = W;
  protected readonly H = H;
  protected readonly PAD = PAD;
  protected readonly months = MONTH_TICKS;
  /** "More seasonals": open the full Seasonals view. */
  readonly more = output<void>();

  private readonly fetched = signal<readonly DailyBar[]>([]);
  readonly loading = signal(false);

  readonly years = computed(() => seasonalYears(this.bars() ?? this.fetched(), this.priorYears()));

  private readonly range = computed(() => {
    let lo = 0;
    let hi = 0;
    for (const y of this.years())
      for (const p of y.points) {
        if (p.pct < lo) lo = p.pct;
        if (p.pct > hi) hi = p.pct;
      }
    const pad = (hi - lo || 1) * 0.08;
    return { lo: lo - pad, hi: hi + pad };
  });

  constructor() {
    effect((onCleanup) => {
      const sym = this.symbol();
      if (this.bars() || !sym) return;
      let live = true;
      onCleanup(() => (live = false));
      this.loading.set(true);
      void this.daily.daily(sym).then((b) => {
        if (!live) return;
        this.fetched.set(b);
        this.loading.set(false);
      });
    });
  }

  protected x(day: number): number {
    return PAD.l + (day / 365) * (W - PAD.l - PAD.r);
  }

  protected y(pct: number): number {
    const { lo, hi } = this.range();
    return PAD.t + ((hi - pct) / (hi - lo)) * (H - PAD.t - PAD.b);
  }

  protected path(yr: SeasonalYear): string {
    return yr.points
      .map((p) => `${this.x(p.day).toFixed(1)},${this.y(p.pct).toFixed(1)}`)
      .join(' ');
  }

  readonly latest = computed(() => this.years()[0]?.year ?? 0);
  /** Oldest first, so the current year is drawn on top. */
  readonly drawOrder = computed(() => [...this.years()].reverse());
  readonly endPoint = computed(() => {
    const cur = this.years()[0];
    const last = cur?.points[cur.points.length - 1];
    return last ? { x: this.x(last.day), y: this.y(last.pct), color: this.color(cur) } : null;
  });

  protected color(yr: SeasonalYear): string {
    return seasonalColor(this.latest(), yr.year);
  }
}
