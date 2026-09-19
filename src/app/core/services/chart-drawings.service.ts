import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import type { ResponseData } from '@core/api/api.types';

/** One drawing as the engine stores it. */
export interface ChartDrawingDto {
  id: number;
  clientId: string;
  symbol: string;
  resolution: string;
  kind: string;
  pointsJson: string;
  styleJson: string;
  locked: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ChartDrawingInput {
  clientId: string;
  kind: string;
  pointsJson: string;
  styleJson: string;
  locked: boolean;
  createdAt: string;
}

/**
 * Client for `/chart-drawings` — durable, cross-device storage for chart
 * drawings.
 *
 * The write side is a whole-scope REPLACE rather than per-drawing CRUD. The
 * browser already holds every drawing for the chart it is showing, and one
 * drag produces a change per animation frame; sending the set makes the request
 * idempotent and self-correcting, where a stream of individual writes can
 * arrive out of order and a dropped delete leaves a drawing the operator
 * removed.
 */
@Injectable({ providedIn: 'root' })
export class ChartDrawingsService {
  private readonly api = inject(ApiService);

  list(symbol: string, resolution: string): Observable<ResponseData<ChartDrawingDto[]>> {
    return this.api.post(`/chart-drawings/list`, { symbol, resolution });
  }

  replaceScope(
    symbol: string,
    resolution: string,
    drawings: ChartDrawingInput[],
  ): Observable<ResponseData<number>> {
    return this.api.put(`/chart-drawings/scope`, { symbol, resolution, drawings });
  }
}
