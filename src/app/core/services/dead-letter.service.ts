import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import { DeadLetterDto, PagedData, PagerRequest, ResponseData } from '@core/api/api.types';

@Injectable({ providedIn: 'root' })
export class DeadLetterService {
  private readonly api = inject(ApiService);

  list(params: PagerRequest): Observable<ResponseData<PagedData<DeadLetterDto>>> {
    return this.api.post(`/dead-letter/list`, params);
  }

  resolve(id: number): Observable<ResponseData<void>> {
    return this.api.put(`/dead-letter/${id}/resolve`);
  }

  replay(id: number): Observable<ResponseData<void>> {
    return this.api.post(`/dead-letter/${id}/replay`);
  }
}
