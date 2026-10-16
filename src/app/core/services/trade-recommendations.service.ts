import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import type { AnalysisMonitorDto, PagedData, ResponseData } from '@core/api/api.types';
import type {
  TradeRecommendationCardDto,
  TradeRecommendationCardFilter,
  TradeRecommendationDetailDto,
  TradeRecommendationSummaryDto,
} from '@features/trade-recommendations/trade-recommendations.types';

/** Strips empty values so the engine sees only the criteria actually set. */
function compactFilter(f: TradeRecommendationCardFilter): TradeRecommendationCardFilter {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(f)) {
    if (v == null || v === '') continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out as TradeRecommendationCardFilter;
}

/**
 * The recommendations page: every card an analysis wrote, paged, with the detail that follows a
 * card to its analysis, monitors and execution. Wraps `/trade-recommendation/*`.
 */
@Injectable({ providedIn: 'root' })
export class TradeRecommendationsService {
  private readonly api = inject(ApiService);
  private readonly base = '/trade-recommendation';

  /**
   * POST /trade-recommendation/paged. The engine binds the criteria from the nested `filter`
   * only; sent flat it refuses the request (-12) rather than return the whole table.
   */
  paged(req: {
    currentPage: number;
    itemCountPerPage: number;
    sortBy?: string | null;
    sortDirection?: 'asc' | 'desc' | null;
    filter: TradeRecommendationCardFilter;
  }): Observable<ResponseData<PagedData<TradeRecommendationCardDto>>> {
    return this.api.post(`${this.base}/paged`, {
      currentPage: req.currentPage,
      itemCountPerPage: req.itemCountPerPage,
      sortBy: req.sortBy ?? 'Id',
      sortDirection: req.sortDirection ?? 'desc',
      filter: compactFilter(req.filter),
    });
  }

  /** POST /trade-recommendation/summary — facet counts and outcome totals for one filter. */
  summary(
    filter: TradeRecommendationCardFilter,
  ): Observable<ResponseData<TradeRecommendationSummaryDto>> {
    return this.api.post(`${this.base}/summary`, { filter: compactFilter(filter) });
  }

  /** GET /trade-recommendation/{id}/detail — the card and everything attached to it. */
  detail(id: number): Observable<ResponseData<TradeRecommendationDetailDto>> {
    return this.api.get(`${this.base}/${id}/detail`);
  }

  /** POST /trade-recommendation/{id}/file — file the stored card as a signal now, through the gates. */
  file(id: number): Observable<ResponseData<number>> {
    return this.api.post(`${this.base}/${id}/file`, {});
  }

  /** POST /trade-recommendation/{id}/arm-monitor — file it when price comes near its entry. */
  armMonitor(
    id: number,
    body: { mode: 'direct' | 'confirm'; expiresInHours?: number },
  ): Observable<ResponseData<AnalysisMonitorDto>> {
    return this.api.post(`${this.base}/${id}/arm-monitor`, body);
  }
}
