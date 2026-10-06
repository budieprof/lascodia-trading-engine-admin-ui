import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Injector } from '@angular/core';
import { of } from 'rxjs';

import { ChartLayoutsService } from '@core/services/chart-layouts.service';
import { ChartPrefsService } from './chart-prefs.service';

function make(server: { key: string; value: unknown }[]) {
  const setPreference = vi.fn(() =>
    of({ status: true, data: null, message: '', responseCode: '00' }),
  );
  const injector = Injector.create({
    providers: [
      {
        provide: ChartLayoutsService,
        useValue: {
          preferences: () => of({ status: true, data: server, message: '', responseCode: '00' }),
          setPreference,
          sendOnUnload: vi.fn(),
        },
      },
      { provide: ChartPrefsService, useClass: ChartPrefsService },
    ],
  });
  return { prefs: injector.get(ChartPrefsService), setPreference };
}

describe('ChartPrefsService', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('hydrate: the engine wins in the cache, and local-only keys are uploaded once', async () => {
    localStorage.setItem('lascodia.chart.favouriteStudies', '["old"]');
    localStorage.setItem('lascodia.chart.watchlist.split', '0.4');
    const { prefs, setPreference } = make([
      { key: 'lascodia.chart.favouriteStudies', value: '["rsi"]' },
    ]);
    await prefs.hydrate();
    expect(localStorage.getItem('lascodia.chart.favouriteStudies')).toBe('["rsi"]');
    await vi.advanceTimersByTimeAsync(900);
    expect(setPreference).toHaveBeenCalledTimes(1);
    expect(setPreference).toHaveBeenCalledWith('lascodia.chart.watchlist.split', '0.4');
  });

  it('setItem writes the cache at once and pushes synced keys after a debounce, unsynced never', async () => {
    const { prefs, setPreference } = make([]);
    prefs.setItem('lascodia.chart.favouriteStudies', '["a"]');
    prefs.setItem('lascodia.chart.favouriteStudies', '["a","b"]');
    prefs.setItem('something.else', 'x');
    expect(localStorage.getItem('lascodia.chart.favouriteStudies')).toBe('["a","b"]');
    await vi.advanceTimersByTimeAsync(900);
    expect(setPreference.mock.calls).toEqual([['lascodia.chart.favouriteStudies', '["a","b"]']]);
  });
});
