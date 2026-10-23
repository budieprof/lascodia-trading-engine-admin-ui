import type { AccountStrip } from '../panels/side/chart-panels.types';
import type { OcoGroup, TicketDirection } from '../trading/manual-trading.types';
import type { LadderOrder, LadderPosition } from './ladder-model';

/**
 * My working orders, pending manual signals and positions on the symbol, from the account strip
 * (`chart-panels/account-strip`) and the account's open OCO pairs (`order/oco`) — the ladder's own columns. Pure.
 */

const WORKING_ORDER = new Set(['Pending', 'Submitted', 'PartialFill', 'Cancelling']);
const WORKING_SIGNAL = new Set(['Pending', 'Approved']);

export function sideOf(direction: unknown): TicketDirection {
  const d = String(direction).toLowerCase();
  return d.includes('sell') || d === 'short' ? 'Sell' : 'Buy';
}

/** order id / signal id → the OCO pair it is a leg of (open pairs only). */
export function ocoIndex(groups: readonly OcoGroup[]): { orders: Map<number, number>; signals: Map<number, number> } {
  const orders = new Map<number, number>();
  const signals = new Map<number, number>();
  for (const g of groups)
    for (const leg of g.legs) {
      signals.set(leg.tradeSignalId, g.id);
      if (leg.orderId !== null) orders.set(leg.orderId, g.id);
    }
  return { orders, signals };
}

export function ladderOrdersFrom(strip: AccountStrip | null, groups: readonly OcoGroup[]): LadderOrder[] {
  if (!strip) return [];
  const oco = ocoIndex(groups);
  const out: LadderOrder[] = [];
  const signalsWithOrder = new Set<number>();
  for (const o of strip.ordersOnSymbol) {
    if (!WORKING_ORDER.has(o.status)) continue;
    if (o.tradeSignalId !== null) signalsWithOrder.add(o.tradeSignalId);
    out.push({
      id: o.id,
      isSignal: false,
      direction: sideOf(o.side),
      price: o.price,
      lots: o.lots,
      stopLoss: o.stopLoss,
      takeProfit: o.takeProfit,
      kind: o.executionType,
      status: o.status,
      ocoGroupId: oco.orders.get(o.id) ?? (o.tradeSignalId !== null ? (oco.signals.get(o.tradeSignalId) ?? null) : null),
    });
  }
  // A manual signal the EA has not placed yet still works (it becomes an order at its entry): show it, marked.
  for (const s of strip.signalsOnSymbol) {
    if (!s.isManual || !WORKING_SIGNAL.has(s.status) || signalsWithOrder.has(s.id) || !(s.entryPrice > 0)) continue;
    out.push({
      id: s.id,
      isSignal: true,
      direction: sideOf(s.direction),
      price: s.entryPrice,
      lots: null,
      stopLoss: s.stopLoss,
      takeProfit: s.takeProfit,
      kind: 'signal',
      status: s.status,
      ocoGroupId: oco.signals.get(s.id) ?? null,
    });
  }
  return out;
}

export function ladderPositionsFrom(strip: AccountStrip | null): LadderPosition[] {
  if (!strip) return [];
  return strip.positionsOnSymbol
    .filter((p) => !p.isPaper)
    .map((p) => ({ direction: sideOf(p.direction), price: p.entryPrice, lots: p.lots }));
}

/** A working order's stop and target moved with its entry by the same distance (the trade keeps its shape). */
export function movedLevels(
  order: Pick<LadderOrder, 'price' | 'stopLoss' | 'takeProfit'>,
  to: number,
  digits: number,
): { price: number; stopLoss: number | null; takeProfit: number | null } {
  const f = 10 ** Math.max(0, digits);
  const round = (p: number) => Math.round(p * f) / f;
  const delta = to - order.price;
  return {
    price: round(to),
    stopLoss: order.stopLoss === null ? null : round(order.stopLoss + delta),
    takeProfit: order.takeProfit === null ? null : round(order.takeProfit + delta),
  };
}

/** The start of the FX session that contains `nowMs`: the latest 17:00 New York time at or before it (epoch ms). */
export function fxSessionStart(nowMs: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(nowMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  // New York wall-clock now, as if it were UTC; its distance from the real instant is the zone offset.
  const wallAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  const offset = wallAsUtc - Math.floor(nowMs / 1000) * 1000;
  let startWall = Date.UTC(get('year'), get('month') - 1, get('day'), 17, 0, 0);
  if (get('hour') < 17) startWall -= 24 * 3600_000;
  return startWall - offset;
}
