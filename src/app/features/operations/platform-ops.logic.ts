import type { FeatureRequirement } from '@shared/components/feedback/feature-state.component';
import type {
  HostJob,
  PlatformColour,
  PlatformConfigValue,
  PlatformOps,
} from './platform-ops.types';

/** The 12 hex characters an operator types to confirm a deploy (the engine checks the same). */
export function shortImage(imageId: string | null | undefined): string {
  let id = (imageId ?? '').trim();
  if (id.toLowerCase().startsWith('sha256:')) id = id.slice(7);
  return id.slice(0, 12);
}

/** The exact confirmation the engine requires. */
export function expectedConfirmation(
  imageId: string | null | undefined,
  rollback: boolean,
): string {
  return rollback ? 'ROLLBACK' : `DEPLOY ${shortImage(imageId)}`;
}

export function isFinished(status: string | null | undefined): boolean {
  return status === 'Succeeded' || status === 'Failed' || status === 'Expired';
}

/** Which colour leads, as one line. */
export function leaderSummary(colours: PlatformColour[]): {
  text: string;
  tone: 'ok' | 'warn' | 'bad';
} {
  const leaders = colours.filter((c) => c.leader);
  if (leaders.length === 1) {
    const standbys = colours.filter((c) => !c.leader && c.state === 'standby').map((c) => c.name);
    return {
      text: `${leaders[0].name} leads${standbys.length ? ` · standby: ${standbys.join(', ')}` : ' · no standby running (normal between swaps)'}`,
      tone: 'ok',
    };
  }
  if (leaders.length > 1)
    return { text: 'More than one colour reports leader — do not deploy', tone: 'bad' };
  if (colours.some((c) => c.state === 'disabled'))
    return { text: 'The leader lease is off (legacy single container)', tone: 'warn' };
  return { text: 'No colour leads (legacy topology, or a handover in progress)', tone: 'warn' };
}

/** What the page needs before its host actions work — real status only. */
export function hostRequirements(ops: PlatformOps): FeatureRequirement[] {
  const host = ops.host;
  const status = host.status;
  return [
    {
      label: 'Host supervisor named (Ops:HostDaemonId)',
      ok: host.configured,
      detail: host.configured
        ? `${host.daemonName ?? host.daemonId}`
        : 'Set it to the daemonId of the supervisor running on the engine host.',
      route: '/engine-config',
      query: { search: 'Ops:HostDaemonId' },
    },
    {
      label: 'Host supervisor online',
      ok: host.configured ? host.online : null,
      detail: host.lastSeenAtUtc ? `last seen ${host.lastSeenAtUtc}` : null,
      route: '/terminals',
    },
    {
      label: 'Supervisor ops enabled (supervisor.yaml ops.enabled + engine_repo)',
      ok: status ? true : host.statusError ? false : null,
      detail: status
        ? `status reported ${host.statusAtUtc ?? ''}`
        : (host.statusError ?? 'No status report yet — press Refresh host status.'),
    },
    {
      label: 'Caddy routes to the blue/green pair (deploy/caddy/Caddyfile.bluegreen)',
      ok: status?.caddyBlueGreen ?? null,
      detail:
        status?.caddyBlueGreen === false
          ? 'The live Caddyfile still proxies the single container — see the cut-over plan.'
          : null,
    },
  ];
}

/** Bool / Int / String control for a setting, from its default. */
export function settingKind(setting: PlatformConfigValue): 'bool' | 'int' | 'text' {
  if (setting.default === 'true' || setting.default === 'false') return 'bool';
  if (/^-?\d+$/.test(setting.default)) return 'int';
  return 'text';
}

/** A value an operator typed for a setting, normalised — or an error message. */
export function normaliseSetting(
  setting: PlatformConfigValue,
  raw: string,
): { value: string } | { error: string } {
  const v = raw.trim();
  switch (settingKind(setting)) {
    case 'bool':
      return v === 'true' || v === 'false' ? { value: v } : { error: 'true or false' };
    case 'int':
      return /^\d{1,5}$/.test(v)
        ? { value: String(Number(v)) }
        : { error: 'a whole number of minutes' };
    default:
      return { value: v };
  }
}

/** Bytes as MB / GB. */
export function sizeText(bytes: number | null | undefined): string {
  if (bytes == null) return '—';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

/** A host job in one line for the history table. */
export function jobLine(job: HostJob): string {
  const what =
    {
      HostOpsStatus: 'Status report',
      HostBackupNow: 'Backup',
      HostRestoreDrill: 'Restore drill',
      HostDeployApi: job.params?.['rollback']
        ? 'Rollback'
        : job.params?.['dryRun']
          ? 'Deploy (dry run)'
          : 'Deploy',
    }[job.type] ?? job.type;
  return `${what} — ${job.status}${job.resultMessage ? `: ${job.resultMessage}` : ''}`;
}
