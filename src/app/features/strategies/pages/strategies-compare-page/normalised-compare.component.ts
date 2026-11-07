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
import type { EChartsOption } from 'echarts';

import type { BacktestRunDto, StrategyEquityCurveDto } from '@core/api/api.types';
import { BacktestsService } from '@core/services/backtests.service';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import { parseEngineRun } from '@features/scripting/report/engine-run';

import {
  COMPARE_BASIS_LABELS,
  backtestSteps,
  correlationPairs,
  liveSteps,
  normalise,
  type CompareBasis,
  type NormalisedSeries,
} from './compare-normalise';

const NOT_EVIDENCE = new Set(['Parity', 'LabReproduction']);

interface RunState {
  run: BacktestRunDto | null;
  error: string | null;
}

/**
 * U11 — the compare page on a common footing: R per trade or % of initial capital from each strategy's newest completed
 * backtest (or the live money curves), with each curve's maximum drawdown in the same unit and the correlation of the
 * strategies' daily results. Reads only.
 */
@Component({
  selector: 'app-normalised-compare',
  standalone: true,
  imports: [ChartCardComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="summary-card" data-testid="normalised-compare" aria-labelledby="nc-title">
      <header class="card-head">
        <h3 id="nc-title">Normalised comparison</h3>
        <label class="basis">
          <span class="muted small">Basis</span>
          <select
            class="field-input"
            aria-label="Comparison basis"
            (change)="basis.set($any($event.target).value)"
          >
            @for (b of bases; track b) {
              <option [value]="b" [selected]="b === basis()">{{ labels[b] }}</option>
            }
          </select>
        </label>
      </header>
      @if (basis() !== 'live') {
        <p class="muted small">
          Each strategy's newest completed backtest (parity and lab reproductions excluded). The
          windows can differ — see each row's source; correlation uses only the days they share.
        </p>
      }
      @if (loading()) {
        <p class="muted">Loading backtests…</p>
      } @else {
        <app-chart-card
          [title]="chartTitle()"
          [options]="chart() ?? {}"
          [emptyMessage]="chart() ? null : 'No selected strategy has data on this basis'"
          height="320px"
        />
        <table class="summary">
          <thead>
            <tr>
              <th>Strategy</th>
              <th class="num">Trades</th>
              <th class="num">Total ({{ unit() }})</th>
              <th class="num">Max drawdown ({{ unit() }})</th>
              <th class="num">Total ÷ drawdown</th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody>
            @for (row of rows(); track row.id) {
              <tr>
                <td>{{ row.name }}</td>
                @if (row.series; as s) {
                  <td class="num">{{ s.trades }}</td>
                  <td class="num" [attr.data-sign]="s.total >= 0 ? 'pos' : 'neg'">
                    {{ fmt(s.total) }}
                  </td>
                  <td class="num">{{ fmt(s.maxDrawdown, false) }}</td>
                  <td class="num">
                    {{ s.maxDrawdown > 0 ? (s.total / s.maxDrawdown).toFixed(2) : '—' }}
                  </td>
                  <td class="muted small">{{ s.source }}</td>
                } @else {
                  <td class="muted small" colspan="5">{{ row.note }}</td>
                }
              </tr>
            }
          </tbody>
        </table>
        @if (pairs().length > 0) {
          <h4 class="sub">Correlation of daily results</h4>
          <table class="summary" data-testid="nc-correlation">
            <thead>
              <tr>
                <th>Pair</th>
                <th class="num">ρ</th>
                <th class="num">Shared days</th>
                <th>Reading</th>
              </tr>
            </thead>
            <tbody>
              @for (p of pairs(); track p.a + '-' + p.b) {
                <tr>
                  <td>{{ name(p.a) }} × {{ name(p.b) }}</td>
                  <td class="num">{{ p.rho === null ? '—' : p.rho.toFixed(2) }}</td>
                  <td class="num">{{ p.days || '—' }}</td>
                  <td class="muted small">{{ reading(p.rho, p.days) }}</td>
                </tr>
              }
            </tbody>
          </table>
        }
      }
    </section>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .summary-card {
        padding: var(--space-4);
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .card-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        flex-wrap: wrap;
      }
      .card-head h3,
      .sub {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      .basis {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      table.summary {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-sm);
      }
      .summary th,
      .summary td {
        padding: 6px 8px;
        border-bottom: 1px solid var(--border);
        text-align: left;
      }
      .summary th {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        font-weight: var(--font-medium);
      }
      .num {
        text-align: right !important;
        font-variant-numeric: tabular-nums;
      }
      [data-sign='pos'] {
        color: var(--profit);
      }
      [data-sign='neg'] {
        color: var(--loss);
      }
      .muted {
        color: var(--text-secondary);
      }
      .small {
        font-size: var(--text-xs);
      }
      p {
        margin: 0;
      }
    `,
  ],
})
export class NormalisedCompareComponent {
  private readonly backtests = inject(BacktestsService);

  readonly ids = input.required<readonly number[]>();
  readonly names = input<ReadonlyMap<number, string>>(new Map());
  readonly curves = input<ReadonlyMap<number, StrategyEquityCurveDto>>(new Map());
  readonly colors = input<readonly string[]>(['#0071E3', '#34C759', '#FF9500', '#AF52DE']);

  readonly bases: CompareBasis[] = ['live', 'r', 'pct'];
  readonly labels = COMPARE_BASIS_LABELS;
  readonly basis = signal<CompareBasis>('r');
  readonly runs = signal<ReadonlyMap<number, RunState>>(new Map());
  readonly loading = signal(false);

  readonly unit = computed(() =>
    this.basis() === 'r' ? 'R' : this.basis() === 'pct' ? '%' : 'money',
  );

  readonly series = computed<Map<number, NormalisedSeries | null>>(() => {
    const out = new Map<number, NormalisedSeries | null>();
    const basis = this.basis();
    for (const id of this.ids()) {
      if (basis === 'live') {
        const c = this.curves().get(id);
        out.set(
          id,
          c && c.points.length > 0
            ? normalise(
                id,
                liveSteps(c.points),
                `${c.pointCount} closed positions (newest 5,000 max)`,
              )
            : null,
        );
        continue;
      }
      const run = this.runs().get(id)?.run;
      if (!run) {
        out.set(id, null);
        continue;
      }
      const trades = parseEngineRun(run.resultJson)?.trades ?? [];
      const { steps, considered } = backtestSteps(trades, basis, run.initialBalance);
      const window = `${run.fromDate.slice(0, 10)} → ${run.toDate.slice(0, 10)}`;
      const of = basis === 'r' ? `, ${steps.length} of ${considered} trades with R` : '';
      out.set(
        id,
        steps.length > 0 ? normalise(id, steps, `backtest #${run.id} (${window})${of}`) : null,
      );
    }
    return out;
  });

  readonly rows = computed(() =>
    this.ids().map((id) => {
      const s = this.series().get(id) ?? null;
      const state = this.runs().get(id);
      const note =
        this.basis() === 'live'
          ? 'No closed live position.'
          : (state?.error ??
            (state?.run
              ? this.basis() === 'r'
                ? `Backtest #${state.run.id} has no trade with a stop (no R).`
                : `Backtest #${state.run.id} has no trades.`
              : 'No completed backtest.'));
      return { id, name: this.name(id), series: s, note };
    }),
  );

  readonly pairs = computed(() =>
    correlationPairs([...this.series().values()].filter((s): s is NormalisedSeries => !!s)),
  );

  readonly chartTitle = computed(
    () => `Cumulative ${this.unit() === 'money' ? 'P&L' : this.unit()}`,
  );

  readonly chart = computed<EChartsOption | null>(() => {
    const ids = this.ids();
    const list = ids
      .map((id, i) => ({ id, i, s: this.series().get(id) }))
      .filter((x) => x.s && x.s.curve.length > 0);
    if (list.length === 0) return null;
    const colors = this.colors();
    return {
      animation: false,
      grid: { left: 64, right: 24, top: 40, bottom: 40 },
      tooltip: { trigger: 'axis' },
      legend: { data: list.map((x) => this.name(x.id)) },
      xAxis: { type: 'time' },
      yAxis: { type: 'value', name: `Cumulative ${this.unit()}` },
      series: list.map((x) => ({
        name: this.name(x.id),
        type: 'line',
        step: 'end',
        showSymbol: false,
        lineStyle: { color: colors[x.i % colors.length], width: 2 },
        itemStyle: { color: colors[x.i % colors.length] },
        data: x.s!.curve,
      })),
    } as EChartsOption;
  });

  constructor() {
    effect(() => {
      const basis = this.basis();
      const ids = this.ids();
      if (basis === 'live') return;
      untracked(() => void this.loadRuns(ids));
    });
  }

  private async loadRuns(ids: readonly number[]): Promise<void> {
    const missing = ids.filter((id) => !this.runs().has(id));
    if (missing.length === 0) return;
    this.loading.set(true);
    const results = await Promise.all(
      missing.map(async (id): Promise<[number, RunState]> => {
        try {
          const res = await firstValueFrom(
            this.backtests.list({
              currentPage: 1,
              itemCountPerPage: 5,
              filter: { strategyId: id, status: 'Completed', includeResultJson: true },
              sortBy: 'id',
              sortDirection: 'desc',
            }),
          );
          const run =
            (res?.data?.data ?? []).find((r) => !NOT_EVIDENCE.has(String(r.queueSource ?? ''))) ??
            null;
          return [id, { run, error: null }];
        } catch {
          return [id, { run: null, error: 'The backtests could not be read.' }];
        }
      }),
    );
    const next = new Map(this.runs());
    for (const [id, state] of results) next.set(id, state);
    this.runs.set(next);
    this.loading.set(false);
  }

  name(id: number): string {
    return this.names().get(id) ?? `#${id}`;
  }

  fmt(v: number, signed = true): string {
    const unit = this.unit();
    const body = Math.abs(v).toFixed(2);
    const sign = signed && v > 0 ? '+' : v < 0 && signed ? '−' : '';
    return unit === 'R' ? `${sign}${body} R` : unit === '%' ? `${sign}${body} %` : `${sign}${body}`;
  }

  reading(rho: number | null, days: number): string {
    if (rho === null) return days > 0 ? 'no variation' : 'fewer than 10 shared days';
    const a = Math.abs(rho);
    const strength =
      a >= 0.7 ? 'strongly' : a >= 0.4 ? 'moderately' : a >= 0.2 ? 'weakly' : 'barely';
    return `${strength} ${rho >= 0 ? 'together' : 'opposed'} — ${a >= 0.7 ? 'little diversification' : a < 0.2 ? 'diversifying' : 'some overlap'}`;
  }
}
