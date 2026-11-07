import type {
  ChartAlertFrequency,
  ChartAlertKind,
  ChartAlertMetricInput,
  MetricAlertKind,
  MetricComparator,
  MetricUnit,
} from './chart-alerts.types';

/**
 * UF04 — derivatives alerts (C7): Funding / OI change / Basis / Liquidations, offered ONLY where the symbol has that
 * data. Pure: what each kind means, which kinds a symbol's data supports, the form's checks (the engine's validator's,
 * refused here first) and how a value is written.
 */

export interface MetricKindInfo {
  kind: MetricAlertKind;
  label: string;
  unit: MetricUnit;
  /** The value's unit as the form shows it. */
  unitText: string;
  /** OI change / liquidations measure over a look-back window (required); funding / basis read the latest value. */
  needsWindow: boolean;
  hint: string;
}

export const METRIC_KINDS: readonly MetricKindInfo[] = [
  {
    kind: 'Funding',
    label: 'Funding rate',
    unit: 'percentPerInterval',
    unitText: '% per funding interval',
    needsWindow: false,
    hint: "The perpetual's latest funding rate, in percent per funding interval (0.01 = 0.01 %)",
  },
  {
    kind: 'OpenInterestChange',
    label: 'Open interest change',
    unit: 'percent',
    unitText: '% over the window',
    needsWindow: true,
    hint: 'Open interest now against the window ago, in percent',
  },
  {
    kind: 'Basis',
    label: 'Basis',
    unit: 'percent',
    unitText: '%',
    needsWindow: false,
    hint: "A perpetual's (mark − index) / index, or a CME FX future's basis over the spot price, in percent",
  },
  {
    kind: 'Liquidations',
    label: 'Liquidations',
    unit: 'quoteNotional',
    unitText: 'quote notional over the window',
    needsWindow: true,
    hint: 'Liquidated notional of both sides (quote currency) in the closed minutes of the window',
  },
];

export const COMPARATORS: readonly { id: MetricComparator; label: string }[] = [
  { id: 'crossesAbove', label: 'Crosses above' },
  { id: 'crossesBelow', label: 'Crosses below' },
  { id: 'above', label: 'Is above' },
  { id: 'below', label: 'Is below' },
];

/** The engine's caps (`ChartAlertMetricKinds`). */
export const MAX_METRIC_WINDOW_MINUTES = 1440;
export const MAX_METRIC_ABS_VALUE = 9_999_999_999;
export const DEFAULT_METRIC_WINDOW_MINUTES = 60;

export function isMetricKind(kind: ChartAlertKind | null | undefined): kind is MetricAlertKind {
  return kind === 'Funding' || kind === 'OpenInterestChange' || kind === 'Basis' || kind === 'Liquidations';
}

export function metricInfo(kind: MetricAlertKind): MetricKindInfo {
  return METRIC_KINDS.find((k) => k.kind === kind)!;
}

// ── Availability ──────────────────────────────────────────────────────────────

/** What one source's `md/crypto/derivatives` answer holds for the symbol (the newest values and the stored minutes). */
export interface DerivativesSample {
  sourceId: string;
  /** Display name of the source. */
  label: string;
  funding: number | null;
  mark: number | null;
  index: number | null;
  openInterest: number | null;
  /** Per-minute rows stored in the sampled window (OI change and liquidations are computed from them). */
  minutes: number;
  /** Rows of those minutes carrying open interest. */
  oiMinutes: number;
}

/** Whether a kind can be evaluated for the symbol, from where, and the newest value (in the kind's unit) if known. */
export interface MetricAvailability {
  kind: MetricAlertKind;
  /** Sources with data for this kind (the first is what the engine reads when the alert names none). */
  sources: { sourceId: string; label: string }[];
  /** The newest value in the kind's unit (funding %, basis %); null when it is computed over a window. */
  current: number | null;
  currentSource: string | null;
}

/**
 * The kinds the symbol's derivatives data supports. Funding: a funding rate; basis: mark AND index (crypto) or a fresh
 * CME basis (`cmeBasis`, FX); OI change: open interest live AND stored per-minute rows of it; liquidations: stored
 * per-minute rows (the engine sums them). A spot market (no funding / mark / OI) offers none of them.
 */
export function availableMetrics(
  samples: readonly DerivativesSample[],
  cmeBasis: { sourceId: string; label: string; percent: number | null } | null = null,
): MetricAvailability[] {
  const sorted = [...samples].sort((a, b) => (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0));
  const out: MetricAvailability[] = [];
  const add = (kind: MetricAlertKind, pick: (s: DerivativesSample) => boolean, value: (s: DerivativesSample) => number | null) => {
    const with_ = sorted.filter(pick);
    if (!with_.length) return;
    out.push({
      kind,
      sources: with_.map((s) => ({ sourceId: s.sourceId, label: s.label })),
      current: value(with_[0]),
      currentSource: with_[0].sourceId,
    });
  };
  add('Funding', (s) => s.funding !== null, (s) => (s.funding !== null ? round8(s.funding * 100) : null));
  add('OpenInterestChange', (s) => s.openInterest !== null && s.oiMinutes > 0, () => null);
  if (cmeBasis)
    out.push({
      kind: 'Basis',
      sources: [{ sourceId: cmeBasis.sourceId, label: cmeBasis.label }],
      current: cmeBasis.percent,
      currentSource: cmeBasis.sourceId,
    });
  else
    add(
      'Basis',
      (s) => s.mark !== null && s.index !== null && s.index > 0,
      (s) => round8(((s.mark! - s.index!) / s.index!) * 100),
    );
  add('Liquidations', (s) => s.minutes > 0, () => null);
  return out;
}

function round8(v: number): number {
  return Math.round(v * 1e8) / 1e8;
}

// ── The form ──────────────────────────────────────────────────────────────────

/** The metric condition the form holds. */
export interface MetricDraft {
  kind: MetricAlertKind;
  comparator: MetricComparator;
  value: number | null;
  windowMinutes: number | null;
  sourceId: string | null;
}

/** What the engine would refuse, in its words, or null. */
export function metricProblem(d: MetricDraft, frequency: ChartAlertFrequency): string | null {
  const info = metricInfo(d.kind);
  if (d.value === null || !Number.isFinite(d.value)) return `Enter the ${info.label.toLowerCase()} value.`;
  if (Math.abs(d.value) > MAX_METRIC_ABS_VALUE) return 'The value is out of range.';
  if (d.kind === 'Liquidations' && d.value < 0) return 'A liquidations value is a notional and cannot be negative.';
  if (info.needsWindow) {
    const w = d.windowMinutes;
    if (w === null || !Number.isInteger(w) || w < 1 || w > MAX_METRIC_WINDOW_MINUTES)
      return `The window must be a whole number of minutes between 1 and ${MAX_METRIC_WINDOW_MINUTES}.`;
  }
  if (frequency === 'once_per_bar_close')
    return 'Derivatives alerts are evaluated every 15 seconds, not at bar closes: choose once, once per bar or every time.';
  return null;
}

/** The API's `metric` object for the draft (window only for the windowed kinds; empty source = auto). */
export function metricInput(d: MetricDraft): ChartAlertMetricInput {
  const info = metricInfo(d.kind);
  return {
    comparator: d.comparator,
    value: d.value ?? 0,
    windowMinutes: info.needsWindow ? d.windowMinutes : null,
    sourceId: d.sourceId || null,
  };
}

/** A value in the kind's unit: "0.0100 % per interval", "+2.35 %", "-0.0420 %", "1,250,000 notional". */
export function formatMetric(kind: MetricAlertKind, value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  switch (kind) {
    case 'Funding':
      return `${value.toFixed(4)} % per interval`;
    case 'OpenInterestChange':
      return `${value > 0 ? '+' : ''}${value.toFixed(2)} %`;
    case 'Basis':
      return `${value.toFixed(4)} %`;
    default:
      return `${Math.round(value).toLocaleString('en-US')} notional`;
  }
}

/** "Funding rate crosses above 0.0100 % per interval" / "Liquidations is above 1,000,000 notional over 60 min". */
export function describeMetric(kind: MetricAlertKind, m: Pick<ChartAlertMetricInput, 'comparator' | 'value' | 'windowMinutes' | 'sourceId'>): string {
  const info = metricInfo(kind);
  const verb = COMPARATORS.find((c) => c.id === m.comparator)?.label.toLowerCase() ?? m.comparator;
  const window = info.needsWindow && m.windowMinutes ? ` over ${m.windowMinutes} min` : '';
  const source = m.sourceId ? ` (${m.sourceId})` : '';
  return `${info.label} ${verb} ${formatMetric(kind, m.value)}${window}${source}`;
}
