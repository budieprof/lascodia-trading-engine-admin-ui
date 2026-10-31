/**
 * Wire types of the self-heal program's EA detail-page API (engine `sh/engine`,
 * contracts C1 / C2 / C4 / C7 in `.selfheal-program/PROGRAM.md`). All routes
 * live under `admin/ea/{instanceId}/…` (`access.operator`) except the job read,
 * `admin/terminals/jobs/{jobId}`.
 *
 * Kept apart from the 6,000-line `api.types.ts` so the self-heal surface can
 * be read in one place.
 */

/** Command status the engine derives for every EA command (C7). */
export type EACommandStatus = 'Pending' | 'Delivered' | 'Succeeded' | 'Failed' | 'Expired';

/** `GET admin/ea/{id}/commands` row and `GET admin/ea/{id}/commands/{commandId}`. */
export interface EACommandHistoryItem {
  commandId: number;
  /** EACommandType name, e.g. `RestartInstance`, `ForceRecovery`, `SetInputs`. */
  type: string;
  status: EACommandStatus | string;
  createdAt: string;
  ackAt: string | null;
  /** The EA's own answer (`Success: …` / `Failed: <why>`), or `Expired …`. */
  ackResult: string | null;
  retries: number;
  /** `admin-user:5 (Name)`, `system:auto-heal`, `job:<jobId>`. */
  requestedBy: string | null;
  correlationId: string | null;
  /** The command's JSON parameters as stored (string). */
  parameters: string | null;
}

/** Job status of a host-supervisor job (C4). */
export type TerminalJobStatus = 'Pending' | 'Claimed' | 'Succeeded' | 'Failed' | 'Expired';

/** `GET admin/terminals/jobs/{jobId}`. */
export interface TerminalJobDto {
  jobId: string;
  /** `StartTerminal` | `StopTerminal` | `RestartTerminal` | `DeployEaBinary` | `TailLog` | `PruneFiles`. */
  type: string;
  status: TerminalJobStatus | string;
  daemonId: number;
  daemonName: string;
  installId: string;
  eaInstanceId: string | null;
  requestedBy: string;
  reason: string | null;
  params: Record<string, unknown> | null;
  createdAt: string;
  expiresAt: string;
  claimedAt: string | null;
  completedAt: string | null;
  resultMessage: string | null;
  /** TailLog: `{path, text, kind}`; Deploy: `{previousSha256, sha256, path, changed}`. */
  resultData: Record<string, unknown> | null;
  /** Commands the engine queued after this job finished (deploy → RestartInstance). */
  followUpCommandIds: number[];
}

/** Answer of every endpoint that queues host work. */
export interface EATerminalJobResult {
  jobId: string;
  message: string;
}

/** C2 beacon file as the supervisor read it. */
export interface EABeacon {
  schema?: number;
  instanceId?: string;
  accountLogin?: number;
  server?: string;
  chartId?: string;
  eaVersion?: string;
  phase?: 'init' | 'running' | 'init_failed' | 'deinit' | string;
  state?: string;
  initFailReason?: string;
  authState?: string;
  lastTimerUtc?: string;
  writtenAtUtc?: string;
  terminalBuild?: number;
}

/** C4 per-install runtime as the supervisor sent it. Every field optional: older supervisors send less. */
export interface EAInstallRuntime {
  running?: boolean;
  terminalPid?: number | null;
  wrapperPid?: number | null;
  adopted?: boolean;
  launchMode?: 'app' | 'wine' | string;
  beacons?: EABeacon[];
  beaconReadError?: string;
  watchdog?: {
    state?: 'ok' | 'restarting' | 'backoff' | 'gave_up' | 'disabled' | string;
    restartsLastHour?: number;
    lastActionUtc?: string;
    lastReason?: string;
    nextAttemptUtc?: string;
  };
  journalSignals?: { oldTick?: boolean; invalidBook?: boolean; debuggerFound?: boolean };
  eaBinarySha256?: string;
  diskFreeBytes?: number;
}

export interface EALatestRelease {
  releaseId: number;
  version: string;
  sha256: string;
}

/** `GET admin/ea/{id}/terminal`. */
export interface EATerminalDto {
  daemonId: number | null;
  daemonHostId: string | null;
  daemonName: string | null;
  daemonOnline: boolean;
  daemonLastSeenAt: string | null;
  installId: string | null;
  installName: string | null;
  desiredState: 'Running' | 'Stopped' | string | null;
  /** Effective: the instance's switch AND the install's. */
  autoHeal: boolean;
  instanceAutoHeal: boolean;
  installAutoHeal: boolean | null;
  desiredStateChangedAt: string | null;
  desiredStateChangedBy: string | null;
  desiredStateReason: string | null;
  runtime: EAInstallRuntime | null;
  runtimeUpdatedAt: string | null;
  beacon: EABeacon | null;
  linkedBy: 'beacon' | 'account' | 'none' | string;
  latestRelease: EALatestRelease | null;
  eaBinaryIsLatest: boolean | null;
}

/** `PUT admin/ea/{id}/autoheal`. */
export interface EAAutoHealDto {
  enabled: boolean;
  instanceAutoHeal: boolean;
  installAutoHeal: boolean | null;
  installId: string | null;
}

/** One auto-heal ladder step (C8). */
export interface EAHealEventDto {
  id: number;
  atUtc: string;
  /** 0 recovered, 1-4 the ladder rungs, 5 gave up. */
  rung: number;
  /** ForceRecovery | RestartInstance | RestartTerminal | StartTerminal | Held | GaveUp | Recovered. */
  action: string;
  reason: string;
  /** DryRun | Held | GaveUp | Recovered | Failed, or the live command / job status. */
  outcome: string;
  commandId: number | null;
  jobId: string | null;
}

export type EAHealthVerdict = 'Healthy' | 'Degraded' | 'Down' | 'Stopped';

/**
 * Endpoint a problem's fix button calls: `force-recovery`, `terminal/start`,
 * `terminal/restart`, `clear-safety-stop`, `release-kill-switch`, `autoheal`
 * (PUT `{enabled:true}`), `deploy` (latest release, restartAfter).
 */
export type EAHealthFixAction =
  | 'force-recovery'
  | 'terminal/start'
  | 'terminal/restart'
  | 'terminal/stop'
  | 'clear-safety-stop'
  | 'release-kill-switch'
  | 'autoheal'
  | 'deploy';

export interface EAHealthProblem {
  code: string;
  severity: 'error' | 'warning' | 'info' | string;
  text: string;
  fix: { action: EAHealthFixAction | string; label: string } | null;
}

/** `GET admin/ea/{id}/health` — the detail page's top card. */
export interface EAHealthDto {
  verdict: EAHealthVerdict | string;
  problems: EAHealthProblem[];
  heartbeatAgeSeconds: number;
  state: string | null;
  stateSinceUtc: string | null;
  stateReason: string | null;
  autoHeal: boolean;
  linkedBy: string;
  lastHealEvent: EAHealEventDto | null;
}

/** One state transition in the C1 diag block, newest first. */
export interface EADiagTransition {
  from: string;
  to: string;
  reason: string;
  atUtc: string;
}

/** C1 heartbeat `diag` block (`LastStatePayload.diag`). Every field optional for older builds. */
export interface EADiag {
  stateSinceUtc?: string;
  stateReason?: string;
  recentTransitions?: EADiagTransition[];
  terminalConnected?: boolean;
  terminalTradeAllowed?: boolean;
  mqlTradeAllowed?: boolean;
  dllsAllowed?: boolean;
  terminalBuild?: number;
  accountLogin?: number;
  server?: string;
  restartTemplateSeeded?: boolean;
  spawnTemplateSeeded?: boolean;
  liveGateBlockedReason?: string;
  recoveryFailed?: boolean;
  recoveryFailedPhase?: string;
  authRung?: 'machine' | 'apikey' | 'bootstrap' | 'none' | string;
  authState?: 'ok' | 'retrying' | 'dormant' | 'dead' | string;
  deadLetterCount?: number;
  lastWebRequestError?: number;
  lastWebRequestErrorAtUtc?: string;
  initDegraded?: boolean;
  initRetryReason?: string;
  diskBytesLascodia?: number;
  /** Beyond C1: a template apply MT5 refused after the command was acknowledged. */
  lastApplyError?: string;
}

/** Host-log kinds the `host-logs` endpoint accepts. */
export type HostLogKind = 'ea' | 'journal' | 'supervisor';
