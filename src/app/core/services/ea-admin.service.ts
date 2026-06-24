import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import type {
  AdminCommandQueueResult,
  AdminFleetCommandResult,
  ClearSafetyStopRequest,
  EAAuditTimelineItem,
  EAAuditTimelineQuery,
  EAFillModeConfig,
  EAFleetItem,
  EAInstanceDetail,
  EALogTimelineItem,
  EALogTimelineQuery,
  FleetClearSafetyStopRequest,
  FleetFlattenRequest,
  FleetKillSwitchRequest,
  FleetReleaseKillSwitchRequest,
  FleetResetCircuitBreakerRequest,
  FleetRestartRequest,
  FleetSafetyStopRequest,
  FlattenInstanceRequest,
  FlushRetryQueueRequest,
  ForceSafetyStopRequest,
  PurgeRetryQueueRequest,
  ReleaseKillSwitchRequest,
  ResetCircuitBreakerRequest,
  ResponseData,
  TriggerKillSwitchRequest,
  UpdateEAFillModeRequest,
  UpdateInstanceConfigRequest,
} from '@core/api/api.types';

/**
 * EA admin-management API client.  Covers the engine's `/admin/ea/...` surface
 * — fleet read, per-instance detail (with rich state envelope), per-instance
 * audit timeline, the 9 per-instance operator commands, and the 6 fleet bulk
 * commands.  Every endpoint requires the Operator policy on the engine; the
 * admin UI's authenticated session is assumed to satisfy it.
 *
 * Returns raw `Observable<ResponseData<T>>` to match the EAInstancesService
 * pattern — page components convert to signals via createPolledResource() or
 * subscribe directly for fire-and-forget commands.
 */
@Injectable({ providedIn: 'root' })
export class EAAdminService {
  private readonly api = inject(ApiService);
  private readonly base = '/admin/ea';

  // ── Queries ────────────────────────────────────────────────────────────────

  /** GET /admin/ea — every registered EA instance (incl. Disconnected / ShuttingDown). */
  listFleet(): Observable<ResponseData<EAFleetItem[]>> {
    return this.api.get<ResponseData<EAFleetItem[]>>(this.base);
  }

  /** GET /admin/ea/{instanceId} — rich detail incl. state envelope. */
  getDetail(instanceId: string): Observable<ResponseData<EAInstanceDetail>> {
    return this.api.get<ResponseData<EAInstanceDetail>>(
      `${this.base}/${encodeURIComponent(instanceId)}`,
    );
  }

  /**
   * GET /admin/ea/{instanceId}/audit — safety-audit timeline, newest first.
   * Defaults to 200 rows; admin UI can page by passing a later `to` based on
   * the oldest returned `occurredAt`.
   */
  getAuditTimeline(
    instanceId: string,
    query?: EAAuditTimelineQuery,
  ): Observable<ResponseData<EAAuditTimelineItem[]>> {
    const params: string[] = [];
    if (query?.from) params.push(`from=${encodeURIComponent(query.from)}`);
    if (query?.to) params.push(`to=${encodeURIComponent(query.to)}`);
    if (query?.eventType) params.push(`eventType=${encodeURIComponent(query.eventType)}`);
    if (typeof query?.take === 'number') params.push(`take=${query.take}`);
    const qs = params.length ? `?${params.join('&')}` : '';
    return this.api.get<ResponseData<EAAuditTimelineItem[]>>(
      `${this.base}/${encodeURIComponent(instanceId)}/audit${qs}`,
    );
  }

  /** Phase-9: paged WARN/ERROR log tail from the EA. */
  getLogTimeline(
    instanceId: string,
    query?: EALogTimelineQuery,
  ): Observable<ResponseData<EALogTimelineItem[]>> {
    const params: string[] = [];
    if (query?.from) params.push(`from=${encodeURIComponent(query.from)}`);
    if (query?.to) params.push(`to=${encodeURIComponent(query.to)}`);
    if (query?.level) params.push(`level=${encodeURIComponent(query.level)}`);
    if (query?.component) params.push(`component=${encodeURIComponent(query.component)}`);
    if (query?.search) params.push(`search=${encodeURIComponent(query.search)}`);
    if (typeof query?.take === 'number') params.push(`take=${query.take}`);
    const qs = params.length ? `?${params.join('&')}` : '';
    return this.api.get<ResponseData<EALogTimelineItem[]>>(
      `${this.base}/${encodeURIComponent(instanceId)}/logs${qs}`,
    );
  }

  // ── Per-instance commands ──────────────────────────────────────────────────
  //
  // Engine-side every per-instance command DTO is declared with
  // `public required string InstanceId { get; set; }` so that the
  // FluentValidation pipeline can assert NotEmpty() upstream of the handler.
  // The controller's `command.InstanceId = instanceId;` runs *after* model
  // binding, but System.Text.Json enforces `required` *during* deserialisation
  // — so a body without `instanceId` fails with HTTP 400 "missing required
  // properties including: 'instanceId'" before the route assignment can fire.
  // We echo the route id into the body in this single helper so every
  // per-instance endpoint stays compatible without each callsite having to
  // remember.
  private withInstanceId<T extends object>(
    instanceId: string,
    body: T,
  ): T & { instanceId: string } {
    return { ...body, instanceId };
  }

  forceSafetyStop(
    instanceId: string,
    body: ForceSafetyStopRequest,
  ): Observable<ResponseData<AdminCommandQueueResult>> {
    return this.api.post<ResponseData<AdminCommandQueueResult>>(
      `${this.base}/${encodeURIComponent(instanceId)}/safety-stop`,
      this.withInstanceId(instanceId, body),
    );
  }

  clearSafetyStop(
    instanceId: string,
    body: ClearSafetyStopRequest,
  ): Observable<ResponseData<AdminCommandQueueResult>> {
    return this.api.post<ResponseData<AdminCommandQueueResult>>(
      `${this.base}/${encodeURIComponent(instanceId)}/clear-safety-stop`,
      this.withInstanceId(instanceId, body),
    );
  }

  triggerKillSwitch(
    instanceId: string,
    body: TriggerKillSwitchRequest,
  ): Observable<ResponseData<AdminCommandQueueResult>> {
    return this.api.post<ResponseData<AdminCommandQueueResult>>(
      `${this.base}/${encodeURIComponent(instanceId)}/kill-switch`,
      this.withInstanceId(instanceId, body),
    );
  }

  releaseKillSwitch(
    instanceId: string,
    body: ReleaseKillSwitchRequest,
  ): Observable<ResponseData<AdminCommandQueueResult>> {
    return this.api.post<ResponseData<AdminCommandQueueResult>>(
      `${this.base}/${encodeURIComponent(instanceId)}/release-kill-switch`,
      this.withInstanceId(instanceId, body),
    );
  }

  flatten(
    instanceId: string,
    body: FlattenInstanceRequest,
  ): Observable<ResponseData<AdminCommandQueueResult>> {
    return this.api.post<ResponseData<AdminCommandQueueResult>>(
      `${this.base}/${encodeURIComponent(instanceId)}/flatten`,
      this.withInstanceId(instanceId, body),
    );
  }

  /** Phase-10: in-place restart via ChartApplyTemplate.  Same { reason? } shape as flatten. */
  restart(
    instanceId: string,
    body: { reason?: string | null } = {},
  ): Observable<ResponseData<AdminCommandQueueResult>> {
    return this.api.post<ResponseData<AdminCommandQueueResult>>(
      `${this.base}/${encodeURIComponent(instanceId)}/restart`,
      this.withInstanceId(instanceId, body),
    );
  }

  /** Phase-11: spawn a sibling EA instance on the same MT5 terminal (one broker account). */
  spawn(
    instanceId: string,
    body: { symbol: string; timeframe?: string | null; reason?: string | null },
  ): Observable<ResponseData<AdminCommandQueueResult>> {
    return this.api.post<ResponseData<AdminCommandQueueResult>>(
      `${this.base}/${encodeURIComponent(instanceId)}/spawn`,
      this.withInstanceId(instanceId, body),
    );
  }

  /** Phase-14: graceful targeted shutdown — EA closes its own chart, OnDeinit runs the normal teardown. */
  shutdown(
    instanceId: string,
    body: { reason?: string | null } = {},
  ): Observable<ResponseData<AdminCommandQueueResult>> {
    return this.api.post<ResponseData<AdminCommandQueueResult>>(
      `${this.base}/${encodeURIComponent(instanceId)}/shutdown`,
      this.withInstanceId(instanceId, body),
    );
  }

  resetCircuitBreaker(
    instanceId: string,
    body: ResetCircuitBreakerRequest,
  ): Observable<ResponseData<AdminCommandQueueResult>> {
    return this.api.post<ResponseData<AdminCommandQueueResult>>(
      `${this.base}/${encodeURIComponent(instanceId)}/circuit-breaker/reset`,
      this.withInstanceId(instanceId, body),
    );
  }

  flushRetryQueue(
    instanceId: string,
    body: FlushRetryQueueRequest,
  ): Observable<ResponseData<AdminCommandQueueResult>> {
    return this.api.post<ResponseData<AdminCommandQueueResult>>(
      `${this.base}/${encodeURIComponent(instanceId)}/retry-queue/flush`,
      this.withInstanceId(instanceId, body),
    );
  }

  purgeRetryQueue(
    instanceId: string,
    body: PurgeRetryQueueRequest,
  ): Observable<ResponseData<AdminCommandQueueResult>> {
    return this.api.post<ResponseData<AdminCommandQueueResult>>(
      `${this.base}/${encodeURIComponent(instanceId)}/retry-queue/purge`,
      this.withInstanceId(instanceId, body),
    );
  }

  updateInstanceConfig(
    instanceId: string,
    body: UpdateInstanceConfigRequest,
  ): Observable<ResponseData<string>> {
    return this.api.post<ResponseData<string>>(
      `${this.base}/${encodeURIComponent(instanceId)}/config`,
      this.withInstanceId(instanceId, body),
    );
  }

  /**
   * GET /admin/ea/{instanceId}/fill-mode — current per-EA fill mode and the
   * compile-time default. Drives the toggle on the EA detail page.
   */
  getFillMode(instanceId: string): Observable<ResponseData<EAFillModeConfig>> {
    return this.api.get<ResponseData<EAFillModeConfig>>(
      `${this.base}/${encodeURIComponent(instanceId)}/fill-mode`,
    );
  }

  /**
   * PUT /admin/ea/{instanceId}/fill-mode — writes one EngineConfig row
   * (`EA:FillMode:{InstanceId}`). Hot-reloads through EngineConfigCache;
   * takes effect on the EA's next signal poll without a restart.
   */
  updateFillMode(
    instanceId: string,
    body: UpdateEAFillModeRequest,
  ): Observable<ResponseData<number>> {
    return this.api.put<ResponseData<number>>(
      `${this.base}/${encodeURIComponent(instanceId)}/fill-mode`,
      this.withInstanceId(instanceId, body),
    );
  }

  // ── Fleet bulk commands ────────────────────────────────────────────────────

  fleetSafetyStop(body: FleetSafetyStopRequest): Observable<ResponseData<AdminFleetCommandResult>> {
    return this.api.post<ResponseData<AdminFleetCommandResult>>(
      `${this.base}/all/safety-stop`,
      body,
    );
  }

  fleetClearSafetyStop(
    body: FleetClearSafetyStopRequest,
  ): Observable<ResponseData<AdminFleetCommandResult>> {
    return this.api.post<ResponseData<AdminFleetCommandResult>>(
      `${this.base}/all/clear-safety-stop`,
      body,
    );
  }

  fleetKillSwitch(body: FleetKillSwitchRequest): Observable<ResponseData<AdminFleetCommandResult>> {
    return this.api.post<ResponseData<AdminFleetCommandResult>>(
      `${this.base}/all/kill-switch`,
      body,
    );
  }

  fleetReleaseKillSwitch(
    body: FleetReleaseKillSwitchRequest,
  ): Observable<ResponseData<AdminFleetCommandResult>> {
    return this.api.post<ResponseData<AdminFleetCommandResult>>(
      `${this.base}/all/release-kill-switch`,
      body,
    );
  }

  fleetFlatten(body: FleetFlattenRequest): Observable<ResponseData<AdminFleetCommandResult>> {
    return this.api.post<ResponseData<AdminFleetCommandResult>>(`${this.base}/all/flatten`, body);
  }

  fleetResetCircuitBreaker(
    body: FleetResetCircuitBreakerRequest,
  ): Observable<ResponseData<AdminFleetCommandResult>> {
    return this.api.post<ResponseData<AdminFleetCommandResult>>(
      `${this.base}/all/circuit-breaker/reset`,
      body,
    );
  }

  fleetRestart(body: FleetRestartRequest): Observable<ResponseData<AdminFleetCommandResult>> {
    return this.api.post<ResponseData<AdminFleetCommandResult>>(`${this.base}/all/restart`, body);
  }
}
