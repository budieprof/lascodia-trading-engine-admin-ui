import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { catchError, map, of, switchMap } from 'rxjs';
import type { EChartsOption } from 'echarts';
import type { ColDef } from 'ag-grid-community';

import { DrawdownRecoveryService } from '@core/services/drawdown-recovery.service';
import type { DrawdownSnapshotDto, RecoveryMode } from '@core/api/api.types';
import { createPolledResource } from '@core/polling/polled-resource';
import {
  ChartAnnotationsService,
  type ChartAnnotationDto,
} from '@core/annotations/chart-annotations.service';
import { FeatureFlagsService } from '@core/feature-flags/feature-flags.service';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { GaugeComponent } from '@shared/components/gauge/gauge.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
import { TabsComponent, TabItem } from '@shared/components/ui/tabs/tabs.component';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import { DataTableComponent } from '@shared/components/data-table/data-table.component';

const MODE_LABEL: Record<RecoveryMode, string> = {
  Normal: 'Normal',
  Reduced: 'Reduced',
  Halted: 'Halted',
};

const MODE_COLOR: Record<RecoveryMode, string> = {
  Normal: '#34C759',
  Reduced: '#FF9500',
  Halted: '#FF3B30',
};

@Component({
  selector: 'app-drawdown-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    PageHeaderComponent,
    GaugeComponent,
    MetricCardComponent,
    CardSkeletonComponent,
    EmptyStateComponent,
    TabsComponent,
    ChartCardComponent,
    DataTableComponent,
    DatePipe,
    DecimalPipe,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Drawdown Recovery"
        subtitle="Real-time drawdown and recovery-mode monitoring"
      />

      <ui-tabs [tabs]="tabs" [(activeTab)]="activeTab" />

      @if (activeTab() === 'live') {
        @if (loading()) {
          <app-card-skeleton [lines]="6" />
        } @else if (snapshot()) {
          @if (snapshot(); as s) {
            <div class="hero-section">
              <div class="hero-gauge">
                <app-gauge
                  [value]="s.drawdownPct"
                  [min]="0"
                  [max]="25"
                  label="Current Drawdown"
                  size="200px"
                  [thresholds]="thresholds"
                />
              </div>
              <div class="hero-info">
                <div class="recovery-badge-row">
                  <span class="recovery-label">Recovery Mode</span>
                  <span class="recovery-badge" [class]="s.recoveryMode.toLowerCase()">
                    {{ modeLabel(s.recoveryMode) }}
                  </span>
                </div>
                <div class="equity-comparison">
                  <div class="equity-item">
                    <span class="equity-label">Peak Equity</span>
                    <span class="equity-value peak">{{ s.peakEquity | number: '1.2-2' }}</span>
                  </div>
                  <div class="equity-divider"><span aria-hidden="true">↓</span></div>
                  <div class="equity-item">
                    <span class="equity-label">Current Equity</span>
                    <span class="equity-value">{{ s.currentEquity | number: '1.2-2' }}</span>
                  </div>
                  <div class="equity-item delta">
                    <span class="equity-label">Drawdown Amount</span>
                    <span class="equity-value loss">{{ drawdownAmount() | number: '1.2-2' }}</span>
                  </div>
                </div>
                <div class="meta-row">
                  <span class="muted">Recorded:</span>
                  <span>{{ s.recordedAt | date: 'MMM d, yyyy HH:mm:ss' }}</span>
                </div>
              </div>
            </div>

            <!-- 8-card KPI strip — derived from the analytics window -->
            <div class="kpis">
              <app-metric-card
                label="Current DD %"
                [value]="s.drawdownPct"
                format="percent"
                [dotColor]="
                  s.drawdownPct < 5 ? '#34C759' : s.drawdownPct < 10 ? '#FF9500' : '#FF3B30'
                "
              />
              <app-metric-card
                label="Drawdown amount"
                [value]="drawdownAmount()"
                format="currency"
                [dotColor]="drawdownAmount() < 0 ? '#FF3B30' : '#34C759'"
              />
              <app-metric-card
                label="Max DD 24h"
                [value]="maxDd24h()"
                format="percent"
                [dotColor]="maxDd24h() < 5 ? '#34C759' : maxDd24h() < 10 ? '#FF9500' : '#FF3B30'"
              />
              <app-metric-card
                label="Max DD 7d"
                [value]="maxDd7d()"
                format="percent"
                [dotColor]="maxDd7d() < 5 ? '#34C759' : maxDd7d() < 10 ? '#FF9500' : '#FF3B30'"
              />
              <app-metric-card
                label="Days since peak"
                [value]="daysSincePeak()"
                format="number"
                [dotColor]="daysSincePeak() === 0 ? '#34C759' : '#FF9500'"
              />
              <app-metric-card
                label="Time in {{ s.recoveryMode }}"
                [value]="timeInCurrentModeHours()"
                format="number"
                [dotColor]="modeColorFor(s.recoveryMode)"
              />
              <app-metric-card
                label="Mode transitions 7d"
                [value]="modeTransitions().length"
                format="number"
                [dotColor]="modeTransitions().length > 5 ? '#FF9500' : '#34C759'"
              />
              <app-metric-card
                label="Snapshots in window"
                [value]="analyticsRows().length"
                format="number"
                dotColor="#0071E3"
              />
            </div>

            <!-- 2-col chart row: drawdown sparkline (24h) + mode breakdown (7d) -->
            <div class="chart-row">
              <app-chart-card
                title="Drawdown — last 24h"
                subtitle="Live ticker — gauge view, including peak markers"
                [options]="liveSparklineOptions()"
                height="220px"
              />
              <app-chart-card
                title="Mode dwell time — last 7d"
                subtitle="How long the engine spent in each recovery mode"
                [options]="modeBreakdownDonutOptions()"
                height="220px"
              />
            </div>

            <!-- Threshold reference + recent mode transitions -->
            <div class="info-row">
              <section class="threshold-card">
                <header class="card-head">
                  <h3>Recovery thresholds</h3>
                  <span class="muted">When does the engine throttle back?</span>
                </header>
                <ul class="threshold-list">
                  <li class="t-row" [class.active]="s.recoveryMode === 'Normal'">
                    <span class="t-dot" style="background:#34C759"></span>
                    <span class="t-label">Normal</span>
                    <span class="t-range">DD &lt; 5%</span>
                    <span class="t-desc">Full size · all strategies trading</span>
                  </li>
                  <li class="t-row" [class.active]="s.recoveryMode === 'Reduced'">
                    <span class="t-dot" style="background:#FF9500"></span>
                    <span class="t-label">Reduced</span>
                    <span class="t-range">DD 5–10%</span>
                    <span class="t-desc">Position sizes scaled down · risk controls tighten</span>
                  </li>
                  <li class="t-row" [class.active]="s.recoveryMode === 'Halted'">
                    <span class="t-dot" style="background:#FF3B30"></span>
                    <span class="t-label">Halted</span>
                    <span class="t-range">DD ≥ 10%</span>
                    <span class="t-desc">No new positions · existing positions managed</span>
                  </li>
                </ul>
              </section>

              <section class="trans-card">
                <header class="card-head">
                  <h3>Recent mode transitions</h3>
                  <span class="muted"
                    >{{ modeTransitions().length }} transitions in the window</span
                  >
                </header>
                @if (modeTransitions().length > 0) {
                  <div class="trans-scroll">
                    <table class="trans-table">
                      <thead>
                        <tr>
                          <th>When</th>
                          <th>From</th>
                          <th></th>
                          <th>To</th>
                          <th class="num">DD %</th>
                        </tr>
                      </thead>
                      <tbody>
                        @for (t of modeTransitions().slice().reverse().slice(0, 12); track t.at) {
                          <tr>
                            <td class="mono muted">{{ t.at | date: 'MMM d, HH:mm' }}</td>
                            <td>
                              <span class="mode-pill" [attr.data-mode]="t.from">{{ t.from }}</span>
                            </td>
                            <td class="muted">→</td>
                            <td>
                              <span class="mode-pill" [attr.data-mode]="t.to">{{ t.to }}</span>
                            </td>
                            <td
                              class="num mono"
                              [class.warn]="t.drawdownPct >= 5 && t.drawdownPct < 10"
                              [class.bad]="t.drawdownPct >= 10"
                            >
                              {{ t.drawdownPct | number: '1.2-2' }}%
                            </td>
                          </tr>
                        }
                      </tbody>
                    </table>
                  </div>
                } @else {
                  <span class="empty good">
                    No mode transitions in the window — engine stayed in {{ s.recoveryMode }}.
                  </span>
                }
              </section>
            </div>
          }
        } @else {
          <app-empty-state
            title="No drawdown data available"
            description="The engine has not yet recorded a drawdown snapshot."
          />
        }
      } @else {
        <div class="history-toolbar">
          <h3 class="muted small">Drawdown history with operator notes</h3>
          @if (annotationsEnabled()) {
            <button
              type="button"
              class="btn btn-secondary btn-sm"
              (click)="openCreateAnnotation()"
              [disabled]="creatingAnnotation()"
            >
              + Add note
            </button>
          }
        </div>

        <!-- 6-card KPI strip computed from the loaded history page -->
        @if (historySeries().length > 0) {
          <div class="kpis kpis-6">
            <app-metric-card
              label="Snapshots loaded"
              [value]="historySeries().length"
              format="number"
              dotColor="#0071E3"
            />
            <app-metric-card
              label="Max DD in page"
              [value]="historyMaxDd()"
              format="percent"
              [dotColor]="
                historyMaxDd() < 5 ? '#34C759' : historyMaxDd() < 10 ? '#FF9500' : '#FF3B30'
              "
            />
            <app-metric-card
              label="Avg DD in page"
              [value]="historyAvgDd()"
              format="percent"
              dotColor="#5AC8FA"
            />
            <app-metric-card
              label="Equity range"
              [value]="historyEquityRange()"
              format="currency"
              dotColor="#AF52DE"
            />
            <app-metric-card
              label="Mode transitions"
              [value]="historyModeTransitions().length"
              format="number"
              [dotColor]="historyModeTransitions().length > 0 ? '#FF9500' : '#34C759'"
            />
            <app-metric-card
              label="Time in non-Normal"
              [value]="historyTimeInNonNormalPct()"
              format="percent"
              [dotColor]="historyTimeInNonNormalPct() === 0 ? '#34C759' : '#FF9500'"
            />
          </div>
        }

        <app-chart-card
          title="Drawdown over time"
          subtitle="Most recent {{ historyChartCount() }} snapshots, oldest first"
          [options]="historyChart()"
          height="320px"
          [loading]="historyLoading()"
        />

        @if (historySeries().length > 0) {
          <div class="chart-row">
            <app-chart-card
              title="Mode distribution in loaded page"
              subtitle="Time spent per recovery mode"
              [options]="historyModeDonutOptions()"
              height="220px"
            />
            <section class="trans-card">
              <header class="card-head">
                <h3>Mode transitions in loaded page</h3>
                <span class="muted"> {{ historyModeTransitions().length }} transitions </span>
              </header>
              @if (historyModeTransitions().length > 0) {
                <div class="trans-scroll">
                  <table class="trans-table">
                    <thead>
                      <tr>
                        <th>When</th>
                        <th>From</th>
                        <th></th>
                        <th>To</th>
                        <th class="num">DD %</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (t of historyModeTransitions().slice().reverse(); track t.at) {
                        <tr>
                          <td class="mono muted">{{ t.at | date: 'MMM d, HH:mm' }}</td>
                          <td>
                            <span class="mode-pill" [attr.data-mode]="t.from">{{ t.from }}</span>
                          </td>
                          <td class="muted">→</td>
                          <td>
                            <span class="mode-pill" [attr.data-mode]="t.to">{{ t.to }}</span>
                          </td>
                          <td
                            class="num mono"
                            [class.warn]="t.drawdownPct >= 5 && t.drawdownPct < 10"
                            [class.bad]="t.drawdownPct >= 10"
                          >
                            {{ t.drawdownPct | number: '1.2-2' }}%
                          </td>
                        </tr>
                      }
                    </tbody>
                  </table>
                </div>
              } @else {
                <span class="empty good">
                  No mode transitions on the loaded page — engine stayed in a single mode.
                </span>
              }
            </section>
          </div>
        }

        <app-data-table
          [columnDefs]="historyColumns"
          [fetchData]="fetchHistoryPage"
          stateKey="drawdown-history"
        />

        @if (annotationDrawerOpen()) {
          <div
            class="annot-overlay"
            role="presentation"
            tabindex="-1"
            (click)="closeAnnotationDrawer()"
            (keydown.escape)="closeAnnotationDrawer()"
          >
            <form
              class="annot-dialog"
              role="dialog"
              aria-modal="true"
              aria-label="Add drawdown note"
              tabindex="-1"
              (click)="$event.stopPropagation()"
              (keydown)="$event.stopPropagation()"
              (ngSubmit)="submitAnnotation()"
            >
              <h4>Add note</h4>
              <label class="field">
                <span class="lbl">When (UTC)</span>
                <input type="datetime-local" [(ngModel)]="annotWhen" name="when" required />
              </label>
              <label class="field">
                <span class="lbl">Note</span>
                <textarea
                  [(ngModel)]="annotBody"
                  name="body"
                  rows="4"
                  maxlength="500"
                  placeholder="What happened here?"
                  required
                ></textarea>
              </label>
              <div class="annot-actions">
                <button type="button" class="btn btn-ghost" (click)="closeAnnotationDrawer()">
                  Cancel
                </button>
                <button
                  type="submit"
                  class="btn btn-primary"
                  [disabled]="creatingAnnotation() || !annotBody.trim()"
                >
                  {{ creatingAnnotation() ? 'Saving…' : 'Save' }}
                </button>
              </div>
            </form>
          </div>
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
        gap: var(--space-5);
      }
      .hero-section {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: var(--space-8);
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-6);
        box-shadow: var(--shadow-sm);
        align-items: center;
      }
      .hero-gauge {
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .hero-info {
        display: flex;
        flex-direction: column;
        gap: var(--space-5);
      }
      .recovery-badge-row {
        display: flex;
        align-items: center;
        gap: var(--space-3);
      }
      .recovery-label {
        font-size: var(--text-sm);
        color: var(--text-secondary);
        font-weight: var(--font-medium);
      }
      .recovery-badge {
        display: inline-flex;
        align-items: center;
        padding: var(--space-2) var(--space-4);
        border-radius: var(--radius-full);
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .recovery-badge.normal {
        background: rgba(52, 199, 89, 0.12);
        color: #248a3d;
      }
      .recovery-badge.reduced {
        background: rgba(255, 149, 0, 0.12);
        color: #c93400;
      }
      .recovery-badge.halted {
        background: rgba(255, 59, 48, 0.12);
        color: #d70015;
      }
      .equity-comparison {
        display: flex;
        align-items: center;
        gap: var(--space-6);
        flex-wrap: wrap;
      }
      .equity-item {
        display: flex;
        flex-direction: column;
        gap: var(--space-1);
      }
      .equity-item.delta {
        margin-left: var(--space-4);
        padding-left: var(--space-4);
        border-left: 1px solid var(--border);
      }
      .equity-label {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        font-weight: var(--font-medium);
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      .equity-value {
        font-size: var(--text-xl);
        font-weight: var(--font-semibold);
        font-variant-numeric: tabular-nums;
        color: var(--text-primary);
      }
      .equity-value.peak {
        color: var(--text-secondary);
      }
      .equity-value.loss {
        color: var(--loss);
      }
      .equity-divider {
        display: flex;
        align-items: center;
        color: var(--text-tertiary);
        font-size: 20px;
      }
      .meta-row {
        display: flex;
        gap: var(--space-2);
        font-size: var(--text-xs);
        color: var(--text-tertiary);
      }
      .muted {
        color: var(--text-tertiary);
      }
      @media (max-width: 1024px) {
        .hero-section {
          grid-template-columns: 1fr;
        }
      }

      /* 8-card KPI strip — fleet-wide drawdown analytics */
      .kpis {
        display: grid;
        grid-template-columns: repeat(8, 1fr);
        gap: var(--space-2);
      }
      .kpis.kpis-6 {
        grid-template-columns: repeat(6, 1fr);
      }
      @media (max-width: 1400px) {
        .kpis,
        .kpis.kpis-6 {
          grid-template-columns: repeat(4, 1fr);
        }
      }
      @media (max-width: 720px) {
        .kpis,
        .kpis.kpis-6 {
          grid-template-columns: repeat(2, 1fr);
        }
      }

      /* 2-col chart row */
      .chart-row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--space-3);
      }
      @media (max-width: 1100px) {
        .chart-row {
          grid-template-columns: 1fr;
        }
      }

      /* Threshold reference + transitions row */
      .info-row {
        display: grid;
        grid-template-columns: 1fr 1.2fr;
        gap: var(--space-3);
      }
      @media (max-width: 1100px) {
        .info-row {
          grid-template-columns: 1fr;
        }
      }
      .threshold-card,
      .trans-card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: hidden;
      }
      .card-head {
        display: flex;
        align-items: baseline;
        gap: var(--space-3);
        padding: var(--space-3) var(--space-4);
        border-bottom: 1px solid var(--border);
      }
      .card-head h3 {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      .threshold-list {
        list-style: none;
        margin: 0;
        padding: 0;
      }
      .t-row {
        display: grid;
        grid-template-columns: 16px 80px 80px 1fr;
        align-items: center;
        gap: var(--space-3);
        padding: var(--space-3) var(--space-4);
        border-bottom: 1px solid var(--border);
        font-size: var(--text-xs);
      }
      .t-row:last-child {
        border-bottom: none;
      }
      .t-row.active {
        background: var(--bg-tertiary);
      }
      .t-dot {
        width: 10px;
        height: 10px;
        border-radius: 50%;
      }
      .t-label {
        font-weight: var(--font-semibold);
        color: var(--text-primary);
      }
      .t-range {
        font-family: 'SF Mono', 'Menlo', monospace;
        color: var(--text-secondary);
      }
      .t-desc {
        color: var(--text-tertiary);
      }

      /* Transitions table */
      .trans-scroll {
        max-height: 320px;
        overflow-y: auto;
      }
      .trans-table {
        width: 100%;
        border-collapse: collapse;
      }
      .trans-table th,
      .trans-table td {
        padding: 6px var(--space-3);
        text-align: left;
        border-bottom: 1px solid var(--border);
        font-size: var(--text-xs);
      }
      .trans-table thead th {
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        font-size: 10.5px;
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        position: sticky;
        top: 0;
        z-index: 1;
      }
      .trans-table tbody tr:last-child td {
        border-bottom: none;
      }
      .trans-table .num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .trans-table .mono {
        font-family: 'SF Mono', 'Menlo', monospace;
      }
      .trans-table .warn {
        color: #c93400;
        font-weight: var(--font-semibold);
      }
      .trans-table .bad {
        color: var(--loss);
        font-weight: var(--font-semibold);
      }
      .mode-pill {
        display: inline-flex;
        padding: 2px 8px;
        border-radius: var(--radius-full);
        font-size: 10.5px;
        font-weight: var(--font-semibold);
      }
      .mode-pill[data-mode='Normal'] {
        background: rgba(52, 199, 89, 0.12);
        color: #248a3d;
      }
      .mode-pill[data-mode='Reduced'] {
        background: rgba(255, 149, 0, 0.12);
        color: #c93400;
      }
      .mode-pill[data-mode='Halted'] {
        background: rgba(255, 59, 48, 0.12);
        color: #d70015;
      }
      .empty {
        display: block;
        padding: var(--space-4);
        font-size: var(--text-xs);
        color: var(--text-tertiary);
      }
      .empty.good {
        color: var(--profit);
      }

      /* ── History-tab toolbar + annotation dialog ───────────────────── */
      .history-toolbar {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: var(--space-3);
      }
      .small {
        font-size: var(--text-xs);
      }
      .btn {
        padding: 6px 14px;
        border-radius: var(--radius-full);
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        border: 1px solid transparent;
        cursor: pointer;
        font-family: inherit;
      }
      .btn-sm {
        padding: 4px 12px;
        font-size: var(--text-xs);
      }
      .btn-primary {
        background: var(--accent);
        color: white;
      }
      .btn-primary:disabled {
        opacity: 0.5;
      }
      .btn-secondary {
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }
      .btn-ghost {
        background: transparent;
        color: var(--text-secondary);
        border-color: var(--border);
      }
      .annot-overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.4);
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1000;
      }
      .annot-dialog {
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-lg);
        box-shadow: var(--shadow-lg);
        padding: var(--space-5) var(--space-6);
        width: 100%;
        max-width: 440px;
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
      }
      .annot-dialog h4 {
        margin: 0;
        font-size: var(--text-lg);
        font-weight: var(--font-semibold);
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: var(--space-1);
      }
      .lbl {
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .field input,
      .field textarea {
        padding: 8px 10px;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-secondary);
        color: var(--text-primary);
        font-size: var(--text-sm);
        font-family: inherit;
        resize: vertical;
      }
      .annot-actions {
        display: flex;
        justify-content: flex-end;
        gap: var(--space-2);
      }
    `,
  ],
})
export class DrawdownPageComponent {
  private readonly service = inject(DrawdownRecoveryService);
  private readonly annotationsService = inject(ChartAnnotationsService);
  private readonly flags = inject(FeatureFlagsService);

  /**
   * Chart annotations are gated behind `chart-annotations` so ops can stage
   * rollout per-role or per-percentage via `runtime-config.json`. When off,
   * existing notes still render in the chart (read path) but the authoring
   * affordance is hidden.
   */
  readonly annotationsEnabled = this.flags.watch('chart-annotations');

  readonly tabs: TabItem[] = [
    { label: 'Live', value: 'live' },
    { label: 'History', value: 'history' },
  ];
  readonly activeTab = signal('live');

  readonly thresholds = [
    { value: 5, color: '#34C759' },
    { value: 10, color: '#FF9500' },
    { value: 25, color: '#FF3B30' },
  ];

  private readonly resource = createPolledResource(
    () =>
      this.service.getLatest().pipe(
        map((r) => r.data),
        catchError(() => of(null as DrawdownSnapshotDto | null)),
      ),
    { intervalMs: 15_000 },
  );

  readonly snapshot = computed(() => this.resource.value());
  readonly loading = computed(() => this.resource.loading() && this.resource.value() === null);
  readonly drawdownAmount = computed(() => {
    const s = this.snapshot();
    if (!s) return 0;
    return s.currentEquity - s.peakEquity;
  });

  // ── Live-tab analytics window ────────────────────────────────────────────
  // Probe-and-fetch the most recent 7 days of snapshots (capped at 5000) so
  // the KPIs and breakdown chart reflect the current state of the engine
  // rather than a single moment in time. Polled every 60s.
  private readonly DAY_MS = 24 * 60 * 60 * 1000;

  private readonly analyticsResource = createPolledResource(
    () => {
      const fromDate = new Date(Date.now() - 7 * this.DAY_MS).toISOString();
      return this.service
        .listHistory({ currentPage: 1, itemCountPerPage: 1, filter: { fromDate } })
        .pipe(
          switchMap((probe) => {
            const total = probe.data?.pager?.totalItemCount ?? 0;
            const limit = Math.min(total, 5000);
            if (limit === 0) return of([] as DrawdownSnapshotDto[]);
            return this.service
              .listHistory({
                currentPage: 1,
                itemCountPerPage: limit,
                filter: { fromDate },
              })
              .pipe(map((r) => r.data?.data ?? []));
          }),
          catchError(() => of([] as DrawdownSnapshotDto[])),
        );
    },
    { intervalMs: 60_000 },
  );

  // Engine returns newest-first; keep oldest-first internally so all the
  // walking logic (transitions, dwell time) reads forward in time.
  readonly analyticsRows = computed(() => {
    const rows = this.analyticsResource.value() ?? [];
    return [...rows].sort(
      (a, b) => new Date(a.recordedAt).getTime() - new Date(b.recordedAt).getTime(),
    );
  });

  readonly maxDd24h = computed(() => {
    const cutoff = Date.now() - this.DAY_MS;
    let max = 0;
    for (const r of this.analyticsRows()) {
      if (new Date(r.recordedAt).getTime() < cutoff) continue;
      if (r.drawdownPct > max) max = r.drawdownPct;
    }
    // Include the current snapshot — it might be fresher than the last
    // analytics row, especially right after a sudden drop.
    const s = this.snapshot();
    if (s && s.drawdownPct > max) max = s.drawdownPct;
    return max;
  });

  readonly maxDd7d = computed(() => {
    let max = 0;
    for (const r of this.analyticsRows()) if (r.drawdownPct > max) max = r.drawdownPct;
    const s = this.snapshot();
    if (s && s.drawdownPct > max) max = s.drawdownPct;
    return max;
  });

  // Days since the most recent equity peak — when did we last touch
  // peakEquity? If currentEquity == peakEquity right now, this is 0.
  readonly daysSincePeak = computed(() => {
    const s = this.snapshot();
    if (!s) return 0;
    if (s.currentEquity >= s.peakEquity) return 0;
    // Walk the analytics rows newest-to-oldest looking for the most recent
    // moment where equity was at or near the current peak.
    const target = s.peakEquity;
    const rows = this.analyticsRows();
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].currentEquity >= target * 0.9999) {
        const elapsed = Date.now() - new Date(rows[i].recordedAt).getTime();
        return Math.max(0, Math.floor(elapsed / this.DAY_MS));
      }
    }
    // Fall back to "older than the analytics window."
    if (rows.length > 0) {
      const elapsed = Date.now() - new Date(rows[0].recordedAt).getTime();
      return Math.floor(elapsed / this.DAY_MS);
    }
    return 0;
  });

  // How long the engine has been continuously in the current mode — walk
  // backwards through history while the mode matches the latest snapshot.
  readonly timeInCurrentModeHours = computed(() => {
    const s = this.snapshot();
    if (!s) return 0;
    const rows = this.analyticsRows();
    if (rows.length === 0) return 0;
    let startedAt: number | null = null;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].recoveryMode === s.recoveryMode) {
        startedAt = new Date(rows[i].recordedAt).getTime();
      } else {
        break;
      }
    }
    if (startedAt === null) return 0;
    return Math.round((Date.now() - startedAt) / (60 * 60 * 1000));
  });

  // List of mode transitions across the analytics window.
  readonly modeTransitions = computed(() => this.computeModeTransitions(this.analyticsRows()));

  // Seconds in each mode across the analytics window. Each adjacent pair of
  // snapshots contributes its time interval to the earlier snapshot's mode.
  readonly modeBreakdownSeconds = computed(() => this.computeModeBreakdown(this.analyticsRows()));

  modeColorFor(mode: RecoveryMode): string {
    return MODE_COLOR[mode];
  }

  // ── Live-tab charts ──────────────────────────────────────────────────────

  readonly liveSparklineOptions = computed<EChartsOption>(() => {
    const cutoff = Date.now() - this.DAY_MS;
    const rows = this.analyticsRows().filter((r) => new Date(r.recordedAt).getTime() >= cutoff);
    if (rows.length === 0) {
      return {
        title: {
          text: 'No drawdown samples in last 24h',
          left: 'center',
          top: 'middle',
          textStyle: { fontSize: 12, color: '#8E8E93', fontWeight: 'normal' },
        },
      };
    }
    return {
      grid: { left: 40, right: 16, top: 16, bottom: 24 },
      tooltip: { trigger: 'axis' },
      xAxis: {
        type: 'time',
        axisLabel: { fontSize: 10, color: '#6E6E73' },
      },
      yAxis: {
        type: 'value',
        axisLabel: { fontSize: 10, color: '#6E6E73', formatter: '{value}%' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      series: [
        {
          type: 'line',
          smooth: true,
          showSymbol: false,
          data: rows.map((r) => [r.recordedAt, r.drawdownPct]),
          lineStyle: { width: 2, color: '#FF9500' },
          areaStyle: { color: 'rgba(255, 149, 0, 0.16)' },
          markLine: {
            silent: true,
            symbol: 'none',
            label: { fontSize: 9, color: '#6E6E73' },
            data: [
              {
                yAxis: 5,
                lineStyle: { color: '#FF9500', type: 'dashed', width: 1 },
                label: { formatter: 'Reduced' },
              },
              {
                yAxis: 10,
                lineStyle: { color: '#FF3B30', type: 'dashed', width: 1 },
                label: { formatter: 'Halted' },
              },
            ],
          },
        },
      ],
    };
  });

  readonly modeBreakdownDonutOptions = computed<EChartsOption>(() => {
    const breakdown = this.modeBreakdownSeconds();
    const data = (Object.entries(breakdown) as [RecoveryMode, number][])
      .filter(([, secs]) => secs > 0)
      .map(([mode, secs]) => ({
        name: mode,
        value: Math.round(secs / 60),
        itemStyle: { color: MODE_COLOR[mode] },
      }));
    if (data.length === 0) {
      return {
        title: {
          text: 'No samples in window',
          left: 'center',
          top: 'middle',
          textStyle: { fontSize: 12, color: '#8E8E93', fontWeight: 'normal' },
        },
      };
    }
    return {
      tooltip: {
        trigger: 'item',
        formatter: (params: any) => {
          const mins: number = params.value;
          const hours = Math.floor(mins / 60);
          const remMins = mins % 60;
          const label = hours > 0 ? `${hours}h ${remMins}m` : `${mins}m`;
          return `${params.name}: ${label} (${params.percent}%)`;
        },
      },
      legend: { bottom: 0, textStyle: { fontSize: 10, color: '#6E6E73' } },
      series: [
        {
          type: 'pie',
          radius: ['45%', '70%'],
          center: ['50%', '45%'],
          label: { show: false },
          data,
        },
      ],
    };
  });

  // ── Helpers for both tabs ────────────────────────────────────────────────

  private computeModeTransitions(rows: DrawdownSnapshotDto[]): {
    at: string;
    from: RecoveryMode;
    to: RecoveryMode;
    drawdownPct: number;
  }[] {
    const out: { at: string; from: RecoveryMode; to: RecoveryMode; drawdownPct: number }[] = [];
    for (let i = 1; i < rows.length; i++) {
      if (rows[i].recoveryMode !== rows[i - 1].recoveryMode) {
        out.push({
          at: rows[i].recordedAt,
          from: rows[i - 1].recoveryMode,
          to: rows[i].recoveryMode,
          drawdownPct: rows[i].drawdownPct,
        });
      }
    }
    return out;
  }

  private computeModeBreakdown(rows: DrawdownSnapshotDto[]): Record<RecoveryMode, number> {
    const out: Record<RecoveryMode, number> = { Normal: 0, Reduced: 0, Halted: 0 };
    for (let i = 1; i < rows.length; i++) {
      const dt =
        (new Date(rows[i].recordedAt).getTime() - new Date(rows[i - 1].recordedAt).getTime()) /
        1000;
      if (dt > 0 && dt < 7 * this.DAY_MS) {
        out[rows[i - 1].recoveryMode] += dt;
      }
    }
    return out;
  }

  // ── History tab ──────────────────────────────────────────────────────────
  readonly historySeries = signal<DrawdownSnapshotDto[]>([]);
  readonly historyLoading = signal(false);
  readonly historyChartCount = computed(() => this.historySeries().length);
  readonly annotations = signal<ChartAnnotationDto[]>([]);

  // History-tab KPI strip + breakdown — analytics computed from the loaded
  // page (no extra fetch). The page is already oldest-first.
  readonly historyMaxDd = computed(() => {
    let max = 0;
    for (const r of this.historySeries()) if (r.drawdownPct > max) max = r.drawdownPct;
    return max;
  });

  readonly historyAvgDd = computed(() => {
    const rows = this.historySeries();
    if (rows.length === 0) return 0;
    const sum = rows.reduce((s, r) => s + (r.drawdownPct ?? 0), 0);
    return sum / rows.length;
  });

  readonly historyEquityRange = computed(() => {
    const rows = this.historySeries();
    if (rows.length === 0) return 0;
    let min = Infinity;
    let max = -Infinity;
    for (const r of rows) {
      if (r.currentEquity < min) min = r.currentEquity;
      if (r.currentEquity > max) max = r.currentEquity;
    }
    return Number.isFinite(min) && Number.isFinite(max) ? max - min : 0;
  });

  readonly historyModeTransitions = computed(() =>
    this.computeModeTransitions(this.historySeries()),
  );

  readonly historyModeBreakdownSeconds = computed(() =>
    this.computeModeBreakdown(this.historySeries()),
  );

  readonly historyTimeInNonNormalPct = computed(() => {
    const b = this.historyModeBreakdownSeconds();
    const total = b.Normal + b.Reduced + b.Halted;
    if (total === 0) return 0;
    return ((b.Reduced + b.Halted) / total) * 100;
  });

  readonly historyModeDonutOptions = computed<EChartsOption>(() => {
    const b = this.historyModeBreakdownSeconds();
    const data = (Object.entries(b) as [RecoveryMode, number][])
      .filter(([, secs]) => secs > 0)
      .map(([mode, secs]) => ({
        name: mode,
        value: Math.round(secs / 60),
        itemStyle: { color: MODE_COLOR[mode] },
      }));
    if (data.length === 0) {
      return {
        title: {
          text: 'No samples in loaded page',
          left: 'center',
          top: 'middle',
          textStyle: { fontSize: 12, color: '#8E8E93', fontWeight: 'normal' },
        },
      };
    }
    return {
      tooltip: {
        trigger: 'item',
        formatter: (params: any) => {
          const mins: number = params.value;
          const hours = Math.floor(mins / 60);
          const remMins = mins % 60;
          const label = hours > 0 ? `${hours}h ${remMins}m` : `${mins}m`;
          return `${params.name}: ${label} (${params.percent}%)`;
        },
      },
      legend: { bottom: 0, textStyle: { fontSize: 10, color: '#6E6E73' } },
      series: [
        {
          type: 'pie',
          radius: ['45%', '70%'],
          center: ['50%', '45%'],
          label: { show: false },
          data,
        },
      ],
    };
  });

  // ── Annotation editor state ───────────────────────────────────────────
  readonly annotationDrawerOpen = signal(false);
  readonly creatingAnnotation = signal(false);
  /** ngModel-bound. `datetime-local` yields `YYYY-MM-DDTHH:mm` (no TZ). */
  annotWhen = '';
  annotBody = '';

  readonly historyChart = computed<EChartsOption>(() => {
    const series = this.historySeries();
    if (series.length === 0) return {};
    return {
      grid: { left: 56, right: 24, top: 24, bottom: 36 },
      tooltip: { trigger: 'axis' },
      legend: { data: ['Drawdown %', 'Equity'] },
      xAxis: {
        type: 'time',
        axisLabel: { color: 'var(--text-secondary)' },
      },
      yAxis: [
        { type: 'value', name: 'DD %', position: 'left', axisLabel: { formatter: '{value}%' } },
        { type: 'value', name: 'Equity', position: 'right' },
      ],
      series: [
        {
          name: 'Drawdown %',
          type: 'line',
          yAxisIndex: 0,
          smooth: true,
          showSymbol: false,
          data: series.map((s) => [s.recordedAt, s.drawdownPct]),
          lineStyle: { width: 2, color: '#FF9500' },
          areaStyle: { color: 'rgba(255, 149, 0, 0.12)' },
          markPoint: {
            symbol: 'circle',
            symbolSize: 8,
            data: series
              .filter((s) => s.recoveryMode !== 'Normal')
              .map((s) => ({
                name: s.recoveryMode,
                value: s.drawdownPct,
                xAxis: s.recordedAt,
                yAxis: s.drawdownPct,
                itemStyle: { color: MODE_COLOR[s.recoveryMode] },
              })),
          },
        },
        {
          name: 'Equity',
          type: 'line',
          yAxisIndex: 1,
          smooth: true,
          showSymbol: false,
          data: series.map((s) => [s.recordedAt, s.currentEquity]),
          lineStyle: { width: 2, color: '#0A84FF' },
        },
        // Operator-authored annotations overlaid as a scatter series, pinned
        // to a fixed y-height (0) on the drawdown axis so they read as
        // "things that happened at this timestamp." Tooltip formatter shows
        // the body; escaping keeps malicious bodies out of the DOM.
        {
          name: 'Notes',
          type: 'scatter',
          yAxisIndex: 0,
          symbol: 'pin',
          symbolSize: 22,
          itemStyle: { color: '#0A84FF' },
          data: this.annotations().map((a) => ({
            name: 'Note',
            value: [a.annotatedAt, 0],
            // ECharts passes a value param; we render only the body (escaped).
            tooltip: { formatter: `<strong>Note</strong><br/>${escapeHtml(a.body)}` },
          })),
          emphasis: { scale: true },
        },
      ],
    };
  });

  readonly historyColumns: ColDef<DrawdownSnapshotDto>[] = [
    {
      headerName: 'Recorded',
      field: 'recordedAt',
      width: 200,
      valueFormatter: (p) => new Date(p.value as string).toLocaleString(),
    },
    {
      headerName: 'Mode',
      field: 'recoveryMode',
      width: 120,
      cellRenderer: (p: { value: RecoveryMode }) => {
        const color = MODE_COLOR[p.value];
        return `<span style="color: ${color}; font-weight: 600;">${MODE_LABEL[p.value] ?? p.value}</span>`;
      },
    },
    {
      headerName: 'Drawdown %',
      field: 'drawdownPct',
      width: 140,
      type: 'numericColumn',
      valueFormatter: (p) => (p.value as number)?.toFixed(2) + '%',
    },
    {
      headerName: 'Current Equity',
      field: 'currentEquity',
      width: 160,
      type: 'numericColumn',
      valueFormatter: (p) =>
        (p.value as number)?.toLocaleString(undefined, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }),
    },
    {
      headerName: 'Peak Equity',
      field: 'peakEquity',
      width: 160,
      type: 'numericColumn',
      valueFormatter: (p) =>
        (p.value as number)?.toLocaleString(undefined, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }),
    },
  ];

  readonly fetchHistoryPage = (params: {
    currentPage?: number;
    itemCountPerPage?: number;
    filter?: any;
  }) => {
    this.historyLoading.set(true);
    return this.service
      .listHistory({
        currentPage: params.currentPage,
        itemCountPerPage: params.itemCountPerPage,
        filter: params.filter,
      })
      .pipe(
        map((res) => {
          const empty = {
            pager: {
              totalItemCount: 0,
              filter: null,
              currentPage: 1,
              itemCountPerPage: 25,
              pageNo: 1,
              pageSize: 25,
            },
            data: [] as DrawdownSnapshotDto[],
          };
          const page = res.data ?? empty;
          // Chart wants oldest-first; engine returns newest-first.
          this.historySeries.set([...page.data].reverse());
          this.historyLoading.set(false);
          // Fire-and-forget — the chart re-renders on annotation arrival,
          // and a failed annotation load shouldn't break the table page.
          this.loadAnnotationsForSeries(page.data);
          return page;
        }),
        catchError(() => {
          this.historySeries.set([]);
          this.historyLoading.set(false);
          return of({
            pager: {
              totalItemCount: 0,
              filter: null,
              currentPage: 1,
              itemCountPerPage: 25,
              pageNo: 1,
              pageSize: 25,
            },
            data: [] as DrawdownSnapshotDto[],
          });
        }),
      );
  };

  modeLabel(mode: RecoveryMode): string {
    return MODE_LABEL[mode] ?? String(mode);
  }

  // ── Annotation editor ────────────────────────────────────────────────

  openCreateAnnotation(): void {
    // Default to "now" so the common case (just happened) is a single click.
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    this.annotWhen = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
    this.annotBody = '';
    this.annotationDrawerOpen.set(true);
  }

  closeAnnotationDrawer(): void {
    if (this.creatingAnnotation()) return; // don't close mid-save
    this.annotationDrawerOpen.set(false);
  }

  submitAnnotation(): void {
    const body = this.annotBody.trim();
    if (!body || !this.annotWhen) return;
    // `datetime-local` value is local time; convert to UTC ISO before posting.
    const annotatedAt = new Date(this.annotWhen).toISOString();
    this.creatingAnnotation.set(true);
    this.annotationsService
      .create({ target: 'drawdown', annotatedAt, body })
      .pipe(catchError(() => of(null)))
      .subscribe((res) => {
        this.creatingAnnotation.set(false);
        if (res?.status) {
          // Refresh against the current window so the new note shows up.
          this.loadAnnotationsForSeries(this.historySeries());
          this.annotationDrawerOpen.set(false);
        }
      });
  }

  /**
   * Fetches chart annotations covering the loaded series's time range and
   * stashes them on `this.annotations`. Network + parse errors leave the
   * annotation layer empty rather than bubble up.
   */
  private loadAnnotationsForSeries(series: DrawdownSnapshotDto[]): void {
    if (series.length === 0) {
      this.annotations.set([]);
      return;
    }
    const earliest = series.reduce(
      (min, s) => (new Date(s.recordedAt) < new Date(min) ? s.recordedAt : min),
      series[0].recordedAt,
    );
    const latest = series.reduce(
      (max, s) => (new Date(s.recordedAt) > new Date(max) ? s.recordedAt : max),
      series[0].recordedAt,
    );

    this.annotationsService
      .list('drawdown', {
        currentPage: 1,
        itemCountPerPage: 100,
        filter: { from: earliest, to: latest },
      })
      .pipe(catchError(() => of(null)))
      .subscribe((res) => {
        this.annotations.set(res?.data?.data ?? []);
      });
  }
}

/** Minimal HTML escape — ECharts renders tooltip strings as raw HTML. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
