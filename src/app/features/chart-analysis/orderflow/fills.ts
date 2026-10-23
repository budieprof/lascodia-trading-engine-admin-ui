import type { ExecutionQualityLogDto, OrderDto } from '@core/api/api.types';
import { utcMs } from '../panels/fx-fundamentals';

/**
 * OF-6 — fills and slippage on the chart: the engine's execution-quality log (C3, one row per filled order) joined to
 * the orders in the page's account scope. The log carries no account, so the join IS the scope: a fill whose order is
 * not one of the scope's is not drawn.
 *
 * Sign (ExecutionQualityLog.SlippagePips): positive = filled worse than requested (adverse), negative = better
 * (price improvement), already signed by the order's direction.
 */

export type SlippageKind = 'adverse' | 'favourable' | 'none';

export interface FillMark {
  id: number;
  orderId: number;
  /** When the fill was recorded (UTC ms). */
  time: number;
  requestedPrice: number;
  filledPrice: number;
  /** Signed as the engine records it: + adverse, − improvement. */
  slippagePips: number;
  /** The same in MT5 points (10^-digits). */
  slippagePoints: number;
  kind: SlippageKind;
  side: 'Buy' | 'Sell' | null;
  accountId: number | null;
  isPaper: boolean;
  submitToFillMs: number;
  partial: boolean;
}

/** Adverse, favourable or none: by the engine's signed slippage (below 0.05 pip is no slippage). */
export function slippageKind(slippagePips: number): SlippageKind {
  if (!Number.isFinite(slippagePips) || Math.abs(slippagePips) < 0.05) return 'none';
  return slippagePips > 0 ? 'adverse' : 'favourable';
}

/** Pips → MT5 points: a pip is `pip / point` points (10 on a 5-digit pair). */
export function pipsToPoints(pips: number, pip: number, point: number): number {
  if (!(pip > 0) || !(point > 0)) return NaN;
  return Math.round(pips * (pip / point) * 10) / 10;
}

/**
 * The fills to draw: logs of `symbol` in `[fromUtc, toUtc]` whose order is in `ordersInScope`, oldest first. Logs of
 * orders outside the scope (another account, or not resolved) are counted in `hidden`.
 */
export function joinFills(
  logs: readonly ExecutionQualityLogDto[],
  ordersInScope: readonly OrderDto[],
  symbol: string,
  fromUtc: number,
  toUtc: number,
  pip: number,
  point: number,
): { fills: FillMark[]; hidden: number } {
  const orders = new Map(ordersInScope.map((o) => [o.id, o]));
  const fills: FillMark[] = [];
  let hidden = 0;
  for (const l of logs) {
    if ((l.symbol ?? '').toUpperCase() !== symbol.toUpperCase()) continue;
    const time = utcMs(l.recordedAt ?? '');
    if (!Number.isFinite(time) || time < fromUtc || time > toUtc) continue;
    const order = orders.get(l.orderId);
    if (!order) {
      hidden++;
      continue;
    }
    const type = String(order.orderType ?? '');
    fills.push({
      id: l.id,
      orderId: l.orderId,
      time,
      requestedPrice: Number(l.requestedPrice),
      filledPrice: Number(l.filledPrice),
      slippagePips: Number(l.slippagePips),
      slippagePoints: pipsToPoints(Number(l.slippagePips), pip, point),
      kind: slippageKind(Number(l.slippagePips)),
      side: /buy/i.test(type) ? 'Buy' : /sell/i.test(type) ? 'Sell' : null,
      accountId: order.tradingAccountId ?? null,
      isPaper: order.isPaper === true,
      submitToFillMs: Number(l.submitToFillMs),
      partial: l.wasPartialFill === true,
    });
  }
  fills.sort((a, b) => a.time - b.time);
  return { fills, hidden };
}

/** "+1.2 pips (12 pts) adverse" — the hover's slippage line. */
export function slippageText(f: FillMark): string {
  if (f.kind === 'none') return 'no slippage';
  const sign = f.slippagePips > 0 ? '+' : '−';
  const pips = Math.abs(f.slippagePips).toFixed(1);
  const pts = Number.isFinite(f.slippagePoints) ? ` (${Math.abs(f.slippagePoints)} pts)` : '';
  return `${sign}${pips} pips${pts} ${f.kind === 'adverse' ? 'adverse' : 'better than requested'}`;
}
