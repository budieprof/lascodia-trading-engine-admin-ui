import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import { ResponseData, AnalysisMonitorDto } from '@core/api/api.types';
import {
  AnalysisMonitorBoard,
  AnalysisMonitorBoardFilter,
  AnalysisMonitorDetail,
  CreateMonitorRequest,
  InstantiateTemplateRequest,
  MonitorInstantiationResult,
  MonitorMetricCatalogue,
  MonitorPreviewRequest,
  MonitorPreviewResult,
  MonitorTemplate,
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

  // ── Authoring ────────────────────────────────────────────────────────────

  /**
   * POST /market-data/analysis-monitors — create a monitor from the cockpit.
   *
   * The anchor is optional here: a monitor created on this page belongs to no
   * conversation and delivers through its own channels instead. Until this
   * existed, monitors could only be born inside an analysis chat.
   */
  create(body: CreateMonitorRequest): Observable<ResponseData<AnalysisMonitorDto>> {
    return this.api.post('/market-data/analysis-monitors', body);
  }

  /**
   * POST .../preview — replay a candidate trigger over stored history.
   *
   * The check that turns an authored spec into something observed. Run it
   * before arming: a zero-fire result on a watch you expected to be busy means
   * the condition cannot work.
   */
  preview(body: MonitorPreviewRequest): Observable<ResponseData<MonitorPreviewResult>> {
    return this.api.post('/market-data/analysis-monitors/preview', body);
  }

  /**
   * GET .../metrics — everything askable about a subject, with live readings,
   * plus the action catalogue and its tiers.
   */
  getMetrics(
    subjectKind: string,
    subjectRef?: string | null,
    timeframe?: string | null,
    includeValues = true,
  ): Observable<ResponseData<MonitorMetricCatalogue>> {
    const p = new URLSearchParams({ subjectKind, includeValues: String(includeValues) });
    if (subjectRef) p.set('subjectRef', subjectRef);
    if (timeframe) p.set('timeframe', timeframe);
    return this.api.get(`/market-data/analysis-monitors/metrics?${p.toString()}`);
  }

  /** POST .../{id}/ack — confirm a fire so it stops escalating. */
  acknowledge(monitorId: number, note?: string): Observable<ResponseData<AnalysisMonitorDto>> {
    return this.api.post(`/market-data/analysis-monitors/${monitorId}/ack`, { reason: note });
  }

  // ── Groups ───────────────────────────────────────────────────────────────

  /**
   * POST .../groups/{groupId}/{action} — pause, resume, cancel or extend every
   * monitor a template fan-out created, as the one thing the operator meant.
   */
  groupAction(
    groupId: string,
    action: 'pause' | 'resume' | 'cancel' | 'extend',
    body?: { reason?: string; extendHours?: number },
  ): Observable<ResponseData<number>> {
    return this.api.post(`/market-data/analysis-monitors/groups/${groupId}/${action}`, body ?? {});
  }

  // ── Templates ────────────────────────────────────────────────────────────

  /** GET /market-data/monitor-templates — the library, built-ins first. */
  getTemplates(subjectKind?: string | null): Observable<ResponseData<MonitorTemplate[]>> {
    const p = new URLSearchParams();
    if (subjectKind) p.set('subjectKind', subjectKind);
    const qs = p.toString();
    return this.api.get(`/market-data/monitor-templates${qs ? `?${qs}` : ''}`);
  }

  /** POST /market-data/monitor-templates — create or update one. Built-ins are read-only. */
  upsertTemplate(
    body: Partial<MonitorTemplate> & { name: string },
  ): Observable<ResponseData<MonitorTemplate>> {
    return this.api.post('/market-data/monitor-templates', body);
  }

  /** DELETE /market-data/monitor-templates/{id}. Built-ins cannot be deleted. */
  deleteTemplate(templateId: number): Observable<ResponseData<boolean>> {
    return this.api.delete(`/market-data/monitor-templates/${templateId}`);
  }

  /**
   * POST /market-data/monitor-templates/{id}/instantiate — one monitor per
   * subject, grouped so they can be managed as a unit.
   *
   * Partial success is normal: six of eight arming is more useful than nothing,
   * and the result names the two that failed.
   */
  instantiateTemplate(
    templateId: number,
    body: InstantiateTemplateRequest,
  ): Observable<ResponseData<MonitorInstantiationResult>> {
    return this.api.post(`/market-data/monitor-templates/${templateId}/instantiate`, body);
  }
}
