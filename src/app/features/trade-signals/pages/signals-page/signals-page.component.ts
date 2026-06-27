import {
  Component,
  ChangeDetectionStrategy,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe, DecimalPipe } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { ColDef } from 'ag-grid-community';
import type { EChartsOption } from 'echarts';
import { catchError, map, of, throttleTime } from 'rxjs';

import { TradeSignalsService } from '@core/services/trade-signals.service';
import { NotificationService } from '@core/notifications/notification.service';
import { RealtimeService } from '@core/realtime/realtime.service';
import type {
  TradeSignalDto,
  PagedData,
  PagerRequest,
  TradeSignalStatus,
  TradeDirection,
} from '@core/api/api.types';

import { DataTableComponent } from '@shared/components/data-table/data-table.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';
import { CreateSignalDialogComponent } from '../../components/create-signal-dialog/create-signal-dialog.component';
import {
  SpotRecChartComponent,
  SpotRecChartRec,
} from '@shared/components/spot-rec-chart/spot-rec-chart.component';
import { ParkedRecsCockpitComponent } from '@features/pending-signal-recs/components/parked-recs-cockpit/parked-recs-cockpit.component';

type StatusChip = 'all' | TradeSignalStatus;
type DirectionChip = 'all' | TradeDirection;

@Component({
  selector: 'app-signals-page',
  standalone: true,
  imports: [
    FormsModule,
    DatePipe,
    DecimalPipe,
    DataTableComponent,
    PageHeaderComponent,
    MetricCardComponent,
    ChartCardComponent,
    ConfirmDialogComponent,
    CreateSignalDialogComponent,
    RelativeTimePipe,
    SpotRecChartComponent,
    ParkedRecsCockpitComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <app-page-header
        title="Trade Signals"
        subtitle="Review pending signals, monitor strategy output, and act on the queue"
      >
        <button class="btn btn-primary" type="button" (click)="showCreateDialog.set(true)">
          + Create signal
        </button>
      </app-page-header>

      @if (showCreateDialog()) {
        <app-create-signal-dialog
          (closed)="showCreateDialog.set(false)"
          (created)="onSignalCreated()"
        />
      }

      <!-- View tabs — main signals queue vs. parked LLM recs awaiting touch -->
      <nav class="view-tabs" role="tablist" aria-label="Signals view">
        <button
          type="button"
          role="tab"
          class="view-tab"
          [class.active]="view() === 'signals'"
          (click)="view.set('signals')"
          [attr.aria-selected]="view() === 'signals'"
        >
          Signals
        </button>
        <button
          type="button"
          role="tab"
          class="view-tab"
          [class.active]="view() === 'parked'"
          (click)="view.set('parked')"
          [attr.aria-selected]="view() === 'parked'"
        >
          Parked recs
        </button>
      </nav>

      @if (view() === 'parked') {
        <app-parked-recs-cockpit />
      } @else {
        <!-- KPI strip (6 dense tiles) -->
        <div class="kpi-grid">
          <app-metric-card
            label="Pending now"
            [value]="pendingCount()"
            format="number"
            [dotColor]="pendingCount() > 0 ? '#FF9500' : '#34C759'"
          />
          <app-metric-card
            label="Approved today"
            [value]="approvedToday()"
            format="number"
            dotColor="#34C759"
          />
          <app-metric-card
            label="Rejected today"
            [value]="rejectedToday()"
            format="number"
            dotColor="#FF3B30"
          />
          <app-metric-card
            label="Expired today"
            [value]="expiredToday()"
            format="number"
            dotColor="#8E8E93"
          />
          <app-metric-card
            label="Avg confidence (pending)"
            [value]="avgPendingConfidence() * 100"
            format="percent"
            dotColor="#0071E3"
          />
          <app-metric-card
            label="ML disagreements (24h)"
            [value]="mlDisagreementCount()"
            format="number"
            [dotColor]="mlDisagreementCount() > 0 ? '#AF52DE' : '#8E8E93'"
          />
        </div>

        <!-- Filter row -->
        <div class="filter-row">
          <div class="chip-group" role="tablist" aria-label="Filter by status">
            @for (s of statusChips; track s) {
              <button
                type="button"
                role="tab"
                class="chip"
                [attr.data-status]="s === 'all' ? null : s"
                [class.active]="statusFilter() === s"
                (click)="statusFilter.set(s)"
                [attr.aria-selected]="statusFilter() === s"
              >
                {{ s === 'all' ? 'All' : s }}
                <span class="chip-count">{{ statusCount(s) }}</span>
              </button>
            }
          </div>

          <div class="chip-group" role="tablist" aria-label="Filter by direction">
            @for (d of directionChips; track d) {
              <button
                type="button"
                role="tab"
                class="chip"
                [class.active]="directionFilter() === d"
                [class.buy]="d === 'Buy'"
                [class.sell]="d === 'Sell'"
                (click)="directionFilter.set(d)"
                [attr.aria-selected]="directionFilter() === d"
              >
                {{ d === 'all' ? 'All directions' : d }}
              </button>
            }
          </div>

          <input
            type="search"
            class="input search"
            placeholder="Symbol or ID…"
            [ngModel]="symbolFilter()"
            (ngModelChange)="symbolFilter.set($event)"
          />

          <label class="toggle">
            <input
              type="checkbox"
              [checked]="mlDisagreementOnly()"
              (change)="mlDisagreementOnly.set($any($event.target).checked)"
            />
            <span>ML disagrees only</span>
          </label>

          <span class="muted">{{ visibleSignals().length }} of {{ recentSignals().length }}</span>
        </div>

        <!-- Charts row -->
        <div class="charts-row">
          <app-chart-card
            title="Signal Flow (24h)"
            subtitle="Hourly count by terminal status"
            [options]="hourlyVolumeChart()"
            height="220px"
            [loading]="metricsLoading()"
          />
          <app-chart-card
            title="By Symbol"
            subtitle="Last 24h, count by direction"
            [options]="bySymbolChart()"
            height="220px"
            [loading]="metricsLoading()"
          />
        </div>

        <!-- Comprehensive table -->
        <app-data-table [columnDefs]="columns" [fetchData]="fetchData" [selectable]="true">
          <ng-template #bulkActions let-rows>
            <button class="btn btn-success" (click)="bulkApprove(rows)" [disabled]="processing()">
              Approve {{ pendingInSelection(rows) }} pending
            </button>
            <button class="btn btn-danger" (click)="bulkReject(rows)" [disabled]="processing()">
              Reject {{ pendingInSelection(rows) }} pending
            </button>
          </ng-template>
        </app-data-table>
      }

      <!-- Detail modal -->
      @if (selectedDetail(); as s) {
        <div class="drawer-backdrop" (click)="selectedDetail.set(null)">
          <aside class="drawer" (click)="$event.stopPropagation()" aria-label="Signal details">
            <header class="drawer-head">
              <div class="head-titles">
                <h2 class="head-title">
                  <span class="signal-id">Signal #{{ s.id }}</span>
                  <span class="symbol">{{ s.symbol }}</span>
                  <span
                    class="dir-chip"
                    [class.dir-chip--buy]="s.direction === 'Buy'"
                    [class.dir-chip--sell]="s.direction === 'Sell'"
                  >
                    {{ s.direction === 'Buy' ? '↑ Buy' : '↓ Sell' }}
                  </span>
                  <span
                    class="status-chip"
                    [class.status-chip--pending]="s.status === 'Pending'"
                    [class.status-chip--approved]="s.status === 'Approved'"
                    [class.status-chip--rejected]="s.status === 'Rejected'"
                    [class.status-chip--executed]="s.status === 'Executed'"
                    [class.status-chip--expired]="s.status === 'Expired'"
                  >
                    {{ s.status }}
                  </span>
                </h2>
                <div class="head-sub">
                  Generated {{ s.generatedAt | date: 'MMM d, HH:mm' }} UTC · expires
                  {{ s.expiresAt | date: 'MMM d, HH:mm' }} UTC
                </div>
              </div>
              <button class="btn-close" (click)="selectedDetail.set(null)" aria-label="Close">
                ×
              </button>
            </header>

            <!-- Chart pane — Entry / SL / TP visualised over the bar window
                 straddling generatedAt. Renders only when the signal has the
                 minimum data needed (symbol + entry/SL/TP triple). Uses the
                 shared SpotRecChart component (same one the Spot Analysis
                 Report drawer + Signal Detail page use); timeframe defaults
                 to H1 because the TradeSignalDto doesn't carry one today. -->
            @if (canChart(s)) {
              <section class="drawer-section">
                <h4>Chart</h4>
                <app-spot-rec-chart
                  [symbol]="s.symbol ?? ''"
                  [timeframe]="'H1'"
                  [asOfUtc]="s.generatedAt"
                  [recommendations]="chartRecsFor(s)"
                />
              </section>
            }

            <section class="drawer-section">
              <h4>Pricing</h4>
              <dl class="drawer-grid">
                <div>
                  <dt>Entry</dt>
                  <dd class="mono">{{ s.entryPrice | number: '1.4-5' }}</dd>
                </div>
                <div>
                  <dt>Stop loss</dt>
                  <dd class="mono">
                    {{ s.stopLoss !== null ? (s.stopLoss | number: '1.4-5') : '—' }}
                  </dd>
                </div>
                <div>
                  <dt>Take profit</dt>
                  <dd class="mono">
                    {{ s.takeProfit !== null ? (s.takeProfit | number: '1.4-5') : '—' }}
                    @if (s.originalTakeProfit !== null && s.originalTakeProfit !== s.takeProfit) {
                      <!-- Engine shrunk the LLM's TP via SpotAnalysisTakeProfitShrinkage.
                           Show the original underneath so the operator sees the
                           LLM's intent vs the executed plan. -->
                      <span
                        class="tp-original"
                        [title]="
                          'LLM proposed ' +
                          (s.originalTakeProfit | number: '1.4-5') +
                          ' — shrunk to ' +
                          (s.takeProfit | number: '1.4-5') +
                          ' (' +
                          (tpReductionPct(s) ?? '0%') +
                          ' reduction of the profit-target distance) before the signal was filed.'
                        "
                      >
                        LLM original: {{ s.originalTakeProfit | number: '1.4-5' }}
                        @if (tpReductionPct(s); as pct) {
                          <span class="tp-reduction">−{{ pct }}</span>
                        }
                      </span>
                    }
                  </dd>
                </div>
                <div>
                  <dt>Risk : Reward</dt>
                  <dd class="mono">{{ formatRR(s) }}</dd>
                </div>
                <div>
                  <dt>Lot size</dt>
                  <dd class="mono">{{ s.suggestedLotSize | number: '1.2-2' }}</dd>
                </div>
                <div>
                  <dt>Strategy confidence</dt>
                  <dd class="mono">{{ (s.confidence * 100 | number: '1.1-1') + '%' }}</dd>
                </div>
              </dl>
            </section>

            <section class="drawer-section">
              <h4>ML Scoring</h4>
              @if (s.mlModelId !== null) {
                <dl class="drawer-grid">
                  <div>
                    <dt>Model</dt>
                    <dd class="mono">#{{ s.mlModelId }}</dd>
                  </div>
                  <div>
                    <dt>Predicted direction</dt>
                    <dd
                      [class.buy]="s.mlPredictedDirection === 'Buy'"
                      [class.sell]="s.mlPredictedDirection === 'Sell'"
                    >
                      {{ s.mlPredictedDirection ?? '—' }}
                      @if (s.mlPredictedDirection && s.mlPredictedDirection !== s.direction) {
                        <span class="disagree-badge">disagrees</span>
                      }
                    </dd>
                  </div>
                  <div>
                    <dt>ML confidence</dt>
                    <dd class="mono">
                      {{
                        s.mlConfidenceScore !== null
                          ? (s.mlConfidenceScore * 100 | number: '1.1-1') + '%'
                          : '—'
                      }}
                    </dd>
                  </div>
                  <div>
                    <dt>Predicted magnitude</dt>
                    <dd class="mono">
                      {{
                        s.mlPredictedMagnitude !== null
                          ? (s.mlPredictedMagnitude | number: '1.2-2') + ' pips'
                          : '—'
                      }}
                    </dd>
                  </div>
                </dl>
              } @else {
                <p class="muted">No ML model active when this signal was scored.</p>
              }
            </section>

            @if (s.rejectionReason) {
              <section class="drawer-section">
                <h4>Rejection reason</h4>
                <pre class="reason mono">{{ s.rejectionReason }}</pre>
              </section>
            }

            <section class="drawer-section">
              <h4>Lifecycle</h4>
              <dl class="drawer-grid">
                <div>
                  <dt>Strategy id</dt>
                  <dd class="mono">#{{ s.strategyId }}</dd>
                </div>
                <div>
                  <dt>Order id</dt>
                  <dd class="mono">{{ s.orderId !== null ? '#' + s.orderId : 'not placed' }}</dd>
                </div>
                <div>
                  <dt>Generated</dt>
                  <dd>{{ s.generatedAt | date: 'MMM d, HH:mm:ss' }}</dd>
                </div>
                <div>
                  <dt>Expires</dt>
                  <dd>{{ s.expiresAt | date: 'MMM d, HH:mm:ss' }}</dd>
                </div>
              </dl>
            </section>

            @if (s.status === 'Pending') {
              <footer class="drawer-actions">
                <button
                  class="btn btn-success"
                  (click)="approveSignal(s)"
                  [disabled]="processing()"
                >
                  Approve
                </button>
                <button class="btn btn-danger" (click)="rejectSignal(s)" [disabled]="processing()">
                  Reject
                </button>
              </footer>
            }
          </aside>
        </div>
      }

      <app-confirm-dialog
        [open]="showRejectDialog()"
        title="Reject signal(s)"
        [message]="rejectDialogMessage()"
        confirmLabel="Reject"
        confirmVariant="destructive"
        [loading]="processing()"
        (confirm)="confirmReject()"
        (cancelled)="showRejectDialog.set(false)"
      />
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
      /* View tabs — Signals queue vs. parked LLM recs cockpit. Visual style
         mirrors the spread-reactive page so the affordance reads as the
         same kind of "switch what the page shows" everywhere. */
      .view-tabs {
        display: flex;
        gap: 4px;
        border-bottom: 1px solid var(--border, #e3e3e3);
        padding: 0;
      }
      .view-tab {
        height: 34px;
        padding: 0 14px;
        border: none;
        background: transparent;
        color: var(--text-secondary);
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        font-family: inherit;
        cursor: pointer;
        border-bottom: 2px solid transparent;
        margin-bottom: -1px;
      }
      .view-tab:hover:not(.active) {
        color: var(--text-primary);
      }
      .view-tab.active {
        color: var(--text-primary);
        border-bottom-color: var(--accent, #0071e3);
        font-weight: var(--font-semibold);
      }
      .kpi-grid {
        display: grid;
        grid-template-columns: repeat(6, 1fr);
        gap: var(--space-3);
      }
      @media (max-width: 1200px) {
        .kpi-grid {
          grid-template-columns: repeat(3, 1fr);
        }
      }
      @media (max-width: 720px) {
        .kpi-grid {
          grid-template-columns: repeat(2, 1fr);
        }
      }

      .filter-row {
        display: flex;
        gap: var(--space-3);
        align-items: center;
        flex-wrap: wrap;
      }
      .chip-group {
        display: inline-flex;
        gap: 2px;
        padding: 3px;
        background: var(--bg-tertiary);
        border-radius: var(--radius-full);
      }
      .chip {
        height: 28px;
        padding: 0 12px;
        border: none;
        background: transparent;
        color: var(--text-secondary);
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
        font-family: inherit;
        border-radius: var(--radius-full);
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .chip:hover:not(.active) {
        color: var(--text-primary);
      }
      .chip.active {
        background: var(--bg-secondary);
        color: var(--text-primary);
        box-shadow: var(--shadow-sm);
      }
      .chip[data-status='Pending'].active {
        color: #c93400;
      }
      .chip[data-status='Approved'].active {
        color: #248a3d;
      }
      .chip[data-status='Rejected'].active {
        color: #d70015;
      }
      .chip.buy.active {
        color: #248a3d;
      }
      .chip.sell.active {
        color: #d70015;
      }
      .chip-count {
        background: var(--bg-tertiary);
        color: var(--text-tertiary);
        padding: 1px 7px;
        border-radius: var(--radius-full);
        font-size: 10px;
        font-variant-numeric: tabular-nums;
      }
      .chip.active .chip-count {
        background: var(--bg-tertiary);
        color: var(--text-secondary);
      }
      .input {
        height: 32px;
        padding: 0 var(--space-3);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-sm);
        outline: none;
      }
      .input.search {
        flex: 1 1 200px;
        max-width: 280px;
      }
      .input:focus {
        border-color: var(--accent);
      }
      .toggle {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: var(--text-xs);
        color: var(--text-secondary);
        cursor: pointer;
      }
      .muted {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
      }

      .charts-row {
        display: grid;
        grid-template-columns: 2fr 1fr;
        gap: var(--space-4);
      }
      @media (max-width: 1200px) {
        .charts-row {
          grid-template-columns: 1fr;
        }
      }

      .btn {
        height: 28px;
        padding: 0 var(--space-3);
        border: none;
        border-radius: var(--radius-full);
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        font-family: inherit;
        cursor: pointer;
      }
      .btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .btn-success {
        background: rgba(52, 199, 89, 0.15);
        color: #248a3d;
      }
      .btn-success:hover:not(:disabled) {
        background: rgba(52, 199, 89, 0.25);
      }
      .btn-danger {
        background: rgba(255, 59, 48, 0.15);
        color: #d70015;
      }
      .btn-danger:hover:not(:disabled) {
        background: rgba(255, 59, 48, 0.25);
      }

      /* Detail modal  centered card replacing the prior side-drawer.
         Class names stay drawer-* because the content classes
         (drawer-section / drawer-grid) ride along; only the outer chrome
         was restyled to give the chart pane horizontal room and a more
         readable Sensitivity-style head. */
      .drawer-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.55);
        backdrop-filter: blur(3px);
        -webkit-backdrop-filter: blur(3px);
        z-index: 100;
        display: flex;
        justify-content: center;
        align-items: center;
        padding: 1.5rem;
        animation: scrimIn 0.12s ease-out;
      }
      @keyframes scrimIn {
        from {
          opacity: 0;
        }
        to {
          opacity: 1;
        }
      }
      .drawer {
        width: min(1060px, 96vw);
        max-height: 92vh;
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: 12px;
        box-shadow: 0 24px 70px rgba(0, 0, 0, 0.45);
        display: flex;
        flex-direction: column;
        overflow-y: auto;
        scrollbar-gutter: stable;
        animation: cardIn 0.16s ease-out;
      }
      @keyframes cardIn {
        from {
          opacity: 0;
          transform: translateY(8px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }
      .drawer-head {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 1rem;
        padding: 1rem 1.25rem;
        border-bottom: 1px solid var(--border);
        background: var(--bg-primary);
        position: sticky;
        top: 0;
        z-index: 1;
      }
      .head-titles {
        min-width: 0;
      }
      .head-title {
        margin: 0;
        font-size: 1.05rem;
        font-weight: 600;
        display: flex;
        align-items: center;
        gap: 0.5rem;
        flex-wrap: wrap;
      }
      .head-title .signal-id {
        color: var(--text-secondary);
        font-weight: 500;
      }
      .head-title .symbol {
        color: var(--text-primary);
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: 1rem;
      }
      /* Direction-tinted chip with subtle border + soft bg. */
      .dir-chip {
        font-size: 0.72rem;
        font-weight: 600;
        padding: 3px 8px;
        border-radius: 4px;
        line-height: 1.1;
        letter-spacing: 0.02em;
      }
      .dir-chip--buy {
        background: rgba(31, 138, 61, 0.14);
        color: #1f8a3d;
        border: 1px solid rgba(31, 138, 61, 0.35);
      }
      .dir-chip--sell {
        background: rgba(196, 41, 10, 0.14);
        color: #c4290a;
        border: 1px solid rgba(196, 41, 10, 0.35);
      }
      /* Status chip; colour per terminal state. */
      .status-chip {
        font-size: 0.72rem;
        font-weight: 600;
        padding: 3px 8px;
        border-radius: 4px;
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        letter-spacing: 0.02em;
      }
      .status-chip--pending {
        background: rgba(255, 159, 10, 0.14);
        color: #b75900;
      }
      .status-chip--approved {
        background: rgba(0, 113, 227, 0.14);
        color: #0071e3;
      }
      .status-chip--rejected {
        background: rgba(196, 41, 10, 0.14);
        color: #c4290a;
      }
      .status-chip--executed {
        background: rgba(31, 138, 61, 0.14);
        color: #1f8a3d;
      }
      .status-chip--expired {
        background: rgba(110, 110, 115, 0.18);
        color: var(--text-secondary);
      }
      .head-sub {
        margin-top: 0.3rem;
        font-size: 0.78rem;
        color: var(--text-secondary);
      }
      .btn-close {
        background: transparent;
        border: none;
        font-size: 1.5rem;
        cursor: pointer;
        line-height: 1;
        padding: 0.25rem 0.5rem;
        border-radius: 4px;
        color: var(--text-secondary);
        flex-shrink: 0;
      }
      .btn-close:hover {
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }
      .drawer-section {
        padding: 1rem 1.25rem;
        border-bottom: 1px solid var(--border);
      }
      .drawer-section:last-of-type {
        border-bottom: none;
      }
      .drawer-section h4 {
        margin: 0 0 0.6rem;
        font-size: 0.7rem;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--text-secondary);
        font-weight: 600;
      }
      /* Three-column grid on the wider modal so the Pricing / Lifecycle /
         ML rows breathe; collapses to two columns on narrower viewports. */
      .drawer-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
        gap: 0.85rem 1.5rem;
        margin: 0;
      }
      .drawer-grid dt {
        font-size: 10.5px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-tertiary);
        margin: 0 0 2px;
        font-weight: 600;
      }
      .drawer-grid dd {
        margin: 0;
        font-size: 0.92rem;
        color: var(--text-primary);
      }
      .drawer-grid dd.mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: 0.86rem;
      }
      /* Pre-shrinkage TP shown under the executed Take profit value when the
         engine's SpotAnalysisTakeProfitShrinkage moved it. Muted + smaller so
         the executed value stays the primary read; tooltip carries the full
         explanation. */
      .tp-original {
        display: block;
        margin-top: 2px;
        font-size: 10px;
        color: var(--text-tertiary);
        cursor: help;
      }
      /* Reduction-percentage chip next to the LLM-original price. Amber so it
         reads as an operator-applied adjustment, not an error. */
      .tp-reduction {
        margin-left: 4px;
        padding: 0 4px;
        border-radius: var(--radius-sm);
        background: rgba(245, 158, 11, 0.12);
        color: #f59e0b;
        font-weight: var(--font-semibold);
      }
      .drawer-grid dd.buy {
        color: var(--profit);
        font-weight: var(--font-semibold);
      }
      .drawer-grid dd.sell {
        color: var(--loss);
        font-weight: var(--font-semibold);
      }
      .disagree-badge {
        display: inline-block;
        margin-left: 8px;
        padding: 1px 8px;
        border-radius: var(--radius-full);
        background: rgba(175, 82, 222, 0.12);
        color: #8a2be2;
        font-size: 10px;
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .reason {
        margin: 0;
        padding: var(--space-2) var(--space-3);
        background: rgba(255, 59, 48, 0.06);
        border: 1px solid rgba(255, 59, 48, 0.2);
        border-radius: var(--radius-sm);
        color: var(--text-primary);
        font-size: var(--text-xs);
        white-space: pre-wrap;
        word-break: break-word;
      }
      .drawer-actions {
        padding: 1rem 1.25rem;
        display: flex;
        gap: 0.6rem;
        background: var(--bg-secondary);
        border-top: 1px solid var(--border);
        position: sticky;
        bottom: 0;
        z-index: 1;
      }
      .drawer-actions .btn {
        flex: 1;
        height: 40px;
        font-weight: 600;
      }
    `,
  ],
})
export class SignalsPageComponent {
  private readonly signalsService = inject(TradeSignalsService);
  private readonly notifications = inject(NotificationService);
  private readonly realtime = inject(RealtimeService);
  private readonly relativeTimePipe = new RelativeTimePipe();
  private readonly dataTable = viewChild(DataTableComponent<TradeSignalDto>);

  // ── View tab — main signals queue vs. parked LLM recs cockpit ─────────
  readonly view = signal<'signals' | 'parked'>('signals');

  // ── Filter signals ────────────────────────────────────────────────────
  readonly statusFilter = signal<StatusChip>('all');
  readonly directionFilter = signal<DirectionChip>('all');
  readonly symbolFilter = signal('');
  readonly mlDisagreementOnly = signal(false);

  readonly statusChips: StatusChip[] = ['all', 'Pending', 'Approved', 'Rejected', 'Expired'];
  readonly directionChips: DirectionChip[] = ['all', 'Buy', 'Sell'];

  // ── Recent-signals snapshot for KPIs / charts ────────────────────────
  // Loaded separately from the paginated table so charts/KPIs don't fight
  // with the operator's pagination state. Refreshed on every realtime push.
  readonly recentSignals = signal<TradeSignalDto[]>([]);
  readonly metricsLoading = signal(true);

  readonly processing = signal(false);

  // ── Reject confirm state ─────────────────────────────────────────────
  readonly showRejectDialog = signal(false);
  readonly pendingRejectIds = signal<number[]>([]);
  readonly rejectDialogMessage = computed(() => {
    const ids = this.pendingRejectIds();
    if (ids.length === 1) return `Reject signal #${ids[0]}?`;
    return `Reject ${ids.length} pending signals?`;
  });

  readonly selectedDetail = signal<TradeSignalDto | null>(null);
  readonly showCreateDialog = signal(false);

  /**
   * Chart-eligibility predicate. The shared `SpotRecChart` needs a symbol
   * plus the full Entry / SL / TP triple to render reference lines; signals
   * missing any of these (e.g. an orphan row, or a manual-entry placeholder
   * that hasn't been priced) skip the chart silently rather than render an
   * empty plot.
   */
  canChart(s: TradeSignalDto): boolean {
    return !!s.symbol && s.entryPrice != null && s.stopLoss != null && s.takeProfit != null;
  }

  /**
   * Wraps the TradeSignal into the chart's rec-shape (singular array — the
   * signal carries one Entry / SL / TP triple, but the chart component is
   * the same multi-rec one the Spot Analysis Report drawer uses).
   */
  chartRecsFor(s: TradeSignalDto): SpotRecChartRec[] {
    return [
      {
        label: `Signal #${s.id} ${s.direction}`,
        action: s.direction,
        entryPrice: s.entryPrice,
        stopLoss: s.stopLoss,
        takeProfit: s.takeProfit,
      },
    ];
  }

  /**
   * Fired by `<app-create-signal-dialog>` after a successful signal creation.
   * Closes the dialog and refreshes the data table so the new row appears
   * without the operator having to manually reload.
   */
  onSignalCreated(): void {
    this.showCreateDialog.set(false);
    this.dataTable()?.loadData();
    this.loadRecent();
  }

  // ── Derived KPIs ──────────────────────────────────────────────────────
  private startOfToday = (): number => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };

  readonly pendingCount = computed(
    () => this.recentSignals().filter((s) => s.status === 'Pending').length,
  );
  readonly approvedToday = computed(() => this.countByStatusToday('Approved'));
  readonly rejectedToday = computed(() => this.countByStatusToday('Rejected'));
  readonly expiredToday = computed(() => this.countByStatusToday('Expired'));

  readonly avgPendingConfidence = computed(() => {
    const pending = this.recentSignals().filter((s) => s.status === 'Pending');
    if (pending.length === 0) return 0;
    return pending.reduce((sum, s) => sum + s.confidence, 0) / pending.length;
  });

  readonly mlDisagreementCount = computed(() => {
    const cutoff = Date.now() - 24 * 3600_000;
    return this.recentSignals().filter(
      (s) =>
        new Date(s.generatedAt).getTime() >= cutoff &&
        s.mlPredictedDirection !== null &&
        s.mlPredictedDirection !== s.direction,
    ).length;
  });

  statusCount(s: StatusChip): number {
    if (s === 'all') return this.recentSignals().length;
    return this.recentSignals().filter((x) => x.status === s).length;
  }

  // ── Visible filter (for "X of Y" + ML-disagreement client-side) ──────
  // Note: this drives only the indicator above; the paginated table fetches
  // server-side filtered data via fetchData.
  readonly visibleSignals = computed(() => {
    const st = this.statusFilter();
    const dir = this.directionFilter();
    const q = this.symbolFilter().toLowerCase().trim();
    const mlOnly = this.mlDisagreementOnly();
    return this.recentSignals().filter((s) => {
      if (st !== 'all' && s.status !== st) return false;
      if (dir !== 'all' && s.direction !== dir) return false;
      if (q && !((s.symbol ?? '').toLowerCase().includes(q) || String(s.id).includes(q))) {
        return false;
      }
      if (mlOnly && (s.mlPredictedDirection === null || s.mlPredictedDirection === s.direction)) {
        return false;
      }
      return true;
    });
  });

  // ── Charts ────────────────────────────────────────────────────────────
  readonly hourlyVolumeChart = computed<EChartsOption>(() => {
    const cutoff = Date.now() - 24 * 3600_000;
    const buckets = new Map<string, Record<string, number>>();
    // Pre-fill 24 hourly buckets so the x-axis is regular regardless of activity.
    for (let h = 23; h >= 0; h--) {
      const t = new Date(Date.now() - h * 3600_000);
      t.setMinutes(0, 0, 0);
      const k = t.toISOString().slice(11, 16);
      buckets.set(k, { Pending: 0, Approved: 0, Rejected: 0, Expired: 0 });
    }
    for (const s of this.recentSignals()) {
      const ts = new Date(s.generatedAt).getTime();
      if (ts < cutoff) continue;
      const t = new Date(ts);
      t.setMinutes(0, 0, 0);
      const k = t.toISOString().slice(11, 16);
      const b = buckets.get(k);
      if (!b) continue;
      const status = s.status as keyof typeof b;
      b[status] = (b[status] ?? 0) + 1;
    }
    const xs = Array.from(buckets.keys());
    const series = [
      { name: 'Approved', color: '#34C759' },
      { name: 'Pending', color: '#FF9500' },
      { name: 'Rejected', color: '#FF3B30' },
      { name: 'Expired', color: '#8E8E93' },
    ].map((s) => ({
      name: s.name,
      type: 'bar' as const,
      stack: 'count',
      itemStyle: { color: s.color },
      data: xs.map((x) => buckets.get(x)?.[s.name] ?? 0),
    }));
    return {
      tooltip: { trigger: 'axis' },
      legend: { bottom: 0, textStyle: { fontSize: 10 } },
      grid: { top: 12, right: 16, bottom: 36, left: 36 },
      xAxis: { type: 'category', data: xs, axisLabel: { fontSize: 10, hideOverlap: true } },
      yAxis: { type: 'value', axisLabel: { fontSize: 10 } },
      series,
    };
  });

  readonly bySymbolChart = computed<EChartsOption>(() => {
    const cutoff = Date.now() - 24 * 3600_000;
    const counts = new Map<string, { buy: number; sell: number }>();
    for (const s of this.recentSignals()) {
      if (new Date(s.generatedAt).getTime() < cutoff) continue;
      if (!s.symbol) continue;
      const c = counts.get(s.symbol) ?? { buy: 0, sell: 0 };
      if (s.direction === 'Buy') c.buy++;
      else c.sell++;
      counts.set(s.symbol, c);
    }
    const sorted = Array.from(counts.entries())
      .sort((a, b) => b[1].buy + b[1].sell - (a[1].buy + a[1].sell))
      .slice(0, 10);
    if (sorted.length === 0) {
      return {
        title: {
          text: 'No signals in last 24h',
          left: 'center',
          top: 'center',
          textStyle: { fontSize: 12, color: '#8E8E93' },
        },
      };
    }
    return {
      tooltip: { trigger: 'axis' },
      legend: { bottom: 0, textStyle: { fontSize: 10 } },
      grid: { top: 12, right: 16, bottom: 36, left: 70 },
      xAxis: { type: 'value', axisLabel: { fontSize: 10 } },
      yAxis: { type: 'category', data: sorted.map(([s]) => s), axisLabel: { fontSize: 10 } },
      series: [
        {
          name: 'Buy',
          type: 'bar',
          stack: 'dir',
          itemStyle: { color: '#34C759' },
          data: sorted.map(([, c]) => c.buy),
        },
        {
          name: 'Sell',
          type: 'bar',
          stack: 'dir',
          itemStyle: { color: '#FF3B30' },
          data: sorted.map(([, c]) => c.sell),
        },
      ],
    };
  });

  // ── Lifecycle ────────────────────────────────────────────────────────
  constructor() {
    this.loadRecent();
    // Realtime push — coalesce bursts so generation storms don't trigger 50
    // refetches in 2 seconds. 1s leading+trailing keeps the feed live without
    // hammering /trade-signal/list.
    this.realtime
      .on('tradeSignalCreated')
      .pipe(throttleTime(1_000, undefined, { leading: true, trailing: true }), takeUntilDestroyed())
      .subscribe(() => {
        this.loadRecent();
        this.dataTable()?.loadData();
      });
  }

  private loadRecent(): void {
    this.metricsLoading.set(true);
    // Big page so KPIs cover today's activity without paginating. Capped at
    // 500 — the engine's PagerRequest doesn't allow unbounded pulls.
    this.signalsService
      .list({ currentPage: 1, itemCountPerPage: 500 })
      .pipe(
        map((r) => r.data?.data ?? []),
        catchError(() => of([] as TradeSignalDto[])),
      )
      .subscribe((rows) => {
        this.recentSignals.set(rows);
        this.metricsLoading.set(false);
      });
  }

  private countByStatusToday(status: TradeSignalStatus): number {
    const start = this.startOfToday();
    return this.recentSignals().filter(
      (s) => s.status === status && new Date(s.generatedAt).getTime() >= start,
    ).length;
  }

  // ── Table ────────────────────────────────────────────────────────────
  readonly columns: ColDef<TradeSignalDto>[] = [
    { headerName: 'ID', field: 'id', width: 70, sortable: true },
    { headerName: 'Symbol', field: 'symbol', width: 100 },
    {
      headerName: 'Src',
      field: 'isManual',
      width: 70,
      cellRenderer: (p: { value: boolean | null | undefined }) => {
        if (p.value) {
          return `<span title="Hand-authored via the admin UI" style="color:#8A2BE2;background:rgba(138,43,226,0.12);padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600">Manual</span>`;
        }
        return `<span title="Generated by a strategy worker" style="color:#8E8E93;font-size:11px">Auto</span>`;
      },
    },
    {
      headerName: 'Dir',
      field: 'direction',
      width: 70,
      cellRenderer: (p: { value: string }) => {
        const isBuy = p.value === 'Buy';
        const color = isBuy ? '#248A3D' : '#D70015';
        const bg = isBuy ? 'rgba(52,199,89,0.12)' : 'rgba(255,59,48,0.12)';
        return `<span style="color:${color};background:${bg};padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600">${isBuy ? '↑' : '↓'} ${p.value}</span>`;
      },
    },
    {
      headerName: 'Strat',
      field: 'strategyId',
      width: 70,
      valueFormatter: (p) => (p.value != null ? `#${p.value}` : '—'),
    },
    {
      headerName: 'Conf',
      field: 'confidence',
      width: 80,
      valueFormatter: (p) => (p.value != null ? `${(p.value * 100).toFixed(1)}%` : '—'),
    },
    {
      headerName: 'ML dir',
      field: 'mlPredictedDirection',
      width: 90,
      cellRenderer: (p: { value: string | null; data: TradeSignalDto }) => {
        if (!p.value) return `<span style="color:#8E8E93;font-size:11px">—</span>`;
        const disagrees = p.value !== p.data.direction;
        const color = disagrees ? '#8A2BE2' : p.value === 'Buy' ? '#248A3D' : '#D70015';
        const arrow = p.value === 'Buy' ? '↑' : '↓';
        const tag = disagrees
          ? `<span style="color:#8A2BE2;font-size:9px;font-weight:600;margin-left:4px">≠</span>`
          : '';
        return `<span style="color:${color};font-size:11px;font-weight:600">${arrow} ${p.value}${tag}</span>`;
      },
    },
    {
      headerName: 'ML score',
      field: 'mlConfidenceScore',
      width: 90,
      valueFormatter: (p) => (p.value != null ? `${(p.value * 100).toFixed(1)}%` : '—'),
    },
    {
      headerName: 'Entry',
      field: 'entryPrice',
      width: 100,
      cellClass: 'mono',
      valueFormatter: (p) => (p.value != null ? Number(p.value).toFixed(5) : '—'),
    },
    {
      headerName: 'SL',
      field: 'stopLoss',
      width: 100,
      cellClass: 'mono',
      valueFormatter: (p) => (p.value != null ? Number(p.value).toFixed(5) : '—'),
    },
    {
      headerName: 'TP',
      field: 'takeProfit',
      width: 100,
      cellClass: 'mono',
      valueFormatter: (p) => (p.value != null ? Number(p.value).toFixed(5) : '—'),
    },
    {
      headerName: 'R:R',
      colId: 'rr',
      width: 75,
      cellClass: 'mono',
      valueGetter: (p) => this.formatRR(p.data as TradeSignalDto),
    },
    {
      headerName: 'Lots',
      field: 'suggestedLotSize',
      width: 70,
      cellClass: 'mono',
      valueFormatter: (p) => (p.value != null ? Number(p.value).toFixed(2) : '—'),
    },
    {
      headerName: 'Status',
      field: 'status',
      width: 110,
      cellRenderer: (p: { value: string; data: TradeSignalDto }) => {
        const map: Record<string, { bg: string; color: string }> = {
          Pending: { bg: 'rgba(255,149,0,0.12)', color: '#C93400' },
          Approved: { bg: 'rgba(52,199,89,0.12)', color: '#248A3D' },
          Executed: { bg: 'rgba(52,199,89,0.12)', color: '#248A3D' },
          Rejected: { bg: 'rgba(255,59,48,0.12)', color: '#D70015' },
          Expired: { bg: 'rgba(142,142,147,0.12)', color: '#636366' },
        };
        const s = map[p.value] ?? map['Expired'];
        const reason =
          p.data.rejectionReason && p.value === 'Rejected'
            ? ` title="${escapeHtml(p.data.rejectionReason)}"`
            : '';
        return `<span${reason} style="background:${s.bg};color:${s.color};padding:2px 10px;border-radius:999px;font-size:11px;font-weight:600">${p.value}</span>`;
      },
    },
    {
      headerName: 'Generated',
      field: 'generatedAt',
      width: 120,
      valueFormatter: (p) => this.relativeTimePipe.transform(p.value),
    },
    {
      headerName: 'Expires',
      field: 'expiresAt',
      width: 120,
      valueFormatter: (p) => this.relativeTimePipe.transform(p.value),
    },
    {
      headerName: 'Actions',
      colId: 'actions',
      width: 150,
      sortable: false,
      cellRenderer: (p: { data: TradeSignalDto }) => {
        if (p.data?.status !== 'Pending') {
          return `<button data-action="details" style="height:24px;padding:0 10px;border:none;border-radius:999px;font-size:11px;font-weight:600;cursor:pointer;background:rgba(0,113,227,0.12);color:#0071E3">Details</button>`;
        }
        return `<div style="display:flex;gap:4px;align-items:center;height:100%">
          <button data-action="approve" style="height:24px;padding:0 10px;border:none;border-radius:999px;font-size:11px;font-weight:600;cursor:pointer;background:rgba(52,199,89,0.15);color:#248A3D">✓</button>
          <button data-action="reject" style="height:24px;padding:0 10px;border:none;border-radius:999px;font-size:11px;font-weight:600;cursor:pointer;background:rgba(255,59,48,0.15);color:#D70015">✗</button>
          <button data-action="details" style="height:24px;padding:0 8px;border:none;border-radius:999px;font-size:11px;font-weight:600;cursor:pointer;background:rgba(0,113,227,0.12);color:#0071E3">⋯</button>
        </div>`;
      },
      onCellClicked: (p) => {
        const target = p.event?.target as HTMLElement | undefined;
        const action = target?.getAttribute('data-action');
        if (!action || !p.data) return;
        if (action === 'approve') this.approveSignal(p.data);
        if (action === 'reject') this.rejectSignal(p.data);
        if (action === 'details') this.selectedDetail.set(p.data);
      },
    },
  ];

  // Server-side filter shape (passed to fetchData). The chip filters drive
  // engine queries via TradeSignalQueryFilter — see CreateAlertCommand for
  // the matching shape on the server.
  fetchData = (params: PagerRequest) => {
    const filterObj: Record<string, unknown> = {
      ...((params.filter as Record<string, unknown>) ?? {}),
    };
    const status = this.statusFilter();
    const direction = this.directionFilter();
    const symbol = this.symbolFilter().trim();
    if (status !== 'all') filterObj['status'] = status;
    if (direction !== 'all') filterObj['direction'] = direction;
    if (symbol) filterObj['search'] = symbol;
    const merged: PagerRequest = {
      ...params,
      filter: Object.keys(filterObj).length > 0 ? filterObj : null,
    };
    return this.signalsService.list(merged).pipe(
      map((response) => {
        if (response.data) {
          // Pin Pending to the top within the page so the operator's eye lands
          // on the actionable rows.
          const sorted = [...response.data.data].sort((a, b) => {
            if (a.status === 'Pending' && b.status !== 'Pending') return -1;
            if (a.status !== 'Pending' && b.status === 'Pending') return 1;
            return 0;
          });
          return { ...response.data, data: sorted };
        }
        return {
          data: [],
          pager: {
            totalItemCount: 0,
            filter: null,
            currentPage: 1,
            itemCountPerPage: 25,
            pageNo: 0,
            pageSize: 25,
          },
        } as PagedData<TradeSignalDto>;
      }),
    );
  };

  // ── Actions ──────────────────────────────────────────────────────────
  approveSignal(s: TradeSignalDto): void {
    this.processing.set(true);
    this.signalsService.approve(s.id).subscribe({
      next: (res) => {
        this.processing.set(false);
        if (res.status) {
          this.notifications.success(`Signal #${s.id} approved`);
          this.selectedDetail.set(null);
          this.dataTable()?.loadData();
          this.loadRecent();
        } else {
          this.notifications.error(res.message ?? 'Failed to approve signal');
        }
      },
      error: () => {
        this.processing.set(false);
        this.notifications.error('Failed to approve signal');
      },
    });
  }

  rejectSignal(s: TradeSignalDto): void {
    this.pendingRejectIds.set([s.id]);
    this.showRejectDialog.set(true);
  }

  bulkApprove(rows: TradeSignalDto[]): void {
    const pending = rows.filter((r) => r.status === 'Pending');
    if (pending.length === 0) {
      this.notifications.warning('No pending signals selected.');
      return;
    }
    this.processing.set(true);
    let remaining = pending.length;
    let approved = 0;
    pending.forEach((s) => {
      this.signalsService.approve(s.id).subscribe({
        next: (res) => {
          if (res.status) approved++;
          if (--remaining === 0) {
            this.processing.set(false);
            this.notifications.success(`Approved ${approved} of ${pending.length}`);
            this.dataTable()?.loadData();
            this.loadRecent();
          }
        },
        error: () => {
          if (--remaining === 0) {
            this.processing.set(false);
            this.notifications.error('Bulk approve failed');
          }
        },
      });
    });
  }

  bulkReject(rows: TradeSignalDto[]): void {
    const pending = rows.filter((r) => r.status === 'Pending');
    if (pending.length === 0) {
      this.notifications.warning('No pending signals selected.');
      return;
    }
    this.pendingRejectIds.set(pending.map((s) => s.id));
    this.showRejectDialog.set(true);
  }

  pendingInSelection(rows: TradeSignalDto[]): number {
    return rows.filter((r) => r.status === 'Pending').length;
  }

  confirmReject(): void {
    const ids = this.pendingRejectIds();
    if (ids.length === 0) return;
    this.processing.set(true);
    let remaining = ids.length;
    let rejected = 0;
    ids.forEach((id) => {
      this.signalsService.reject(id, { reason: 'Manually rejected by admin' }).subscribe({
        next: (res) => {
          if (res.status) rejected++;
          if (--remaining === 0) {
            this.processing.set(false);
            this.showRejectDialog.set(false);
            this.selectedDetail.set(null);
            this.notifications.success(`Rejected ${rejected} of ${ids.length}`);
            this.dataTable()?.loadData();
            this.loadRecent();
          }
        },
        error: () => {
          if (--remaining === 0) {
            this.processing.set(false);
            this.showRejectDialog.set(false);
            this.notifications.error('Bulk reject failed');
          }
        },
      });
    });
  }

  // ── Helpers ──────────────────────────────────────────────────────────
  formatRR(s: TradeSignalDto | null): string {
    if (!s || s.stopLoss === null || s.takeProfit === null) return '—';
    const risk = Math.abs(s.entryPrice - s.stopLoss);
    const reward = Math.abs(s.takeProfit - s.entryPrice);
    if (risk === 0) return '—';
    return `1:${(reward / risk).toFixed(2)}`;
  }

  /**
   * Reduction percentage the engine's TP shrinkage applied to this signal,
   * computed live from the stored prices (no dependency on the current
   * config value — reflects what was actually applied at generation time).
   * Returns e.g. "20%" when the executed TP distance is 80% of the LLM's
   * original. Null when the signal wasn't shrunk (no originalTakeProfit, or
   * it equals takeProfit) or the math is undefined.
   */
  tpReductionPct(s: TradeSignalDto | null): string | null {
    if (
      !s ||
      s.takeProfit === null ||
      s.originalTakeProfit === null ||
      s.originalTakeProfit === s.takeProfit
    ) {
      return null;
    }
    const origDist = Math.abs(s.originalTakeProfit - s.entryPrice);
    const execDist = Math.abs(s.takeProfit - s.entryPrice);
    if (origDist === 0) return null;
    const reductionPct = (1 - execDist / origDist) * 100;
    // Round to a whole percent — shrinkage values are coarse (0.5 / 0.7 /
    // 0.8) so the reduction always lands on a clean integer in practice.
    return `${Math.round(reductionPct)}%`;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
