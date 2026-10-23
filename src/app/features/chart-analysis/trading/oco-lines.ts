import type { OcoGroup } from './manual-trading.types';
import type { TradeLine } from './trade-lines';

/**
 * OCO pairs on the chart (C8): each working leg of an open pair as a purple line at its entry, labelled with the pair
 * so the two legs read as linked ("OCO #12 · BUY 1/2", "OCO #12 · SELL 2/2"). Clicking one asks to cancel the pair.
 * A leg that filled is a position (drawn by the trade layer); a leg that is gone is not drawn. Pure.
 */

export const OCO_COLOR = '#9C27B0';

const WORKING = new Set(['SignalWorking', 'OrderUnplaced', 'OrderWorking', 'Cancelling', 'Unknown']);
const OPEN = new Set(['Active', 'Triggered', 'Cancelling', 'NeedsAttention']);

export function ocoLines(
  groups: readonly OcoGroup[],
  symbol: string,
  inScope: (accountId: number | null | undefined) => boolean,
): TradeLine[] {
  const s = symbol.toUpperCase();
  const lines: TradeLine[] = [];
  for (const g of groups) {
    if ((g.symbol ?? '').toUpperCase() !== s || !inScope(g.tradingAccountId) || !OPEN.has(String(g.status))) continue;
    for (const leg of g.legs) {
      if (!WORKING.has(String(leg.phase)) || !(leg.entryPrice > 0)) continue;
      const cancelling = leg.phase === 'Cancelling' || g.cancelRequested || g.status === 'Triggered';
      lines.push({
        key: `oco:${g.id}:${leg.leg}`,
        kind: 'ocoLeg',
        price: leg.entryPrice,
        label: `OCO #${g.id} · ${String(leg.direction).toUpperCase()} ${leg.leg}/2${cancelling ? ' · cancelling' : ''}${
          g.status === 'NeedsAttention' ? ' · NEEDS ATTENTION' : ''
        }`,
        color: OCO_COLOR,
        draggable: false,
        clickable: !g.cancelRequested,
        drawn: true,
        refId: g.id,
        faded: cancelling,
      });
    }
  }
  return lines;
}

/** order id → the open pair it is a leg of. */
export function ocoOrderIndex(groups: readonly OcoGroup[]): Map<number, OcoGroup> {
  const m = new Map<number, OcoGroup>();
  for (const g of groups) for (const leg of g.legs) if (leg.orderId !== null) m.set(leg.orderId, g);
  return m;
}
