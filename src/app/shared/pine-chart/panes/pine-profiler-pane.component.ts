import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import type { PineProfileLine } from '../model/pine-outputs.types';
import type { PineLineJump } from './pine-logs-pane.component';
import {
  formatMicros,
  heatColor,
  profilerRows,
  sortProfilerRows,
  type ProfilerSort,
  type ProfilerSortKey,
} from './profiler-model';

/**
 * Pine Profiler: per-line execution count and time, sortable, with a heat bar for each line's share
 * of the run and flames on the three costliest lines. A row jumps the editor to its line.
 */
@Component({
  selector: 'app-pine-profiler-pane',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="summary">
      @if (rows().length) {
        <span><b>{{ rows().length }}</b> significant lines</span>
        <span>· total <b>{{ micros(totalMicros()) }}</b></span>
        @if (elapsedMs() !== null) {
          <span>· run {{ elapsedMs() }} ms</span>
        }
      } @else {
        <span>No profile. Run the script with profiling on to see where its time goes.</span>
      }
    </div>
    @if (rows().length) {
      <div class="table" role="table" aria-label="Profiler results">
        <div class="head" role="row">
          @for (c of columns; track c.key) {
            <button
              type="button"
              role="columnheader"
              [class.active]="sort().key === c.key"
              [attr.aria-sort]="sort().key === c.key ? (sort().dir === 'asc' ? 'ascending' : 'descending') : 'none'"
              (click)="sortBy(c.key)"
            >
              {{ c.label }}
              @if (sort().key === c.key) {
                <span class="arrow">{{ sort().dir === 'asc' ? '▲' : '▼' }}</span>
              }
            </button>
          }
          <span role="columnheader" class="code-head">Code</span>
        </div>
        @for (r of sorted(); track r.line) {
          <div class="tr" role="row" tabindex="0" (click)="lineJump.emit({ line: r.line })" (keydown.enter)="lineJump.emit({ line: r.line })" [title]="'Go to line ' + r.line">
            <span class="num" role="cell">
              {{ r.line }}
              @if (r.flame) {
                <svg class="flame" viewBox="0 0 24 24" [attr.aria-label]="'Costliest line #' + r.flame"><path d="M12 2c1 3.5-1.5 5.2-1.5 7.6 0 1.4.9 2.4 2 2.4 1.9 0 2.5-2 1.9-4.2C16.9 9.9 19 12.9 19 16a7 7 0 1 1-14 0c0-3.3 2.2-5.8 4.3-7.7C11 6.7 12.4 4.8 12 2z" /></svg>
              }
            </span>
            <span class="num" role="cell">{{ r.executions.toLocaleString() }}</span>
            <span class="num" role="cell">{{ micros(r.totalMicros) }}</span>
            <span class="num" role="cell">{{ micros(r.avgMicros) }}</span>
            <span class="pct" role="cell">
              <span class="heat" [style.width.%]="r.heat * 100" [style.background]="heat(r.heat)"></span>
              <span class="pct-text">{{ r.percent.toFixed(1) }}%</span>
            </span>
            <code class="code" role="cell">{{ r.source ?? '' }}</code>
          </div>
        }
      </div>
    }
  `,
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        min-height: 0;
        height: 100%;
        font-size: 12px;
        color: var(--text-primary, #1d1d1f);
      }
      .summary {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        padding: 6px 10px;
        color: var(--text-secondary, #6e6e73);
        border-bottom: 1px solid var(--border, rgba(0, 0, 0, 0.08));
      }
      .summary b {
        color: var(--text-primary, #1d1d1f);
        font-weight: 600;
      }
      .table {
        flex: 1 1 auto;
        overflow: auto;
      }
      .head,
      .tr {
        display: grid;
        grid-template-columns: 70px 90px 90px 80px 130px minmax(160px, 1fr);
        gap: 8px;
        align-items: center;
        padding: 3px 10px;
      }
      .head {
        position: sticky;
        top: 0;
        z-index: 1;
        background: var(--bg-secondary, #f5f5f7);
      }
      .head button {
        font: inherit;
        font-weight: 600;
        text-align: left;
        border: 0;
        padding: 0;
        background: transparent;
        color: var(--text-secondary, #6e6e73);
        cursor: pointer;
      }
      .head button.active {
        color: var(--text-primary, #1d1d1f);
      }
      .code-head {
        font-weight: 600;
        color: var(--text-secondary, #6e6e73);
      }
      .arrow {
        font-size: 9px;
      }
      .tr {
        cursor: pointer;
        border-bottom: 1px solid var(--border, rgba(0, 0, 0, 0.04));
      }
      .tr:hover {
        background: var(--bg-secondary, #f5f5f7);
      }
      .num {
        font-variant-numeric: tabular-nums;
        display: inline-flex;
        align-items: center;
        gap: 4px;
      }
      .flame {
        width: 12px;
        height: 12px;
        fill: #ff6d00;
      }
      .pct {
        position: relative;
        height: 16px;
        border-radius: 3px;
        background: var(--bg-tertiary, #e8e8ed);
        overflow: hidden;
      }
      .heat {
        position: absolute;
        left: 0;
        top: 0;
        bottom: 0;
      }
      .pct-text {
        position: relative;
        padding-left: 4px;
        font-variant-numeric: tabular-nums;
        line-height: 16px;
      }
      .code {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        color: var(--text-secondary, #6e6e73);
      }
    `,
  ],
})
export class PineProfilerPaneComponent {
  readonly profile = input<readonly PineProfileLine[]>([]);
  /** Script source, to show each profiled line's code. */
  readonly source = input<string | null>(null);
  readonly elapsedMs = input<number | null>(null);
  readonly lineJump = output<PineLineJump>();

  protected readonly columns: ReadonlyArray<{ key: ProfilerSortKey; label: string }> = [
    { key: 'line', label: 'Line' },
    { key: 'executions', label: 'Executions' },
    { key: 'total', label: 'Time' },
    { key: 'avg', label: 'Avg' },
    { key: 'percent', label: '% of run' },
  ];

  readonly sort = signal<ProfilerSort>({ key: 'total', dir: 'desc' });
  readonly rows = computed(() => profilerRows(this.profile(), this.source()));
  readonly sorted = computed(() => sortProfilerRows(this.rows(), this.sort()));
  readonly totalMicros = computed(() => this.rows().reduce((s, r) => s + r.totalMicros, 0));

  sortBy(key: ProfilerSortKey): void {
    const cur = this.sort();
    this.sort.set(
      cur.key === key ? { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'line' ? 'asc' : 'desc' },
    );
  }

  protected micros(us: number): string {
    return formatMicros(us);
  }

  protected heat(h: number): string {
    return heatColor(h);
  }
}
