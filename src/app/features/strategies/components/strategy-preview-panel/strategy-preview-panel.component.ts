import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnInit,
  ViewChild,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import type { FormGroup } from '@angular/forms';

import type {
  BacktestPreviewResult,
  BacktestPreviewSnapshotDto,
  RunBacktestPreviewRequest,
  SaveBacktestPreviewSnapshotRequest,
} from '@core/api/api.types';
import { NotificationService } from '@core/notifications/notification.service';
import { StrategiesService } from '@core/services/strategies.service';
import { fmtFraction, fmtProfitFactor, isNoLossProfitFactor } from '@shared/utils/metric-format';

export interface OverlayCurve {
  id: string;
  label: string;
  color: string;
  points: string;
  /// Inline-rendered metrics for the legend ("S 1.42 · W 58% · DD 6.3%").
  /// Empty for the live-preview series until a result lands; populated
  /// from each saved snapshot's persisted fields.
  metrics: string;
}

/**
 * The strategy form's backtest preview panel (U13: split out of StrategyFormComponent, behaviour unchanged): a
 * synchronous, server-bounded preview of the UNSAVED configuration (≤90 d, ≤6000 candles, 60 s), saved server-side
 * snapshots with notes, and the equity overlay chart. It reads the form's current values through `form`.
 */
@Component({
  selector: 'app-strategy-preview-panel',
  standalone: true,
  imports: [DatePipe, DecimalPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <!-- Backtest preview panel — synchronous, server-bounded (≤90d, ≤6000
       candles, 60s deadline). Operators see real Sharpe / win-rate / max DD
       before saving. Single-symbol only; multi-symbol previews are too noisy
       to interpret in one panel. -->
    <div class="preview-panel">
      <div class="preview-controls">
        <label class="form-label" style="margin:0;">
          Backtest preview window
          <select
            class="form-input preview-window-select"
            [value]="previewLookbackDays()"
            (change)="previewLookbackDays.set(+$any($event.target).value)"
          >
            <option [value]="7">7 days</option>
            <option [value]="14">14 days</option>
            <option [value]="30">30 days</option>
            <option [value]="60">60 days</option>
            <option [value]="90">90 days</option>
          </select>
        </label>
        <button
          type="button"
          class="btn btn-secondary preview-run-btn"
          (click)="runBacktestPreview()"
          [disabled]="runningPreview() || form().invalid"
        >
          @if (runningPreview()) {
            <span class="spinner-sm"></span> Running…
          } @else {
            Run preview
          }
        </button>
      </div>
      @if (previewError(); as err) {
        <div class="preview-error">{{ err }}</div>
      }
      @if (previewResult(); as r) {
        <div class="preview-stats">
          <div class="preview-stat">
            <span class="preview-stat-label">Trades</span>
            <span class="preview-stat-value mono">{{ r.totalTrades }}</span>
            <span class="preview-stat-sub">{{ r.winningTrades }}W / {{ r.losingTrades }}L</span>
          </div>
          <div class="preview-stat">
            <span class="preview-stat-label">Win rate</span>
            <span
              class="preview-stat-value mono"
              [class.positive]="r.winRate >= 0.5"
              [class.negative]="r.winRate < 0.5 && r.totalTrades > 0"
              >{{ fmtFraction(r.winRate) }}</span
            >
          </div>
          <div class="preview-stat">
            <span class="preview-stat-label">Sharpe</span>
            <span
              class="preview-stat-value mono"
              [class.positive]="r.sharpeRatio >= 1"
              [class.negative]="r.sharpeRatio < 0"
              >{{ r.sharpeRatio.toFixed(2) }}</span
            >
          </div>
          <div class="preview-stat">
            <span class="preview-stat-label">Profit factor</span>
            <span
              class="preview-stat-value mono"
              [class.positive]="r.profitFactor >= 1.5"
              [class.negative]="r.profitFactor < 1 && r.totalTrades > 0"
              [title]="isNoLossProfitFactor(r.profitFactor) ? 'No losing trades in the window' : ''"
              >{{ fmtProfitFactor(r.profitFactor, 2, r.totalTrades > 0) }}</span
            >
          </div>
          <div class="preview-stat">
            <span class="preview-stat-label">Max DD</span>
            <span class="preview-stat-value mono" [class.negative]="r.maxDrawdownPct >= 10"
              >{{ r.maxDrawdownPct.toFixed(1) }}%</span
            >
          </div>
          <div class="preview-stat">
            <span class="preview-stat-label">Return</span>
            <span
              class="preview-stat-value mono"
              [class.positive]="r.totalReturn > 0"
              [class.negative]="r.totalReturn < 0"
              >{{ r.totalReturn.toFixed(1) }}%</span
            >
          </div>
        </div>
        @if (r.equityCurve && r.equityCurve.length > 1) {
          <div class="equity-sparkline">
            <span class="muted small">Equity curve</span>
            <svg width="100%" height="80" preserveAspectRatio="none" viewBox="0 0 400 80">
              <polyline
                [attr.points]="equitySparklinePoints(r.equityCurve, 400, 80)"
                fill="none"
                [attr.stroke]="r.finalBalance >= r.initialBalance ? '#248A3D' : '#D70015'"
                stroke-width="1.5"
              />
              <line
                [attr.x1]="0"
                [attr.x2]="400"
                [attr.y1]="equityBaselineY(r.equityCurve, r.initialBalance, 80)"
                [attr.y2]="equityBaselineY(r.equityCurve, r.initialBalance, 80)"
                stroke="rgba(0,0,0,0.15)"
                stroke-dasharray="2,3"
                stroke-width="1"
              />
            </svg>
          </div>
        }
        <div class="preview-meta">
          {{ r.candlesAnalyzed | number }} candles analysed · final balance &#36;{{
            r.finalBalance.toFixed(0)
          }}
          @if (r.note) {
            · <em>{{ r.note }}</em>
          }
          <button
            type="button"
            class="btn btn-link preview-snapshot-btn"
            (click)="snapshotPreview()"
            title="Save this preview to compare against later runs"
          >
            📌 Snapshot
          </button>
        </div>
      }
      @if (previewSnapshots().length > 0) {
        <div class="preview-snapshots">
          <div class="preview-snapshots-head">
            <span class="muted small">Saved snapshots ({{ previewSnapshots().length }})</span>
            <span class="muted small">·</span>
            <button
              type="button"
              class="btn btn-link"
              (click)="toggleSnapshotFilter()"
              [title]="
                snapshotFilterMode() === 'matching'
                  ? 'Currently matching this config — click to show all configs'
                  : 'Currently all configs — click to filter to this config'
              "
            >
              {{ snapshotFilterMode() === 'matching' ? 'this config' : 'all configs' }}
            </button>
            <span class="muted small">·</span>
            <button
              type="button"
              class="btn btn-link"
              (click)="toggleSnapshotScope()"
              [title]="
                snapshotScope() === 'mine'
                  ? 'Currently your snapshots — click to include other operators'
                  : 'Currently every operator — click to filter to yours'
              "
            >
              {{ snapshotScope() === 'mine' ? 'yours' : 'everyone' }}
            </button>
          </div>
          <table class="preview-snapshot-table">
            <thead>
              <tr>
                <th>Captured</th>
                <th>Strategy</th>
                <th>Sharpe</th>
                <th>Win %</th>
                <th>Max DD</th>
                <th>Return</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              @for (s of previewSnapshots(); track s.id) {
                <tr>
                  <td>{{ s.capturedAt | date: 'MM-dd HH:mm' }}</td>
                  <td class="mono" [title]="s.label ?? ''">
                    {{ s.symbol }}/{{ s.timeframe }} · {{ s.strategyType }}
                  </td>
                  <td class="mono">{{ s.sharpeRatio.toFixed(2) }}</td>
                  <td class="mono">{{ fmtFraction(s.winRate) }}</td>
                  <td class="mono">{{ s.maxDrawdownPct.toFixed(1) }}%</td>
                  <td class="mono">{{ s.totalReturn.toFixed(1) }}%</td>
                  <td>
                    <button
                      type="button"
                      class="btn btn-link"
                      (click)="toggleSnapshotNotes(s)"
                      [title]="s.notes ? 'Edit notes — currently: ' + s.notes : 'Add notes'"
                    >
                      📝
                    </button>
                    <button
                      type="button"
                      class="btn btn-link"
                      (click)="deleteSnapshot(s)"
                      [disabled]="deletingSnapshotId() === s.id"
                      title="Delete this saved snapshot"
                    >
                      🗑
                    </button>
                  </td>
                </tr>
                @if (editingNotesId() === s.id) {
                  <tr class="snapshot-notes-row">
                    <td colspan="7">
                      <textarea
                        class="form-input form-textarea"
                        rows="2"
                        placeholder="Notes (optional)…"
                        [value]="editingNotesText()"
                        (input)="editingNotesText.set($any($event.target).value)"
                      ></textarea>
                      <div style="margin-top:4px;display:flex;gap:8px;justify-content:flex-end;">
                        <button
                          type="button"
                          class="btn btn-link"
                          (click)="editingNotesId.set(null)"
                        >
                          Cancel
                        </button>
                        <button type="button" class="btn btn-link" (click)="saveSnapshotNotes(s)">
                          Save notes
                        </button>
                      </div>
                    </td>
                  </tr>
                }
              }
            </tbody>
          </table>
          @if (overlayCurves().length > 0) {
            <div class="overlay-chart">
              <div class="overlay-chart-head">
                <span class="muted small">
                  Equity-curve overlay · {{ visibleCurves().length }}/{{ overlayCurves().length }}
                  series
                </span>
                <label
                  class="dsl-checkbox"
                  title="Plot all curves on a shared y-axis to compare absolute returns instead of just shape"
                >
                  <input
                    type="checkbox"
                    [checked]="overlaySharedY()"
                    (change)="overlaySharedY.set($any($event.target).checked)"
                  />
                  <span class="muted small">shared y-axis</span>
                </label>
                <button
                  type="button"
                  class="btn btn-link"
                  (click)="exportOverlayPng()"
                  title="Download the overlay chart as a PNG"
                >
                  📥 PNG
                </button>
              </div>
              <div class="overlay-svg-wrap">
                @if (overlaySharedY() && overlayBounds(); as b) {
                  <span class="overlay-y-max muted small">{{ b.max | number: '1.0-0' }}</span>
                  <span class="overlay-y-min muted small">{{ b.min | number: '1.0-0' }}</span>
                }
                <svg
                  #overlaySvg
                  class="overlay-svg"
                  viewBox="0 0 320 80"
                  preserveAspectRatio="none"
                >
                  @for (c of visibleCurves(); track c.id) {
                    <polyline
                      fill="none"
                      [attr.stroke]="c.color"
                      stroke-width="1.4"
                      [attr.points]="c.points"
                    />
                  }
                </svg>
              </div>
              <div class="overlay-legend">
                @for (c of overlayCurves(); track c.id) {
                  <button
                    type="button"
                    class="overlay-legend-item"
                    [class.is-hidden]="hiddenCurves().has(c.id)"
                    (click)="toggleCurveVisibility(c.id)"
                    [title]="hiddenCurves().has(c.id) ? 'Show ' + c.label : 'Hide ' + c.label"
                  >
                    <span class="overlay-legend-swatch" [style.background]="c.color"></span>
                    <span class="overlay-legend-text">{{ c.label }}</span>
                    @if (c.metrics) {
                      <span class="overlay-legend-metrics muted small">{{ c.metrics }}</span>
                    }
                  </button>
                }
              </div>
            </div>
          }
        </div>
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
      }

      .form-label {
        display: block;
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        color: var(--text-secondary);
        margin-bottom: var(--space-1);
      }

      .form-input {
        width: 100%;
        height: 36px;
        padding: 0 var(--space-3);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-sm);
        font-family: inherit;
        outline: none;
        box-sizing: border-box;
        transition: border-color 0.15s ease;
      }

      .form-input:focus {
        border-color: var(--accent);
        box-shadow: 0 0 0 3px rgba(0, 113, 227, 0.1);
      }

      .form-textarea {
        height: auto;
        padding: var(--space-2) var(--space-3);
        resize: vertical;
        line-height: 1.5;
      }

      .btn {
        height: 36px;
        padding: 0 var(--space-5);
        border: none;
        border-radius: var(--radius-full);
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        font-family: inherit;
        cursor: pointer;
        transition: all 0.15s ease;
        display: flex;
        align-items: center;
        justify-content: center;
        min-width: 80px;
      }

      .btn:active:not(:disabled) {
        transform: scale(0.97);
      }

      .btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .btn-secondary {
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }

      .btn-secondary:hover:not(:disabled) {
        opacity: 0.8;
      }

      .spinner-sm {
        display: inline-block;
        width: 12px;
        height: 12px;
        border: 2px solid rgba(0, 113, 227, 0.3);
        border-top-color: #0071e3;
        border-radius: 50%;
        animation: spin 0.6s linear infinite;
      }

      .preview-panel {
        background: var(--bg-tertiary, #fafafa);
        border: 1px solid var(--border, #e5e5ea);
        border-radius: 8px;
        padding: 12px;
        margin: 12px 0;
      }

      .preview-controls {
        display: flex;
        align-items: flex-end;
        gap: 12px;
        margin-bottom: 8px;
      }

      .preview-window-select {
        width: 110px;
        font-size: 12px;
      }

      .preview-run-btn {
        font-size: 12px;
        padding: 6px 14px;
      }

      .preview-stats {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(min(110px, 100%), 1fr));
        gap: 8px;
        margin-top: 8px;
      }

      .preview-stat {
        display: flex;
        flex-direction: column;
        gap: 2px;
        padding: 6px 8px;
        background: var(--bg-primary, #fff);
        border-radius: 4px;
      }

      .preview-stat-label {
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-secondary, #636366);
      }

      .preview-stat-value {
        font-size: 14px;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
      }

      .preview-stat-sub {
        font-size: 10px;
        color: var(--text-tertiary, #8e8e93);
      }

      .preview-stat-value.positive {
        color: #248a3d;
      }

      .preview-stat-value.negative {
        color: #d70015;
      }

      .preview-meta {
        font-size: 11px;
        color: var(--text-tertiary, #8e8e93);
        margin-top: 8px;
      }

      .preview-error {
        background: rgba(255, 59, 48, 0.08);
        border: 1px solid rgba(255, 59, 48, 0.32);
        color: #d70015;
        padding: 8px 12px;
        border-radius: 4px;
        font-size: 12px;
        margin-top: 8px;
      }

      .btn.clone-link {
        margin-left: auto;
        height: 28px;
        padding: 0 10px;
        font-size: 12px;
        background: transparent;
        color: var(--accent);
      }

      .mono {
        font-family: 'SF Mono', Menlo, monospace;
      }

      .template-save-row .form-input {
        flex: 1;
      }

      .equity-sparkline {
        display: block;
        margin-top: 8px;
        padding: 8px;
        background: var(--bg-primary, #fff);
        border-radius: 4px;
      }

      .equity-sparkline svg {
        display: block;
      }

      .preview-snapshot-btn {
        font-size: 11px;
        padding: 2px 8px;
        margin-left: 8px;
      }

      .preview-snapshots {
        margin-top: 12px;
        padding: 10px;
        background: var(--bg-secondary, #f7f8fa);
        border: 1px solid var(--border, #e4e7eb);
        border-radius: 6px;
      }

      .preview-snapshots-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 6px;
      }

      .preview-snapshot-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 12px;
      }

      .preview-snapshot-table th,
      .preview-snapshot-table td {
        text-align: left;
        padding: 4px 6px;
        border-bottom: 1px solid var(--border);
      }

      .preview-snapshot-table th {
        font-weight: var(--font-semibold, 600);
        color: var(--text-secondary, #5a6273);
      }

      .preview-snapshot-table tr:last-child td {
        border-bottom: none;
      }

      .overlay-chart {
        margin-top: 8px;
        padding: 6px 4px 0;
        border-top: 1px solid var(--border);
      }

      .overlay-chart-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 4px;
        gap: 12px;
      }

      .overlay-svg-wrap {
        position: relative;
      }

      .overlay-svg {
        width: 100%;
        height: 80px;
        display: block;
      }

      .overlay-y-max,
      .overlay-y-min {
        position: absolute;
        right: 4px;
        font-variant-numeric: tabular-nums;
        background: rgba(255, 255, 255, 0.7);
        padding: 0 3px;
        border-radius: 2px;
      }

      .overlay-y-max {
        top: 0;
      }

      .overlay-y-min {
        bottom: 0;
      }

      .overlay-legend {
        display: flex;
        flex-wrap: wrap;
        gap: 4px 10px;
        margin-top: 6px;
      }

      .overlay-legend-item {
        background: transparent;
        border: 1px solid transparent;
        padding: 2px 6px;
        font-size: 11px;
        color: var(--text-primary, #1d1d1f);
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 5px;
        border-radius: 3px;
      }

      .overlay-legend-item:hover {
        background: rgba(0, 113, 227, 0.06);
      }

      .overlay-legend-item.is-hidden {
        opacity: 0.4;
        text-decoration: line-through;
      }

      .overlay-legend-swatch {
        display: inline-block;
        width: 10px;
        height: 10px;
        border-radius: 2px;
      }

      .overlay-legend-metrics {
        font-variant-numeric: tabular-nums;
        font-family: 'SF Mono', Menlo, monospace;
        font-size: 10px;
      }

      .dsl-checkbox {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        font-size: 11px;
        cursor: pointer;
      }

      .version-manual-capture .form-input {
        flex: 1;
        font-size: 12px;
        padding: 4px 6px;
        height: 26px;
      }

      .snapshot-notes-row td {
        padding: 6px 4px;
        background: var(--bg-secondary, #fafbfc);
      }
    `,
  ],
})
export class StrategyPreviewPanelComponent implements OnInit {
  private readonly strategiesService = inject(StrategiesService);
  private readonly notifications = inject(NotificationService);

  /** The strategy form whose current values are previewed and snapshotted. */
  readonly form = input.required<FormGroup>();

  protected readonly fmtFraction = fmtFraction;
  protected readonly fmtProfitFactor = fmtProfitFactor;
  protected readonly isNoLossProfitFactor = isNoLossProfitFactor;

  // ── Backtest preview state ──────────────────────────────────────────────
  // Synchronous preview backtest of the unsaved configuration. Bounded by
  // the server (≤90d / ≤6000 candles / 60s) so the call returns within
  // seconds. Operators see real Sharpe / win-rate / max DD before saving.
  runningPreview = signal(false);
  previewResult = signal<BacktestPreviewResult | null>(null);
  previewError = signal<string | null>(null);
  previewLookbackDays = signal<number>(30);
  /// Saved snapshots of past previews for side-by-side comparison. Backed by
  /// the engine's BacktestPreviewSnapshot table — visible across browsers and
  /// sessions, with no 3-row localStorage cap.
  previewSnapshots = signal<BacktestPreviewSnapshotDto[]>([]);
  /// 'matching' filters snapshots to the current symbol/timeframe/strategyType
  /// so the overlay compares like-for-like; 'all' shows everything.
  snapshotFilterMode = signal<'matching' | 'all'>('matching');
  /// 'mine' (default) limits the listing to the current operator's snapshots;
  /// 'all' surfaces every operator's snapshots for cross-operator comparison.
  snapshotScope = signal<'mine' | 'all'>('mine');
  savingSnapshot = signal(false);
  deletingSnapshotId = signal<number | null>(null);

  /// 'true' = all curves share one y-axis (compare absolute returns);
  /// 'false' = each curve normalised to its own min/max (compare shapes).
  overlaySharedY = signal(false);
  /// Curve ids the operator has hidden via the legend. Toggled per-id.
  hiddenCurves = signal<Set<string>>(new Set());

  /// SVG polyline series for the overlay chart: every saved snapshot's equity
  /// curve plus the current live preview if any. Reads {@link overlaySharedY}
  /// to decide between own-min/max (shape compare) and global min/max
  /// (absolute compare).
  overlayCurves = computed<OverlayCurve[]>(() => {
    const palette = ['#0071e3', '#34c759', '#ff9500', '#af52de', '#5ac8fa', '#ff3b30', '#8e8e93'];
    const series: { id: string; label: string; values: number[]; metrics: string }[] = [];

    const live = this.previewResult();
    if (live?.equityCurve && live.equityCurve.length > 1) {
      series.push({
        id: 'live',
        label: 'Live preview',
        values: live.equityCurve,
        metrics: `S ${live.sharpeRatio.toFixed(2)} · W ${fmtFraction(live.winRate, 0)} · DD ${live.maxDrawdownPct.toFixed(1)}% · R ${live.totalReturn.toFixed(1)}%`,
      });
    }
    for (const s of this.previewSnapshots()) {
      if (!s.equityCurveJson) continue;
      try {
        const v = JSON.parse(s.equityCurveJson);
        if (Array.isArray(v) && v.length > 1) {
          const label = s.label?.trim() || `${s.symbol}/${s.timeframe} #${s.id}`;
          series.push({
            id: `s${s.id}`,
            label,
            values: v as number[],
            metrics: `S ${s.sharpeRatio.toFixed(2)} · W ${fmtFraction(s.winRate, 0)} · DD ${s.maxDrawdownPct.toFixed(1)}% · R ${s.totalReturn.toFixed(1)}%`,
          });
        }
      } catch {
        /* skip malformed */
      }
    }

    // Shared-y bounds across all visible series.
    let globalMin = Infinity,
      globalMax = -Infinity;
    if (this.overlaySharedY()) {
      for (const s of series) {
        for (const v of s.values) {
          if (v < globalMin) globalMin = v;
          if (v > globalMax) globalMax = v;
        }
      }
      if (!isFinite(globalMin)) {
        globalMin = 0;
        globalMax = 1;
      }
    }

    return series.map((s, idx) => {
      const min = this.overlaySharedY() ? globalMin : Math.min(...s.values);
      const max = this.overlaySharedY() ? globalMax : Math.max(...s.values);
      const range = max - min || 1;
      const pts = s.values
        .map((v, i) => {
          const x = (i / (s.values.length - 1)) * 320;
          const y = 80 - ((v - min) / range) * 80;
          return `${x.toFixed(1)},${y.toFixed(1)}`;
        })
        .join(' ');
      return {
        id: s.id,
        label: s.label,
        color: s.id === 'live' ? '#0040dd' : palette[idx % palette.length],
        points: pts,
        metrics: s.metrics,
      };
    });
  });

  /// Curves the chart actually plots — overlayCurves minus any the operator
  /// has toggled off via the legend.
  visibleCurves = computed<OverlayCurve[]>(() => {
    const hidden = this.hiddenCurves();
    return this.overlayCurves().filter((c) => !hidden.has(c.id));
  });

  /// Global min/max across visible series — surfaced as the y-axis label
  /// pair when shared-y is on so operators can tell scale at a glance.
  overlayBounds = computed<{ min: number; max: number } | null>(() => {
    const curves = this.visibleCurves();
    if (!this.overlaySharedY() || curves.length === 0) return null;
    // The polyline points are normalised; we need to recompute from raw values.
    const live = this.previewResult();
    const all: number[] = [];
    if (live?.equityCurve) all.push(...live.equityCurve);
    for (const s of this.previewSnapshots()) {
      if (!s.equityCurveJson) continue;
      try {
        const v = JSON.parse(s.equityCurveJson);
        if (Array.isArray(v)) all.push(...(v as number[]));
      } catch {
        /* skip */
      }
    }
    if (all.length === 0) return null;
    return { min: Math.min(...all), max: Math.max(...all) };
  });

  /** Toggle whether a particular curve renders in the overlay chart. */
  toggleCurveVisibility(id: string): void {
    const next = new Set(this.hiddenCurves());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.hiddenCurves.set(next);
  }

  @ViewChild('overlaySvg') overlaySvgRef?: ElementRef<SVGSVGElement>;

  /**
   * Rasterise the overlay SVG to a PNG and trigger a download. Uses the
   * standard "serialise SVG → blob URL → Image → canvas → toDataURL" pipeline
   * so no canvas-rendering library is needed. Browser-quirk-safe; works in
   * every modern Chromium / Safari.
   */
  exportOverlayPng(): void {
    const svg = this.overlaySvgRef?.nativeElement;
    if (!svg) return;
    const xml = new XMLSerializer().serializeToString(svg);
    const blob = new Blob([xml], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      // 2x scale for crisp PNG on retina; 320x80 logical → 640x160 pixels.
      canvas.width = 640;
      canvas.height = 160;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        URL.revokeObjectURL(url);
        return;
      }
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      const a = document.createElement('a');
      a.download = `equity-overlay-${Date.now()}.png`;
      a.href = canvas.toDataURL('image/png');
      a.click();
    };
    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
  }

  /// When non-null, a snapshot row's notes editor is open for that id.
  editingNotesId = signal<number | null>(null);
  editingNotesText = signal('');

  /**
   * Persist the current preview as a server-side snapshot so it's visible
   * across browsers and sessions. Replaces the v1 localStorage-only path
   * which lost snapshots on browser clear and capped at 3 rows.
   */
  snapshotPreview(): void {
    const r = this.previewResult();
    if (r === null || this.savingSnapshot()) return;
    const v = this.form().value;

    const req: SaveBacktestPreviewSnapshotRequest = {
      label: `${v.symbol} ${v.timeframe} ${v.strategyType} · Sharpe ${r.sharpeRatio.toFixed(2)} · DD ${r.maxDrawdownPct.toFixed(1)}%`,
      symbol: v.symbol,
      timeframe: v.timeframe,
      strategyType: v.strategyType,
      lookbackDays: this.previewLookbackDays(),
      initialBalance: r.initialBalance,
      parametersJson: v.parametersJson || null,
      riskProfileId: v.riskProfileId ?? null,
      riskOverridesJson: v.riskOverridesJson || null,
      sizingConfigJson: v.sizingConfigJson || null,
      sessionFilterJson: v.sessionFilterJson || null,
      regimeGateJson: v.regimeGateJson || null,
      multiTimeframeGateJson: v.multiTimeframeGateJson || null,
      candlesAnalyzed: r.candlesAnalyzed,
      fromUtc: r.fromUtc,
      toUtc: r.toUtc,
      finalBalance: r.finalBalance,
      totalReturn: r.totalReturn,
      totalTrades: r.totalTrades,
      winningTrades: r.winningTrades,
      losingTrades: r.losingTrades,
      winRate: r.winRate,
      profitFactor: r.profitFactor,
      maxDrawdownPct: r.maxDrawdownPct,
      sharpeRatio: r.sharpeRatio,
      expectancy: r.expectancy,
      exposurePct: r.exposurePct,
      equityCurveJson:
        r.equityCurve && r.equityCurve.length > 0 ? JSON.stringify(r.equityCurve) : null,
    };

    this.savingSnapshot.set(true);
    this.strategiesService.savePreviewSnapshot(req).subscribe({
      next: (res) => {
        this.savingSnapshot.set(false);
        if (res?.status) {
          this.notifications.success('Snapshot saved');
          this.refreshPreviewSnapshots();
        } else {
          this.notifications.error(res?.message ?? 'Failed to save snapshot');
        }
      },
      error: () => {
        this.savingSnapshot.set(false);
        this.notifications.error('Failed to save snapshot');
      },
    });
  }

  /**
   * Refresh the saved-snapshot list from the engine. Filtered to the current
   * symbol/timeframe/strategyType when {@link snapshotFilterMode} is 'matching'
   * so the overlay chart compares like-for-like; flips to unfiltered when the
   * operator wants to see snapshots from other symbols too.
   */
  refreshPreviewSnapshots(): void {
    const v = this.form()?.value ?? {};
    const matching = this.snapshotFilterMode() === 'matching';
    const filter = {
      symbol: matching ? v.symbol : undefined,
      timeframe: matching ? v.timeframe : undefined,
      strategyType: matching ? v.strategyType : undefined,
      scope: this.snapshotScope(),
      limit: 50,
    };
    this.strategiesService.listPreviewSnapshots(filter).subscribe({
      next: (res) => this.previewSnapshots.set(res?.data ?? []),
      error: () => this.previewSnapshots.set([]),
    });
  }

  /** Toggle between matching-only and all-snapshots views; refetches. */
  toggleSnapshotFilter(): void {
    this.snapshotFilterMode.set(this.snapshotFilterMode() === 'matching' ? 'all' : 'matching');
    this.refreshPreviewSnapshots();
  }

  /** Toggle between own-snapshots and every-operator view; refetches. */
  toggleSnapshotScope(): void {
    this.snapshotScope.set(this.snapshotScope() === 'mine' ? 'all' : 'mine');
    this.refreshPreviewSnapshots();
  }

  /** Soft-delete a single snapshot. */
  deleteSnapshot(s: BacktestPreviewSnapshotDto): void {
    if (this.deletingSnapshotId() != null) return;
    this.deletingSnapshotId.set(s.id);
    this.strategiesService.deletePreviewSnapshot(s.id).subscribe({
      next: (res) => {
        this.deletingSnapshotId.set(null);
        if (res?.status) {
          this.previewSnapshots.update((rows) => rows.filter((r) => r.id !== s.id));
        } else {
          this.notifications.error(res?.message ?? 'Failed to delete snapshot');
        }
      },
      error: () => {
        this.deletingSnapshotId.set(null);
        this.notifications.error('Failed to delete snapshot');
      },
    });
  }

  /** Toggle the inline notes editor for a snapshot row. */
  toggleSnapshotNotes(s: BacktestPreviewSnapshotDto): void {
    if (this.editingNotesId() === s.id) {
      this.editingNotesId.set(null);
      this.editingNotesText.set('');
    } else {
      this.editingNotesId.set(s.id);
      this.editingNotesText.set(s.notes ?? '');
    }
  }

  /** Persist the in-progress notes value to the engine. */
  saveSnapshotNotes(s: BacktestPreviewSnapshotDto): void {
    const next = this.editingNotesText().trim() || null;
    this.strategiesService.updatePreviewSnapshotNotes(s.id, next).subscribe({
      next: (res) => {
        if (res?.status) {
          // Patch the local list so the operator sees the change without
          // refetching the whole list.
          this.previewSnapshots.update((rows) =>
            rows.map((r) => (r.id === s.id ? { ...r, notes: next } : r)),
          );
          this.editingNotesId.set(null);
          this.editingNotesText.set('');
          this.notifications.success('Notes updated');
        } else {
          this.notifications.error(res?.message ?? 'Failed to update notes');
        }
      },
      error: () => this.notifications.error('Failed to update notes'),
    });
  }

  /**
   * Renders an equity curve as a SVG polyline points string. Y-axis is
   * inverted (SVG origin top-left) so higher equity is at the top of the
   * sparkline. Min/max scaling fits the available height.
   */
  equitySparklinePoints(curve: number[], width: number, height: number): string {
    if (!curve || curve.length === 0) return '';
    const min = Math.min(...curve);
    const max = Math.max(...curve);
    const range = max - min || 1;
    return curve
      .map((v, i) => {
        const x = (i / Math.max(curve.length - 1, 1)) * width;
        const y = height - ((v - min) / range) * height;
        return `${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(' ');
  }

  /** Y-coordinate of the initial-balance baseline so operators see breakeven. */
  equityBaselineY(curve: number[], initial: number, height: number): number {
    if (!curve || curve.length === 0) return height;
    const min = Math.min(...curve);
    const max = Math.max(...curve);
    const range = max - min || 1;
    return height - ((initial - min) / range) * height;
  }

  /**
   * Fires a backtest preview against the current form values. Symbol is
   * required and must be a single value (multi-symbol is for save-time only).
   * The server enforces the bounds; this method only drives the loading state
   * and result display.
   */
  runBacktestPreview(): void {
    if (this.form().invalid) {
      this.notifications.error('Fix form errors before running a preview');
      return;
    }
    const v = this.form().value;
    const symbols = (v.symbol as string)
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter((s) => s.length > 0);
    if (symbols.length === 0) {
      this.notifications.error('Symbol is required');
      return;
    }
    if (symbols.length > 1) {
      this.notifications.error(
        'Preview supports a single symbol — pick one for the run, then save with the full basket.',
      );
      return;
    }

    const req: RunBacktestPreviewRequest = {
      symbol: symbols[0],
      timeframe: v.timeframe,
      strategyType: v.strategyType,
      parametersJson: v.parametersJson || '{}',
      lookbackDays: this.previewLookbackDays(),
      initialBalance: 10000,
      riskOverridesJson: v.riskOverridesJson || null,
      sizingConfigJson: v.sizingConfigJson || null,
      sessionFilterJson: v.sessionFilterJson || null,
      regimeGateJson: v.regimeGateJson || null,
      multiTimeframeGateJson: v.multiTimeframeGateJson || null,
    };

    this.runningPreview.set(true);
    this.previewError.set(null);
    this.previewResult.set(null);
    this.strategiesService.runBacktestPreview(req).subscribe({
      next: (res) => {
        this.runningPreview.set(false);
        if (res?.status && res.data) {
          this.previewResult.set(res.data);
          if (res.data.timedOut) this.previewError.set(res.data.note ?? 'Timed out');
        } else {
          this.previewError.set(res?.message ?? 'Preview failed');
        }
      },
      error: () => {
        this.runningPreview.set(false);
        this.previewError.set('Preview request failed');
      },
    });
  }

  ngOnInit(): void {
    // Hydrate server-side preview snapshots filtered to the current form
    // context so the comparison chart compares apples to apples.
    this.refreshPreviewSnapshots();
  }
}
