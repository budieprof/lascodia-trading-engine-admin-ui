import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import { ResponseData, PagedData, PagerRequest, DecisionLogDto } from '@core/api/api.types';

@Injectable({ providedIn: 'root' })
export class AuditTrailService {
  private readonly api = inject(ApiService);

  create(data: any): Observable<ResponseData<DecisionLogDto>> {
    // Engine-side validator rejects empty/null Reason with HTTP 400
    // (LogDecisionCommandValidator: "Reason cannot be empty"). Several
    // callers surface the reason as an OPTIONAL field, so we default an
    // empty/missing reason to a sentinel here rather than forcing every
    // call site to think about it. Anything truthy passes through
    // unchanged.
    const reason =
      typeof data?.reason === 'string' && data.reason.trim().length > 0
        ? data.reason
        : 'No reason provided';
    return this.api.post(`/audit-trail`, { ...data, reason });
  }

  list(params: PagerRequest): Observable<ResponseData<PagedData<DecisionLogDto>>> {
    return this.api.post(`/audit-trail/list`, params);
  }
}
