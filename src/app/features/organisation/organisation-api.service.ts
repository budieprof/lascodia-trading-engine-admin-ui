import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';

import { ApiService } from '@core/api/api.service';
import { ApiError, type ResponseData } from '@core/api/api.types';
import { queryString, rows } from '@features/iam/iam-api.service';
import type {
  CreateEnrollmentTokenBody,
  EnrollmentToken,
  EnrollmentTokenCreated,
  MachineCredential,
} from './organisation.types';

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
}
