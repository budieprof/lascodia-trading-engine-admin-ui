import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import { ResponseData, PagedData, PagerRequest, ExecutionQualityLogDto } from '@core/api/api.types';

@Injectable({ providedIn: 'root' })
export class ExecutionQualityService {
  private readonly api = inject(ApiService);

  create(data: any): Observable<ResponseData<ExecutionQualityLogDto>> {
    return this.api.post(`/execution-quality`, data);
  }

  getById(id: number): Observable<ResponseData<ExecutionQualityLogDto>> {
    return this.api.get(`/execution-quality/${id}`);
  }

  list(params: PagerRequest): Observable<ResponseData<PagedData<ExecutionQualityLogDto>>> {
    return this.api.post(`/execution-quality/list`, params);
  }
}
