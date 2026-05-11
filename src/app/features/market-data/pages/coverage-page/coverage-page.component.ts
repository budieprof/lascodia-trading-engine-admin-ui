import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { catchError, finalize, map, of } from 'rxjs';

import { MarketDataService } from '@core/services/market-data.service';
import type { CandleCoverageDto, Timeframe } from '@core/api/api.types';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';

const TIMEFRAMES: readonly Timeframe[] = ['M1', 'M5', 'M15', 'H1', 'H4', 'D1'] as const;

interface CoverageResult {
  symbol: string;
  timeframe: Timeframe;
  data: CandleCoverageDto | null;
  error: string | null;
}

@Component({
  selector: 'app-coverage-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    DecimalPipe,
    FormsModule,
    RouterLink,
    PageHeaderComponent,
    MetricCardComponent,
    CardSkeletonComponent,
    ErrorStateComponent,
    EmptyStateComponent,
    RelativeTimePipe,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Market Data — Candle Coverage"
        subtitle="Per-(symbol, timeframe) candle coverage with gap segments + earliest/latest"
      >
        <a routerLink="/market-data" class="btn btn-secondary">← Market Data</a>
        <a routerLink="/market-data/order-book" class="btn btn-secondary">Order Book →</a>
      </app-page-header>

      <section class="controls">
        <label class="field">
          <span>Symbols</span>
          <input
            type="search"
            placeholder="EURUSD, GBPUSD, USDJPY"
            [(ngModel)]="symbolsInput"
            (keydown.enter)="run()"
          />
        </label>
        <label class="field tf">
          <span>Timeframes</span>
          <div class="tf-pills">
            @for (tf of TIMEFRAMES; track tf) {
              <button
                type="button"
                [class.active]="selectedTimeframes().includes(tf)"
                (click)="toggleTimeframe(tf)"
              >
                {{ tf }}
              </button>
            }
          </div>
        </label>
        <div class="field date-pair">
          <span>Window (optional)</span>
          <div class="date-row">
            <input type="datetime-local" [(ngModel)]="fromInput" placeholder="from" />
            <span class="arrow">→</span>
            <input type="datetime-local" [(ngModel)]="toInput" placeholder="to" />
          </div>
        </div>
        <button
          type="button"
          class="btn btn-primary"
          (click)="run()"
          [disabled]="!canRun() || running()"
        >
          {{ running() ? 'Running…' : 'Probe' }}
        </button>
      </section>

      @if (running()) {
        <app-card-skeleton [lines]="6" />
      } @else if (results().length === 0) {
        <app-empty-state
          title="Enter a symbol and pick at least one timeframe"
          description="Each (symbol, timeframe) combination fires one independent coverage probe. Date window is optional — omit for total-history coverage."
        />
      } @else {
        <section class="kpis">
          <app-metric-card
            label="Probes"
            [value]="results().length"
            format="number"
            dotColor="#0071E3"
          />
          <app-metric-card
            label="Probes with data"
            [value]="resultsWithData().length"
            format="number"
            dotColor="#34C759"
          />
          <app-metric-card
            label="Total gap segments"
            [value]="totalSegments()"
            format="number"
            [dotColor]="totalSegments() > 0 ? '#FF9500' : '#34C759'"
          />
          <app-metric-card
            label="Failures"
            [value]="failureCount()"
            format="number"
            [dotColor]="failureCount() > 0 ? '#FF3B30' : '#34C759'"
          />
        </section>

        <section class="card">
          <table class="coverage-table">
            <thead>
              <tr>
                <th>Symbol</th>
                <th>Timeframe</th>
                <th class="num">Total candles</th>
                <th class="num">In window</th>
                <th class="num">Gaps</th>
                <th class="num">Largest gap</th>
                <th>Earliest</th>
                <th>Latest</th>
              </tr>
            </thead>
            <tbody>
              @for (row of results(); track rowKey(row)) {
                <tr [class.error]="row.error" [class.gappy]="(row.data?.segmentCount ?? 0) > 1">
                  <td class="mono symbol">{{ row.symbol }}</td>
                  <td class="mono">{{ row.timeframe }}</td>
                  @if (row.error) {
                    <td colspan="6" class="error-msg">{{ row.error }}</td>
                  } @else if (row.data) {
                    <td class="num mono">{{ row.data.totalCandles | number: '1.0-0' }}</td>
                    <td class="num mono">{{ row.data.candlesInWindow | number: '1.0-0' }}</td>
                    <td
                      class="num mono"
                      [class.warn]="row.data.segmentCount > 1"
                      [class.bad]="row.data.segmentCount > 5"
                    >
                      {{ Math.max(row.data.segmentCount - 1, 0) }}
                    </td>
                    <td class="num mono small">
                      {{ row.data.largestSegmentCandles | number: '1.0-0' }} candles
                    </td>
                    <td
                      class="time"
                      [title]="
                        row.data.earliestTimestamp
                          ? (row.data.earliestTimestamp | date: 'yyyy-MM-dd HH:mm UTC')
                          : '—'
                      "
                    >
                      @if (row.data.earliestTimestamp) {
                        {{ row.data.earliestTimestamp | relativeTime }}
                      } @else {
                        <span class="muted">—</span>
                      }
                    </td>
                    <td
                      class="time"
                      [title]="
                        row.data.latestTimestamp
                          ? (row.data.latestTimestamp | date: 'yyyy-MM-dd HH:mm UTC')
                          : '—'
                      "
                    >
                      @if (row.data.latestTimestamp) {
                        {{ row.data.latestTimestamp | relativeTime }}
                      } @else {
                        <span class="muted">—</span>
                      }
                    </td>
                  } @else {
                    <td colspan="6" class="muted small">No data returned</td>
                  }
                </tr>
              }
            </tbody>
          </table>
        </section>

        @if (totalSegments() > 0) {
          <p class="hint muted small">
            <strong>Gap segments</strong> indicates how many non-contiguous candle runs the engine
            sees in the window. <code>0</code> = perfect coverage; anything higher means there's at
            least one missing range. Right-click a row's earliest/latest timestamp to copy.
          </p>
        }
      }
    </div>
  `,
  styles: [
    `
      .page {
        padding: var(--space-2) 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
      }
      .controls {
        display: grid;
        grid-template-columns: 1fr 1fr 1fr auto;
        gap: var(--space-3);
        align-items: end;
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-3) var(--space-4);
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .field span {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        font-weight: var(--font-medium);
      }
      .field input {
        padding: 8px 12px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-sm);
      }
      .field.tf .tf-pills {
        display: inline-flex;
        gap: 4px;
        background: var(--bg-primary);
        padding: 4px;
        border-radius: var(--radius-md);
      }
      .field.tf .tf-pills button {
        background: transparent;
        border: 1px solid transparent;
        padding: 4px 10px;
        border-radius: var(--radius-sm);
        font-size: var(--text-xs);
        color: var(--text-secondary);
        cursor: pointer;
        font-weight: var(--font-medium);
        font-family: var(--font-mono);
      }
      .field.tf .tf-pills button.active {
        background: var(--bg-secondary);
        color: var(--text-primary);
        box-shadow: var(--shadow-sm);
      }
      .date-pair .date-row {
        display: flex;
        gap: 6px;
        align-items: center;
      }
      .date-pair input {
        flex: 1;
      }
      .arrow {
        color: var(--text-tertiary);
      }
      .btn-primary {
        padding: 8px 18px;
        border-radius: var(--radius-sm);
        background: var(--accent);
        color: #fff;
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        border: none;
        cursor: pointer;
      }
      .btn-primary:disabled {
        background: var(--bg-tertiary, #d1d1d6);
        cursor: not-allowed;
      }
      .kpis {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
        gap: var(--space-3);
      }
      .card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--card-padding);
        box-shadow: var(--shadow-sm);
        overflow-x: auto;
      }
      .coverage-table {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-sm);
      }
      .coverage-table th,
      .coverage-table td {
        padding: 8px 10px;
        text-align: left;
        border-bottom: 1px solid var(--border);
        vertical-align: middle;
      }
      .coverage-table th {
        color: var(--text-secondary);
        font-weight: var(--font-medium);
        font-size: var(--text-xs);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .coverage-table td.num,
      .coverage-table th.num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .coverage-table tr.gappy {
        background: rgba(255, 149, 0, 0.04);
      }
      .coverage-table tr.error {
        background: rgba(255, 59, 48, 0.04);
      }
      .coverage-table tr.error td:first-child {
        border-left: 3px solid #d70015;
        padding-left: 8px;
      }
      .symbol {
        font-weight: var(--font-semibold);
      }
      .mono {
        font-family: var(--font-mono);
      }
      .muted {
        color: var(--text-tertiary);
      }
      .small {
        font-size: var(--text-xs);
      }
      .warn {
        color: #c93400;
      }
      .bad {
        color: #d70015;
        font-weight: var(--font-semibold);
      }
      .time {
        color: var(--text-secondary);
        font-size: var(--text-xs);
      }
      .error-msg {
        color: #d70015;
        font-size: var(--text-xs);
      }
      .hint {
        margin: 0;
      }
      code {
        font-family: var(--font-mono);
        background: var(--bg-secondary);
        padding: 1px 5px;
        border-radius: 4px;
      }
    `,
  ],
})
export class CoveragePageComponent {
  private readonly marketData = inject(MarketDataService);
  protected readonly TIMEFRAMES = TIMEFRAMES;
  protected readonly Math = Math;

  protected symbolsInput = 'EURUSD, GBPUSD, USDJPY';
  protected fromInput = '';
  protected toInput = '';
  protected readonly selectedTimeframes = signal<Timeframe[]>(['H1']);
  protected readonly running = signal(false);
  protected readonly results = signal<CoverageResult[]>([]);

  protected readonly resultsWithData = computed(() =>
    this.results().filter((r) => r.data !== null),
  );
  protected readonly failureCount = computed(
    () => this.results().filter((r) => r.error !== null).length,
  );
  protected readonly totalSegments = computed(() =>
    this.results().reduce((s, r) => s + (r.data ? Math.max(r.data.segmentCount - 1, 0) : 0), 0),
  );

  protected toggleTimeframe(tf: Timeframe): void {
    const cur = this.selectedTimeframes();
    if (cur.includes(tf)) this.selectedTimeframes.set(cur.filter((x) => x !== tf));
    else this.selectedTimeframes.set([...cur, tf]);
  }

  protected canRun(): boolean {
    return this.parsedSymbols().length > 0 && this.selectedTimeframes().length > 0;
  }

  protected parsedSymbols(): string[] {
    return this.symbolsInput
      .split(/[\s,]+/)
      .map((s) => s.trim().toUpperCase())
      .filter((s) => s.length > 0);
  }

  protected run(): void {
    if (!this.canRun() || this.running()) return;
    this.running.set(true);
    const symbols = this.parsedSymbols();
    const tfs = this.selectedTimeframes();
    const fromIso = this.fromInput ? new Date(this.fromInput).toISOString() : undefined;
    const toIso = this.toInput ? new Date(this.toInput).toISOString() : undefined;

    // Initial placeholder rows so the UI shows progress as results stream in.
    const initial: CoverageResult[] = symbols.flatMap((s) =>
      tfs.map((t) => ({ symbol: s, timeframe: t, data: null, error: null })),
    );
    this.results.set(initial);

    const total = initial.length;
    let done = 0;
    for (const symbol of symbols) {
      for (const timeframe of tfs) {
        this.marketData
          .getCandleCoverage(symbol, timeframe, fromIso, toIso)
          .pipe(
            map((res) => ({
              ok: res.status,
              data: res.data ?? null,
              message: res.message ?? null,
            })),
            catchError(() => of({ ok: false, data: null, message: 'Network or engine error.' })),
            finalize(() => {
              done++;
              if (done === total) this.running.set(false);
            }),
          )
          .subscribe((res) => {
            this.results.update((prev) =>
              prev.map((r) =>
                r.symbol === symbol && r.timeframe === timeframe
                  ? { ...r, data: res.data, error: res.ok ? null : (res.message ?? 'Failed') }
                  : r,
              ),
            );
          });
      }
    }
  }

  protected rowKey(r: CoverageResult): string {
    return `${r.symbol}|${r.timeframe}`;
  }
}
