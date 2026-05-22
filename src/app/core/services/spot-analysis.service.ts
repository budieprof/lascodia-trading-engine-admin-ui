import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import {
  ResponseData,
  PagerRequest,
  SpotAnalysisReportDto,
  SpotAnalysisDetailDto,
} from '@core/api/api.types';

/**
 * Data access for the Spot Analysis Report — the paged ledger of every
 * `market_analysis.spot` run with its attributed trade outcomes, returned
 * alongside a window-wide KPI summary and per-analysis P&L time series.
 */
@Injectable({ providedIn: 'root' })
export class SpotAnalysisService {
  private readonly api = inject(ApiService);

  /**
   * Paged Spot Analysis Report. `params.filter` accepts
   * `{ symbol?, timeframe?, outcome?, from?, to? }` — all optional.
   * Returns one page of rows AND the window-wide KPI summary + time series.
   */
  list(params: PagerRequest): Observable<ResponseData<SpotAnalysisReportDto>> {
    return this.api.post(`/market-data/spot-analyses/list`, params);
  }

  /**
   * Full detail of one analysis — replayed prose brief, structured
   * recommendations, linked signals/positions, and the exit-instruction
   * history. Drives the report drawer drill-down.
   */
  getDetail(id: number): Observable<ResponseData<SpotAnalysisDetailDto>> {
    return this.api.get(`/market-data/spot-analyses/${id}`);
  }
}
