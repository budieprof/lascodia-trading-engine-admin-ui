/**
 * Wire types of the engine's audit log API (`/admin/audit-events`, multi-tenancy Phase 1 F1.4).
 * Enums travel by name.
 */

export type AuditActorType = 'User' | 'ServiceAccount' | 'Machine' | 'System' | 'Anonymous';
export type AuditCategory = 'Security' | 'Access' | 'Config' | 'Trading' | 'Data' | 'Platform';
export type AuditOutcome = 'Succeeded' | 'Denied' | 'Failed';

export const AUDIT_ACTOR_TYPES: readonly AuditActorType[] = [
  'User',
  'ServiceAccount',
  'Machine',
  'System',
  'Anonymous',
];
export const AUDIT_CATEGORIES: readonly AuditCategory[] = [
  'Security',
  'Access',
  'Config',
  'Trading',
  'Data',
  'Platform',
];
export const AUDIT_OUTCOMES: readonly AuditOutcome[] = ['Succeeded', 'Denied', 'Failed'];

/** One audit event. `before`/`after` are JSON values (secrets already masked by the engine). */
export interface AuditEventDto {
  id: number;
  occurredAtUtc: string;
  tenantId: number | null;
  actorType: AuditActorType;
  actorId: string;
  actorDisplay: string | null;
  onBehalfOf: string | null;
  sessionId: string | null;
  clientIp: string | null;
  userAgent: string | null;
  action: string;
  category: AuditCategory;
  resourceType: string | null;
  resourceId: string | null;
  outcome: AuditOutcome;
  reason: string | null;
  before: unknown;
  after: unknown;
  correlationId: string | null;
  hash: string | null;
  prevHash: string | null;
  sealedAtUtc: string | null;
}

/** A page, newest first; pass `nextBeforeId` back as `beforeId` for the next (older) page. */
export interface AuditEventPage {
  items: AuditEventDto[];
  nextBeforeId: number | null;
  hasMore: boolean;
}

export interface AuditChainBreak {
  eventId: number;
  problem: 'prev_hash_mismatch' | 'hash_mismatch' | 'unsealed_inside_chain' | string;
  detail: string;
}

/** Result of `GET /admin/audit-events/verify`. */
export interface AuditChainVerification {
  fromId: number | null;
  toId: number | null;
  rowsChecked: number;
  sealedRowsVerified: number;
  pendingUnsealed: number;
  intact: boolean;
  firstBrokenLink: AuditChainBreak | null;
  anchorId: number | null;
  truncated: boolean;
  nextFromId: number | null;
}
