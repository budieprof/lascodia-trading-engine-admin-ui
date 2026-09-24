import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';

import type { StrategyReport } from './strategy-report.model';
import { buildEquityChartOptions, underwaterPercent, type ReportPalette } from './report-charts';
import {
  formatDateTime,
  formatInteger,
  formatMoney,
  formatPercent,
  formatQty,
  formatRatio,
  polarity,
} from './report-format';

interface StatTile {
  label: string;
  value: string;
  detail: string;
  tone: '' | 'gain' | 'loss';
}

/** Rows of the equity curve's table view; long curves are sampled evenly to this many rows. */
const TABLE_ROWS = 120;

/**
 * Overview tab: the five headline statistics as stat tiles, then one chart with the strategy's
 * equity against buy & hold, the underwater drawdown and the position size stacked on a shared
 * time axis. The curve also has a table view for readers who cannot use the chart.
 */
@Component({
  selector: 'app-report-overview',
  standalone: true,
  imports: [ChartCardComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ul class="tiles" aria-label="Key statistics">
      @for (t of tiles(); track t.label) {
        <li class="tile">
          <span class="tile-label">{{ t.label }}</span>
          <span
            class="tile-value"
            [class.gain]="t.tone === 'gain'"
            [class.loss]="t.tone === 'loss'"
            >{{ t.value }}</span
          >
          <span class="tile-detail">{{ t.detail }}</span>
        </li>
      }
    </ul>

    <app-chart-card
      title="Equity"
      [subtitle]="chartSubtitle()"
      [options]="chartOptions() ?? {}"
      [emptyMessage]="chartOptions() ? null : 'Not enough equity data to draw a curve'"
      [emptyHint]="chartOptions() ? null : 'The run processed fewer than two bars with equity.'"
      alt="Strategy equity and buy-and-hold equity over time, with the underwater drawdown and the position size in panels below"
      height="500px"
    />

    @if (tableRows().length > 0) {
      <details class="table-twin">
        <summary>Equity data table{{ sampled() ? ' (sampled)' : '' }}</summary>
        <div class="twin-wrap" tabindex="0" role="region" aria-label="Equity data table">
          <table>
            <caption class="sr-only">
              Equity curve values per bar, UTC
            </caption>
            <thead>
              <tr>
                <th scope="col">Time (UTC)</th>
                <th scope="col" class="num">Equity</th>
                <th scope="col" class="num">Buy &amp; hold</th>
                <th scope="col" class="num">Drawdown</th>
                <th scope="col" class="num">Drawdown %</th>
                <th scope="col" class="num">Position</th>
              </tr>
            </thead>
            <tbody>
              @for (r of tableRows(); track $index) {
                <tr>
                  <th scope="row">{{ r.time }}</th>
                  <td class="num">{{ r.equity }}</td>
                  <td class="num">{{ r.buyHold }}</td>
                  <td class="num">{{ r.drawdown }}</td>
                  <td class="num">{{ r.drawdownPct }}</td>
                  <td class="num">{{ r.position }}</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      </details>
    }
  `,
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
      }
      .tiles {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
        gap: var(--space-3);
      }
      .tile {
        display: flex;
        flex-direction: column;
        gap: 2px;
        padding: var(--space-4);
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        min-width: 0;
      }
      .tile-label {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        font-weight: var(--font-medium);
      }
      .tile-value {
        font-size: var(--text-xl);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
        overflow-wrap: anywhere;
      }
      .tile-detail {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
      }
      .gain {
        color: var(--profit);
      }
      .loss {
        color: var(--loss);
      }
      .table-twin summary {
        cursor: pointer;
        font-size: var(--text-sm);
        color: var(--text-secondary);
      }
      .table-twin summary:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: 2px;
      }
      .twin-wrap {
        margin-top: var(--space-2);
        max-height: 360px;
        overflow: auto;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
      }
      table {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-xs);
      }
      th,
      td {
        padding: 6px var(--space-3);
        border-bottom: 1px solid var(--border);
        text-align: left;
        white-space: nowrap;
      }
      thead th {
        position: sticky;
        top: 0;
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        font-weight: var(--font-semibold);
      }
      tbody th {
        font-weight: var(--font-regular);
      }
      .num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
        border: 0;
      }
    `,
  ],
})
export class ReportOverviewComponent {
  readonly report = input.required<StrategyReport>();
  readonly currency = input('');
  readonly palette = input.required<ReportPalette>();

  readonly tiles = computed<StatTile[]>(() => {
    const r = this.report();
    const all = r.performance.all;
    const cur = this.currency();
    const closed = all.totalClosedTrades ?? 0;
    const open = all.totalOpenTrades ?? 0;
    const tone = (v: number | null): StatTile['tone'] => {
      const p = polarity(v);
      return p === 'pos' ? 'gain' : p === 'neg' ? 'loss' : '';
    };
    const tiles: StatTile[] = [
      {
        label: 'Total P&L',
        value: formatMoney(all.netProfit, cur, { signed: true }),
        detail: `${formatPercent(all.netProfitPercent, { signed: true })} of initial capital`,
        tone: tone(all.netProfit),
      },
      {
        label: 'Max equity drawdown',
        value: formatMoney(r.equity.maxDrawdown, cur),
        detail: `${formatPercent(r.equity.maxDrawdownPercent)} from the peak (intrabar)`,
        tone: (r.equity.maxDrawdown ?? 0) > 0 ? 'loss' : '',
      },
      {
        label: 'Total trades',
        value: formatInteger(all.totalClosedTrades),
        detail: open > 0 ? `closed · ${formatInteger(open)} still open` : 'closed',
        tone: '',
      },
      {
        label: 'Profitable trades',
        value: formatPercent(all.percentProfitable),
        detail: `${formatInteger(all.winningTrades)} of ${formatInteger(closed)} closed`,
        tone: '',
      },
      {
        label: 'Profit factor',
        value: formatRatio(all.profitFactor),
        detail:
          all.profitFactor !== null
            ? 'gross profit ÷ gross loss'
            : closed > 0 && (all.losingTrades ?? 0) === 0
              ? 'not defined — no losing trades'
              : 'not defined',
        tone: '',
      },
    ];
    if (open > 0) {
      tiles.push({
        label: 'Open P&L',
        value: formatMoney(all.openPnL, cur, { signed: true }),
        detail: `${formatInteger(open)} open trade${open === 1 ? '' : 's'}`,
        tone: tone(all.openPnL),
      });
    }
    return tiles;
  });

  readonly chartOptions = computed(() =>
    buildEquityChartOptions(this.report(), this.palette(), this.currency()),
  );

  readonly chartSubtitle = computed(() => {
    const hasBuyHold = this.report().equityCurve.some((p) => p.buyHoldEquity !== null);
    return (
      (hasBuyHold ? 'Strategy vs buy & hold' : 'Strategy equity') +
      ' · underwater drawdown · position size · shaded: largest drawdown (UTC)'
    );
  });

  readonly sampled = computed(() => this.report().equityCurve.length > TABLE_ROWS);

  readonly tableRows = computed(() => {
    const curve = this.report().equityCurve;
    const cur = this.currency();
    const step = Math.max(1, Math.ceil(curve.length / TABLE_ROWS));
    const indices: number[] = [];
    for (let i = 0; i < curve.length; i += step) indices.push(i);
    // Sampling must not drop the final value — it is the one the tiles report.
    if (curve.length > 0 && indices[indices.length - 1] !== curve.length - 1) {
      indices.push(curve.length - 1);
    }
    const rows = [];
    for (const i of indices) {
      const p = curve[i];
      rows.push({
        time: formatDateTime(p.time),
        equity: formatMoney(p.equity, cur),
        buyHold: formatMoney(p.buyHoldEquity, cur),
        drawdown: formatMoney(p.drawdown, cur),
        drawdownPct: formatPercent(underwaterPercent(p)),
        position: formatQty(p.positionSize),
      });
    }
    return rows;
  });
}
