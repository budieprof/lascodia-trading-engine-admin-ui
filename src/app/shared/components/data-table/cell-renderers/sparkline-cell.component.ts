import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core';
import type { ICellRendererAngularComp } from 'ag-grid-angular';
import type { ICellRendererParams } from 'ag-grid-community';

/**
 * Cell-renderer params consumed alongside the standard `value`. The cell
 * value is expected to be `number[] | null | undefined` — the most recent
 * value on the right edge. Out-of-band stats (min/max/last) are derived
 * inline so callers don't have to pre-compute them.
 */
export interface SparklineCellRendererParams {
  /** Range used to scale the polyline. Defaults to data's own min/max. */
  domain?: [number, number];
  /** Stroke colour. Defaults to a neutral grey; use accent for active rows. */
  color?: string;
  /** Whether to render a tiny dot on the most recent point. Default true. */
  showLatestDot?: boolean;
  /** Accessible label prefix, e.g. "Health score". */
  label?: string;
}

const DEFAULT_COLOR = '#0071E3';
const DOT_COLOR = '#0040DD';

/**
 * Inline-SVG sparkline cell — no external charting dep, no per-row canvas
 * teardown. Renders nothing when the series is empty so the row stays clean
 * during the initial fetch (better than a flickering placeholder).
 *
 * Use from ColDef:
 *   {
 *     field: 'healthSeries',
 *     cellRenderer: SparklineCellComponent,
 *     cellRendererParams: { color: '#34C759', label: 'Health score' }
 *       satisfies SparklineCellRendererParams,
 *     ...
 *   }
 */
@Component({
  selector: 'app-sparkline-cell',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (points().length >= 2) {
      <svg
        class="spark"
        viewBox="0 0 100 32"
        preserveAspectRatio="none"
        [attr.aria-label]="ariaLabel()"
        role="img"
      >
        <polyline
          [attr.points]="polyline()"
          [attr.stroke]="color()"
          fill="none"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
          vector-effect="non-scaling-stroke"
        />
        @if (showDot()) {
          <circle [attr.cx]="latestX()" [attr.cy]="latestY()" r="1.6" [attr.fill]="dotColor()" />
        }
      </svg>
    } @else {
      <span class="muted">—</span>
    }
  `,
  styles: [
    `
      :host {
        display: flex;
        align-items: center;
        height: 100%;
        width: 100%;
      }
      .spark {
        display: block;
        width: 100%;
        height: 28px;
      }
      .muted {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
      }
    `,
  ],
})
export class SparklineCellComponent implements ICellRendererAngularComp {
  readonly points = signal<number[]>([]);
  readonly color = signal<string>(DEFAULT_COLOR);
  readonly dotColor = signal<string>(DOT_COLOR);
  readonly showDot = signal<boolean>(true);
  readonly label = signal<string>('Trend');
  readonly domainOverride = signal<[number, number] | null>(null);

  readonly polyline = computed(() => {
    const pts = this.points();
    if (pts.length < 2) return '';
    const [lo, hi] = this.domain();
    const range = hi - lo || 1;
    const stepX = 100 / (pts.length - 1);
    return pts
      .map((v, i) => {
        const x = i * stepX;
        // Y is inverted for SVG; pad by 2px on each side so the dot doesn't clip.
        const y = 30 - ((v - lo) / range) * 28;
        return `${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(' ');
  });

  readonly latestX = computed(() => {
    const n = this.points().length;
    return n < 2 ? 0 : 100;
  });

  readonly latestY = computed(() => {
    const pts = this.points();
    if (pts.length < 2) return 16;
    const [lo, hi] = this.domain();
    const range = hi - lo || 1;
    return 30 - ((pts[pts.length - 1] - lo) / range) * 28;
  });

  readonly ariaLabel = computed(() => {
    const pts = this.points();
    if (pts.length === 0) return `${this.label()}: no data`;
    const last = pts[pts.length - 1];
    return `${this.label()}: ${pts.length} points, latest ${last.toFixed(2)}`;
  });

  private domain(): [number, number] {
    const override = this.domainOverride();
    if (override) return override;
    const pts = this.points();
    const min = Math.min(...pts);
    const max = Math.max(...pts);
    // Don't collapse to zero range — gives the polyline some breathing room.
    return min === max ? [min - 0.5, max + 0.5] : [min, max];
  }

  agInit(params: ICellRendererParams & SparklineCellRendererParams): void {
    this.apply(params);
  }

  refresh(params: ICellRendererParams & SparklineCellRendererParams): boolean {
    this.apply(params);
    return true;
  }

  private apply(params: ICellRendererParams & SparklineCellRendererParams): void {
    const raw = params.value;
    const pts = Array.isArray(raw) ? raw.filter((v): v is number => typeof v === 'number') : [];
    this.points.set(pts);
    this.color.set(params.color ?? DEFAULT_COLOR);
    this.dotColor.set(params.color ?? DOT_COLOR);
    this.showDot.set(params.showLatestDot !== false);
    this.label.set(params.label ?? 'Trend');
    this.domainOverride.set(params.domain ?? null);
  }
}
