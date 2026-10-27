import type { SessionStateDto } from '@core/instruments/instrument.types';

/** "Contango" / "backwardation" / "flat" for an annualised term-structure slope in %. */
export function slopeWord(slopePct: number | null | undefined): string {
  if (slopePct === null || slopePct === undefined) return '—';
  if (Math.abs(slopePct) < 0.05) return 'flat';
  return slopePct > 0 ? 'contango' : 'backwardation';
}

/** Sign colouring of a funding rate: positive (longs pay shorts) `pos`, negative `neg`. */
export function fundingTone(rate: number | null | undefined): '' | 'pos' | 'neg' {
  if (rate === null || rate === undefined || rate === 0) return '';
  return rate > 0 ? 'pos' : 'neg';
}

function inWords(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${m % 60} min`;
  return `${Math.round(h / 24)} days`;
}

/**
 * The market's state in one line from the engine's session state ("Open (Regular) · closes in 2 h 5 min",
 * "Closed · opens in 14 h 30 min"); "Session state unknown" when the engine has none.
 */
export function sessionText(s: SessionStateDto | null, nowMs: number): string {
  if (!s) return 'Session state unknown.';
  if (s.open) {
    const close = s.nextClose ? Date.parse(s.nextClose) : NaN;
    return `Open${s.sessionKind ? ` (${s.sessionKind})` : ''}${Number.isFinite(close) ? ` · closes in ${inWords(close - nowMs)}` : ''}.`;
  }
  const open = s.nextOpen ? Date.parse(s.nextOpen) : NaN;
  return `Closed${Number.isFinite(open) ? ` · opens in ${inWords(open - nowMs)}` : ''}.`;
}
