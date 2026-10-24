/**
 * Wire shapes of the terminal connection wizard (engine enterprise onboarding,
 * `docs/api/onboarding-api.md`): `GET onboarding/terminal-setup` and
 * `GET machine/enrollments/{id}/progress` (both `accounts.read`).
 */

export type EaDownloadSource = 'engine' | 'external' | 'none';

/** `GET onboarding/ea/latest` (`accounts.read`): a published EA build, without its bytes. */
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

/** `GET onboarding/ea/download` (`accounts.connect`): the file and what the engine says it is. */
export interface EaDownloadFile {
  blob: Blob;
  fileName: string;
  /** `X-Content-SHA256`, lower-case hex (null when the header was not exposed). */
  sha256: string | null;
  version: string | null;
}

/** `GET onboarding/terminal-setup`. */
export interface TerminalSetup {
  /** The engine API base URL for `InpEngineBaseUrl`; empty = the console's own origin + `apiPath`. */
  engineBaseUrl: string;
  apiPath: string;
  /** An external https link to the EA (.ex5) that overrides the engine's own copy; empty = none. */
  eaDownloadUrl: string;
  /**
   * `engine` = the signed-in download (`GET onboarding/ea/download`), `external` = `eaDownloadUrl`,
   * `none` = nothing published (ask the platform operator).
   */
  eaDownloadSource: EaDownloadSource;
  /** The latest EA build published to the engine, or null. */
  latestEa: EaReleaseInfo | null;
  eaMinimumVersion: string;
  enrollmentTokenInput: string;
  engineUrlInput: string;
  enrollmentTokenHours: number;
  /** Only demo trading accounts may connect (outside House while the platform is demo-only). */
  demoAccountsOnly: boolean;
  /** The demonstration organisation: nothing may be connected at all. */
  showcaseOrganisation: boolean;
  maxTerminals: number | null;
  terminalsInUse: number;
  maxTradingAccounts: number | null;
  heartbeatTimeoutSeconds: number;
}

/**
 * Where one token stands: `waiting-for-terminal`, `refused`, `token-expired`, `token-revoked`,
 * `enrolled`, `signed-in`, `registered`, `connected`, `stale`, `credential-revoked`.
 */
export type EnrollmentStage =
  | 'waiting-for-terminal'
  | 'refused'
  | 'token-expired'
  | 'token-revoked'
  | 'enrolled'
  | 'signed-in'
  | 'registered'
  | 'connected'
  | 'stale'
  | 'credential-revoked'
  | string;

export interface EnrollmentStep {
  /** `token`, `enrolled`, `signed-in`, `registered`, `heartbeat`. */
  key: string;
  title: string;
  /** `done`, `current`, `waiting`, `failed`. */
  state: 'done' | 'current' | 'waiting' | 'failed' | string;
  detail: string | null;
  atUtc: string | null;
}

export interface EnrollmentHint {
  /** `allowlist-4060`, `token-expired`, `refused`, `demo-only`, `clock-skew`, `ea-too-old`, `no-heartbeat`, … */
  code: string;
  title: string;
  text: string;
  /** True: the engine sees this happening now. False: a general check while waiting. */
  observed: boolean;
}

/** `GET machine/enrollments/{id}/progress`. */
export interface EnrollmentProgress {
  tokenId: number;
  label: string;
  tokenStatus: string;
  createdAtUtc: string;
  expiresAtUtc: string;
  stage: EnrollmentStage;
  connected: boolean;
  lastRefusedAtUtc: string | null;
  lastRefusalReason: string | null;
  credentialId: number | null;
  instanceId: string | null;
  credentialLastUsedAtUtc: string | null;
  tradingAccountId: number | null;
  accountLogin: string | null;
  brokerServer: string | null;
  accountType: string | null;
  instanceStatus: string | null;
  lastHeartbeatUtc: string | null;
  secondsSinceHeartbeat: number | null;
  eaVersion: string | null;
  eaState: string | null;
  symbols: string[];
  heartbeatTimeoutSeconds: number;
  serverTimeUtc: string;
  steps: EnrollmentStep[];
  hints: EnrollmentHint[];
}
