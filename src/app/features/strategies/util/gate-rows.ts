import type { PromotionGateOutcomeName, PromotionGateRowDto } from '@core/api/api.types';

/**
 * Structured promotion-gate rows (engine contract C2, strategy program 2026-11-07).
 *
 * The engine now says for every gate what it decided — Pass / Fail / Skipped / NotMeasurable /
 * Bypassed / Observe — with the measured value, the threshold and the comparator. Before that the
 * console guessed the status from free text, so a passed gate was never shown as "Pass" and a
 * "failed … skip" line was pilled "Skipped". Render these rows whenever they are present; the text
 * parse stays only for answers recorded before the rows existed.
 */

export const GATE_OUTCOMES: readonly PromotionGateOutcomeName[] = [
  'Pass',
  'Fail',
  'Skipped',
  'NotMeasurable',
  'Bypassed',
  'Observe',
];

export type GateTone = 'pass' | 'fail' | 'skip' | 'bypass' | 'warn' | 'info';

/** The outcome by name; tolerates the enum's ordinal and odd casing. Unknown → null. */
export function gateOutcome(v: unknown): PromotionGateOutcomeName | null {
  if (typeof v === 'number') return GATE_OUTCOMES[v] ?? null;
  if (typeof v !== 'string') return null;
  const k = v.replace(/[\s_-]/g, '').toLowerCase();
  return GATE_OUTCOMES.find((o) => o.toLowerCase() === k) ?? null;
}

export function gateOutcomeLabel(o: PromotionGateOutcomeName | null): string {
  switch (o) {
    case 'Pass':
      return 'Pass';
    case 'Fail':
      return 'Fail';
    case 'Skipped':
      return 'Skipped';
    case 'NotMeasurable':
      return 'Not measurable';
    case 'Bypassed':
      return 'Bypassed';
    case 'Observe':
      return 'Observe';
    default:
      return 'Unknown';
  }
}

export function gateOutcomeTone(o: PromotionGateOutcomeName | null): GateTone {
  switch (o) {
    case 'Pass':
      return 'pass';
    case 'Fail':
      return 'fail';
    case 'Skipped':
      return 'skip';
    case 'Bypassed':
      return 'bypass';
    case 'NotMeasurable':
    case 'Observe':
      return 'warn';
    default:
      return 'info';
  }
}

/** What an outcome means for the reader (chip tooltip). */
export function gateOutcomeHint(o: PromotionGateOutcomeName | null): string {
  switch (o) {
    case 'Pass':
      return 'Measured and within its threshold.';
    case 'Fail':
      return 'Measured and outside its threshold — blocks promotion.';
    case 'Skipped':
      return 'Not run: switched off by configuration.';
    case 'NotMeasurable':
      return 'Ran but could not measure (no data, too few trades). Whether that blocks is the engine policy Promotion:NotMeasurablePolicy — it is not a pass.';
    case 'Bypassed':
      return 'Deliberately bypassed for this evaluation.';
    case 'Observe':
      return 'Measured and reported only — configured not to block.';
    default:
      return '';
  }
}

/** `cpcv` → the engine's display name when sent, else "Cpcv"-style words from the key. */
export function gateLabel(row: Pick<PromotionGateRowDto, 'gate' | 'displayName'>): string {
  const dn = row.displayName?.trim();
  if (dn) return dn;
  const key = (row.gate ?? '').trim();
  if (!key) return 'Gate';
  const KNOWN: Record<string, string> = {
    dsr: 'Deflated Sharpe (DSR)',
    pbo: 'Probability of backtest overfitting (PBO)',
    tca: 'TCA-adjusted expectancy',
    spa: 'Superior predictive ability (SPA)',
    cpcv: 'Time-dispersion stress',
  };
  if (KNOWN[key.toLowerCase()]) return KNOWN[key.toLowerCase()];
  const words = key.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const COMPARATOR: Record<string, string> = {
  '>=': '≥',
  '<=': '≤',
  '>': '>',
  '<': '<',
  '==': '=',
  '=': '=',
};

/** A gate number: up to 4 significant digits, no exponent for ordinary magnitudes. */
export function fmtGateNumber(v: number | null | undefined, unit?: string | null): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const u = (unit ?? '').trim().toLowerCase();
  if (u === '%' || u === 'percent') return `${trimNum(v)}%`;
  return trimNum(v);
}

function trimNum(v: number): string {
  const a = Math.abs(v);
  if (a !== 0 && (a < 0.0001 || a >= 1e7)) return v.toExponential(2);
  const digits = a >= 100 ? 1 : a >= 1 ? 2 : 3;
  return String(Number(v.toFixed(digits)));
}

function unitSuffix(unit: string | null | undefined): string {
  const u = (unit ?? '').trim();
  if (!u || u === '%' || u.toLowerCase() === 'percent') return '';
  return ` ${u}`;
}

/**
 * "0.97 probability (needs ≥ 0.95)" — the measured value with its unit, then what passing needs.
 * With no value: "needs ≥ 0.95 probability"; with neither: "—". Never written as "0.81 ≥ 0.95",
 * which reads as a (false) statement.
 */
export function gateValueVsThreshold(
  row: Pick<PromotionGateRowDto, 'value' | 'threshold' | 'unit' | 'comparator'>,
): string {
  const cmp = row.comparator ? (COMPARATOR[row.comparator.trim()] ?? row.comparator.trim()) : null;
  const hasV = row.value != null && Number.isFinite(row.value);
  const hasT = row.threshold != null && Number.isFinite(row.threshold);
  const u = unitSuffix(row.unit);
  if (hasV && hasT) {
    return `${fmtGateNumber(row.value, row.unit)}${u} (needs ${cmp ? cmp + ' ' : ''}${fmtGateNumber(row.threshold, row.unit)})`;
  }
  if (hasV) return `${fmtGateNumber(row.value, row.unit)}${u}`;
  if (hasT) return `needs ${cmp ? cmp + ' ' : ''}${fmtGateNumber(row.threshold, row.unit)}${u}`;
  return '—';
}

export interface GateRowView {
  key: string;
  label: string;
  outcome: PromotionGateOutcomeName | null;
  outcomeLabel: string;
  tone: GateTone;
  hint: string;
  measure: string;
  detail: string;
}

/** Rows ready for a table; null/garbage rows are dropped. */
export function gateRowViews(
  rows: readonly PromotionGateRowDto[] | null | undefined,
): GateRowView[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r): r is PromotionGateRowDto => !!r && typeof r === 'object')
    .map((r, i) => {
      const outcome = gateOutcome(r.outcome);
      return {
        key: `${r.gate ?? ''}#${i}`,
        label: gateLabel(r),
        outcome,
        outcomeLabel: gateOutcomeLabel(outcome),
        tone: gateOutcomeTone(outcome),
        hint: gateOutcomeHint(outcome),
        measure: gateValueVsThreshold(r),
        detail: (r.detail ?? '').trim(),
      };
    });
}

/** "3 pass · 1 fail · 2 not measurable" — counts in the outcome order, zeros left out. */
export function gateOutcomeCounts(views: readonly GateRowView[]): string {
  const parts: string[] = [];
  for (const o of GATE_OUTCOMES) {
    const n = views.filter((v) => v.outcome === o).length;
    if (n > 0) parts.push(`${n} ${gateOutcomeLabel(o).toLowerCase()}`);
  }
  return parts.join(' · ');
}

/** Failed gates as one line each ("Deflated Sharpe (DSR): 0.81 probability (needs ≥ 0.95) — detail"). */
export function failedGateLines(views: readonly GateRowView[]): string[] {
  return views
    .filter((v) => v.outcome === 'Fail')
    .map((v) => {
      const m = v.measure !== '—' ? `: ${v.measure}` : '';
      return v.detail ? `${v.label}${m} — ${v.detail}` : `${v.label}${m}`;
    });
}
