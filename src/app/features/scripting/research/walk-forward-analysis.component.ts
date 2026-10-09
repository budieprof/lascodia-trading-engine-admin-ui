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

import { ThemeService } from '@core/theme/theme.service';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';

import { SCRIPTING_UI_STYLES } from '../components/scripting-ui.styles';
import { reportPalette } from '../report/report-charts';
import {
  formatDate,
  formatDateTime,
  formatMoney,
  formatNumber,
  formatPercent,
  formatRatio,
} from '../report/report-format';
import { describeFailure } from '../shared/api-error';
import { MonteCarloPanelComponent } from './monte-carlo-panel.component';
import { valueText } from './parameter-space.model';
import { ResearchApiService, type WalkForwardRun } from './research-api.service';
import { isOosScatterOptions, stitchedEquityOptions } from './research-charts';
import { holdoutText } from './research-runs.model';
import type { WalkForwardAnalysisDto, WalkForwardFoldDto } from './research.types';

/** The candidate-document marker the engine stores with a script's inputs (not a parameter). */
const SPACE_MARKER = '__ScriptInputs';

/**
 * BT-I5 — a completed walk-forward analysed by the engine (`GET walk-forward/{id}/analysis`): the out-of-sample folds
 * stitched into one equity curve (money or R) with their trades, each fold's windows, inputs and in- vs out-of-sample
 * results, walk-forward efficiency, how the re-optimised inputs drifted fold to fold, the locked terminal holdout, and
 * the Monte Carlo of the stitched trades.
 */
@Component({
  selector: 'app-walk-forward-analysis',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ChartCardComponent, MonteCarloPanelComponent],
  template: `
    <div class="stack" data-testid="walk-forward-analysis">
      @if (error(); as e) {
        <p class="error-box" role="alert">{{ e }}</p>
      }
      @if (run(); as r) {
        @if (r.status !== 'Completed') {
          <section class="card">
            <p class="muted">
              Run #{{ r.id }} is {{ r.status.toLowerCase() }}.
              {{
                r.status === 'Failed'
                  ? (r.errorMessage ?? '')
                  : 'The analysis appears when it completes.'
              }}
            </p>
          </section>
        }
      }
      @if (dto(); as d) {
        <section class="card" aria-labelledby="wfa-title">
          <header class="head">
            <h3 id="wfa-title" class="title">
              Walk-forward #{{ d.runId }} — out of sample, stitched
            </h3>
            <span class="chip">{{ d.windowMode }}</span>
            <span class="chip" [class.chip-accent]="d.reOptimizePerFold">
              {{ d.reOptimizePerFold ? 're-optimised per fold' : 'fixed inputs' }}
            </span>
            <span class="muted small">{{ day(d.fromDate) }} → {{ day(d.toDate) }}</span>
          </header>
          <div class="figures" data-testid="wfa-figures">
            <div class="figure">
              <span class="value">{{ money(d.stitched.netProfit) }}</span
              ><span class="muted small">net, {{ d.stitched.totalTrades }} trades</span>
            </div>
            <div class="figure">
              <span class="value">{{ r3(d.stitched.expectancyR) }} R</span
              ><span class="muted small">per trade ({{ d.stitched.rTrades }} with a stop)</span>
            </div>
            <div class="figure">
              <span class="value">{{ r2(d.stitched.totalR) }} R</span
              ><span class="muted small">total</span>
            </div>
            <div class="figure">
              <span class="value">{{ pct(d.stitched.maxDrawdownPct) }}</span
              ><span class="muted small">max drawdown</span>
            </div>
            <div class="figure">
              <span class="value">{{ pct(d.stitched.winRate * 100) }}</span
              ><span class="muted small">win rate</span>
            </div>
            <div class="figure">
              <span class="value">{{ ratio(d.stitched.profitFactor) }}</span
              ><span class="muted small">profit factor</span>
            </div>
            <div class="figure">
              <span class="value">{{ pct(d.stitched.annualisedReturnPct) }}</span
              ><span class="muted small"
                >a year, over {{ num0(d.stitched.outOfSampleDays) }} OOS days</span
              >
            </div>
          </div>
          <div class="toggle" role="radiogroup" aria-label="Curve">
            <label
              ><input
                type="radio"
                name="wfa-mode"
                [checked]="mode() === 'money'"
                (change)="mode.set('money')"
              />
              Equity</label
            >
            <label
              ><input
                type="radio"
                name="wfa-mode"
                [checked]="mode() === 'r'"
                (change)="mode.set('r')"
              />
              Cumulative R</label
            >
          </div>
          <app-chart-card
            [title]="mode() === 'r' ? 'Cumulative R, out of sample' : 'Equity, out of sample'"
            subtitle="The out-of-sample folds in time order, trade by trade; shaded bands tell the folds apart"
            [options]="equity() ?? {}"
            [emptyMessage]="equity() ? null : 'Fewer than two points to draw'"
            height="330px"
          />
        </section>

        <section class="card" aria-labelledby="wfe-title">
          <header class="head">
            <h3 id="wfe-title" class="title">Efficiency and the holdout</h3>
          </header>
          <div class="figures">
            <div class="figure">
              <span class="value" data-testid="wfa-efficiency">{{
                pct0(d.efficiency.walkForwardEfficiency)
              }}</span>
              <span class="muted small"
                >walk-forward efficiency — out-of-sample profit a day ÷ in-sample</span
              >
            </div>
            <div class="figure">
              <span class="value">{{ pct0(d.efficiency.sharpeEfficiency) }}</span>
              <span class="muted small">Sharpe efficiency — mean OOS ÷ mean IS Sharpe</span>
            </div>
            <div class="figure">
              <span class="value">{{ d.efficiency.foldsCompared }}</span>
              <span class="muted small">fitted folds compared</span>
            </div>
          </div>
          @if (d.efficiency.note) {
            <p class="muted small">{{ d.efficiency.note }}</p>
          }
          @if (run(); as r) {
            <p class="small" data-testid="wfa-holdout">
              <span class="strong">Holdout:</span> {{ holdout(r) }}
            </p>
          }
        </section>

        @if (foldPoints().length > 0) {
          <app-chart-card
            title="In-sample vs out-of-sample Sharpe, per fold"
            subtitle="Each dot is one re-optimised fold: its search winner in sample, then the next window it never saw"
            [options]="foldScatter() ?? {}"
            [emptyMessage]="foldScatter() ? null : 'No fitted fold'"
            height="280px"
          />
        }

        <section class="card" aria-labelledby="wff-title">
          <header class="head"><h3 id="wff-title" class="title">Folds</h3></header>
          <div class="table-wrap">
            <table data-testid="wfa-folds">
              <thead>
                <tr>
                  <th scope="col">Fold</th>
                  <th scope="col">Out of sample</th>
                  <th scope="col">Inputs</th>
                  <th scope="col" class="num">OOS Sharpe</th>
                  <th scope="col" class="num">OOS R / trade</th>
                  <th scope="col" class="num">OOS trades</th>
                  <th scope="col" class="num">OOS net</th>
                  <th scope="col" class="num">OOS DD</th>
                  <th scope="col" class="num">IS Sharpe</th>
                  <th scope="col" class="num">IS trades</th>
                  <th scope="col" class="num">Efficiency</th>
                </tr>
              </thead>
              <tbody>
                @for (f of d.folds; track f.windowIndex) {
                  <tr>
                    <td>
                      {{ f.windowIndex + 1 }}
                      @if (f.reOptimized) {
                        <span class="chip chip-accent">fitted</span>
                      }
                    </td>
                    <td class="small">
                      {{ day(f.outOfSampleFrom) }} → {{ day(f.outOfSampleTo)
                      }}<span class="muted block">in sample from {{ day(f.inSampleFrom) }}</span>
                    </td>
                    <td class="mono small">{{ inputs(f) }}</td>
                    <td class="num">{{ ratio(f.oosSharpe) }}</td>
                    <td class="num">{{ r3(f.oosExpectancyR) }}</td>
                    <td class="num">{{ f.oosTrades }}</td>
                    <td class="num">{{ money(f.oosNetProfit) }}</td>
                    <td class="num">{{ pct(f.oosMaxDrawdownPct) }}</td>
                    <td class="num">{{ ratio(f.isSharpe) }}</td>
                    <td class="num">{{ f.isTrades ?? '—' }}</td>
                    <td class="num">{{ pct0(f.efficiency) }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </section>

        @if (d.parameterDrift.length > 0) {
          <section class="card" aria-labelledby="wfd-title">
            <header class="head">
              <h3 id="wfd-title" class="title">How the inputs drifted fold to fold</h3>
            </header>
            <div class="table-wrap">
              <table data-testid="wfa-drift">
                <thead>
                  <tr>
                    <th scope="col">Input</th>
                    <th scope="col">Per fold</th>
                    <th scope="col" class="num">Median</th>
                    <th scope="col" class="num">Spread</th>
                    <th scope="col" class="num">Mean step</th>
                    <th scope="col" class="num">Changes</th>
                  </tr>
                </thead>
                <tbody>
                  @for (p of d.parameterDrift; track p.id) {
                    <tr>
                      <th scope="row" class="mono">{{ p.id }}</th>
                      <td class="mono small">{{ driftValues(p.values) }}</td>
                      <td class="num">{{ p.numeric ? r3(p.median) : '—' }}</td>
                      <td class="num" [attr.title]="'(max − min) ÷ |median|'">
                        {{ p.numeric ? pct0(p.relativeSpread) : p.distinct + ' values' }}
                      </td>
                      <td class="num" [attr.title]="'mean |fold-to-fold change| ÷ |median|'">
                        {{ p.numeric ? pct0(p.meanRelativeStep) : '—' }}
                      </td>
                      <td class="num">{{ p.changes }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
            <p class="muted small">
              Inputs that jump between folds are being re-fitted to each window's noise; stable ones
              are a sign the search keeps finding the same structure.
            </p>
          </section>
        }

        <details class="card trades">
          <summary>Stitched out-of-sample trades ({{ d.stitched.trades.length }})</summary>
          <div class="table-wrap">
            <table data-testid="wfa-trades">
              <thead>
                <tr>
                  <th scope="col">Fold</th>
                  <th scope="col">Side</th>
                  <th scope="col">Entry (UTC)</th>
                  <th scope="col">Exit (UTC)</th>
                  <th scope="col" class="num">Lots</th>
                  <th scope="col" class="num">P&amp;L</th>
                  <th scope="col" class="num">R</th>
                  <th scope="col">Exit</th>
                </tr>
              </thead>
              <tbody>
                @for (t of d.stitched.trades; track $index) {
                  <tr>
                    <td>{{ t.fold + 1 }}</td>
                    <td>{{ t.direction }}</td>
                    <td>{{ when(t.entryTime) }}</td>
                    <td>{{ when(t.exitTime) }}</td>
                    <td class="num">{{ r2(t.lotSize) }}</td>
                    <td class="num" [class.pos]="t.pnL > 0" [class.neg]="t.pnL < 0">
                      {{ money(t.pnL) }}
                    </td>
                    <td class="num">{{ r2(t.r) }}</td>
                    <td>{{ t.exitReason }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </details>

        @for (n of d.notes; track n) {
          <p class="muted small">{{ n }}</p>
        }

        <app-monte-carlo-panel [source]="mcSource()" />
      } @else if (loading()) {
        <p class="muted">Analysing walk-forward #{{ runId() }}…</p>
      }
    </div>
  `,
  styles: [
    SCRIPTING_UI_STYLES,
    `
      :host {
        display: block;
      }
      .stack {
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
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
        align-items: center;
        flex-wrap: wrap;
        gap: 8px;
      }
      .title {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .figures {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-5);
      }
      .figure {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 110px;
      }
      .value {
        font-size: var(--text-lg, 17px);
        font-weight: var(--font-semibold);
        font-variant-numeric: tabular-nums;
      }
      .toggle {
        display: flex;
        gap: 12px;
        font-size: var(--text-sm);
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
        vertical-align: top;
      }
      thead th {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        white-space: nowrap;
      }
      .num {
        text-align: right;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }
      .block {
        display: block;
      }
      .strong {
        font-weight: var(--font-semibold);
      }
      .pos {
        color: var(--profit, #1f8a3b);
      }
      .neg {
        color: var(--loss);
      }
      .trades summary {
        cursor: pointer;
        font-weight: var(--font-medium);
      }
      p {
        margin: 0;
      }
    `,
  ],
})
export class WalkForwardAnalysisComponent {
  private readonly api = inject(ResearchApiService);
  private readonly theme = inject(ThemeService);

  readonly runId = input.required<number>();

  readonly run = signal<WalkForwardRun | null>(null);
  readonly dto = signal<WalkForwardAnalysisDto | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly mode = signal<'money' | 'r'>('money');

  readonly equity = computed(() => {
    const d = this.dto();
    return d
      ? stitchedEquityOptions(d.stitched.equity, reportPalette(this.theme.theme()), this.mode())
      : null;
  });
  readonly foldPoints = computed(() =>
    (this.dto()?.folds ?? [])
      .filter((f) => f.reOptimized && f.isSharpe !== null)
      .map((f) => ({
        inSample: f.isSharpe!,
        outOfSample: f.oosSharpe,
        label: `Fold ${f.windowIndex + 1}`,
      })),
  );
  readonly foldScatter = computed(() =>
    isOosScatterOptions(this.foldPoints(), reportPalette(this.theme.theme()), {
      x: 'In-sample Sharpe (fold search winner)',
      y: 'Out-of-sample Sharpe',
    }),
  );
  readonly mcSource = computed(() => ({ kind: 'walk-forward' as const, id: this.runId() }));

  constructor() {
    effect(() => {
      const id = this.runId();
      untracked(() => {
        this.run.set(null);
        this.dto.set(null);
        void this.load(id);
      });
    });
  }

  async load(id: number): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const runRes = await firstValueFrom(this.api.walkForwardRun(id));
      if (id !== this.runId()) return;
      if (!runRes?.status || !runRes.data) throw runRes;
      this.run.set(runRes.data);
      if (runRes.data.status !== 'Completed') return;
      const res = await firstValueFrom(this.api.walkForwardAnalysis(id));
      if (id !== this.runId()) return;
      if (!res?.status || !res.data) throw res;
      this.dto.set(res.data);
    } catch (err) {
      this.error.set(describeFailure(err, `Walk-forward #${id} could not be analysed.`));
    } finally {
      this.loading.set(false);
    }
  }

  holdout(r: WalkForwardRun): string {
    return holdoutText(r);
  }

  inputs(f: WalkForwardFoldDto): string {
    const p = f.parameters;
    if (!p) return f.reOptimized ? '—' : 'current inputs';
    return Object.entries(p)
      .filter(([k]) => k !== SPACE_MARKER)
      .map(([k, v]) => `${k}=${valueText(v)}`)
      .join(', ');
  }

  driftValues(values: unknown[]): string {
    return values.map((v) => valueText(v)).join(' → ');
  }

  day(iso: string): string {
    return formatDate(Date.parse(iso));
  }
  when(iso: string): string {
    return formatDateTime(Date.parse(iso));
  }
  money(v: number | null | undefined): string {
    return formatMoney(v ?? null, '');
  }
  pct(v: number | null | undefined): string {
    return formatPercent(v ?? null, { decimals: 1 });
  }
  pct0(v: number | null | undefined): string {
    return v === null || v === undefined ? '—' : formatPercent(v * 100, { decimals: 0 });
  }
  ratio(v: number | null | undefined): string {
    return formatRatio(v ?? null, 2);
  }
  r2(v: number | null | undefined): string {
    return formatNumber(v ?? null, 2);
  }
  r3(v: number | null | undefined): string {
    return formatNumber(v ?? null, 3);
  }
  num0(v: number | null | undefined): string {
    return formatNumber(v ?? null, 0);
  }
}
