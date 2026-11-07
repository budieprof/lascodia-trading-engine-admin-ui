import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { minutesText } from './ni-viz';

/**
 * Latency range chart (Sources tab): per row, the publish → first-seen p50…p90 range on a log-minutes axis,
 * 24 h (solid, accent) over 7 d (thin, muted). A dot marks each p50. One axis, one unit; hover a row for the
 * exact figures. Rows arrive pre-sorted.
 */
export interface LatencyRangeRow {
  label: string;
  sub?: string | null;
  day: { count: number; p50: number; p90: number } | null;
  week: { count: number; p50: number; p90: number } | null;
}

const TICKS = [1, 5, 15, 60, 240, 720, 1440, 4320, 10080];

@Component({
  selector: 'app-ni-latency-range',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="lr" (mouseleave)="hover.set(null)">
      <div class="axis">
        <span class="lbl"></span>
        <span class="track">
          @for (t of ticks(); track t.m) {
            <span class="tk" [style.left.%]="t.x">{{ t.text }}</span>
          }
        </span>
        <span class="n">n 24h</span>
      </div>
      @for (r of rows(); track r.label + (r.sub ?? ''); let i = $index) {
        <div class="row" (mouseenter)="hover.set(i)" [class.dim]="hover() !== null && hover() !== i">
          <span class="lbl" [title]="r.label + (r.sub ? ' · ' + r.sub : '')">
            {{ r.label }}
            @if (r.sub) {
              <small>{{ r.sub }}</small>
            }
          </span>
          <span class="track">
            @for (t of ticks(); track t.m) {
              <i class="grid" [style.left.%]="t.x"></i>
            }
            @if (r.week; as w) {
              <i class="rw" [style.left.%]="x(w.p50)" [style.width.%]="Math.max(0.6, x(w.p90) - x(w.p50))"></i>
              <i class="dw" [style.left.%]="x(w.p50)"></i>
            }
            @if (r.day; as d) {
              <i class="rd" [style.left.%]="x(d.p50)" [style.width.%]="Math.max(0.6, x(d.p90) - x(d.p50))"></i>
              <i class="dd" [style.left.%]="x(d.p50)"></i>
            }
            @if (hover() === i) {
              <span class="tip" [class.flip]="x(r.day?.p50 ?? r.week?.p50 ?? 1) > 55" [style.left.%]="x(r.day?.p50 ?? r.week?.p50 ?? 1)">
                <b>{{ r.label }}</b>
                <span>24h p50 {{ m(r.day?.p50) }} · p90 {{ m(r.day?.p90) }} · n {{ r.day?.count ?? 0 }}</span>
                <span>7d p50 {{ m(r.week?.p50) }} · p90 {{ m(r.week?.p90) }} · n {{ r.week?.count ?? 0 }}</span>
              </span>
            }
          </span>
          <span class="n">{{ r.day?.count ?? '—' }}</span>
        </div>
      } @empty {
        <p class="empty">No latency rows reported.</p>
      }
      <div class="legend">
        <span><i class="ld"></i>24 h p50–p90</span>
        <span><i class="lw"></i>7 d p50–p90</span>
        <span class="faint">log scale</span>
      </div>
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
        min-width: 0;
      }
      .axis,
      .row {
        display: grid;
        grid-template-columns: var(--lbl-w, 120px) minmax(0, 1fr) 40px;
        gap: 8px;
        align-items: center;
      }
      .axis {
        height: 16px;
        font-size: 10px;
        color: var(--text-tertiary);
      }
      .row {
        height: 22px;
        transition: opacity 0.1s ease;
      }
      .row.dim {
        opacity: 0.55;
      }
      .lbl {
        font-size: 11.5px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .lbl small {
        color: var(--text-tertiary);
        font-size: 10px;
        margin-left: 3px;
      }
      .track {
        position: relative;
        height: 100%;
      }
      .tk {
        position: absolute;
        transform: translateX(-50%);
        white-space: nowrap;
      }
      .grid {
        position: absolute;
        top: 0;
        bottom: 0;
        width: 1px;
        background: var(--ni-grid);
      }
      .rw,
      .rd {
        position: absolute;
        border-radius: 3px;
      }
      .rw {
        top: 13px;
        height: 3px;
        background: var(--text-tertiary);
        opacity: 0.45;
      }
      .rd {
        top: 6px;
        height: 6px;
        background: color-mix(in oklab, var(--accent) 55%, transparent);
      }
      .dd,
      .dw {
        position: absolute;
        border-radius: 50%;
        transform: translateX(-50%);
      }
      .dd {
        top: 4px;
        width: 10px;
        height: 10px;
        background: var(--accent);
        box-shadow: 0 0 0 2px var(--ni-panel, #fff);
      }
      .dw {
        top: 12px;
        width: 5px;
        height: 5px;
        background: var(--text-secondary);
      }
      .n {
        font-size: 11px;
        text-align: right;
        font-variant-numeric: tabular-nums;
        color: var(--text-secondary);
      }
      .tip {
        position: absolute;
        bottom: calc(100% + 2px);
        transform: translateX(-10px);
        z-index: 30;
        display: flex;
        flex-direction: column;
        gap: 1px;
        background: var(--ni-panel, #fff);
        border: 1px solid var(--border);
        border-radius: 8px;
        box-shadow: var(--shadow-lg);
        padding: 6px 8px;
        font-size: 11px;
        white-space: nowrap;
        pointer-events: none;
        font-variant-numeric: tabular-nums;
      }
      .tip.flip {
        transform: translateX(calc(-100% + 10px));
      }
      .tip span {
        color: var(--text-secondary);
      }
      .legend {
        display: flex;
        gap: 12px;
        margin-top: 6px;
        font-size: 10.5px;
        color: var(--text-secondary);
      }
      .legend span {
        display: inline-flex;
        align-items: center;
        gap: 5px;
      }
      .ld {
        width: 16px;
        height: 6px;
        border-radius: 3px;
        background: color-mix(in oklab, var(--accent) 55%, transparent);
      }
      .lw {
        width: 16px;
        height: 3px;
        border-radius: 2px;
        background: var(--text-tertiary);
        opacity: 0.6;
      }
      .faint {
        color: var(--text-tertiary);
      }
      .empty {
        color: var(--text-tertiary);
        font-size: 12px;
        padding: 8px 0;
      }
    `,
  ],
})
export class NiLatencyRangeComponent {
  readonly rows = input<readonly LatencyRangeRow[]>([]);
  readonly hover = signal<number | null>(null);
  readonly Math = Math;

  /** Log domain from the data, padded to whole ticks (≥ 1 minute). */
  private readonly dom = computed<[number, number]>(() => {
    const vs: number[] = [];
    for (const r of this.rows()) {
      for (const c of [r.day, r.week]) if (c) vs.push(c.p50, c.p90);
    }
    const pos = vs.filter((v) => v > 0);
    const lo = Math.max(1, Math.min(...(pos.length ? pos : [1])) * 0.7);
    const hi = Math.max(lo * 4, Math.max(...(pos.length ? pos : [60])) * 1.3);
    return [Math.log(lo), Math.log(hi)];
  });

  x(minutes: number | null | undefined): number {
    const [a, b] = this.dom();
    const v = Math.log(Math.max(1, minutes ?? 1));
    return Math.max(0, Math.min(100, ((v - a) / (b - a || 1)) * 100));
  }

  readonly ticks = computed(() => {
    const [a, b] = this.dom();
    return TICKS.filter((t) => Math.log(t) >= a && Math.log(t) <= b).map((m) => ({
      m,
      x: this.x(m),
      text: minutesText(m),
    }));
  });

  m(v: number | null | undefined): string {
    return minutesText(v);
  }
}
