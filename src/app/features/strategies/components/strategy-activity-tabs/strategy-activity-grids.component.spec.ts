import { describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom, of } from 'rxjs';

import { OrdersService } from '@core/services/orders.service';
import { TradeSignalsService } from '@core/services/trade-signals.service';
import { declareSignalIo } from '@shared/testing/jit-signal-io';
import { StrategyOrdersGridComponent } from './strategy-orders-grid.component';
import { StrategySignalsGridComponent } from './strategy-signals-grid.component';

declareSignalIo(StrategySignalsGridComponent, { inputs: ['strategyId', 'currentHash'] });
declareSignalIo(StrategyOrdersGridComponent, { inputs: ['strategyId'] });

// U13: the Signals and Orders grids moved out of the strategy detail page unchanged.
describe('strategy detail activity grids (U13 split)', () => {
  it('signals: filters the list to the strategy and marks rows of an older configuration', async () => {
    const list = vi.fn().mockReturnValue(of({ data: { pager: {}, data: [] } }));
    TestBed.configureTestingModule({
      imports: [StrategySignalsGridComponent],
      providers: [{ provide: TradeSignalsService, useValue: { list } }],
    });
    const fixture = TestBed.createComponent(StrategySignalsGridComponent);
    fixture.componentRef.setInput('strategyId', 7);
    fixture.componentRef.setInput('currentHash', 'b'.repeat(64));
    const cmp = fixture.componentInstance as unknown as {
      fetchSignals: (p: object) => ReturnType<typeof of>;
      signalColumns: {
        colId?: string;
        field?: string;
        valueFormatter?: (p: { value: unknown }) => string;
      }[];
    };
    await firstValueFrom(cmp.fetchSignals({ currentPage: 2, filter: { search: 'x' } }));
    expect(list).toHaveBeenCalledWith({ currentPage: 2, filter: { search: 'x', strategyId: 7 } });
    const hash = cmp.signalColumns.find((c) => c.colId === 'strategyConfigHash')!;
    expect(hash.valueFormatter!({ value: 'a'.repeat(64) })).toBe('aaaaaaaa (older)');
    expect(cmp.signalColumns.map((c) => c.field).slice(0, 3)).toEqual([
      'id',
      'symbol',
      'direction',
    ]);
  });

  it('orders: filters the list to the strategy', async () => {
    const list = vi.fn().mockReturnValue(of({ data: { pager: {}, data: [] } }));
    TestBed.configureTestingModule({
      imports: [StrategyOrdersGridComponent],
      providers: [{ provide: OrdersService, useValue: { list } }],
    });
    const fixture = TestBed.createComponent(StrategyOrdersGridComponent);
    fixture.componentRef.setInput('strategyId', 7);
    const cmp = fixture.componentInstance as unknown as {
      fetchOrders: (p: object) => ReturnType<typeof of>;
    };
    await firstValueFrom(cmp.fetchOrders({ currentPage: 1 }));
    expect(list).toHaveBeenCalledWith({ currentPage: 1, filter: { strategyId: 7 } });
  });
});
