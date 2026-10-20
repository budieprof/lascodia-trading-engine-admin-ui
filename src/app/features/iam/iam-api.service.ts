import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';

import { ApiService } from '@core/api/api.service';
import { ApiError, type ResponseData } from '@core/api/api.types';
import type { PermissionDefinition } from '@core/auth/permissions.generated';
import {
  memberIds,
  toAccessReview,
  toApproval,
  toElevation,
  toGrant,
  toInvitation,
  toMember,
  toRole,
  toSession,
  toSso,
  toToken,
} from './iam-adapters';
import type {
  AcceptInvitationResult,
  AccessElevation,
  AccessReviewReport,
  ApprovalRequest,
  ApprovalStatus,
  CreateGrantBody,
  CreateInvitationBody,
  CreateInvitationResult,
  CreateTenantBody,
  CreateTokenBody,
  CreatedToken,
  ExplainQuery,
  ExplainResult,
  GrantQuery,
  IamAccountGroup,
  IamGrant,
  IamInvitation,
  IamMember,
  IamRole,
  IamSession,
  IamTeam,
  MemberStatus,
  PersonalAccessToken,
  RequestElevationBody,
  SaveNamedBody,
  SaveRoleBody,
  SaveSsoBody,
  ScimToken,
  SecurityPolicy,
  SsoConfig,
  StartImpersonationBody,
  TenantDto,
} from './iam.types';

const SILENT = { silent: true } as const;

type Raw = Record<string, unknown>;

/**
 * Rows of a list answer, whatever list shape the engine chose: a bare array, a paged
 * `{ data: [] }`, or `{ items: [] }`. Anything else is an empty list, not a crash.
 */
export function rows<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === 'object') {
    const o = data as { data?: unknown; items?: unknown };
    if (Array.isArray(o.data)) return o.data as T[];
    if (Array.isArray(o.items)) return o.items as T[];
  }
  return [];
}

/** A query string from the set fields (null / undefined / '' left out). */
export function queryString(
  params: Record<string, string | number | boolean | null | undefined>,
): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === '') continue;
    q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

/** Unwraps an envelope whose `data` may legitimately be null (deletes, revokes); throws on refusal. */
function settled<T>(source: Observable<ResponseData<T>>): Observable<T> {
  return source.pipe(
    map((res) => {
      if (!res || res.status !== true) {
        throw new ApiError(res?.responseCode ?? 'UNKNOWN', res?.message ?? 'Request failed', res);
      }
      return res.data as T;
    }),
  );
}

/**
 * The identity-and-access API (contract C3.5) for the organisation screens, "Your account" and the
 * platform console. Every call acts in the session's active organisation; the engine enforces each
 * permission (and StepUp / TwoPerson, which the HTTP interceptors handle).
 */
@Injectable({ providedIn: 'root' })
export class IamApiService {
  private readonly api = inject(ApiService);

  // Silent: the pages say what went wrong themselves (inline for loads, a toast for actions), so the
  // interceptor's generic toast would only double it. Session handling (sign-in again, step-up,
  // CSRF refresh) still applies.
  private get<T>(path: string): Observable<T> {
    return settled(this.api.get<ResponseData<T>>(path, SILENT));
  }
  private post<T>(path: string, body: unknown = {}): Observable<T> {
    return settled(this.api.post<ResponseData<T>>(path, body, SILENT));
  }
  private put<T>(path: string, body: unknown): Observable<T> {
    return settled(this.api.put<ResponseData<T>>(path, body, SILENT));
  }
  private patch<T>(path: string, body: unknown): Observable<T> {
    return settled(this.api.patch<ResponseData<T>>(path, body, SILENT));
  }
  private del<T>(path: string): Observable<T> {
    return settled(this.api.delete<ResponseData<T>>(path, SILENT));
  }
  private list<T>(path: string): Observable<T[]> {
    return this.get<unknown>(path).pipe(map((d) => rows<T>(d)));
  }

  // ── Permission catalog (C3.4) ──
  permissionCatalog(): Observable<PermissionDefinition[]> {
    return this.list<PermissionDefinition>('/admin/permissions/catalog');
  }

  // ── Members ──
  members(): Observable<IamMember[]> {
    return this.list<Raw>('/iam/members').pipe(map((rs) => rs.map(toMember)));
  }
  setMemberStatus(userId: number, status: MemberStatus): Observable<unknown> {
    return this.patch(`/iam/members/${userId}`, { status });
  }
  removeMember(userId: number): Observable<unknown> {
    return this.del(`/iam/members/${userId}`);
  }
  memberSessions(userId: number): Observable<IamSession[]> {
    return this.list<Raw>(`/iam/members/${userId}/sessions`).pipe(map((rs) => rs.map(toSession)));
  }
  endMemberSessions(userId: number): Observable<unknown> {
    return this.del(`/iam/members/${userId}/sessions`);
  }

  // ── Invitations ──
  invitations(): Observable<IamInvitation[]> {
    return this.list<Raw>('/iam/invitations').pipe(map((rs) => rs.map(toInvitation)));
  }
  invite(body: CreateInvitationBody): Observable<CreateInvitationResult> {
    return this.post<CreateInvitationResult>('/iam/invitations', body);
  }
  revokeInvitation(id: number): Observable<unknown> {
    return this.del(`/iam/invitations/${id}`);
  }
  acceptInvitation(token: string): Observable<AcceptInvitationResult | null> {
    return this.post<AcceptInvitationResult | null>('/iam/invitations/accept', { token });
  }

  // ── Roles ──
  roles(): Observable<IamRole[]> {
    return this.list<Raw>('/iam/roles').pipe(map((rs) => rs.map(toRole)));
  }
  createRole(body: SaveRoleBody): Observable<IamRole | null> {
    return this.post<Raw | null>('/iam/roles', body).pipe(map((r) => (r ? toRole(r) : null)));
  }
  updateRole(id: number, body: SaveRoleBody): Observable<unknown> {
    return this.put(`/iam/roles/${id}`, body);
  }
  deleteRole(id: number): Observable<unknown> {
    return this.del(`/iam/roles/${id}`);
  }

  // ── Grants ──
  grants(query: GrantQuery = {}): Observable<IamGrant[]> {
    return this.list<Raw>(`/iam/grants${queryString({ ...query })}`).pipe(
      map((rs) => rs.map(toGrant)),
    );
  }
  createGrant(body: CreateGrantBody): Observable<unknown> {
    return this.post('/iam/grants', body);
  }
  revokeGrant(id: number): Observable<unknown> {
    return this.del(`/iam/grants/${id}`);
  }
  explain(q: ExplainQuery): Observable<ExplainResult> {
    return this.get<ExplainResult>(`/iam/explain${queryString({ ...q })}`);
  }

  // ── Teams ──
  teams(): Observable<IamTeam[]> {
    return this.list<Raw>('/iam/teams').pipe(
      map((rs) =>
        rs.map((t) => ({
          id: Number(t['id']),
          name: String(t['name'] ?? ''),
          description: (t['description'] as string | null) ?? null,
          memberCount: Array.isArray(t['memberAdminUserIds'])
            ? t['memberAdminUserIds'].length
            : ((t['memberCount'] as number | null) ?? null),
        })),
      ),
    );
  }
  createTeam(body: SaveNamedBody): Observable<IamTeam> {
    return this.post<IamTeam>('/iam/teams', { ...body, memberAdminUserIds: [] });
  }
  updateTeam(id: number, body: SaveNamedBody): Observable<unknown> {
    return this.put(`/iam/teams/${id}`, { id, ...body });
  }
  deleteTeam(id: number): Observable<unknown> {
    return this.del(`/iam/teams/${id}`);
  }
  /** Admin-user ids in the team (`GET /iam/teams/{id}/members` answers the team). */
  teamMemberIds(id: number): Observable<number[]> {
    return this.get<Raw | null>(`/iam/teams/${id}/members`).pipe(
      map((t) => memberIds(t, 'memberAdminUserIds')),
    );
  }
  addTeamMember(id: number, userId: number): Observable<unknown> {
    return this.post(`/iam/teams/${id}/members`, { adminUserIds: [userId] });
  }
  removeTeamMember(id: number, userId: number): Observable<unknown> {
    return this.del(`/iam/teams/${id}/members/${userId}`);
  }

  // ── Account groups ──
  accountGroups(): Observable<IamAccountGroup[]> {
    return this.list<Raw>('/iam/account-groups').pipe(
      map((rs) =>
        rs.map((g) => ({
          id: Number(g['id']),
          name: String(g['name'] ?? ''),
          description: (g['description'] as string | null) ?? null,
          accountCount: Array.isArray(g['tradingAccountIds'])
            ? g['tradingAccountIds'].length
            : ((g['accountCount'] as number | null) ?? null),
        })),
      ),
    );
  }
  createAccountGroup(body: SaveNamedBody): Observable<IamAccountGroup> {
    return this.post<IamAccountGroup>('/iam/account-groups', { ...body, tradingAccountIds: [] });
  }
  updateAccountGroup(id: number, body: SaveNamedBody): Observable<unknown> {
    return this.put(`/iam/account-groups/${id}`, { id, ...body });
  }
  deleteAccountGroup(id: number): Observable<unknown> {
    return this.del(`/iam/account-groups/${id}`);
  }
  /** Trading-account ids in the group (`GET /iam/account-groups/{id}/members` answers the group). */
  accountGroupMemberIds(id: number): Observable<number[]> {
    return this.get<Raw | null>(`/iam/account-groups/${id}/members`).pipe(
      map((g) => memberIds(g, 'tradingAccountIds')),
    );
  }
  addAccountGroupMember(id: number, tradingAccountId: number): Observable<unknown> {
    return this.post(`/iam/account-groups/${id}/members`, {
      tradingAccountIds: [tradingAccountId],
    });
  }
  removeAccountGroupMember(id: number, tradingAccountId: number): Observable<unknown> {
    return this.del(`/iam/account-groups/${id}/members/${tradingAccountId}`);
  }

  // ── Security policy and SSO ──
  securityPolicy(): Observable<SecurityPolicy> {
    return this.get<SecurityPolicy>('/iam/security-policy');
  }
  saveSecurityPolicy(body: SecurityPolicy): Observable<unknown> {
    return this.put('/iam/security-policy', body);
  }
  sso(): Observable<SsoConfig | null> {
    return this.get<Raw | null>('/iam/sso').pipe(map((r) => toSso(r)));
  }
  saveSso(body: SaveSsoBody): Observable<unknown> {
    return this.put('/iam/sso', body);
  }
  scimTokens(): Observable<ScimToken[]> {
    return this.list<Raw>('/iam/scim-tokens').pipe(map((rs) => rs.map(toToken)));
  }
  createScimToken(name: string, expiresInDays: number): Observable<CreatedToken> {
    return this.post<CreatedToken>('/iam/scim-tokens', { name, expiresInDays });
  }
  revokeScimToken(id: number): Observable<unknown> {
    return this.del(`/iam/scim-tokens/${id}`);
  }

  // ── Your account ──
  mySessions(): Observable<IamSession[]> {
    return this.list<Raw>('/iam/me/sessions').pipe(map((rs) => rs.map(toSession)));
  }
  endMySession(id: string | number): Observable<unknown> {
    return this.del(`/iam/me/sessions/${encodeURIComponent(String(id))}`);
  }
  endMyOtherSessions(): Observable<unknown> {
    return this.del('/iam/me/sessions');
  }
  myTokens(): Observable<PersonalAccessToken[]> {
    return this.list<Raw>('/iam/me/tokens').pipe(map((rs) => rs.map(toToken)));
  }
  createMyToken(body: CreateTokenBody): Observable<CreatedToken> {
    return this.post<CreatedToken>('/iam/me/tokens', body);
  }
  revokeMyToken(id: number): Observable<unknown> {
    return this.del(`/iam/me/tokens/${id}`);
  }

  // ── Approvals ──
  approvals(status: ApprovalStatus | null = 'Pending'): Observable<ApprovalRequest[]> {
    return this.list<Raw>(`/iam/approvals${queryString({ status })}`).pipe(
      map((rs) => rs.map(toApproval)),
    );
  }
  approve(id: number, note: string | null = null): Observable<unknown> {
    return this.post(`/iam/approvals/${id}/approve`, { note });
  }
  reject(id: number, note: string | null): Observable<unknown> {
    return this.post(`/iam/approvals/${id}/reject`, { note });
  }

  // ── Access review ──
  accessReview(): Observable<AccessReviewReport> {
    return this.get<Raw | null>('/iam/access-review').pipe(map((r) => toAccessReview(r)));
  }
  revokeReviewed(grantIds: number[], reason: string | null = null): Observable<unknown> {
    return this.post('/iam/access-review/revoke', { grantIds, reason });
  }

  // ── Platform console ──
  tenants(search?: string): Observable<TenantDto[]> {
    return this.list<TenantDto>(`/platform/tenants${queryString({ search })}`);
  }
  createTenant(body: CreateTenantBody): Observable<TenantDto> {
    return this.post<TenantDto>('/platform/tenants', body);
  }
  suspendTenant(id: number, reason: string): Observable<TenantDto> {
    return this.post<TenantDto>(`/platform/tenants/${id}/suspend`, { reason });
  }
  reactivateTenant(id: number, reason: string | null): Observable<TenantDto> {
    return this.post<TenantDto>(`/platform/tenants/${id}/reactivate`, { reason });
  }
  tenantMembers(id: number): Observable<IamMember[]> {
    return this.list<{
      adminUserId: number;
      username: string;
      displayName?: string;
      email?: string;
      status: string;
    }>(`/platform/tenants/${id}/members`).pipe(
      map((list) =>
        list.map((m) => ({
          userId: m.adminUserId,
          username: m.username,
          displayName: m.displayName ?? null,
          email: m.email ?? null,
          status: m.status,
        })),
      ),
    );
  }
  elevations(): Observable<AccessElevation[]> {
    return this.list<Raw>('/platform/elevations').pipe(map((rs) => rs.map(toElevation)));
  }
  requestElevation(body: RequestElevationBody): Observable<unknown> {
    // Changes while impersonating are never asked for from the console: read-only is the default.
    return this.post('/platform/elevations', { ...body, allowImpersonationWrites: false });
  }
  approveElevation(id: number): Observable<unknown> {
    return this.post(`/platform/elevations/${id}/approve`, { id, note: null });
  }
  endElevation(id: number): Observable<unknown> {
    return this.post(`/platform/elevations/${id}/end`);
  }
  startImpersonation(body: StartImpersonationBody): Observable<unknown> {
    return this.post('/platform/impersonation', body);
  }
  endImpersonation(): Observable<unknown> {
    return this.del('/platform/impersonation');
  }
}
