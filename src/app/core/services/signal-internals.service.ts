import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';

/** One stage of the generate → approve → serve → attempt → fill pipeline. */
export interface SignalFunnelStageDto {
  stage: string;
  label: string;
  entered: number;
  dropped: number;
  explanation: string;
}

export interface SignalReasonCountDto {
  reason: string;
  count: number;
  latestDetail: string | null;
  latestAtUtc: string | null;
}

export interface SignalStageRejectionDto {
  stage: string;
  count: number;
  reasons: SignalReasonCountDto[];
}

export interface SignalEaInstanceDto {
  instanceId: string;
  status: string;
  eaVersion: string;
  symbols: string;
  lastHeartbeatUtc: string | null;
  heartbeatAgeSeconds: number | null;
  isPolling: boolean;
  notPollingReason: string | null;
}

export interface SignalAccountReadinessDto {
  tradingAccountId: number;
  accountNumber: string;
  accountName: string;
  isActive: boolean;
  equity: number;

  recoveryMode: string;
  drawdownPct: number | null;
  peakEquity: number | null;
  drawdownRecordedAtUtc: string | null;

  /** Non-null when something blocks this account wholesale, regardless of signal. */
  blockingCondition: string | null;
  blockingDetail: string | null;
  blockingRemedy: string | null;

  instances: SignalEaInstanceDto[];
  polledSymbols: string[];

  signalsServable: number;
  attempts: number;
  attemptsPassed: number;
  attemptsBlocked: number;
  ordersPlaced: number;
  blockReasons: SignalReasonCountDto[];
  lastAttemptAtUtc: string | null;
  lastPassedAtUtc: string | null;
}

export type SignalDisposition = 'Filled' | 'Ordered' | 'Blocked' | 'NotServed' | 'NotAttempted';

export interface SignalAccountDispositionDto {
  tradingAccountId: number;
  accountName: string;
  disposition: SignalDisposition;
  explanation: string;
  blockReason: string | null;
  atUtc: string | null;
  orderStatus: string | null;
  brokerOrderId: string | null;
  retryPossible: boolean;
  retryEligibleAtUtc: string | null;
}

export interface SignalPipelineSignalDto {
  signalId: number;
  symbol: string;
  direction: string;
  status: string;
  source: string | null;
  confidence: number | null;
  entryPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  generatedAtUtc: string;
  expiresAtUtc: string | null;
  minutesToExpiry: number | null;
  isLive: boolean;
  rejectionReason: string | null;
  llmInvocationId: number | null;
  accounts: SignalAccountDispositionDto[];
  accountsFilled: number;
  accountsBlocked: number;
  accountsUntouched: number;
}

export interface SignalServingRulesDto {
  tier2RejectionBackoffMinutes: number;
  maxSignalsPerPoll: number;
  sinceParameterBehaviour: string;
  servingCriteria: string[];
}

export interface SignalPipelineOverviewDto {
  generatedAtUtc: string;
  windowHours: number;
  rules: SignalServingRulesDto;
  funnel: SignalFunnelStageDto[];
  accounts: SignalAccountReadinessDto[];
  signals: SignalPipelineSignalDto[];
  generationRejections: SignalStageRejectionDto[];
  topBlockReasons: SignalReasonCountDto[];
  liveSignalCount: number;
  blockedAccountCount: number;
}

export interface SignalInternalsParams {
  windowHours?: number;
  maxSignals?: number;
  accountId?: number | null;
  symbol?: string | null;
}

/**
 * Read-only view of the signal module's internal state.
 *
 * The endpoint approves nothing and serves nothing — it exists so "why did this
 * account not trade that signal" is answerable on one screen rather than by
 * joining five tables in psql.
 */
@Injectable({ providedIn: 'root' })
export class SignalInternalsService {
  private readonly api = inject(ApiService);

  getOverview(params: SignalInternalsParams = {}): Observable<SignalPipelineOverviewDto> {
    const query = new URLSearchParams();
    query.set('windowHours', String(params.windowHours ?? 24));
    query.set('maxSignals', String(params.maxSignals ?? 40));
    if (params.accountId != null) query.set('accountId', String(params.accountId));
    if (params.symbol) query.set('symbol', params.symbol);

    return this.api.getEnvelope<SignalPipelineOverviewDto>(
      `/trade-signal/internals?${query.toString()}`,
    );
  }
}
