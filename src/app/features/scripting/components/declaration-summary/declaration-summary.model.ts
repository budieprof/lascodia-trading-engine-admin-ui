import type { ScriptDeclaration, ScriptStrategyProperties } from '@core/api/scripting.types';

import {
  ENGINE_DEFAULT_CAPITAL_TEXT,
  formatCapital,
  scriptCapitalOf,
} from '../../shared/script-capital';

/** One row of the declaration summary. */
export interface PropRow {
  label: string;
  value: string;
  /** Declared by the script or off the Pine default — worth a second look. */
  set?: boolean;
  /** What the value means, shown on hover. */
  hint?: string;
}

const QTY_TYPES = ['Fixed', 'Cash', 'PercentOfEquity'];
const COMMISSION_TYPES = ['Percent', 'CashPerContract', 'CashPerOrder'];

function enumText(value: string | number | undefined, names: string[]): string | undefined {
  if (value === undefined || value === null) return undefined;
  return typeof value === 'number' ? (names[value] ?? String(value)) : value;
}

function qtyLabel(p: ScriptStrategyProperties): string {
  const type = enumText(p.defaultQtyType, QTY_TYPES) ?? 'Fixed';
  const v = p.defaultQtyValue ?? 1;
  switch (type.toLowerCase().replace(/[_\s.]/g, '')) {
    case 'cash':
    case 'strategycash':
      return `${v} (cash)`;
    case 'percentofequity':
    case 'strategypercentofequity':
      return `${v}% of equity`;
    default:
      return `${v} (contracts/lots)`;
  }
}

function commissionLabel(p: ScriptStrategyProperties): string {
  const v = p.commissionValue ?? 0;
  if (!v) return 'None';
  const type = (enumText(p.commissionType, COMMISSION_TYPES) ?? 'Percent').toLowerCase();
  if (type.includes('contract')) return `${v} per contract`;
  if (type.includes('order')) return `${v} per order`;
  return `${v}%`;
}

const yesNo = (b: boolean | undefined) => (b ? 'Yes' : 'No');

/**
 * The capital, by the compiler's `initialCapitalSpecified` flag — never by the value (a declared
 * 1,000,000 equals Pine's default): declared, else the engine's default (engine D122). Without the
 * flag the compiled value is shown as it is, with no claim about where it comes from.
 */
export function capitalRow(p: ScriptStrategyProperties): PropRow {
  const capital = scriptCapitalOf(p);
  const label = 'Initial capital';
  if (capital.source === 'declared') {
    const amount = capital.amount !== null ? formatCapital(capital.amount, capital.currency) : '—';
    return {
      label,
      value: `${amount} · declared`,
      set: true,
      hint: 'strategy(initial_capital=…): every run of the script opens with this capital.',
    };
  }
  if (capital.source === 'engineDefault') {
    return {
      label,
      value: capital.currency ? `Engine default (${capital.currency})` : 'Engine default',
      hint:
        `strategy() declares no initial_capital: every run of the script opens with the ` +
        `${ENGINE_DEFAULT_CAPITAL_TEXT}, not Pine's 1,000,000.`,
    };
  }
  const compiled = typeof p.initialCapital === 'number' ? p.initialCapital : null;
  return { label, value: compiled !== null ? formatCapital(compiled, capital.currency) : '—' };
}

/** Margins, marked declared or default by the compiler's `marginSpecified` flag only. */
export function marginRow(p: ScriptStrategyProperties): PropRow {
  const value = `${p.marginLong ?? 100}% / ${p.marginShort ?? 100}%`;
  const label = 'Margin long / short';
  if (p.marginSpecified === true) {
    return {
      label,
      value: `${value} · declared`,
      set: true,
      hint: 'strategy() sets margin_long or margin_short.',
    };
  }
  if (p.marginSpecified === false) {
    return {
      label,
      value: `${value} · default`,
      hint: 'strategy() sets no margin: strategy.margin_liquidation_price is na.',
    };
  }
  return { label, value };
}

/** The rows of a declaration: kind-independent ones, and every `strategy()` property for a strategy. */
export function declarationRows(d: ScriptDeclaration | null | undefined): PropRow[] {
  if (!d) return [];
  const rows: PropRow[] = [{ label: 'Overlay', value: yesNo(d.overlay) }];
  const p = d.strategy;
  if (d.kind === 'strategy' && p) {
    rows.push(
      capitalRow(p),
      { label: 'Order size', value: qtyLabel(p) },
      { label: 'Pyramiding', value: String(p.pyramiding ?? 0), set: (p.pyramiding ?? 0) > 1 },
      { label: 'Commission', value: commissionLabel(p), set: !!p.commissionValue },
      { label: 'Slippage', value: `${p.slippage ?? 0} ticks`, set: !!p.slippage },
      marginRow(p),
      {
        label: 'Orders on close',
        value: yesNo(p.processOrdersOnClose),
        set: !!p.processOrdersOnClose,
      },
      { label: 'Every tick', value: yesNo(p.calcOnEveryTick), set: !!p.calcOnEveryTick },
      { label: 'On order fills', value: yesNo(p.calcOnOrderFills), set: !!p.calcOnOrderFills },
      { label: 'Close entries rule', value: p.closeEntriesRule ?? 'FIFO' },
      { label: 'Bar magnifier', value: yesNo(p.useBarMagnifier), set: !!p.useBarMagnifier },
      {
        label: 'Fill on standard OHLC',
        value: yesNo(p.fillOrdersOnStandardOhlc),
        set: !!p.fillOrdersOnStandardOhlc,
      },
      {
        label: 'Limit fill assumption',
        value: `${p.backtestFillLimitsAssumption ?? 0} ticks`,
        set: !!p.backtestFillLimitsAssumption,
      },
      { label: 'Risk-free rate', value: `${p.riskFreeRate ?? 2}%` },
    );
  }
  if (d.timeframe) rows.push({ label: 'Timeframe', value: d.timeframe, set: true });
  if (d.format && d.format !== 'inherit')
    rows.push({ label: 'Format', value: d.format, set: true });
  if (d.precision !== null && d.precision !== undefined)
    rows.push({ label: 'Precision', value: String(d.precision), set: true });
  const maxBarsBack = p?.maxBarsBack || d.maxBarsBack;
  if (maxBarsBack) rows.push({ label: 'Max bars back', value: String(maxBarsBack), set: true });
  const drawing = [d.maxLinesCount, d.maxLabelsCount, d.maxBoxesCount, d.maxPolylinesCount];
  if (drawing.some((x) => x !== undefined && x !== 50)) {
    rows.push({
      label: 'Max lines / labels / boxes / polylines',
      value: drawing.map((x) => x ?? 50).join(' / '),
      set: true,
    });
  }
  return rows;
}
