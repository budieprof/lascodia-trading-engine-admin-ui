// Engine endpoints that READ by POST — the only non-GET calls the review scripts let through to the
// live engine. Everything else non-GET is aborted (see README "Safety").
//
// Generic: the paged/list convention (`/list`, `/paged`, `/query`, `/summary`).
// Specific: verified 2026-10-19 by reading each controller — every route below sends a MediatR
// `*Query`, never a `*Command`. Add a route here only after checking the same way; a POST that
// sends a Command (e.g. experiment/cme-contracts/back-adjust, strategy/preview-snapshots) must
// stay blocked.
const READ_POST = new RegExp(
  [
    String.raw`/(list|paged|query|summary)$`,
    String.raw`/admin/calibration/(signal-rejections|snapshots)$`, // GetPagedSignalRejections / CalibrationSnapshots
    String.raw`/drawdown-recovery/history$`, // GetPagedDrawdownSnapshotsQuery
    String.raw`/llm-backtest/(estimate-cost|points|\d+/sensitivity-analysis)$`, // Estimate… / GetLlmBacktestPoints / Analyze…
    String.raw`/ml-model/drift-report$`, // GetDriftReportQuery
    String.raw`/scripting/(chart-bars|compile|format|run)$`, // GetChartBars / CompileScript / FormatScript / RunScriptQuery
    String.raw`/strategy-feedback/\d+/snapshots$`, // GetPagedStrategySnapshotsQuery
    String.raw`/strategy/(\d+/rejection-distribution|health/recent|runs/latest)$`, // Get… queries
    String.raw`/trade-signal/sensitivity-analysis$`, // AnalyzeSignalSensitivityQuery
    // Verified 2026-10-28 the same way (handlers write nothing):
    String.raw`/trade-signal/preview$`, // PreviewManualTradeQuery — the manual ticket's dry run
    String.raw`/execution-console/ticket/preview$`, // VenueTicketPreviewQuery — the venue ticket's dry run
    String.raw`/md/history$`, // GetMarketDataHistoryQuery — ladder/heatmap history
    // Dealing desk reads (DealingController; each sends a Get…Query whose handler takes only
    // IReadApplicationDbContext / the tick store — verified 2026-10-28). `dealing/feeds` (POST/PUT)
    // and `dealing/trades/ingest` are commands and stay blocked.
    String.raw`/dealing/(clients|clients/detail|markouts|ab-book-report|ab-book-report/export|alerts|lp-analytics)$`,
  ].join('|'),
  'i',
);
/** True when a non-GET engine call may go through: a POST to a read route, or SignalR's negotiate. */
const isReadPost = (method, path) =>
  /\/hubs?\/|negotiate/i.test(path) || (method === 'POST' && READ_POST.test(path));
module.exports = { READ_POST, isReadPost };
