import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import {
  ResponseData,
  PagedData,
  PagerRequest,
  SpotAnalysisListItemDto,
} from '@core/api/api.types';

/**
 * Data access for the Spot Analysis Report — the paged ledger of every
 * `market_analysis.spot` run with its attributed trade outcomes.
 */
@Injectable({ providedIn: 'root' })
export class SpotAnalysisService {
  private readonly api = inject(ApiService);

  /**
   * Paged Spot Analysis Report. `filter` accepts
   * `{ symbol?, timeframe?, outcome?, from?, to? }` — all optional.
   */
  list(params: PagerRequest): Observable<ResponseData<PagedData<SpotAnalysisListItemDto>>> {
    return this.api.post(`/market-data/spot-analyses/list`, params);
  }
}
