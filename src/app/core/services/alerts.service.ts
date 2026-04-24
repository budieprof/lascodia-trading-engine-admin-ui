import { Injectable, inject } from '@angular/core';
import { Observable, catchError, of } from 'rxjs';
import { HttpErrorResponse } from '@angular/common/http';
import { ApiService } from '@core/api/api.service';
import {
  ResponseData,
  PagedData,
  PagerRequest,
  AlertDto,
  CreateAlertRequest,
  UpdateAlertRequest,
} from '@core/api/api.types';

// The engine doesn't yet expose a generic `/alert` controller — only the
// drift-report endpoint returns alerts, scoped to ML degradation. Until a
// real alert surface lands, list() degrades to an empty page on 404 so
// alert-triage + dashboard widgets render gracefully.
const EMPTY_ALERT_PAGE = {
  status: true,
  data: {
    data: [],
    pager: {
      totalItemCount: 0,
      filter: null,
      currentPage: 1,
      itemCountPerPage: 0,
      pageNo: 0,
      pageSize: 0,
    },
  },
  message: 'No alerts surface configured',
  responseCode: '00',
} as unknown as ResponseData<PagedData<AlertDto>>;

@Injectable({ providedIn: 'root' })
export class AlertsService {
  private readonly api = inject(ApiService);

  getById(id: number): Observable<ResponseData<AlertDto>> {
    return this.api.get(`/alert/${id}`);
  }

  list(params: PagerRequest): Observable<ResponseData<PagedData<AlertDto>>> {
    return this.api.post<ResponseData<PagedData<AlertDto>>>(`/alert/list`, params).pipe(
      catchError((err: HttpErrorResponse) => {
        if (err.status === 404) return of(EMPTY_ALERT_PAGE);
        throw err;
      }),
    );
  }

  create(data: CreateAlertRequest): Observable<ResponseData<AlertDto>> {
    return this.api.post(`/alert`, data);
  }

  update(id: number, data: UpdateAlertRequest): Observable<ResponseData<AlertDto>> {
    return this.api.put(`/alert/${id}`, data);
  }

  delete(id: number): Observable<ResponseData<void>> {
    return this.api.delete(`/alert/${id}`);
  }
}
