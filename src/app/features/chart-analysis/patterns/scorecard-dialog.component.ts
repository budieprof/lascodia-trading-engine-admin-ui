import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import type { Ohlc } from '../indicators/math';
import type { CandleTrendFilter } from './candlestick-patterns';
import { canExportPine, pineStrategyFor } from './pine-export';
import {
  candleSignals,
  chartPatternSignals,
  scoreSignals,
  structureSignals,
  type PatternScore,
  type ScoreSource,
} from './scorecard';

const SECTIONS: { source: ScoreSource; title: string }[] = [
  { source: 'candle', title: 'Candlestick patterns' },
  { source: 'chart', title: 'Chart patterns (confirmed)' },
  { source: 'structure', title: 'Structure' },
];

/**
 * The pattern and structure scorecard (DR-I8): every candlestick pattern, confirmed chart pattern and structure event
 * on the loaded bars, scored the scorecard's way ({@link scoreSignals}) — and a row exported as a Pine strategy draft.
 */
@Component({
  selector: 'app-pattern-scorecard-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="sc-backdrop" (pointerdown)="closed.emit()"></div>
    <div
      class="sc"
      role="dialog"
      aria-modal="true"
      aria-label="Pattern scorecard"
      (keydown.escape)="closed.emit()"
    >
      <header class="sc-head">
        <span class="sc-title"
          >Pattern &amp; structure scorecard · {{ symbol() }} {{ resolution() }}</span
        >
        <button type="button" class="sc-x" aria-label="Close" (click)="closed.emit()">×</button>
      </header>
      <div class="sc-controls">
        <label>
          Held
          <select aria-label="Bars held" (change)="horizon.set(+$any($event.target).value)">
            @for (k of horizons; track k) {
              <option [value]="k" [selected]="horizon() === k">{{ k }} bars</option>
            }
          </select>
        </label>
        <label>
          Spread
          <input
            type="number"
            min="0"
            step="0.1"
            aria-label="Spread in pips"
            [value]="spreadPips()"
            (change)="spreadPipsSet($any($event.target).value)"
          />
          pips
        </label>
        <span class="sc-meta">{{ bars().length }} bars</span>
      </div>
      <div class="sc-body">
        @for (sec of sections(); track sec.source) {
          <h4 class="sc-sec">{{ sec.title }}</h4>
          @if (!sec.rows.length) {
            <p class="sc-none">None on these bars.</p>
          } @else {
            <table class="sc-table">
              <thead>
                <tr>
                  <th scope="col">Signal</th>
                  <th scope="col">Way</th>
                  <th scope="col" class="num" title="Signals with all their bars behind them">N</th>
                  <th scope="col" class="num" title="Made money after the spread">Hit</th>
                  <th
                    scope="col"
                    class="num"
                    title="Mean result in R (ATR at the signal), after the spread"
                  >
                    Mean R
                  </th>
                  <th scope="col" class="num" title="Mean best excursion, R">MFE</th>
                  <th scope="col" class="num" title="Mean worst excursion against, R">MAE</th>
                  <th scope="col"><span class="sr-only">Export</span></th>
                </tr>
              </thead>
              <tbody>
                @for (r of sec.rows; track r.id + r.direction) {
                  <tr [class.thin]="r.samples < 20">
                    <td>{{ r.name }}</td>
                    <td
                      [class.up]="r.direction === 'bullish'"
                      [class.down]="r.direction === 'bearish'"
                    >
                      {{ r.direction === 'bullish' ? 'Long' : 'Short' }}
                    </td>
                    <td class="num">{{ r.samples }}</td>
                    <td class="num">{{ r.samples ? (r.hitRate * 100).toFixed(0) + '%' : '—' }}</td>
                    <td class="num" [class.up]="r.meanR > 0" [class.down]="r.meanR < 0">
                      {{ r.samples ? fmtR(r.meanR) : '—' }}
                    </td>
                    <td class="num">{{ r.samples ? fmtR(r.meanMfeR) : '—' }}</td>
                    <td class="num">{{ r.samples ? fmtR(r.meanMaeR) : '—' }}</td>
                    <td>
                      @if (exportable(r)) {
                        <button
                          type="button"
                          class="sc-btn"
                          title="Open as a Pine strategy draft in the editor (nothing is saved or run)"
                          (click)="export(r)"
                        >
                          Pine
                        </button>
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          }
        }
      </div>
      <p class="sc-note">
        Entry at the next bar's open after the signal, exit at the open {{ horizon() }} bars later;
        1R = ATR(14) at the signal; one spread paid per trade; no stop. Fewer than 20 samples are
        greyed. These are the loaded bars of this chart — evidence to look at, not a forecast.
      </p>
    </div>
  `,
  styles: `
    .sc-backdrop {
      position: fixed;
      inset: 0;
      z-index: 1000;
      background: rgba(0, 0, 0, 0.2);
    }
    .sc {
      position: fixed;
      z-index: 1001;
      left: 50%;
      top: 50%;
      transform: translate(-50%, -50%);
      width: min(760px, calc(100vw - 32px));
      max-height: calc(100vh - 64px);
      display: flex;
      flex-direction: column;
      background: var(--tv-bg, #fff);
      color: var(--tv-ink, #131722);
      border-radius: 6px;
      box-shadow: 0 2px 24px rgba(0, 0, 0, 0.3);
      font-size: 13px;
    }
    .sc-head {
      display: flex;
      align-items: center;
      padding: 14px 18px 8px;
    }
    .sc-title {
      font-size: 17px;
      font-weight: 600;
      flex: 1;
    }
    .sc-x {
      border: 0;
      background: none;
      color: var(--tv-muted, #787b86);
      font-size: 22px;
      cursor: pointer;
    }
    .sc-controls {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 16px;
      padding: 0 18px 8px;
    }
    .sc-controls label {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .sc-controls select,
    .sc-controls input {
      height: 28px;
      padding: 0 6px;
      border: 1px solid var(--tv-line, #e0e3eb);
      border-radius: 4px;
      background: var(--tv-bg, #fff);
      color: inherit;
      font: inherit;
    }
    .sc-controls input {
      width: 64px;
    }
    .sc-meta {
      color: var(--tv-muted, #787b86);
    }
    .sc-body {
      overflow: auto;
      padding: 0 18px;
    }
    .sc-sec {
      margin: 12px 0 6px;
      font-size: 13px;
    }
    .sc-none {
      color: var(--tv-muted, #787b86);
      margin: 0 0 8px;
    }
    .sc-table {
      width: 100%;
      border-collapse: collapse;
    }
    .sc-table th,
    .sc-table td {
      padding: 4px 6px;
      border-bottom: 1px solid var(--tv-line, #e0e3eb);
      text-align: left;
    }
    .sc-table th {
      color: var(--tv-muted, #787b86);
      font-weight: 500;
    }
    .num {
      text-align: right !important;
      font-variant-numeric: tabular-nums;
    }
    .up {
      color: #089981;
    }
    .down {
      color: #f23645;
    }
    tr.thin td {
      opacity: 0.55;
    }
    .sc-btn {
      height: 24px;
      padding: 0 8px;
      border: 1px solid var(--tv-line, #e0e3eb);
      border-radius: 4px;
      background: none;
      color: inherit;
      cursor: pointer;
    }
    .sc-note {
      margin: 0;
      padding: 10px 18px 14px;
      color: var(--tv-muted, #787b86);
      font-size: 12px;
    }
    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip: rect(0 0 0 0);
    }
  `,
})
export class PatternScorecardDialogComponent {
  /** The chart's bars (UTC, ascending). */
  readonly bars = input.required<readonly Ohlc[]>();
  readonly symbol = input('');
  readonly resolution = input('');
  /** One pip, in price. */
  readonly pipSize = input(0.0001);
  /** The live spread in price units; null = 1 pip. */
  readonly spread = input<number | null>(null);
  /** The candlestick studies' trend filter (the first one's), and the chart-pattern study's swing size. */
  readonly trend = input<CandleTrendFilter>('sma50');
  readonly pivotDepth = input(5);

  readonly closed = output<void>();
  /** A row as a Pine strategy draft for the editor. */
  readonly exportPine = output<{ name: string; source: string }>();

  readonly horizons = [1, 3, 5, 10, 20, 50];
  readonly horizon = signal(10);
  private readonly spreadOverride = signal<number | null>(null);

  readonly spreadPips = computed(() => {
    const o = this.spreadOverride();
    if (o !== null) return o;
    const pip = this.pipSize() || 0.0001;
    const s = this.spread();
    return s !== null && s >= 0 ? Math.round((s / pip) * 10) / 10 : 1;
  });

  private readonly signals = computed(() => {
    const bars = this.bars();
    return [
      ...candleSignals(bars, { trend: this.trend() }),
      ...chartPatternSignals(bars, { pivotDepth: this.pivotDepth() }),
      ...structureSignals(bars, this.pivotDepth()),
    ];
  });

  readonly sections = computed(() => {
    const scores = scoreSignals(this.bars(), this.signals(), {
      horizon: this.horizon(),
      spread: this.spreadPips() * (this.pipSize() || 0.0001),
    });
    return SECTIONS.map((s) => ({ ...s, rows: scores.filter((r) => r.source === s.source) }));
  });

  spreadPipsSet(raw: string): void {
    const v = Number(raw);
    if (Number.isFinite(v) && v >= 0) this.spreadOverride.set(v);
  }

  fmtR(v: number): string {
    return `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}`;
  }

  exportable(r: PatternScore): boolean {
    return canExportPine(r);
  }

  export(r: PatternScore): void {
    const source = pineStrategyFor(r, {
      horizon: this.horizon(),
      trendFilter: this.trend() === 'sma50',
      depth: this.pivotDepth(),
      symbol: this.symbol(),
      timeframe: this.resolution(),
    });
    if (source)
      this.exportPine.emit({
        name: `${r.name} (${r.direction === 'bullish' ? 'long' : 'short'})`,
        source,
      });
  }
}
