import { describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';

import { NotificationService } from '@core/notifications/notification.service';
import { StrategiesService } from '@core/services/strategies.service';
import { declareSignalIo } from '@shared/testing/jit-signal-io';
import { StrategyLineageTabComponent } from './strategy-lineage-tab.component';

declareSignalIo(StrategyLineageTabComponent, { inputs: ['strategyId'] });

const node = (id: number, depthOffset: number, parentInTree: number | null) => ({
  id,
  name: `S${id}`,
  symbol: 'EURUSD',
  timeframe: 'H1',
  strategyType: 'RuleBased',
  status: 'Active',
  generation: 1,
  generationSource: null,
  createdAt: `2025-01-0${id}T00:00:00Z`,
  depthOffset,
  parentInTree,
});

describe('StrategyLineageTabComponent (U13 split, behaviour unchanged)', () => {
  it('reads the lineage of its strategy and draws the tree with links to the others', () => {
    const getLineage = vi
      .fn()
      .mockReturnValue(
        of({
          status: true,
          data: { focusStrategyId: 2, nodes: [node(1, -1, null), node(2, 0, 1), node(3, 1, 2)] },
        }),
      );
    TestBed.configureTestingModule({
      imports: [StrategyLineageTabComponent],
      providers: [
        provideRouter([]),
        { provide: StrategiesService, useValue: { getLineage } },
        { provide: NotificationService, useValue: { error: vi.fn() } },
      ],
    });
    const fixture = TestBed.createComponent(StrategyLineageTabComponent);
    fixture.componentRef.setInput('strategyId', 2);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(getLineage).toHaveBeenCalledWith(2);
    expect(el.textContent).toContain('1 ancestor(s) · 1 focus');
    expect(el.querySelectorAll('.lineage-tree-node')).toHaveLength(3);
    expect(el.querySelectorAll('path')).toHaveLength(2);
    expect(el.querySelector('.lineage-tree-node.is-focus')!.getAttribute('href')).toBeNull();
  });
});
