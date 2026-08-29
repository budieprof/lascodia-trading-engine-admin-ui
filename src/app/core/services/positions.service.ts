import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import {
  ResponseData,
  PagedData,
  PagerRequest,
  PositionDto,
  PositionLifecycleEventDto,
} from '@core/api/api.types';

/**
 * Execution-latency timestamps for a position, from `GET /position/{id}/timing`.
 * Any field is null when the Position → Order → TradeSignal link is missing.
 */
export interface PositionTimingDto {
  positionId: number;
  signalTriggeredAt: string | null;
  signalGeneratedAt: string | null;
  orderPlacedAt: string | null;
  orderFilledAt: string | null;
  openedAt: string | null;
}

/** One open position sitting across an upcoming release. */
export interface ExposedPositionDto {
  positionId: number;
  symbol: string;
  direction: string;
  lots: number;
  unrealizedPnL: number;
  openedAtUtc: string;
  ageMinutes: number;
  tradingAccountId: number;
  /** False when the position carries no stop — the case worth looking at first. */
  hasStopLoss: boolean;
  stopLoss: number | null;
  takeProfit: number | null;
}

/** An upcoming release and the open exposure sitting across it. */
export interface ExposedEventDto {
  eventId: number;
  title: string;
  currency: string;
  impact: string;
  scheduledAtUtc: string;
  minutesUntil: number;
  forecast: string | null;
  previous: string | null;
  /** False when no consensus is published — the release cannot be read in surprise terms at all. */
  hasConsensus: boolean;
  positionCount: number;
  totalLots: number;
  totalUnrealizedPnL: number;
  unprotectedPositionCount: number;
  positions: ExposedPositionDto[];
}

/** Event-exposure snapshot across the open book, from `GET /position/event-exposure`. */
export interface EventExposureDto {
  generatedAtUtc: string;
  lookaheadHours: number;
  openPositionCount: number;
  /** Distinct positions exposed to at least one release; a position may appear under several. */
  exposedPositionCount: number;
  exposedLots: number;
  exposedUnrealizedPnL: number;
  events: ExposedEventDto[];
  /** What the measurement does and does not establish. Render it with the numbers. */
  basis: string;
}

@Injectable({ providedIn: 'root' })
export class PositionsService {
  private readonly api = inject(ApiService);

  getById(id: number): Observable<ResponseData<PositionDto>> {
    return this.api.get(`/position/${id}`);
  }

  /**
   * Open positions about to straddle a high-impact economic release, grouped by event.
   *
   * Reporting only. The engine returns a `basis` string describing exactly what the
   * measurement does and does not establish; render it alongside the numbers rather
   * than presenting the exposure as a call to close.
   */
  getEventExposure(
    lookaheadHours = 24,
    includeMediumImpact = false,
  ): Observable<ResponseData<EventExposureDto>> {
    return this.api.get(
      `/position/event-exposure?lookaheadHours=${lookaheadHours}` +
        `&includeMediumImpact=${includeMediumImpact}`,
    );
  }

  /**
   * Execution-latency timestamps for a position (signal fired vs. order placed),
   * resolved server-side via Position → Order → TradeSignal.
   */
  getTiming(id: number): Observable<ResponseData<PositionTimingDto>> {
    return this.api.get(`/position/${id}/timing`);
  }

  list(params: PagerRequest): Observable<ResponseData<PagedData<PositionDto>>> {
    return this.api.post(`/position/list`, params);
  }

  /**
   * Manually close (or partially close) an open position. The engine
   * updates the position record AND queues an EA command for MT5 to
   * flatten the trade. `closeLots` is optional — when omitted the engine
   * defaults to closing all open lots.
   */
  close(id: number, closePrice: number, closeLots?: number): Observable<ResponseData<string>> {
    return this.api.post(`/position/${id}/close`, {
      id,
      closePrice,
      closeLots: closeLots ?? null,
    });
  }

  /**
   * Modify SL and/or TP on an open position. At least one of `stopLoss`,
   * `takeProfit` must be a number; pass `null` to leave a level unchanged.
   * The engine updates the position row and queues a ModifySLTP EACommand
   * so MT5 applies the new levels broker-side. Operator entry point: drag
   * the SL/TP horizontal line on the trading chart.
   */
  modifySlTp(
    id: number,
    stopLoss: number | null,
    takeProfit: number | null,
  ): Observable<ResponseData<string>> {
    return this.api.post(`/position/${id}/modify-sl-tp`, {
      stopLoss,
      takeProfit,
    });
  }

  /**
   * GET /position/{id}/lifecycle — chronological lifecycle / delta timeline.
   * Returns an empty list until the writer-side wiring lands across the
   * position-management command handlers (see engine commit 3fb257d).
   */
  getLifecycle(id: number, limit?: number): Observable<ResponseData<PositionLifecycleEventDto[]>> {
    const qs = limit !== undefined ? `?limit=${limit}` : '';
    return this.api.get(`/position/${id}/lifecycle${qs}`);
  }

  /**
   * POST /position/lifecycle/list — fleet-wide position-delta feed
   * (PRD-V2 FR-5.8). The filter shape on the engine accepts substring
   * matches on eventType / source via ILIKE, so a `source: 'PositionWorker'`
   * filter catches all the colon-suffixed close-reason variants
   * ("PositionWorker:StopLoss", "PositionWorker:TakeProfit", etc.).
   */
  listLifecycleEvents(
    params: PagerRequest & {
      filter?: {
        positionId?: number | null;
        eventType?: string | null;
        source?: string | null;
        from?: string | null;
        to?: string | null;
      };
    },
  ): Observable<ResponseData<PagedData<PositionLifecycleEventDto>>> {
    return this.api.post(`/position/lifecycle/list`, params);
  }
}
