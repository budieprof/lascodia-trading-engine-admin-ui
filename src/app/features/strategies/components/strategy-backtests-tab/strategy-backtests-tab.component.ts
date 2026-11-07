import { ChangeDetectionStrategy, Component, ViewChild, inject, input } from '@angular/core';
import { formatDate } from '@angular/common';
import { Router } from '@angular/router';
import type { ColDef } from 'ag-grid-community';
import { map } from 'rxjs';

import type { BacktestRunDto, PagerRequest, StrategyDto } from '@core/api/api.types';
import { BacktestsService } from '@core/services/backtests.service';
import { DataTableComponent } from '@shared/components/data-table/data-table.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';
import { ScriptBacktestLauncherComponent } from '@features/scripting/backtest/script-backtest-launcher.component';
import { RunComparisonComponent } from '@features/scripting/backtest/run-comparison.component';
import { configHashColumn } from '../../util/config-hash-column';
import { StatusPillCellComponent } from '@shared/components/data-table/cell-renderers/status-pill-cell.component';

/** A backtest row that closed at least one trade; without one its ratios are not measured. */
function runHasTrades(row: { totalTrades?: number | null } | null | undefined): boolean {
  return row?.totalTrades == null || row.totalTrades > 0;
}

/**
 * Strategy detail → Backtests tab (U13: split out of the strategy detail page, behaviour unchanged): the script
 * launcher (script strategies), the strategy's runs (click → the run's page) and the two-run comparison.
 */
@Component({
  selector: 'app-strategy-backtests-tab',
  standalone: true,
  imports: [DataTableComponent, ScriptBacktestLauncherComponent, RunComparisonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (isScript()) {
      <!-- Script strategies: symbol / timeframe / input overrides, deep mode and
         the bar magnifier (ADR-0027 §4). -->
      <app-script-backtest-launcher [strategy]="strategy()" (queued)="backtestTable?.loadData()" />
    }
    <!-- Tighter cells: at the grid's default padding the "(override)" marker and the
       Started column were clipped and single-word headers broke mid-word. -->
    <div class="bt-runs">
      <app-data-table
        #backtestTable
        [columnDefs]="backtestColumns"
        [fetchData]="fetchBacktests"
        (rowClick)="onBacktestRowClick($event)"
      />
    </div>
    <!-- PE-I7: two runs side by side — metrics, equity and how each was made. -->
    <app-run-comparison [strategyId]="strategy().id" />
  `,
  styles: [
    `
      :host {
        display: contents;
      }
      .bt-runs ::ng-deep .ag-theme-alpine {
        --ag-cell-horizontal-padding: 12px;
      }
    `,
  ],
})
export class StrategyBacktestsTabComponent {
  private readonly backtestsService = inject(BacktestsService);
  private readonly router = inject(Router);
  private readonly relativeTime = new RelativeTimePipe();

  readonly strategy = input.required<StrategyDto>();
  readonly isScript = input(false);

  @ViewChild('backtestTable') backtestTable?: DataTableComponent<BacktestRunDto>;

  readonly fetchBacktests = (params: PagerRequest) =>
    this.backtestsService
      .list({ ...params, filter: { ...(params.filter ?? {}), strategyId: this.strategy().id } })
      .pipe(map((res) => res.data!));

  // Minimums sized to each header and widest value at 12px cell padding (.bt-runs): they sum to
  // ~1,100px, inside the tab's card, so sizeColumnsToFit never squeezes one past its content.
  readonly backtestColumns: ColDef[] = [
    { field: 'id', headerName: 'ID', width: 70, minWidth: 60 },
    {
      field: 'symbol',
      headerName: 'Market',
      width: 176,
      minWidth: 172,
      // A run with a symbol/timeframe override tested the rules on another market — never
      // promotion evidence; the promotion gate ignores it (its verdict says "No completed backtest
      // on the strategy's own market" and counts the override runs). Say so on the row too.
      valueFormatter: (p: any) => {
        const d = p.data as
          | {
              symbol?: string;
              timeframe?: string;
              symbolOverride?: string | null;
              timeframeOverride?: string | null;
            }
          | undefined;
        if (!d) return p.value ?? '—';
        // The timeframe code ("H1"), as on the Backtests page: "1 Hour (override)" did not fit.
        const market = `${d.symbol ?? '—'} · ${d.timeframe ?? '—'}`;
        return d.symbolOverride || d.timeframeOverride ? `${market} (override)` : market;
      },
      tooltipValueGetter: (p: any) =>
        p.data?.symbolOverride || p.data?.timeframeOverride
          ? "Override run: the strategy's rules on another market or timeframe — not promotion evidence"
          : null,
    },
    // UTC dates: toLocaleDateString printed a window ending 2026-09-30T23:00Z as "10/1/2026".
    // One "from – to" column (sorts by its start) leaves room for the rest.
    {
      field: 'fromDate',
      headerName: 'Window (UTC)',
      width: 200,
      minWidth: 196,
      valueFormatter: (p: any) =>
        p.data ? `${this.utcDay(p.data.fromDate)} – ${this.utcDay(p.data.toDate)}` : '—',
    },
    {
      field: 'status',
      headerName: 'Status',
      width: 112,
      minWidth: 106,
      cellRenderer: StatusPillCellComponent,
      cellRendererParams: { label: 'Backtest status' },
    },
    {
      field: 'totalTrades',
      headerName: 'Trades',
      width: 80,
      minWidth: 76,
      valueFormatter: (p: any) => (p.value != null ? p.value : '—'),
    },
    // A run that closed no trade has no win rate, PF or Sharpe (the engine stores 0.0): "—".
    {
      field: 'winRate',
      headerName: 'Win %',
      width: 76,
      minWidth: 70,
      valueFormatter: (p: any) =>
        p.value != null && runHasTrades(p.data) ? `${(p.value * 100).toFixed(1)}%` : '—',
    },
    {
      field: 'profitFactor',
      headerName: 'PF',
      width: 64,
      minWidth: 60,
      // 9999 is the engine's "no losing trade" sentinel, not a measured ratio.
      valueFormatter: (p: any) =>
        p.value == null || !runHasTrades(p.data) ? '—' : p.value >= 9999 ? '∞' : p.value.toFixed(2),
    },
    {
      field: 'maxDrawdownPct',
      headerName: 'Max DD',
      width: 84,
      minWidth: 80,
      valueFormatter: (p: any) => (p.value != null ? `${p.value.toFixed(2)}%` : '—'),
    },
    {
      field: 'sharpeRatio',
      headerName: 'Sharpe',
      width: 80,
      minWidth: 76,
      valueFormatter: (p: any) =>
        p.value != null && runHasTrades(p.data) ? p.value.toFixed(2) : '—',
    },
    {
      field: 'totalReturn',
      headerName: 'Return',
      width: 92,
      minWidth: 88,
      // BacktestEngine stores TotalReturn already in percent (0.1089 = 0.1089%);
      // multiplying by 100 again printed 10.89% for a $10.89 gain on $10,000.
      valueFormatter: (p: any) => (p.value != null ? `${Number(p.value).toFixed(2)}%` : '—'),
    },
    {
      // The engine's backtest row has no `startedAt` (a stale typed field), so this column was
      // blank: it sends `executionStartedAt`, and `claimedAt` for a run not yet executing.
      colId: 'executionStartedAt',
      headerName: 'Started (UTC)',
      flex: 1,
      minWidth: 112,
      valueGetter: (p: any) =>
        p.data?.executionStartedAt ?? p.data?.claimedAt ?? p.data?.startedAt ?? null,
      // "about 19 hours ago" did not fit the column; the date does, the rest is in the tooltip.
      valueFormatter: (p: any) => (p.value ? this.utcDay(p.value) : '—'),
      tooltipValueGetter: (p: any) =>
        p.value
          ? `${formatDate(p.value, 'MMM d, yyyy HH:mm', 'en-US', 'UTC')} UTC · ${this.relativeTime.transform(p.value)}`
          : null,
    },
    configHashColumn(
      () => (this.strategy() as { strategyConfigHash?: string | null }).strategyConfigHash ?? null,
    ),
  ];

  /** "Sep 30, 2026" in UTC — a backtest window is a UTC range. */
  private utcDay(iso: string | null | undefined): string {
    if (!iso) return '—';
    return formatDate(iso, 'MMM d, yyyy', 'en-US', 'UTC');
  }

  onBacktestRowClick(run: BacktestRunDto): void {
    this.router.navigate(['/backtests', run.id]);
  }
}
