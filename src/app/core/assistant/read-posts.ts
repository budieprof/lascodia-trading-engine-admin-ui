/**
 * Engine endpoints that READ by POST.
 *
 * <p>The console's copy of `tools/visual-review/read-posts.js` — the list the review crawlers use to
 * decide which non-GET calls may reach the live engine. The assistant's write guard uses the same
 * list for the same decision, so the two must never drift: `read-posts.spec.ts` loads the crawler's
 * file and fails if the patterns differ. Add a route to BOTH, and only after reading its controller
 * and confirming it sends a MediatR `*Query`, never a `*Command`.</p>
 */
export const READ_POST = new RegExp(
  [
    String.raw`/(list|paged|query|summary)$`,
    String.raw`/admin/calibration/(signal-rejections|snapshots)$`,
    String.raw`/drawdown-recovery/history$`,
    String.raw`/llm-backtest/(estimate-cost|points|compare|\d+/sensitivity-analysis)$`,
    String.raw`/ml-model/drift-report$`,
    String.raw`/scripting/(chart-bars|compile|format|run)$`,
    String.raw`/strategy-feedback/\d+/snapshots$`,
    String.raw`/strategy/(\d+/rejection-distribution|health/recent|runs/latest)$`,
    String.raw`/trade-signal/sensitivity-analysis$`,
    String.raw`/trade-signal/preview$`,
    String.raw`/execution-console/ticket/preview$`,
    String.raw`/md/history$`,
    String.raw`/dealing/(clients|clients/detail|markouts|ab-book-report|ab-book-report/export|alerts|lp-analytics)$`,
  ].join('|'),
  'i',
);

/**
 * True when a request only reads: GET/HEAD/OPTIONS, a POST to a reviewed read route, or SignalR's
 * negotiate handshake. `path` is the URL without its query string.
 */
export function isReadRequest(method: string, path: string): boolean {
  const m = method.toUpperCase();
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return true;
  if (/\/hubs?\/|negotiate/i.test(path)) return true;
  return m === 'POST' && READ_POST.test(path);
}
