import { describe, expect, it, vi } from 'vitest';
import { Injector, runInInjectionContext } from '@angular/core';

// afterNextRender needs a renderer; the delete flow does not.
vi.mock('@angular/core', async (orig) => ({
  ...(await orig<typeof import('@angular/core')>()),
  afterNextRender: () => ({ destroy: () => undefined }),
}));

import { IndicatorsDialogComponent } from './indicators-dialog.component';
import type { DialogItem } from './dialog-items';
import { ChartPrefsService } from '../workspace/chart-prefs.service';

const mine: DialogItem = {
  kind: 'script',
  id: 'mine:7',
  name: 'EMA',
  category: 'My scripts',
  deletable: true,
};
const builtIn: DialogItem = { kind: 'indicator', id: 'rsi', name: 'RSI', category: 'Oscillators' };

function make(): IndicatorsDialogComponent {
  return runInInjectionContext(
    Injector.create({
      providers: [
        { provide: ChartPrefsService, useValue: { setItem: vi.fn(), getItem: () => null } },
      ],
    }),
    () => new IndicatorsDialogComponent(),
  );
}

describe('IndicatorsDialogComponent — delete with confirm', () => {
  it('asks first, emits only on confirm, then closes the confirmation', () => {
    const cmp = make();
    const spy = vi.fn();
    cmp.deleteRequested.subscribe(spy);
    cmp.askDelete(mine);
    expect(cmp.confirming()).toBe('script:mine:7');
    expect(spy).not.toHaveBeenCalled();
    cmp.confirmDelete(mine);
    expect(spy).toHaveBeenCalledWith(mine);
    expect(cmp.confirming()).toBeNull();
  });

  it('cancel emits nothing', () => {
    const cmp = make();
    const spy = vi.fn();
    cmp.deleteRequested.subscribe(spy);
    cmp.askDelete(mine);
    cmp.cancelDelete();
    cmp.confirmDelete(mine);
    expect(spy).not.toHaveBeenCalled();
    expect(cmp.confirming()).toBeNull();
  });

  it('non-deletable items never enter the confirm step', () => {
    const cmp = make();
    const spy = vi.fn();
    cmp.deleteRequested.subscribe(spy);
    cmp.askDelete(builtIn);
    cmp.confirmDelete(builtIn);
    expect(cmp.confirming()).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});
