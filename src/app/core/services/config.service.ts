import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import {
  ResponseData,
  EngineConfigDto,
  UpsertConfigRequest,
} from '@core/api/api.types';

@Injectable({ providedIn: 'root' })
export class ConfigService {
  private readonly api = inject(ApiService);

  upsert(data: UpsertConfigRequest): Observable<ResponseData<EngineConfigDto>> {
    return this.api.put(`/config`, data);
  }

  getByKey(key: string): Observable<ResponseData<EngineConfigDto>> {
    return this.api.get(`/config/${key}`);
  }

  getAll(): Observable<ResponseData<EngineConfigDto[]>> {
    return this.api.get(`/config/all`);
  }
}
