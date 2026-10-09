import { describe, expect, it, vi } from 'vitest';
import { signal } from '@angular/core';

import { ChartAnalysisPageComponent } from './chart-analysis-page.component';

// Compare overlays (CC-I12) on just the state they touch.

type Page = ChartAnalysisPageComponent & Record<string, any>;

function setup(mode = 'normal') {
  const p = Object.create(ChartAnalysisPageComponent.prototype) as Page;
  Object.assign(p, {
    compareSeries: signal([]),
    scaleMode: signal(mode),
    notify: { info: vi.fn() },
  });
  return p;
}

describe('chart page — compare overlays (CC-I12)', () => {
  it('a compare symbol turns the scale to Percent and says so', () => {
    const p = setup();
    p.addCompare({ id: 'a', kind: 'compare', symbols: ['GBPUSD'], color: '#FF6D00' });
    expect(p.compareSeries()).toHaveLength(1);
    expect(p.scaleMode()).toBe('percent');
    expect(p['notify'].info).toHaveBeenCalled();
  });

  it('indexed to 100 already compares; a ratio in its own pane leaves the scale alone', () => {
    const p = setup('indexed');
    p.addCompare({ id: 'a', kind: 'compare', symbols: ['GBPUSD'], color: '#FF6D00' });
    expect(p.scaleMode()).toBe('indexed');
    const q = setup('log');
    q.addCompare({ id: 'b', kind: 'ratio', symbols: ['EURUSD', 'GBPUSD'], color: '#FF6D00' });
    expect(q.scaleMode()).toBe('log');
    q.removeCompare('b');
    expect(q.compareSeries()).toEqual([]);
  });
});
