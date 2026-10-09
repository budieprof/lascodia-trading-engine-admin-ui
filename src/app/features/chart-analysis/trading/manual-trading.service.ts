import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';

import { ApiService } from '@core/api/api.service';
import type { ResponseData } from '@core/api/api.types';

import type {
  ManualTradePreview,
  ManualTradeRequest,
  ManualTradeResult,
} from './manual-trading.types';

/**
 * The engine side of trading from the chart. The ticket only ever previews and submits a manual SIGNAL: the engine
 * judges it again on submission, and a live one then passes Tier 1 and Tier 2 like any signal.
 */
@Injectable({ providedIn: 'root' })
export class ManualTradingService {
  private readonly api = inject(ApiService);

  /** `POST trade-signal/preview` — the dry run. Writes nothing. */
  preview(request: ManualTradeRequest): Observable<ResponseData<ManualTradePreview>> {
    return this.api.post('/trade-signal/preview', request);
  }

  /** `POST trade-signal/manual` — submits the ticket (paper or live); refused with the reason unless it passes. */
  submit(request: ManualTradeRequest): Observable<ResponseData<ManualTradeResult>> {
    return this.api.post('/trade-signal/manual', request);
  }
}
