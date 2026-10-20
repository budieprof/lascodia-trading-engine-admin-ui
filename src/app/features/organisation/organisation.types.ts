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

// ── Layered settings (engine ConfigOverridesController, ADR-0012 addendum) ───────────────────

/** `Default`, `Platform`, `Tenant`, `Account` or `LegacyAccountKey`. */
export type ConfigSource =
  | 'Default'
  | 'Platform'
  | 'Tenant'
  | 'Account'
  | 'LegacyAccountKey'
  | string;

/** One layer of an effective value, outermost first. */
export interface ConfigLayerValue {
  layer: ConfigSource;
  value: string | null;
  applied: boolean;
  /** Why a stored value was not used ("unset", "looser than the inherited 10…"). */
  note: string | null;
}

/** `Text`, `Bool`, `Int`, `Decimal`, `Enum` or `Json`. */
export type ConfigValueKind = 'Text' | 'Bool' | 'Int' | 'Decimal' | 'Enum' | 'Json' | string;

/** Which direction of a value is the more restrictive one (engine `ConfigTightness`). */
export type ConfigTightness =
  | 'None'
  | 'LowerIsTighter'
  | 'HigherIsTighter'
  | 'FalseIsTighter'
  | 'TrueIsTighter'
  | 'OrderedTightestFirst'
  | 'LowerIsTighterZeroUnlimited'
  | string;

/** `GET /config/effective` entry: a key as the scope runs with it, and where the value came from. */
export interface EffectiveConfigEntry {
  key: string;
  family: string;
  description: string;
  value: string | null;
  source: ConfigSource;
  /** Layers the key may be set at: `Platform`, `Tenant`, `Account`. */
  allowedLayers: string[];
  valueKind: ConfigValueKind;
  allowedValues: string[];
  min: number | null;
  max: number | null;
  tightenOnly: boolean;
  riskSensitive: boolean;
  /** Absent on an engine older than c7-tenant: loosening cannot then be judged before saving. */
  tightness?: ConfigTightness;
  /** What the scope runs with if its own value is removed (absent on an older engine). */
  inheritedValue?: string | null;
  secret: boolean;
  layers: ConfigLayerValue[];
}

export interface EffectiveConfig {
  tenantId: number;
  tradingAccountId: number | null;
  entries: EffectiveConfigEntry[];
}

/** Where an override applies. */
export type OverrideScopeType = 'Tenant' | 'Account';

/** One of the organisation's own values. */
export interface ConfigOverride {
  id: number;
  scopeType: OverrideScopeType | string;
  tradingAccountId: number | null;
  key: string;
  /** `***SET` for a secret. */
  value: string;
  updatedBy: string;
  updatedAtUtc: string;
  reason: string | null;
}

/** A risk-loosening change waiting out the cooling-off period. */
export interface PendingConfigOverride {
  id: number;
  scopeType: OverrideScopeType | string;
  tradingAccountId: number | null;
  key: string;
  /** The change removes the value (the scope inherits again). */
  remove: boolean;
  newValue: string | null;
  oldValue: string | null;
  reason: string;
  requestedAt: string;
  effectiveAt: string;
}

export interface ConfigOverrides {
  overrides: ConfigOverride[];
  pending: PendingConfigOverride[];
}

/** `PUT /config/overrides`. */
export interface SetConfigOverrideBody {
  scopeType: OverrideScopeType;
  tradingAccountId?: number;
  key: string;
  value: string;
  reason?: string;
  /** Break-glass: apply a risk-loosening change now (reason required; audit-flagged). */
  immediate?: boolean;
}

/** `Applied`, `Removed`, `Unchanged` or `QueuedForCoolingOff`. */
export type OverrideOutcome = 'Applied' | 'Removed' | 'Unchanged' | 'QueuedForCoolingOff' | string;

/** The answer to an override write: the envelope plus the outcome fields. */
export interface OverrideWriteResult {
  /** The override's id, or the pending change's when it was queued. */
  id: number;
  outcome: OverrideOutcome | null;
  effectiveAt: string | null;
  pendingChangeId: number | null;
  breakGlass: boolean;
  message: string | null;
}

// ── Kill switches and emergency flatten (engine KillSwitchController, EmergencyFlattenController) ──

/** `Platform`, `Tenant` (the organisation), `Account` or `Strategy`. */
export type KillSwitchScope = 'Platform' | 'Tenant' | 'Account' | 'Strategy' | string;

/** `GET admin/kill-switch/tenant` and `…/account/{id}`. */
export interface ScopedKillSwitchStatus {
  /** This switch is engaged. */
  enabled: boolean;
  reason: string | null;
  changedAt: string | null;
  changedBy: string | null;
  scope: KillSwitchScope;
  /** The switch that halts the scope right now (account → organisation → platform), or null. */
  haltedBy: KillSwitchScope | null;
}

/** One of the organisation's accounts with its kill switch (or why it could not be read). */
export interface AccountSwitchRow {
  account: AccountRef;
  status: ScopedKillSwitchStatus | null;
  error: string | null;
}

// ── Strategy subscriptions (engine StrategySubscriptionsController, StrategyExecutionController) ──

/** One of the organisation's subscriptions: an account bound to a strategy (`GET /strategy/subscriptions`). */
export interface StrategySubscription {
  strategyId: number;
  strategyName: string;
  symbol: string;
  timeframe: string;
  strategyStatus: string;
  /** A platform strategy; false = the organisation's own, private strategy. */
  isPlatform: boolean;
  /** A script strategy: with no enabled subscription it trades on no account at all. */
  isScript: boolean;
  tradingAccountId: number;
  accountName: string;
  accountLogin: string;
  lotMultiplier: number;
  /** False pauses delivery to this account. */
  isEnabled: boolean;
  createdAt: string;
}

export interface StrategySubscriptions {
  /**
   * True: the organisation's accounts receive a strategy's signals only through a subscription of its
   * own (always outside House). False (House by default): a strategy with no House subscription
   * reaches every House account whose EA streams its symbol.
   */
  requireSubscription: boolean;
  subscriptions: StrategySubscription[];
}

/** `Platform` (no owning organisation) or `Private` (the organisation's own). */
export type StrategyOwnership = 'Platform' | 'Private';

/** The fields of the engine's `StrategyDto` the subscriptions page reads (`POST strategy/list`). */
export interface StrategySummary {
  id: number;
  /** The owning organisation; null for a platform strategy (absent on an older engine). */
  tenantId?: number | null;
  name: string | null;
  symbol: string | null;
  timeframe: string;
  status: string;
  authoringMode?: string | null;
}

/** `GET|PUT /strategy/{id}/account-bindings` — the organisation's own set for one strategy. */
export interface StrategyBinding {
  tradingAccountId: number;
  accountName: string;
  lotMultiplier: number;
  isEnabled: boolean;
}

export interface StrategyBindingInput {
  tradingAccountId: number;
  lotMultiplier: number;
  isEnabled: boolean;
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
