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
import { formatNumber, formatRatio } from '../report/report-format';
import { describeFailure } from '../shared/api-error';
import { valueText } from './parameter-space.model';
import { ParameterHeatmapComponent } from './parameter-heatmap.component';
import { ResearchApiService } from './research-api.service';
import { isOosScatterOptions, logitHistogramOptions } from './research-charts';
import { evidenceRows } from './research-runs.model';
import type { OptimizationCandidateDto, OptimizationCandidatesDto } from './research.types';

export const CANDIDATE_SORTS = [
  { id: 'healthScore', label: 'Health score' },
  { id: 'expectancyR', label: 'Expectancy (R)' },
  { id: 'sharpeR', label: 'Sharpe in R' },
  { id: 'trades', label: 'Trades' },
] as const;

/** The candidate-document marker the engine stores with a script's inputs (not a parameter). */
const SPACE_MARKER = '__ScriptInputs';

/**
 * One optimization run opened (PE-I4, BT-I4, BT-I7): the engine's overfitting evidence (deflated Sharpe, PBO by CSCV,
 * the IS vs OOS degradation and its warnings — never a client-side guess), every candidate it tried with its per-fold
 * R, and the expectancy heatmap with its plateau readout.
 */
@Component({
  selector: 'app-optimization-run-detail',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ChartCardComponent, ParameterHeatmapComponent],
  template: `
    <div class="stack" data-testid="optimization-run-detail">
      @if (error(); as e) {
        <p class="error-box" role="alert">{{ e }}</p>
      } @else if (!dto()) {
        <p class="muted">{{ loading() ? 'Loading run #' + runId() + '…' : '' }}</p>
      }
      @if (dto(); as d) {
        <section class="card" aria-labelledby="ev-title">
          <header class="head">
            <h3 id="ev-title" class="title">
              Run #{{ d.optimizationRunId }} — overfitting evidence
            </h3>
            <span class="chip">ranked by {{ d.objective }}</span>
            <span class="chip">{{ d.candidates }} candidates</span>
          </header>
          @if (d.selection.warnings.length > 0) {
            <ul class="warnings" role="alert" data-testid="overfit-warnings">
              @for (w of d.selection.warnings; track w) {
                <li>{{ w }}</li>
              }
            </ul>
          } @else if (d.candidates > 0) {
            <p class="ok small" data-testid="overfit-clear">
              The engine raises no overfitting warning for this run's selection.
            </p>
          }
          <table class="evidence">
            <tbody>
              @for (row of evidence(); track row.label) {
                <tr>
                  <th scope="row">{{ row.label }}</th>
                  <td class="num">
                    <span
                      class="chip"
                      [class.chip-ok]="row.ok === true"
                      [class.chip-error]="row.ok === false"
                      >{{ row.value }}</span
                    >
                  </td>
                  <td class="muted small">{{ row.note }}</td>
                </tr>
              }
            </tbody>
          </table>
          @if (d.selection.selectedParametersJson) {
            <p class="muted small">
              Measured on
              {{
                d.selection.selectedIsWinner
                  ? "the run's chosen parameters"
                  : 'the candidate with the best Sharpe in R'
              }}:
              <span class="mono">{{ d.selection.selectedParametersJson }}</span>
              — Sharpe in R {{ ratio(d.selection.selectedSharpeR) }} over
              {{ d.selection.selectedRTrades }} trades with a stop.
            </p>
          }
          @if (d.validation; as v) {
            <p class="small" data-testid="run-validation">
              Out-of-sample check of the winner: health {{ ratio(v.inSampleHealthScore) }} in sample
              → {{ ratio(v.outOfSampleHealthScore) }} out of sample;
              {{
                v.passed
                  ? 'passed validation'
                  : 'did not pass' + (v.failureReason ? ' — ' + v.failureReason : '')
              }}.
            </p>
          }
          @if (d.whyNot) {
            <p class="muted">{{ d.whyNot }}</p>
          }
        </section>

        @if (d.cscvSplits.length > 0) {
          <div class="charts">
            <app-chart-card
              title="In-sample vs out-of-sample Sharpe"
              [subtitle]="'Each dot is one CSCV split: the in-sample winner, measured out of sample. Under the dashed line it lost edge; a falling line means better in-sample picks did worse out of sample.'"
              [options]="scatter() ?? {}"
              [emptyMessage]="scatter() ? null : 'No split had an out-of-sample Sharpe'"
              height="300px"
            />
            <app-chart-card
              title="Where the in-sample winner ranked out of sample"
              [subtitle]="'Logit of its rank among all candidates on each split; the share at or below 0 is the PBO.'"
              [options]="logits() ?? {}"
              [emptyMessage]="logits() ? null : 'No split'"
              height="300px"
            />
          </div>
        }

        <section class="card" aria-labelledby="cand-title">
          <header class="head">
            <h3 id="cand-title" class="title">Candidates</h3>
            <span class="spacer"></span>
            <label class="sort">
              <span class="muted small">Best first by</span>
              <select
                class="field-input"
                (change)="setSort($any($event.target).value)"
                aria-label="Sort candidates"
              >
                @for (s of sorts; track s.id) {
                  <option [value]="s.id" [selected]="s.id === sortBy()">{{ s.label }}</option>
                }
              </select>
            </label>
          </header>
          @if (d.rows.length === 0) {
            <p class="muted">No candidate is recorded for this run.</p>
          } @else {
            <div class="table-wrap">
              <table class="candidates" data-testid="candidates-table">
                <thead>
                  <tr>
                    <th scope="col" class="num">#</th>
                    @for (p of paramColumns(); track p) {
                      <th scope="col">{{ p }}</th>
                    }
                    <th scope="col" class="num">Health</th>
                    <th scope="col" class="num">Expectancy (R)</th>
                    <th scope="col" class="num">Sharpe in R</th>
                    <th scope="col" class="num">Trades</th>
                    <th scope="col">Mean R per fold</th>
                  </tr>
                </thead>
                <tbody>
                  @for (c of d.rows; track c.rank) {
                    <tr [class.winner]="c.isWinner">
                      <td class="num">
                        {{ c.rank }}
                        @if (c.isWinner) {
                          <span class="chip chip-ok" title="The parameters this run chose"
                            >chosen</span
                          >
                        }
                      </td>
                      @for (p of paramColumns(); track p) {
                        <td class="mono">{{ param(c, p) }}</td>
                      }
                      <td class="num">{{ ratio(c.healthScore) }}</td>
                      <td
                        class="num"
                        [class.pos]="(c.expectancyR ?? 0) > 0"
                        [class.neg]="(c.expectancyR ?? 0) < 0"
                      >
                        {{ r(c.expectancyR) }}
                      </td>
                      <td class="num">{{ ratio(c.sharpeR) }}</td>
                      <td class="num">
                        {{ c.trades ?? '—'
                        }}<span class="muted small"> ({{ c.rTrades ?? 0 }} R)</span>
                      </td>
                      <td class="folds">
                        @for (f of c.folds; track $index) {
                          <span
                            class="fold"
                            [class.pos]="(f?.meanR ?? 0) > 0"
                            [class.neg]="(f?.meanR ?? 0) < 0"
                            [attr.title]="foldTitle($index, f)"
                            >{{ f ? r(f.meanR) : '—' }}</span
                          >
                        }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
            @if (d.candidates > d.rows.length) {
              <p class="muted small">
                Showing the best {{ d.rows.length }} of {{ d.candidates }} candidates.
              </p>
            }
          }
        </section>

        <app-parameter-heatmap [runId]="d.optimizationRunId" />
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
      .spacer {
        flex: 1;
      }
      .sort {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .warnings {
        margin: 0;
        padding: 8px 12px 8px 28px;
        border-radius: var(--radius-sm);
        background: rgba(255, 149, 0, 0.12);
        font-size: var(--text-sm);
      }
      .ok {
        margin: 0;
        color: var(--profit, #1f8a3b);
      }
      .charts {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(min(100%, 380px), 1fr));
        gap: var(--space-4);
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
        vertical-align: middle;
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
      tr.winner {
        background: rgba(52, 199, 89, 0.08);
      }
      .pos {
        color: var(--profit, #1f8a3b);
      }
      .neg {
        color: var(--loss);
      }
      .folds {
        display: flex;
        gap: 4px;
        flex-wrap: wrap;
      }
      .fold {
        font-size: 11px;
        font-variant-numeric: tabular-nums;
        padding: 1px 4px;
        border-radius: 4px;
        background: var(--bg-tertiary);
      }
      p {
        margin: 0;
      }
    `,
  ],
})
export class OptimizationRunDetailComponent {
  private readonly api = inject(ResearchApiService);
  private readonly theme = inject(ThemeService);

  readonly runId = input.required<number>();

  readonly sorts = CANDIDATE_SORTS;
  readonly sortBy = signal<string>('healthScore');
  readonly dto = signal<OptimizationCandidatesDto | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  readonly evidence = computed(() => {
    const d = this.dto();
    return d ? evidenceRows(d.selection) : [];
  });
  readonly paramColumns = computed(() => {
    const seen = new Set<string>();
    for (const c of this.dto()?.rows ?? [])
      for (const k of Object.keys(c.parameters ?? {})) if (k !== SPACE_MARKER) seen.add(k);
    return [...seen];
  });
  readonly scatter = computed(() => {
    const d = this.dto();
    if (!d) return null;
    const points = d.cscvSplits
      .filter((s) => s.outOfSampleSharpe !== null)
      .map((s, i) => ({
        inSample: s.inSampleSharpe,
        outOfSample: s.outOfSampleSharpe!,
        label: `Split ${i + 1}`,
      }));
    return isOosScatterOptions(points, reportPalette(this.theme.theme()), {
      x: 'In-sample Sharpe in R',
      y: 'Out-of-sample Sharpe in R',
    });
  });
  readonly logits = computed(() => {
    const d = this.dto();
    return d
      ? logitHistogramOptions(
          d.cscvSplits.map((s) => s.logit),
          reportPalette(this.theme.theme()),
        )
      : null;
  });

  constructor() {
    effect(() => {
      const id = this.runId();
      untracked(() => {
        this.dto.set(null);
        void this.load(id);
      });
    });
  }

  setSort(sortBy: string): void {
    this.sortBy.set(sortBy);
    void this.load(this.runId());
  }

  async load(runId: number): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const res = await firstValueFrom(this.api.candidates(runId, this.sortBy()));
      if (runId !== this.runId()) return;
      if (!res?.status || !res.data) throw res;
      this.dto.set(res.data);
    } catch (err) {
      this.error.set(describeFailure(err, `Run #${runId}'s candidates could not be read.`));
    } finally {
      this.loading.set(false);
    }
  }

  ratio(v: number | null | undefined): string {
    return formatRatio(v ?? null, 3);
  }

  r(v: number | null | undefined): string {
    return formatNumber(v ?? null, 3);
  }

  param(c: OptimizationCandidateDto, id: string): string {
    const v = c.parameters?.[id];
    return v === undefined ? '—' : valueText(v);
  }

  foldTitle(
    index: number,
    f: { trades: number; rTrades: number; meanR: number | null; sharpeR: number | null } | null,
  ): string {
    if (!f) return `Fold ${index + 1}: did not run`;
    return `Fold ${index + 1}: ${f.trades} trades (${f.rTrades} with R), mean ${formatNumber(f.meanR, 3)} R, Sharpe in R ${formatRatio(f.sharpeR, 3)}`;
  }
}
