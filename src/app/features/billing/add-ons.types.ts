/**
 * Freemium program (engine `docs/api/billing-api.md`, "Usage ledger", "Allowances and add-ons", "Paying for add-ons by
 * card"): priced units, add-ons, plan allowances and what each unit costs the platform.
 */

/** `GET tenant/usage` → `units[]`: one priced unit for the organisation. */
export interface UsageUnit {
  /** `ai.analysis`, `research.backtest`, `signals.symbols`, `watches.active`. */
  unit: string;
  label: string;
  /** `consumption` (per month) or `capacity` (at once). */
  kind: 'consumption' | 'capacity' | string;
  used: number;
  /** Null = unlimited. */
  allowance: number | null;
  remaining: number | null;
  /** At least 80% used (or an allowance of 0). */
  nearLimit: boolean;
  month: string;
  /** Consumption units: when the allowance starts again. */
  resetsOnUtc: string | null;
}

/** An add-on as the catalogue shows it; the `held…`/`…Available` fields only on the organisation's own view. */
export interface AddOn {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  priceUsdMonthly: number | null;
  trialDays: number;
  isActive: boolean;
  /** Unit key → amount the add-on adds to the plan's allowance. */
  grants: Record<string, number>;
  held?: boolean | null;
  heldUntilUtc?: string | null;
  /** `staff`, `trial`, `stripe`, `paystack`. */
  heldVia?: string | null;
  trialAvailable?: boolean | null;
  checkoutAvailable?: boolean | null;
  manageAvailable?: boolean | null;
}

/** `PUT platform/billing/add-ons/{slug}` body. */
export interface AddOnBody {
  name: string;
  description: string | null;
  priceUsdMonthly: number | null;
  trialDays: number;
  isActive: boolean;
  grants: Record<string, number>;
}

/** An add-on an organisation holds or held (staff view). */
export interface TenantAddOn {
  id: number;
  tenantId: number;
  addOnSlug: string;
  source: string;
  startedAtUtc: string;
  endsAtUtc: string | null;
  endedAtUtc: string | null;
  inForce: boolean;
  note: string | null;
}

/** Unit key → allowance (null = unlimited). */
export type PlanAllowances = Record<string, number | null>;

/** `GET platform/billing/unit-costs`: one unit's month across organisations. */
export interface UnitCost {
  unit: string;
  label: string;
  quantity: number;
  entries: number;
  organisations: number;
  aiCostUsd: number;
  aiNotionalCostUsd: number;
  computeHours: number;
  computeCostUsd: number | null;
  totalCostUsd: number;
  costPerUnitUsd: number | null;
}

export interface UnitCostReport {
  month: string;
  computeUsdPerHour: number;
  units: UnitCost[];
  note: string;
}
