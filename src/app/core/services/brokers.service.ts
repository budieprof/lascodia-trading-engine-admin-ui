import { Injectable, inject } from '@angular/core';
import { Observable, catchError, of } from 'rxjs';
import { HttpErrorResponse } from '@angular/common/http';
import { ApiService } from '@core/api/api.service';
import {
  ResponseData,
  PagedData,
  PagerRequest,
  BrokerDto,
  CreateBrokerRequest,
  UpdateBrokerRequest,
  UpdateBrokerStatusRequest,
} from '@core/api/api.types';

// The engine doesn't ship a Broker resource — "broker" is derived from
// TradingAccount.brokerName today. These calls exist so the UI can drop in a
// real backend later without touching consumers; for now, 404 is expected
// and degrades to an empty list so global-mount components (rate-limit strip)
// don't noise up the console on every route.
const EMPTY_PAGE = {
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
  message: 'No brokers configured',
  responseCode: '00',
} as unknown as ResponseData<PagedData<BrokerDto>>;

@Injectable({ providedIn: 'root' })
export class BrokersService {
  private readonly api = inject(ApiService);

  getById(id: number): Observable<ResponseData<BrokerDto>> {
    return this.api.get(`/broker/${id}`);
  }

  list(params: PagerRequest): Observable<ResponseData<PagedData<BrokerDto>>> {
    return this.api.post<ResponseData<PagedData<BrokerDto>>>(`/broker/list`, params).pipe(
      catchError((err: HttpErrorResponse) => {
        if (err.status === 404) return of(EMPTY_PAGE);
        throw err;
      }),
    );
  }

  create(data: CreateBrokerRequest): Observable<ResponseData<BrokerDto>> {
    return this.api.post(`/broker`, data);
  }

  update(id: number, data: UpdateBrokerRequest): Observable<ResponseData<BrokerDto>> {
    return this.api.put(`/broker/${id}`, data);
  }

  delete(id: number): Observable<ResponseData<void>> {
    return this.api.delete(`/broker/${id}`);
  }

  activate(id: number): Observable<ResponseData<BrokerDto>> {
    return this.api.put(`/broker/${id}/activate`);
  }

  updateStatus(id: number, data: UpdateBrokerStatusRequest): Observable<ResponseData<BrokerDto>> {
    return this.api.put(`/broker/${id}/status`, data);
  }

  switch(): Observable<ResponseData<BrokerDto>> {
    return this.api.put(`/broker/switch`);
  }

  getActive(): Observable<ResponseData<BrokerDto>> {
    return this.api.get(`/broker/active`);
  }

  health(): Observable<ResponseData<BrokerDto>> {
    return this.api.get(`/broker/health`);
  }
}
