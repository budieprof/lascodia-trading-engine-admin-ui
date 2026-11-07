import { describe, expect, it, vi } from 'vitest';
import { signal } from '@angular/core';
import { Subject, of } from 'rxjs';
import { TradeLayersLoader, type TradeLayersDeps } from './trade-layers-loader';

function setup() {
  const symbol = signal('EURUSD');
  const positionsReply = new Subject<unknown>();
  const deps = {
    symbol: () => symbol(),
    accountScope: { accountIds: () => [7], accountIdsKey: () => '7' },
    showPositions: () => true,
    showOrders: () => false,
    showClosedTrades: () => false,
    showOverlays: () => false,
    inTradeScope: () => () => true,
    positions: { list: vi.fn(() => positionsReply.asObservable()) },
    orders: { list: vi.fn(() => of(null)) },
    signals: { list: vi.fn(() => of(null)) },
    martingale: { getOverview: vi.fn(() => of(null)) },
    destroyRef: { onDestroy: () => () => undefined, destroyed: false },
  } as unknown as TradeLayersDeps;
  return { loader: new TradeLayersLoader(deps), deps, symbol, positionsReply };
}

describe('US02 TradeLayersLoader (moved from the page, behaviour unchanged)', () => {
  it('asks for the symbol\'s open positions in the account scope, nested filter', () => {
    const { loader, deps, positionsReply } = setup();
    loader.load();
    expect(deps.positions.list).toHaveBeenCalledWith({
      currentPage: 1,
      itemCountPerPage: 50,
      filter: { symbol: 'EURUSD', status: 'Open', tradingAccountIds: [7] },
    });
    positionsReply.next({ status: true, data: { data: [{ id: 1, symbol: 'EURUSD' }] } });
    expect(loader.openPositions()).toHaveLength(1);
  });

  it('drops a reply for a symbol the chart has left (CC-09); a toggle off clears its layer', () => {
    const { loader, symbol, positionsReply } = setup();
    loader.load();
    symbol.set('GBPUSD');
    positionsReply.next({ status: true, data: { data: [{ id: 1, symbol: 'EURUSD' }] } });
    expect(loader.openPositions()).toEqual([]);
    loader.workingOrders.set([{ id: 3 } as never]);
    loader.load();
    expect(loader.workingOrders()).toEqual([]);
  });
});
