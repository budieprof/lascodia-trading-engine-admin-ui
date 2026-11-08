import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import type { EAInstanceDto, RefreshSymbolSpecsRequest, ResponseData } from '@core/api/api.types';

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
}
