import type { ResponseData } from '@core/api/api.types';
export { isValidColour, lighten, readableTextOn } from '@core/branding/branding-colour';
import type {
  BrandingImageKind,
  CloseTenantResult,
  TenantClosure,
  TenantClosureState,
  TenantClosureStatus,
  TenantDataExport,
  TenantPurgePlan,
} from './lifecycle.types';

// ── Shared ──

/** "1.4 MB", "820 KB", "512 B". */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Whole days from `now` until `isoUtc` (0 once it has passed). */
export function daysUntil(isoUtc: string | null | undefined, now: number = Date.now()): number {
  if (!isoUtc) return 0;
  const at = Date.parse(isoUtc);
  if (Number.isNaN(at)) return 0;
  return Math.max(0, Math.ceil((at - now) / 86_400_000));
}

// ── Branding ──

/** The limits the engine applies (by content) — checked here first so a wrong file is refused at once. */
export const BRANDING_LIMITS: Readonly<
  Record<BrandingImageKind, { maxBytes: number; types: readonly string[]; label: string }>
> = {
  logo: {
    maxBytes: 256 * 1024,
    types: ['image/png', 'image/jpeg', 'image/webp'],
    label: 'PNG, JPEG or WebP, up to 256 KB',
  },
  favicon: {
    maxBytes: 64 * 1024,
    types: ['image/png', 'image/x-icon', 'image/vnd.microsoft.icon'],
    label: 'PNG or ICO, up to 64 KB',
  },
};

/** Why `file` cannot be the logo / favicon, or null when it may be sent (the engine checks its content). */
export function imageFileProblem(
  kind: BrandingImageKind,
  file: { name: string; size: number; type: string },
): string | null {
  const limits = BRANDING_LIMITS[kind];
  const name = kind === 'logo' ? 'The logo' : 'The favicon';
  if (file.size <= 0) return `${name} file is empty.`;
  if (file.size > limits.maxBytes)
    return `${name} is ${Math.ceil(file.size / 1024)} KB; the limit is ${limits.maxBytes / 1024} KB.`;
  const type = file.type.toLowerCase();
  const byExtension = kind === 'favicon' && /\.ico$/i.test(file.name);
  if (!limits.types.includes(type) && !byExtension)
    return `${name} must be ${limits.label.split(',')[0]}.`;
  return null;
}

// ── Data export ──

export function exportStatusLabel(e: TenantDataExport, now: number = Date.now()): string {
  switch (e.status) {
    case 'Queued':
      return 'Waiting to start';
    case 'Running':
      return 'Being prepared';
    case 'Ready':
      return e.canDownload ? `Ready — ${daysUntil(e.expiresAtUtc, now)} day(s) left` : 'Expired';
    case 'Failed':
      return 'Failed';
    case 'Expired':
      return 'Expired (deleted)';
    default:
      return String(e.status);
  }
}

export function exportTone(e: TenantDataExport): 'ok' | 'warn' | 'bad' | 'muted' {
  if (e.status === 'Ready' && e.canDownload) return 'ok';
  if (e.status === 'Queued' || e.status === 'Running') return 'warn';
  if (e.status === 'Failed') return 'bad';
  return 'muted';
}

/** One export at a time: a new one only when none is waiting or being prepared. */
export function exportInProgress(exports: readonly TenantDataExport[]): TenantDataExport | null {
  return exports.find((e) => e.status === 'Queued' || e.status === 'Running') ?? null;
}

// ── Closing ──

/** Whether the typed confirmation matches and a reason is given (the engine checks both again). */
export function closeConfirmationOk(
  state: TenantClosureState | null,
  typedSlug: string,
  reason: string,
): boolean {
  return (
    !!state &&
    state.canClose &&
    typedSlug.trim().toLowerCase() === state.slug.toLowerCase() &&
    reason.trim().length > 0 &&
    reason.trim().length <= 500
  );
}

export type CloseOutcome =
  | { kind: 'closed'; closure: TenantClosure }
  | { kind: 'approval'; approvalId: number; expiresAtUtc: string | null }
  | { kind: 'refused'; message: string };

/** What a close request's envelope means: closed, held for a second Owner (HTTP 202 `-202-approval`), or refused. */
export function closeOutcome(
  res: ResponseData<CloseTenantResult> | null | undefined,
): CloseOutcome {
  if (res?.status === true && res.data?.closure)
    return { kind: 'closed', closure: res.data.closure };
  if (res?.responseCode === '-202-approval' && res.data?.approvalId != null)
    return {
      kind: 'approval',
      approvalId: res.data.approvalId,
      expiresAtUtc: res.data.expiresAtUtc,
    };
  return { kind: 'refused', message: res?.message || 'The organisation could not be closed.' };
}

export function closureStatusLabel(status: TenantClosureStatus | string): string {
  switch (status) {
    case 'Closed':
      return 'Closed — in its grace period';
    case 'Reopened':
      return 'Reopened';
    case 'PurgeScheduled':
      return 'Deletion confirmed — waiting to run';
    case 'Purging':
      return 'Deleting its data';
    case 'Purged':
      return 'Data deleted';
    case 'PurgeFailed':
      return 'Deletion stopped';
    default:
      return String(status);
  }
}

export function closureTone(status: TenantClosureStatus | string): 'ok' | 'warn' | 'bad' | 'muted' {
  if (status === 'Reopened') return 'ok';
  if (status === 'Closed' || status === 'PurgeScheduled' || status === 'Purging') return 'warn';
  if (status === 'PurgeFailed') return 'bad';
  return 'muted';
}

/** One line for a plan: what it deletes and whether it may run. */
export function planSummary(plan: TenantPurgePlan): string {
  const removed = plan.people.filter((p) => p.action === 'remove').length;
  const rows = `${plan.rows.toLocaleString()} row(s) in ${plan.steps.length} table(s)`;
  const people = `${removed} person(s) removed, ${plan.people.length - removed} kept`;
  const kept = `${plan.auditEventsKept.toLocaleString()} audit event(s) kept until their retention passes`;
  return plan.canRun
    ? `Would delete ${rows}; ${people}; ${kept}.`
    : `Blocked (${plan.blockers.length} reference(s) to this organisation's rows from data that is not its own).`;
}

/** Whether the typed slug confirms a deletion (the engine checks it again). */
export function purgeConfirmationOk(
  closure: TenantClosure | null,
  slug: string,
  typed: string,
): boolean {
  return (
    !!closure &&
    closure.canSchedulePurge &&
    !!closure.plan?.canRun &&
    typed.trim().toLowerCase() === slug.toLowerCase()
  );
}
