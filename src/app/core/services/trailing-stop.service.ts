import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import { ResponseData, ScalePositionRequest, UpdateTrailingStopRequest } from '@core/api/api.types';

@Injectable({ providedIn: 'root' })
export class TrailingStopService {
  private readonly api = inject(ApiService);

  update(positionId: number, data: UpdateTrailingStopRequest): Observable<ResponseData<void>> {
    return this.api.put(`/trailing-stop/${positionId}`, data);
  }

  scale(data: ScalePositionRequest): Observable<ResponseData<void>> {
    return this.api.post(`/trailing-stop/scale`, data);
  }
}
