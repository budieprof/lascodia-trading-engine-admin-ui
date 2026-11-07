import { describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import { firstValueFrom, of } from 'rxjs';

import type { StrategyDto } from '@core/api/api.types';
import { BacktestsService } from '@core/services/backtests.service';
import { declareSignalIo } from '@shared/testing/jit-signal-io';
import { StrategyBacktestsTabComponent } from './strategy-backtests-tab.component';

declareSignalIo(StrategyBacktestsTabComponent, { inputs: ['strategy', 'isScript'] });

// U13: the Backtests tab moved out of the strategy detail page unchanged.
describe('StrategyBacktestsTabComponent (U13 split)', () => {
  it('lists the strategy’s runs, formats the UTC window and opens a run on click', async () => {
    const list = vi.fn().mockReturnValue(of({ data: { pager: {}, data: [] } }));
    const navigate = vi.fn();
    TestBed.configureTestingModule({
      imports: [StrategyBacktestsTabComponent],
      providers: [
        { provide: BacktestsService, useValue: { list } },
        { provide: Router, useValue: { navigate } },
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: RUNTIME_CONFIG, useValue: { apiBaseUrl: 'http://test' } },
      ],
    });
    const fixture = TestBed.createComponent(StrategyBacktestsTabComponent);
    fixture.componentRef.setInput('strategy', {
      id: 9,
      strategyConfigHash: 'b'.repeat(64),
    } as unknown as StrategyDto);
    const cmp = fixture.componentInstance as unknown as {
      fetchBacktests: (p: object) => ReturnType<typeof of>;
      backtestColumns: {
        colId?: string;
        valueFormatter?: (p: { value?: unknown; data?: unknown }) => string;
      }[];
      onBacktestRowClick: (r: { id: number }) => void;
    };
    await firstValueFrom(cmp.fetchBacktests({ currentPage: 1 }));
    expect(list).toHaveBeenCalledWith({ currentPage: 1, filter: { strategyId: 9 } });
    const hash = cmp.backtestColumns.find((c) => c.colId === 'strategyConfigHash')!;
    expect(hash.valueFormatter!({ value: 'b'.repeat(64) })).toBe('bbbbbbbb');
    cmp.onBacktestRowClick({ id: 812 });
    expect(navigate).toHaveBeenCalledWith(['/backtests', 812]);
  });
});
