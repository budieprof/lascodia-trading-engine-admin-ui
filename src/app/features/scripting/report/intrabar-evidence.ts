import type { ReportMeta } from './strategy-report.model';

/**
 * C3 evidence-policy facts of a script run (engine 2026-11-07): how the emulator ordered a bar's
 * extremes when OHLC cannot tell, how many bars that mattered on, and how much of the run was walked
 * through real lower-timeframe bars rather than an assumed OHLC path. Rows only for what the engine
 * reported — an older engine's report shows none of them.
 */

export type IntrabarResolutionName = 'ScriptDefault' | 'Pessimistic' | 'Optimistic';

export const INTRABAR_RESOLUTION_LABELS: Record<IntrabarResolutionName, string> = {
  ScriptDefault: "Pine's (nearest extreme first)",
  Pessimistic: 'Pessimistic (adverse extreme first)',
  Optimistic: 'Optimistic (favourable extreme first)',
};

export interface MagnifierCoverage {
  /** Fractions of the walked bars (0..1). */
  m1: number;
  lower: number;
  ohlc: number;
}

type C3Meta = Pick<
  ReportMeta,
  | 'intrabarResolution'
  | 'ambiguousBars'
  | 'intrabarReorderedBars'
  | 'walkedBars'
  | 'magnifiedM1Bars'
  | 'magnifiedLowerBars'
>;

/** True when the report carries any C3 field (an engine from 2026-11-07 on that had something to say). */
export function hasIntrabarEvidence(m: C3Meta): boolean {
  return (
    !!m.intrabarResolution ||
    m.ambiguousBars != null ||
    m.intrabarReorderedBars != null ||
    m.walkedBars != null
  );
}

export function intrabarResolutionLabel(v: string | null | undefined): string {
  const k = (v ?? '').trim() as IntrabarResolutionName;
  // The engine omits the default value: a C3 report without the field walked Pine's path.
  if (!k) return INTRABAR_RESOLUTION_LABELS.ScriptDefault;
  return INTRABAR_RESOLUTION_LABELS[k] ?? k;
}

/** Share of the walked bars filled along 1-minute bars, another lower timeframe, or their own OHLC. */
export function magnifierCoverage(m: C3Meta): MagnifierCoverage | null {
  const walked = m.walkedBars ?? 0;
  if (walked <= 0) return null;
  const m1 = Math.max(0, m.magnifiedM1Bars ?? 0);
  const lower = Math.max(0, m.magnifiedLowerBars ?? 0);
  const ohlc = Math.max(0, walked - m1 - lower);
  return { m1: m1 / walked, lower: lower / walked, ohlc: ohlc / walked };
}

const pct = (f: number) => `${(f * 100).toFixed(1)}%`;

export function magnifierCoverageText(c: MagnifierCoverage | null): string | null {
  if (!c) return null;
  return `M1 ${pct(c.m1)} · lower TF ${pct(c.lower)} · OHLC path ${pct(c.ohlc)}`;
}

/** The C3 rows of the report's run properties; empty for a report without C3 fields. */
export function intrabarRows(m: C3Meta): { label: string; value: string }[] {
  if (!hasIntrabarEvidence(m)) return [];
  const n = (v: number | null) => (v ?? 0).toLocaleString('en-US');
  const rows = [
    { label: 'Intrabar resolution', value: intrabarResolutionLabel(m.intrabarResolution) },
    { label: 'Ambiguous bars', value: n(m.ambiguousBars) },
    { label: 'Bars re-ordered by the resolution', value: n(m.intrabarReorderedBars) },
  ];
  const cov = magnifierCoverageText(magnifierCoverage(m));
  if (cov) rows.push({ label: `Fill path of ${n(m.walkedBars)} walked bars`, value: cov });
  return rows;
}
