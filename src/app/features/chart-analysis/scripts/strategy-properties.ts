import type { ScriptStrategyPropertyOverrides } from '@core/api/scripting.types';
import type { ReportStrategyProperties } from '@features/scripting/report/strategy-report.model';

/**
 * The Strategy Tester's editable Properties (PC-I5): TradingView's Properties dialog over the
 * script's `strategy()`, sent as `strategyProperties` on the chart's runs and its deep backtests
 * (scripting API §3d). The form starts from what the shown run used (the report's
 * `meta.properties`); a Re-run sends the operator's overrides — the ones already applied plus every
 * field changed here — and "Script's own" clears them all.
 */

export type QtyTypeValue = NonNullable<ScriptStrategyPropertyOverrides['defaultQtyType']>;
export type CommissionTypeValue = NonNullable<ScriptStrategyPropertyOverrides['commissionType']>;

/** Every editable property with the value it has in the form (the run's when it starts). */
export interface PropertyDraft {
  initialCapital: number | null;
  currency: string;
  defaultQtyType: QtyTypeValue;
  defaultQtyValue: number | null;
  pyramiding: number | null;
  commissionType: CommissionTypeValue;
  commissionValue: number | null;
  backtestFillLimitsAssumption: number | null;
  slippage: number | null;
  marginLong: number | null;
  marginShort: number | null;
  processOrdersOnClose: boolean;
  calcOnOrderFills: boolean;
  calcOnEveryTick: boolean;
  useBarMagnifier: boolean;
  fillOrdersOnStandardOhlc: boolean;
  closeEntriesRule: 'FIFO' | 'ANY';
  riskFreeRate: number | null;
}

export const QTY_TYPES: { value: QtyTypeValue; label: string }[] = [
  { value: 'fixed', label: 'Units (fixed)' },
  { value: 'cash', label: 'Cash amount' },
  { value: 'percent_of_equity', label: '% of equity' },
];

export const COMMISSION_TYPES: { value: CommissionTypeValue; label: string }[] = [
  { value: 'percent', label: '% of order value' },
  { value: 'cash_per_contract', label: 'Cash per contract' },
  { value: 'cash_per_order', label: 'Cash per order' },
];

function qtyType(v: string | null): QtyTypeValue {
  const t = (v ?? '').replace(/_/g, '').toLowerCase();
  return t === 'cash' ? 'cash' : t === 'percentofequity' ? 'percent_of_equity' : 'fixed';
}

function commissionType(v: string | null): CommissionTypeValue {
  const t = (v ?? '').replace(/_/g, '').toLowerCase();
  return t === 'cashpercontract'
    ? 'cash_per_contract'
    : t === 'cashperorder'
      ? 'cash_per_order'
      : 'percent';
}

/** The form's starting values: what the shown run used (`meta.properties`). */
export function draftFromReport(p: ReportStrategyProperties): PropertyDraft {
  return {
    initialCapital: p.initialCapital,
    currency: (p.currency ?? 'NONE').toUpperCase(),
    defaultQtyType: qtyType(p.defaultQtyType),
    defaultQtyValue: p.defaultQtyValue,
    pyramiding: p.pyramiding,
    commissionType: commissionType(p.commissionType),
    commissionValue: p.commissionValue,
    backtestFillLimitsAssumption: p.backtestFillLimitsAssumption,
    slippage: p.slippage,
    marginLong: p.marginLong,
    marginShort: p.marginShort,
    processOrdersOnClose: p.processOrdersOnClose === true,
    calcOnOrderFills: p.calcOnOrderFills === true,
    calcOnEveryTick: p.calcOnEveryTick === true,
    useBarMagnifier: p.useBarMagnifier === true,
    fillOrdersOnStandardOhlc: p.fillOrdersOnStandardOhlc === true,
    closeEntriesRule: (p.closeEntriesRule ?? 'FIFO').toUpperCase() === 'ANY' ? 'ANY' : 'FIFO',
    riskFreeRate: p.riskFreeRate,
  };
}

/** Problems with the form's values in plain words — the engine's own limits (empty = sendable). */
export function draftProblems(d: PropertyDraft): string[] {
  const problems: string[] = [];
  const range = (label: string, v: number | null, min: number, max: number, above = false) => {
    if (v === null) return;
    if (!Number.isFinite(v) || (above ? v <= min : v < min) || v > max)
      problems.push(`${label} must be ${above ? 'above' : 'at least'} ${min} and at most ${max}.`);
  };
  const whole = (label: string, v: number | null) => {
    if (v !== null && !Number.isInteger(v)) problems.push(`${label} must be a whole number.`);
  };
  range('Initial capital', d.initialCapital, 0, 1e12, true);
  range('Order size', d.defaultQtyValue, 0, 1e12, true);
  range('Pyramiding', d.pyramiding, 0, 100);
  whole('Pyramiding', d.pyramiding);
  range('Commission', d.commissionValue, 0, d.commissionType === 'percent' ? 100 : 1e9);
  range('Verify price for limit orders', d.backtestFillLimitsAssumption, 0, 1_000_000);
  whole('Verify price for limit orders', d.backtestFillLimitsAssumption);
  range('Slippage', d.slippage, 0, 1_000_000);
  whole('Slippage', d.slippage);
  range('Margin for long positions', d.marginLong, 0, 100);
  range('Margin for short positions', d.marginShort, 0, 100);
  range('Risk-free rate', d.riskFreeRate, -100, 100);
  if (!/^(NONE|[A-Z]{3})$/.test(d.currency.trim().toUpperCase()))
    problems.push('Base currency must be a three-letter code such as USD, or NONE.');
  return problems;
}

/**
 * The overrides a Re-run sends: those already applied, plus every field the form changed from
 * what the shown run used (`start`). A field changed back stays an explicit override (the engine
 * applies the same value), so nothing silently returns to the script's own.
 */
export function overridesFrom(
  current: ScriptStrategyPropertyOverrides,
  start: PropertyDraft,
  edited: PropertyDraft,
): ScriptStrategyPropertyOverrides {
  const out: Record<string, unknown> = { ...current };
  for (const key of Object.keys(edited) as (keyof PropertyDraft)[]) {
    const a = start[key];
    const b = edited[key];
    if (a === b || b === null) continue;
    out[key] = key === 'currency' ? String(b).trim().toUpperCase() : b;
  }
  return out as ScriptStrategyPropertyOverrides;
}

/** "Initial capital, pyramiding" — the overridden properties, for the tester's note. */
export function overriddenLabel(o: ScriptStrategyPropertyOverrides | null | undefined): string {
  const labels: Record<string, string> = {
    initialCapital: 'initial capital',
    currency: 'base currency',
    defaultQtyType: 'order size type',
    defaultQtyValue: 'order size',
    pyramiding: 'pyramiding',
    commissionType: 'commission type',
    commissionValue: 'commission',
    backtestFillLimitsAssumption: 'limit-price check',
    slippage: 'slippage',
    marginLong: 'long margin',
    marginShort: 'short margin',
    processOrdersOnClose: 'orders on close',
    calcOnOrderFills: 'recalculate after fills',
    calcOnEveryTick: 'recalculate on every tick',
    useBarMagnifier: 'bar magnifier',
    fillOrdersOnStandardOhlc: 'standard OHLC fills',
    closeEntriesRule: 'close-entries rule',
    riskFreeRate: 'risk-free rate',
  };
  return Object.keys(o ?? {})
    .map((k) => labels[k] ?? k)
    .join(', ');
}
