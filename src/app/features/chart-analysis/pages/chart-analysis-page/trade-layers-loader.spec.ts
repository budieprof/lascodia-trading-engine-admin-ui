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

  it('asks for working orders by `search` (OrderQueryFilter has no symbol), one query per working status', () => {
    const { deps } = setup();
    const orderReply = (status: string) =>
      of({ status: true, data: { data: [
        { id: status.length, symbol: 'EURUSD', status },
        { id: 100 + status.length, symbol: 'EURUSDX', status },
      ] } });
    (deps as unknown as { showOrders: () => boolean }).showOrders = () => true;
    (deps.orders.list as ReturnType<typeof vi.fn>).mockImplementation(
      (req: { filter: { status: string } }) => orderReply(req.filter.status),
    );
    const loader = new TradeLayersLoader(deps);
    loader.load();
    const calls = (deps.orders.list as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(calls.map((c) => c.filter.status)).toEqual(['Pending', 'Submitted', 'PartialFill']);
    for (const c of calls) {
      expect(c.filter).toMatchObject({ search: 'EURUSD', tradingAccountIds: [7] });
      expect(c.filter).not.toHaveProperty('symbol');
    }
    // Only the exact symbol is drawn (search is a contains-match).
    expect(loader.workingOrders().map((o) => o.symbol)).toEqual(['EURUSD', 'EURUSD', 'EURUSD']);
  });

  it('asks for trade signals by `search`, not the ignored `symbol`', () => {
    const { deps } = setup();
    (deps as unknown as { showOverlays: () => boolean }).showOverlays = () => true;
    new TradeLayersLoader(deps).load();
    expect(deps.signals.list).toHaveBeenCalledWith(
      expect.objectContaining({ filter: { search: 'EURUSD' } }),
    );
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
