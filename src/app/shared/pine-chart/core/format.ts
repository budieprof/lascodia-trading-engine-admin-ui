/**
 * Number formatting for the status line, the data window and the price-scale labels, following the
 * Pine `format.*` / `precision` rules: an output's own format and precision win, else the
 * declaration's, else the chart's price precision. `na` renders as ∅, as the data window does.
 */

export const NA_TEXT = '∅';

export type PineFormatName = 'inherit' | 'price' | 'volume' | 'percent' | 'mintick';

export interface ValueFormat {
  format: PineFormatName;
  precision: number;
}

/**
 * Resolves the effective format of an output.
 * @param own the output's `format`/`precision` (null = not given)
 * @param declaration the script declaration's `format`/`precision`
 * @param pricePrecision decimals of the chart symbol's price (mintick)
 */
export function resolveFormat(
  own: { format?: string | null; precision?: number | null },
  declaration: { format?: string | null; precision?: number | null } | null | undefined,
  pricePrecision: number,
): ValueFormat {
  const norm = (f: string | null | undefined): PineFormatName | null => {
    if (!f) return null;
    const v = f.toLowerCase();
    return v === 'price' || v === 'volume' || v === 'percent' || v === 'mintick' ? v : null;
  };
  const format = norm(own.format) ?? norm(declaration?.format) ?? 'price';
  const explicit = own.precision ?? declaration?.precision ?? null;
  let precision: number;
  if (explicit !== null && explicit !== undefined && Number.isFinite(explicit)) {
    precision = clampPrecision(explicit);
  } else if (format === 'percent') {
    precision = 2;
  } else if (format === 'volume') {
    precision = 2;
  } else {
    precision = pricePrecision;
  }
  return { format, precision };
}

function clampPrecision(p: number): number {
  return Math.max(0, Math.min(16, Math.round(p)));
}

/** Formats a value; null/NaN/±Infinity print as ∅. */
export function formatValue(value: number | null | undefined, fmt: ValueFormat): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NA_TEXT;
  switch (fmt.format) {
    case 'percent':
      return `${fixed(value, fmt.precision)}%`;
    case 'volume':
      return formatVolume(value, fmt.precision);
    default:
      return fixed(value, fmt.precision);
  }
}

function fixed(value: number, precision: number): string {
  // toFixed prints "-0.00" for tiny negatives; the status line should not flicker a sign.
  const s = value.toFixed(precision);
  return /^-0(\.0*)?$/.test(s) ? s.slice(1) : s;
}

/** Abbreviated volume: 812, 1.23K, 45.67M, 1.2B. */
export function formatVolume(value: number, precision = 2): string {
  const abs = Math.abs(value);
  const units: Array<[number, string]> = [
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ];
  for (const [size, suffix] of units) {
    if (abs >= size) return `${trimZeros((value / size).toFixed(Math.min(precision, 3)))}${suffix}`;
  }
  return trimZeros(value.toFixed(abs >= 100 ? 0 : Math.min(precision, 3)));
}

function trimZeros(s: string): string {
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

/** Decimals needed to show the bar prices exactly (e.g. 5 for EURUSD, 2 for XAUUSD), capped at 8. */
export function inferPricePrecision(prices: ArrayLike<number>, sample = 400): number {
  let best = 0;
  const n = prices.length;
  const start = Math.max(0, n - sample);
  for (let i = start; i < n; i++) {
    const v = prices[i];
    if (!Number.isFinite(v)) continue;
    const d = decimals(v);
    if (d > best) best = d;
    if (best >= 8) return 8;
  }
  return best;
}

function decimals(v: number): number {
  // Round to 10 places first so binary noise (1.1 + 2.2 = 3.3000000000000003) does not count.
  const s = (Math.round(v * 1e10) / 1e10).toString();
  if (s.includes('e-')) return Math.min(8, +s.split('e-')[1]);
  const dot = s.indexOf('.');
  return dot < 0 ? 0 : Math.min(8, s.length - dot - 1);
}

/** `yyyy-MM-dd HH:mm` (seconds when non-zero) of a Unix-ms time in an IANA zone (default UTC). */
export function formatBarTime(ms: number, timeZone = 'UTC', withSeconds = false): string {
  if (!Number.isFinite(ms)) return '';
  const parts = zonedParts(ms, timeZone);
  const base = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
  return withSeconds || parts.second !== '00' ? `${base}:${parts.second}` : base;
}

/** ISO-8601 with the zone offset, as Pine Logs prefix messages: `2026-09-24T13:00:00.000+00:00`. */
export function formatIsoInZone(ms: number, timeZone = 'UTC'): string {
  if (!Number.isFinite(ms)) return '';
  const p = zonedParts(ms, timeZone);
  const offsetMin = zoneOffsetMinutes(ms, timeZone);
  const sign = offsetMin < 0 ? '-' : '+';
  const abs = Math.abs(offsetMin);
  const oh = String(Math.floor(abs / 60)).padStart(2, '0');
  const om = String(abs % 60).padStart(2, '0');
  const msPart = String(((ms % 1000) + 1000) % 1000).padStart(3, '0');
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}.${msPart}${sign}${oh}:${om}`;
}

interface ZonedParts {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-GB', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      });
    } catch {
      f = formatterFor('UTC');
    }
    formatters.set(timeZone, f);
  }
  return f;
}

function zonedParts(ms: number, timeZone: string): ZonedParts {
  if (timeZone === 'UTC') {
    const d = new Date(ms);
    const two = (n: number) => String(n).padStart(2, '0');
    return {
      year: String(d.getUTCFullYear()),
      month: two(d.getUTCMonth() + 1),
      day: two(d.getUTCDate()),
      hour: two(d.getUTCHours()),
      minute: two(d.getUTCMinutes()),
      second: two(d.getUTCSeconds()),
    };
  }
  const out: Record<string, string> = {};
  for (const part of formatterFor(timeZone).formatToParts(new Date(ms)))
    out[part.type] = part.value;
  return {
    year: out['year'] ?? '',
    month: out['month'] ?? '',
    day: out['day'] ?? '',
    hour: out['hour'] === '24' ? '00' : (out['hour'] ?? ''),
    minute: out['minute'] ?? '',
    second: out['second'] ?? '',
  };
}

const offsetCache = new Map<string, number>();

/**
 * Offset of an IANA zone from UTC at an instant, in minutes (DST-aware). Memoised per zone and
 * 15-minute bucket — zone transitions fall on quarter hours — because shifting 20,000 bar times
 * through Intl one by one is a visible pause.
 */
export function zoneOffsetMinutes(ms: number, timeZone: string): number {
  if (timeZone === 'UTC' || !Number.isFinite(ms)) return 0;
  const key = `${timeZone}|${Math.floor(ms / 900_000)}`;
  const hit = offsetCache.get(key);
  if (hit !== undefined) return hit;
  const p = zonedParts(ms, timeZone);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  const offset = Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60_000);
  if (offsetCache.size > 100_000) offsetCache.clear();
  offsetCache.set(key, offset);
  return offset;
}
