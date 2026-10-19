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
  ].join('|'),
  'i',
);
/** True when a non-GET engine call may go through: a POST to a read route, or SignalR's negotiate. */
const isReadPost = (method, path) =>
  /\/hubs?\/|negotiate/i.test(path) || (method === 'POST' && READ_POST.test(path));
module.exports = { READ_POST, isReadPost };
