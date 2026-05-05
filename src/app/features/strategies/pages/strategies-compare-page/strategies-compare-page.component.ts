import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { catchError, forkJoin, of } from 'rxjs';
import type { EChartsOption } from 'echarts';

import { StrategiesService } from '@core/services/strategies.service';
import type { StrategyDto, StrategyEquityCurveDto } from '@core/api/api.types';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';

/**
 * Side-by-side comparison of 2–4 strategies. Picker drives a forkJoin over
 * the per-strategy equity-curve endpoint; the curves render normalized to
 * each strategy's first close-time so different start dates don't squash
 * shorter histories against the right edge.
 *
 * Cap at 4 because the chart legend gets unreadable past that and the
 * cumulative-pnl scale loses meaning when half the lines are flat starting
 * regions.
 */
@Component({
  selector: 'app-strategies-compare-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    PageHeaderComponent,
    ChartCardComponent,
    CardSkeletonComponent,
    EmptyStateComponent,
    FormsModule,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Strategy Compare"
        subtitle="Overlay realised cumulative PnL for up to 4 strategies"
      />

      <!-- Selected strategies bar — always visible so picks don't get lost
           when scrolling through a long picker. Empty when nothing is picked. -->
      <section class="selected-bar" [class.empty]="picked().length === 0">
        <header class="sb-head">
          <h3>
            Selected
            <span class="muted small">({{ picked().length }}/{{ MAX }})</span>
          </h3>
          @if (picked().length > 0) {
            <button type="button" class="sb-clear" (click)="clearAll()">Clear all</button>
          }
        </header>
        @if (picked().length === 0) {
          <p class="muted small">
            Pick 2–4 strategies below to overlay their cumulative P&amp;L curves.
          </p>
        } @else {
          <div class="sb-chips">
            @for (id of picked(); track id; let i = $index) {
              @if (strategyById().get(id); as s) {
                <button class="sb-chip" (click)="toggle(id)" [style.--accent]="lineColor(i)">
                  <span class="sb-chip-dot" [style.background]="lineColor(i)"></span>
                  <span class="sb-chip-name">{{ s.name }}</span>
                  <span class="muted">({{ s.symbol }})</span>
                  <span class="sb-chip-x">×</span>
                </button>
              }
            }
          </div>
        }
      </section>

      <section class="picker">
        <header class="picker-head">
          <h3>
            Pick strategies
            <span class="muted small"
              >{{ filteredStrategies().length }} shown · {{ allStrategies().length }} total</span
            >
          </h3>
          <div class="picker-controls">
            <input
              type="search"
              class="picker-search"
              placeholder="Search by name or symbol…"
              [ngModel]="searchTerm()"
              (ngModelChange)="searchTerm.set($event)"
            />
            <button
              type="button"
              class="picker-toggle"
              (click)="pickerExpanded.set(!pickerExpanded())"
            >
              {{ pickerExpanded() ? 'Collapse' : 'Expand' }}
            </button>
          </div>
        </header>

        <!-- Symbol filter chips: derived from the loaded strategies. Tapping
             a symbol narrows the chip grid below it. -->
        @if (symbolFilters().length > 0 && pickerExpanded()) {
          <div class="symbol-filters">
            <button
              type="button"
              class="sym-chip"
              [class.active]="symbolFilter() === ''"
              (click)="symbolFilter.set('')"
            >
              All <span class="muted">({{ allStrategies().length }})</span>
            </button>
            @for (sym of symbolFilters(); track sym.symbol) {
              <button
                type="button"
                class="sym-chip"
                [class.active]="symbolFilter() === sym.symbol"
                (click)="symbolFilter.set(sym.symbol)"
              >
                {{ sym.symbol }} <span class="muted">({{ sym.count }})</span>
              </button>
            }
          </div>
        }

        @if (allLoading()) {
          <app-card-skeleton [lines]="3" />
        } @else if (allStrategies().length === 0) {
          <app-empty-state
            title="No strategies to compare"
            description="Create at least two strategies first."
          />
        } @else if (pickerExpanded()) {
          @if (filteredStrategies().length === 0) {
            <p class="muted small empty-search">No strategies match the current filter.</p>
          } @else {
            <div class="chip-scroll">
              <div class="chips">
                @for (s of filteredStrategies(); track s.id) {
                  <button
                    type="button"
                    class="chip"
                    [class.picked]="isPicked(s.id)"
                    [disabled]="!isPicked(s.id) && picked().length >= MAX"
                    (click)="toggle(s.id)"
                  >
                    {{ s.name }}
                    <span class="muted">({{ s.symbol }})</span>
                  </button>
                }
              </div>
            </div>
          }
        }
      </section>

      @if (picked().length >= 2) {
        @if (curvesLoading()) {
          <app-card-skeleton [lines]="6" />
        } @else if (overlayChart(); as opts) {
          <!-- 8-card KPI strip — comparison roll-ups across the 2–4 selected -->
          <div class="cmp-kpis">
            <div class="cmp-kpi">
              <span class="kpi-label">Strategies</span>
              <span class="kpi-value">{{ summaryRows().length }}</span>
            </div>
            <div class="cmp-kpi">
              <span class="kpi-label">Total closed</span>
              <span class="kpi-value">{{ comparisonStats().totalClosed }}</span>
            </div>
            <div class="cmp-kpi">
              <span class="kpi-label">Combined P&amp;L</span>
              <span
                class="kpi-value"
                [class.good]="comparisonStats().totalPnl > 0"
                [class.bad]="comparisonStats().totalPnl < 0"
              >
                {{ comparisonStats().totalPnl >= 0 ? '+' : ''
                }}{{ comparisonStats().totalPnl.toFixed(2) }}
              </span>
            </div>
            <div class="cmp-kpi">
              <span class="kpi-label">Best</span>
              <span class="kpi-value good sm">{{ comparisonStats().bestName }}</span>
            </div>
            <div class="cmp-kpi">
              <span class="kpi-label">Best P&amp;L</span>
              <span class="kpi-value good">+{{ comparisonStats().bestPnl.toFixed(2) }}</span>
            </div>
            <div class="cmp-kpi">
              <span class="kpi-label">Worst</span>
              <span class="kpi-value bad sm">{{ comparisonStats().worstName }}</span>
            </div>
            <div class="cmp-kpi">
              <span class="kpi-label">Worst P&amp;L</span>
              <span class="kpi-value bad">{{ comparisonStats().worstPnl.toFixed(2) }}</span>
            </div>
            <div class="cmp-kpi">
              <span class="kpi-label">Spread (best − worst)</span>
              <span class="kpi-value">{{ comparisonStats().spread.toFixed(2) }}</span>
            </div>
          </div>

          <app-chart-card
            title="Cumulative realised PnL"
            subtitle="Normalised to each strategy's first close — flat segments mean no closed positions in that window"
            [options]="opts"
            height="380px"
          />

          <!-- Detailed comparison table with vs-leader delta -->
          <section class="summary-card">
            <header class="card-head">
              <h3>Per-strategy comparison</h3>
              <span class="muted small">
                Δ shows P&amp;L difference vs the leader (best total P&amp;L)
              </span>
            </header>
            <table class="summary">
              <thead>
                <tr>
                  <th>Strategy</th>
                  <th class="num">Closed</th>
                  <th class="num">Total P&amp;L</th>
                  <th class="num">Avg / trade</th>
                  <th class="num">Δ vs leader</th>
                  <th class="num">First close</th>
                  <th class="num">Last close</th>
                </tr>
              </thead>
              <tbody>
                @for (row of summaryWithDelta(); track row.strategyId) {
                  <tr>
                    <td>
                      <span class="row-dot" [style.background]="lineColor(row._index)"></span>
                      {{ row.name }}
                    </td>
                    <td class="num">{{ row.pointCount }}</td>
                    <td class="num" [attr.data-sign]="row.finalCumulativePnL >= 0 ? 'pos' : 'neg'">
                      {{ row.finalCumulativePnL >= 0 ? '+' : ''
                      }}{{ row.finalCumulativePnL.toFixed(2) }}
                    </td>
                    <td class="num">
                      {{
                        row.pointCount > 0
                          ? (row.finalCumulativePnL / row.pointCount).toFixed(2)
                          : '—'
                      }}
                    </td>
                    <td class="num" [attr.data-sign]="row.deltaToLeader >= 0 ? 'pos' : 'neg'">
                      @if (row.deltaToLeader === 0) {
                        leader
                      } @else {
                        {{ row.deltaToLeader >= 0 ? '+' : '' }}{{ row.deltaToLeader.toFixed(2) }}
                      }
                    </td>
                    <td class="num mono">
                      {{ row.firstAt ? formatDate(row.firstAt) : '—' }}
                    </td>
                    <td class="num mono">
                      {{ row.lastAt ? formatDate(row.lastAt) : '—' }}
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </section>
        } @else {
          <app-empty-state
            title="No closed positions in the selected strategies"
            description="None of the picked strategies have any closed positions yet, so there's nothing to overlay."
          />
        }
      } @else {
        <app-empty-state
          title="Pick at least 2 strategies"
          description="Select 2–4 strategies above to overlay their cumulative PnL curves."
        />
      }
    </div>
  `,
  styles: [
    `
      .page {
        padding: var(--space-2) 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }

      /* Selected strategies bar (always visible) */
      .selected-bar {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-3) var(--space-4);
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
      }
      .selected-bar.empty {
        background: var(--bg-tertiary);
      }
      .sb-head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: var(--space-2);
      }
      .sb-head h3 {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      .sb-clear {
        background: transparent;
        border: none;
        color: var(--text-tertiary);
        font-size: var(--text-xs);
        cursor: pointer;
        text-decoration: underline;
      }
      .sb-clear:hover {
        color: var(--loss);
      }
      .sb-chips {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-2);
      }
      .sb-chip {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 4px 10px;
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-full);
        font-size: var(--text-xs);
        cursor: pointer;
        font-family: inherit;
      }
      .sb-chip:hover {
        border-color: var(--loss);
        color: var(--loss);
      }
      .sb-chip-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
      }
      .sb-chip-name {
        font-weight: var(--font-semibold);
      }
      .sb-chip-x {
        font-size: 13px;
        color: var(--text-tertiary);
      }

      .picker {
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
        padding: var(--space-3) var(--space-4);
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
      }
      .picker-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-3);
        flex-wrap: wrap;
      }
      .picker-head h3 {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .picker-controls {
        display: flex;
        gap: var(--space-2);
        align-items: center;
      }
      .picker-search {
        height: 32px;
        padding: 0 var(--space-3);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-sm);
        font-family: inherit;
        outline: none;
        min-width: 220px;
      }
      .picker-search:focus {
        border-color: var(--accent);
      }
      .picker-toggle {
        height: 32px;
        padding: 0 var(--space-3);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        color: var(--text-secondary);
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
        cursor: pointer;
        font-family: inherit;
      }
      .picker-toggle:hover {
        color: var(--text-primary);
      }

      .symbol-filters {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
      }
      .sym-chip {
        height: 24px;
        padding: 0 10px;
        border: 1px solid var(--border);
        border-radius: var(--radius-full);
        background: var(--bg-primary);
        color: var(--text-secondary);
        font-size: 11px;
        font-weight: var(--font-medium);
        cursor: pointer;
        font-family: inherit;
      }
      .sym-chip:hover {
        color: var(--text-primary);
        border-color: var(--text-tertiary);
      }
      .sym-chip.active {
        background: var(--accent);
        border-color: var(--accent);
        color: white;
      }
      .sym-chip.active .muted {
        color: rgba(255, 255, 255, 0.85);
      }

      /* Cap the chip grid height so a 600-strategy fleet doesn't push the
         comparison results below the fold. Internal scroll keeps everything
         on one screen. */
      .chip-scroll {
        max-height: 320px;
        overflow-y: auto;
      }
      .chips {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      .chip {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 4px 10px;
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-full);
        font-size: var(--text-xs);
        cursor: pointer;
        transition: all 0.15s ease;
        font-family: inherit;
      }
      .chip:hover:not(:disabled) {
        border-color: var(--accent);
        color: var(--accent);
      }
      .chip.picked {
        background: var(--accent);
        border-color: var(--accent);
        color: white;
      }
      .chip.picked .muted {
        color: rgba(255, 255, 255, 0.85);
      }
      .chip:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
      .empty-search {
        padding: var(--space-3) 0;
      }
      .muted {
        color: var(--text-secondary);
      }
      .small {
        font-size: var(--text-sm);
      }

      /* KPI strip */
      .cmp-kpis {
        display: grid;
        grid-template-columns: repeat(8, 1fr);
        gap: var(--space-2);
      }
      @media (max-width: 1400px) {
        .cmp-kpis {
          grid-template-columns: repeat(4, 1fr);
        }
      }
      @media (max-width: 720px) {
        .cmp-kpis {
          grid-template-columns: repeat(2, 1fr);
        }
      }
      .cmp-kpi {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-3) var(--space-4);
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        gap: 4px;
        min-height: 72px;
      }
      .cmp-kpi .kpi-label {
        font-size: 10px;
        font-weight: var(--font-semibold);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .cmp-kpi .kpi-value {
        font-size: var(--text-xl);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .cmp-kpi .kpi-value.good {
        color: var(--profit);
      }
      .cmp-kpi .kpi-value.bad {
        color: var(--loss);
      }
      .cmp-kpi .kpi-value.sm {
        font-size: var(--text-sm);
      }

      /* Comparison summary table chrome */
      .summary-card {
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
      .summary {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-sm);
      }
      .summary th,
      .summary td {
        padding: 8px 12px;
        text-align: left;
        border-bottom: 1px solid var(--border);
      }
      .summary tbody tr:last-child td {
        border-bottom: none;
      }
      .summary th {
        font-size: var(--text-xs);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-tertiary);
        background: var(--bg-tertiary);
      }
      .num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .summary .mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
      }
      td.num[data-sign='pos'] {
        color: var(--profit);
        font-weight: var(--font-semibold);
      }
      td.num[data-sign='neg'] {
        color: var(--loss);
        font-weight: var(--font-semibold);
      }
      .row-dot {
        display: inline-block;
        width: 10px;
        height: 10px;
        border-radius: 50%;
        margin-right: var(--space-2);
        vertical-align: middle;
      }
    `,
  ],
})
export class StrategiesComparePageComponent {
  protected readonly MAX = 4;

  // Distinct line colors for the up-to-4 picked strategies. Reused as
  // chip dots, table dots, and chart line colors so the visual mapping
  // is consistent everywhere.
  private readonly LINE_COLORS = ['#0071E3', '#34C759', '#FF9500', '#AF52DE'];

  private readonly strategiesService = inject(StrategiesService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  readonly allStrategies = signal<StrategyDto[]>([]);
  readonly allLoading = signal(true);

  readonly picked = signal<number[]>([]);

  readonly curves = signal<Map<number, StrategyEquityCurveDto>>(new Map());
  readonly curvesLoading = signal(false);

  // Picker UX state — search term, symbol filter, expanded/collapsed.
  readonly searchTerm = signal('');
  readonly symbolFilter = signal('');
  readonly pickerExpanded = signal(true);

  readonly strategyById = computed(() => new Map(this.allStrategies().map((s) => [s.id, s])));

  readonly symbolFilters = computed(() => {
    const counts = new Map<string, number>();
    for (const s of this.allStrategies()) {
      const sym = s.symbol ?? 'unknown';
      counts.set(sym, (counts.get(sym) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([symbol, count]) => ({ symbol, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 12);
  });

  readonly filteredStrategies = computed(() => {
    const q = this.searchTerm().toLowerCase().trim();
    const sym = this.symbolFilter();
    return this.allStrategies().filter((s) => {
      if (sym && s.symbol !== sym) return false;
      if (q) {
        const hay = `${s.name ?? ''} ${s.symbol ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  });

  readonly summaryRows = computed(() => {
    const map = this.curves();
    const byId = this.strategyById();
    return this.picked().map((id) => {
      const c = map.get(id);
      const s = byId.get(id);
      return {
        strategyId: id,
        name: s?.name ?? `#${id}`,
        pointCount: c?.pointCount ?? 0,
        finalCumulativePnL: c?.finalCumulativePnL ?? 0,
        firstAt: c?.points?.[0]?.closedAt ?? null,
        lastAt: c?.points?.[c.points.length - 1]?.closedAt ?? null,
      };
    });
  });

  // Adds Δ-vs-leader and a sequential _index for color/dot mapping.
  readonly summaryWithDelta = computed(() => {
    const rows = this.summaryRows();
    if (rows.length === 0) return [];
    const leader = Math.max(...rows.map((r) => r.finalCumulativePnL));
    return rows.map((r, i) => ({
      ...r,
      _index: i,
      deltaToLeader: r.finalCumulativePnL - leader,
    }));
  });

  readonly comparisonStats = computed(() => {
    const rows = this.summaryRows();
    if (rows.length === 0) {
      return {
        totalClosed: 0,
        totalPnl: 0,
        bestName: '—',
        bestPnl: 0,
        worstName: '—',
        worstPnl: 0,
        spread: 0,
      };
    }
    const sortedByPnl = [...rows].sort((a, b) => b.finalCumulativePnL - a.finalCumulativePnL);
    const best = sortedByPnl[0];
    const worst = sortedByPnl[sortedByPnl.length - 1];
    return {
      totalClosed: rows.reduce((s, r) => s + r.pointCount, 0),
      totalPnl: rows.reduce((s, r) => s + r.finalCumulativePnL, 0),
      bestName: best.name,
      bestPnl: best.finalCumulativePnL,
      worstName: worst.name,
      worstPnl: worst.finalCumulativePnL,
      spread: best.finalCumulativePnL - worst.finalCumulativePnL,
    };
  });

  readonly overlayChart = computed<EChartsOption | null>(() => {
    const map = this.curves();
    const byId = this.strategyById();
    const series = this.picked()
      .map((id, i) => ({ id, curve: map.get(id), s: byId.get(id), i }))
      .filter((x) => x.curve && x.curve.points.length > 0);

    if (series.length === 0) return null;

    return {
      grid: { left: 64, right: 24, top: 40, bottom: 40 },
      tooltip: { trigger: 'axis' },
      legend: { data: series.map((x) => x.s?.name ?? `#${x.id}`) },
      xAxis: { type: 'time' },
      yAxis: { type: 'value', name: 'Cumulative PnL' },
      series: series.map((x) => ({
        name: x.s?.name ?? `#${x.id}`,
        type: 'line',
        smooth: true,
        showSymbol: false,
        lineStyle: { color: this.lineColor(x.i), width: 2 },
        itemStyle: { color: this.lineColor(x.i) },
        data: x.curve!.points.map((p) => [p.closedAt, +p.cumulativePnL.toFixed(2)]),
      })),
    };
  });

  constructor() {
    this.loadStrategies();

    // Pre-select via ?ids=1,2,3 query string so deep links work.
    const idsParam = this.route.snapshot.queryParamMap.get('ids');
    if (idsParam) {
      const ids = idsParam
        .split(',')
        .map((s) => parseInt(s, 10))
        .filter((n) => Number.isFinite(n))
        .slice(0, this.MAX);
      this.picked.set(ids);
      if (ids.length >= 2) {
        // Auto-collapse the picker when arriving with a deep-link selection.
        this.pickerExpanded.set(false);
        this.loadCurves();
      }
    }
  }

  protected isPicked(id: number): boolean {
    return this.picked().includes(id);
  }

  protected toggle(id: number): void {
    const cur = this.picked();
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id].slice(0, this.MAX);
    this.picked.set(next);
    this.syncQueryParam(next);
    if (next.length >= 2) {
      this.loadCurves();
      // Auto-collapse once we have enough to draw a comparison — picker
      // can be reopened via the toggle button when the operator wants to swap.
      if (next.length === this.MAX) this.pickerExpanded.set(false);
    }
  }

  protected clearAll(): void {
    this.picked.set([]);
    this.curves.set(new Map());
    this.syncQueryParam([]);
    this.pickerExpanded.set(true);
  }

  protected lineColor(index: number): string {
    return this.LINE_COLORS[index % this.LINE_COLORS.length];
  }

  protected formatDate(iso: string): string {
    const d = new Date(iso);
    return Number.isFinite(d.getTime())
      ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })
      : '—';
  }

  private syncQueryParam(ids: number[]): void {
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { ids: ids.length > 0 ? ids.join(',') : null },
      queryParamsHandling: 'merge',
    });
  }

  private loadStrategies(): void {
    this.allLoading.set(true);
    // Probe-and-fetch — discover the true total then pull all rows so the
    // picker doesn't artificially cap at 100. Capped at 1000 for safety.
    this.strategiesService.list({ currentPage: 1, itemCountPerPage: 1, filter: null }).subscribe({
      next: (probe) => {
        const total = probe?.data?.pager?.totalItemCount ?? 0;
        if (total === 0) {
          this.allStrategies.set([]);
          this.allLoading.set(false);
          return;
        }
        this.strategiesService
          .list({ currentPage: 1, itemCountPerPage: Math.min(total, 1000), filter: null })
          .subscribe({
            next: (full) => {
              this.allStrategies.set(full?.data?.data ?? []);
              this.allLoading.set(false);
            },
            error: () => {
              this.allStrategies.set([]);
              this.allLoading.set(false);
            },
          });
      },
      error: () => {
        this.allStrategies.set([]);
        this.allLoading.set(false);
      },
    });
  }

  private loadCurves(): void {
    const ids = this.picked();
    if (ids.length === 0) return;
    this.curvesLoading.set(true);
    forkJoin(
      ids.map((id) => this.strategiesService.getEquityCurve(id).pipe(catchError(() => of(null)))),
    ).subscribe((results) => {
      const next = new Map<number, StrategyEquityCurveDto>();
      results.forEach((res, i) => {
        const data = res?.data;
        if (data) next.set(ids[i], data);
      });
      this.curves.set(next);
      this.curvesLoading.set(false);
    });
  }
}
