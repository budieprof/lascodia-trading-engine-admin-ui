import type {
  ConfigOverride,
  ConfigOverrides,
  ConfigSource,
  EffectiveConfigEntry,
  OverrideScopeType,
  OverrideWriteResult,
  PendingConfigOverride,
} from './organisation.types';

// Settings (T7.2): the organisation's and one account's layered settings (engine ConfigOverridesController).
// The engine decides every write; these functions say beforehand what it will ask for — a valid value, a
// tighten-only key kept tighter than what it inherits, and the governed path for a risk-loosening change.

/** The layer a page edits: the organisation's own values, or one account's. */
export function scopeLayer(tradingAccountId: number | null): OverrideScopeType {
  return tradingAccountId ? 'Account' : 'Tenant';
}

/** Whether the key may be set at that layer (the registry's allowed layers). */
export function canSetAt(entry: EffectiveConfigEntry, layer: OverrideScopeType): boolean {
  return entry.allowedLayers.includes(layer);
}

export function sourceLabel(source: ConfigSource): string {
  switch (source) {
    case 'Default':
      return 'Engine default';
    case 'Platform':
      return 'Platform';
    case 'Tenant':
      return 'Organisation';
    case 'Account':
      return 'This account';
    case 'LegacyAccountKey':
      return 'This account (older setting)';
    default:
      return source;
  }
}

/** A cap where 0 means "no limit" (organisation-wide limits). */
export function zeroIsUnlimited(entry: EffectiveConfigEntry): boolean {
  return entry.tightness === 'LowerIsTighterZeroUnlimited';
}

/** A value as the page shows it: "—" for none, "No limit" for a zero cap. */
export function valueText(entry: EffectiveConfigEntry, value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  if (zeroIsUnlimited(entry)) {
    const n = Number(value.trim());
    if (Number.isFinite(n) && n <= 0) return 'No limit';
  }
  return value;
}

// ── Values ────────────────────────────────────────────────────────────

const INT = /^[+-]?\d+$/;
const DECIMAL = /^[+-]?(\d+\.?\d*|\.\d+)$/;

/** Why `raw` is not a valid value for the key, or null. Mirrors the registry's checks. */
export function valueProblem(entry: EffectiveConfigEntry, raw: string): string | null {
  const v = raw.trim();
  if (!v) return 'Enter a value.';
  switch (entry.valueKind) {
    case 'Bool':
      return /^(true|false)$/i.test(v) ? null : 'Choose true or false.';
    case 'Int':
      if (!INT.test(v)) return 'Enter a whole number.';
      return rangeProblem(entry, Number(v));
    case 'Decimal':
      if (!DECIMAL.test(v)) return 'Enter a number (use a dot for decimals).';
      return rangeProblem(entry, Number(v));
    case 'Enum':
      return entry.allowedValues.some((a) => a.toLowerCase() === v.toLowerCase())
        ? null
        : `Choose one of: ${entry.allowedValues.join(', ')}.`;
    case 'Json':
      try {
        JSON.parse(v);
        return null;
      } catch {
        return 'Enter valid JSON.';
      }
    default:
      return null;
  }
}

function rangeProblem(entry: EffectiveConfigEntry, n: number): string | null {
  if (entry.min !== null && n < entry.min) return `The lowest allowed value is ${entry.min}.`;
  if (entry.max !== null && n > entry.max) return `The highest allowed value is ${entry.max}.`;
  return null;
}

/** The value as it is sent: trimmed, a bool in lower case, an allowed value in its listed spelling. */
export function canonicalValue(entry: EffectiveConfigEntry, raw: string): string {
  const v = raw.trim();
  if (entry.valueKind === 'Bool') return v.toLowerCase();
  if (entry.valueKind === 'Enum') {
    return entry.allowedValues.find((a) => a.toLowerCase() === v.toLowerCase()) ?? v;
  }
  return v;
}

// ── Tightness (mirror of the engine's ConfigKeyRegistry.CompareTightness) ──

function num(v: string): number | null {
  const t = v.trim().replace(/,/g, '');
  return DECIMAL.test(t) ? Number(t) : null;
}

/**
 * Negative when `a` is tighter than `b`, positive when looser, 0 when as tight; null when the two
 * cannot be compared (no direction, an unparsable value).
 */
export function compareTightness(
  entry: EffectiveConfigEntry,
  a: string | null | undefined,
  b: string | null | undefined,
): number | null {
  if (a === null || a === undefined || b === null || b === undefined) return null;
  switch (entry.tightness) {
    case 'LowerIsTighter':
    case 'HigherIsTighter': {
      const x = num(a);
      const y = num(b);
      if (x === null || y === null) return null;
      const c = Math.sign(x - y);
      return entry.tightness === 'LowerIsTighter' ? c : -c;
    }
    case 'LowerIsTighterZeroUnlimited': {
      const x = num(a);
      const y = num(b);
      if (x === null || y === null) return null;
      const limitedA = x > 0;
      const limitedB = y > 0;
      if (limitedA && limitedB) return Math.sign(x - y);
      return limitedA === limitedB ? 0 : limitedA ? -1 : 1;
    }
    case 'FalseIsTighter':
    case 'TrueIsTighter': {
      const p = /^true$/i.test(a.trim()) ? true : /^false$/i.test(a.trim()) ? false : null;
      const q = /^true$/i.test(b.trim()) ? true : /^false$/i.test(b.trim()) ? false : null;
      if (p === null || q === null) return null;
      if (p === q) return 0;
      const aIsTighter = entry.tightness === 'FalseIsTighter' ? !p : p;
      return aIsTighter ? -1 : 1;
    }
    case 'OrderedTightestFirst': {
      const i = entry.allowedValues.findIndex((v) => v.toLowerCase() === a.trim().toLowerCase());
      const j = entry.allowedValues.findIndex((v) => v.toLowerCase() === b.trim().toLowerCase());
      return i < 0 || j < 0 ? null : Math.sign(i - j);
    }
    default:
      return null;
  }
}

/**
 * Whether going from `before` to `after` loosens the key: true, false, or null when this engine does
 * not say how the key's tightness is judged. A change whose direction cannot be judged counts as
 * loosening — the engine errs towards asking, and so does the page.
 */
export function isLoosening(
  entry: EffectiveConfigEntry,
  before: string | null | undefined,
  after: string | null | undefined,
): boolean | null {
  if ((before ?? '').trim().toLowerCase() === (after ?? '').trim().toLowerCase()) return false;
  if (entry.tightness === undefined) return null;
  const c = compareTightness(entry, after, before);
  return c === null || c > 0;
}

/** A tighten-only key refuses a value looser than the one inherited; the engine's words, beforehand. */
export function tightenOnlyProblem(
  entry: EffectiveConfigEntry,
  value: string,
  layer: OverrideScopeType,
): string | null {
  const inherited = entry.inheritedValue;
  if (!entry.tightenOnly || inherited === undefined || inherited === null) return null;
  const c = compareTightness(entry, value, inherited);
  const who = layer === 'Account' ? 'this account' : 'this organisation';
  const from = layer === 'Account' ? 'the organisation' : 'the platform';
  if (c !== null && c > 0) {
    return `This key may only be tightened below ${from}: ${who} inherits ${valueText(entry, inherited)}, and ${valueText(entry, value)} is looser.`;
  }
  if (c === null && compareTightness(entry, inherited, inherited) !== null) {
    return `${valueText(entry, value)} cannot be compared with the inherited ${valueText(entry, inherited)}.`;
  }
  return null;
}

/** What saving a change will involve. */
export interface ChangePlan {
  before: string | null;
  after: string | null;
  /** Why the engine would refuse it, or null. */
  refusal: string | null;
  /** True/false, or null when this engine cannot say before saving. */
  loosening: boolean | null;
  /** A risk key whose change loosens it (or may): a reason, risk.loosen, step-up, two-person, cooling-off. */
  governed: boolean;
}

/** Setting `raw` at `layer`. */
export function planSet(
  entry: EffectiveConfigEntry,
  raw: string,
  layer: OverrideScopeType,
): ChangePlan {
  const problem = valueProblem(entry, raw);
  const after = problem ? raw.trim() : canonicalValue(entry, raw);
  const refusal = problem ?? (entry.secret ? null : tightenOnlyProblem(entry, after, layer));
  const loosening = entry.secret ? null : isLoosening(entry, entry.value, after);
  return {
    before: entry.value,
    after,
    refusal,
    loosening,
    governed: entry.riskSensitive && loosening !== false,
  };
}

/** Removing the scope's own value: it then runs with the inherited one. */
export function planRemove(entry: EffectiveConfigEntry): ChangePlan {
  const after = entry.inheritedValue;
  const loosening = after === undefined ? null : isLoosening(entry, entry.value, after);
  return {
    before: entry.value,
    after: after ?? null,
    refusal: null,
    loosening,
    governed: entry.riskSensitive && loosening !== false,
  };
}

// ── The organisation's own values ─────────────────────────────────────

export function ownOverride(
  o: ConfigOverrides | null,
  key: string,
  layer: OverrideScopeType,
  tradingAccountId: number | null,
): ConfigOverride | undefined {
  return o?.overrides.find(
    (x) =>
      x.key === key &&
      x.scopeType === layer &&
      (layer === 'Tenant' || x.tradingAccountId === tradingAccountId),
  );
}

export function pendingFor(
  o: ConfigOverrides | null,
  key: string,
  layer: OverrideScopeType,
  tradingAccountId: number | null,
): PendingConfigOverride[] {
  return (o?.pending ?? []).filter(
    (p) =>
      p.key === key &&
      p.scopeType === layer &&
      (layer === 'Tenant' || p.tradingAccountId === tradingAccountId),
  );
}

export interface EntryGroup {
  name: string;
  entries: EffectiveConfigEntry[];
}

/** Entries matching `text` (key or description), grouped by the key's first segment, in key order. */
export function groupEntries(entries: readonly EffectiveConfigEntry[], text = ''): EntryGroup[] {
  const q = text.trim().toLowerCase();
  const groups = new Map<string, EffectiveConfigEntry[]>();
  for (const e of entries) {
    if (q && !e.key.toLowerCase().includes(q) && !e.description.toLowerCase().includes(q)) continue;
    const name = e.key.split(':')[0];
    const list = groups.get(name) ?? [];
    list.push(e);
    groups.set(name, list);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, list]) => ({ name, entries: list.sort((x, y) => x.key.localeCompare(y.key)) }));
}

// ── Messages ──────────────────────────────────────────────────────────

/** What the person is told after a write the engine accepted. */
export function outcomeMessage(key: string, r: OverrideWriteResult): string {
  switch (r.outcome) {
    case 'QueuedForCoolingOff': {
      const at = r.effectiveAt ? new Date(r.effectiveAt) : null;
      const when = at && !Number.isNaN(at.getTime()) ? ` at ${at.toLocaleString()}` : '';
      return `${key}: the change is queued and takes effect${when} unless someone cancels it.`;
    }
    case 'Unchanged':
      return `${key} already had that value.`;
    case 'Removed':
      return r.breakGlass
        ? `${key} removed now (break-glass, recorded in the audit log); it inherits again.`
        : `${key} removed: it inherits again.`;
    default:
      return r.breakGlass
        ? `${key} applied now (break-glass, recorded in the audit log).`
        : `${key} saved.`;
  }
}

/** The governed path, in words, for a risk-loosening change. */
export function governanceText(entry: EffectiveConfigEntry, plan: ChangePlan): string {
  const change =
    plan.before !== null || plan.after !== null
      ? ` (${valueText(entry, plan.before)} → ${valueText(entry, plan.after)})`
      : '';
  const lead =
    plan.loosening === null
      ? `This is a risk setting: if the change loosens it${change}, it`
      : `This loosens a risk setting${change}. It`;
  return (
    `${lead} needs the risk.loosen permission, a reason, and a sign-in with your second factor ` +
    'within the last five minutes. Where two-person rules apply, another person must approve it first. ' +
    'It then waits out the cooling-off period before it applies, unless you apply it now (break-glass, ' +
    'flagged in the audit log).'
  );
}
