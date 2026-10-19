/**
 * How many rows an analytics sample (the KPI tiles, histograms and leaderboards above a run list) may fetch.
 *
 * The pages probe the list with one row and then fetch the newest N. N used to be min(total, 5,000), which is fine
 * for ~1 KB rows — but until 2026-10-19 the engine's walk-forward list carried every run's `windowResultsJson`
 * (~64 KB a row), so 2,973 runs came back as one 117 MB response and the tab sat on zeros while the browser
 * downloaded and parsed it. The engine now sends that column only on the detail GET (list rows: null, ~1 KB), so
 * the usual cap applies again; the probe row's size still bounds the download by a byte budget, so a list row that
 * grows a heavy column again shrinks the sample instead of stalling the page.
 */
export const ANALYTICS_SAMPLE_ROW_CAP = 5000;
export const ANALYTICS_SAMPLE_BYTE_BUDGET = 12 * 1024 * 1024;
/** Never fewer than this, however heavy a row is — a sample of ten says nothing. */
export const ANALYTICS_SAMPLE_ROW_FLOOR = 100;

export function analyticsSampleSize(total: number, probeRow: unknown): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  let bytes = 0;
  try {
    bytes = probeRow == null ? 0 : JSON.stringify(probeRow).length;
  } catch {
    bytes = 0;
  }
  const byBudget =
    bytes > 0 ? Math.floor(ANALYTICS_SAMPLE_BYTE_BUDGET / bytes) : ANALYTICS_SAMPLE_ROW_CAP;
  return Math.min(total, ANALYTICS_SAMPLE_ROW_CAP, Math.max(ANALYTICS_SAMPLE_ROW_FLOOR, byBudget));
}

/** The request for the newest `size` rows — sorted explicitly; the engine's default order is not a contract. */
export function newestRowsRequest(size: number): {
  currentPage: number;
  itemCountPerPage: number;
  filter: null;
  sortBy: string;
  sortDirection: 'desc';
} {
  return {
    currentPage: 1,
    itemCountPerPage: size,
    filter: null,
    sortBy: 'id',
    sortDirection: 'desc',
  };
}
