import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiCallOptions, ApiService } from '@core/api/api.service';
import { ResponseData, EngineConfigDto, UpsertConfigRequest } from '@core/api/api.types';

@Injectable({ providedIn: 'root' })
export class ConfigService {
  private readonly api = inject(ApiService);

  upsert(data: UpsertConfigRequest): Observable<ResponseData<EngineConfigDto>> {
    return this.api.put(`/config`, data);
  }

  /** One key's live row. `opts.silent` for callers that render their own (or no) failure — the
   *  approval-card preview asks for keys that may legitimately have no row yet. */
  getByKey(key: string, opts?: ApiCallOptions): Observable<ResponseData<EngineConfigDto>> {
    return this.api.get(`/config/${key}`, opts);
  }

  getAll(): Observable<ResponseData<EngineConfigDto[]>> {
    return this.api.get(`/config/all`);
  }
}
