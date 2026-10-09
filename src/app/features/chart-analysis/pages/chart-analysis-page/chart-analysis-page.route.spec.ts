import { describe, expect, it, vi } from 'vitest';
import { signal } from '@angular/core';
import { convertToParamMap } from '@angular/router';

import { ChartAnalysisPageComponent } from './chart-analysis-page.component';

// The page's symbol switch and its URL follower, run against just the state they touch (as the
// page's dock and editor specs do). The feed's history request never answers: what is counted is
// how many loads a switch starts, which is how many history requests reach the engine.

type Page = ChartAnalysisPageComponent & Record<string, any>;

function setup(url: { tf?: string } = {}) {
  const feed = {
    invalidate: vi.fn(),
    getBars: vi.fn(() => new Promise(() => undefined)),
    // 1m … 1h charts ask the symbol's session once (a one-bar `scripting/chart-bars`), not a load.
    learnSession: vi.fn(() => Promise.resolve(null)),
    sessionOf: vi.fn(() => null),
  };
  const router = { navigate: vi.fn(() => Promise.resolve(true)) };
  const p = Object.create(ChartAnalysisPageComponent.prototype) as Page;
  Object.assign(p, {
    symbol: signal('EURUSD'),
    resolution: signal('60'),
    replayActive: signal(false),
    replayHead: signal(null),
    // Layout memory per symbol (CC-I11): off unless a spec turns it on.
    rememberPerSymbol: signal(false),
    symbolMemory: signal({}),
    viewSnapshot: signal(null),
    pendingView: null,
    pendingViewFor: null,
    symbolMenuOpen: signal(false),
    symbolQuery: signal(''),
    loading: signal(false),
    error: signal<string | null>(null),
    requested: null,
    route: { snapshot: { queryParamMap: convertToParamMap(url) } },
    router,
    drawings: { setScope: vi.fn() },
    loadTradingOverlays: vi.fn(),
    rollover: { reset: vi.fn() },
    feed,
  });
  /** The router's paramMap emitting `params` (the page subscribes `followRoute` to it). */
  const follow = (params: Record<string, string>): void =>
    p['followRoute'](convertToParamMap(params));
  /** The symbols the history requests were for, in order. */
  const loads = (): string[] => feed.getBars.mock.calls.map((c: unknown[]) => c[0] as string);
  return { p, feed, router, follow, loads };
}

describe('chart page — layout memory per symbol (CC-I11)', () => {
  it('with it on, a symbol opens on the timeframe and zoom it was left on', () => {
    const { p, feed } = setup();
    const view = { barSpacing: 9, rightOffset: -20, paneHeights: [500] };
    p.rememberPerSymbol.set(true);
    p.resolution.set('240');
    p.viewSnapshot.set(view);
    p.selectSymbol('USDJPY'); // EURUSD left on 4h with that zoom
    p.resolution.set('15');
    p.viewSnapshot.set(null);
    p.selectSymbol('EURUSD');
    expect(p.resolution()).toBe('240');
    expect(feed.getBars).toHaveBeenLastCalledWith('EURUSD', '240', 0, expect.any(Number), 1500);
    expect(p['pendingView']).toEqual(view);
    expect(p['pendingViewFor']).toEqual({ symbol: 'EURUSD', resolution: '240' });
  });

  it('off, the timeframe stays as it is (it is still remembered for when it is turned on)', () => {
    const { p } = setup();
    p.resolution.set('240');
    p.selectSymbol('USDJPY');
    p.resolution.set('15');
    p.selectSymbol('EURUSD');
    expect(p.resolution()).toBe('15');
    expect(p.symbolMemory().EURUSD).toEqual({ resolution: '240' });
  });
});

describe('chart page — one load per symbol switch', () => {
  it('a symbol switch loads its series once: the navigation it makes is not loaded again', () => {
    const { p, feed, router, follow } = setup({ tf: '240' });
    p.resolution.set('240');

    p.selectSymbol('USDJPY');
    expect(feed.getBars).toHaveBeenCalledTimes(1);
    expect(feed.getBars).toHaveBeenLastCalledWith('USDJPY', '240', 0, expect.any(Number), 1500);
    expect(router.navigate).toHaveBeenCalledWith(['/chart-analysis', 'USDJPY'], {
      queryParams: { tf: '240' },
      replaceUrl: true,
    });

    // The router's paramMap echoing that navigation: the series is already loading.
    follow({ symbol: 'USDJPY' });
    expect(feed.getBars).toHaveBeenCalledTimes(1);
    expect(feed.invalidate).toHaveBeenCalledTimes(1);
  });

  it('a stored-grid switch also asks the symbol’s session; a session-grid switch does not', () => {
    const { p, feed } = setup();
    p.selectSymbol('USDJPY');
    expect(feed.learnSession).toHaveBeenCalledTimes(1);
    expect(feed.learnSession).toHaveBeenLastCalledWith('USDJPY');

    p.resolution.set('240');
    p.selectSymbol('GBPUSD');
    // The session-grid load reports the session itself.
    expect(feed.learnSession).toHaveBeenCalledTimes(1);
  });

  it('switching back loads the symbol again, once', () => {
    const { p, follow, loads } = setup();
    p.selectSymbol('USDJPY');
    follow({ symbol: 'USDJPY' });
    p.selectSymbol('EURUSD');
    follow({ symbol: 'EURUSD' });

    expect(loads()).toEqual(['USDJPY', 'EURUSD']);
  });

  it('a deep link opens on its symbol and timeframe', () => {
    const { p, feed, follow } = setup({ tf: '240' });

    follow({ symbol: 'gbpusd' });

    expect(p.symbol()).toBe('GBPUSD');
    expect(p.resolution()).toBe('240');
    expect(feed.getBars).toHaveBeenCalledTimes(1);
    expect(feed.getBars).toHaveBeenLastCalledWith('GBPUSD', '240', 0, expect.any(Number), 1500);
  });

  it('the page’s first URL loads the chart even when it names the default series', () => {
    const { feed, follow } = setup(); // bare /chart-analysis: EURUSD 1h, the chart's defaults

    follow({});

    expect(feed.getBars).toHaveBeenCalledTimes(1);
    expect(feed.getBars).toHaveBeenLastCalledWith('EURUSD', '60', 0, expect.any(Number), 1500);
  });

  it('a link to another symbol while the chart is open still switches it', () => {
    const { p, follow, loads } = setup();
    follow({ symbol: 'EURUSD' });

    follow({ symbol: 'XAUUSD' });

    expect(p.symbol()).toBe('XAUUSD');
    expect(loads()).toEqual(['EURUSD', 'XAUUSD']);
  });

  it('an unknown timeframe in the URL keeps the chart’s', () => {
    // Seconds have no source (no tick history); 7 minutes is a typed interval since CC-I8.
    const { p, feed, follow } = setup({ tf: '30S' });
    p.resolution.set('240');

    follow({ symbol: 'USDJPY' });

    expect(p.resolution()).toBe('240');
    expect(feed.getBars).toHaveBeenLastCalledWith('USDJPY', '240', 0, expect.any(Number), 1500);
  });

  it('a typed interval in the URL opens on it (CC-I8)', () => {
    const { p, feed, follow } = setup({ tf: '7' });
    follow({ symbol: 'USDJPY' });
    expect(p.resolution()).toBe('7');
    expect(feed.getBars).toHaveBeenLastCalledWith('USDJPY', '7', 0, expect.any(Number), 1500);
  });
});
