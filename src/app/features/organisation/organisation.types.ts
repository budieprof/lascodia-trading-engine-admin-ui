/**
 * Wire shapes of the organisation console (multi-tenancy Phase 7, c7-tenant). Every call acts in the
 * session's active organisation; the engine enforces each permission and answers the usual
 * `ResponseData` envelope. Field names are the engine's (camelCase).
 */

// ── Machine credentials (engine `MachineController`, EA ADR-0017) ─────────────────────────────

/** What a token connects: one EA on a chart, or an MT5 supervisor daemon. */
export type MachineKind = 'EaTerminal' | 'Daemon';

/** `POST /machine/enrollments`. */
export interface CreateEnrollmentTokenBody {
  kind: MachineKind;
  label: string;
  /** EA only: bind to this account of the organisation. */
  tradingAccountId?: number;
  /** EA only, with `brokerServer`: bind to a broker login (the account may not exist yet). */
  accountLogin?: string;
  brokerServer?: string;
}

/** The answer to a create — the only time the token text is ever shown. */
export interface EnrollmentTokenCreated {
  id: number;
  token: string;
  prefix: string;
  kind: MachineKind | string;
  tradingAccountId: number | null;
  accountLogin: string | null;
  brokerServer: string | null;
  label: string;
  expiresAtUtc: string;
}

/** `Pending`, `Used`, `Expired` or `Revoked`. */
export type EnrollmentTokenStatus = 'Pending' | 'Used' | 'Expired' | 'Revoked' | string;

/** `GET /machine/enrollments` row (never the secret). */
export interface EnrollmentToken {
  id: number;
  prefix: string;
  kind: MachineKind | string;
  label: string;
  tradingAccountId: number | null;
  accountLogin: string | null;
  brokerServer: string | null;
  createdBy: string;
  createdAtUtc: string;
  expiresAtUtc: string;
  usedAtUtc: string | null;
  usedByCredentialId: number | null;
  revokedAtUtc: string | null;
  status: EnrollmentTokenStatus;
}

/** `Enrollment`, `LegacyUpgrade` (moved over from the account API key) or `Child` (a sibling instance). */
export type CredentialOrigin = 'Enrollment' | 'LegacyUpgrade' | 'Child' | string;

/** `GET /machine/credentials` row (never the secret). */
export interface MachineCredential {
  id: number;
  kind: MachineKind | string;
  instanceId: string;
  tradingAccountId: number | null;
  origin: CredentialOrigin;
  createdBy: string;
  createdAtUtc: string;
  /** Sampled: updated at most every few minutes by the token exchange. */
  lastUsedAtUtc: string | null;
  lastUsedIp: string | null;
  rotationRequestedAtUtc: string | null;
  /** A rotated secret was handed out and has not been used yet. */
  rotationPending: boolean;
  replacesCredentialId: number | null;
  parentCredentialId: number | null;
  enrollmentTokenId: number | null;
  terminalFingerprint: string | null;
  revokedAtUtc: string | null;
  revokedReason: string | null;
  revokedBy: string | null;
}

/** The organisation's accounts as the pages name them (from the account list the console already keeps). */
export interface AccountRef {
  id: number;
  /** Broker login. */
  login: string | null;
  name: string | null;
  brokerServer: string | null;
  /** `Demo`, `Real`, `Contest`. */
  accountType: string;
  isPaper: boolean;
}
