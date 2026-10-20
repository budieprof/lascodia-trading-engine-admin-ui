import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';

import { ApiService } from '@core/api/api.service';
import { ApiError, type ResponseData } from '@core/api/api.types';
import { queryString, rows } from '@features/iam/iam-api.service';
import type {
  ConfigOverrides,
  CreateEnrollmentTokenBody,
  EffectiveConfig,
  EnrollmentToken,
  EnrollmentTokenCreated,
  MachineCredential,
  OverrideScopeType,
  OverrideWriteResult,
  ScopedKillSwitchStatus,
  SetConfigOverrideBody,
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
}
