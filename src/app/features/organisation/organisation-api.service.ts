import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';

import { ApiService } from '@core/api/api.service';
import { ApiError, type PagedData, type ResponseData } from '@core/api/api.types';
import { queryString, rows } from '@features/iam/iam-api.service';
import type {
  AlertChannelName,
  AlertChannelSaveResult,
  AlertChannelSettings,
  AlertChannelTestResult,
  ConfigOverrides,
  CreateEnrollmentTokenBody,
  EffectiveConfig,
  EnrollmentToken,
  EnrollmentTokenCreated,
  LlmUsageReport,
  MachineCredential,
  OverrideScopeType,
  OverrideWriteResult,
  SaveAlertChannelBody,
  ScopedKillSwitchStatus,
  SetConfigOverrideBody,
  StrategyBinding,
  StrategyBindingInput,
  StrategyOwnership,
  StrategySubscriptions,
  StrategySummary,
  TenantLlmKey,
} from './organisation.types';

/** The override writes' answer: the envelope plus `outcome`, `effectiveAt`, `pendingChangeId`, `breakGlass`. */
interface OverrideWriteResponse extends ResponseData<number> {
  outcome?: string | null;
  effectiveAt?: string | null;
  pendingChangeId?: number | null;
  breakGlass?: boolean;
}

/** An override write's result, or an {@link ApiError} for a refusal (incl. `-202-approval`). */
export function overrideResult(res: OverrideWriteResponse | null): OverrideWriteResult {
  if (!res || res.status !== true) {
    const envelope = res ?? { data: null, status: false, message: null, responseCode: null };
    throw new ApiError(res?.responseCode ?? 'UNKNOWN', res?.message ?? 'Request failed', envelope);
  }
  return {
    id: res.data ?? 0,
    outcome: res.outcome ?? null,
    effectiveAt: res.effectiveAt ?? null,
    pendingChangeId: res.pendingChangeId ?? null,
    breakGlass: res.breakGlass === true,
    message: res.message,
  };
}

/** The pages say what went wrong themselves; session handling (step-up, CSRF, sign-in) still applies. */
const SILENT = { silent: true } as const;

/**
 * The envelope's `data`, or an {@link ApiError} for a refusal — including a two-person action the
 * engine accepted for approval (`-202-approval`, HTTP 202), which the pages must announce as sent
 * for approval, not as a failure.
 */
export function settled<T>(source: Observable<ResponseData<T>>): Observable<T> {
  return source.pipe(
    map((res) => {
      if (!res || res.status !== true) {
        throw new ApiError(res?.responseCode ?? 'UNKNOWN', res?.message ?? 'Request failed', res);
      }
      return res.data as T;
    }),
  );
}

/**
 * The organisation console's engine calls (multi-tenancy Phase 7, c7-tenant). Every call acts in
 * the session's active organisation; the engine enforces the permission (and StepUp / TwoPerson,
 * which the HTTP interceptors turn into a sign-in or an "awaiting approval" notice).
 */
@Injectable({ providedIn: 'root' })
export class OrganisationApiService {
  private readonly api = inject(ApiService);

  private get<T>(path: string): Observable<T> {
    return settled(this.api.get<ResponseData<T>>(path, SILENT));
  }
  private post<T>(path: string, body: unknown = {}): Observable<T> {
    return settled(this.api.post<ResponseData<T>>(path, body, SILENT));
  }
  private del<T>(path: string): Observable<T> {
    return settled(this.api.delete<ResponseData<T>>(path, SILENT));
  }

  // ── Connect a terminal (engine MachineController) ──

  /** `accounts.connect` (step-up). The token text comes back this once. */
  createEnrollmentToken(body: CreateEnrollmentTokenBody): Observable<EnrollmentTokenCreated> {
    return this.post('/machine/enrollments', body);
  }

  /** `accounts.read`. Pending only unless `includeInactive`. */
  enrollmentTokens(includeInactive: boolean): Observable<EnrollmentToken[]> {
    return this.get<unknown>(`/machine/enrollments${queryString({ includeInactive })}`).pipe(
      map((d) => rows<EnrollmentToken>(d)),
    );
  }

  /** `accounts.manage`. A used token cannot be revoked (revoke its credential instead). */
  revokeEnrollmentToken(id: number): Observable<boolean> {
    return this.del(`/machine/enrollments/${id}`);
  }

  /** `accounts.read`. Active only unless `includeRevoked`. */
  machineCredentials(includeRevoked: boolean): Observable<MachineCredential[]> {
    return this.get<unknown>(`/machine/credentials${queryString({ includeRevoked })}`).pipe(
      map((d) => rows<MachineCredential>(d)),
    );
  }

  /** `accounts.connect` (step-up). The machine is refused within 30 seconds. */
  revokeCredential(id: number, reason: string | null): Observable<boolean> {
    return this.post(`/machine/credentials/${id}/revoke`, { reason: reason || null });
  }

  /** `accounts.connect` (step-up). The machine picks up a new secret on its next token exchange. */
  rotateCredential(id: number): Observable<boolean> {
    return this.post(`/machine/credentials/${id}/rotate`);
  }

  // ── Layered settings (engine ConfigOverridesController; engine.config on the scope) ──

  /** What one account (or, without one, the organisation) runs with, layer by layer. */
  effectiveConfig(tradingAccountId: number | null): Observable<EffectiveConfig> {
    return this.get(`/config/effective${queryString({ tradingAccountId })}`);
  }

  /** The organisation's own values (with an account: organisation-wide + that account's) and queued changes. */
  configOverrides(tradingAccountId: number | null): Observable<ConfigOverrides> {
    return this.get(`/config/overrides${queryString({ tradingAccountId })}`);
  }

  /** Set a value. A risk-loosening change may be queued, refused for step-up, or sent for approval. */
  setOverride(body: SetConfigOverrideBody): Observable<OverrideWriteResult> {
    return this.api
      .put<OverrideWriteResponse>('/config/overrides', body, SILENT)
      .pipe(map(overrideResult));
  }

  /** Remove a value: the scope inherits again. Removing a tighter value is a risk-loosening change. */
  removeOverride(p: {
    scopeType: OverrideScopeType;
    tradingAccountId: number | null;
    key: string;
    reason: string | null;
    immediate: boolean;
  }): Observable<OverrideWriteResult> {
    const q = queryString({
      scopeType: p.scopeType,
      tradingAccountId: p.scopeType === 'Account' ? p.tradingAccountId : null,
      key: p.key,
      reason: p.reason,
      immediate: p.immediate || null,
    });
    return this.api
      .delete<OverrideWriteResponse>(`/config/overrides${q}`, SILENT)
      .pipe(map(overrideResult));
  }

  /** Cancel one of the organisation's queued changes before it takes effect. */
  cancelPendingOverride(id: number, reason: string | null): Observable<OverrideWriteResult> {
    return this.api
      .post<OverrideWriteResponse>(`/config/overrides/pending/${id}/cancel`, { reason }, SILENT)
      .pipe(map(overrideResult));
  }

  // ── Kill switches and emergency flatten (engine KillSwitchController, EmergencyFlattenController) ──

  /** `engine.killswitch`. The acting organisation's switch (`haltedBy` also reports the platform's). */
  tenantKillSwitch(): Observable<ScopedKillSwitchStatus> {
    return this.get('/admin/kill-switch/tenant');
  }

  /**
   * Engage (`engine.killswitch`) or release (`engine.killswitch.release`: step-up, and a second
   * person where two-person rules apply — HTTP 202) the organisation's switch. A reason is required.
   */
  setTenantKillSwitch(enabled: boolean, reason: string): Observable<ScopedKillSwitchStatus> {
    return settled(
      this.api.put<ResponseData<ScopedKillSwitchStatus>>(
        '/admin/kill-switch/tenant',
        { enabled, reason },
        SILENT,
      ),
    );
  }

  /** `engine.killswitch` on the account. Another organisation's account is "not found". */
  accountKillSwitch(tradingAccountId: number): Observable<ScopedKillSwitchStatus> {
    return this.get(`/admin/kill-switch/account/${tradingAccountId}`);
  }

  /** Engage or release one account's switch (release: step-up, two-person). */
  setAccountKillSwitch(
    tradingAccountId: number,
    enabled: boolean,
    reason: string,
  ): Observable<ScopedKillSwitchStatus> {
    return settled(
      this.api.put<ResponseData<ScopedKillSwitchStatus>>(
        `/admin/kill-switch/account/${tradingAccountId}`,
        { enabled, reason },
        SILENT,
      ),
    );
  }

  /**
   * `positions.flatten` organisation-wide: engages the organisation's kill switch, cancels its
   * accounts' pending orders, closes their open positions and pauses its own strategies.
   */
  flattenOrganisation(reason: string): Observable<boolean> {
    return this.post('/admin/emergency-flatten/tenant', { reason });
  }

  /** `positions.flatten` on the account: engages its switch, cancels its orders, closes its positions. */
  flattenAccount(tradingAccountId: number, reason: string): Observable<boolean> {
    return this.post(`/admin/emergency-flatten/account/${tradingAccountId}`, { reason });
  }

  // ── Strategy subscriptions ──

  /** `access.operator`. The organisation's own subscriptions and the rule its accounts receive signals under. */
  strategySubscriptions(): Observable<StrategySubscriptions> {
    return this.get('/strategy/subscriptions');
  }

  /** `strategies.read`. One page of platform or private strategies, by name (filter nested, as the engine requires). */
  strategies(q: {
    ownership: StrategyOwnership;
    search: string;
    status: string | null;
    page: number;
    pageSize: number;
  }): Observable<PagedData<StrategySummary>> {
    return settled(
      this.api.post<ResponseData<PagedData<StrategySummary>>>(
        '/strategy/list',
        {
          currentPage: q.page,
          itemCountPerPage: q.pageSize,
          sortBy: 'name',
          sortDirection: 'asc',
          filter: {
            ownership: q.ownership,
            ...(q.search.trim() ? { search: q.search.trim() } : {}),
            ...(q.status ? { status: q.status } : {}),
          },
        },
        SILENT,
      ),
    );
  }

  /** `access.operator`. The organisation's own subscriptions of one strategy. */
  strategyBindings(strategyId: number): Observable<StrategyBinding[]> {
    return this.get<unknown>(`/strategy/${strategyId}/account-bindings`).pipe(
      map((d) => rows<StrategyBinding>(d)),
    );
  }

  /**
   * `access.operator`. Replaces the organisation's own subscriptions of one strategy (accounts left
   * out are unsubscribed; another organisation's are never touched).
   */
  replaceStrategyBindings(
    strategyId: number,
    bindings: StrategyBindingInput[],
  ): Observable<boolean> {
    return settled(
      this.api.put<ResponseData<boolean>>(
        `/strategy/${strategyId}/account-bindings`,
        bindings,
        SILENT,
      ),
    );
  }

  // ── Alert channels (engine AlertChannelsController; alerts.manage, changes step-up) ──

  /** The organisation's e-mail, webhook and Telegram channels (secrets as "set" flags only). */
  alertChannels(): Observable<AlertChannelSettings[]> {
    return this.get<unknown>('/alerts/channels').pipe(map((d) => rows<AlertChannelSettings>(d)));
  }

  /** Sets up or changes one channel. A new webhook without a secret gets one generated (shown once). */
  saveAlertChannel(
    channel: AlertChannelName,
    body: SaveAlertChannelBody,
  ): Observable<AlertChannelSaveResult> {
    return settled(
      this.api.put<ResponseData<AlertChannelSaveResult>>(
        `/alerts/channels/${channel.toLowerCase()}`,
        body,
        SILENT,
      ),
    );
  }

  /** Removes one channel (House falls back to its platform channel; others get nothing on it). */
  removeAlertChannel(channel: AlertChannelName): Observable<boolean> {
    return this.del(`/alerts/channels/${channel.toLowerCase()}`);
  }

  /** Sends a test alert through the channel (at most one per channel every 10 seconds). */
  testAlertChannel(
    channel: AlertChannelName,
    message: string | null,
  ): Observable<AlertChannelTestResult> {
    return this.post(`/alerts/channels/${channel.toLowerCase()}/test`, {
      message: message || null,
    });
  }

  /** A new webhook signing secret (shown once); the old one stops at once, the deprecated header too. */
  rotateWebhookSecret(): Observable<AlertChannelSaveResult> {
    return this.post('/alerts/channels/webhook/rotate-secret');
  }

  // ── LLM usage and the organisation's own key (engine r6-llm; llm.usage.read / llm.keys.manage) ──

  /** This month so far: calls, tokens, cost, the budget and the provider of each tier. */
  llmUsage(): Observable<LlmUsageReport> {
    return this.get('/llm/usage');
  }

  /** The organisation's stored provider keys (provider and hint only). */
  tenantLlmKeys(): Observable<TenantLlmKey[]> {
    return this.get<unknown>('/llm/tenant-key').pipe(map((d) => rows<TenantLlmKey>(d)));
  }

  /** Stores or replaces the key for one provider (step-up). Write-only: never read back. */
  storeTenantLlmKey(provider: string, apiKey: string): Observable<TenantLlmKey> {
    return settled(
      this.api.put<ResponseData<TenantLlmKey>>('/llm/tenant-key', { provider, apiKey }, SILENT),
    );
  }

  /** Removes the key for one provider; calls that need it are refused from then on. */
  removeTenantLlmKey(provider: string): Observable<boolean> {
    return this.del(`/llm/tenant-key/${encodeURIComponent(provider)}`);
  }
}
