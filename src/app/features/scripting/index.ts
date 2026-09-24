/**
 * Public surface of the scripting feature for other features (e.g. the Pine editor's preview):
 *
 * ```ts
 * import { StrategyReportComponent, normalizeStrategyReport } from '@features/scripting';
 * // <app-strategy-report [report]="runResponse.report" />
 * ```
 *
 * `StrategyReportComponent` accepts the report straight from `POST scripting/run` (or any
 * serialisation of the engine's StrategyReport); pass `backtestRunId` only for a backtest run,
 * which enables the CSV / XLSX export.
 */
export { StrategyReportComponent, REPORT_TABS } from './report/strategy-report.component';
export type { ReportTabId } from './report/strategy-report.component';
export {
  extractStrategyReport,
  normalizeStrategyReport,
  reportCurrency,
} from './report/strategy-report.model';
export type {
  ReportEquityPoint,
  ReportMeta,
  ReportMonthlyReturn,
  ReportSplit,
  ReportTrade,
  StrategyReport,
} from './report/strategy-report.model';
