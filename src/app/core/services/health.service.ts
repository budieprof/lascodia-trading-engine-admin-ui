import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import { ResponseData, HealthStatusDto } from '@core/api/api.types';

@Injectable({ providedIn: 'root' })
export class HealthService {
  private readonly api = inject(ApiService);

  getStatus(): Observable<ResponseData<HealthStatusDto>> {
    return this.api.get(`/health/status`);
  }
}
