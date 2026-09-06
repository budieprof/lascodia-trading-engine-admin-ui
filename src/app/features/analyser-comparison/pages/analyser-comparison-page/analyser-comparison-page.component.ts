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
 * Analyser Comparison — side-by-side card view of LLM vs Synthetic analyser
 * over a configurable window. Driven by /market-data/analyser-comparison/summary
 * which returns a stable 2-row shape (one row per source) so the page always
 * renders both columns even when one source has zero rows.
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
            Window: {{ summary()!.fromUtc | date: 'MMM d, yyyy HH:mm' }} →
            {{ summary()!.toUtc | date: 'MMM d, yyyy HH:mm' }}
            ({{ summary()!.symbol ?? 'all symbols' }},
            {{ summary()!.timeframe ?? 'all timeframes' }})
          </span>
        </section>
        <section class="grid">
          @for (row of summary()!.sources; track row.source) {
            <article
              class="source-card"
              [class.source-card--llm]="row.source === 'SpotAnalysis'"
              [class.source-card--syn]="row.source === 'SyntheticAnalyser'"
            >
              <header>
                <h2>{{ sourceLabel(row) }}</h2>
                <span class="badge">{{ row.decisions | number }} decisions</span>
              </header>
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
                <div>
                  <dt>Avg raw PnL</dt>
                  <dd>{{ row.avgCounterfactualRawPnL ?? 0 | currency: 'USD' }}</dd>
                </div>
              </dl>
            </article>
          }
        </section>
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
        gap: var(--space-4);
        align-items: flex-end;
        flex-wrap: wrap;
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
      .profit {
        color: var(--profit);
      }
      .loss {
        color: var(--loss);
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

  ngOnInit() {
    this.reload();
  }

  setWindow(w: { label: string; days: number }) {
    this.activeWindow.set(w);
    this.reload();
  }

  reload() {
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
          this.errorMessage.set(err?.message ?? 'Failed to load summary.');
          return of(null);
        }),
      )
      .subscribe((res) => {
        this.loading.set(false);
        if (res?.status && res.data) this.summary.set(res.data);
      });
  }

  sourceLabel(row: AnalyserComparisonRowDto): string {
    return row.source === 'SpotAnalysis'
      ? 'LLM Analyser (Spot Analysis)'
      : row.source === 'SyntheticAnalyser'
        ? 'Synthetic Analyser (Stacked)'
        : row.source;
  }
}
