import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import { ResponseData, AnalysisMonitorDto } from '@core/api/api.types';
import {
  AnalysisMonitorBoard,
  AnalysisMonitorBoardFilter,
  AnalysisMonitorDetail,
  UpdateAnalysisMonitorRequest,
} from '@features/analysis-monitors/analysis-monitors.types';

/**
 * The analysis-monitor cockpit's API surface.
 *
 * Separate from `MarketDataService` (which keeps the chat strip's narrow
 * anchor-scoped `getAnalysisMonitors` / `cancelAnalysisMonitor`) because this is
 * a different job: fleet-wide visibility and the operator control verbs —
 * pause, resume, extend, edit, force-fire — that did not exist before.
 * All endpoints are Operator-gated.
 */
@Injectable({ providedIn: 'root' })
export class AnalysisMonitorsService {
  private readonly api = inject(ApiService);

  /**
   * GET /market-data/analysis-monitors/board — one round trip returning the
   * filtered page, the fleet roll-up and the recent-activity feed, so the page
   * cannot render three inconsistent views of the same instant.
   */
  getBoard(filter?: AnalysisMonitorBoardFilter): Observable<ResponseData<AnalysisMonitorBoard>> {
    const p = new URLSearchParams();
    if (filter?.statuses?.length) p.set('statuses', filter.statuses.join(','));
    if (filter?.symbol) p.set('symbol', filter.symbol.trim().toUpperCase());
    if (filter?.origin) p.set('origin', filter.origin);
    if (filter?.evaluationMode) p.set('evaluationMode', filter.evaluationMode);
    if (filter?.search) p.set('search', filter.search.trim());
    if (filter?.anchorLlmInvocationId != null)
      p.set('anchorLlmInvocationId', String(filter.anchorLlmInvocationId));
    p.set('activityLimit', String(filter?.activityLimit ?? 40));
    p.set('page', String(filter?.page ?? 1));
    p.set('pageSize', String(filter?.pageSize ?? 50));
    return this.api.get(`/market-data/analysis-monitors/board?${p.toString()}`);
  }

  /**
   * GET /market-data/analysis-monitors/{id} — config, history timeline, filed
   * signals and re-arm lineage for one monitor.
   *
   * `includeHeartbeats` pulls in the routine "checked, condition not met" rows.
   * Off by default because they are numerous; on when the question is
   * specifically "why has this never fired".
   */
  getDetail(
    monitorId: number,
    includeHeartbeats = false,
    timelineLimit = 200,
  ): Observable<ResponseData<AnalysisMonitorDetail>> {
    const p = new URLSearchParams({
      includeHeartbeats: String(includeHeartbeats),
      timelineLimit: String(timelineLimit),
    });
    return this.api.get(`/market-data/analysis-monitors/${monitorId}?${p.toString()}`);
  }

  /** POST .../{id}/pause — silence a live watch without destroying it.
   *  Note the expiry clock keeps running while paused. */
  pause(monitorId: number, reason?: string): Observable<ResponseData<AnalysisMonitorDto>> {
    return this.api.post(`/market-data/analysis-monitors/${monitorId}/pause`, { reason });
  }

  /** POST .../{id}/resume — bring a paused watch back. Rejected if its expiry
   *  has already passed (extend it first). */
  resume(monitorId: number, reason?: string): Observable<ResponseData<AnalysisMonitorDto>> {
    return this.api.post(`/market-data/analysis-monitors/${monitorId}/resume`, { reason });
  }

  /** POST .../{id}/extend — push the hard stop out, bounded by the engine ceiling. */
  extend(
    monitorId: number,
    additionalHours: number,
    reason?: string,
  ): Observable<ResponseData<AnalysisMonitorDto>> {
    return this.api.post(`/market-data/analysis-monitors/${monitorId}/extend`, {
      additionalHours,
      reason,
    });
  }

  /** PATCH .../{id} — edit trigger/action/limits in place, keeping id + history. */
  update(
    monitorId: number,
    body: UpdateAnalysisMonitorRequest,
  ): Observable<ResponseData<AnalysisMonitorDto>> {
    return this.api.patch(`/market-data/analysis-monitors/${monitorId}`, body);
  }

  /**
   * POST .../{id}/fire — ask the worker to fire this monitor next tick,
   * regardless of trigger. Returns once QUEUED, not once the analysis has run:
   * firing stays the worker's job (it holds the concurrency gate and owns
   * TriggerCount), so the outcome lands on the timeline moments later.
   */
  forceFire(monitorId: number, reason?: string): Observable<ResponseData<AnalysisMonitorDto>> {
    return this.api.post(`/market-data/analysis-monitors/${monitorId}/fire`, { reason });
  }

  /** POST .../{id}/cancel — terminal stop, with an optional recorded reason. */
  cancel(monitorId: number, reason?: string): Observable<ResponseData<AnalysisMonitorDto>> {
    return this.api.post(`/market-data/analysis-monitors/${monitorId}/cancel`, { reason });
  }
}
