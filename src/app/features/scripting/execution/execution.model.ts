import type { TradingAccountDto } from '@core/api/api.types';

import {
  MAX_LOT_MULTIPLIER,
  type ExecutionPolicy,
  type StrategyAccountBinding,
  type StrategyAccountBindingInput,
} from '../api/scripting-api.types';

/**
 * Account bindings and execution policy — the rules behind the live-capital UI, kept pure so
 * every safety property is unit-tested.
 *
 * Engine semantics (ADR-0027 DEC-05/06, `StrategyAccountRouting.Decide`):
 * - no binding rows → a script strategy trades on NO account (emulator / paper only); any other
 *   strategy fans out to every account whose EA streams its symbol;
 * - any binding row → the strategy trades ONLY on the ENABLED bound accounts, lots × multiplier;
 *   disabling every row pauses live delivery (it never widens back to the fleet).
 */

/** Where an account's money lives. UNKNOWN (unlisted / deleted account) is treated as real. */
export type AccountEnvironment = 'REAL' | 'DEMO' | 'CONTEST' | 'PAPER' | 'UNKNOWN';

export function accountEnvironment(a: TradingAccountDto | null | undefined): AccountEnvironment {
  if (!a) return 'UNKNOWN';
  if (a.isPaper) return 'PAPER';
  switch (a.accountType) {
    case 'Real':
      return 'REAL';
    case 'Demo':
      return 'DEMO';
    case 'Contest':
      return 'CONTEST';
    default:
      return 'UNKNOWN';
  }
}

/**
 * Real money can be at stake: a REAL account, or one the console cannot classify (it is gone from
 * the accounts list, or its type is unknown). Fail closed — the gate asks for confirmation.
 */
export function isLiveMoney(env: AccountEnvironment): boolean {
  return env === 'REAL' || env === 'UNKNOWN';
}

export const ENVIRONMENT_LABELS: Record<AccountEnvironment, string> = {
  REAL: 'REAL',
  DEMO: 'DEMO',
  CONTEST: 'CONTEST',
  PAPER: 'PAPER',
  UNKNOWN: 'UNVERIFIED',
};

export const ENVIRONMENT_HINTS: Record<AccountEnvironment, string> = {
  REAL: 'Real-money broker account',
  DEMO: 'Broker demo account — no real money',
  CONTEST: 'Broker contest account — no real money',
  PAPER: 'Paper account — simulated fills inside the engine',
  UNKNOWN: 'Not in the accounts list — treated as real money',
};

export interface BindingRow {
  tradingAccountId: number;
  accountName: string;
  /** Broker login (MT5 account number), when known. */
  accountNumber: string | null;
  brokerName: string | null;
  currency: string | null;
  environment: AccountEnvironment;
  lotMultiplier: number;
  isEnabled: boolean;
  /** The row as last saved; null for a binding added in this edit. */
  saved: { lotMultiplier: number; isEnabled: boolean } | null;
}

export function describeAccount(
  accountId: number,
  account: TradingAccountDto | null | undefined,
  fallbackName = '',
): Pick<BindingRow, 'accountName' | 'accountNumber' | 'brokerName' | 'currency' | 'environment'> {
  return {
    accountName:
      (account?.accountName ?? '').trim() || fallbackName.trim() || `Account #${accountId}`,
    accountNumber: account?.accountId?.trim() || null,
    brokerName: account?.brokerName?.trim() || null,
    currency: account?.currency?.trim() || null,
    environment: accountEnvironment(account),
  };
}

/** Merges the engine's bindings with the accounts list (for type, number, broker). */
export function toBindingRows(
  bindings: readonly StrategyAccountBinding[],
  accounts: readonly TradingAccountDto[],
): BindingRow[] {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  return bindings.map((b) => ({
    tradingAccountId: b.tradingAccountId,
    ...describeAccount(b.tradingAccountId, byId.get(b.tradingAccountId), b.accountName),
    lotMultiplier: Number(b.lotMultiplier),
    isEnabled: b.isEnabled,
    saved: { lotMultiplier: Number(b.lotMultiplier), isEnabled: b.isEnabled },
  }));
}

/**
 * What the operator must type to bind or enable a live-money account: the account number
 * (broker login), or the account name. Both are accepted; the number is what the dialog asks for.
 */
export function confirmationTargets(
  row: Pick<BindingRow, 'accountNumber' | 'accountName' | 'tradingAccountId'>,
): string[] {
  const targets = [row.accountNumber, row.accountName].filter(
    (t): t is string => typeof t === 'string' && t.trim().length > 0,
  );
  // An account the console cannot see still has an id the operator can read on screen.
  return targets.length > 0 ? targets : [String(row.tradingAccountId)];
}

function normalisePhrase(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** True when `typed` names one of the accepted targets (whitespace / case insensitive). */
export function matchesConfirmation(typed: string, targets: readonly string[]): boolean {
  const t = normalisePhrase(typed);
  return t.length > 0 && targets.some((x) => normalisePhrase(x) === t);
}

export type BindingAction = 'bind' | 'enable';

/** Binding — or enabling — a live-money account needs the typed confirmation. */
export function requiresTypedConfirmation(row: Pick<BindingRow, 'environment'>): boolean {
  return isLiveMoney(row.environment);
}

/**
 * Rows that would start (or keep) live-money delivery without a confirmation from this edit
 * session: a live-money binding that is new, or was saved disabled and is now enabled. The save
 * refuses while this is non-empty — the dialog is the normal path, this is the backstop.
 */
export function unconfirmedLiveChanges(
  rows: readonly BindingRow[],
  confirmedAccountIds: ReadonlySet<number>,
): BindingRow[] {
  return rows.filter((r) => {
    if (!isLiveMoney(r.environment) || confirmedAccountIds.has(r.tradingAccountId)) return false;
    if (r.saved === null) return true;
    return r.isEnabled && !r.saved.isEnabled;
  });
}

export function validateMultiplier(v: unknown): string | null {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return 'Enter a number.';
  if (n <= 0) return 'Must be greater than 0.';
  if (n > MAX_LOT_MULTIPLIER) return `Cannot exceed ${MAX_LOT_MULTIPLIER}.`;
  return null;
}

/** Problems that block saving the set (besides unconfirmed live-money changes). */
export function validateBindingSet(rows: readonly BindingRow[]): string[] {
  const errors: string[] = [];
  const seen = new Set<number>();
  for (const r of rows) {
    if (seen.has(r.tradingAccountId)) errors.push(`${r.accountName} is bound twice.`);
    seen.add(r.tradingAccountId);
    const m = validateMultiplier(r.lotMultiplier);
    if (m) errors.push(`${r.accountName}: lot multiplier ${m.toLowerCase()}`);
  }
  return errors;
}

/** The PUT body — the complete replacement set. */
export function toBindingInputs(rows: readonly BindingRow[]): StrategyAccountBindingInput[] {
  return rows.map((r) => ({
    tradingAccountId: r.tradingAccountId,
    lotMultiplier: Number(r.lotMultiplier),
    isEnabled: r.isEnabled,
  }));
}

export interface BindingChange {
  kind: 'added' | 'removed' | 'enabled' | 'disabled' | 'multiplier';
  row: BindingRow;
  from?: number;
  to?: number;
}

/** What saving would change, row by row, against the last saved set. */
export function diffBindings(
  saved: readonly BindingRow[],
  current: readonly BindingRow[],
): BindingChange[] {
  const changes: BindingChange[] = [];
  const currentIds = new Set(current.map((r) => r.tradingAccountId));
  for (const r of current) {
    if (r.saved === null) {
      changes.push({ kind: 'added', row: r });
      continue;
    }
    if (r.isEnabled !== r.saved.isEnabled) {
      changes.push({ kind: r.isEnabled ? 'enabled' : 'disabled', row: r });
    }
    if (Number(r.lotMultiplier) !== Number(r.saved.lotMultiplier)) {
      changes.push({
        kind: 'multiplier',
        row: r,
        from: r.saved.lotMultiplier,
        to: r.lotMultiplier,
      });
    }
  }
  for (const r of saved) {
    if (!currentIds.has(r.tradingAccountId)) changes.push({ kind: 'removed', row: r });
  }
  return changes;
}

export type DeliveryMode = 'paper-only' | 'unrestricted' | 'paused' | 'restricted';

export interface DeliveryEffect {
  mode: DeliveryMode;
  /** Plain-language consequence of this binding set. */
  summary: string;
  /** Accounts the strategy would trade on (restricted mode). */
  liveRows: BindingRow[];
  /** True when real money can be reached (a live-money account, or the unrestricted fan-out). */
  touchesRealMoney: boolean;
}

/** What a binding set means for live trading, in the engine's routing terms. */
export function deliveryEffect(
  rows: readonly BindingRow[],
  isScript: boolean,
  symbol: string | null,
): DeliveryEffect {
  if (rows.length === 0) {
    return isScript
      ? {
          mode: 'paper-only',
          summary:
            'No account is bound, so this script strategy trades on no account — it runs in the emulator / paper only.',
          liveRows: [],
          touchesRealMoney: false,
        }
      : {
          mode: 'unrestricted',
          summary: `No account is bound, so signals fan out to every account whose EA streams ${symbol || 'the symbol'} — including REAL accounts.`,
          liveRows: [],
          touchesRealMoney: true,
        };
  }
  const live = rows.filter((r) => r.isEnabled && r.lotMultiplier > 0);
  if (live.length === 0) {
    return {
      mode: 'paused',
      summary:
        'Every bound account is disabled, so the strategy trades on no account until one is enabled.',
      liveRows: [],
      touchesRealMoney: false,
    };
  }
  const names = live
    .map(
      (r) =>
        `${r.accountName} (${ENVIRONMENT_LABELS[r.environment]}, lots ×${formatMultiplier(r.lotMultiplier)})`,
    )
    .join(', ');
  return {
    mode: 'restricted',
    summary: `Trades only on ${names}.`,
    liveRows: live,
    touchesRealMoney: live.some((r) => isLiveMoney(r.environment)),
  };
}

/**
 * Removing the last binding of a non-script strategy widens it from its bound accounts to the
 * whole fleet. That is a live-capital change in the dangerous direction and gets its own typed
 * confirmation on save.
 */
export function widensToFleet(
  saved: readonly BindingRow[],
  current: readonly BindingRow[],
  isScript: boolean,
): boolean {
  return !isScript && saved.length > 0 && current.length === 0;
}

export function formatMultiplier(v: number): string {
  return Number.isFinite(v) ? String(Number(v.toFixed(4))) : '?';
}

// ── Execution policy ──────────────────────────────────────────────────────────

export interface PolicyDescription {
  policy: ExecutionPolicy;
  title: string;
  summary: string;
}

export const POLICY_DESCRIPTIONS: Record<ExecutionPolicy, PolicyDescription> = {
  Standard: {
    policy: 'Standard',
    title: 'Standard',
    summary:
      'Every gate in the signal pipeline applies — the discretionary filters that second-guess the strategy, and the hard safety and risk checks.',
  },
  Direct: {
    policy: 'Direct',
    title: 'Direct',
    summary:
      'Only the hard safety and risk gates apply, so live trading reproduces the backtest. The default for script strategies.',
  },
};

/** Plain-language list of the discretionary filters Direct skips (engine `DirectExecutionPolicy`). */
export const DIRECT_SKIPS: readonly string[] = [
  'Multi-timeframe confirmation and its confidence scaling',
  'Portfolio correlation limits between strategies',
  'Hawkes "signal burst" filter',
  'Pre-score early exit',
  'ML suppression, abstention, disagreement and stale-model rejections (ML still scores for telemetry)',
  'Cross-strategy conflict resolution and the 30-minute cross-strategy duplicate filter',
  'Regime-archetype gate and the post-conflict regime confirmation',
];

/** Plain-language list of the hard gates Direct keeps (engine `DirectExecutionPolicy`). */
export const DIRECT_KEEPS: readonly string[] = [
  'Kill switches (global and per strategy) and engine degradation / emergency halts',
  'EA health: no live EA for the symbol (or no live bound EA), stale ticks, EA-side safety gates',
  'News blackout, the session allowlist and the strategy’s own session / regime / timeframe filters',
  'Account bindings, the RiskProfile / Tier-2 risk checker and every account cap (lots, risk %, exposure, drawdown, margin)',
  'Strategy health, backtest qualification, the failure circuit breaker, per-strategy cooldown and exact-duplicate protection',
];

export const EXITS_NEVER_BLOCKED =
  'Exits and protective stop / target changes are never blocked by entry gates, under either policy.';
