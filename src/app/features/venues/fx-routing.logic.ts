import type { FxConfigKey, FxGatewaySession, FxSessionStatus, FxVenueKind } from './venues.types';

/** The typed control a key gets on the FX routing page. */
export type FxControlKind = 'bool' | 'mode' | 'int';

export const GATE_MODES = ['Enforce', 'Observe'] as const;

export function fxControlKind(k: FxConfigKey): FxControlKind {
  if (k.dataType === 'Bool') return 'bool';
  if (k.key.endsWith(':Mode')) return 'mode';
  return 'int';
}

/** The value a control shows: the stored one, else the default. */
export function fxEffective(k: FxConfigKey): string {
  return k.value ?? k.default;
}

/** Why a typed value cannot be saved (the engine clamps too; the page refuses first), or null. */
export function fxValueProblem(k: FxConfigKey, raw: string): string | null {
  const v = raw.trim();
  switch (fxControlKind(k)) {
    case 'bool':
      return v === 'true' || v === 'false' ? null : 'true or false.';
    case 'mode':
      return (GATE_MODES as readonly string[]).includes(v) ? null : 'Enforce or Observe.';
    default: {
      if (!/^\d+$/.test(v)) return 'A whole number.';
      const n = Number(v);
      return n >= 1 && n <= 120 ? null : 'Between 1 and 120.';
    }
  }
}

/** `Execution:Fx:oanda:Enabled` → "oanda route"; `…:PreTradeGates:MaxOrdersPerMinute` → "Max orders per minute". */
export function fxKeyLabel(key: string): string {
  const route = /^Execution:Fx:([^:]+):Enabled$/.exec(key);
  if (route && route[1] !== 'PreTradeGates') return `${route[1]} route`;
  if (key === 'Execution:Fx:PreTradeGates:Mode') return 'Pre-trade gates mode';
  const last =
    key
      .split(':')
      .filter((s) => s !== 'Enabled')
      .pop() ?? key;
  const words = last.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Saving this value changes what reaches a venue (the confirm dialog says so). */
export function fxChangeWarning(k: FxConfigKey, next: string): string {
  if (/^Execution:Fx:[^:]+:Enabled$/.test(k.key) && next === 'true')
    return 'Active venue accounts of this kind start taking NEW entries (if the router, entries and multi-asset risk are on).';
  if (k.key.endsWith(':Mode') && next === 'Observe')
    return 'Observe lets entries through that the news blackout / order-rate gates would refuse — they are only recorded.';
  if (k.key.endsWith(':Enabled') && next === 'false')
    return 'No new entries on this route; exits keep working.';
  return 'Recorded in the configuration history and the audit log.';
}

export function sessionTone(s: FxSessionStatus | FxGatewaySession): 'ok' | 'warn' | 'bad' {
  if ('state' in s)
    return s.state === 'LoggedOn' ? 'ok' : s.state === 'Connecting' ? 'warn' : 'bad';
  return s.connected ? 'ok' : s.lastError ? 'bad' : 'warn';
}

/** One line saying why a route is (not) live. */
export function routeSummary(v: FxVenueKind, prerequisitesOn: boolean): string {
  if (!v.registered) return 'Not in this build.';
  if (!v.enabled) return 'Off — no new entries.';
  if (!prerequisitesOn) return 'On, but a prerequisite switch is off — nothing is routed yet.';
  if (v.activeAccounts === 0) return 'On; no Active account of this kind.';
  return `On — ${v.activeAccounts} active account(s), ${v.environment}.`;
}

/** The prerequisite booleans are all on (router, entries, multi-asset risk). */
export function prerequisitesOn(keys: FxConfigKey[]): boolean {
  const must = ['Execution:Router:Enabled', 'Execution:Entries:Enabled', 'Risk:MultiAsset:Enabled'];
  return must.every((m) => {
    const k = keys.find((x) => x.key === m);
    return !!k && fxEffective(k) === 'true';
  });
}
