import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import { OperatorRoleDto, ResponseData } from '@core/api/api.types';

/**
 * Thin wrapper over the Admin-only `/admin/operator-roles` endpoints.
 * All methods require an `Admin`-policy JWT server-side — the auth service's
 * nav gating keeps unauthorized users out of the page in the first place.
 */
@Injectable({ providedIn: 'root' })
export class OperatorRolesService {
  private readonly api = inject(ApiService);

  list(tradingAccountId?: number): Observable<ResponseData<OperatorRoleDto[]>> {
    const qs = tradingAccountId != null ? `?tradingAccountId=${tradingAccountId}` : '';
    return this.api.get(`/admin/operator-roles${qs}`);
  }

  grant(tradingAccountId: number, role: string): Observable<ResponseData<string>> {
    return this.api.post(`/admin/operator-roles/grant`, { tradingAccountId, role });
  }

  revoke(tradingAccountId: number, role: string): Observable<ResponseData<string>> {
    return this.api.post(`/admin/operator-roles/revoke`, { tradingAccountId, role });
  }
}
