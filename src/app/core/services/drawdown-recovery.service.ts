import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import {
  ResponseData,
  DrawdownSnapshotDto,
} from '@core/api/api.types';

@Injectable({ providedIn: 'root' })
export class DrawdownRecoveryService {
  private readonly api = inject(ApiService);

  record(data: any): Observable<ResponseData<DrawdownSnapshotDto>> {
    return this.api.post(`/drawdown-recovery`, data);
  }

  getLatest(): Observable<ResponseData<DrawdownSnapshotDto>> {
    return this.api.get(`/drawdown-recovery/latest`);
  }
}
