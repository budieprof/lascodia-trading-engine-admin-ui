import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import type { StrategyTrialLedgerDto } from '@core/api/scripting.types';
import { ScriptingService } from '@core/services/scripting.service';

import type { EngineRun } from './engine-run';
import { MONTE_CARLO_DEFAULTS, monteCarloR } from './monte-carlo';
import {
  R_BASIS_TEXT,
  bootstrapMeanInterval,
  deflatedSharpe,
  rHistogram,
  rSampleFromEngineTrades,
  rSampleFromReport,
  summarizeR,
  type RSample,
} from './r-analysis';
import {
  MINUS,
  NA,
  formatInteger,
  formatMoney,
  formatNumber,
  formatPercent,
} from './report-format';
import type { Num, StrategyReport } from './strategy-report.model';

/** A count of tests the host knows about when there is no trial ledger (the editor's previews). */
export interface ReportTestCount {
  count: number;
  /** What was counted, e.g. "variants previewed in this editor session". */
  label: string;
}

interface CostRow {
  label: string;
  total: Num;
  note?: string;
}

/** Fewer trades than this and every figure is flagged as a rough guide. */
const SMALL_SAMPLE = 30;
const RISK_CHOICES = [0.25, 0.5, 1, 2, 3] as const;

/**
 * Resamples for the interval and the Monte Carlo: 2000, fewer for very long trade lists so the
 * tab stays responsive (each resample walks every trade) — never below 200.
 */
export function resampleCount(trades: number): number {
  return Math.min(2000, Math.max(200, Math.floor(4_000_000 / Math.max(1, trades))));
}

/**
 * The Strategy report's "R analysis" tab (PE-I1, PE-I8): every closed trade in units of what it
 * risked at its entry stop — expectancy with a bootstrap interval, the distribution, how many
 * configurations were tried and the deflated Sharpe the promotion gate computes, the cost totals,
 * and a Monte Carlo of the same trades in other orders. Everything hides gracefully: a run whose
 * trades carry no stop explains why there is no R.
 */
@Component({
  selector: 'app-report-r-analysis',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="r-analysis">
      @if (summary(); as s) {
        <p class="basis">
          Measured on <strong>{{ int(s.n) }}</strong> of {{ int(sample().closed) }} closed trades:
          {{ basisText() }}.
          @if (s.n < smallSample) {
            <strong
              >Fewer than {{ smallSample }} trades — read every figure as a rough guide.</strong
            >
          }
        </p>

        <div class="tiles">
          <div class="tile" data-testid="r-expectancy">
            <span class="tile-label">Expectancy</span>
            <span class="tile-value" [class.neg]="s.mean < 0">{{ r(s.mean) }}</span>
            @if (interval(); as ci) {
              <span class="tile-sub"
                >{{ pct(ci.level * 100, 0) }} interval {{ r(ci.low) }} to {{ r(ci.high) }}</span
              >
            }
          </div>
          <div class="tile">
            <span class="tile-label">Median trade</span>
            <span class="tile-value" [class.neg]="s.median < 0">{{ r(s.median) }}</span>
            <span class="tile-sub">best {{ r(s.best) }} · worst {{ r(s.worst) }}</span>
          </div>
          <div class="tile">
            <span class="tile-label">Won (above 0R)</span>
            <span class="tile-value">{{ pct(s.winRate * 100, 1) }}</span>
            <span class="tile-sub"
              >average win {{ r(s.avgWin) }} · average loss {{ r(s.avgLoss) }}</span
            >
          </div>
          <div class="tile">
            <span class="tile-label">SQN</span>
            <span class="tile-value">{{ num(s.sqn) }}</span>
            <span class="tile-sub">t-statistic {{ num(s.tStat) }} · total {{ r(s.sumR) }}</span>
          </div>
          <div class="tile" data-testid="r-tests">
            <span class="tile-label">Tests counted</span>
            <span class="tile-value">{{ trials() === null ? NA : int(trials()) }}</span>
            <span class="tile-sub">{{ trialsSource() }}</span>
          </div>
          <div class="tile" data-testid="r-dsr">
            <span class="tile-label">Deflated Sharpe</span>
            <span class="tile-value" [class.neg]="(dsr() ?? 0) < 0">{{ num(dsr()) }}</span>
            <span class="tile-sub">{{ dsrNote() }}</span>
          </div>
        </div>

        <p class="verdict" data-testid="r-verdict">{{ verdict() }}</p>

        <h4 class="section-title">Distribution</h4>
        <div class="hist" role="img" [attr.aria-label]="histogramLabel()">
          @for (b of bins(); track b.label) {
            <div class="hist-col" [title]="b.label + ': ' + b.count + ' trade(s)'">
              <span class="hist-count">{{ b.count || '' }}</span>
              <div class="hist-track">
                <div
                  class="hist-bar"
                  [class.losing]="b.losing"
                  [style.height.%]="barHeight(b.count)"
                ></div>
              </div>
              <span class="hist-label">{{ b.label }}</span>
            </div>
          }
        </div>
      } @else {
        <p class="empty" data-testid="r-empty">
          No closed trade carries the stop it opened with, so its R — the result in units of what it
          risked — cannot be measured. Give every entry a stop (<code
            >strategy.exit(…, stop = …)</code
          >) to see the R analysis and the Monte Carlo.
        </p>
      }

      @if (costRows().length > 0) {
        <h4 class="section-title">Costs</h4>
        <table class="costs" data-testid="r-costs">
          <caption class="sr-only">
            Execution costs over the run
          </caption>
          <thead>
            <tr>
              <th scope="col">Cost</th>
              <th scope="col" class="num">Total</th>
              <th scope="col" class="num">Per trade</th>
            </tr>
          </thead>
          <tbody>
            @for (c of costRows(); track c.label) {
              <tr>
                <th scope="row">
                  {{ c.label }}
                  @if (c.note) {
                    <span class="muted">({{ c.note }})</span>
                  }
                </th>
                <td class="num">{{ money(c.total) }}</td>
                <td class="num">{{ money(perTrade(c.total)) }}</td>
              </tr>
            }
          </tbody>
        </table>
        @if (costNote(); as note) {
          <p class="muted small">{{ note }}</p>
        }
      }

      @if (monteCarlo(); as mc) {
        <h4 class="section-title">Monte Carlo</h4>
        <div class="mc-controls">
          <label>
            <span class="muted small">Risk per trade</span>
            <select
              class="field-input"
              [value]="riskPct()"
              (change)="riskPct.set(+$any($event.target).value)"
            >
              @for (c of riskChoices; track c) {
                <option [value]="c" [selected]="c === riskPct()">{{ c }}% of equity</option>
              }
            </select>
          </label>
          <span class="muted small">
            {{ int(mc.runs) }} reorderings of the {{ int(mc.trades) }} trades
            {{
              mc.blockSize > 1
                ? 'in blocks of ' + mc.blockSize + ' (streaks kept)'
                : 'one by one (too few for blocks)'
            }}; ruin = a {{ mc.ruinDrawdownPct }}% drawdown.
          </span>
        </div>
        <table class="mc" data-testid="r-monte-carlo">
          <caption class="sr-only">
            Monte Carlo percentiles
          </caption>
          <thead>
            <tr>
              <th scope="col"></th>
              <th scope="col" class="num">This run</th>
              <th scope="col" class="num">Typical (median)</th>
              <th scope="col" class="num">Bad (1 in 20)</th>
              <th scope="col" class="num">Good (1 in 20)</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">Deepest drawdown</th>
              <td class="num">{{ pct(mc.observed.maxDrawdownPct, 1) }}</td>
              <td class="num">{{ pct(mc.maxDrawdownPct.p50, 1) }}</td>
              <td class="num">{{ pct(mc.maxDrawdownPct.p95, 1) }}</td>
              <td class="num">{{ pct(mc.maxDrawdownPct.p5, 1) }}</td>
            </tr>
            <tr>
              <th scope="row">Return</th>
              <td class="num">{{ signedPct(mc.observed.finalReturnPct) }}</td>
              <td class="num">{{ signedPct(mc.finalReturnPct.p50) }}</td>
              <td class="num">{{ signedPct(mc.finalReturnPct.p5) }}</td>
              <td class="num">{{ signedPct(mc.finalReturnPct.p95) }}</td>
            </tr>
            <tr>
              <th scope="row">Longest losing streak</th>
              <td class="num">{{ int(mc.observed.longestLosingStreak) }}</td>
              <td class="num">{{ int(mc.longestLosingStreak.p50) }}</td>
              <td class="num">{{ int(mc.longestLosingStreak.p95) }}</td>
              <td class="num">{{ int(mc.longestLosingStreak.p5) }}</td>
            </tr>
          </tbody>
        </table>
        <p class="ruin" [attr.data-tone]="ruinTone()" data-testid="r-ruin">
          Risk of ruin: <strong>{{ pct(mc.riskOfRuin * 100, 1) }}</strong> of the reorderings fell
          {{ mc.ruinDrawdownPct }}% or more below their peak at {{ mc.riskPct }}% risk per trade.
        </p>
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .r-analysis {
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .basis,
      .verdict,
      .empty,
      .ruin {
        margin: 0;
        font-size: var(--text-sm);
        line-height: 1.5;
        color: var(--text-primary);
      }
      .empty {
        padding: var(--space-4);
        border: 1px dashed var(--border);
        border-radius: var(--radius-md);
        color: var(--text-secondary);
      }
      .tiles {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(min(100%, 190px), 1fr));
        gap: var(--space-2);
      }
      .tile {
        display: flex;
        flex-direction: column;
        gap: 2px;
        padding: var(--space-3);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
      }
      .tile-label {
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .tile-value {
        font-size: var(--text-lg);
        font-weight: var(--font-semibold);
        font-variant-numeric: tabular-nums;
      }
      .tile-value.neg {
        color: var(--loss);
      }
      .tile-sub {
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .section-title {
        margin: var(--space-2) 0 0;
        font-size: var(--text-xs);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-secondary);
      }
      .hist {
        display: flex;
        align-items: stretch;
        gap: 2px;
        height: 180px;
        overflow-x: auto;
      }
      .hist-col {
        flex: 1 0 34px;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 2px;
      }
      .hist-count {
        font-size: 10px;
        color: var(--text-secondary);
        min-height: 12px;
      }
      .hist-track {
        flex: 1;
        width: 100%;
        display: flex;
        align-items: flex-end;
      }
      .hist-bar {
        width: 100%;
        min-height: 1px;
        border-radius: 3px 3px 0 0;
        background: var(--accent);
      }
      .hist-bar.losing {
        background: var(--loss);
      }
      .hist-label {
        font-size: 9px;
        color: var(--text-tertiary);
        text-align: center;
        line-height: 1.1;
        min-height: 22px;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-sm);
      }
      th,
      td {
        padding: 4px 8px;
        border-bottom: 1px solid var(--border);
        text-align: left;
        font-weight: normal;
      }
      thead th {
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .mc-controls {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--space-3);
      }
      .mc-controls label {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .ruin[data-tone='warn'] {
        color: var(--loss);
      }
      .muted {
        color: var(--text-secondary);
      }
      .small {
        font-size: var(--text-xs);
      }
      .sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        overflow: hidden;
        clip: rect(0 0 0 0);
        white-space: nowrap;
      }
    `,
  ],
})
export class ReportRAnalysisComponent {
  private readonly scripting = inject(ScriptingService);
  private readonly destroyRef = inject(DestroyRef);

  readonly report = input.required<StrategyReport>();
  /** The engine's stored result for a backtest run: its trade list's R and its cost totals. */
  readonly engine = input<EngineRun | null>(null);
  /** The strategy behind a backtest run: its trial ledger gives the test count. */
  readonly strategyId = input<number | null>(null);
  /** A test count the host keeps when there is no ledger (the editor's previews). */
  readonly testCount = input<ReportTestCount | null>(null);
  readonly currency = input('');

  readonly NA = NA;
  readonly smallSample = SMALL_SAMPLE;
  readonly riskChoices = RISK_CHOICES;
  readonly riskPct = signal<number>(MONTE_CARLO_DEFAULTS.riskPct);

  readonly ledger = signal<StrategyTrialLedgerDto | null>(null);
  readonly ledgerError = signal<string | null>(null);

  /** The engine's own trade list when it has R (costs included), else the report's trades. */
  readonly sample = computed<RSample>(() => {
    const engine = this.engine();
    if (engine && engine.trades.length > 0) {
      const fromEngine = rSampleFromEngineTrades(engine.trades);
      if (fromEngine.values.length > 0) return fromEngine;
    }
    return rSampleFromReport(this.report());
  });
  readonly summary = computed(() => summarizeR(this.sample().values));
  readonly interval = computed(() => {
    const values = this.sample().values;
    return bootstrapMeanInterval(values, { resamples: resampleCount(values.length) });
  });
  readonly bins = computed(() => rHistogram(this.sample().values));
  private readonly maxBin = computed(() => Math.max(1, ...this.bins().map((b) => b.count)));
  readonly basisText = computed(() => {
    const b = this.sample().basis;
    return b ? R_BASIS_TEXT[b] : '';
  });

  readonly trials = computed<number | null>(() => {
    const l = this.ledger();
    if (l) return l.effectiveTrials;
    return this.testCount()?.count ?? null;
  });
  readonly trialsSource = computed(() => {
    const l = this.ledger();
    if (l) {
      return `configurations the strategy's lineage tried (${formatInteger(l.ledgerTrials)} in the ledger, ${formatInteger(l.peerStrategies)} strategies on the pair) — the count the promotion gates use`;
    }
    const t = this.testCount();
    if (t) return t.label;
    if (this.ledgerError()) return `unknown — ${this.ledgerError()}`;
    return this.strategyId() !== null ? 'loading…' : 'unknown for this run';
  });

  readonly dsr = computed<number | null>(() => {
    const s = this.summary();
    const n = this.trials();
    if (!s || s.sharpe === null || n === null || s.n < 2) return null;
    return deflatedSharpe(s.sharpe, n, s.n);
  });
  readonly dsrNote = computed(() => {
    const s = this.summary();
    if (this.dsr() === null) {
      return s?.sharpe === null || (s?.n ?? 0) < 2
        ? 'needs two trades whose R varies'
        : 'needs the test count';
    }
    return `per-trade Sharpe ${formatNumber(s!.sharpe, 3)} against the best of ${formatInteger(Math.max(this.trials()!, 2))} no-edge tries; the promotion gate passes 1.0 by default`;
  });

  readonly verdict = computed(() => {
    const ci = this.interval();
    const s = this.summary();
    if (!s) return '';
    if (!ci) return 'One trade: no interval can be drawn around it.';
    if (ci.low > 0) {
      return 'The whole interval is above 0R: on these trades the expectancy is positive beyond resampling noise. It is one sample — it says nothing about trades the run did not see.';
    }
    if (ci.high < 0) {
      return 'The whole interval is below 0R: these trades lose money on average.';
    }
    return 'The interval includes 0R: these trades do not show an edge distinguishable from none.';
  });

  readonly histogramLabel = computed(
    () =>
      `R distribution: ${this.bins()
        .filter((b) => b.count > 0)
        .map((b) => `${b.count} trade${b.count === 1 ? '' : 's'} ${b.label}`)
        .join(', ')}`,
  );

  /** Cost totals: the report's (C6) when it carries them, else the engine result's. */
  readonly costRows = computed<CostRow[]>(() => {
    const c = this.report().costs;
    if (c) {
      const rows: CostRow[] = [
        { label: 'Commission', total: c.commission },
        { label: 'Spread', total: c.spread },
        { label: 'Slippage', total: c.slippage },
        { label: 'Swap', total: c.swap, note: 'positive = paid' },
      ];
      return rows.filter((r) => r.total !== null);
    }
    const e = this.engine()?.costs;
    if (!e) return [];
    const rows: CostRow[] = [
      { label: 'Commission', total: e.commission },
      { label: 'Spread and slippage', total: e.slippage },
      { label: 'Swap', total: e.swap, note: 'positive = paid' },
    ];
    return rows.filter((r) => r.total !== null);
  });
  readonly costNote = computed(() => {
    const parts: string[] = [];
    const model = this.report().costs?.model || this.engine()?.costs?.model;
    if (model) parts.push(`Cost model: ${model}.`);
    const be = this.engine()?.costs?.breakevenPipsPerTrade;
    if (be !== null && be !== undefined) {
      parts.push(
        be > 0
          ? `About ${formatNumber(be, 1)} more pips of cost per trade would take the net profit to zero.`
          : 'The run already loses before any extra cost.',
      );
    }
    return parts.join(' ');
  });

  readonly monteCarlo = computed(() =>
    monteCarloR(this.sample().values, {
      riskPct: this.riskPct(),
      runs: resampleCount(this.sample().values.length),
    }),
  );
  readonly ruinTone = computed(() => ((this.monteCarlo()?.riskOfRuin ?? 0) > 0.01 ? 'warn' : ''));

  constructor() {
    effect(() => {
      const id = this.strategyId();
      untracked(() => this.loadLedger(id));
    });
  }

  private loadLedger(id: number | null): void {
    this.ledger.set(null);
    this.ledgerError.set(null);
    if (id === null) return;
    this.scripting
      .getTrialLedger(id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (l) => {
          if (id === this.strategyId()) this.ledger.set(l);
        },
        error: (e: { message?: string }) => {
          if (id === this.strategyId())
            this.ledgerError.set(e?.message ?? 'the ledger is unavailable');
        },
      });
  }

  barHeight(count: number): number {
    return (count / this.maxBin()) * 100;
  }

  perTrade(total: Num): Num {
    const n = this.sample().closed;
    return total === null || n === 0 ? null : total / n;
  }

  r(v: number | null | undefined): string {
    if (v === null || v === undefined || !Number.isFinite(v)) return NA;
    const body = Math.abs(v).toFixed(2);
    if (body === '0.00') return '0.00R';
    return `${v < 0 ? MINUS : '+'}${body}R`;
  }

  num(v: number | null | undefined): string {
    return formatNumber(v ?? null, 2);
  }

  int(v: number | null | undefined): string {
    return formatInteger(v ?? null);
  }

  pct(v: number | null | undefined, decimals = 1): string {
    return formatPercent(v ?? null, { decimals });
  }

  signedPct(v: number | null | undefined): string {
    return formatPercent(v ?? null, { decimals: 1, signed: true });
  }

  money(v: Num): string {
    return formatMoney(v, this.currency());
  }
}
