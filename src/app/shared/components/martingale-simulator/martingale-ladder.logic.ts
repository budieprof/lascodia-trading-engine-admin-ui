/**
 * Martingale / recovery-ladder simulation over an ordered list of trades — the pure core behind
 * `<app-martingale-simulator>`. Each page adapts its own trades into {@link LadderTrade}s (the
 * signal-sensitivity replay, a backtest's trade list) and this module does the rest.
 *
 * <p><b>Outcomes are normalised to R; the ladder ledger is MONEY.</b> Each trade's outcome is a
 * multiple of the risk it took (raw P&L has lot size baked in and cannot be restaked), but the
 * deficit a ladder must repay is tracked in currency: percent losses and percent gains are not
 * symmetric, so an R-unit ledger recovered against post-loss equity systematically under-recovers,
 * compounding with depth. A chain resets only when deficit + target is actually paid — a trade that
 * merely closes positive shrinks the deficit and the chain continues.</p>
 *
 * <p><b>The ladder is per-symbol and strictly sequential</b>: a symbol running a ladder holds at most
 * one position at a time, so its trades form one ordered chain and other symbols are untouched.</p>
 */

/** How the next stake is chosen after a loss. */
export type LadderMode = 'recovery' | 'fixed';

/** What happens when the ladder hits its depth cap without recovering. */
export type CapPolicy = 'abandon' | 'continue';

/** One trade, as the ladder sees it. Adapters build these from each page's own rows. */
export interface LadderTrade {
  /** Row key the host page uses to look the simulated trade back up (signal id, trade number). */
  id: number;
  symbol: string;
  /** When the position opened (ISO). Trades that never took risk keep their best-known time. */
  at: string;
  /** When the position closed (Unix ms); null when unknown. Drives the one-position rule. */
  exitMs: number | null;
  /** Outcome as a multiple of the risk taken; null when the trade took no risk (never filled, no stop). */
  r: number | null;
  /**
   * Reward:risk as knowable AT ENTRY (target distance over stop distance). Recovery stakes divide by
   * this, never by the realised outcome. Null when the source does not record a target — the
   * settings' {@link LadderSettings.assumedGeomR} is used instead.
   */
  geomR: number | null;
}

export interface LadderSettings {
  /** A symbol, or `'__all__'` to ladder every symbol. */
  symbolScope: string;
  mode: LadderMode;
  fixedMult: number;
  targetProfitR: number;
  baseRiskPct: number;
  /** Recovery rungs allowed after the opening loss (engine `MaxDepth` semantics). */
  maxDepth: number;
  capPolicy: CapPolicy;
  startBalance: number;
  /** Reward:risk for recovery sizing when a trade's {@link LadderTrade.geomR} is null. */
  assumedGeomR: number;
}

/** One simulated trade in sequence. */
export interface SimTrade {
  index: number;
  /** The {@link LadderTrade.id} it came from. */
  signalId: number;
  at: string;
  symbol: string;
  r: number;
  laddered: boolean;
  depth: number;
  stakePct: number;
  pnl: number;
  equity: number;
  /** Running P&L since the start of the run — equity minus the opening balance. */
  cumPnl: number;
  /** What flat sizing had made by this same point, so the two ledgers compare row by row. */
  baselineEquity: number;
}

/** Why a trade was not simulated; for overlaps, which executed trade held the position. */
export interface SkipInfo {
  reason: 'unfilled' | 'overlap';
  blockedBySignalId?: number;
  blockedUntil?: string;
}

export interface SimResult {
  trades: SimTrade[];
  baselineEquity: number[];
  finalEquity: number;
  baselineFinal: number;
  maxDrawdownPct: number;
  ruinedAtIndex: number | null;
  maxDepth: number;
  laddersStarted: number;
  laddersRecovered: number;
  laddersAbandoned: number;
  peakStakePct: number;
  usableTrades: number;
  skippedNoR: number;
  /**
   * Flat sizing over EVERY trade that took risk — no serialisation, no ladder. The control that
   * separates what the one-position rule did from what the ladder did.
   */
  baselineAllFilledFinal: number;
  /** How many trades that population contains. */
  allFilledCount: number;
  /** Trades skipped because they filled while the symbol's simulated position was still open. */
  skippedOverlap: number;
  /** Why each unsimulated trade was skipped. Post-break trades are simply absent. */
  skipReasons: Map<number, SkipInfo>;
}

/**
 * Absolute slack for the paid-in-full comparison, scaled to the amount being compared so it stays
 * meaningful whether the ladder deals in cents or millions. Large enough to absorb double-rounding
 * on a multiply-then-divide round trip, far too small to forgive a genuinely unpaid deficit.
 */
function clearTolerance(targetMoney: number): number {
  return 1e-9 * Math.max(1, Math.abs(targetMoney));
}

/** Median of the R multiples of trades that closed at their take-profit — a stand-in target R:R. */
export function medianR(values: number[]): number | null {
  const v = values.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

export function simulateLadder(input: readonly LadderTrade[], cfg: LadderSettings): SimResult {
  // Chronological by open, then id — the ladder is a SEQUENCE, so order is the whole model.
  const ordered = [...input].sort((a, b) => {
    const ta = Date.parse(a.at);
    const tb = Date.parse(b.at);
    return ta === tb ? a.id - b.id : ta - tb;
  });

  const scope = cfg.symbolScope;
  const base = cfg.baseRiskPct / 100;
  const target = cfg.targetProfitR;
  const cap = Math.max(1, Math.trunc(cfg.maxDepth));
  const useRecovery = cfg.mode === 'recovery';
  const mult = Math.max(1, cfg.fixedMult);
  const assumedGeom = cfg.assumedGeomR > 0 ? cfg.assumedGeomR : 1;

  let equity = cfg.startBalance;
  let baseline = cfg.startBalance;
  let peakEquity = equity;
  let maxDd = 0;
  let peakStakePct = 0;
  let ruinedAt: number | null = null;
  let maxDepthSeen = 0;
  let started = 0;
  let recovered = 0;
  let abandoned = 0;
  let skipped = 0;
  let skippedOverlap = 0;
  const skipReasons = new Map<number, SkipInfo>();

  // One position per symbol, enforced: a laddered symbol cannot open a new position until the
  // previous one has closed, so overlapping historical trades must not all "execute" and advance the
  // chain with outcomes that did not exist yet at the next fill.
  const busyUntil = new Map<string, { until: number; bySignalId: number }>();

  // Ladder state is PER SYMBOL, and the DEFICIT is tracked in MONEY (see the module doc).
  const ladder = new Map<string, { depth: number; deficit: number; targetMoney: number }>();

  const trades: SimTrade[] = [];
  const baselineEquity: number[] = [];

  for (const t of ordered) {
    const r = t.r;
    if (r === null || !Number.isFinite(r)) {
      skipped++;
      skipReasons.set(t.id, { reason: 'unfilled' });
      continue;
    }

    const inScope = scope === '__all__' || t.symbol === scope;

    // Serialise in-scope symbols. Out-of-scope symbols keep their historical concurrency — they
    // are flat-sized context, not the scheme under test.
    const fillMs = Date.parse(t.at);
    if (inScope) {
      const busy = busyUntil.get(t.symbol);
      if (busy && fillMs < busy.until) {
        skippedOverlap++;
        skipReasons.set(t.id, {
          reason: 'overlap',
          blockedBySignalId: busy.bySignalId,
          blockedUntil: new Date(busy.until).toISOString(),
        });
        continue;
      }
    }
    const st = ladder.get(t.symbol) ?? { depth: 0, deficit: 0, targetMoney: 0 };
    const inLadder = inScope && st.depth > 0;

    // Recovery mode sizes by the trade's ENTRY-KNOWN geometry — what a live implementation would
    // have to use, since the realised outcome does not exist yet. Sizing by realised R is lookahead.
    let stakeMoney = equity * base;
    if (inLadder) {
      if (useRecovery) {
        const geomR = t.geomR ?? assumedGeom;
        // A micro-TP trade cannot be asked to recover a large deficit — the stake explodes. Floor
        // the divisor at 0.1R and let the ruin check catch what still cannot fit, loudly.
        stakeMoney = (st.deficit + st.targetMoney) / Math.max(0.1, geomR);
      } else {
        stakeMoney = equity * base * Math.pow(mult, st.depth);
      }
    }

    const stakePct = equity > 0 ? stakeMoney / equity : 1;
    peakStakePct = Math.max(peakStakePct, stakePct * 100);

    // Ruin: the stake the ladder demands exceeds what is left. This ENDS the simulation — the scheme
    // is unexecutable from here, and skipping the unaffordable trade would launder the verdict.
    if (stakeMoney > equity || equity <= 0) {
      ruinedAt = trades.length;
      break;
    }

    const pnl = r * stakeMoney;
    equity += pnl;
    baseline += r * (baseline * base);
    baselineEquity.push(baseline);

    peakEquity = Math.max(peakEquity, equity);
    maxDd = Math.max(maxDd, peakEquity > 0 ? ((peakEquity - equity) / peakEquity) * 100 : 0);

    if (inScope) {
      // Busy until the position closes; never let the window end before the fill itself.
      busyUntil.set(t.symbol, {
        until: Math.max(fillMs, t.exitMs ?? fillMs),
        bySignalId: t.id,
      });
    }

    trades.push({
      index: trades.length,
      signalId: t.id,
      at: t.at,
      symbol: t.symbol,
      r,
      laddered: inLadder,
      depth: inScope ? st.depth : 0,
      stakePct: stakePct * 100,
      pnl,
      equity,
      cumPnl: equity - cfg.startBalance,
      baselineEquity: baseline,
    });

    if (equity <= 0) {
      ruinedAt = trades.length - 1;
      break;
    }

    // Advance ladder state on the MONEY ledger. The chain resets only when deficit + target has
    // actually been PAID; a partial win shrinks the deficit and the chain continues.
    if (inScope) {
      const newDeficit = st.deficit - pnl;
      if (st.depth === 0) {
        if (pnl < 0) {
          started++;
          maxDepthSeen = Math.max(maxDepthSeen, 1);
          ladder.set(t.symbol, {
            depth: 1,
            deficit: -pnl,
            // Target fixed in money at LADDER START, so later stakes cannot inflate "recovered".
            targetMoney: target * stakeMoney,
          });
        }
      } else if (newDeficit <= -st.targetMoney + clearTolerance(st.targetMoney)) {
        // Deficit paid AND target banked. Relative tolerance: a HitTP repays deficit + target to
        // the cent, which in floating point can land a hair above the threshold (GBPUSD #8956).
        recovered++;
        ladder.delete(t.symbol);
      } else {
        const nextDepth = st.depth + 1;
        maxDepthSeen = Math.max(maxDepthSeen, nextDepth);
        // The cap counts RECOVERY RUNGS (engine MaxDepth since 2026-09-05): rung N is permitted when
        // N <= cap, so the chain abandons only when the NEXT rung would be cap + 1.
        if (nextDepth > cap && cfg.capPolicy === 'abandon') {
          abandoned++;
          ladder.delete(t.symbol);
        } else {
          ladder.set(t.symbol, {
            depth: nextDepth,
            deficit: Math.max(0, newDeficit),
            targetMoney: st.targetMoney,
          });
        }
      }
    }
  }

  // Flat sizing over every trade that took risk, ignoring serialisation. Without this the panel
  // credits the ladder for gains the one-position rule produced by SELECTION.
  let allFilledEquity = cfg.startBalance;
  let allFilledCount = 0;
  for (const t of ordered) {
    if (t.r === null || !Number.isFinite(t.r)) continue;
    allFilledCount++;
    allFilledEquity += t.r * (allFilledEquity * base);
  }

  return {
    trades,
    baselineEquity,
    finalEquity: equity,
    baselineFinal: baseline,
    maxDrawdownPct: maxDd,
    ruinedAtIndex: ruinedAt,
    maxDepth: maxDepthSeen,
    laddersStarted: started,
    laddersRecovered: recovered,
    laddersAbandoned: abandoned,
    peakStakePct,
    usableTrades: trades.length,
    skippedNoR: skipped,
    skippedOverlap,
    skipReasons,
    baselineAllFilledFinal: allFilledEquity,
    allFilledCount,
  };
}
