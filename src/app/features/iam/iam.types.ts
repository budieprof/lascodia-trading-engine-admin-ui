/**
 * Wire shapes of the identity-and-access API (multi-tenancy W3, contract C3.5). Request bodies follow
 * the contract exactly; response rows list every field the console READS — optional fields degrade
 * to "—" when the engine leaves them out. Everything acts in the session's active organisation.
 *
 * Owners: i3-engine (members, invitations, security policy, SSO, sessions, tokens, SCIM tokens),
 * a4-engine (roles, grants, teams, account groups, explain, approvals, access review, elevation,
 * impersonation). `core/api/_generated/schema.ts` does not have them yet.
 */

export type ScopeType = 'Tenant' | 'AccountGroup' | 'TradingAccount' | 'Strategy';
export const SCOPE_TYPES: readonly ScopeType[] = [
  'Tenant',
  'AccountGroup',
  'TradingAccount',
  'Strategy',
];

export type PrincipalType = 'User' | 'Team' | 'ServiceAccount';
export const PRINCIPAL_TYPES: readonly PrincipalType[] = ['User', 'Team', 'ServiceAccount'];

/** `Invited`, `Active` or `Suspended` (engine `TenantMembershipStatus`). */
export type MemberStatus = 'Invited' | 'Active' | 'Suspended';

// ── Members (C3.5: GET /iam/members, PATCH /iam/members/{userId} {status}, DELETE …) ──

export interface IamMember {
  userId: number;
  username: string;
  displayName?: string | null;
  email?: string | null;
  status: MemberStatus | string;
  joinedAtUtc?: string | null;
  lastSignInAtUtc?: string | null;
  /** Names of the roles the member holds in this organisation (any scope). */
  roles?: string[] | null;
  mfaEnabled?: boolean | null;
}

/** A console session (`GET /iam/members/{userId}/sessions`, `GET /iam/me/sessions`). */
export interface IamSession {
  id: string | number;
  createdAtUtc: string;
  lastSeenAtUtc?: string | null;
  expiresAtUtc?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  /** The session this request came from (own list only). */
  current?: boolean | null;
}

// ── Invitations (C3.5) ──

export interface GrantSpec {
  roleId: number;
  scopeType: ScopeType;
  scopeId: number | null;
}

export interface CreateInvitationBody {
  email: string;
  grants: GrantSpec[];
}

export interface CreateInvitationResult {
  invitationId: number;
  /** Single-use link the inviter passes on — set when the engine could not e-mail it. */
  acceptUrl: string | null;
  /** First-sign-in password of a NEW account the engine created (no e-mail set up yet); shown once. */
  temporaryPassword?: string | null;
}

/** `POST /iam/invitations/accept` — the organisation joined. */
export interface AcceptInvitationResult {
  tenantId: number;
  slug: string;
  name: string;
}

export interface IamInvitation {
  id: number;
  email: string;
  status?: string | null;
  invitedBy?: string | null;
  createdAtUtc?: string | null;
  expiresAtUtc?: string | null;
  grants?: (GrantSpec & { roleName?: string | null })[] | null;
}

// ── Roles (C3.5: GET|POST /iam/roles {name,description,permissions[]}, PUT|DELETE /iam/roles/{id}) ──

export interface IamRole {
  id: number;
  name: string;
  description?: string | null;
  permissions: string[];
  /** System roles (Owner, Admin, Trader, …) are read-only. */
  isSystem: boolean;
  /** A platform-staff role (PlatformAdmin, …): only meaningful in House. */
  platform?: boolean | null;
  /** How many grants use it (delete is refused while any do). */
  assignmentCount?: number | null;
}

export interface SaveRoleBody {
  name: string;
  description: string;
  permissions: string[];
}

// ── Grants (C3.5) ──

export interface IamGrant {
  id: number;
  principalType: PrincipalType | string;
  principalId: number;
  principalName?: string | null;
  roleId: number;
  roleName?: string | null;
  scopeType: ScopeType | string;
  scopeId: number | null;
  scopeName?: string | null;
  expiresAtUtc?: string | null;
  reason?: string | null;
  grantedBy?: string | null;
  grantedAtUtc?: string | null;
  lastUsedAtUtc?: string | null;
}

export interface CreateGrantBody {
  principalType: PrincipalType;
  principalId: number;
  roleId: number;
  scopeType: ScopeType;
  scopeId: number | null;
  expiresAtUtc: string | null;
  reason: string | null;
}

export interface GrantQuery {
  principalType?: PrincipalType | null;
  principalId?: number | null;
  scopeType?: ScopeType | null;
  scopeId?: number | null;
}

/** `GET /iam/explain` — why a principal holds (or lacks) a permission at a scope. */
export interface ExplainResult {
  allowed: boolean;
  via: { grantId: number; roleName: string; scopeType: string; scopeId: number | null }[];
  missingReason: string | null;
}

export interface ExplainQuery {
  principalType: PrincipalType;
  principalId: number;
  permission: string;
  scopeType: ScopeType;
  scopeId: number | null;
}

// ── Teams and account groups (C3.5: CRUD + /members) ──

export interface IamTeam {
  id: number;
  name: string;
  description?: string | null;
  memberCount?: number | null;
}

export interface IamAccountGroup {
  id: number;
  name: string;
  description?: string | null;
  accountCount?: number | null;
}

export interface SaveNamedBody {
  name: string;
  description: string;
}

// ── Security policy and SSO (C3.5) ──

export interface SecurityPolicy {
  mfaRequired: boolean;
  sessionIdleMinutes: number;
  sessionAbsoluteHours: number;
  ipAllowlist: string[];
}

export type SsoProtocol = 'oidc' | 'saml';

/** `GET /iam/sso`. The client secret is write-only: it is never returned. */
export interface SsoConfig {
  protocol: SsoProtocol;
  displayName: string;
  issuerOrMetadataUrl: string;
  clientId: string;
  domains: string[];
  enabled: boolean;
  /** Whether a secret is stored (the secret itself never comes back). */
  hasClientSecret?: boolean | null;
  /** Last time the identity provider was configured in Keycloak, and what went wrong if it failed. */
  lastSyncedAtUtc?: string | null;
  lastSyncError?: string | null;
}

/** `PUT /iam/sso`. `clientSecret` omitted (or null) keeps the stored one. */
export interface SaveSsoBody extends Omit<SsoConfig, 'hasClientSecret'> {
  clientSecret?: string | null;
}

/** SCIM provisioning tokens (`POST|GET|DELETE /iam/scim-tokens`). */
export interface ScimToken {
  id: number;
  name?: string | null;
  prefix: string;
  createdAtUtc?: string | null;
  expiresAtUtc?: string | null;
  lastUsedAtUtc?: string | null;
  /** `Active`, `Revoked` or `Expired`. */
  status?: string | null;
}

// ── Personal access tokens (C3.5: GET|POST /iam/me/tokens, DELETE /iam/me/tokens/{id}) ──

export interface PersonalAccessToken {
  id: number;
  name: string;
  prefix: string;
  permissions: string[];
  createdAtUtc?: string | null;
  expiresAtUtc: string;
  lastUsedAtUtc?: string | null;
  /** `Active`, `Revoked` or `Expired`. */
  status?: string | null;
}

export interface CreateTokenBody {
  name: string;
  permissions: string[];
  expiresInDays: number;
}

/** The token is in this answer ONLY — it is never shown again. */
export interface CreatedToken {
  id: number;
  token: string;
  prefix: string;
  expiresAtUtc: string;
}

// ── Approvals (C3.3 / C3.5: /iam/approvals?status=, POST /{id}/approve|reject) ──

export type ApprovalStatus = 'Pending' | 'Approved' | 'Rejected' | 'Expired' | 'Executed';

export interface ApprovalRequest {
  id: number;
  /** The permission key of the action, e.g. `engine.killswitch.release`. */
  actionKey: string;
  /** What will happen, in words. */
  summary?: string | null;
  requestedBy?: string | null;
  requestedByUserId?: number | null;
  requestedAtUtc?: string | null;
  expiresAtUtc?: string | null;
  status: ApprovalStatus | string;
  decidedBy?: string | null;
  decidedAtUtc?: string | null;
}

// ── Access review (C3.5: GET /iam/access-review, POST /iam/access-review/revoke {grantIds[]}) ──

export interface AccessReviewEntry {
  grantId: number;
  principalType: string;
  principalId: number;
  principalName?: string | null;
  roleName?: string | null;
  scopeType: string;
  scopeId: number | null;
  scopeName?: string | null;
  grantedAtUtc?: string | null;
  lastUsedAtUtc?: string | null;
  /** Unused for the review window (90 days). */
  stale: boolean;
  /** Days since last use (or since granted, never used). */
  idleDays?: number | null;
}

export interface AccessReviewReport {
  generatedAtUtc?: string | null;
  staleAfterDays?: number | null;
  grants: AccessReviewEntry[];
}

// ── Platform (C3.5 platform; t2-core platform/tenants) ──

/** t2-core `TenantDto`. */
export interface TenantDto {
  id: number;
  slug: string;
  name: string;
  kind: 'House' | 'Customer' | 'Canary' | string;
  status: 'Active' | 'Suspended' | 'Closed' | string;
  statusReason?: string | null;
  statusChangedAtUtc?: string | null;
  createdAtUtc?: string | null;
  activeMembers?: number | null;
  contributesToPlatformLearning?: boolean | null;
}

export interface CreateTenantBody {
  slug: string;
  name: string;
  kind: 'Customer' | 'Canary';
  contributesToPlatformLearning: boolean;
}

export type ElevationStatus = 'Pending' | 'Active' | 'Ended' | 'Expired' | 'Rejected';

export interface AccessElevation {
  id: number;
  staffUserId?: number | null;
  staffName?: string | null;
  tenantId: number;
  tenantName?: string | null;
  reason: string;
  permissions: string[];
  minutes?: number | null;
  requestedAtUtc?: string | null;
  startsAtUtc?: string | null;
  endsAtUtc?: string | null;
  approvedBy?: string | null;
  status: ElevationStatus | string;
}

export interface RequestElevationBody {
  tenantId: number;
  reason: string;
  minutes: number;
  permissions: string[];
}

export interface StartImpersonationBody {
  userId: number;
  tenantId: number;
  readOnly: true;
  /** Recorded in the organisation's audit log. */
  reason?: string | null;
}

/** Most elevated access may last (C3.5: minutes ≤ 240). */
export const MAX_ELEVATION_MINUTES = 240;
