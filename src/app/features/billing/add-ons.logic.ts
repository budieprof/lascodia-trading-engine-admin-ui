import type { AddOn, AddOnBody, PlanAllowances, UsageUnit } from './add-ons.types';

/** The units a plan or add-on can set an allowance for, in display order, with what a person reads. */
export const ALLOWABLE_UNITS: readonly { key: string; label: string; perMonth: boolean }[] = [
  { key: 'ai.analysis', label: 'AI analyses a month', perMonth: true },
  { key: 'research.backtest', label: 'Backtests and optimisations a month', perMonth: true },
  { key: 'signals.symbols', label: 'Symbols followed for platform signals', perMonth: false },
  { key: 'watches.active', label: 'Active watches', perMonth: false },
];

/** "AI analyses", … — a unit's plural noun (the key when unknown). */
export function unitNoun(key: string): string {
  switch (key) {
    case 'ai.analysis':
      return 'AI analyses';
    case 'research.backtest':
      return 'backtests';
    case 'signals.symbols':
      return 'signal symbols';
    case 'watches.active':
      return 'watches';
    default:
      return key;
  }
}

/** A number without trailing zeros (2.25 → "2.25", 3 → "3"). */
export function amount(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return Number(n.toFixed(2)).toString();
}

/** "2.25 of 3", "1 (unlimited)", "Not included" (an allowance of 0 with nothing in use — an add-on adds it). */
export function usedLabel(u: Pick<UsageUnit, 'used' | 'allowance'>): string {
  if (u.allowance === null) return `${amount(u.used)} (unlimited)`;
  if (u.allowance === 0 && u.used === 0) return 'Not included';
  return `${amount(u.used)} of ${amount(u.allowance)}`;
}

/** Whether the unit shows a bar: not when unlimited, nor when not included at all. */
export function showsBar(u: Pick<UsageUnit, 'used' | 'allowance'>): boolean {
  return u.allowance !== null && !(u.allowance === 0 && u.used === 0);
}

/** 0-100 for the bar; 0 when unlimited, 100 when the allowance is 0 or used up. */
export function usedPercent(u: Pick<UsageUnit, 'used' | 'allowance'>): number {
  if (u.allowance === null) return 0;
  if (u.allowance <= 0) return 100;
  return Math.max(0, Math.min(100, Math.round((u.used / u.allowance) * 100)));
}

/** The bar's tone: `bad` when used up, `warn` from 80%, else `ok`. */
export function usageTone(u: Pick<UsageUnit, 'used' | 'allowance' | 'nearLimit'>): 'ok' | 'warn' | 'bad' {
  if (u.allowance === null) return 'ok';
  if (u.used >= u.allowance) return 'bad';
  return u.nearLimit ? 'warn' : 'ok';
}

/** "+30 AI analyses, +10 watches". */
export function grantsLabel(grants: Record<string, number>): string {
  const parts = ALLOWABLE_UNITS.filter((u) => grants[u.key] !== undefined).map(
    (u) => `+${amount(grants[u.key])} ${unitNoun(u.key)}`,
  );
  return parts.length ? parts.join(', ') : 'Nothing yet';
}

/** "$10 a month", "" when no price is set. */
export function priceLabel(a: Pick<AddOn, 'priceUsdMonthly'>): string {
  return a.priceUsdMonthly === null || a.priceUsdMonthly === undefined ? '' : `$${amount(a.priceUsdMonthly)} a month`;
}

/** What the organisation can do with an add-on now. */
export type AddOnAction = 'manage' | 'held' | 'buy' | 'trial' | 'contact';

/**
 * The main action on an add-on card: pays by card → Manage; holds it otherwise (trial, staff grant) → Buy if card
 * payment is available (to keep it after the trial), else just "held"; not held → Buy, else the free trial, else
 * "contact us".
 */
export function addOnAction(a: AddOn): AddOnAction {
  if (a.manageAvailable) return 'manage';
  if (a.held) return a.checkoutAvailable ? 'buy' : 'held';
  if (a.checkoutAvailable) return 'buy';
  if (a.trialAvailable) return 'trial';
  return 'contact';
}

/** "On until 3 Dec (trial)", "On (paid by card)". */
export function heldLabel(a: AddOn, format: (iso: string) => string): string {
  if (!a.held) return '';
  const via =
    a.heldVia === 'trial' ? 'trial' : a.heldVia === 'staff' ? 'given by the platform' : 'paid by card';
  return a.heldUntilUtc ? `On until ${format(a.heldUntilUtc)} (${via})` : `On (${via})`;
}

/** Where the browser came back from an add-on payment: `?addon=success|cancelled|paystack`. */
export type AddOnReturn = 'success' | 'cancelled' | 'paystack' | null;

export function addOnReturn(value: string | null | undefined): AddOnReturn {
  return value === 'success' || value === 'cancelled' || value === 'paystack' ? value : null;
}

/** Query parameters the add-on payment pages add on the way back; stripped once read. */
export const ADD_ON_RETURN_PARAMS = ['addon', 'reference', 'trxref'] as const;

// ── Staff editors ────────────────────────────────────────────────────────────

/** A form row per allowable unit: '' = unlimited (plan) / not granted (add-on). */
export type UnitForm = Record<string, string>;

export function unitFormFrom(values: Record<string, number | null | undefined>): UnitForm {
  return Object.fromEntries(
    ALLOWABLE_UNITS.map((u) => {
      const v = values[u.key];
      return [u.key, v === null || v === undefined ? '' : String(v)];
    }),
  );
}

/** The form back to numbers; an error sentence for a value that is not a number from 0 up. */
export function unitFormValues(form: UnitForm): { values: Record<string, number | null>; error: string | null } {
  const values: Record<string, number | null> = {};
  for (const u of ALLOWABLE_UNITS) {
    const raw = (form[u.key] ?? '').trim();
    if (raw === '') {
      values[u.key] = null;
      continue;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return { values, error: `${u.label}: enter a number from 0 up, or leave it empty.` };
    values[u.key] = n;
  }
  return { values, error: null };
}

/** A plan's allowances body: empty = unlimited (null). */
export function planAllowancesBody(form: UnitForm): { body: PlanAllowances | null; error: string | null } {
  const { values, error } = unitFormValues(form);
  return error ? { body: null, error } : { body: values, error: null };
}

export interface AddOnForm {
  slug: string;
  name: string;
  description: string;
  price: string;
  trialDays: string;
  isActive: boolean;
  grants: UnitForm;
}

export function addOnFormFrom(a: AddOn | null): AddOnForm {
  return {
    slug: a?.slug ?? '',
    name: a?.name ?? '',
    description: a?.description ?? '',
    price: a?.priceUsdMonthly === null || a?.priceUsdMonthly === undefined ? '' : String(a.priceUsdMonthly),
    trialDays: String(a?.trialDays ?? 0),
    isActive: a?.isActive ?? true,
    grants: unitFormFrom(a?.grants ?? {}),
  };
}

/** The add-on body, or an error sentence. */
export function addOnBody(form: AddOnForm): { slug: string; body: AddOnBody | null; error: string | null } {
  const slug = form.slug.trim().toLowerCase();
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) || slug.length < 2 || slug.length > 63)
    return { slug, body: null, error: 'Slug: 2-63 lowercase letters, digits and single hyphens.' };
  if (!form.name.trim()) return { slug, body: null, error: 'Name is required.' };
  const price = form.price.trim() === '' ? null : Number(form.price);
  if (price !== null && (!Number.isFinite(price) || price < 0))
    return { slug, body: null, error: 'Price: a number from 0 up, or empty.' };
  const trial = Number(form.trialDays);
  if (!Number.isInteger(trial) || trial < 0 || trial > 90)
    return { slug, body: null, error: 'Trial days: a whole number from 0 to 90.' };
  const { values, error } = unitFormValues(form.grants);
  if (error) return { slug, body: null, error };
  const grants: Record<string, number> = {};
  for (const [k, v] of Object.entries(values)) if (v !== null) grants[k] = v;
  return {
    slug,
    body: {
      name: form.name.trim(),
      description: form.description.trim() || null,
      priceUsdMonthly: price,
      trialDays: trial,
      isActive: form.isActive,
      grants,
    },
    error: null,
  };
}

/** "$0.0070" for small unit costs, "$12.40" otherwise; "—" when unknown. */
export function usd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return Math.abs(n) > 0 && Math.abs(n) < 0.1 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}
