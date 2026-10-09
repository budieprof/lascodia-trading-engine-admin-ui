import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { ThemeService } from '@core/theme/theme.service';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';

import { ScriptStrategyService } from '../api/script-strategy.service';
import { describeFailure } from '../shared/api-error';
import { reportPalette } from '../report/report-charts';
import {
  compareMetrics,
  compareSetup,
  equityOverlayOptions,
  summarizeRun,
  type CompareRun,
  type RunSummary,
} from './run-compare.model';

interface RunChoice {
  id: number;
  label: string;
  completed: boolean;
}

/**
 * PE-I7: two backtest runs of a strategy side by side — their metrics with the difference, their
 * equity rebased to the same start, and how each was made (market, window, script hash, inputs,
 * cost model, fill mode), so a difference in results can be traced to a difference in setup.
 */
@Component({
  selector: 'app-run-comparison',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ChartCardComponent],
  template: `
    <section class="card" aria-labelledby="rc-title" data-testid="run-comparison">
      <header class="head">
        <h3 id="rc-title" class="title">Compare two runs</h3>
        <span class="spacer"></span>
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          [attr.aria-expanded]="open()"
          (click)="toggle()"
        >
          {{ open() ? 'Hide' : 'Compare…' }}
        </button>
      </header>

      @if (open()) {
        @if (listError(); as e) {
          <p class="error" role="alert">{{ e }}</p>
        } @else if (choices().length < 2) {
          <p class="muted">
            {{ loadingList() ? 'Loading the runs…' : 'Two runs are needed to compare.' }}
          </p>
        } @else {
          <div class="pickers">
            <label>
              <span class="muted small">Run A</span>
              <select (change)="pick('a', +$any($event.target).value)" aria-label="Run A">
                @for (c of choices(); track c.id) {
                  <option [value]="c.id" [selected]="c.id === aId()">{{ c.label }}</option>
                }
              </select>
            </label>
            <label>
              <span class="muted small">Run B</span>
              <select (change)="pick('b', +$any($event.target).value)" aria-label="Run B">
                @for (c of choices(); track c.id) {
                  <option [value]="c.id" [selected]="c.id === bId()">{{ c.label }}</option>
                }
              </select>
            </label>
          </div>

          @if (loadingRuns()) {
            <p class="muted">Loading the two runs…</p>
          } @else if (runError(); as e) {
            <p class="error" role="alert">{{ e }}</p>
          } @else if (pair(); as p) {
            <table class="metrics" data-testid="compare-metrics">
              <thead>
                <tr>
                  <th scope="col">Metric</th>
                  <th scope="col" class="num">#{{ p.a.id }} {{ p.a.symbol }}</th>
                  <th scope="col" class="num">#{{ p.b.id }} {{ p.b.symbol }}</th>
                  <th scope="col" class="num">B − A</th>
                </tr>
              </thead>
              <tbody>
                @for (m of metrics(); track m.label) {
                  <tr>
                    <th scope="row">{{ m.label }}</th>
                    <td class="num" [class.better]="m.better === 'a'">{{ m.a }}</td>
                    <td class="num" [class.better]="m.better === 'b'">{{ m.b }}</td>
                    <td class="num">{{ m.delta }}</td>
                  </tr>
                }
              </tbody>
            </table>

            <app-chart-card
              title="Equity, rebased to the start"
              subtitle="Each run's equity as % change from its first bar"
              [options]="overlay() ?? {}"
              [emptyMessage]="overlay() ? null : 'An equity curve is missing from one of the runs'"
              height="260px"
            />

            @if (setup(); as s) {
              <h4 class="section-title">How each run was made</h4>
              @if (s.sameScript === false) {
                <p class="warn" data-testid="compare-script-differs">
                  The runs executed different scripts: a result difference may come from the code,
                  not the market or the inputs.
                </p>
              }
              <table class="setup" data-testid="compare-setup">
                <tbody>
                  @for (row of s.rows; track row.label) {
                    <tr [class.differs]="!row.same">
                      <th scope="row">{{ row.label }}</th>
                      <td>{{ row.a }}</td>
                      <td>{{ row.b }}</td>
                    </tr>
                  }
                  @for (d of s.inputDiffs; track d.id) {
                    <tr class="differs">
                      <th scope="row">
                        Input <span class="mono">{{ d.id }}</span>
                      </th>
                      <td>{{ d.run ?? 'default' }}</td>
                      <td>{{ d.now ?? 'default' }}</td>
                    </tr>
                  }
                </tbody>
              </table>
              @if (s.inputDiffs.length === 0 && s.sameScript !== null) {
                <p class="muted small">Same inputs.</p>
              }
            }
          }
        }
      }
    </section>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .card {
        margin-top: var(--space-4);
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
      .pickers {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-3);
      }
      .pickers label {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .pickers select {
        height: 32px;
        min-width: 260px;
        padding: 0 8px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-primary);
        color: var(--text-primary);
        font: inherit;
        font-size: var(--text-sm);
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
      td.better {
        font-weight: var(--font-semibold);
      }
      tr.differs td {
        background: rgba(255, 149, 0, 0.08);
      }
      .section-title {
        margin: var(--space-2) 0 0;
        font-size: var(--text-xs);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-secondary);
      }
      .warn {
        margin: 0;
        font-size: var(--text-sm);
        color: var(--loss);
      }
      .muted {
        margin: 0;
        color: var(--text-secondary);
        font-size: var(--text-sm);
      }
      .small {
        font-size: var(--text-xs);
      }
      .mono {
        font-family: ui-monospace, 'SF Mono', Menlo, monospace;
        font-size: 12px;
      }
      .error {
        margin: 0;
        color: var(--loss);
        font-size: var(--text-sm);
      }
    `,
  ],
})
export class RunComparisonComponent {
  private readonly api = inject(ScriptStrategyService);
  private readonly theme = inject(ThemeService);

  readonly strategyId = input.required<number>();

  readonly open = signal(false);
  readonly loadingList = signal(false);
  readonly listError = signal<string | null>(null);
  readonly choices = signal<RunChoice[]>([]);
  readonly aId = signal<number | null>(null);
  readonly bId = signal<number | null>(null);
  readonly loadingRuns = signal(false);
  readonly runError = signal<string | null>(null);
  readonly pair = signal<{ a: RunSummary; b: RunSummary } | null>(null);

  readonly metrics = computed(() => {
    const p = this.pair();
    return p ? compareMetrics(p.a, p.b) : [];
  });
  readonly setup = computed(() => {
    const p = this.pair();
    return p ? compareSetup(p.a, p.b) : null;
  });
  readonly overlay = computed(() => {
    const p = this.pair();
    return p ? equityOverlayOptions(p.a, p.b, reportPalette(this.theme.theme())) : null;
  });

  private listed = false;

  toggle(): void {
    this.open.set(!this.open());
    if (this.open() && !this.listed) void this.loadList();
  }

  /** The strategy's newest runs; the two newest completed ones are compared first. */
  async loadList(): Promise<void> {
    this.listed = true;
    this.loadingList.set(true);
    this.listError.set(null);
    try {
      const res = await firstValueFrom(this.api.listStrategyBacktests(this.strategyId()));
      if (!res?.status) throw res;
      const runs = [...(res.data?.data ?? [])].sort((x, y) => y.id - x.id);
      this.choices.set(
        runs.map((r) => ({
          id: r.id,
          completed: r.status === 'Completed',
          label: `#${r.id} · ${r.symbol ?? ''} ${r.timeframe ?? ''} · ${String(r.fromDate).slice(0, 10)} → ${String(r.toDate).slice(0, 10)} · ${r.status}${r.symbolOverride || r.timeframeOverride ? ' · override' : ''}`,
        })),
      );
      const done = this.choices().filter((c) => c.completed);
      const [b, a] = done.length >= 2 ? done : this.choices();
      if (a && b) await this.compare(a.id, b.id);
    } catch (err) {
      this.listError.set(describeFailure(err, 'The runs could not be listed.'));
    } finally {
      this.loadingList.set(false);
    }
  }

  async pick(which: 'a' | 'b', id: number): Promise<void> {
    const a = which === 'a' ? id : this.aId();
    const b = which === 'b' ? id : this.bId();
    if (a !== null && b !== null) await this.compare(a, b);
  }

  async compare(a: number, b: number): Promise<void> {
    this.aId.set(a);
    this.bId.set(b);
    this.loadingRuns.set(true);
    this.runError.set(null);
    try {
      const [ra, rb] = await Promise.all(
        [a, b].map((id) => firstValueFrom(this.api.getBacktestRun(id))),
      );
      if (this.aId() !== a || this.bId() !== b) return;
      if (!ra?.status || !ra.data) throw ra;
      if (!rb?.status || !rb.data) throw rb;
      this.pair.set({
        a: summarizeRun(ra.data as CompareRun),
        b: summarizeRun(rb.data as CompareRun),
      });
    } catch (err) {
      this.pair.set(null);
      this.runError.set(describeFailure(err, 'The runs could not be loaded.'));
    } finally {
      this.loadingRuns.set(false);
    }
  }
}
