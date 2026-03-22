import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import {
  ResponseData,
  PagedData,
  PagerRequest,
  OrderDto,
  CreateOrderRequest,
  UpdateOrderRequest,
  ModifyOrderRequest,
  SubmitOrderResult,
} from '@core/api/api.types';

@Injectable({ providedIn: 'root' })
export class OrdersService {
  private readonly api = inject(ApiService);

  getById(id: number): Observable<ResponseData<OrderDto>> {
    return this.api.get(`/order/${id}`);
  }

  list(params: PagerRequest): Observable<ResponseData<PagedData<OrderDto>>> {
    return this.api.post(`/order/list`, params);
  }

  create(data: CreateOrderRequest): Observable<ResponseData<OrderDto>> {
    return this.api.post(`/order`, data);
  }

  update(id: number, data: UpdateOrderRequest): Observable<ResponseData<OrderDto>> {
    return this.api.put(`/order/${id}`, data);
  }

  submit(id: number): Observable<ResponseData<SubmitOrderResult>> {
    return this.api.post(`/order/${id}/submit`);
  }

  cancel(id: number): Observable<ResponseData<OrderDto>> {
    return this.api.post(`/order/${id}/cancel`);
  }

  modify(id: number, data: ModifyOrderRequest): Observable<ResponseData<OrderDto>> {
    return this.api.put(`/order/${id}/modify`, data);
  }

  delete(id: number): Observable<ResponseData<void>> {
    return this.api.delete(`/order/${id}`);
  }
}
