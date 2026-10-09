import type { OrderDto } from '@core/api/api.types';

import type { ChartPosition } from '../overlays/trade-layer';
import type { TradeLine } from './trade-lines';

/**
 * SP-I3: the lines of open positions and working orders the operator can act on (the trade layer's overlay draws
 * them; these make them grabbable or clickable), and the "pending" ghosts a sent change leaves until the EA answers.
 * Pure.
 */

const RED = '#EF5350';
const GREEN = '#26A69A';
const AMBER = '#F9A825';

const isLong = (direction: unknown) =>
  String(direction).toLowerCase().includes('buy') || String(direction).toLowerCase() === 'long';

/** What a sent change is waiting for. */
export type PendingKind = 'stop' | 'target' | 'close' | 'orderStop' | 'orderTarget' | 'cancel';

/** A change sent to the EA and not yet acknowledged. */
export interface PendingChange {
  correlationId: string;
  kind: PendingKind;
  /** The position or order. */
  refId: number;
  /** The level it moves to (for a close or a cancel: the line it acts on). */
  price: number;
  label: string;
  startedAt: number;
}

/**
 * The grabbable / clickable lines of `symbol`'s positions and orders in the account scope:
 * a position's stop and target drag (a missing one is not drawn and cannot be dragged into being here);
 * its entry is clicked for close / partial close; a working order's stop and target drag, its price is clicked for
 * cancel (the EA has no command to move a working order's price). Lines with a change pending are not grabbable.
 */
export function actionableLines(
  positions: readonly ChartPosition[],
  orders: readonly OrderDto[],
  symbol: string,
  inScope: (accountId: number | null | undefined) => boolean,
  pending: readonly PendingChange[],
): TradeLine[] {
  const busy = (kind: PendingKind, id: number) =>
    pending.some((p) => p.refId === id && p.kind === kind);
  const lines: TradeLine[] = [];
  const s = symbol.toUpperCase();
  for (const p of positions) {
    if ((p.symbol ?? '').toUpperCase() !== s || !inScope(p.tradingAccountId)) continue;
    if (busy('close', p.id)) continue;
    const side = isLong(p.direction) ? 'LONG' : 'SHORT';
    lines.push({
      key: `pos:${p.id}:entry`,
      kind: 'positionEntry',
      price: p.averageEntryPrice,
      label: `${side} ${p.openLots}`,
      color: isLong(p.direction) ? GREEN : RED,
      draggable: false,
      clickable: true,
      drawn: false,
      refId: p.id,
    });
    if (p.stopLoss && !busy('stop', p.id))
      lines.push({
        key: `pos:${p.id}:stop`,
        kind: 'positionStop',
        price: p.stopLoss,
        label: 'SL',
        color: RED,
        draggable: true,
        drawn: false,
        refId: p.id,
      });
    if (p.takeProfit && !busy('target', p.id))
      lines.push({
        key: `pos:${p.id}:target`,
        kind: 'positionTarget',
        price: p.takeProfit,
        label: 'TP',
        color: GREEN,
        draggable: true,
        drawn: false,
        refId: p.id,
      });
  }
  for (const o of orders) {
    if (
      (o.symbol ?? '').toUpperCase() !== s ||
      !inScope(o.tradingAccountId) ||
      !['Pending', 'Submitted', 'PartialFill'].includes(String(o.status)) ||
      busy('cancel', o.id)
    )
      continue;
    lines.push({
      key: `ord:${o.id}:price`,
      kind: 'orderPrice',
      price: o.price,
      label: 'order',
      color: String(o.orderType) === 'Buy' ? GREEN : RED,
      draggable: false,
      clickable: true,
      drawn: false,
      refId: o.id,
    });
    if (o.stopLoss && !busy('orderStop', o.id))
      lines.push({
        key: `ord:${o.id}:stop`,
        kind: 'orderStop',
        price: o.stopLoss,
        label: 'O·SL',
        color: RED,
        draggable: true,
        drawn: false,
        refId: o.id,
      });
    if (o.takeProfit && !busy('orderTarget', o.id))
      lines.push({
        key: `ord:${o.id}:target`,
        kind: 'orderTarget',
        price: o.takeProfit,
        label: 'O·TP',
        color: GREEN,
        draggable: true,
        drawn: false,
        refId: o.id,
      });
  }
  return lines;
}

/** A pending change as a faded line with its chip ("SL → 1.09750 · waiting for the EA"). */
export function pendingLines(pending: readonly PendingChange[], precision: number): TradeLine[] {
  return pending.map((p) => ({
    key: `pending:${p.correlationId}`,
    kind: 'pending' as const,
    price: p.price,
    label: `${p.label} ${p.price.toFixed(precision)} · waiting for the EA`,
    color: AMBER,
    draggable: false,
    drawn: true,
    faded: true,
    refId: p.refId,
  }));
}

/** A fresh correlation id for one operator action ("chart-" + 20 random hex digits). */
export function newCorrelationId(random: () => number = Math.random): string {
  let hex = '';
  for (let i = 0; i < 20; i++) hex += Math.floor(random() * 16).toString(16);
  return `chart-${hex}`;
}

/** How long the chart keeps following a change before it stops waiting and says so. */
export const PENDING_TIMEOUT_MS = 120_000;

/** The pending changes still worth following at `now`. */
export function livePending(pending: readonly PendingChange[], now: number): PendingChange[] {
  return pending.filter((p) => now - p.startedAt < PENDING_TIMEOUT_MS);
}

/**
 * Where a dragged position / order line lands, and whether it is allowed to (the side of the price it must stay on).
 * `trigger` is the price that would close the position now (bid for a long, ask for a short), or the order's entry.
 */
export function dragSideProblem(
  kind: TradeLine['kind'],
  long: boolean,
  price: number,
  trigger: number | null,
): string | null {
  if (trigger === null) return null;
  const stopKind = kind === 'positionStop' || kind === 'orderStop';
  const targetKind = kind === 'positionTarget' || kind === 'orderTarget';
  if (stopKind && (long ? price >= trigger : price <= trigger))
    return `A ${long ? 'long' : 'short'}'s stop must stay ${long ? 'below' : 'above'} ${trigger}: there it would close at once.`;
  if (targetKind && (long ? price <= trigger : price >= trigger))
    return `A ${long ? 'long' : 'short'}'s target must stay ${long ? 'above' : 'below'} ${trigger}: there it would close at once.`;
  return null;
}
