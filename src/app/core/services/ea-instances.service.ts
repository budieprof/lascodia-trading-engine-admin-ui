import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import type {
  EAInstanceDto,
  RefreshSymbolSpecsRequest,
  ResponseData,
  UpdateEAConfigRequest,
} from '@core/api/api.types';

@Injectable({ providedIn: 'root' })
export class EAInstancesService {
  private readonly api = inject(ApiService);

  list(): Observable<ResponseData<EAInstanceDto[]>> {
    return this.api.get<ResponseData<EAInstanceDto[]>>(`/ea/instances`);
  }

  /**
   * PUT /ea/symbol-specs/refresh — queues a RequestBackfill command at the
   * coordinator EA for the supplied trading-account; the EA re-sends symbol
   * specifications for all watched symbols.
   */
  refreshSymbolSpecs(payload: RefreshSymbolSpecsRequest): Observable<ResponseData<string>> {
    return this.api.put<ResponseData<string>>(`/ea/symbol-specs/refresh`, payload);
  }

  /**
   * POST /ea/commands/update-config — hot-reloads EA safety config. The engine
   * accepts a per-instance target or a fleet-wide push when targetInstanceId
   * is null. Zero-valued fields are ignored by the EA (keeps current value).
   */
  updateEAConfig(payload: UpdateEAConfigRequest): Observable<ResponseData<string>> {
    return this.api.post<ResponseData<string>>(`/ea/commands/update-config`, payload);
  }
}
