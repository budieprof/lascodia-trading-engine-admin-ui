/**
 * Engine DTOs → the shapes the pages use, in one place. The identity-and-access API (contract C3.5)
 * was built in parallel by i3-engine and a4-engine; their DTOs name a few fields differently from
 * the contract's prose (`adminUserId`, `permissionKeys`, `memberAdminUserIds`, `clientSecretSet`, a
 * review entry wrapping its grant, …). Each adapter accepts both the engine's names and the plain
 * ones, so a later rename on either side changes one function, not ten pages.
 */
import type {
  AccessElevation,
  AccessReviewEntry,
  AccessReviewReport,
  ApprovalRequest,
  IamGrant,
  IamInvitation,
  IamMember,
  IamRole,
  IamSession,
  PersonalAccessToken,
  ScimToken,
  ScopeType,
  SsoConfig,
} from './iam.types';

type Raw = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const numbers = (v: unknown): number[] =>
  Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number') : [];
const byId = (prefix: string, id: number | null) => (id === null ? null : `${prefix} #${id}`);

/** i3-engine `IamMemberDto` (`adminUserId`, `lastLoginAtUtc`). */
export function toMember(r: Raw): IamMember {
  return {
    userId: num(r['userId']) ?? num(r['adminUserId']) ?? 0,
    username: str(r['username']) ?? '',
    displayName: str(r['displayName']),
    email: str(r['email']),
    status: str(r['status']) ?? 'Active',
    joinedAtUtc: str(r['joinedAtUtc']),
    lastSignInAtUtc: str(r['lastSignInAtUtc']) ?? str(r['lastLoginAtUtc']),
    roles: Array.isArray(r['roles']) ? strings(r['roles']) : null,
    mfaEnabled: bool(r['mfaEnabled']),
    signsInWithIdentityProvider: bool(r['signsInWithIdentityProvider']),
  };
}

/** i3-engine `InvitationDto` (`invitedByAdminUserId`). */
export function toInvitation(r: Raw): IamInvitation {
  const grants = Array.isArray(r['grants']) ? (r['grants'] as Raw[]) : [];
  return {
    id: num(r['id']) ?? 0,
    email: str(r['email']) ?? '',
    status: str(r['status']),
    invitedBy: str(r['invitedBy']) ?? byId('User', num(r['invitedByAdminUserId'])),
    createdAtUtc: str(r['createdAtUtc']),
    expiresAtUtc: str(r['expiresAtUtc']),
    grants: grants.map((g) => ({
      roleId: num(g['roleId']) ?? 0,
      roleName: str(g['roleName']),
      scopeType: (str(g['scopeType']) ?? 'Tenant') as ScopeType,
      scopeId: num(g['scopeId']),
    })),
  };
}

/** a4-engine `RoleDto` (`permissionKeys`, `userCount`). */
export function toRole(r: Raw): IamRole {
  return {
    id: num(r['id']) ?? 0,
    name: str(r['name']) ?? '',
    description: str(r['description']),
    permissions: strings(r['permissions'] ?? r['permissionKeys']),
    isSystem: bool(r['isSystem']) ?? false,
    platform: bool(r['platform']),
    assignmentCount: num(r['assignmentCount']) ?? num(r['userCount']),
  };
}

/** a4-engine `GrantDto` (`grantedByAdminUserId`). */
export function toGrant(r: Raw): IamGrant {
  return {
    id: num(r['id']) ?? 0,
    principalType: str(r['principalType']) ?? 'User',
    principalId: num(r['principalId']) ?? 0,
    principalName: str(r['principalName']),
    roleId: num(r['roleId']) ?? 0,
    roleName: str(r['roleName']),
    scopeType: str(r['scopeType']) ?? 'Tenant',
    scopeId: num(r['scopeId']),
    scopeName: str(r['scopeName']),
    expiresAtUtc: str(r['expiresAtUtc']),
    reason: str(r['reason']),
    grantedBy: str(r['grantedBy']) ?? byId('User', num(r['grantedByAdminUserId'])),
    grantedAtUtc: str(r['grantedAtUtc']),
    lastUsedAtUtc: str(r['lastUsedAtUtc']),
  };
}

/** Member ids of a team (`memberAdminUserIds`) or account ids of a group (`tradingAccountIds`). */
export function memberIds(
  r: Raw | null | undefined,
  field: 'memberAdminUserIds' | 'tradingAccountIds',
): number[] {
  return r ? numbers(r[field]) : [];
}

/** a4-engine `AccessReviewDto`: each entry wraps its grant (`{ grant, stale, idleDays }`). */
export function toAccessReview(r: Raw | null | undefined): AccessReviewReport {
  const entries = Array.isArray(r?.['grants']) ? (r!['grants'] as Raw[]) : [];
  return {
    generatedAtUtc: str(r?.['generatedAtUtc']),
    staleAfterDays: num(r?.['staleAfterDays']),
    grants: entries.map((e): AccessReviewEntry => {
      const g =
        e['grant'] && typeof e['grant'] === 'object' ? toGrant(e['grant'] as Raw) : toGrant(e);
      return {
        grantId: num(e['grantId']) ?? g.id,
        principalType: g.principalType,
        principalId: g.principalId,
        principalName: g.principalName,
        roleName: g.roleName,
        scopeType: g.scopeType,
        scopeId: g.scopeId,
        scopeName: g.scopeName,
        grantedAtUtc: g.grantedAtUtc,
        lastUsedAtUtc: g.lastUsedAtUtc,
        stale: bool(e['stale']) ?? false,
        idleDays: num(e['idleDays']),
      };
    }),
  };
}

/** The admin-user id in an actor string such as `7` or `admin:7`; null for anything else. */
export function actorUserId(actor: string | null): number | null {
  const m = actor ? /^(?:[a-z]+[:/-])?(\d+)$/i.exec(actor.trim()) : null;
  return m ? Number(m[1]) : null;
}

/** a4-engine `ApprovalDto` (`requestedBy` = actor id, `requestedByDisplay` = name). */
export function toApproval(r: Raw): ApprovalRequest {
  const requestedBy = str(r['requestedBy']);
  return {
    id: num(r['id']) ?? 0,
    actionKey: str(r['actionKey']) ?? '',
    summary: str(r['summary']),
    requestedBy: str(r['requestedByDisplay']) ?? requestedBy,
    requestedByUserId: num(r['requestedByUserId']) ?? actorUserId(requestedBy),
    requestedAtUtc: str(r['requestedAtUtc']),
    expiresAtUtc: str(r['expiresAtUtc']),
    status: str(r['status']) ?? 'Pending',
    decidedBy: str(r['decidedByDisplay']) ?? str(r['decidedBy']),
    decidedAtUtc: str(r['decidedAtUtc']),
    policyKind: str(r['policyKind']),
    requiredApprovals: num(r['requiredApprovals']) ?? 1,
    approverRoles: Array.isArray(r['approverRoles'])
      ? (r['approverRoles'] as unknown[]).filter((x): x is string => typeof x === 'string')
      : [],
    approvals: Array.isArray(r['approvals'])
      ? (r['approvals'] as Raw[]).map((a) => ({
          decidedBy: str(a['decidedByDisplay']) ?? str(a['decidedBy']) ?? '',
          decidedAtUtc: str(a['decidedAtUtc']),
          note: str(a['note']),
          qualifyingRole: str(a['qualifyingRole']),
        }))
      : [],
  };
}

/** a4-engine `ElevationDto` (`staffAdminUserId`, `approvedByAdminUserId`). */
export function toElevation(r: Raw): AccessElevation {
  return {
    id: num(r['id']) ?? 0,
    staffUserId: num(r['staffUserId']) ?? num(r['staffAdminUserId']),
    staffName: str(r['staffName']) ?? byId('Staff', num(r['staffAdminUserId'])),
    tenantId: num(r['tenantId']) ?? 0,
    tenantName: str(r['tenantName']),
    reason: str(r['reason']) ?? '',
    permissions: strings(r['permissions']),
    minutes: num(r['minutes']),
    requestedAtUtc: str(r['requestedAtUtc']),
    startsAtUtc: str(r['startsAtUtc']),
    endsAtUtc: str(r['endedAtUtc']) ?? str(r['endsAtUtc']),
    approvedBy: str(r['approvedBy']) ?? byId('Staff', num(r['approvedByAdminUserId'])),
    status: str(r['status']) ?? 'Pending',
  };
}

/** i3-engine `SsoConnectionDto` (`clientSecretSet`); null when none is configured. */
export function toSso(r: Raw | null | undefined): SsoConfig | null {
  if (!r) return null;
  return {
    protocol: str(r['protocol'])?.toLowerCase() === 'saml' ? 'saml' : 'oidc',
    displayName: str(r['displayName']) ?? '',
    issuerOrMetadataUrl: str(r['issuerOrMetadataUrl']) ?? '',
    clientId: str(r['clientId']) ?? '',
    domains: strings(r['domains']),
    enabled: bool(r['enabled']) ?? false,
    hasClientSecret: bool(r['hasClientSecret']) ?? bool(r['clientSecretSet']),
    lastSyncedAtUtc: str(r['lastSyncedAtUtc']),
    lastSyncError: str(r['lastSyncError']),
  };
}

/** i3-engine `ApiTokenDto` (personal and SCIM tokens). */
export function toToken(r: Raw): PersonalAccessToken & ScimToken {
  return {
    id: num(r['id']) ?? 0,
    name: str(r['name']) ?? '',
    prefix: str(r['prefix']) ?? '',
    permissions: strings(r['permissions']),
    createdAtUtc: str(r['createdAtUtc']),
    expiresAtUtc: str(r['expiresAtUtc']) ?? '',
    lastUsedAtUtc: str(r['lastUsedAtUtc']),
    status: str(r['status']) ?? (str(r['revokedAtUtc']) ? 'Revoked' : 'Active'),
  };
}

/** i3-engine `SessionDto` (string ids). */
export function toSession(r: Raw): IamSession {
  return {
    id: str(r['id']) ?? num(r['id']) ?? '',
    createdAtUtc: str(r['createdAtUtc']) ?? '',
    lastSeenAtUtc: str(r['lastSeenAtUtc']),
    expiresAtUtc: str(r['expiresAtUtc']),
    ipAddress: str(r['ipAddress']),
    userAgent: str(r['userAgent']),
    current: bool(r['current']) ?? false,
  };
}
