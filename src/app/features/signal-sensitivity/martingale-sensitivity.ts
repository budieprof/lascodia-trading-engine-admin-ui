import type {
  AnalyzeSignalSensitivityResultDto,
  AnalyzeSignalSensitivitySignalDto,
} from '@core/api/api.types';
import type { LadderTrade } from '@shared/components/martingale-simulator/martingale-ladder.logic';

/**
 * Per-trade outcome as a multiple of the risk that trade took.
 *
 * <p>Derived from prices rather than read off a field, because the sensitivity replay applies TP/SL
 * multipliers that the stored levels do not reflect. A stopped-out trade is −1R by definition;
 * anything else is scaled by how far it actually travelled against its own stop distance, so the
 * number restakes correctly at any lot size.</p>
 *
 * <p>Returns null when the trade never took risk (no fill, zero stop distance) — those are excluded
 * rather than silently counted as scratches, since a ladder must not advance on a trade that never
 * happened.</p>
 */
export function sensitivityRMultiple(
  sig: AnalyzeSignalSensitivitySignalDto,
  slMult: number,
  tpMult: number,
): number | null {
  if (!sig.fillAt) return null; // never filled — no risk taken
  const riskDist = Math.abs(sig.entryPrice - sig.originalSL) * (slMult || 1);
  if (!isFinite(riskDist) || riskDist <= 0) return null;

  if (sig.outcome === 'HitSL') return -1;
  if (sig.outcome === 'HitTP') {
    const rewardDist = Math.abs(sig.originalTP - sig.entryPrice) * (tpMult || 1);
    return rewardDist / riskDist;
  }
  // EarlyExit / Expired / Open — use realised travel, signed by direction.
  if (sig.exitPrice == null) return null;
  const move = sig.exitPrice - sig.entryPrice;
  const signed = (sig.direction || '').toLowerCase().startsWith('s') ? -move : move;
  return signed / riskDist;
}

/**
 * The trade's reward:risk as knowable AT ENTRY — TP distance over SL distance under the active
 * multipliers. Recovery stakes divide by this, never by the realised outcome.
 */
export function sensitivityGeometryR(
  sig: AnalyzeSignalSensitivitySignalDto,
  slMult: number,
  tpMult: number,
): number {
  const riskDist = Math.abs(sig.entryPrice - sig.originalSL) * (slMult || 1);
  const rewardDist = Math.abs(sig.originalTP - sig.entryPrice) * (tpMult || 1);
  if (!isFinite(riskDist) || riskDist <= 0 || !isFinite(rewardDist)) return 1;
  return rewardDist / riskDist;
}

/** The sensitivity result's replayed signals as ladder trades, keyed by signal id. */
export function ladderTradesFromSensitivity(
  res: AnalyzeSignalSensitivityResultDto | null,
): LadderTrade[] | null {
  if (!res) return null;
  const slMult = res.slMultiplier ?? 1;
  const tpMult = res.tpMultiplier ?? 1;
  return res.signals.map((sig) => ({
    id: sig.signalId,
    symbol: sig.symbol,
    at: sig.fillAt ?? sig.triggeredAt ?? sig.generatedAt,
    exitMs: Date.parse(sig.exitAt) || null,
    r: sensitivityRMultiple(sig, slMult, tpMult),
    geomR: sensitivityGeometryR(sig, slMult, tpMult),
  }));
}
