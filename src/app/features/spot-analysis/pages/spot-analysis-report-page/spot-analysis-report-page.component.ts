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
import { catchError, of } from 'rxjs';

import { SpotAnalysisService } from '@core/services/spot-analysis.service';
import { SpotAnalysisListItemDto } from '@core/api/api.types';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';

/** Rolling-window options for the report. */
const WINDOWS: { label: string; hours: number }[] = [
  { label: '24h', hours: 24 },
  { label: '7d', hours: 168 },
  { label: '30d', hours: 720 },
  { label: 'All', hours: 0 },
];

/**
 * Spot Analysis Report — a dense ledger of every `market_analysis.spot` run
 * with the trade outcomes attributed to it: recommendations emitted, signals
 * generated, positions opened, and the realised/unrealised P&L of those
 * positions. One fetch of the most recent runs in the chosen window; KPIs are
 * rolled up client-side so they always match the table.
 */
@Component({
  selector: 'app-spot-analysis-report-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CurrencyPipe,
    DatePipe,
    DecimalPipe,
    FormsModule,
    PageHeaderComponent,
    MetricCardComponent,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Spot Analysis Report"
        subtitle="Every LLM spot analysis with its recommendations, generated signals, and attributed trade P&L"
      >
        <div class="header-controls">
          <div class="chip-group" role="tablist" aria-label="Time window">
            @for (w of windows; track w.hours) {
              <button
                type="button"
                class="chip"
                [class.active]="windowHours() === w.hours"
                (click)="setWindow(w.hours)"
              >
                {{ w.label }}
              </button>
            }
          </div>
          <input
            type="search"
            class="input"
            placeholder="Symbol filter…"
            [ngModel]="symbolFilter()"
            (ngModelChange)="onSymbolFilter($event)"
          />
          <button class="btn" type="button" (click)="load()" [disabled]="loading()">
            {{ loading() ? 'Loading…' : 'Refresh' }}
          </button>
        </div>
      </app-page-header>

      <!-- KPI strip -->
      <div class="kpi-grid">
        <app-metric-card label="Analyses" [value]="kpiCount()" format="number" dotColor="#0071E3" />
        <app-metric-card
          label="LLM spend"
          [value]="kpiCost()"
          format="currency"
          dotColor="#FF9500"
        />
        <app-metric-card
          label="Avg latency (s)"
          [value]="kpiAvgLatency()"
          format="number"
          dotColor="#8E8E93"
        />
        <app-metric-card
          label="Signals created"
          [value]="kpiSignals()"
          format="number"
          dotColor="#34C759"
        />
        <app-metric-card
          label="Positions opened"
          [value]="kpiPositions()"
          format="number"
          dotColor="#5856D6"
        />
        <app-metric-card
          label="Realized P&L"
          [value]="kpiRealized()"
          format="currency"
          [colorByValue]="true"
        />
        <app-metric-card
          label="Unrealized P&L"
          [value]="kpiUnrealized()"
          format="currency"
          [colorByValue]="true"
        />
        <app-metric-card
          label="Total P&L"
          [value]="kpiTotal()"
          format="currency"
          [colorByValue]="true"
        />
      </div>

      @if (error(); as e) {
        <div class="error-banner">{{ e }}</div>
      }

      <!-- Dense ledger -->
      <div class="table-wrap">
        <table class="dense">
          <thead>
            <tr>
              <th>Time</th>
              <th>Symbol</th>
              <th>TF</th>
              <th>Bar</th>
              <th>Model</th>
              <th class="num">Latency</th>
              <th class="num">Cost</th>
              <th class="num">Tokens</th>
              <th>Outcome</th>
              <th class="num">Recs</th>
              <th class="num">Signals</th>
              <th class="num">Positions</th>
              <th class="num">Realized</th>
              <th class="num">Unrealized</th>
              <th class="num">Total P&L</th>
              <th class="num">Exits</th>
            </tr>
          </thead>
          <tbody>
            @for (r of visibleRows(); track r.id) {
              <tr (click)="selectedDetail.set(r)" class="row">
                <td class="mono">{{ r.invokedAt | date: 'MMM d, HH:mm' }}</td>
                <td class="strong">{{ r.symbol }}</td>
                <td>{{ r.timeframe }}</td>
                <td class="muted">{{ r.barPosition }}</td>
                <td class="muted ellipsis">{{ r.model }}</td>
                <td class="num mono">{{ r.latencyMs / 1000 | number: '1.0-1' }}s</td>
                <td class="num mono">{{ r.costUsd | currency: 'USD' : 'symbol' : '1.4-4' }}</td>
                <td class="num mono muted">{{ r.tokensInput }}/{{ r.tokensOutput }}</td>
                <td>
                  <span class="chip-outcome" [class.bad]="r.outcome !== 'Ok'">{{ r.outcome }}</span>
                </td>
                <td class="num mono">{{ r.recommendationCount }}</td>
                <td class="num mono">
                  {{ r.signalsCreated }}
                  @if (r.signalsRejected > 0) {
                    <span class="sub loss">({{ r.signalsRejected }} rej)</span>
                  }
                </td>
                <td class="num mono">
                  {{ r.positionsOpened }}
                  @if (r.positionsClosed > 0) {
                    <span class="sub muted">({{ r.positionsClosed }} closed)</span>
                  }
                </td>
                <td
                  class="num mono"
                  [class.profit]="r.realizedPnl > 0"
                  [class.loss]="r.realizedPnl < 0"
                >
                  {{ r.realizedPnl | currency: 'USD' : 'symbol' : '1.2-2' }}
                </td>
                <td
                  class="num mono"
                  [class.profit]="r.unrealizedPnl > 0"
                  [class.loss]="r.unrealizedPnl < 0"
                >
                  {{ r.unrealizedPnl | currency: 'USD' : 'symbol' : '1.2-2' }}
                </td>
                <td
                  class="num mono strong"
                  [class.profit]="r.totalPnl > 0"
                  [class.loss]="r.totalPnl < 0"
                >
                  {{ r.totalPnl | currency: 'USD' : 'symbol' : '1.2-2' }}
                </td>
                <td class="num mono muted">
                  {{ r.exitInstructionsExecuted }}/{{ r.exitInstructionCount }}
                </td>
              </tr>
            } @empty {
              <tr>
                <td colspan="16" class="empty">
                  {{ loading() ? 'Loading…' : 'No spot analyses in this window.' }}
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
      <p class="row-count muted">{{ visibleRows().length }} of {{ rows().length }} analyses</p>
    </div>

    <!-- Detail drawer -->
    @if (selectedDetail(); as d) {
      <div class="drawer-backdrop" (click)="selectedDetail.set(null)">
        <aside class="drawer" (click)="$event.stopPropagation()" aria-label="Analysis detail">
          <header class="drawer-head">
            <div>
              <h3>{{ d.symbol }} · {{ d.timeframe }}</h3>
              <span class="muted">
                {{ d.invokedAt | date: 'MMM d, y HH:mm:ss' }} · audit #{{ d.id }}
              </span>
            </div>
            <button class="btn-close" (click)="selectedDetail.set(null)" aria-label="Close">
              ×
            </button>
          </header>

          <section class="drawer-section">
            <h4>Analysis</h4>
            <dl class="drawer-grid">
              <div>
                <dt>Bar position</dt>
                <dd>{{ d.barPosition }}</dd>
              </div>
              <div>
                <dt>Provider / model</dt>
                <dd class="mono">{{ d.provider }} / {{ d.model }}</dd>
              </div>
              <div>
                <dt>Latency</dt>
                <dd class="mono">{{ d.latencyMs | number }} ms</dd>
              </div>
              <div>
                <dt>Outcome</dt>
                <dd>{{ d.outcome }}</dd>
              </div>
              <div>
                <dt>Tokens in / out</dt>
                <dd class="mono">{{ d.tokensInput }} / {{ d.tokensOutput }}</dd>
              </div>
              <div>
                <dt>LLM cost</dt>
                <dd class="mono">{{ d.costUsd | currency: 'USD' : 'symbol' : '1.4-4' }}</dd>
              </div>
            </dl>
          </section>

          <section class="drawer-section">
            <h4>Recommendations & signals</h4>
            <dl class="drawer-grid">
              <div>
                <dt>Recommendations emitted</dt>
                <dd class="mono">{{ d.recommendationCount }}</dd>
              </div>
              <div>
                <dt>Signals created</dt>
                <dd class="mono">{{ d.signalsCreated }}</dd>
              </div>
              <div>
                <dt>Approved</dt>
                <dd class="mono">{{ d.signalsApproved }}</dd>
              </div>
              <div>
                <dt>Rejected</dt>
                <dd class="mono">{{ d.signalsRejected }}</dd>
              </div>
            </dl>
          </section>

          <section class="drawer-section">
            <h4>Trade outcomes</h4>
            <dl class="drawer-grid">
              <div>
                <dt>Positions opened</dt>
                <dd class="mono">{{ d.positionsOpened }}</dd>
              </div>
              <div>
                <dt>Positions closed</dt>
                <dd class="mono">{{ d.positionsClosed }}</dd>
              </div>
              <div>
                <dt>Realized P&L</dt>
                <dd
                  class="mono"
                  [class.profit]="d.realizedPnl > 0"
                  [class.loss]="d.realizedPnl < 0"
                >
                  {{ d.realizedPnl | currency: 'USD' : 'symbol' : '1.2-2' }}
                </dd>
              </div>
              <div>
                <dt>Unrealized P&L</dt>
                <dd
                  class="mono"
                  [class.profit]="d.unrealizedPnl > 0"
                  [class.loss]="d.unrealizedPnl < 0"
                >
                  {{ d.unrealizedPnl | currency: 'USD' : 'symbol' : '1.2-2' }}
                </dd>
              </div>
              <div>
                <dt>Total P&L</dt>
                <dd
                  class="mono strong"
                  [class.profit]="d.totalPnl > 0"
                  [class.loss]="d.totalPnl < 0"
                >
                  {{ d.totalPnl | currency: 'USD' : 'symbol' : '1.2-2' }}
                </dd>
              </div>
            </dl>
          </section>

          <section class="drawer-section">
            <h4>LLM position management</h4>
            <dl class="drawer-grid">
              <div>
                <dt>Exit instructions emitted</dt>
                <dd class="mono">{{ d.exitInstructionCount }}</dd>
              </div>
              <div>
                <dt>Executed</dt>
                <dd class="mono">{{ d.exitInstructionsExecuted }}</dd>
              </div>
            </dl>
          </section>
        </aside>
      </div>
    }
  `,
  styles: [
    `
      .page {
        padding: var(--space-5);
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
      }
      .header-controls {
        display: flex;
        align-items: center;
        gap: var(--space-3);
        flex-wrap: wrap;
      }
      .chip-group {
        display: inline-flex;
        gap: 2px;
        background: var(--bg-tertiary);
        border-radius: var(--radius-sm);
        padding: 2px;
      }
      .chip {
        border: 0;
        background: transparent;
        color: var(--text-secondary);
        font-size: var(--text-xs);
        padding: 4px 10px;
        border-radius: var(--radius-sm);
        cursor: pointer;
      }
      .chip.active {
        background: var(--bg-primary);
        color: var(--text-primary);
        font-weight: var(--font-semibold);
      }
      .input {
        padding: 5px 10px;
        font-size: var(--text-xs);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        color: var(--text-primary);
      }
      .btn {
        padding: 5px 12px;
        font-size: var(--text-xs);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-tertiary);
        color: var(--text-primary);
        cursor: pointer;
      }
      .kpi-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
        gap: var(--space-3);
      }
      .error-banner {
        padding: var(--space-3);
        border: 1px solid #ff3b30;
        border-radius: var(--radius-sm);
        background: rgba(255, 59, 48, 0.08);
        color: #ff3b30;
        font-size: var(--text-sm);
      }
      .table-wrap {
        overflow-x: auto;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
      }
      table.dense {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-xs);
      }
      table.dense thead th {
        position: sticky;
        top: 0;
        background: var(--bg-tertiary);
        color: var(--text-tertiary);
        text-align: left;
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        font-size: 10px;
        padding: 6px 10px;
        white-space: nowrap;
        border-bottom: 1px solid var(--border);
      }
      table.dense th.num,
      table.dense td.num {
        text-align: right;
      }
      table.dense td {
        padding: 5px 10px;
        border-bottom: 1px solid var(--border);
        color: var(--text-primary);
        white-space: nowrap;
      }
      tr.row {
        cursor: pointer;
      }
      tr.row:hover td {
        background: var(--bg-tertiary);
      }
      .mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-variant-numeric: tabular-nums;
      }
      .strong {
        font-weight: var(--font-semibold);
      }
      .muted {
        color: var(--text-tertiary);
      }
      .ellipsis {
        max-width: 130px;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .profit {
        color: var(--profit, #16a34a);
      }
      .loss {
        color: var(--loss, #dc2626);
      }
      .sub {
        font-size: 10px;
        margin-left: 3px;
      }
      .chip-outcome {
        font-size: 10px;
        padding: 1px 6px;
        border-radius: var(--radius-sm);
        background: rgba(52, 199, 89, 0.14);
        color: #16a34a;
      }
      .chip-outcome.bad {
        background: rgba(255, 59, 48, 0.14);
        color: #dc2626;
      }
      .empty {
        text-align: center;
        padding: var(--space-5);
        color: var(--text-tertiary);
      }
      .row-count {
        font-size: var(--text-xs);
        margin: 0;
      }
      /* Drawer */
      .drawer-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.4);
        display: flex;
        justify-content: flex-end;
        z-index: 1000;
      }
      .drawer {
        width: 420px;
        max-width: 90vw;
        height: 100%;
        background: var(--bg-primary);
        border-left: 1px solid var(--border);
        overflow-y: auto;
        padding: var(--space-4);
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
      }
      .drawer-head {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
      }
      .drawer-head h3 {
        margin: 0;
        font-size: var(--text-base);
      }
      .drawer-head .muted {
        font-size: var(--text-xs);
      }
      .btn-close {
        border: 0;
        background: transparent;
        font-size: 22px;
        line-height: 1;
        color: var(--text-tertiary);
        cursor: pointer;
      }
      .drawer-section h4 {
        margin: 0 0 var(--space-2);
        font-size: var(--text-xs);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-tertiary);
      }
      .drawer-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--space-2) var(--space-3);
        margin: 0;
      }
      .drawer-grid dt {
        font-size: 10px;
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.03em;
      }
      .drawer-grid dd {
        margin: 2px 0 0;
        font-size: var(--text-sm);
        color: var(--text-primary);
      }
    `,
  ],
})
export class SpotAnalysisReportPageComponent implements OnInit {
  private readonly service = inject(SpotAnalysisService);

  readonly windows = WINDOWS;
  readonly windowHours = signal(168); // 7d default
  readonly symbolFilter = signal('');
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly rows = signal<SpotAnalysisListItemDto[]>([]);
  readonly selectedDetail = signal<SpotAnalysisListItemDto | null>(null);

  /** Client-side symbol narrowing on top of the server-fetched window. */
  readonly visibleRows = computed(() => {
    const q = this.symbolFilter().trim().toUpperCase();
    const all = this.rows();
    return q ? all.filter((r) => r.symbol.toUpperCase().includes(q)) : all;
  });

  // ── KPI roll-ups (over the visible rows so they always match the table) ──
  readonly kpiCount = computed(() => this.visibleRows().length);
  readonly kpiCost = computed(() => this.sum((r) => r.costUsd));
  readonly kpiAvgLatency = computed(() => {
    const rows = this.visibleRows();
    if (rows.length === 0) return 0;
    return this.sum((r) => r.latencyMs) / rows.length / 1000;
  });
  readonly kpiSignals = computed(() => this.sum((r) => r.signalsCreated));
  readonly kpiPositions = computed(() => this.sum((r) => r.positionsOpened));
  readonly kpiRealized = computed(() => this.sum((r) => r.realizedPnl));
  readonly kpiUnrealized = computed(() => this.sum((r) => r.unrealizedPnl));
  readonly kpiTotal = computed(() => this.sum((r) => r.totalPnl));

  private sum(pick: (r: SpotAnalysisListItemDto) => number): number {
    return this.visibleRows().reduce((acc, r) => acc + (pick(r) ?? 0), 0);
  }

  ngOnInit(): void {
    this.load();
  }

  setWindow(hours: number): void {
    if (this.windowHours() === hours) return;
    this.windowHours.set(hours);
    this.load();
  }

  onSymbolFilter(value: string): void {
    // Pure client-side narrowing — no refetch; visibleRows recomputes.
    this.symbolFilter.set(value);
  }

  load(): void {
    this.loading.set(true);
    this.error.set(null);

    const hours = this.windowHours();
    const filter: Record<string, unknown> = {};
    if (hours > 0) {
      filter['from'] = new Date(Date.now() - hours * 3_600_000).toISOString();
    }

    this.service
      .list({ currentPage: 1, itemCountPerPage: 200, filter })
      .pipe(
        catchError((err) => {
          this.error.set(err?.error?.message ?? err?.message ?? 'Failed to load spot analyses.');
          return of(null);
        }),
      )
      .subscribe((res) => {
        this.loading.set(false);
        if (res?.status && res.data) {
          this.rows.set(res.data.data ?? []);
        } else if (res && !res.status) {
          this.error.set(res.message ?? 'Failed to load spot analyses.');
          this.rows.set([]);
        }
      });
  }
}
