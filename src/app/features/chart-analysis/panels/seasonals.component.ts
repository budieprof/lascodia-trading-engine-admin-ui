import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { DailyBarsService } from './daily-bars.service';
import { seasonalYears, type DailyBar, type SeasonalYear } from './performance';

const W = 236;
const H = 120;
const PAD = { l: 4, r: 4, t: 6, b: 14 };
/** Newest first: current year in the accent, prior years progressively muted. */
const YEAR_COLORS = ['var(--accent, #2962ff)', '#f7a600', 'var(--text-muted, #787b86)'];
const MONTHS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
const MONTH_START_DAYS = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];

/**
 * Seasonals mini-chart: cumulative % change through each calendar year for the
 * current year and the two before it, overlaid on a shared day-of-year axis.
 * Plain SVG — three short polylines do not justify a Lightweight Charts instance.
 */
@Component({
  selector: 'app-seasonals',
  standalone: true,
  imports: [DecimalPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="tree-title">Seasonals</div>
    @if (loading()) {
      <div class="pane-empty">Loading…</div>
    } @else if (years().length === 0) {
      <div class="pane-empty">No daily history.</div>
    } @else {
      <svg [attr.viewBox]="'0 0 ' + W + ' ' + H" class="chart" role="img" aria-label="Year-over-year cumulative change">
        <line class="zero" [attr.x1]="PAD.l" [attr.x2]="W - PAD.r" [attr.y1]="y(0)" [attr.y2]="y(0)" />
        @for (m of months; track $index) {
          <text class="axis" [attr.x]="x(m.day) + 1" [attr.y]="H - 3">{{ m.label }}</text>
        }
        @for (yr of years(); track yr.year; let i = $index) {
          <polyline
            [attr.points]="path(yr)"
            [attr.stroke]="color(i)"
            [attr.stroke-width]="i === 0 ? 1.8 : 1.2"
            fill="none"
          />
        }
      </svg>
      <div class="legend">
        @for (yr of years(); track yr.year; let i = $index) {
          <span class="key">
            <i [style.background]="color(i)"></i>{{ yr.year }}
            <b [class.up]="lastPct(yr) > 0" [class.down]="lastPct(yr) < 0">{{ lastPct(yr) | number: '1.2-2' }}%</b>
          </span>
        }
      </div>
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
        flex-wrap: wrap;
        gap: 4px 10px;
        padding: 4px 12px 0;
        font-variant-numeric: tabular-nums;
      }
      .key i {
        display: inline-block;
        width: 8px;
        height: 2px;
        margin-right: 4px;
        vertical-align: middle;
      }
      .key b {
        margin-left: 3px;
        font-weight: 600;
      }
      .up {
        color: #26a69a;
      }
      .down {
        color: #ef5350;
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
  protected readonly months = MONTHS.map((label, i) => ({ label, day: MONTH_START_DAYS[i] }));

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
    return yr.points.map((p) => `${this.x(p.day).toFixed(1)},${this.y(p.pct).toFixed(1)}`).join(' ');
  }

  protected color(i: number): string {
    return YEAR_COLORS[Math.min(i, YEAR_COLORS.length - 1)];
  }

  protected lastPct(yr: SeasonalYear): number {
    return yr.points.length ? yr.points[yr.points.length - 1].pct : 0;
  }
}
