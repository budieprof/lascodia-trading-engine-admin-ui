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
    localStorage.setItem('lascodia.chart.pref.magnetStrength', 'strong');
    const { prefs, setPreference } = make([
      { key: 'lascodia.chart.favouriteStudies', value: '["rsi"]' },
    ]);
    await prefs.hydrate();
    expect(localStorage.getItem('lascodia.chart.favouriteStudies')).toBe('["rsi"]');
    await vi.advanceTimersByTimeAsync(900);
    expect(setPreference).toHaveBeenCalledTimes(1);
    expect(setPreference).toHaveBeenCalledWith('lascodia.chart.pref.magnetStrength', 'strong');
  });

  it('screen-dependent positions and splits stay on this device: never uploaded, never taken from the engine', async () => {
    localStorage.setItem('lascodia.chart.watchlist.split', '0.4');
    localStorage.setItem('lascodia.chart.drawing-toolbar.pos.v1', '{"x":40,"y":80}');
    const { prefs, setPreference } = make([
      { key: 'lascodia.chart.watchlist.split', value: '0.9' },
      { key: 'lascodia.chart.favoritesBar.pos.v1', value: '{"x":1500,"y":20}' },
    ]);
    await prefs.hydrate();
    prefs.setItem('lascodia.chart.watchlist.split', '0.5');
    await vi.advanceTimersByTimeAsync(900);
    expect(localStorage.getItem('lascodia.chart.watchlist.split')).toBe('0.5');
    expect(localStorage.getItem('lascodia.chart.favoritesBar.pos.v1')).toBeNull();
    expect(setPreference).not.toHaveBeenCalled();
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

  it('favourite intervals follow the operator to other machines (CC-I8)', async () => {
    const { prefs, setPreference } = make([]);
    prefs.setItem('lascodia.chart.pref.favouriteIntervals', '["45","180"]');
    await vi.advanceTimersByTimeAsync(900);
    expect(setPreference.mock.calls).toEqual([
      ['lascodia.chart.pref.favouriteIntervals', '["45","180"]'],
    ]);
  });
});
