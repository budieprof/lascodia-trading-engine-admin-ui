import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { DecimalPipe, DatePipe } from '@angular/common';
import { DailyBarsService } from './daily-bars.service';
import { performanceTiles, type DailyBar } from './performance';

/**
 * 1W / 1M / 3M / 6M / YTD / 1Y % change tiles for a symbol, from daily candles.
 * Pass `bars` to render from data the host already holds; otherwise the
 * component fetches the engine's daily sessions for `symbol` itself
 * (`DailyBarsService`: 17:00 New York days, stamped by trading day).
 */
@Component({
  selector: 'app-performance-tiles',
  standalone: true,
  imports: [DecimalPipe, DatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="tree-title">Performance</div>
    @if (loading()) {
      <div class="pane-empty">Loading…</div>
    } @else {
      <div class="tiles">
        @for (t of tiles(); track t.period) {
          <div
            class="tile"
            [class.up]="(t.pct ?? 0) > 0"
            [class.down]="(t.pct ?? 0) < 0"
            [attr.title]="
              t.fromTime === null
                ? 'Not enough history'
                : 'Since close of ' + (t.fromTime | date: 'yyyy-MM-dd' : 'UTC')
            "
          >
            <span class="pct">{{ t.pct === null ? '—' : (t.pct | number: '1.2-2') + '%' }}</span>
            <span class="period">{{ t.period }}</span>
          </div>
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
      .tiles {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 4px;
        padding: 0 12px;
      }
      .tile {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 1px;
        padding: 5px 2px;
        border-radius: 6px;
        background: var(--surface-hover, #f0f3fa);
        font-variant-numeric: tabular-nums;
      }
      .pct {
        font-weight: 600;
      }
      .period {
        color: var(--text-muted, #787b86);
        font-size: 11px;
      }
      .tile.up {
        color: #26a69a;
        background: rgba(38, 166, 154, 0.1);
      }
      .tile.down {
        color: #ef5350;
        background: rgba(239, 83, 80, 0.1);
      }
    `,
  ],
})
export class PerformanceTilesComponent {
  private readonly daily = inject(DailyBarsService);

  readonly symbol = input<string | null>(null);
  /** Optional pre-loaded ascending daily bars; when set, no fetch happens. */
  readonly bars = input<readonly DailyBar[] | null>(null);

  private readonly fetched = signal<readonly DailyBar[]>([]);
  readonly loading = signal(false);

  readonly tiles = computed(() => performanceTiles(this.bars() ?? this.fetched()));

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
}
