import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import type {
  CloneMt5OnDaemonRequest,
  DaemonCloneMt5Response,
  DaemonInstallDto,
  DaemonKillOrphanResponse,
  DaemonLogTailResponse,
  DaemonOrphanDto,
  DaemonRestartResponse,
  DaemonRotateApiKeyResponse,
  KillOrphanRequest,
  LaunchTerminalRequest,
  PatchInstallOnDaemonRequest,
  RegisterInstallOnDaemonRequest,
  ResponseData,
  TerminalDaemonDto,
  TerminalSessionDto,
} from '@core/api/api.types';

/**
 * Phase-12 admin client for the terminal-supervisor surface.  The engine
 * proxies launch / close requests to the registered daemon over HTTP; the
 * UI never talks to the daemon directly so we keep one auth model.
 */
@Injectable({ providedIn: 'root' })
export class TerminalsService {
  private readonly api = inject(ApiService);
  private readonly base = '/admin/terminals';

  listDaemons(): Observable<ResponseData<TerminalDaemonDto[]>> {
    return this.api.get<ResponseData<TerminalDaemonDto[]>>(`${this.base}/daemons`);
  }

  listSessions(opts?: {
    daemonId?: number;
    includeClosed?: boolean;
  }): Observable<ResponseData<TerminalSessionDto[]>> {
    const params: string[] = [];
    if (typeof opts?.daemonId === 'number') params.push(`daemonId=${opts.daemonId}`);
    if (typeof opts?.includeClosed === 'boolean')
      params.push(`includeClosed=${opts.includeClosed}`);
    const qs = params.length ? `?${params.join('&')}` : '';
    return this.api.get<ResponseData<TerminalSessionDto[]>>(`${this.base}/sessions${qs}`);
  }

  launch(body: LaunchTerminalRequest): Observable<ResponseData<TerminalSessionDto>> {
    return this.api.post<ResponseData<TerminalSessionDto>>(`${this.base}/launch`, body);
  }

  closeSession(sessionId: number, reason?: string | null): Observable<ResponseData<string>> {
    return this.api.post<ResponseData<string>>(`${this.base}/sessions/${sessionId}/close`, {
      sessionId,
      reason: reason ?? null,
    });
  }

  // ── Phase-15 wave 1: per-daemon install management ─────────────────

  /** Full install schema for a daemon — used by the per-row edit form. */
  listDaemonInstalls(daemonId: number): Observable<ResponseData<DaemonInstallDto[]>> {
    return this.api.get<ResponseData<DaemonInstallDto[]>>(
      `${this.base}/daemons/${daemonId}/installs`,
    );
  }

  /** Stage 1 of "Add broker terminal": clone the MT5 bundle on the host. */
  cloneMt5OnDaemon(
    daemonId: number,
    body: CloneMt5OnDaemonRequest,
  ): Observable<ResponseData<DaemonCloneMt5Response>> {
    return this.api.post<ResponseData<DaemonCloneMt5Response>>(
      `${this.base}/daemons/${daemonId}/installs/clone-mt5`,
      body,
    );
  }

  /** Stage 3 of "Add broker terminal": register the freshly-configured MT5 with the daemon. */
  registerInstallOnDaemon(
    daemonId: number,
    body: RegisterInstallOnDaemonRequest,
  ): Observable<ResponseData<DaemonInstallDto>> {
    return this.api.post<ResponseData<DaemonInstallDto>>(
      `${this.base}/daemons/${daemonId}/installs/register`,
      body,
    );
  }

  // ── Wave 2: install CRUD + daemon ops ──────────────────────────────

  deleteInstallOnDaemon(daemonId: number, installId: string): Observable<ResponseData<string>> {
    return this.api.delete<ResponseData<string>>(
      `${this.base}/daemons/${daemonId}/installs/${encodeURIComponent(installId)}`,
    );
  }

  patchInstallOnDaemon(
    daemonId: number,
    installId: string,
    body: PatchInstallOnDaemonRequest,
  ): Observable<ResponseData<DaemonInstallDto>> {
    return this.api.patch<ResponseData<DaemonInstallDto>>(
      `${this.base}/daemons/${daemonId}/installs/${encodeURIComponent(installId)}`,
      body,
    );
  }

  restartDaemon(daemonId: number): Observable<ResponseData<DaemonRestartResponse>> {
    return this.api.post<ResponseData<DaemonRestartResponse>>(
      `${this.base}/daemons/${daemonId}/restart`,
      {},
    );
  }

  rotateDaemonApiKey(daemonId: number): Observable<ResponseData<DaemonRotateApiKeyResponse>> {
    return this.api.post<ResponseData<DaemonRotateApiKeyResponse>>(
      `${this.base}/daemons/${daemonId}/rotate-api-key`,
      {},
    );
  }

  // ── Wave 3: observability ──────────────────────────────────────────

  tailDaemonLogs(
    daemonId: number,
    lines: number = 200,
  ): Observable<ResponseData<DaemonLogTailResponse>> {
    return this.api.get<ResponseData<DaemonLogTailResponse>>(
      `${this.base}/daemons/${daemonId}/logs/tail?lines=${lines}`,
    );
  }

  getDaemonConfig(daemonId: number): Observable<ResponseData<Record<string, unknown>>> {
    return this.api.get<ResponseData<Record<string, unknown>>>(
      `${this.base}/daemons/${daemonId}/config`,
    );
  }

  // ── Orphan MT5 processes ───────────────────────────────────────────

  /** List MT5 terminal64.exe processes the daemon is not tracking. */
  listOrphansOnDaemon(daemonId: number): Observable<ResponseData<DaemonOrphanDto[]>> {
    return this.api.get<ResponseData<DaemonOrphanDto[]>>(
      `${this.base}/daemons/${daemonId}/orphans`,
    );
  }

  /** Terminate one orphan MT5 process by PID. */
  killOrphanOnDaemon(
    daemonId: number,
    pid: number,
    body: KillOrphanRequest = {},
  ): Observable<ResponseData<DaemonKillOrphanResponse>> {
    return this.api.post<ResponseData<DaemonKillOrphanResponse>>(
      `${this.base}/daemons/${daemonId}/orphans/${pid}/kill`,
      body,
    );
  }
}
