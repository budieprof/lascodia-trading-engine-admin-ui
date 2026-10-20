import type {
  AccountRef,
  EffectiveConfigEntry,
  ScopedKillSwitchStatus,
} from './organisation.types';
import type { Tone } from './terminals.logic';

// Risk & kill switches (T7.3): the organisation's and its accounts' kill switches (account →
// organisation → platform), scoped emergency flatten, and the organisation-wide limits (TenantRisk:*).

/** Longest reason the engine keeps for a switch or a flatten. */
export const KILL_REASON_MAX = 1000;

/** The organisation-wide limits, in the order the page shows them. */
export const TENANT_RISK_KEYS = [
  'TenantRisk:MaxOpenPositions',
  'TenantRisk:MaxTotalLots',
  'TenantRisk:MaxDailyLossPct',
  'TenantRisk:MaxOrdersPerMinute',
] as const;

const LIMIT_LABELS: Record<string, string> = {
  'TenantRisk:MaxOpenPositions': 'Open positions',
  'TenantRisk:MaxTotalLots': 'Open lots',
  'TenantRisk:MaxDailyLossPct': 'Daily loss (% of start-of-day equity)',
  'TenantRisk:MaxOrdersPerMinute': 'Orders per minute',
};

export function limitLabel(key: string): string {
  return LIMIT_LABELS[key] ?? key;
}

/** The organisation-wide limit entries of an effective view, in page order. */
export function riskLimitEntries(entries: readonly EffectiveConfigEntry[]): EffectiveConfigEntry[] {
  const byKey = new Map(entries.map((e) => [e.key, e]));
  return TENANT_RISK_KEYS.map((k) => byKey.get(k)).filter((e): e is EffectiveConfigEntry => !!e);
}

/** A switch's state as a chip: its own, or the outer switch that halts the scope. */
export function switchState(s: ScopedKillSwitchStatus | null): { label: string; tone: Tone } {
  if (!s) return { label: 'Unknown', tone: '' };
  if (s.enabled) return { label: 'Engaged', tone: 'bad' };
  if (s.haltedBy === 'Tenant') return { label: 'Halted by the organisation', tone: 'warn' };
  if (s.haltedBy === 'Platform') return { label: 'Halted by the platform', tone: 'warn' };
  return { label: 'Trading', tone: 'ok' };
}

/** Who changed it, when and why, in one line; null when the switch was never set. */
export function lastChange(s: ScopedKillSwitchStatus | null): string | null {
  if (!s?.changedAt) return null;
  const at = new Date(s.changedAt);
  const when = Number.isNaN(at.getTime()) ? s.changedAt : at.toLocaleString();
  const who = s.changedBy ? ` by ${s.changedBy}` : '';
  const why = s.reason ? `: ${s.reason}` : '';
  return `${s.enabled ? 'Engaged' : 'Released'}${who} on ${when}${why}`;
}

export function reasonProblem(reason: string): string | null {
  const r = reason.trim();
  if (!r) return 'Give a reason: it is kept in the audit log and shown with the switch.';
  if (r.length > KILL_REASON_MAX) return `The reason is at most ${KILL_REASON_MAX} characters.`;
  return null;
}

/** What a person must type to flatten. */
export function flattenPhrase(
  scope: 'organisation' | 'account',
  organisationName: string | null,
  account?: AccountRef | null,
): string {
  if (scope === 'organisation') return organisationName?.trim() || 'FLATTEN';
  return account?.login?.trim() || (account ? `account ${account.id}` : 'FLATTEN');
}

/** What a flatten does, in words, for its confirmation. */
export function flattenEffects(scope: 'organisation' | 'account'): string[] {
  const who =
    scope === 'organisation' ? "every one of the organisation's accounts" : 'this account';
  const out = [
    `Engages the ${scope === 'organisation' ? "organisation's" : "account's"} kill switch: no new orders on ${who}.`,
    `Cancels the pending orders of ${who}, at the broker too.`,
    `Closes every open position of ${who} at market.`,
  ];
  if (scope === 'organisation') out.push("Pauses the organisation's own strategies.");
  out.push(
    'Trading resumes only when someone releases the kill switch (a second-factor sign-in, and a second person where two-person rules apply).',
  );
  return out;
}
