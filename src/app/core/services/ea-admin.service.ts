import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import type {
  EaConfigProfile,
  SaveEaConfigProfileRequest,
  CaptureEaConfigProfileRequest,
  ApplyProfileResult,
  AdminCommandQueueResult,
  AdminFleetCommandResult,
  CandleStreamSource,
  SetCandleStreamSourceRequest,
  ClearSafetyStopRequest,
  EAAuditTimelineItem,
  EAAuditTimelineQuery,
  EABreakevenExitConfig,
  EAFillModeConfig,
  EAPendingSignalRevalConfig,
  EASpreadPadConfig,
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
  UpdateEABreakevenExitRequest,
  UpdateEAFillModeRequest,
  UpdateEAPendingSignalRevalRequest,
  UpdateEASpreadPadRequest,
  UpdateInstanceConfigRequest,
} from '@core/api/api.types';
import type {
  EAAutoHealDto,
  EACommandHistoryItem,
  EAHealEventDto,
  EAHealthDto,
  EATerminalDto,
  EATerminalJobResult,
  HostLogKind,
  TerminalJobDto,
} from '@core/api/ea-selfheal.types';

/** Background reads (polls) never raise an error toast — the panels show their own state. */
const SILENT = { silent: true } as const;

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

  // ── Self-heal program (C3 / C7): manage the instance and its terminal ──────

  private path(instanceId: string, rest: string): string {
    return `${this.base}/${encodeURIComponent(instanceId)}/${rest}`;
  }

  /** GET commands — newest first; `[]` past the end. */
  listCommands(
    instanceId: string,
    page = 1,
    pageSize = 25,
  ): Observable<ResponseData<EACommandHistoryItem[]>> {
    return this.api.get<ResponseData<EACommandHistoryItem[]>>(
      this.path(instanceId, `commands?page=${page}&pageSize=${pageSize}`),
      SILENT,
    );
  }

  /** GET commands/{commandId} — polled after sending one until its status is final. */
  getCommand(instanceId: string, commandId: number): Observable<ResponseData<EACommandHistoryItem>> {
    return this.api.get<ResponseData<EACommandHistoryItem>>(
      this.path(instanceId, `commands/${commandId}`),
      SILENT,
    );
  }

  /** C3 22 ForceRecovery — never clears an operator halt (the engine refuses it with a sentence). */
  forceRecovery(
    instanceId: string,
    body: { reason?: string | null } = {},
  ): Observable<ResponseData<AdminCommandQueueResult>> {
    return this.api.post<ResponseData<AdminCommandQueueResult>>(
      this.path(instanceId, 'force-recovery'),
      body,
    );
  }

  /** C3 23 SetInputs — rewrites the EA's restart-required inputs and reloads the EA on them. */
  setInputs(
    instanceId: string,
    body: { inputs: Record<string, string | number | boolean>; reason?: string | null },
  ): Observable<ResponseData<AdminCommandQueueResult>> {
    return this.api.post<ResponseData<AdminCommandQueueResult>>(
      this.path(instanceId, 'inputs'),
      body,
    );
  }

  /** GET terminal — host, install, desired state, auto-heal, supervisor runtime, beacon. */
  getTerminal(instanceId: string): Observable<ResponseData<EATerminalDto>> {
    return this.api.get<ResponseData<EATerminalDto>>(this.path(instanceId, 'terminal'), SILENT);
  }

  /** POST terminal/{start|stop|restart} — a host-supervisor job. Stop also sets desired state Stopped. */
  terminalAction(
    instanceId: string,
    action: 'start' | 'stop' | 'restart',
    reason?: string | null,
  ): Observable<ResponseData<EATerminalJobResult>> {
    return this.api.post<ResponseData<EATerminalJobResult>>(
      this.path(instanceId, `terminal/${action}`),
      { reason: reason ?? null },
    );
  }

  /** PUT autoheal — the instance's and its terminal's switch. */
  setAutoHeal(instanceId: string, enabled: boolean): Observable<ResponseData<EAAutoHealDto>> {
    return this.api.put<ResponseData<EAAutoHealDto>>(this.path(instanceId, 'autoheal'), {
      enabled,
    });
  }

  /** POST deploy — put a release (blank = latest) on the terminal, then restart its EAs on it. */
  deployEa(
    instanceId: string,
    body: { releaseId?: number | null; restartAfter?: boolean } = {},
  ): Observable<ResponseData<EATerminalJobResult>> {
    return this.api.post<ResponseData<EATerminalJobResult>>(this.path(instanceId, 'deploy'), {
      releaseId: body.releaseId ?? null,
      restartAfter: body.restartAfter ?? true,
    });
  }

  /** POST host-logs — ask the host supervisor for a log tail; read it from the job's result. */
  requestHostLogs(
    instanceId: string,
    kind: HostLogKind,
    lines: number,
  ): Observable<ResponseData<EATerminalJobResult>> {
    return this.api.post<ResponseData<EATerminalJobResult>>(this.path(instanceId, 'host-logs'), {
      kind,
      lines,
    });
  }

  /**
   * POST prune-files — clean up old files on the host. `dryRun` (default) only
   * lists them (job `resultData`, see `PruneFilesResult`); the real run needs
   * the job id of a succeeded dry run of the same terminal from the last 30 min.
   */
  pruneFiles(
    instanceId: string,
    body: { dryRun: boolean; dryRunJobId?: string | null; reason?: string | null },
  ): Observable<ResponseData<EATerminalJobResult>> {
    return this.api.post<ResponseData<EATerminalJobResult>>(this.path(instanceId, 'prune-files'), {
      dryRun: body.dryRun,
      dryRunJobId: body.dryRunJobId ?? null,
      reason: body.reason ?? null,
    });
  }

  /** GET heal-events — the auto-heal ladder's steps, newest first. */
  listHealEvents(
    instanceId: string,
    page = 1,
    pageSize = 50,
  ): Observable<ResponseData<EAHealEventDto[]>> {
    return this.api.get<ResponseData<EAHealEventDto[]>>(
      this.path(instanceId, `heal-events?page=${page}&pageSize=${pageSize}`),
      SILENT,
    );
  }

  /** GET health — verdict + plain-language problems with their one-click fixes. */
  getHealth(instanceId: string): Observable<ResponseData<EAHealthDto>> {
    return this.api.get<ResponseData<EAHealthDto>>(this.path(instanceId, 'health'), SILENT);
  }

  /** GET admin/terminals/jobs/{jobId} — a host job with its status and result. */
  getTerminalJob(jobId: string): Observable<ResponseData<TerminalJobDto>> {
    return this.api.get<ResponseData<TerminalJobDto>>(
      `/admin/terminals/jobs/${encodeURIComponent(jobId)}`,
      SILENT,
    );
  }

  // ── Config profiles ──────────────────────────────────────────────────────

  listConfigProfiles(): Observable<ResponseData<EaConfigProfile[]>> {
    return this.api.get<ResponseData<EaConfigProfile[]>>(`${this.base}/profiles`);
  }

  saveConfigProfile(body: SaveEaConfigProfileRequest): Observable<ResponseData<EaConfigProfile>> {
    return this.api.post<ResponseData<EaConfigProfile>>(`${this.base}/profiles`, body);
  }

  deleteConfigProfile(profileId: number): Observable<ResponseData<string>> {
    return this.api.delete<ResponseData<string>>(`${this.base}/profiles/${profileId}`);
  }

  /** Snapshot an instance's EFFECTIVE config (post config_override replay) into a profile. */
  captureConfigProfile(
    instanceId: string,
    body: Omit<CaptureEaConfigProfileRequest, 'instanceId'>,
  ): Observable<ResponseData<EaConfigProfile>> {
    return this.api.post<ResponseData<EaConfigProfile>>(
      `${this.base}/${encodeURIComponent(instanceId)}/capture-profile`,
      { ...body, instanceId },
    );
  }

  /** Apply a profile to one or more instances. Partial success is reported per-target. */
  applyConfigProfile(
    profileId: number,
    instanceIds: string[],
  ): Observable<ResponseData<ApplyProfileResult>> {
    return this.api.post<ResponseData<ApplyProfileResult>>(
      `${this.base}/profiles/${profileId}/apply`,
      { profileId, instanceIds },
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

  /**
   * GET /admin/ea/{instanceId}/spread-pad — current per-EA spread-pad toggle
   * and the compile-time default. AND-ed under the hood with the engine-wide
   * SpreadReactive:Pad:Enabled master.
   */
  getSpreadPad(instanceId: string): Observable<ResponseData<EASpreadPadConfig>> {
    return this.api.get<ResponseData<EASpreadPadConfig>>(
      `${this.base}/${encodeURIComponent(instanceId)}/spread-pad`,
    );
  }

  /**
   * PUT /admin/ea/{instanceId}/spread-pad — writes one EngineConfig row
   * (`EA:SpreadPad:Account:{accountId}`). Hot-reloads through
   * EngineConfigCache; takes effect on the next pad evaluation without a
   * restart.
   */
  updateSpreadPad(
    instanceId: string,
    body: UpdateEASpreadPadRequest,
  ): Observable<ResponseData<number>> {
    return this.api.put<ResponseData<number>>(
      `${this.base}/${encodeURIComponent(instanceId)}/spread-pad`,
      this.withInstanceId(instanceId, body),
    );
  }

  /**
   * GET /admin/ea/{instanceId}/breakeven-exit — current rule-based BE config
   * for the trading account that owns the EA + compile-time defaults.  Drives
   * the BE panel on the EA detail page.
   */
  getBreakevenExit(instanceId: string): Observable<ResponseData<EABreakevenExitConfig>> {
    return this.api.get<ResponseData<EABreakevenExitConfig>>(
      `${this.base}/${encodeURIComponent(instanceId)}/breakeven-exit`,
    );
  }

  /**
   * PUT /admin/ea/{instanceId}/breakeven-exit — writes the five account-scoped
   * EngineConfig rows that back the two BE mechanics.  Hot-reloads through
   * EngineConfigCache; takes effect on the next PositionWorker cycle without
   * a restart.
   */
  updateBreakevenExit(
    instanceId: string,
    body: UpdateEABreakevenExitRequest,
  ): Observable<ResponseData<number>> {
    return this.api.put<ResponseData<number>>(
      `${this.base}/${encodeURIComponent(instanceId)}/breakeven-exit`,
      this.withInstanceId(instanceId, body),
    );
  }

  /**
   * GET /admin/ea/{instanceId}/pending-signal-reval — current park-and-revalidate
   * config for the trading account that owns the EA + compile-time defaults.
   * Drives the pending-signal-reval panel on the EA detail page.
   */
  getPendingSignalReval(instanceId: string): Observable<ResponseData<EAPendingSignalRevalConfig>> {
    return this.api.get<ResponseData<EAPendingSignalRevalConfig>>(
      `${this.base}/${encodeURIComponent(instanceId)}/pending-signal-reval`,
    );
  }

  /**
   * PUT /admin/ea/{instanceId}/pending-signal-reval — writes the five account-scoped
   * EngineConfig rows that back the mechanic.  Hot-reloads through EngineConfigCache;
   * takes effect on the next gate/worker cycle without a restart.
   */
  updatePendingSignalReval(
    instanceId: string,
    body: UpdateEAPendingSignalRevalRequest,
  ): Observable<ResponseData<number>> {
    return this.api.put<ResponseData<number>>(
      `${this.base}/${encodeURIComponent(instanceId)}/pending-signal-reval`,
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

  /** GET /admin/ea/candle-source — current single-source selection + pickable fleet. */
  getCandleSource(): Observable<ResponseData<CandleStreamSource>> {
    return this.api.get<ResponseData<CandleStreamSource>>(`${this.base}/candle-source`);
  }

  /**
   * PUT /admin/ea/candle-source — designate (or clear) the candle-stream
   * instance.  Omit `symbol` for the global default; empty `instanceId` clears.
   */
  setCandleSource(body: SetCandleStreamSourceRequest): Observable<ResponseData<string>> {
    return this.api.put<ResponseData<string>>(`${this.base}/candle-source`, body);
  }
}
