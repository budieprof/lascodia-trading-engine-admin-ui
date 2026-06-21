import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import { ResponseData, TradingWindowConfig } from '@core/api/api.types';

/**
 * Fleet-level admin operations for the EA Instances cockpit. Separate from
 * EAAdminService (per-EA commands) — these endpoints sit on
 * `/api/v1/lascodia-trading-engine/ea-fleet/*` and configure fleet-wide
 * policy rather than addressing a specific EA.
 */
@Injectable({ providedIn: 'root' })
export class EAFleetService {
  private readonly api = inject(ApiService);

  getTradingWindow(): Observable<ResponseData<TradingWindowConfig>> {
    return this.api.get<ResponseData<TradingWindowConfig>>(`/ea-fleet/trading-window`);
  }

  updateTradingWindow(config: TradingWindowConfig): Observable<ResponseData<TradingWindowConfig>> {
    return this.api.put<ResponseData<TradingWindowConfig>>(`/ea-fleet/trading-window`, config);
  }
}
