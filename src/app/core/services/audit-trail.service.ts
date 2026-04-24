import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import { ResponseData, PagedData, PagerRequest, DecisionLogDto } from '@core/api/api.types';

@Injectable({ providedIn: 'root' })
export class AuditTrailService {
  private readonly api = inject(ApiService);

  create(data: any): Observable<ResponseData<DecisionLogDto>> {
    return this.api.post(`/audit-trail`, data);
  }

  list(params: PagerRequest): Observable<ResponseData<PagedData<DecisionLogDto>>> {
    return this.api.post(`/audit-trail/list`, params);
  }
}
