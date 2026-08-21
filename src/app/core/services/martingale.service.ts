import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';

/** One symbol's ladder state on one account. */
export interface MartingaleSymbolDto {
  symbol: string;
  /** The per-(account, symbol) opt-in. */
  enabled: boolean;
  /** True only when the opt-in AND the profile flag are both set. */
  effectivelyActive: boolean;

  maxDepthOverride: number | null;
  targetProfitROverride: number | null;
  maxStakePctEquityOverride: number | null;
  maxChainAgeHoursOverride: number | null;

  effectiveMaxDepth: number;
  effectiveTargetProfitR: number;
  effectiveMaxStakePctEquity: number;
  effectiveMaxChainAgeHours: number;

  hasOpenChain: boolean;
  chainId: number | null;
  chainDepth: number;
  chainDeficitAmount: number;
  chainTargetAmount: number;
  chainOpenedAtUtc: string | null;

  /** Cumulative loss if every rung to the depth cap loses, as a % of equity. */
  worstCaseDrawdownPct: number;
}

/** Per-account martingale view. */
export interface MartingaleAccountSymbolsDto {
  tradingAccountId: number;
  accountName: string;
  riskProfileId: number | null;
  riskProfileName: string | null;
  profileMartingaleEnabled: boolean;
  /** Other accounts on the same risk profile — the PROFILE flag affects all of them. */
  accountsSharingProfile: number[];

  defaultMaxDepth: number;
  defaultTargetProfitR: number;
  defaultMaxStakePctEquity: number;
  defaultMaxChainAgeHours: number;
  defaultAbandonAtCap: boolean;

  /** Per-trade risk — the base stake every worst-case figure compounds from. */
  baseRiskPerTradePct: number;
  /** Worst case at the profile default depth, as a % of equity. */
  defaultWorstCaseDrawdownPct: number;
  /** Fleet-wide drawdown thresholds a ladder must stay inside. */
  reducedDrawdownPct: number;
  haltedDrawdownPct: number;

  /**
   * FLEET-WIDE execution mode — not per-account, not per-profile. Dominates both opt-ins:
   * a symbol shown as enabled while this is 'Shadow' computes rungs and applies none.
   */
  mode: MartingaleMode;

  symbols: MartingaleSymbolDto[];
}

export type MartingaleMode = 'Off' | 'Shadow' | 'Live';

export interface SetMartingaleModeRequest {
  mode: MartingaleMode;
  /** Required when going Live. */
  reason?: string | null;
  /** Required when going Live; recorded in the audit trail. */
  acknowledgeLiveTrading?: boolean;
}

export interface SetMartingaleModeResult {
  previousMode: string;
  newMode: string;
  /** (account, symbol) ladders the change immediately affects. */
  activeLadderCount: number;
  activeLadders: string[];
}

export interface SetMartingaleProfileRequest {
  enabled: boolean;
  targetProfitR: number;
  maxDepth: number;
  maxStakePctEquity: number;
  maxChainAgeHours: number;
  abandonAtCap: boolean;
  /** Required to set abandonAtCap = false; recorded in the audit trail. */
  acknowledgeUnboundedRisk?: boolean;
  /** Required when enabling. */
  reason?: string | null;
}

export interface SetMartingaleSymbolRequest {
  enabled: boolean;
  maxDepthOverride?: number | null;
  targetProfitROverride?: number | null;
  maxStakePctEquityOverride?: number | null;
  maxChainAgeHoursOverride?: number | null;
  /** Required when enabling. */
  reason?: string | null;
}

// ── Fleet-wide internals ─────────────────────────────────────────────────────

/** One close that moved a chain, replayed from position history. */
export interface MartingaleChainLedgerEntryDto {
  positionId: number;
  direction: string;
  lots: number;
  realisedPnl: number;
  closedAtUtc: string | null;
  closePrice: number | null;
  /** Deficit after this close, replayed from the chain's opening balance. */
  runningDeficit: number;
  /** Loss | Win | Scratch. */
  outcome: string;
  /** Only losses cost a rung — depth counts attempts that lost. */
  burnedARung: boolean;
  openedTheChain: boolean;
}

/** The rung a chain would stake next, and the first thing that would stop it. */
export interface MartingaleNextRungDto {
  depth: number;
  amountToRecover: number;
  stakeMultiple: number;
  stakePctEquity: number;
  bindingConstraint: string | null;
  wouldAbandon: boolean;
  /** Serialisation: something is already live on the symbol. */
  blockedBy: string | null;
}

export interface MartingaleChainViewDto {
  id: number;
  tradingAccountId: number;
  accountName: string;
  symbol: string;
  status: string;
  depth: number;
  maxDepth: number;
  /** Positive is owed; NEGATIVE is surplus banked toward the target. */
  deficitAmount: number;
  targetAmount: number;
  baseStakeAmount: number;
  openedAtUtc: string;
  lastAdvancedAtUtc: string;
  closedAtUtc: string | null;
  closureReason: string | null;
  lastPositionId: number | null;
  ageHours: number;
  maxChainAgeHours: number;
  isStale: boolean;
  realisedPnl: number;
  ledger: MartingaleChainLedgerEntryDto[];
  nextRung: MartingaleNextRungDto | null;
}

export interface MartingaleSweeperStateDto {
  enabled: boolean;
  intervalSeconds: number;
  staleAfterMinutes: number;
  openLookbackMinutes: number;
  openSettleSeconds: number;
  maxChainsPerCycle: number;
  chainsCurrentlyStale: number;
}

export interface MartingaleTotalsDto {
  openChains: number;
  recoveredChains: number;
  abandonedChains: number;
  outstandingDeficit: number;
  bankedSurplus: number;
  abandonedDeficit: number;
  lifetimeRealisedPnl: number;
}

export interface MartingaleLadderedSymbolDto {
  tradingAccountId: number;
  accountName: string;
  symbol: string;
  enabled: boolean;
  profileEnabled: boolean;
  effectivelyActive: boolean;
  effectiveMaxDepth: number;
  effectiveTargetProfitR: number;
  effectiveMaxStakePctEquity: number;
  effectiveMaxChainAgeHours: number;
  abandonAtCap: boolean;
  accountEquity: number;
  worstCaseDrawdownPct: number;
  openChainId: number | null;
  openPositions: number;
  ordersInFlight: number;
}

export interface MartingaleOverviewDto {
  mode: MartingaleMode;
  modeExplicitlySet: boolean;
  generatedAtUtc: string;
  sweeper: MartingaleSweeperStateDto;
  totals: MartingaleTotalsDto;
  chains: MartingaleChainViewDto[];
  ladderedSymbols: MartingaleLadderedSymbolDto[];
}

/**
 * Per-symbol recovery ladder controls.
 *
 * Opt-in is scoped to an (account, symbol) pair — never to a symbol alone, because risk profiles
 * are shared between accounts and a symbol-only toggle would ladder every account on the profile.
 */
@Injectable({ providedIn: 'root' })
export class MartingaleService {
  private readonly api = inject(ApiService);

  /**
   * Everything the ladder module is doing, fleet-wide. Read-only and derived — the chain ledgers
   * are replayed from position history because a chain row keeps only running totals.
   */
  getOverview(opts?: {
    maxChains?: number;
    status?: string;
    accountId?: number;
  }): Observable<MartingaleOverviewDto> {
    const params = new URLSearchParams();
    if (opts?.maxChains != null) params.set('maxChains', String(opts.maxChains));
    if (opts?.status) params.set('status', opts.status);
    if (opts?.accountId != null) params.set('accountId', String(opts.accountId));
    const qs = params.toString();
    return this.api.getEnvelope<MartingaleOverviewDto>(`/martingale/overview${qs ? `?${qs}` : ''}`);
  }

  getSymbols(accountId: number): Observable<MartingaleAccountSymbolsDto> {
    return this.api.getEnvelope<MartingaleAccountSymbolsDto>(
      `/martingale/accounts/${accountId}/symbols`,
    );
  }

  setSymbol(
    accountId: number,
    symbol: string,
    body: SetMartingaleSymbolRequest,
  ): Observable<boolean> {
    return this.api.putEnvelope<boolean>(
      `/martingale/accounts/${accountId}/symbols/${encodeURIComponent(symbol)}`,
      body,
    );
  }

  /**
   * Updates the martingale defaults on a risk profile. Scoped to the martingale fields alone —
   * it never round-trips the profile's other risk limits, which this screen does not show.
   */
  setProfile(riskProfileId: number, body: SetMartingaleProfileRequest): Observable<boolean> {
    return this.api.putEnvelope<boolean>(`/martingale/profiles/${riskProfileId}`, body);
  }

  /**
   * Sets the fleet-wide execution mode. Affects every account at once — the response reports how
   * many (account, symbol) ladders the change actually touches.
   */
  setMode(body: SetMartingaleModeRequest): Observable<SetMartingaleModeResult> {
    return this.api.putEnvelope<SetMartingaleModeResult>(`/martingale/mode`, body);
  }
}
