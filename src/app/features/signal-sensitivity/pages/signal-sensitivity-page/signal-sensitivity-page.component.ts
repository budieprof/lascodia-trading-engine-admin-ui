import { Component, ChangeDetectionStrategy, computed, inject, signal } from '@angular/core';
import { CurrencyPipe, DatePipe, DecimalPipe, PercentPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { catchError, of } from 'rxjs';

import { SignalSensitivityService } from '@core/services/signal-sensitivity.service';
import {
  AnalyzeSignalSensitivityResultDto,
  AnalyzeSignalSensitivityAggregateDto,
} from '@core/api/api.types';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';

const SOURCES = ['SpotAnalysis', 'Strategy', 'Manual', 'SyntheticAnalyser'] as const;
const WINDOW_OPTIONS = [
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
  { label: '180d', days: 180 },
];

/**
 * Signal Sensitivity Analysis page. Lets the operator replay historic
 * TradeSignal rows under hypothetical (TP, SL) multipliers and see how
 * win-rate / P&L move. The TP-sweep chart shows the win-rate response
 * curve across a span of TP shrink/widen values; the per-signal table
 * shows each replay's outcome for drill-in.
 *
 * Backend at POST /trade-signal/sensitivity-analysis.
 */
@Component({
  selector: 'app-signal-sensitivity-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CurrencyPipe, DatePipe, DecimalPipe, PercentPipe, FormsModule, PageHeaderComponent],
  template: `
    <div class="page">
      <app-page-header
        title="Signal Sensitivity Analysis"
        subtitle="Replay historic signals against actual subsequent candles under hypothetical TP/SL multipliers"
      />

      <form class="filter-card" (ngSubmit)="run()">
        <div class="filter-row">
          <label class="field">
            <span>Window</span>
            <select [(ngModel)]="windowDays" name="windowDays">
              @for (w of windows; track w.days) {
                <option [ngValue]="w.days">{{ w.label }}</option>
              }
            </select>
          </label>
          <label class="field">
            <span>Symbol</span>
            <input
              type="text"
              maxlength="12"
              placeholder="any"
              [(ngModel)]="symbolFilter"
              name="symbol"
            />
          </label>
          <label class="field field--wide">
            <span>Sources</span>
            <div class="source-chips">
              @for (s of sourcesAvail; track s) {
                <label class="chip-checkbox">
                  <input
                    type="checkbox"
                    [checked]="selectedSources().includes(s)"
                    (change)="toggleSource(s)"
                  />
                  {{ s }}
                </label>
              }
            </div>
          </label>
        </div>
        <div class="filter-row">
          <label class="field">
            <span>TP Multiplier</span>
            <input
              type="number"
              step="0.05"
              min="0.05"
              max="3"
              [(ngModel)]="tpMultiplier"
              name="tpMultiplier"
            />
          </label>
          <label class="field">
            <span>SL Multiplier</span>
            <input
              type="number"
              step="0.05"
              min="0.05"
              max="3"
              [(ngModel)]="slMultiplier"
              name="slMultiplier"
            />
          </label>
          <label class="field field--wide">
            <span>TP Sweep (comma-separated)</span>
            <input
              type="text"
              [(ngModel)]="sweepInput"
              name="sweepInput"
              placeholder="0.5, 0.75, 1.0, 1.25, 1.5"
            />
          </label>
          <button type="submit" class="run-btn" [disabled]="loading()">
            {{ loading() ? 'Analysing…' : 'Analyse' }}
          </button>
        </div>
      </form>

      @if (errorMessage()) {
        <div class="status error">{{ errorMessage() }}</div>
      }

      @if (result(); as r) {
        <section class="window-meta">
          {{ r.fromUtc | date: 'short' }} → {{ r.toUtc | date: 'short' }} ·
          {{ r.signalCount | number }} signals
          @if (r.symbol) {
            · {{ r.symbol }}
          }
          @if (r.sources.length) {
            · sources: {{ r.sources.join(', ') }}
          }
          · TP×{{ r.tpMultiplier | number: '1.2-2' }} · SL×{{ r.slMultiplier | number: '1.2-2' }}
        </section>

        <!-- ── KPI strip for the operator's chosen point ─────────────────── -->
        <section class="kpi-grid">
          <div class="kpi">
            <div class="kpi-label">Win rate</div>
            <div
              class="kpi-value"
              [class.profit]="r.aggregate.winRatePct >= 50"
              [class.loss]="r.aggregate.winRatePct < 50"
            >
              {{ r.aggregate.winRatePct | number: '1.1-1' }}%
            </div>
            <div class="kpi-sub">{{ r.aggregate.winCount }} W / {{ r.aggregate.lossCount }} L</div>
          </div>
          <div class="kpi">
            <div class="kpi-label">Sum P&amp;L</div>
            <div
              class="kpi-value"
              [class.profit]="r.aggregate.sumPnL > 0"
              [class.loss]="r.aggregate.sumPnL < 0"
            >
              {{ r.aggregate.sumPnL | currency: 'USD' }}
            </div>
            <div class="kpi-sub">avg {{ r.aggregate.avgPnL | currency: 'USD' }}/sig</div>
          </div>
          <div class="kpi">
            <div class="kpi-label">Profit factor</div>
            <div class="kpi-value">{{ r.aggregate.profitFactor | number: '1.2-2' }}</div>
            <div class="kpi-sub">
              avg W {{ r.aggregate.avgWinPnL | currency: 'USD' }} / avg L
              {{ r.aggregate.avgLossPnL | currency: 'USD' }}
            </div>
          </div>
          <div class="kpi">
            <div class="kpi-label">Outcome mix</div>
            <div class="kpi-value">{{ r.aggregate.walkable | number }}</div>
            <div class="kpi-sub">
              {{ r.aggregate.hitTpCount }} TP / {{ r.aggregate.hitSlCount }} SL /
              {{ r.aggregate.expiredCount }} exp
              @if (r.aggregate.noCandlesCount > 0) {
                · {{ r.aggregate.noCandlesCount }} no-data
              }
            </div>
          </div>
        </section>

        <!-- ── TP sweep curve as a table + ASCII bar visual ───────────────── -->
        <section class="sweep-card">
          <h2>
            TP-multiplier sweep <small>(SL × {{ r.slMultiplier | number: '1.2-2' }})</small>
          </h2>
          <table class="sweep-table">
            <thead>
              <tr>
                <th>TP×</th>
                <th>Win rate</th>
                <th>Win curve</th>
                <th class="num">W</th>
                <th class="num">L</th>
                <th class="num">PF</th>
                <th class="num">Sum P&amp;L</th>
                <th class="num">Avg P&amp;L</th>
              </tr>
            </thead>
            <tbody>
              @for (row of r.tpSweep; track row.tpMultiplier) {
                <tr [class.row--active]="row.tpMultiplier === r.tpMultiplier">
                  <td>{{ row.tpMultiplier | number: '1.2-2' }}</td>
                  <td [class.profit]="row.winRatePct >= 50" [class.loss]="row.winRatePct < 50">
                    {{ row.winRatePct | number: '1.1-1' }}%
                  </td>
                  <td class="curve">
                    <div
                      class="curve-bar"
                      [style.width.%]="row.winRatePct"
                      [class.curve-bar--profit]="row.winRatePct >= 50"
                      [class.curve-bar--loss]="row.winRatePct < 50"
                    ></div>
                  </td>
                  <td class="num">{{ row.winCount | number }}</td>
                  <td class="num">{{ row.lossCount | number }}</td>
                  <td class="num">{{ row.profitFactor | number: '1.2-2' }}</td>
                  <td class="num" [class.profit]="row.sumPnL > 0" [class.loss]="row.sumPnL < 0">
                    {{ row.sumPnL | currency: 'USD' }}
                  </td>
                  <td class="num">{{ row.avgPnL | currency: 'USD' }}</td>
                </tr>
              }
            </tbody>
          </table>
        </section>

        <!-- ── Per-signal table ────────────────────────────────────────────── -->
        <section class="signals-card">
          <h2>
            Per-signal outcomes <small>({{ r.signals.length }} of {{ r.signalCount }})</small>
          </h2>
          <div class="table-scroll">
            <table class="signal-table">
              <thead>
                <tr>
                  <th>Id</th>
                  <th>Time</th>
                  <th>Symbol</th>
                  <th>Source</th>
                  <th>Dir</th>
                  <th class="num">Entry</th>
                  <th class="num">SL</th>
                  <th class="num">TP</th>
                  <th>Outcome</th>
                  <th class="num">Exit</th>
                  <th class="num">P&amp;L</th>
                </tr>
              </thead>
              <tbody>
                @for (s of r.signals; track s.signalId) {
                  <tr [class.row--win]="s.scenarioPnL > 0" [class.row--loss]="s.scenarioPnL < 0">
                    <td>{{ s.signalId }}</td>
                    <td>{{ s.generatedAt | date: 'short' }}</td>
                    <td>{{ s.symbol }}</td>
                    <td>{{ s.source }}</td>
                    <td>{{ s.direction }}</td>
                    <td class="num">{{ s.entryPrice | number: '1.5-5' }}</td>
                    <td class="num">{{ s.originalSL | number: '1.5-5' }}</td>
                    <td class="num">{{ s.originalTP | number: '1.5-5' }}</td>
                    <td>
                      <span
                        class="outcome-chip"
                        [class.chip--tp]="s.outcome === 'HitTP'"
                        [class.chip--sl]="s.outcome === 'HitSL'"
                        [class.chip--exp]="s.outcome === 'Expired'"
                      >
                        {{ s.outcome }}
                      </span>
                    </td>
                    <td class="num">
                      {{ s.exitPrice !== null ? (s.exitPrice | number: '1.5-5') : '—' }}
                    </td>
                    <td
                      class="num"
                      [class.profit]="s.scenarioPnL > 0"
                      [class.loss]="s.scenarioPnL < 0"
                    >
                      {{ s.scenarioPnL | currency: 'USD' }}
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </section>
      } @else if (loading()) {
        <div class="status">Analysing…</div>
      } @else {
        <div class="status hint">
          Pick filters + multipliers, then press <b>Analyse</b>. The query replays each matching
          signal against actual candles between its <code>GeneratedAt</code> and
          <code>ExpiresAt</code>, applying your TP/SL multipliers to compute the outcome.
        </div>
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
      .filter-card {
        background: var(--card-bg, #1a1f2b);
        border: 1px solid var(--border, #2a2f3a);
        border-radius: 8px;
        padding: 1rem;
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
      }
      .filter-row {
        display: flex;
        gap: 1rem;
        flex-wrap: wrap;
        align-items: flex-end;
      }
      .field {
        display: inline-flex;
        flex-direction: column;
        gap: 4px;
        font-size: 0.85rem;
      }
      .field--wide {
        flex: 1 1 240px;
      }
      .field input,
      .field select {
        padding: 0.35rem 0.5rem;
        background: transparent;
        color: inherit;
        border: 1px solid var(--border, #2a2f3a);
        border-radius: 4px;
        min-width: 90px;
      }
      .source-chips {
        display: flex;
        gap: 0.5rem;
        flex-wrap: wrap;
      }
      .chip-checkbox {
        display: inline-flex;
        align-items: center;
        gap: 0.25rem;
        padding: 0.2rem 0.5rem;
        border: 1px solid var(--border, #2a2f3a);
        border-radius: 9999px;
        font-size: 0.8rem;
        cursor: pointer;
      }
      .run-btn {
        background: var(--accent, #4f8cff);
        color: #fff;
        border: none;
        padding: 0.5rem 1.25rem;
        border-radius: 4px;
        cursor: pointer;
        font-weight: 600;
      }
      .run-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .status {
        padding: 0.75rem;
        opacity: 0.8;
        font-size: 0.9rem;
      }
      .status.error {
        color: #f66;
      }
      .status.hint code {
        background: rgba(255, 255, 255, 0.06);
        padding: 0.05rem 0.3rem;
        border-radius: 3px;
      }
      .window-meta {
        font-size: 0.85rem;
        opacity: 0.7;
      }

      .kpi-grid {
        display: grid;
        gap: 1rem;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      }
      .kpi {
        background: var(--card-bg, #1a1f2b);
        border: 1px solid var(--border, #2a2f3a);
        border-radius: 8px;
        padding: 0.75rem 1rem;
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
      }
      .kpi-label {
        font-size: 0.75rem;
        opacity: 0.7;
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .kpi-value {
        font-size: 1.6rem;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
      }
      .kpi-sub {
        font-size: 0.75rem;
        opacity: 0.7;
      }
      .profit {
        color: #4fd1c5;
      }
      .loss {
        color: #ff7a7a;
      }

      .sweep-card,
      .signals-card {
        background: var(--card-bg, #1a1f2b);
        border: 1px solid var(--border, #2a2f3a);
        border-radius: 8px;
        padding: 0.75rem 1rem;
      }
      .sweep-card h2,
      .signals-card h2 {
        margin: 0 0 0.5rem 0;
        font-size: 1rem;
        font-weight: 600;
      }
      .sweep-card small,
      .signals-card small {
        font-weight: 400;
        opacity: 0.7;
        margin-left: 0.5rem;
      }
      .sweep-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 0.85rem;
      }
      .sweep-table th,
      .sweep-table td {
        padding: 0.35rem 0.5rem;
        text-align: left;
        border-bottom: 1px solid rgba(255, 255, 255, 0.04);
      }
      .sweep-table th.num,
      .sweep-table td.num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .sweep-table tr.row--active {
        background: rgba(79, 140, 255, 0.08);
      }
      .curve {
        width: 200px;
      }
      .curve-bar {
        height: 12px;
        border-radius: 6px;
      }
      .curve-bar--profit {
        background: rgba(79, 209, 197, 0.6);
      }
      .curve-bar--loss {
        background: rgba(255, 122, 122, 0.6);
      }

      .table-scroll {
        overflow-x: auto;
        max-height: 60vh;
      }
      .signal-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 0.85rem;
      }
      .signal-table th,
      .signal-table td {
        padding: 0.3rem 0.5rem;
        text-align: left;
        border-bottom: 1px solid rgba(255, 255, 255, 0.04);
        white-space: nowrap;
      }
      .signal-table th.num,
      .signal-table td.num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .signal-table tr.row--win td {
        background: rgba(79, 209, 197, 0.04);
      }
      .signal-table tr.row--loss td {
        background: rgba(255, 122, 122, 0.04);
      }

      .outcome-chip {
        font-size: 0.7rem;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        padding: 0.1rem 0.4rem;
        border-radius: 3px;
        background: rgba(255, 255, 255, 0.06);
      }
      .chip--tp {
        background: rgba(79, 209, 197, 0.18);
        color: #4fd1c5;
      }
      .chip--sl {
        background: rgba(255, 122, 122, 0.18);
        color: #ff7a7a;
      }
      .chip--exp {
        background: rgba(160, 160, 160, 0.18);
        color: #aaa;
      }
    `,
  ],
})
export class SignalSensitivityPageComponent {
  private readonly svc = inject(SignalSensitivityService);

  readonly sourcesAvail = SOURCES;
  readonly windows = WINDOW_OPTIONS;

  readonly windowDays = signal<number>(30);
  readonly symbolFilter = signal<string>('');
  readonly selectedSources = signal<string[]>(['SpotAnalysis']);
  readonly tpMultiplier = signal<number>(1.0);
  readonly slMultiplier = signal<number>(1.0);
  readonly sweepInput = signal<string>('0.5, 0.75, 1.0, 1.25, 1.5');

  readonly loading = signal(false);
  readonly errorMessage = signal<string | null>(null);
  readonly result = signal<AnalyzeSignalSensitivityResultDto | null>(null);

  toggleSource(s: string) {
    const current = this.selectedSources();
    this.selectedSources.set(
      current.includes(s) ? current.filter((x) => x !== s) : [...current, s],
    );
  }

  run() {
    if (this.loading()) return;
    this.loading.set(true);
    this.errorMessage.set(null);

    const now = new Date();
    const fromUtc = new Date(now.getTime() - this.windowDays() * 24 * 60 * 60 * 1000);

    const sweep = this.sweepInput()
      .split(',')
      .map((v) => parseFloat(v.trim()))
      .filter((n) => !isNaN(n) && n > 0);

    this.svc
      .analyze({
        sources: this.selectedSources().length ? this.selectedSources() : undefined,
        symbol: this.symbolFilter().trim() || undefined,
        fromUtc: fromUtc.toISOString(),
        toUtc: now.toISOString(),
        tpMultiplier: this.tpMultiplier(),
        slMultiplier: this.slMultiplier(),
        tpSweepValues: sweep.length ? sweep : undefined,
        signalDetailCap: 200,
      })
      .pipe(
        catchError((err) => {
          this.errorMessage.set(err?.message ?? 'Sensitivity query failed.');
          return of(null);
        }),
      )
      .subscribe((res) => {
        this.loading.set(false);
        if (res?.status && res.data) this.result.set(res.data);
        else if (res && !res.status)
          this.errorMessage.set(res.message ?? 'Query returned failure.');
      });
  }
}
