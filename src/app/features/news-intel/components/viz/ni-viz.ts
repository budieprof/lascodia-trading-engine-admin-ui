import { exposureKindOf, EXPOSURE_KIND_LABEL } from '@features/news-intel/news-intel.logic';
import { ExposureKindName } from '@features/news-intel/news-intel.types';

/**
 * Shared helpers for the News Intel cockpit's charts. Colours are CSS variables declared on the page host
 * (`news-intel-shared.scss`), so every chart follows the light/dark theme without code. The kind order is
 * FIXED and validated (dataviz skill, light + dark) — it is never cycled and never re-ordered by a filter.
 */

/** Exposure kinds in their fixed display + colour order. */
export const KIND_ORDER: readonly ExposureKindName[] = [
  'Currency',
  'Commodity',
  'EquityIndex',
  'Equity',
  'Crypto',
  'Factor',
];

const KIND_VAR: Record<ExposureKindName, string> = {
  Currency: 'var(--ni-k-currency, #2a78d6)',
  Commodity: 'var(--ni-k-commodity, #eb6834)',
  EquityIndex: 'var(--ni-k-index, #1baf7a)',
  Equity: 'var(--ni-k-stock, #eda100)',
  Crypto: 'var(--ni-k-crypto, #e87ba4)',
  Factor: 'var(--ni-k-factor, #4a3aa7)',
};

/** CSS colour for an exposure key's kind (muted ink when the key is malformed). */
export function kindVar(key: string | null | undefined): string {
  const k = exposureKindOf(key);
  return k ? KIND_VAR[k] : 'var(--text-tertiary)';
}

export function kindColor(kind: ExposureKindName): string {
  return KIND_VAR[kind];
}

export function kindLabel(kind: ExposureKindName): string {
  return EXPOSURE_KIND_LABEL[kind];
}

/** Display form of a key: the prefix is implied by the kind colour + group, so `EQ:AAPL` → `AAPL`. */
export function shortKey(key: string): string {
  const i = key.indexOf(':');
  return i > 0 ? key.slice(i + 1) : key;
}

/** Selection-ordered series colours for multi-line charts (≤ 6; colour follows the entity while selected). */
export const SERIES_VARS: readonly string[] = [
  'var(--ni-s1, #2a78d6)',
  'var(--ni-s2, #eb6834)',
  'var(--ni-s3, #1baf7a)',
  'var(--ni-s4, #eda100)',
  'var(--ni-s5, #e87ba4)',
  'var(--ni-s6, #4a3aa7)',
];

/**
 * Diverging fill for a signed value: neutral midpoint, desk up/down poles. `full` is the magnitude that reaches
 * the pole (|v| ≥ full ⇒ full colour). A square-root ease keeps small-but-real readings visible.
 */
export function divergingFill(v: number | null | undefined, full = 0.6): string {
  if (v == null || !Number.isFinite(v) || v === 0) return 'var(--ni-mid)';
  const t = Math.min(1, Math.sqrt(Math.abs(v) / full));
  const pct = Math.round(t * 100);
  const pole = v > 0 ? 'var(--ni-up)' : 'var(--ni-down)';
  return `color-mix(in oklab, ${pole} ${pct}%, var(--ni-mid))`;
}

/** Ink that stays readable on a `divergingFill` background. */
export function divergingInk(v: number | null | undefined, full = 0.6): string {
  if (v == null || !Number.isFinite(v)) return 'var(--text-primary)';
  return Math.sqrt(Math.abs(v) / full) > 0.62 ? '#fff' : 'var(--text-primary)';
}

export function signed(v: number | null | undefined, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const s = v.toFixed(digits);
  return v > 0 ? `+${s}` : v < 0 ? `−${s.slice(1)}` : s;
}

export function compact(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e4) return `${Math.round(n / 1e3)}k`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

/** "4m", "3h", "2d" — age from an ISO instant to now. */
export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  return minutesText((now - t) / 60_000);
}

export function minutesText(min: number | null | undefined): string {
  if (min == null || !Number.isFinite(min)) return '—';
  const m = Math.max(0, min);
  if (m < 1) return 'now';
  if (m < 60) return `${Math.round(m)}m`;
  if (m < 48 * 60) return `${Math.round(m / 60)}h`;
  return `${Math.round(m / 1440)}d`;
}

/** SVG path for a polyline over [0..w]×[0..h] from values mapped into [lo, hi]. Gaps (null) break the path. */
export function linePath(
  values: readonly (number | null)[],
  w: number,
  h: number,
  lo: number,
  hi: number,
): string {
  const n = values.length;
  if (n === 0) return '';
  const span = hi - lo || 1;
  let d = '';
  let pen = false;
  values.forEach((v, i) => {
    if (v == null || !Number.isFinite(v)) {
      pen = false;
      return;
    }
    const x = n === 1 ? w / 2 : (i / (n - 1)) * w;
    const y = h - ((Math.min(hi, Math.max(lo, v)) - lo) / span) * h;
    d += `${pen ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
    pen = true;
  });
  return d;
}

/** Downsample to at most `max` points by striding (keeps first + last). */
export function thin<T>(xs: readonly T[], max: number): T[] {
  if (xs.length <= max) return [...xs];
  const out: T[] = [];
  const step = (xs.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(xs[Math.round(i * step)]);
  return out;
}
