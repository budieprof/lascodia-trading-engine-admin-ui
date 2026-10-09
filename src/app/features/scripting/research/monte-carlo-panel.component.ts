import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { SCRIPTING_UI_STYLES } from '../components/scripting-ui.styles';
import { formatDate, formatInteger, formatNumber, formatPercent } from '../report/report-format';
import { describeFailure } from '../shared/api-error';
import { ResearchApiService } from './research-api.service';
import type { MonteCarloDto, MonteCarloParams, MonteCarloPercentiles } from './research.types';

export const DEFAULT_MC_PARAMS: MonteCarloParams = {
  iterations: 2000,
  riskPerTradePct: 1,
  ruinDrawdownPct: 50,
};

export interface McRow {
  label: string;
  unit: 'pct' | 'trades' | 'days';
  p: MonteCarloPercentiles | null;
  note: string;
}

/** The engine's percentiles as table rows; "p95" of a drawdown is the bad tail (only 5 % of paths fell further). */
export function monteCarloRows(dto: MonteCarloDto): McRow[] {
  const r = dto.result;
  return [
    {
      label: 'Maximum drawdown',
      unit: 'pct',
      p: r.maxDrawdownPct,
      note: 'P95: only 5 % of paths fell further',
    },
    {
      label: 'Total return',
      unit: 'pct',
      p: r.totalReturnPct,
      note: 'over a path as long as the run',
    },
    {
      label: 'Annual growth (CAGR)',
      unit: 'pct',
      p: r.cagrPct,
      note: r.cagrPct ? 'annualised by the run’s own pace' : 'the trades span less than a day',
    },
    {
      label: 'Longest time under water',
      unit: 'trades',
      p: r.timeToRecoverTrades,
      note: 'trades from a peak back to it',
    },
    {
      label: 'Longest time under water',
      unit: 'days',
      p: r.timeToRecoverDays,
      note: 'at the run’s trade pace',
    },
  ];
}

export function mcValue(v: number, unit: McRow['unit']): string {
  if (unit === 'pct') return formatPercent(v, { decimals: 1 });
  if (unit === 'trades') return `${formatInteger(v)} trades`;
  return `${formatInteger(v)} days`;
}

/**
 * BT-I6 — Monte Carlo in R from the engine (`GET backtest/{id}/monte-carlo` or `walk-forward/{id}/monte-carlo`): the
 * run's R multiples block-bootstrapped into paths as long as the run, compounded at a fixed risk per trade. Shows the
 * P5 / P50 / P95 of drawdown, return, annual growth and time under water, the risk of ruin, the chance of ending down
 * and the share of paths still under water at the end.
 */
@Component({
  selector: 'app-monte-carlo-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card" aria-labelledby="mc-title" data-testid="monte-carlo-panel">
      <header class="head">
        <h3 id="mc-title" class="title">Monte Carlo in R</h3>
        <span class="muted small">{{ sourceLabel() }}</span>
      </header>
      <div class="params">
        <label>
          <span class="muted small">Risk per trade (%)</span>
          <input
            class="field-input num"
            type="number"
            min="0.1"
            max="10"
            step="0.1"
            [value]="params().riskPerTradePct"
            (change)="setParam('riskPerTradePct', $any($event.target).value)"
          />
        </label>
        <label>
          <span class="muted small">Ruin at a drawdown of (%)</span>
          <input
            class="field-input num"
            type="number"
            min="1"
            max="100"
            step="1"
            [value]="params().ruinDrawdownPct"
            (change)="setParam('ruinDrawdownPct', $any($event.target).value)"
          />
        </label>
        <label>
          <span class="muted small">Paths</span>
          <select class="field-input" (change)="setParam('iterations', $any($event.target).value)">
            @for (n of iterationChoices; track n) {
              <option [value]="n" [selected]="n === params().iterations">{{ n }}</option>
            }
          </select>
        </label>
        <button type="button" class="btn btn-primary btn-sm" [disabled]="loading()" (click)="run()">
          @if (loading()) {
            <span class="spinner" aria-hidden="true"></span>
          }
          Simulate
        </button>
      </div>
      @if (error(); as e) {
        <p class="error-box" role="alert">{{ e }}</p>
      } @else if (dto(); as d) {
        <div class="chips">
          <span
            class="chip"
            [class.chip-error]="d.result.riskOfRuin > 0"
            [class.chip-ok]="d.result.riskOfRuin === 0"
            data-testid="mc-ruin"
            >Risk of ruin {{ pct(d.result.riskOfRuin) }}</span
          >
          <span class="chip">Ends down in {{ pct(d.result.probabilityOfLoss) }} of paths</span>
          <span class="chip"
            >Still under water at the end in {{ pct(d.result.unrecoveredShare) }}</span
          >
        </div>
        <div class="table-wrap">
          <table data-testid="mc-table">
            <thead>
              <tr>
                <th scope="col">Measure</th>
                <th scope="col" class="num">P5</th>
                <th scope="col" class="num">P50</th>
                <th scope="col" class="num">P95</th>
                <th scope="col"></th>
              </tr>
            </thead>
            <tbody>
              @for (row of rows(); track row.label + row.unit) {
                <tr>
                  <th scope="row">{{ row.label }}</th>
                  @if (row.p; as p) {
                    <td class="num">{{ value(p.p5, row.unit) }}</td>
                    <td class="num strong">{{ value(p.p50, row.unit) }}</td>
                    <td class="num">{{ value(p.p95, row.unit) }}</td>
                  } @else {
                    <td class="num muted" colspan="3">not measurable</td>
                  }
                  <td class="muted small">{{ row.note }}</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
        <p class="muted small">
          {{ d.result.trades }} trades with a stop (of {{ d.tradesInSource }}), mean
          {{ num(d.result.meanR) }} R, total {{ num(d.result.totalR) }} R{{
            d.result.years ? ' over ' + num(d.result.years) + ' years' : ''
          }}; {{ d.result.iterations }} paths in blocks of {{ d.result.blockSize }} trades (losing
          streaks stay together), at {{ d.result.riskPerTradePct }} % of equity risked per trade;
          ruin = a {{ d.result.ruinDrawdownPct }} % drawdown.
          @if (d.firstTradeUtc && d.lastTradeUtc) {
            Trades {{ day(d.firstTradeUtc) }} to {{ day(d.lastTradeUtc) }}.
          }
        </p>
        @for (n of d.notes; track n) {
          <p class="muted small">{{ n }}</p>
        }
      } @else if (loading()) {
        <p class="muted">Simulating…</p>
      }
    </section>
  `,
  styles: [
    SCRIPTING_UI_STYLES,
    `
      :host {
        display: block;
      }
      .card {
        padding: var(--space-4) var(--space-5);
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .head {
        display: flex;
        align-items: baseline;
        gap: 8px;
      }
      .title {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .params {
        display: flex;
        flex-wrap: wrap;
        align-items: flex-end;
        gap: 12px;
      }
      .params label {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .num {
        width: 90px;
      }
      .chips {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      .table-wrap {
        overflow-x: auto;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-sm);
      }
      th,
      td {
        padding: 5px 8px;
        border-bottom: 1px solid var(--border);
        text-align: left;
        font-weight: normal;
      }
      thead th {
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      td.num,
      th.num {
        width: auto;
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .strong {
        font-weight: var(--font-semibold);
      }
      p {
        margin: 0;
      }
    `,
  ],
})
export class MonteCarloPanelComponent {
  private readonly api = inject(ResearchApiService);

  readonly source = input.required<{ kind: 'backtest' | 'walk-forward'; id: number }>();

  readonly iterationChoices = [500, 1000, 2000, 5000, 10000];
  readonly params = signal<MonteCarloParams>({ ...DEFAULT_MC_PARAMS });
  readonly dto = signal<MonteCarloDto | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  readonly rows = computed(() => {
    const d = this.dto();
    return d ? monteCarloRows(d) : [];
  });
  readonly sourceLabel = computed(() =>
    this.source().kind === 'walk-forward'
      ? `the walk-forward's stitched out-of-sample trades (run #${this.source().id})`
      : `backtest #${this.source().id}`,
  );

  constructor() {
    effect(() => {
      this.source();
      untracked(() => {
        this.dto.set(null);
        void this.run();
      });
    });
  }

  setParam(key: keyof MonteCarloParams, raw: string): void {
    const v = Number(raw);
    if (!Number.isFinite(v)) return;
    const clamp: Record<keyof MonteCarloParams, [number, number]> = {
      iterations: [100, 20000],
      riskPerTradePct: [0.01, 10],
      ruinDrawdownPct: [1, 100],
    };
    const [lo, hi] = clamp[key];
    this.params.update((p) => ({ ...p, [key]: Math.min(hi, Math.max(lo, v)) }));
  }

  async run(): Promise<void> {
    const source = this.source();
    this.loading.set(true);
    this.error.set(null);
    try {
      const res = await firstValueFrom(this.api.monteCarlo(source, this.params()));
      if (source !== this.source()) return;
      if (!res?.status || !res.data) throw res;
      this.dto.set(res.data);
    } catch (err) {
      this.dto.set(null);
      this.error.set(describeFailure(err, 'The Monte Carlo could not be run.'));
    } finally {
      this.loading.set(false);
    }
  }

  value(v: number, unit: McRow['unit']): string {
    return mcValue(v, unit);
  }
  pct(v: number): string {
    return formatPercent(v * 100, { decimals: v > 0 && v < 0.01 ? 2 : 1 });
  }
  num(v: number | null): string {
    return formatNumber(v, 2);
  }
  day(iso: string): string {
    return formatDate(Date.parse(iso));
  }
}
