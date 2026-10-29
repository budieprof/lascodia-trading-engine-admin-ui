/** Display helpers for the summary figures of the strategies group's pages. Every one returns "—" for a missing value. */

export function money(
  v: number | null | undefined,
  currency: string | null = 'USD',
  signed = false,
): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const abs = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.abs(v));
  const sign = v < 0 ? '−' : signed && v > 0 ? '+' : '';
  const unit = currency && currency !== 'USD' ? ` ${currency}` : '';
  return currency === 'USD' || currency === null ? `${sign}$${abs}` : `${sign}${abs}${unit}`;
}

/** A FRACTION (0.012) shown as a percent ("+1.20%"). */
export function fractionPct(v: number | null | undefined, digits = 2, signed = true): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const p = v * 100;
  return `${signed && p > 0 ? '+' : p < 0 ? '−' : ''}${Math.abs(p).toFixed(digits)}%`;
}

export function count(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return new Intl.NumberFormat('en-US').format(v);
}

/** "3 days ago", "in 2 hours", "just now" from an ISO date; "—" when absent. */
export function ago(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '—';
  const s = Math.round((now - t) / 1000);
  const abs = Math.abs(s);
  const unit =
    abs < 60
      ? null
      : abs < 3600
        ? [Math.round(abs / 60), 'minute']
        : abs < 86400
          ? [Math.round(abs / 3600), 'hour']
          : [Math.round(abs / 86400), 'day'];
  if (!unit) return 'just now';
  const [n, u] = unit as [number, string];
  const text = `${n} ${u}${n === 1 ? '' : 's'}`;
  return s >= 0 ? `${text} ago` : `in ${text}`;
}

/** "28 Oct 2026" from an ISO date. */
export function day(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '—';
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}
