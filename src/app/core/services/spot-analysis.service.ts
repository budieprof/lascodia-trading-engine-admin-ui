import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import { ResponseData, PagerRequest, SpotAnalysisReportDto } from '@core/api/api.types';

/**
 * Data access for the Spot Analysis Report — the paged ledger of every
 * `market_analysis.spot` run with its attributed trade outcomes, returned
 * alongside a window-wide KPI summary.
 */
@Injectable({ providedIn: 'root' })
export class SpotAnalysisService {
  private readonly api = inject(ApiService);

  /**
   * Paged Spot Analysis Report. `params.filter` accepts
   * `{ symbol?, timeframe?, outcome?, from?, to? }` — all optional.
   * Returns one page of rows AND the window-wide KPI summary (aggregated
   * across the FULL filtered set, not just the current page).
   */
  list(params: PagerRequest): Observable<ResponseData<SpotAnalysisReportDto>> {
    return this.api.post(`/market-data/spot-analyses/list`, params);
  }
}
