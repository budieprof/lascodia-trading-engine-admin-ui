import { HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, catchError, map, of, throwError } from 'rxjs';

import { ApiService } from '@core/api/api.service';
import type { ResponseData } from '@core/api/api.types';
import { settled } from '@features/organisation/lifecycle/lifecycle-api.service';
import type {
  PublicSignupAvailability,
  SignupBody,
  SignupResult,
  SignupStatus,
  TenantOnboarding,
  TenantSignup,
} from './onboarding.types';

const SILENT = { silent: true } as const;

/**
 * Self-serve sign-up (public), its approval queue (platform staff, `platform.tenants.manage`) and the
 * onboarding checklist (`tenant.usage.read`) — engine multi-tenancy Phase 7, LC.1. Calls are silent: the
 * pages say what went wrong.
 */
@Injectable({ providedIn: 'root' })
export class OnboardingApiService {
  private readonly api = inject(ApiService);

  /** Whether the public sign-up can be used; null when it is not offered at all (the engine answers 404). */
  signupAvailability(): Observable<PublicSignupAvailability | null> {
    return settled(
      this.api.get<ResponseData<PublicSignupAvailability>>('/onboarding/signup', SILENT),
    ).pipe(
      catchError((e: unknown) =>
        e instanceof HttpErrorResponse && e.status === 404 ? of(null) : throwError(() => e),
      ),
    );
  }

  signUp(body: SignupBody): Observable<SignupResult> {
    return settled(this.api.post<ResponseData<SignupResult>>('/onboarding/signup', body, SILENT));
  }

  // ── Platform staff ──
  signups(status: string | null = null): Observable<TenantSignup[]> {
    const q = status ? `?status=${encodeURIComponent(status)}` : '';
    return settled(
      this.api.get<ResponseData<TenantSignup[]>>(`/platform/signups${q}`, SILENT),
    ).pipe(map((rows) => rows ?? []));
  }
  signupStatus(): Observable<SignupStatus> {
    return settled(this.api.get<ResponseData<SignupStatus>>('/platform/signups/status', SILENT));
  }
  approve(id: number, note: string | null): Observable<TenantSignup> {
    return settled(
      this.api.post<ResponseData<TenantSignup>>(
        `/platform/signups/${id}/approve`,
        { note },
        SILENT,
      ),
    );
  }
  reject(id: number, note: string): Observable<TenantSignup> {
    return settled(
      this.api.post<ResponseData<TenantSignup>>(`/platform/signups/${id}/reject`, { note }, SILENT),
    );
  }

  // ── The organisation's checklist ──
  onboarding(): Observable<TenantOnboarding> {
    return settled(this.api.get<ResponseData<TenantOnboarding>>('/tenant/onboarding', SILENT));
  }
}
