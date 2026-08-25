import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import {
  ResponseData,
  DrawdownSnapshotDto,
  DrawdownSnapshotQueryFilter,
  PagedData,
  PagerRequest,
} from '@core/api/api.types';

@Injectable({ providedIn: 'root' })
export class DrawdownRecoveryService {
  private readonly api = inject(ApiService);

  record(data: any): Observable<ResponseData<DrawdownSnapshotDto>> {
    return this.api.post(`/drawdown-recovery`, data);
  }

  /**
   * Pass `accountIds` to scope the response.  When omitted the engine
   * rolls up across every active trading account (legacy fleet
   * behaviour, retained so callers that don't yet pass scope keep
   * working).  A single id returns that account's latest verbatim;
   * multiple ids return an aggregate (sums equity/peak, picks the
   * worst recovery mode across the set).
   */
  getLatest(accountIds?: ReadonlyArray<number>): Observable<ResponseData<DrawdownSnapshotDto>> {
    const qs = accountIds && accountIds.length > 0 ? `?accountIds=${accountIds.join(',')}` : '';
    return this.api.get(`/drawdown-recovery/latest${qs}`);
  }

  listHistory(
    query: PagerRequest & { filter?: DrawdownSnapshotQueryFilter },
  ): Observable<ResponseData<PagedData<DrawdownSnapshotDto>>> {
    return this.api.post(`/drawdown-recovery/history`, query);
  }

  /**
   * Per-account recovery standing.
   *
   * `getLatest` aggregates — it sums equity and reports the worst mode in the set —
   * so it can show the fleet as "Reduced" while one account has been Halted for
   * days. This returns each account separately, with the mode read from the
   * EngineConfig rows RiskChecker actually enforces.
   */
  listByAccount(includeInactive = false): Observable<ResponseData<AccountRecoveryStateDto[]>> {
    return this.api.get(`/drawdown-recovery/by-account?includeInactive=${includeInactive}`);
  }

  /**
   * BREAK-GLASS: rebase an account's drawdown anchor to its current equity.
   *
   * Mode is derived from drawdown against a monotonic peak, and Halted blocks new
   * orders — so a halted account with no open positions has static equity and can
   * never trade its way back under the threshold. This is the release valve.
   *
   * `reason` is mandatory and is persisted on the rebase snapshot: an unexplained
   * rebase is indistinguishable later from a bug. `targetDrawdownPct` 0 releases to
   * Normal; a value inside the Reduced band resumes at reduced size instead.
   */
  rebaseAnchor(
    accountId: number,
    reason: string,
    targetDrawdownPct = 0,
  ): Observable<ResponseData<RebaseDrawdownAnchorResult>> {
    return this.api.post(`/drawdown-recovery/${accountId}/rebase-anchor`, {
      reason,
      targetDrawdownPct,
    });
  }
}

/** One account's recovery standing — mirrors AccountRecoveryStateDto on the engine. */
export interface AccountRecoveryStateDto {
  tradingAccountId: number;
  accountName: string;
  accountNumber: string;
  isActive: boolean;
  /** Mode RiskChecker enforces, from DrawdownRecovery:ActiveMode:{id}. */
  recoveryMode: string;
  /** Mode on the newest snapshot; a divergence means the published row is stale. */
  snapshotMode: string | null;
  drawdownPct: number | null;
  peakEquity: number | null;
  currentEquity: number | null;
  highWaterMark: number | null;
  recordedAtUtc: string | null;
  peakRebasedAtUtc: string | null;
  peakRebaseReason: string | null;
  isRestricted: boolean;
  /** No ActiveMode row — never evaluated, not a halt. */
  isUnknown: boolean;
}

/** Outcome of a rebase attempt. */
export interface RebaseDrawdownAnchorResult {
  rebased: boolean;
  refusedReason: string | null;
  previousAnchor: number;
  newAnchor: number;
  highWaterMark: number;
  previousDrawdownPct: number;
  previousMode: string;
}
