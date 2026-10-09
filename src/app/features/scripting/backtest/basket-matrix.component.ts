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
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { ScriptStrategyService } from '../api/script-strategy.service';
import { formatNumber, formatPercent, MINUS, NA } from '../report/report-format';
import {
  basketSummary,
  basketVerdict,
  isFinished,
  summarizeRun,
  type CompareRun,
  type RunSummary,
} from './run-compare.model';

/** How often unfinished runs are re-read, and for how long at most. */
export const BASKET_POLL_MS = 5_000;
export const BASKET_POLL_LIMIT = 360;

/**
 * PE-I7: a basket backtest's results matrix — one row per market, filled in as each run finishes,
 * with how many markets the rules made money on and the median return and expectancy.
 */
@Component({
  selector: 'app-basket-matrix',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `
    <section class="matrix" aria-label="Basket results" data-testid="basket-matrix">
      <p class="summary" role="status">
        {{ summary().completed }} of {{ summary().runs }} runs finished
        @if (summary().medianReturn !== null) {
          · median return {{ pct(summary().medianReturn) }}
        }
        @if (summary().medianExpectancyR !== null) {
          · median expectancy {{ r(summary().medianExpectancyR) }}
        }
      </p>
      <p class="verdict" data-testid="basket-verdict">{{ verdict() }}</p>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Market</th>
              <th scope="col">Run</th>
              <th scope="col">Status</th>
              <th scope="col" class="num">Trades</th>
              <th scope="col" class="num">Return</th>
              <th scope="col" class="num">Win rate</th>
              <th scope="col" class="num">Profit factor</th>
              <th scope="col" class="num">Max drawdown</th>
              <th scope="col" class="num">Expectancy</th>
            </tr>
          </thead>
          <tbody>
            @for (row of rows(); track row.id) {
              <tr [attr.data-run]="row.id" [class.own]="!row.override">
                <th scope="row">
                  {{ row.symbol || '…' }}
                  @if (!row.override && row.symbol) {
                    <span class="muted small">(its own)</span>
                  }
                </th>
                <td>
                  <a [routerLink]="['/backtests', row.id]">#{{ row.id }}</a>
                </td>
                <td>{{ row.status || 'Queued' }}</td>
                <td class="num">{{ int(row.totalTrades) }}</td>
                <td class="num" [class.neg]="(row.totalReturn ?? 0) < 0">
                  {{ pct(row.totalReturn) }}
                </td>
                <td class="num">{{ row.winRate === null ? NA : pct(row.winRate * 100, false) }}</td>
                <td class="num">{{ num(row.profitFactor) }}</td>
                <td class="num">
                  {{ row.maxDrawdownPct === null ? NA : pct(row.maxDrawdownPct, false) }}
                </td>
                <td class="num">{{ r(row.expectancyR) }}</td>
              </tr>
            }
          </tbody>
        </table>
      </div>
      @if (error(); as e) {
        <p class="error" role="alert">{{ e }}</p>
      }
    </section>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .matrix {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .summary,
      .verdict {
        margin: 0;
        font-size: var(--text-sm);
      }
      .verdict {
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
        padding: 4px 8px;
        border-bottom: 1px solid var(--border);
        text-align: left;
        font-weight: normal;
        white-space: nowrap;
      }
      thead th {
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      tr.own th {
        font-weight: var(--font-semibold);
      }
      .num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .neg {
        color: var(--loss);
      }
      .muted {
        color: var(--text-secondary);
      }
      .small {
        font-size: var(--text-xs);
      }
      a {
        color: var(--accent);
      }
      .error {
        margin: 0;
        color: var(--loss);
        font-size: var(--text-sm);
      }
    `,
  ],
})
export class BasketMatrixComponent {
  private readonly api = inject(ScriptStrategyService);

  /** The basket's runs: the strategy's own market first, then the overrides. */
  readonly runIds = input.required<readonly number[]>();

  readonly NA = NA;
  readonly runs = signal<ReadonlyMap<number, RunSummary>>(new Map());
  readonly error = signal<string | null>(null);

  readonly rows = computed<RunSummary[]>(() =>
    this.runIds().map((id) => this.runs().get(id) ?? placeholder(id)),
  );
  readonly summary = computed(() => basketSummary(this.rows()));
  readonly verdict = computed(() => {
    const own = this.rows().find((r) => !r.override && r.status === 'Completed');
    return basketVerdict(this.summary(), own ? (own.totalReturn ?? 0) > 0 : null);
  });

  private timer: ReturnType<typeof setTimeout> | null = null;
  private polls = 0;
  private generation = 0;

  constructor() {
    effect(() => {
      const ids = this.runIds();
      untracked(() => this.start(ids));
    });
    inject(DestroyRef).onDestroy(() => this.stop());
  }

  private start(ids: readonly number[]): void {
    this.stop();
    this.generation++;
    this.polls = 0;
    this.runs.set(new Map());
    this.error.set(null);
    if (ids.length) void this.poll(this.generation);
  }

  private stop(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Reads every run not finished yet; again in a while while any is still queued or running. */
  async poll(generation: number): Promise<void> {
    if (generation !== this.generation) return;
    this.polls++;
    const pending = this.runIds().filter((id) => !isFinished(this.runs().get(id)?.status ?? ''));
    const read = await Promise.all(
      pending.map((id) =>
        firstValueFrom(this.api.getBacktestRun(id)).then(
          (res) => (res?.status && res.data ? summarizeRun(res.data as CompareRun) : null),
          () => null,
        ),
      ),
    );
    if (generation !== this.generation) return;
    const next = new Map(this.runs());
    let failed = 0;
    read.forEach((summary, i) => {
      if (summary) next.set(pending[i], summary);
      else failed++;
    });
    this.runs.set(next);
    this.error.set(failed > 0 ? `${failed} run(s) could not be read; retrying.` : null);
    const unfinished = this.runIds().some((id) => !isFinished(next.get(id)?.status ?? ''));
    if (unfinished && this.polls < BASKET_POLL_LIMIT) {
      this.timer = setTimeout(() => void this.poll(generation), BASKET_POLL_MS);
    }
  }

  pct(v: number | null | undefined, signed = true): string {
    return formatPercent(v ?? null, { decimals: 2, signed });
  }

  num(v: number | null): string {
    return formatNumber(v, 2);
  }

  int(v: number | null): string {
    return formatNumber(v, 0);
  }

  r(v: number | null): string {
    return v === null ? NA : `${v < 0 ? MINUS : '+'}${Math.abs(v).toFixed(2)}R`;
  }
}

function placeholder(id: number): RunSummary {
  return {
    id,
    symbol: '',
    timeframe: '',
    status: '',
    override: true,
    fromDate: '',
    toDate: '',
    totalTrades: null,
    totalReturn: null,
    winRate: null,
    profitFactor: null,
    maxDrawdownPct: null,
    sharpeRatio: null,
    expectancyR: null,
    provenance: null,
    equity: [],
  };
}
