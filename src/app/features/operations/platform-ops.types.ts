/**
 * Operations → Platform (engine gaps program, zero-downtime): `GET ops/platform` and the host jobs it queues. The engine
 * contract is `LascodiaTradingEngine.Application/Ops/Platform/PlatformOps.cs`; `host.status` is the host supervisor's
 * HostOpsStatus report (supervisor `hostops.collect_status`), passed through as JSON.
 */

export interface PlatformColour {
  name: string;
  state: string; // leader | standby | stopping | lost | disabled | down | unknown
  leader: boolean;
  holder: string | null;
  fencingToken: number | null;
  leaderSinceUtc: string | null;
  draining: boolean;
  error: string | null;
}

export interface PlatformLease {
  key: string;
  holderName: string;
  fencingToken: number;
  acquiredAtUtc: string;
  renewedAtUtc: string;
  expiresAtUtc: string;
  held: boolean;
}

export interface PlatformConfigValue {
  key: string;
  value: string;
  default: string;
  description: string | null;
  lastChangedBy: string | null;
  lastChangedAtUtc: string | null;
}

export interface PlatformAlerting {
  reachable: boolean;
  error: string | null;
  receivers: string[];
  integrations: string[];
  silences: AlertSilence[];
  activeAlerts: number;
}

export interface AlertSilence {
  id?: string;
  comment?: string;
  createdBy?: string;
  endsAt?: string;
  matchers?: { name: string; value: string; isRegex?: boolean; isEqual?: boolean }[];
  status?: { state?: string };
}

export interface HostContainer {
  service: string;
  exists: boolean;
  running?: boolean;
  status?: string | null;
  startedAt?: string | null;
  health?: string | null;
  image?: string | null;
  restartCount?: number | null;
}

export interface HostBackups {
  dir: string;
  exists: boolean;
  lastSuccess: string | null;
  newest?: {
    manifest: string;
    createdUtc: string | null;
    latestMigration: string | null;
    encryption: string | null;
    bytes: number;
    durationSeconds: string | null;
  };
  count?: number;
  lastDrill: {
    drillUtc?: string;
    passed?: boolean;
    backupCreatedUtc?: string;
    rtoDatabaseSeconds?: number | null;
    wallSeconds?: number;
    rowsEqual?: number;
    rowsDiffer?: number;
    failures?: number | null;
  } | null;
  configured: boolean;
  remote: string | null;
  remoteUrl: string | null;
  encryption: string | null;
  scheduleInstalled: boolean;
  schedule?: string;
}

export interface HostStatus {
  collectedAtUtc: string;
  bluegreen: { state: Record<string, string>; history: string[]; swapInProgress: boolean };
  containers: HostContainer[];
  deployableImage: { id: string; created: string | null; revision: string | null } | null;
  backups: HostBackups;
  caddyBlueGreen: boolean | null;
  opsDeployAllowed: boolean;
}

export interface PlatformHost {
  daemonId: string | null;
  daemonName: string | null;
  configured: boolean;
  online: boolean;
  lastSeenAtUtc: string | null;
  status: HostStatus | null;
  statusAtUtc: string | null;
  statusJobId: string | null;
  statusError: string | null;
}

export interface PlatformDeployPolicy {
  enabled: boolean;
  highRiskNow: boolean;
  highRiskReasons: string[];
  minutesBefore: number;
  minutesAfter: number;
  fourEyesPolicy: boolean;
  cliCommand: string;
}

export interface HostJob {
  jobId: string;
  type: string;
  status: 'Pending' | 'Claimed' | 'Succeeded' | 'Failed' | 'Expired' | string;
  daemonName: string;
  requestedBy: string;
  reason: string | null;
  params: Record<string, unknown> | null;
  createdAt: string;
  claimedAt: string | null;
  completedAt: string | null;
  resultMessage: string | null;
  resultData: Record<string, unknown> | null;
  progress: string | null;
  progressAt: string | null;
}

export interface PlatformOps {
  generatedAtUtc: string;
  thisProcessHolder: string;
  thisProcessState: string;
  lease: PlatformLease | null;
  colours: PlatformColour[];
  schemaHead: string | null;
  appliedMigrations: number;
  host: PlatformHost;
  alerting: PlatformAlerting;
  deploy: PlatformDeployPolicy;
  recentJobs: HostJob[];
  settings: PlatformConfigValue[];
}

export type PlatformHostAction = 'RefreshStatus' | 'BackupNow' | 'RestoreDrill';

export interface PlatformJobQueued {
  jobId: string;
  message: string;
}

export interface DeployRequest {
  imageId: string | null;
  rollback: boolean;
  dryRun: boolean;
  confirmation: string;
  overrideHighRisk: boolean;
  reason: string | null;
}
