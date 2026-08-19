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

  symbols: MartingaleSymbolDto[];
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

/**
 * Per-symbol recovery ladder controls.
 *
 * Opt-in is scoped to an (account, symbol) pair — never to a symbol alone, because risk profiles
 * are shared between accounts and a symbol-only toggle would ladder every account on the profile.
 */
@Injectable({ providedIn: 'root' })
export class MartingaleService {
  private readonly api = inject(ApiService);

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
}
