import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';

import { ThemeService } from '@core/theme/theme.service';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';

import { ScriptStrategyService, type BacktestExportFormat } from '../api/script-strategy.service';
import { describeFailure } from '../shared/api-error';
import { saveBlob } from '../shared/download';
import { normalizeStrategyReport, reportCurrency, type ReportTrade } from './strategy-report.model';
import { buildProfitDistributionOptions, reportPalette } from './report-charts';
import { formatDate, formatInteger, formatUnits } from './report-format';
import {
  CAPITAL_GROUPS,
  PERFORMANCE_GROUPS,
  RISK_RETURNS_GROUPS,
  TRADES_ANALYSIS_GROUPS,
} from './report-sections';
import { ReportOverviewComponent } from './report-overview.component';
import { ReportSplitTableComponent } from './report-split-table.component';
import { ReportMetricListComponent } from './report-metric-list.component';
import { ReportTradesGridComponent } from './report-trades-grid.component';
import { ReportMonthlyHeatmapComponent } from './report-monthly-heatmap.component';
import { ReportPropertiesComponent } from './report-properties.component';

export type ReportTabId =
  | 'overview'
  | 'performance'
  | 'trades-analysis'
  | 'risk'
  | 'capital'
  | 'trades'
  | 'monthly'
  | 'properties';

export const REPORT_TABS: readonly { id: ReportTabId; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'performance', label: 'Performance' },
  { id: 'trades-analysis', label: 'Trades analysis' },
  { id: 'risk', label: 'Risk & returns' },
  { id: 'capital', label: 'Capital efficiency' },
  { id: 'trades', label: 'List of trades' },
  { id: 'monthly', label: 'Monthly returns' },
  { id: 'properties', label: 'Properties' },
];

export type ReportNoticeLevel = 'critical' | 'warning' | 'info';

export interface ReportNotice {
  level: ReportNoticeLevel;
  text: string;
}

let nextReportUid = 0;

/**
 * TradingView-style Strategy report for a script strategy's StrategyReport — reusable wherever a
 * report appears: a backtest run, the live panel, the editor's preview.
 *
 * `report` takes the report in any serialisation the engine produces (JSON text or object,
 * camelCase or PascalCase); it is normalised here. With `backtestRunId` set, the header offers the
 * engine's CSV / XLSX export of that run.
 *
 * ```html
 * <app-strategy-report [report]="run.report" [backtestRunId]="runId" />
 * ```
 */
@Component({
  selector: 'app-strategy-report',
  standalone: true,
  imports: [
    ChartCardComponent,
    ReportOverviewComponent,
    ReportSplitTableComponent,
    ReportMetricListComponent,
    ReportTradesGridComponent,
    ReportMonthlyHeatmapComponent,
    ReportPropertiesComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (data(); as r) {
      <section class="report" [attr.aria-labelledby]="uid + '-title'">
        <header class="head">
          <div class="head-text">
            <h3 class="title" [id]="uid + '-title'">{{ heading() || 'Strategy report' }}</h3>
            <p class="meta">{{ metaLine() }}</p>
          </div>
          <div class="head-actions">
            @if (r.meta.useBarMagnifier) {
              <span class="chip" title="Orders filled along lower-timeframe bars"
                >Bar magnifier</span
              >
            }
            @if (backtestRunId()) {
              <div class="exports" role="group" aria-label="Export report">
                <button
                  type="button"
                  class="btn"
                  [disabled]="exporting() !== null"
                  (click)="exportAs('csv')"
                  [attr.aria-busy]="exporting() === 'csv'"
                >
                  {{ exporting() === 'csv' ? 'Exporting…' : 'Export CSV' }}
                </button>
                <button
                  type="button"
                  class="btn"
                  [disabled]="exporting() !== null"
                  (click)="exportAs('xlsx')"
                  [attr.aria-busy]="exporting() === 'xlsx'"
                >
                  {{ exporting() === 'xlsx' ? 'Exporting…' : 'Export XLSX' }}
                </button>
              </div>
            }
          </div>
        </header>

        @if (exportError()) {
          <p class="export-error" role="alert">{{ exportError() }}</p>
        }

        @if (notices().length > 0) {
          <ul class="notices" aria-label="Report warnings">
            @for (n of notices(); track $index) {
              <li class="notice" [attr.data-level]="n.level">
                <span class="notice-tag">{{ noticeTag(n.level) }}</span>
                <span>{{ n.text }}</span>
              </li>
            }
          </ul>
        }

        <div class="tabs" role="tablist" aria-label="Report sections">
          @for (t of tabs; track t.id; let i = $index) {
            <button
              type="button"
              role="tab"
              class="tab"
              [id]="tabId(t.id)"
              [attr.aria-selected]="activeTab() === t.id"
              [attr.aria-controls]="panelId(t.id)"
              [attr.tabindex]="activeTab() === t.id ? 0 : -1"
              [class.active]="activeTab() === t.id"
              (click)="activeTab.set(t.id)"
              (keydown)="onTabKeydown($event, i)"
            >
              {{ t.label }}
              @if (t.id === 'trades') {
                <span class="tab-count">{{ tradeCount() }}</span>
              }
            </button>
          }
        </div>

        <div
          class="panel"
          role="tabpanel"
          [id]="panelId(activeTab())"
          [attr.aria-labelledby]="tabId(activeTab())"
          tabindex="0"
        >
          @switch (activeTab()) {
            @case ('overview') {
              <app-report-overview [report]="r" [currency]="currency()" [palette]="palette()" />
            }
            @case ('performance') {
              <app-report-split-table
                [groups]="performanceGroups"
                [splits]="r.performance"
                [currency]="currency()"
                caption="Performance for all, long and short trades"
              />
            }
            @case ('trades-analysis') {
              <div class="stack">
                <app-report-split-table
                  [groups]="tradesAnalysisGroups"
                  [splits]="r.performance"
                  [currency]="currency()"
                  caption="Trades analysis for all, long and short trades"
                />
                <app-chart-card
                  title="Profit distribution"
                  subtitle="Closed trades by profit, losing bins in red and winning bins in blue"
                  [options]="distributionOptions() ?? {}"
                  [emptyMessage]="distributionOptions() ? null : 'Fewer than three closed trades'"
                  emptyHint="A distribution needs a sample."
                  height="280px"
                />
              </div>
            }
            @case ('risk') {
              <app-report-metric-list [groups]="riskGroups" [report]="r" [currency]="currency()" />
            }
            @case ('capital') {
              <app-report-metric-list
                [groups]="capitalGroups"
                [report]="r"
                [currency]="currency()"
              />
            }
            @case ('trades') {
              <app-report-trades-grid
                [trades]="r.trades"
                [currency]="currency()"
                [clickable]="tradesClickable()"
                (tradeClick)="tradeClick.emit($event)"
              />
            }
            @case ('monthly') {
              <app-report-monthly-heatmap
                [monthlyReturns]="r.monthlyReturns"
                [palette]="palette()"
                [currency]="currency()"
              />
            }
            @case ('properties') {
              <app-report-properties [report]="r" [currency]="currency()" />
            }
          }
        </div>
      </section>
    } @else if (report() !== null && report() !== undefined) {
      <p class="unreadable" role="status">
        This run carries a result, but not a strategy report the console can read.
      </p>
    }
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .report {
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
      }
      .head {
        display: flex;
        flex-wrap: wrap;
        align-items: flex-start;
        justify-content: space-between;
        gap: var(--space-3);
      }
      .title {
        margin: 0;
        font-size: var(--text-lg);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
      }
      .meta {
        margin: var(--space-1) 0 0;
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .head-actions {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--space-2);
      }
      .chip {
        padding: 2px 10px;
        border-radius: var(--radius-full);
        border: 1px solid var(--border);
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .exports {
        display: flex;
        gap: var(--space-2);
      }
      .btn {
        height: 32px;
        padding: 0 var(--space-4);
        border-radius: var(--radius-full);
        border: 1px solid var(--border);
        background: var(--bg-secondary);
        color: var(--text-primary);
        font: inherit;
        font-size: var(--text-sm);
        cursor: pointer;
      }
      .btn:hover:not(:disabled) {
        background: var(--bg-tertiary);
      }
      .btn:disabled {
        opacity: 0.55;
        cursor: progress;
      }
      .btn:focus-visible,
      .tab:focus-visible,
      .panel:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: 2px;
      }
      .export-error {
        margin: 0;
        padding: var(--space-2) var(--space-3);
        border-radius: var(--radius-sm);
        background: rgba(255, 59, 48, 0.08);
        color: var(--loss);
        font-size: var(--text-sm);
      }
      .notices {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
      }
      .notice {
        display: flex;
        gap: var(--space-3);
        align-items: baseline;
        padding: var(--space-2) var(--space-3);
        border-radius: var(--radius-sm);
        border: 1px solid rgba(255, 149, 0, 0.35);
        background: rgba(255, 149, 0, 0.08);
        font-size: var(--text-sm);
        color: var(--text-primary);
      }
      .notice[data-level='critical'] {
        border-color: rgba(255, 59, 48, 0.45);
        background: rgba(255, 59, 48, 0.08);
      }
      .notice[data-level='info'] {
        border-color: var(--border);
        background: var(--bg-secondary);
      }
      .notice-tag {
        flex-shrink: 0;
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-secondary);
      }
      .tabs {
        display: flex;
        gap: var(--space-1);
        overflow-x: auto;
        scrollbar-width: none;
        border-bottom: 1px solid var(--border);
      }
      .tab {
        flex-shrink: 0;
        padding: var(--space-2) var(--space-3);
        border: none;
        border-bottom: 2px solid transparent;
        background: transparent;
        color: var(--text-secondary);
        font: inherit;
        font-size: 13px;
        font-weight: var(--font-medium);
        cursor: pointer;
        white-space: nowrap;
      }
      .tab:hover:not(.active) {
        color: var(--text-primary);
      }
      .tab.active {
        color: var(--accent);
        border-bottom-color: var(--accent);
      }
      .tab-count {
        margin-left: 4px;
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        font-variant-numeric: tabular-nums;
      }
      .stack {
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
      }
      .unreadable {
        margin: 0;
        padding: var(--space-4);
        border: 1px dashed var(--border);
        border-radius: var(--radius-md);
        color: var(--text-secondary);
        font-size: var(--text-sm);
      }
    `,
  ],
})
export class StrategyReportComponent {
  private readonly api = inject(ScriptStrategyService);
  private readonly theme = inject(ThemeService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  /** The StrategyReport, in any serialisation the engine produces. */
  readonly report = input<unknown>(null);
  /** Set when the report belongs to a backtest run: enables the CSV / XLSX export. */
  readonly backtestRunId = input<number | null>(null);
  readonly heading = input<string | null>('Strategy report');
  /** When true, List-of-trades rows are clickable and emit {@link tradeClick}. */
  readonly tradesClickable = input(false);
  /** A List-of-trades row was clicked. */
  readonly tradeClick = output<ReportTrade>();

  readonly uid = `rpt-${nextReportUid++}`;
  readonly tabs = REPORT_TABS;
  readonly activeTab = signal<ReportTabId>('overview');

  readonly performanceGroups = PERFORMANCE_GROUPS;
  readonly tradesAnalysisGroups = TRADES_ANALYSIS_GROUPS;
  readonly riskGroups = RISK_RETURNS_GROUPS;
  readonly capitalGroups = CAPITAL_GROUPS;

  readonly exporting = signal<BacktestExportFormat | null>(null);
  readonly exportError = signal<string | null>(null);

  readonly data = computed(() => normalizeStrategyReport(this.report()));
  readonly currency = computed(() => {
    const r = this.data();
    return r ? reportCurrency(r) : '';
  });
  readonly palette = computed(() => reportPalette(this.theme.theme()));

  readonly tradeCount = computed(() => formatInteger(this.data()?.trades.length ?? 0));

  readonly metaLine = computed(() => {
    const r = this.data();
    if (!r) return '';
    const m = r.meta;
    const parts: string[] = [];
    if (m.symbol) parts.push(m.symbol);
    if (m.timeframe) parts.push(m.timeframe);
    if (m.firstBarTime !== null) {
      parts.push(
        `${formatDate(m.firstBarTime)} → ${formatDate(m.lastBarTimeClose ?? m.lastBarTime)} UTC`,
      );
    }
    if (m.bars !== null) parts.push(`${formatInteger(m.bars)} bars`);
    const cur = this.currency();
    if (cur) parts.push(`amounts in ${cur}`);
    return parts.join(' · ');
  });

  /** Everything that qualifies the numbers: risk halts, margin calls, trimmed trades, engine warnings. */
  readonly notices = computed<ReportNotice[]>(() => {
    const r = this.data();
    if (!r) return [];
    const out: ReportNotice[] = [];
    if (r.meta.riskHalted) {
      out.push({
        level: 'critical',
        text: `A strategy.risk rule halted trading${r.meta.riskHaltReason ? `: ${r.meta.riskHaltReason}` : '.'} Pending orders were cancelled and the position closed.`,
      });
    }
    const calls = r.capital.marginCalls ?? 0;
    if (calls > 0) {
      out.push({
        level: 'warning',
        text: `${formatInteger(calls)} margin call${calls === 1 ? '' : 's'}: the emulated broker liquidated ${formatUnits(r.capital.liquidatedQty)} for lack of margin.`,
      });
    }
    const trimmed = r.meta.trimmedTrades ?? 0;
    if (trimmed > 0) {
      out.push({
        level: 'info',
        text: `The ${formatInteger(trimmed)} oldest closed trades are not listed (trade-list limit); every statistic still includes them.`,
      });
    }
    for (const w of r.warnings) out.push({ level: 'warning', text: w });
    return out;
  });

  readonly distributionOptions = computed(() => {
    const r = this.data();
    return r ? buildProfitDistributionOptions(r, this.palette(), this.currency()) : null;
  });

  tabId(id: ReportTabId): string {
    return `${this.uid}-tab-${id}`;
  }

  panelId(id: ReportTabId): string {
    return `${this.uid}-panel-${id}`;
  }

  noticeTag(level: ReportNoticeLevel): string {
    return level === 'critical' ? 'Halted' : level === 'warning' ? 'Warning' : 'Note';
  }

  /** Arrow keys / Home / End move between tabs (WAI-ARIA tabs pattern, automatic activation). */
  onTabKeydown(event: KeyboardEvent, index: number): void {
    const n = this.tabs.length;
    let next: number;
    switch (event.key) {
      case 'ArrowRight':
        next = (index + 1) % n;
        break;
      case 'ArrowLeft':
        next = (index - 1 + n) % n;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = n - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const target = this.tabs[next].id;
    this.activeTab.set(target);
    queueMicrotask(() =>
      this.host.nativeElement.querySelector<HTMLElement>(`#${this.tabId(target)}`)?.focus(),
    );
  }

  exportAs(format: BacktestExportFormat): void {
    const runId = this.backtestRunId();
    if (!runId || this.exporting() !== null) return;
    this.exporting.set(format);
    this.exportError.set(null);
    this.api.downloadBacktestExport(runId, format).subscribe({
      next: (file) => {
        saveBlob(file.blob, file.fileName);
        this.exporting.set(null);
      },
      error: (err: unknown) => {
        this.exportError.set(describeFailure(err, 'The export failed.'));
        this.exporting.set(null);
      },
    });
  }
}
