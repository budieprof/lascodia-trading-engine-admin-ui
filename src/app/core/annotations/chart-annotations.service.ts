import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { ApiService } from '@core/api/api.service';
import type { PagedData, PagerRequest, ResponseData } from '@core/api/api.types';

export interface ChartAnnotationDto {
  id: number;
  target: string;
  symbol: string | null;
  annotatedAt: string;
  body: string;
  createdBy: number;
  createdAt: string;
  updatedAt: string | null;
}

export interface CreateChartAnnotationRequest {
  target: string;
  symbol?: string;
  annotatedAt: string;
  body: string;
}

/**
 * Client for `/chart-annotations` — the engine's operator-authored chart
 * note surface (see `ChartAnnotationController.cs`). Reads are open to
 * Viewer-policy tokens; writes need Trader.
 */
@Injectable({ providedIn: 'root' })
export class ChartAnnotationsService {
  private readonly api = inject(ApiService);

  list(
    target: string,
    params: PagerRequest & { filter?: { symbol?: string; from?: string; to?: string } },
  ): Observable<ResponseData<PagedData<ChartAnnotationDto>>> {
    return this.api.post(`/chart-annotations/list`, {
      ...params,
      filter: { target, ...(params.filter ?? {}) },
    });
  }

  create(req: CreateChartAnnotationRequest): Observable<ResponseData<number>> {
    return this.api.post(`/chart-annotations`, req);
  }

  update(id: number, body: string): Observable<ResponseData<string>> {
    return this.api.put(`/chart-annotations/${id}`, { body });
  }

  remove(id: number): Observable<ResponseData<string>> {
    return this.api.delete(`/chart-annotations/${id}`);
  }
}
