import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import { ResponseData, HealthStatusDto, WorkerOverrideKnobsDto } from '@core/api/api.types';

@Injectable({ providedIn: 'root' })
export class HealthService {
  private readonly api = inject(ApiService);

  getStatus(): Observable<ResponseData<HealthStatusDto>> {
    return this.api.get(`/health/status`);
  }

  /** GET /health/worker-override-knobs — every BackgroundService's allow-listed override knobs. */
  getWorkerOverrideKnobs(): Observable<ResponseData<WorkerOverrideKnobsDto[]>> {
    return this.api.get(`/health/worker-override-knobs`);
  }
}
