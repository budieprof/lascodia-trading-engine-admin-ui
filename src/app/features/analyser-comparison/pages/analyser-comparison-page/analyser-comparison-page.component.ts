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
            Window: {{ summary()!.fromUtc | date: 'short' }} →
            {{ summary()!.toUtc | date: 'short' }}
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
      .page {
        padding: 1rem;
        display: flex;
        flex-direction: column;
        gap: 1rem;
      }
      .header-controls {
        display: flex;
        gap: 1rem;
        align-items: center;
        flex-wrap: wrap;
      }
      .chip-group {
        display: inline-flex;
        gap: 0.25rem;
      }
      .chip {
        border: 1px solid var(--border, #2a2f3a);
        background: transparent;
        color: inherit;
        padding: 0.25rem 0.6rem;
        border-radius: 9999px;
        cursor: pointer;
        font-size: 0.85rem;
      }
      .chip--active {
        background: var(--accent, #4f8cff);
        color: #fff;
        border-color: transparent;
      }
      .field {
        display: inline-flex;
        flex-direction: column;
        gap: 2px;
        font-size: 0.85rem;
      }
      .field input,
      .field select {
        padding: 0.25rem 0.5rem;
        background: transparent;
        color: inherit;
        border: 1px solid var(--border, #2a2f3a);
        border-radius: 4px;
        min-width: 80px;
      }
      .audit-link {
        color: var(--accent, #4f8cff);
        text-decoration: none;
        font-size: 0.9rem;
      }
      .audit-link:hover {
        text-decoration: underline;
      }
      .status {
        padding: 1rem;
        opacity: 0.7;
      }
      .status.error {
        color: #f66;
      }
      .window-meta {
        font-size: 0.85rem;
        opacity: 0.7;
      }
      .grid {
        display: grid;
        gap: 1rem;
        grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      }
      .source-card {
        background: var(--card-bg, #1a1f2b);
        border: 1px solid var(--border, #2a2f3a);
        border-radius: 8px;
        padding: 1rem;
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
      }
      .source-card--llm {
        border-left: 4px solid #b07cff;
      }
      .source-card--syn {
        border-left: 4px solid #4fd1c5;
      }
      .source-card header {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 0.5rem;
      }
      .source-card h2 {
        margin: 0;
        font-size: 1.05rem;
      }
      .source-card h3 {
        margin: 0;
        font-size: 0.85rem;
        opacity: 0.7;
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      .badge {
        background: var(--badge-bg, #2a2f3a);
        border-radius: 9999px;
        padding: 0.15rem 0.5rem;
        font-size: 0.75rem;
      }
      .kv {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: 0.25rem 1rem;
        margin: 0;
      }
      .kv > div {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        padding: 0.15rem 0;
      }
      .kv dt {
        font-size: 0.8rem;
        opacity: 0.7;
      }
      .kv dd {
        margin: 0;
        font-variant-numeric: tabular-nums;
        font-weight: 600;
      }
      .kv--pnl dd {
        font-size: 1.05rem;
      }
      .profit {
        color: #4fd1c5;
      }
      .loss {
        color: #ff7a7a;
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
