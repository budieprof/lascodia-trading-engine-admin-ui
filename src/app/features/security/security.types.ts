/**
 * Security controls (engine enterprise program security-controls; engine `docs/api/security-controls-api.md`):
 * quarterly access reviews with reviewer sign-off, release notes, and the evidence bundle.
 */

export type CampaignStatus = 'Open' | 'SignedOff';

export interface AccessReviewCampaign {
  id: number;
  period: string;
  periodStartUtc: string;
  status: CampaignStatus;
  generatedAtUtc: string;
  generatedBy: string;
  snapshotSha256: string;
  peopleCount: number;
  stalePeopleCount: number;
  grantCount: number;
  staleGrantCount: number;
  privilegedGrantCount: number;
  machineIdentityCount: number;
  staleMachineIdentityCount: number;
  apiTokenCount: number;
  staleApiTokenCount: number;
  signedOffAtUtc: string | null;
  signedOffBy: string | null;
  signedOffByName: string | null;
  signOffNotes: string | null;
}

export type FindingSeverity = 'high' | 'medium' | 'low';

export interface ReviewFinding {
  severity: FindingSeverity;
  kind: string;
  subject: string;
  detail: string;
}

export interface ReviewPerson {
  adminUserId: number;
  username: string;
  displayName: string;
  email: string;
  membershipStatus: string;
  userActive: boolean;
  lastActivityUtc: string | null;
  idleDays: number;
  stale: boolean;
  privileged: boolean;
  roles: string[];
}

export interface ReviewMachineIdentity {
  credentialId: number;
  kind: string;
  instanceId: string;
  tradingAccountId: number | null;
  origin: string;
  createdAtUtc: string;
  lastUsedAtUtc: string | null;
  idleDays: number;
  stale: boolean;
}

export interface ReviewApiToken {
  id: number;
  kind: string;
  name: string;
  prefix: string;
  holderAdminUserId: number | null;
  createdAtUtc: string;
  expiresAtUtc: string;
  lastUsedAtUtc: string | null;
  idleDays: number;
  stale: boolean;
  permissions: string[];
}

export interface ReviewRole {
  id: number;
  name: string;
  system: boolean;
  privileged: boolean;
  permissions: string[];
}

export interface AccessReviewSnapshot {
  schema: string;
  tenantId: number;
  tenantName: string | null;
  period: string;
  generatedAtUtc: string;
  staleAfterDays: number;
  people: ReviewPerson[];
  roles: ReviewRole[];
  machineIdentities: ReviewMachineIdentity[];
  apiTokens: ReviewApiToken[];
  serviceAccounts: {
    id: number;
    clientId: string;
    displayName: string;
    active: boolean;
    roles: string[];
    lastUse: string;
  }[];
  findings: ReviewFinding[];
}

export interface AccessReviewCampaignDetail {
  campaign: AccessReviewCampaign;
  snapshot: AccessReviewSnapshot;
}

export type ReleaseComponent = 'engine' | 'console' | 'ea' | 'cme-feed';

export interface ReleaseNoteItem {
  scope: string | null;
  subject: string;
  sha: string | null;
  breaking: boolean;
}

export interface ReleaseNoteSection {
  kind: string;
  title: string;
  items: ReleaseNoteItem[];
}

export interface ReleaseNote {
  id: number;
  component: ReleaseComponent;
  version: string;
  releasedAtUtc: string;
  fromRef: string | null;
  toRef: string;
  commitCount: number;
  summary: string;
  hasBreakingChanges: boolean;
  hasSecurityFixes: boolean;
  sections: ReleaseNoteSection[];
  publishedBy: string;
  publishedAtUtc: string;
}

export interface EvidenceDownload {
  blob: Blob;
  fileName: string;
  sha256: string | null;
  signature: string | null;
  signingKeyId: string | null;
}

/** One published EA build (`GET platform/ea/releases`, `GET onboarding/ea/latest`) — metadata, never the bytes. */
export interface EaReleaseInfo {
  id: number;
  version: string;
  numericVersion: number;
  sha256: string;
  sizeBytes: number;
  builtAtUtc: string | null;
  publishedAtUtc: string;
  publishedBy: string;
  notes: string | null;
  fileName: string;
}

/** One engine process's build (`GET admin/observability/build-skew`). */
export interface RoleBuild {
  role: string;
  buildId: string;
  buildVersion: string;
  buildTimeUtc: string | null;
  hostName: string | null;
  startedAtUtc: string | null;
  lastSeenAtUtc: string | null;
  hoursBehind: number;
}

export interface RoleBuildSkew {
  hasSkew: boolean;
  distinctBuilds: number;
  roles: RoleBuild[];
  staleRoles: string[];
}
