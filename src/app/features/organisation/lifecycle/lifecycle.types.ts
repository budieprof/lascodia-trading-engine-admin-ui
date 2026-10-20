/**
 * An organisation's life cycle — branding, data export, closing and deleting it (engine multi-tenancy
 * Phase 7, c7-lifecycle; contract in the engine's `docs/api/tenant-lifecycle.md`). DTOs as the engine
 * sends them (camelCase, enums by name).
 */

// ── Branding (`/tenant/branding`): the types live with the service that applies them ──

export type {
  BrandingImage,
  BrandingImageKind,
  TenantBranding,
  UpdateBrandingBody,
} from '@core/branding/branding.types';

// ── Data export (`/tenant/exports`) ──

export type TenantDataExportStatus = 'Queued' | 'Running' | 'Ready' | 'Failed' | 'Expired';

export interface TenantDataExport {
  id: number;
  status: TenantDataExportStatus;
  requestedBy: string;
  requestedAtUtc: string;
  startedAtUtc: string | null;
  completedAtUtc: string | null;
  expiresAtUtc: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  tableCount: number | null;
  rowCount: number | null;
  failureReason: string | null;
  downloadCount: number;
  lastDownloadedAtUtc: string | null;
  canDownload: boolean;
}

/** A single-use download link (relative to the API base). */
export interface TenantExportLink {
  url: string;
  expiresAtUtc: string;
}

// ── Closing (`/tenant/closure`) ──

export interface TenantClosureState {
  tenantId: number;
  slug: string;
  name: string;
  status: 'Active' | 'Suspended' | 'Closed' | string;
  isHouse: boolean;
  openPositions: number;
  workingOrders: number;
  owners: number;
  needsSecondOwner: boolean;
  graceDays: number;
  activeMachineCredentials: number;
  members: number;
  canClose: boolean;
  blockers: string[];
}

export interface CloseTenantBody {
  confirmSlug: string;
  reason: string;
}

export type TenantClosureStatus =
  | 'Closed'
  | 'Reopened'
  | 'PurgeScheduled'
  | 'Purging'
  | 'Purged'
  | 'PurgeFailed';

export interface PurgeStep {
  table: string;
  entity: string;
  ownership: string | null;
  rows: number;
}

export interface PurgeBlocker {
  table: string;
  column: string;
  referencesTable: string;
  /** -1 = the reference could not be checked (that also blocks). */
  rows: number;
  why: string;
}

export interface PurgePerson {
  adminUserId: number;
  username: string;
  /** `remove`, or `keep: <why>`. */
  action: string;
}

/** The deletion plan — a dry run (`POST platform/closures/{id}/purge-plan`). */
export interface TenantPurgePlan {
  tenantId: number;
  slug: string;
  name: string;
  generatedAtUtc: string;
  canRun: boolean;
  rows: number;
  steps: PurgeStep[];
  tablesVisited: number;
  cascades: { table: string; referencesTable: string; rows: number }[];
  blockers: PurgeBlocker[];
  auditEventsKept: number;
  people: PurgePerson[];
  identityProviderOrganizationId: string | null;
  identityProviderEnabled: boolean;
  notes: string[];
}

export interface TenantPurgeReport {
  completed: boolean;
  error: string | null;
  deletedRows: Record<string, number>;
  rows: number;
  peopleRemoved: number[];
  peopleKept: number[];
  identityProviderOrganizationRemoved: boolean;
  identityProviderErrors: string[];
  finishedAtUtc: string;
}

export interface ClosureEffects {
  killSwitchEngaged?: boolean;
  machineCredentialsRevoked?: number;
  enrollmentTokensRevoked?: number;
  accessTokensRevoked?: number;
  invitationsWithdrawn?: number;
  consoleSessionsEnded?: number;
  members?: number;
}

export interface TenantClosure {
  id: number;
  tenantId: number;
  /** The organisation's handle and name (platform staff's views). */
  slug: string | null;
  name: string | null;
  status: TenantClosureStatus;
  reason: string | null;
  requestedBy: string;
  approvedBy: string | null;
  closedAtUtc: string;
  graceEndsAtUtc: string;
  effects: ClosureEffects | null;
  reopenedAtUtc: string | null;
  reopenedBy: string | null;
  reopenReason: string | null;
  plannedAtUtc: string | null;
  plan: TenantPurgePlan | null;
  purgeRequestedAtUtc: string | null;
  purgeRequestedBy: string | null;
  purgeStartedAtUtc: string | null;
  purgeCompletedAtUtc: string | null;
  purgeReport: TenantPurgeReport | null;
  purgeError: string | null;
  canReopen: boolean;
  canSchedulePurge: boolean;
}

/** `data` of a close request: the closure, or — with a second Owner to approve — the pending approval. */
export interface CloseTenantResult {
  closure: TenantClosure | null;
  approvalId: number | null;
  expiresAtUtc: string | null;
}
