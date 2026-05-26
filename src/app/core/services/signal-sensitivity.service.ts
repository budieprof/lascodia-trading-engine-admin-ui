import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import {
  ResponseData,
  AnalyzeSignalSensitivityRequest,
  AnalyzeSignalSensitivityResultDto,
} from '@core/api/api.types';

/**
 * Data access for the Signal Sensitivity Analysis page. Single-method API:
 * POST a filter + multiplier spec, get back the aggregate KPIs, TP-sweep
 * rows, and per-signal detail.
 */
@Injectable({ providedIn: 'root' })
export class SignalSensitivityService {
  private readonly api = inject(ApiService);

  analyze(
    request: AnalyzeSignalSensitivityRequest,
  ): Observable<ResponseData<AnalyzeSignalSensitivityResultDto>> {
    return this.api.post('/trade-signal/sensitivity-analysis', request);
  }
}
