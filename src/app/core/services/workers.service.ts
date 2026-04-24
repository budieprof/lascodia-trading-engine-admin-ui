import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import { ResponseData, WorkerHealthDto } from '@core/api/api.types';

@Injectable({ providedIn: 'root' })
export class WorkersService {
  private readonly api = inject(ApiService);

  /** Returns health snapshots for all background workers (147+). */
  list(): Observable<ResponseData<WorkerHealthDto[]>> {
    return this.api.get<ResponseData<WorkerHealthDto[]>>(`/health/workers`);
  }
}
