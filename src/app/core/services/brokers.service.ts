import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
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

@Injectable({ providedIn: 'root' })
export class BrokersService {
  private readonly api = inject(ApiService);

  getById(id: number): Observable<ResponseData<BrokerDto>> {
    return this.api.get(`/broker/${id}`);
  }

  list(params: PagerRequest): Observable<ResponseData<PagedData<BrokerDto>>> {
    return this.api.post(`/broker/list`, params);
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
