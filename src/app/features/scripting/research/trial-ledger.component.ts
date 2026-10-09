import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { SCRIPTING_UI_STYLES } from '../components/scripting-ui.styles';
import { formatDateTime, formatNumber, formatPercent } from '../report/report-format';
import { describeFailure } from '../shared/api-error';
import { ResearchApiService } from './research-api.service';
import type { TrialLedgerDto } from './research.types';

const KIND_LABELS: Record<string, string> = {
  OptimizerCandidate: 'Optimizer candidates',
  WalkForwardFoldSearch: 'Walk-forward fold searches',
  Configuration: 'Configurations backtested',
};

/**
 * BT-I4 — the multiple-testing ledger of the strategy's lineage: how many configurations its research tried (optimizer
 * candidates, walk-forward fold re-optimisations, configurations backtested), the trial count the promotion gates
 * deflate its Sharpe by, and the probability of backtest overfitting (CSCV) of its newest optimization runs.
 */
@Component({
  selector: 'app-trial-ledger',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card" aria-labelledby="tl-title" data-testid="trial-ledger">
      <header class="head">
        <h3 id="tl-title" class="title">Trials and overfitting — this strategy's lineage</h3>
        <span class="spacer"></span>
        <button type="button" class="btn btn-ghost btn-sm" (click)="reload()">Refresh</button>
      </header>
      @if (error(); as e) {
        <p class="error-box" role="alert">{{ e }}</p>
      } @else if (dto(); as d) {
        <div class="figures">
          <div class="figure">
            <span class="value" data-testid="effective-trials">{{ d.effectiveTrials }}</span>
            <span class="muted small">trials the promotion gates deflate by</span>
          </div>
          <div class="figure">
            <span class="value">{{ d.ledgerTrials }}</span>
            <span class="muted small">recorded by this lineage</span>
          </div>
          <div class="figure">
            <span class="value">{{ d.peerStrategies }}</span>
            <span class="muted small">strategies on the same pair (the floor)</span>
          </div>
        </div>
        <p class="muted small">
          A Sharpe ratio picked as the best of many tries is inflated by the picking. The gates
          deflate it by the larger of the lineage's trials and the strategies on the pair — today
          {{ d.effectiveTrials }}.
          @if (d.lineageRootStrategyId !== d.strategyId) {
            The lineage starts at strategy #{{ d.lineageRootStrategyId }}: its relatives' trials
            count here too.
          }
        </p>
        <ul class="kinds">
          @for (k of kinds(); track k.kind) {
            <li>
              <span class="strong">{{ k.label }}</span
              >: {{ k.rows }} row{{ k.rows === 1 ? '' : 's' }}
            </li>
          }
          <li>
            <span class="strong">Distinct configurations</span>: {{ d.distinctConfigurations }}
          </li>
          <li>
            <span class="strong">Parameter sets tried by fold searches</span>:
            {{ d.foldSearchCandidates }}
          </li>
        </ul>

        @if (d.optimizationRuns.length > 0) {
          <div class="table-wrap">
            <table data-testid="pbo-table">
              <thead>
                <tr>
                  <th scope="col">Run</th>
                  <th scope="col">Completed</th>
                  <th scope="col" class="num">Candidates</th>
                  <th scope="col" class="num">PBO</th>
                  <th scope="col">How it was measured</th>
                </tr>
              </thead>
              <tbody>
                @for (r of d.optimizationRuns; track r.optimizationRunId) {
                  <tr
                    tabindex="0"
                    (click)="openRun.emit(r.optimizationRunId)"
                    (keydown.enter)="openRun.emit(r.optimizationRunId)"
                  >
                    <td class="mono">
                      #{{ r.optimizationRunId }} <span class="muted small">{{ r.status }}</span>
                    </td>
                    <td>{{ r.completedAt ? when(r.completedAt) : '—' }}</td>
                    <td class="num">
                      {{ r.candidates }}
                      <span class="muted small">({{ r.candidatesWithFolds }} with folds)</span>
                    </td>
                    <td class="num">
                      @if (r.pbo !== null) {
                        <span class="chip">{{ pct(r.pbo) }}</span>
                      } @else {
                        <span class="muted">—</span>
                      }
                    </td>
                    <td class="muted small">
                      @if (r.pbo !== null) {
                        CSCV over {{ r.blocks }} folds, {{ r.combinations }} splits; median logit
                        {{ num(r.medianLogit) }}
                      } @else {
                        {{ r.whyNot }}
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          <p class="muted small">
            PBO is the share of splits where the in-sample winner did no better than the median out
            of sample. Open a run to see it against the PBO gate's limit in force (Promotion:MaxPBO)
            and the engine's warnings.
          </p>
        } @else {
          <p class="muted">No completed optimization run is recorded for this strategy yet.</p>
        }
      } @else {
        <p class="muted">{{ loading() ? 'Reading the ledger…' : '' }}</p>
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
        align-items: center;
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
      .figures {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-5);
      }
      .figure {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .value {
        font-size: var(--text-xl, 20px);
        font-weight: var(--font-semibold);
        font-variant-numeric: tabular-nums;
      }
      .kinds {
        margin: 0;
        padding-left: 18px;
        font-size: var(--text-sm);
      }
      .strong {
        font-weight: var(--font-medium);
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
      tbody tr {
        cursor: pointer;
      }
      tbody tr:hover {
        background: var(--bg-tertiary);
      }
      .num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      p {
        margin: 0;
      }
    `,
  ],
})
export class TrialLedgerComponent {
  private readonly api = inject(ResearchApiService);

  readonly strategyId = input.required<number>();
  /** Bump to re-read (a run finished). */
  readonly refreshKey = input(0);
  readonly openRun = output<number>();

  readonly dto = signal<TrialLedgerDto | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  readonly kinds = computed(() =>
    Object.entries(this.dto()?.rowsByKind ?? {}).map(([kind, rows]) => ({
      kind,
      rows,
      label: KIND_LABELS[kind] ?? kind,
    })),
  );

  constructor() {
    effect(() => {
      this.strategyId();
      this.refreshKey();
      untracked(() => void this.reload());
    });
  }

  async reload(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const res = await firstValueFrom(this.api.trials(this.strategyId()));
      if (!res?.status || !res.data) throw res;
      this.dto.set(res.data);
    } catch (err) {
      this.error.set(describeFailure(err, 'The trial ledger could not be read.'));
    } finally {
      this.loading.set(false);
    }
  }

  when(iso: string): string {
    return `${formatDateTime(Date.parse(iso))} UTC`;
  }

  pct(v: number): string {
    return formatPercent(v * 100, { decimals: 0 });
  }

  num(v: number | null): string {
    return formatNumber(v, 2);
  }
}
