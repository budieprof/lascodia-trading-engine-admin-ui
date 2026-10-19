import {
  Component,
  ChangeDetectionStrategy,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CurrencyPipe, DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { catchError, of } from 'rxjs';

import { AnalyserComparisonService } from '@core/services/analyser-comparison.service';
import {
  AnalyserComparisonSummaryDto,
  AnalyserComparisonRowDto,
  Timeframe,
} from '@core/api/api.types';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';

const WINDOWS: { label: string; days: number }[] = [
  { label: '24h', days: 1 },
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
];

const TIMEFRAMES: (Timeframe | '')[] = ['', 'M1', 'M5', 'M15', 'H1', 'H4', 'D1'];

/**
 * A summary row plus the derived tripwire fields the engine computes
 * (`PopulateDerivedBenchmarkFields`) but api.types' AnalyserComparisonRowDto
 * does not declare. Optional so an older engine still type-checks.
 */
type BenchmarkRow = AnalyserComparisonRowDto & {
  isValidBenchmark?: boolean;
  holdPct?: number;
};

/**
 * Analyser Comparison — side-by-side card view of the LLM analyser, the
 * Synthetic analyser and the three baselines over a configurable window. Driven
 * by /market-data/analyser-comparison/summary, which always returns every
 * compared source (zero-row sources included) plus a per-model split of the
 * synthetic side.
 *
 * Counterfactual P&L is shown in three flavours so the operator can pick the
 * comparison most relevant to a decision: Raw (thesis only), Managed
 * (rule-evaluator applied — equal to Raw until Phase 1d/2-managed lands),
 * Gated (only what the gate stack would have actually let through).
 */
@Component({
  selector: 'app-analyser-comparison-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CurrencyPipe, DatePipe, DecimalPipe, FormsModule, RouterLink, PageHeaderComponent],
  template: `
    <div class="page">
      <app-page-header
        title="Analyser Comparison"
        subtitle="LLM analyser vs non-LLM Synthetic Analyser — decision counts, action mix, and counterfactual P&L"
      >
        <div class="header-controls">
          <div class="chip-group" role="tablist" aria-label="Time window">
            @for (w of windows; track w.days) {
              <button
                type="button"
                role="tab"
                class="chip"
                [class.chip--active]="w.days === activeWindow().days"
                (click)="setWindow(w)"
              >
                {{ w.label }}
              </button>
            }
          </div>
          <label class="field">
            <span>Symbol</span>
            <input
              type="text"
              maxlength="12"
              placeholder="any"
              [(ngModel)]="symbolFilter"
              (change)="reload()"
            />
          </label>
          <label class="field">
            <span>Timeframe</span>
            <select [(ngModel)]="timeframeFilter" (change)="reload()">
              @for (tf of timeframes; track tf) {
                <option [value]="tf">{{ tf || 'any' }}</option>
              }
            </select>
          </label>
          <a class="audit-link" [routerLink]="['/analyser-comparison/audit']">
            Run look-ahead audit →
          </a>
        </div>
      </app-page-header>

      @if (loading()) {
        <div class="status">Loading…</div>
      } @else if (errorMessage()) {
        <div class="status error">{{ errorMessage() }}</div>
      } @else if (summary()) {
        <section class="window-meta">
          <span>
            Window: {{ summary()!.fromUtc | date: 'MMM d, yyyy HH:mm' : 'UTC' }} →
            {{ summary()!.toUtc | date: 'MMM d, yyyy HH:mm' : 'UTC' }} UTC ({{
              summary()!.symbol ?? 'all symbols'
            }}, {{ summary()!.timeframe ?? 'all timeframes' }})
          </span>
        </section>
        <section class="grid">
          @for (row of rows(); track row.source) {
            <article
              class="source-card"
              [class.source-card--llm]="row.source === 'SpotAnalysis'"
              [class.source-card--syn]="row.source === 'SyntheticAnalyser'"
            >
              <header>
                <h2>{{ sourceLabel(row) }}</h2>
                <span class="badge">{{ row.decisions | number }} decisions</span>
              </header>
              <!-- The engine flags a source with too few actionable decisions to
                   compare against; the card used to look as authoritative as the rest. -->
              @if (row.isValidBenchmark === false) {
                <p class="benchmark-warn" role="note">
                  Not a valid benchmark — only {{ row.actionable | number }} actionable decision{{
                    row.actionable === 1 ? '' : 's'
                  }}
                  in this window, too few to compare.
                </p>
              }
              <dl class="kv">
                <div>
                  <dt>Actionable</dt>
                  <dd>{{ row.actionable | number }}</dd>
                </div>
                <div>
                  <dt>Executed</dt>
                  <dd>{{ row.executed | number }}</dd>
                </div>
                <div>
                  <dt>Buy</dt>
                  <dd>{{ row.buyCount | number }}</dd>
                </div>
                <div>
                  <dt>Sell</dt>
                  <dd>{{ row.sellCount | number }}</dd>
                </div>
                <div>
                  <dt>Hold</dt>
                  <dd>{{ row.holdCount | number }}</dd>
                </div>
                <div>
                  <dt>Avg confidence</dt>
                  <dd>{{ row.avgConfidence | number: '1.2-2' }}</dd>
                </div>
                <div>
                  <dt>Backfilled</dt>
                  <dd>{{ row.backfilledCount | number }} / {{ row.decisions | number }}</dd>
                </div>
              </dl>
              <h3>Counterfactual P&amp;L</h3>
              <dl class="kv kv--pnl">
                <div>
                  <dt>Raw</dt>
                  <dd
                    [class.profit]="row.sumCounterfactualRawPnL > 0"
                    [class.loss]="row.sumCounterfactualRawPnL < 0"
                  >
                    {{ row.sumCounterfactualRawPnL | currency: 'USD' }}
                  </dd>
                </div>
                <div>
                  <dt>Managed</dt>
                  <dd
                    [class.profit]="row.sumCounterfactualManagedPnL > 0"
                    [class.loss]="row.sumCounterfactualManagedPnL < 0"
                  >
                    {{ row.sumCounterfactualManagedPnL | currency: 'USD' }}
                  </dd>
                </div>
                <div>
                  <dt>Gated</dt>
                  <dd
                    [class.profit]="row.sumCounterfactualGatedPnL > 0"
                    [class.loss]="row.sumCounterfactualGatedPnL < 0"
                  >
                    {{ row.sumCounterfactualGatedPnL | currency: 'USD' }}
                  </dd>
                </div>
              </dl>
              <dl class="kv">
                <div>
                  <dt>Win / loss</dt>
                  <dd>
                    {{ row.counterfactualWins | number }} / {{ row.counterfactualLosses | number }}
                  </dd>
                </div>
                <!-- Two averages, labelled. The engine's is per backfilled ACTIONABLE
                     (Buy/Sell) decision since 2026-10-19 — it used to count holds as $0,
                     which diluted hold-heavy sources (the LLM: 188 of 298 rows) next to
                     baselines that never hold. Per TRADE divides by wins + losses, so it
                     also leaves breakevens out. -->
                <div>
                  <dt
                    title="Engine average over backfilled Buy/Sell decisions — holds excluded, breakevens included"
                  >
                    Avg raw P&amp;L / actionable
                  </dt>
                  <dd
                    [class.profit]="(row.avgCounterfactualRawPnL ?? 0) > 0"
                    [class.loss]="(row.avgCounterfactualRawPnL ?? 0) < 0"
                  >
                    @if (row.avgCounterfactualRawPnL !== null) {
                      {{ row.avgCounterfactualRawPnL | currency: 'USD' }}
                    } @else {
                      <span class="muted">—</span>
                    }
                  </dd>
                </div>
                <div>
                  <dt title="Raw P&L ÷ (wins + losses) — breakeven trades excluded">
                    Avg raw P&amp;L / trade
                  </dt>
                  <dd
                    [class.profit]="(perTrade(row) ?? 0) > 0"
                    [class.loss]="(perTrade(row) ?? 0) < 0"
                  >
                    @if (perTrade(row) !== null) {
                      {{ perTrade(row) | currency: 'USD' }}
                    } @else {
                      <span class="muted">—</span>
                    }
                  </dd>
                </div>
              </dl>
            </article>
          }
        </section>

        <!-- The engine splits the synthetic side by the model that produced each
             decision (an architecture swap mid-window otherwise blends into one row);
             the page never showed it. -->
        @if (summary()!.perModel.length > 0) {
          <section class="per-model">
            <h2>Synthetic analyser by model</h2>
            <div class="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Model</th>
                    <th>Architecture</th>
                    <th>Status</th>
                    <th>Trained (UTC)</th>
                    <th class="num">Decisions</th>
                    <th class="num">Actionable</th>
                    <th class="num">Buy / Sell / Hold</th>
                    <th class="num">Avg conf.</th>
                    <th class="num">Raw P&amp;L</th>
                    <th class="num">Gated P&amp;L</th>
                  </tr>
                </thead>
                <tbody>
                  @for (m of summary()!.perModel; track m.mlModelId) {
                    <tr>
                      <td class="mono">#{{ m.mlModelId }}</td>
                      <td>{{ m.architecture }}</td>
                      <td>{{ m.modelStatus }}</td>
                      <td class="mono">
                        {{ m.trainedAt ? (m.trainedAt | date: 'yyyy-MM-dd' : 'UTC') : '—' }}
                      </td>
                      <td class="num">{{ m.decisions | number }}</td>
                      <td class="num">{{ m.actionable | number }}</td>
                      <td class="num">
                        {{ m.buyCount | number }} / {{ m.sellCount | number }} /
                        {{ m.holdCount | number }}
                      </td>
                      <td class="num">{{ m.avgConfidence | number: '1.2-2' }}</td>
                      <td
                        class="num"
                        [class.profit]="m.sumCounterfactualRawPnL > 0"
                        [class.loss]="m.sumCounterfactualRawPnL < 0"
                      >
                        {{ m.sumCounterfactualRawPnL | currency: 'USD' }}
                      </td>
                      <td
                        class="num"
                        [class.profit]="m.sumCounterfactualGatedPnL > 0"
                        [class.loss]="m.sumCounterfactualGatedPnL < 0"
                      >
                        {{ m.sumCounterfactualGatedPnL | currency: 'USD' }}
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </section>
        }
      }
    </div>
  `,
  styles: [
    `
      /* No page-level padding — the layout shell already provides the 32px
         gutter, so content here used to start 16px to the right of every
         other route. */
      .page {
        padding: var(--space-2) 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
      }
      .header-controls {
        display: flex;
        gap: var(--space-3) var(--space-4);
        align-items: flex-end;
        flex-wrap: wrap;
        justify-content: flex-end;
      }
      .chip-group {
        display: inline-flex;
        gap: var(--space-1);
      }
      .chip {
        border: 1px solid var(--border);
        background: transparent;
        color: var(--text-primary);
        padding: 4px 10px;
        border-radius: var(--radius-full);
        cursor: pointer;
        font-size: var(--text-xs);
        font-family: inherit;
      }
      .chip--active {
        background: var(--accent);
        color: #fff;
        border-color: transparent;
      }
      .field {
        display: inline-flex;
        flex-direction: column;
        gap: 2px;
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .field input,
      .field select {
        height: 32px;
        padding: 0 var(--space-2);
        background: var(--bg-primary);
        color: var(--text-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        min-width: 90px;
        font-size: var(--text-sm);
        font-family: inherit;
      }
      .audit-link {
        color: var(--accent);
        text-decoration: none;
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        padding-bottom: 6px;
      }
      .audit-link:hover {
        text-decoration: underline;
      }
      .status {
        padding: var(--space-4);
        color: var(--text-secondary);
        font-size: var(--text-sm);
      }
      .status.error {
        color: var(--loss);
      }
      .window-meta {
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      /* Exactly two sources are ever returned, so lay out two equal columns —
         auto-fit produced a third, empty column on wide screens. */
      .grid {
        display: grid;
        gap: var(--space-4);
        grid-template-columns: repeat(2, minmax(0, 1fr));
        align-items: start;
      }
      @media (max-width: 900px) {
        .grid {
          grid-template-columns: 1fr;
        }
      }
      .source-card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--card-padding);
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
        min-width: 0;
      }
      .source-card--llm {
        border-left: 4px solid #af52de;
      }
      .source-card--syn {
        border-left: 4px solid #0071e3;
      }
      .source-card header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-2);
      }
      .source-card h2 {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
      }
      .source-card h3 {
        margin: 0;
        font-size: 10.5px;
        font-weight: var(--font-semibold);
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      .badge {
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        border-radius: var(--radius-full);
        padding: 2px 10px;
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
        white-space: nowrap;
        flex-shrink: 0;
        font-variant-numeric: tabular-nums;
      }
      /* One label/value pair per row: the earlier two-column grid put the
         label and the value in one flex line and let the value wrap into the
         label ("Backfilled2,905 /"). Label left, value right, nothing wraps. */
      .kv {
        display: grid;
        grid-template-columns: 1fr;
        gap: 2px;
        margin: 0;
      }
      .kv > div {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        align-items: baseline;
        gap: var(--space-3);
        padding: 3px 0;
        border-bottom: 1px solid var(--border);
      }
      .kv > div:last-child {
        border-bottom: none;
      }
      .kv dt {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .kv dd {
        margin: 0;
        font-variant-numeric: tabular-nums;
        font-weight: var(--font-semibold);
        font-size: var(--text-sm);
        color: var(--text-primary);
        white-space: nowrap;
        text-align: right;
      }
      .kv--pnl dd {
        font-size: var(--text-base);
      }
      /* Qualified with the element: ".kv dd" (0,1,1) out-ranked a bare ".profit"
         (0,1,0), so every P&L figure rendered white whatever its sign. */
      .profit,
      .kv dd.profit {
        color: var(--profit);
      }
      .loss,
      .kv dd.loss {
        color: var(--loss);
      }
      .muted {
        color: var(--text-tertiary);
        font-weight: var(--font-regular);
      }
      .benchmark-warn {
        margin: 0;
        padding: var(--space-2) var(--space-3);
        border-radius: var(--radius-sm);
        font-size: var(--text-xs);
        color: var(--warning);
        background: color-mix(in srgb, var(--warning) 10%, transparent);
      }
      .per-model {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--card-padding);
      }
      .per-model h2 {
        margin: 0 0 var(--space-3);
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .table-scroll {
        overflow-x: auto;
      }
      .per-model table {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-sm);
        font-variant-numeric: tabular-nums;
      }
      .per-model th,
      .per-model td {
        padding: 6px 10px;
        text-align: left;
        border-bottom: 1px solid var(--border);
        white-space: nowrap;
      }
      .per-model th {
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        color: var(--text-secondary);
      }
      .per-model .num {
        text-align: right;
      }
      .mono {
        font-family: ui-monospace, SFMono-Regular, monospace;
      }
    `,
  ],
})
export class AnalyserComparisonPageComponent implements OnInit {
  private readonly svc = inject(AnalyserComparisonService);

  readonly windows = WINDOWS;
  readonly timeframes = TIMEFRAMES;

  readonly activeWindow = signal(WINDOWS[2]); // 30d default
  readonly symbolFilter = signal('');
  readonly timeframeFilter = signal<Timeframe | ''>('');

  readonly loading = signal(true);
  readonly errorMessage = signal<string | null>(null);
  readonly summary = signal<AnalyserComparisonSummaryDto | null>(null);
  /** Rows with the engine's benchmark tripwire, which api.types does not declare yet. */
  readonly rows = computed(() => (this.summary()?.sources ?? []) as BenchmarkRow[]);
  /** Sequence of the latest request — a slower earlier answer must not overwrite it. */
  private requestSeq = 0;

  ngOnInit() {
    this.reload();
  }

  setWindow(w: { label: string; days: number }) {
    this.activeWindow.set(w);
    this.reload();
  }

  reload() {
    const seq = ++this.requestSeq;
    this.loading.set(true);
    this.errorMessage.set(null);
    const days = this.activeWindow().days;
    const toUtc = new Date();
    const fromUtc = new Date(toUtc.getTime() - days * 24 * 60 * 60 * 1000);
    const filter = {
      symbol: this.symbolFilter().trim() || undefined,
      timeframe: (this.timeframeFilter() || undefined) as Timeframe | undefined,
      fromUtc: fromUtc.toISOString(),
      toUtc: toUtc.toISOString(),
    };
    this.svc
      .getSummary(filter)
      .pipe(
        catchError((err) => {
          if (seq === this.requestSeq)
            this.errorMessage.set(err?.message ?? 'Failed to load summary.');
          return of(null);
        }),
      )
      .subscribe((res) => {
        // Window chips and filters fire a request each; only the newest may land.
        if (seq !== this.requestSeq) return;
        this.loading.set(false);
        if (res?.status && res.data) this.summary.set(res.data);
        else if (res) this.errorMessage.set(res.message ?? 'The engine refused the summary query.');
      });
  }

  /** Raw counterfactual P&L per resolved trade (wins + losses); null when none resolved. */
  perTrade(row: AnalyserComparisonRowDto): number | null {
    const n = row.counterfactualWins + row.counterfactualLosses;
    return n > 0 ? row.sumCounterfactualRawPnL / n : null;
  }

  sourceLabel(row: AnalyserComparisonRowDto): string {
    return row.source === 'SpotAnalysis'
      ? 'LLM Analyser (Spot Analysis)'
      : row.source === 'SyntheticAnalyser'
        ? 'Synthetic Analyser (Stacked)'
        : row.source;
  }
}
