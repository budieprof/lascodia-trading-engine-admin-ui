/**
 * Pure formatting helpers for the Economic Events page (no Angular, so they are unit-testable).
 */

/**
 * Parse release strings like "275K", "1.9%", "<0.75%", "-42" as numbers so the page can compute
 * an actual-vs-forecast surprise. Returns null when the string does not parse — better to render
 * "—" than a misleading delta.
 */
export function parseEconValue(v: string | null | undefined): number | null {
  if (v == null) return null;
  const s = v.trim();
  if (s === '') return null;
  // Drop comparison operators / leading symbols (<, >, ~, ≈, ±).
  const stripped = s.replace(/^[<>~≈±]+\s*/, '').replace(/[,\s]/g, '');
  // Match number with optional sign + optional unit suffix (K/M/B/T).
  const m = stripped.match(/^(-?\d+(?:\.\d+)?)\s*([KkMmBbTt%]?)/);
  if (!m) return null;
  let n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = m[2].toUpperCase();
  if (unit === 'K') n *= 1_000;
  else if (unit === 'M') n *= 1_000_000;
  else if (unit === 'B') n *= 1_000_000_000;
  else if (unit === 'T') n *= 1_000_000_000_000;
  return n;
}

/** Actual minus forecast, or null when either side is missing or unparseable. */
export function parseSurprise(
  actual: string | null | undefined,
  forecast: string | null | undefined,
): number | null {
  const a = parseEconValue(actual);
  const f = parseEconValue(forecast);
  if (a === null || f === null) return null;
  return a - f;
}

const compactFmt = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
});
const plainFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

/**
 * A surprise as the operator reads it: signed, and in the same scale as the release. A payrolls
 * beat of 15,000 used to render "+15000.00"; it now reads "+15K". Small values keep two decimals
 * at most ("+0.2", "−0.05"). Zero reads "0".
 */
export function formatSurprise(delta: number): string {
  if (!Number.isFinite(delta)) return '—';
  const abs = Math.abs(delta);
  // Round to the shown precision first so a float residue (1.0000000002) never reads "+1".
  const body = abs >= 1000 ? compactFmt.format(abs) : plainFmt.format(abs);
  if (body === '0') return '0';
  return (delta > 0 ? '+' : '−') + body;
}
