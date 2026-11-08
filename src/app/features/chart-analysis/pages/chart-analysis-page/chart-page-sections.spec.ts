import { DestroyRef, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { convertToParamMap, type ParamMap } from '@angular/router';
import { BehaviorSubject, Subject, of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import { ensureTestBed } from '@core/testing/zoneless-test-bed';
import type { Bar } from '../../datafeed/candle-feed.service';
import type { InstrumentFacts } from '../../datafeed/instrument-facts';
import type { EventMark } from '../../overlays/event-marks-renderer';
import type { ActiveIndicator } from '../../chart/chart-host.component';
import type { NewsArticleIngestedPayload } from '../../panels/news-pane';
import { ChartAlertsController, type ChartAlertsControllerDeps } from './chart-alerts-controller';
import { ChartEventsState } from './chart-events-state';
import { ChartLayoutActions, type ChartLayoutActionsDeps } from './chart-layout-actions';
import { ChartNewsPane } from './chart-news-pane';
import { ChartFundamentalsLoader } from './chart-fundamentals-loader';
import { ChartSeriesAdjustments } from './chart-series-adjustments';
import { ChartSymbolSearch } from './chart-symbol-search';
import { ChartTimeNavigator } from './chart-time-navigator';
import { ChartTradeTimeline } from './chart-trade-timeline';
import type { ReplayController } from '../../replay/replay-controller';

// b9-maint: the chart page's events layer, side panes, price alerts and layout actions, moved out of the page behaviour
// for behaviour. These cases pin what the page did with them (the page itself delegates; its route, history, runs and
// overlays-persist specs still drive the page).

ensureTestBed();

const H = 3_600_000;
const bar = (i: number): Bar => ({ time: i * H, open: 1, high: 1, low: 1, close: 1, volume: 1 });
const eurusd = {
  resolving: false,
  assetClass: 'Fx',
  instrument: { symbol: 'EURUSD', baseCurrency: 'EUR', quoteCurrency: 'USD' },
} as unknown as InstrumentFacts;

function events(opts: { replay?: boolean; shown?: Bar[] } = {}) {
  const showEvents = signal(true);
  const minEventImpact = signal<'High' | 'Medium' | 'Low'>('Medium');
  const marks: EventMark[] = [{ time: 2 * H } as EventMark, { time: 9 * H } as EventMark];
  const eventsFeed = {
    load: vi.fn(() => Promise.resolve(marks)),
    blackout: vi.fn(() => Promise.resolve(null)),
  };
  const state = TestBed.runInInjectionContext(
    () =>
      new ChartEventsState({
        symbol: () => 'EURUSD',
        facts: () => eurusd,
        currentPair: () => undefined,
        bars: () => [bar(1), bar(2), bar(3)],
        replayActive: () => !!opts.replay,
        displayBars: () => opts.shown ?? [],
        showEvents,
        minEventImpact,
        showBlackout: () => true,
        feed: { factsOf: () => null } as never,
        instruments: { calendar: () => Promise.resolve(null) } as never,
        eventsFeed: eventsFeed as never,
      }),
  );
  return { state, showEvents, minEventImpact, eventsFeed, marks };
}

describe('ChartEventsState', () => {
  it('loads the pair\'s two currencies at the chart\'s importance and holds them for the symbol', async () => {
    const { state, eventsFeed, marks } = events();
    expect(state.pairCurrencies()).toEqual(['EUR', 'USD']);
    state.loadEvents();
    expect(eventsFeed.load).toHaveBeenCalledWith(
      expect.objectContaining({ currencies: ['EUR', 'USD'], minImpact: 'Medium', symbol: 'EURUSD' }),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(state.events()).toEqual(marks);
    expect(state.holdsEventsFor('eurusd')).toBe(true);
    expect(state.holdsEventsFor('GBPUSD')).toBe(false);
  });

  it('switched off clears the layer and drops a reply in flight', async () => {
    const { state, showEvents, eventsFeed } = events();
    state.loadEvents();
    state.toggleEvents(); // off
    expect(showEvents()).toBe(false);
    expect(eventsFeed.load).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(state.events()).toEqual([]);
    expect(state.holdsEventsFor('EURUSD')).toBe(false);
  });

  it('the importance cycles High → Medium → Low and asks again', () => {
    const { state, minEventImpact, eventsFeed } = events();
    state.cycleEventImpact();
    expect(minEventImpact()).toBe('Low');
    state.cycleEventImpact();
    expect(minEventImpact()).toBe('High');
    expect(eventsFeed.load).toHaveBeenCalledTimes(2);
  });

  it('in replay draws no event after the head', () => {
    const { state, marks } = events({ replay: true, shown: [bar(1), bar(5)] });
    state.events.set(marks);
    expect(state.chartEvents().map((e) => e.time)).toEqual([2 * H]);
  });

  it('the blackout chip says what it shades before the window is known', () => {
    expect(events().state.blackoutTitle()).toBe('Shade the news blackout around high-impact events');
  });
});

function news() {
  const chartPanels = { close: vi.fn(), toggle: vi.fn() };
  const newsIntel = {
    getArticles: vi.fn(() => of([])),
    getFocus: vi.fn(() => of(null)),
  };
  const watchlistOpen = signal(false);
  const pane = TestBed.runInInjectionContext(
    () =>
      new ChartNewsPane({
        symbol: () => 'EURUSD',
        symbols: () => [{ symbol: 'EURUSD', baseCurrency: 'EUR', quoteCurrency: 'USD' } as never],
        eventRelevance: () => ({ kind: 'fx', currencies: ['EUR', 'USD'] }) as never,
        pairCurrencies: () => ['EUR', 'USD'],
        details: () => ({ base: 'EUR', quote: 'USD' }),
        watchlistOpen,
        chartPanels,
        newsIntel: newsIntel as never,
        destroyRef: TestBed.inject(DestroyRef),
      }),
  );
  return { pane, chartPanels, newsIntel, watchlistOpen };
}

describe('ChartNewsPane', () => {
  it('a pane toggles, closes the SP-I9 panels, and the news pane reads both currencies', () => {
    const { pane, chartPanels, newsIntel } = news();
    pane.openSidePane('news');
    expect(pane.sidePane()).toBe('news');
    expect(chartPanels.close).toHaveBeenCalledTimes(1);
    expect(newsIntel.getArticles.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
      { currency: 'EUR', hours: 48, take: 40 },
      { currency: 'USD', hours: 48, take: 40 },
    ]);
    expect(newsIntel.getFocus).toHaveBeenCalledWith('EURUSD');
    expect(pane.newsLoading()).toBe(false);
    pane.openSidePane('news');
    expect(pane.sidePane()).toBe('none');
  });

  it('an SP-I9 panel replaces any open pane', () => {
    const { pane, chartPanels } = news();
    pane.openSidePane('details');
    pane.openPanel('notes');
    expect(pane.sidePane()).toBe('none');
    expect(chartPanels.toggle).toHaveBeenCalledWith('notes');
  });

  it('the calendar lists the pair\'s two currencies for FX', () => {
    expect(news().pane.calendarCurrencies()).toEqual(['EUR', 'USD']);
  });

  it('a headline for the pair re-reads the open news pane once per burst', () => {
    vi.useFakeTimers();
    try {
      const { pane, newsIntel } = news();
      const ingested = new Subject<NewsArticleIngestedPayload>();
      pane.followIngested(ingested);
      ingested.next({ currencies: ['USD'] } as never); // pane closed, watchlist closed: ignored
      vi.advanceTimersByTime(2_000);
      expect(newsIntel.getArticles).not.toHaveBeenCalled();
      pane.sidePane.set('news');
      ingested.next({ currencies: ['USD'] } as never);
      ingested.next({ currencies: ['EUR'] } as never);
      vi.advanceTimersByTime(1_500);
      expect(newsIntel.getFocus).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

function alerts(query = new BehaviorSubject<ParamMap>(convertToParamMap({}))) {
  const contextMenu = signal<{ price?: number | null; level?: { price: number } | null } | null>(null);
  const openMenu = signal<string | null>(null);
  const notify = { success: vi.fn(), error: vi.fn(), warning: vi.fn() };
  const deps: ChartAlertsControllerDeps = {
    symbol: () => 'EURUSD',
    resolution: () => '60',
    logScale: () => false,
    precision: () => 5,
    host: () => undefined,
    contextMenu: () => contextMenu(),
    closeContextMenu: () => contextMenu.set(null),
    openAlertMenu: () => openMenu.set('alert'),
    closeMenus: () => openMenu.set(null),
    toggleAlertMenu: () => openMenu.set(openMenu() === 'alert' ? null : 'alert'),
    alertMoveDialog: () => undefined,
    queryParamMap: query,
    drawings: { allDrawings: () => [] } as never,
    chartAlerts: { alerts: signal([]), ensureLoaded: vi.fn(), update: vi.fn() } as never,
    notify: notify as never,
    destroyRef: TestBed.inject(DestroyRef),
  };
  const c = TestBed.runInInjectionContext(() => new ChartAlertsController(deps));
  return { c, contextMenu, openMenu, notify, query };
}

describe('ChartAlertsController', () => {
  it('"Add alert here" opens the form at the right-clicked price; no price, no form', () => {
    const { c, contextMenu, openMenu } = alerts();
    contextMenu.set({ price: null });
    c.createAlertHere();
    expect(openMenu()).toBeNull();
    expect(contextMenu()).toBeNull();
    contextMenu.set({ price: 1.0842 });
    c.createAlertHere();
    expect(c.alertPreset()).toBe(1.0842);
    expect(c.alertDraft()).toBeNull();
    expect(openMenu()).toBe('alert');
    expect(contextMenu()).toBeNull();
  });

  it('an alert at a derived level uses the level\'s exact price', () => {
    const { c, contextMenu, openMenu } = alerts();
    contextMenu.set({ price: 1.2, level: { price: 1.08425 } });
    c.createAlertAtLevel();
    expect(c.alertPreset()).toBe(1.08425);
    expect(openMenu()).toBe('alert');
  });

  it('a drawing that cannot carry an alert says so and opens nothing', () => {
    const { c, openMenu, notify } = alerts();
    c.addDrawingAlert({ id: 'missing' });
    expect(notify.error).toHaveBeenCalled();
    expect(openMenu()).toBeNull();
  });

  it('saving closes the form and names what fires', () => {
    const { c, openMenu, notify } = alerts();
    openMenu.set('alert');
    c.onAlertSaved();
    expect(openMenu()).toBeNull();
    expect(notify.success).toHaveBeenCalledWith('Alert set — it fires when price crosses the level.');
  });

  it('a bell link (?alert= / ?scriptAlert=) opens the manager on it; closing clears both', () => {
    const query = new BehaviorSubject<ParamMap>(convertToParamMap({ alert: '12' }));
    const { c } = alerts(query);
    TestBed.runInInjectionContext(() => c.connect());
    TestBed.tick();
    expect(c.alertManagerOpen()).toBe(true);
    expect(c.alertFocusId()).toBe(12);
    query.next(convertToParamMap({ scriptAlert: '7' }));
    TestBed.tick();
    expect(c.scriptAlertFocusId()).toBe(7);
    c.toggleAlertManager();
    expect(c.alertManagerOpen()).toBe(false);
    expect(c.alertFocusId()).toBeNull();
    expect(c.scriptAlertFocusId()).toBeNull();
  });
});

function layout(opts: { confirm?: boolean; name?: string | null; studies?: number } = {}) {
  const layoutMenuOpen = signal(true);
  const active = signal<ActiveIndicator[]>(
    Array.from({ length: opts.studies ?? 0 }, (_, i) => ({ uid: `s${i}` }) as ActiveIndicator),
  );
  const workspace = {
    newLayout: vi.fn(() => Promise.resolve(true)),
    rename: vi.fn(() => Promise.resolve(true)),
    duplicate: vi.fn(() => Promise.resolve(true)),
    switchTo: vi.fn(() => Promise.resolve(true)),
    remove: vi.fn(() => Promise.resolve(true)),
    layouts: signal([{ id: 3, name: 'Scalping' }]),
    active: signal({ id: 3, name: 'Scalping', version: 1 }),
  };
  const dialogs = {
    ask: vi.fn(() =>
      Promise.resolve(opts.name === null ? { choice: null, text: '' } : { choice: 'ok', text: opts.name ?? 'Mine' }),
    ),
    confirm: vi.fn(() => Promise.resolve(opts.confirm ?? false)),
  };
  const layoutStore = { saveTemplate: vi.fn(), instantiate: vi.fn(() => []), removeTemplate: vi.fn() };
  const notify = { success: vi.fn(), error: vi.fn() };
  const deps: ChartLayoutActionsDeps = {
    layoutMenuOpen,
    active,
    isFullscreen: signal(false),
    title: () => 'EURUSD · 1h · Candles',
    fileStem: () => 'EURUSD-1h',
    closeContextMenu: vi.fn(),
    host: () => undefined,
    workspace: workspace as never,
    layoutStore: layoutStore as never,
    dialogs: dialogs as never,
    notify: notify as never,
  };
  return { a: new ChartLayoutActions(deps), deps, workspace, dialogs, layoutStore, notify, layoutMenuOpen };
}

describe('ChartLayoutActions', () => {
  it('a copy is named after the layout and closes the menu', async () => {
    const { a, workspace, dialogs, layoutMenuOpen } = layout({ name: 'Scalping 2' });
    await a.duplicateLayout();
    expect(layoutMenuOpen()).toBe(false);
    expect((dialogs.ask.mock.calls[0] as unknown[])[0]).toEqual(
      expect.objectContaining({ field: expect.objectContaining({ value: 'Scalping copy' }) }),
    );
    expect(workspace.duplicate).toHaveBeenCalledWith('Scalping 2');
  });

  it('a cancelled name creates nothing', async () => {
    const { a, workspace } = layout({ name: null });
    await a.newLayout();
    expect(workspace.newLayout).not.toHaveBeenCalled();
  });

  it('a layout is deleted only after the operator confirms', async () => {
    const no = layout({ confirm: false });
    no.a.removeLayout(3, new Event('click'));
    await Promise.resolve();
    await Promise.resolve();
    expect(no.dialogs.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Delete layout “Scalping”?' }));
    expect(no.workspace.remove).not.toHaveBeenCalled();
    const yes = layout({ confirm: true });
    yes.a.removeLayout(3, new Event('click'));
    await Promise.resolve();
    await Promise.resolve();
    expect(yes.workspace.remove).toHaveBeenCalledWith(3);
  });

  it('a template needs studies on the chart', async () => {
    const empty = layout({ studies: 0 });
    await empty.a.saveTemplate();
    expect(empty.dialogs.ask).not.toHaveBeenCalled();
    const two = layout({ studies: 2, name: 'Trend' });
    await two.a.saveTemplate();
    expect(two.layoutStore.saveTemplate).toHaveBeenCalledWith('Trend', two.deps.active());
  });

  it('a snapshot of a chart not drawn yet says so', () => {
    const { a, notify, deps } = layout();
    const r = a.takeSnapshot();
    expect(r.ok).toBe(false);
    expect(notify.error).toHaveBeenCalledWith(r.message);
    expect(deps.closeContextMenu).toHaveBeenCalled();
  });
});

describe('ChartFundamentalsLoader', () => {
  function loader() {
    const scriptError = signal<string | null>(null);
    const fundamentals = {
      rateDifferential: vi.fn(() => of([{ time: 1, value: 0.5 }])),
      carryPanes: vi.fn(),
      newsPressureDifference: vi.fn(),
      surpriseIndex: vi.fn(),
    };
    const l = new ChartFundamentalsLoader({
      paneScope: () => ({ symbol: 'EURUSD', kind: 'fx', perpetual: false, sourceId: null, futureRoot: null, currencies: ['EUR', 'USD'] }) as never,
      bars: () => [],
      scriptError: () => scriptError,
      fundamentals: fundamentals as never,
      dailyBars: { daily: vi.fn() } as never,
      marketPanes: { load: vi.fn() } as never,
      destroyRef: TestBed.inject(DestroyRef),
    });
    return { l, fundamentals, scriptError };
  }

  it('no fundamental study clears the panes', () => {
    const { l } = loader();
    l.panes.set([{ uid: 'x', lines: [] }]);
    l.load([], 'EURUSD');
    expect(l.panes()).toEqual([]);
  });

  it('the FX rate differential is drawn as base − quote', () => {
    const { l, fundamentals } = loader();
    l.load([{ uid: 'r1', defId: 'fund:rate-differential', params: {} } as unknown as ActiveIndicator], 'EURUSD');
    expect(fundamentals.rateDifferential).toHaveBeenCalledWith('EURUSD');
    expect(l.panes()).toEqual([
      { uid: 'r1', lines: [{ title: 'EUR−USD rate %', color: '#2962FF', points: [{ time: 1, value: 0.5 }] }] },
    ]);
  });

  it('a pane that fails says so on the error line and stays empty', () => {
    const { l, fundamentals, scriptError } = loader();
    fundamentals.rateDifferential.mockReturnValue(throwError(() => new Error('down')) as never);
    l.load([{ uid: 'r1', defId: 'fund:rate-differential', params: {} } as unknown as ActiveIndicator], 'EURUSD');
    expect(scriptError()).toMatch(/: down$/);
    expect(l.panes()).toEqual([{ uid: 'r1', lines: [] }]);
  });
});

describe('ChartSeriesAdjustments', () => {
  function adj(symbol: string, adjustment: 'none' | 'splits' | 'all' | null = null) {
    const feed = {
      factsOf: vi.fn(() => null),
      adjustmentOf: vi.fn(() => adjustment),
      setAdjustment: vi.fn(),
    };
    const selectSymbol = vi.fn();
    const reload = vi.fn(() => Promise.resolve());
    const futuresRolls = { rolls: vi.fn(() => Promise.resolve([])) };
    const a = TestBed.runInInjectionContext(
      () =>
        new ChartSeriesAdjustments({
          symbol: () => symbol,
          bars: () => [],
          precision: () => 2,
          assetClass: () => 'Equity',
          selectSymbol,
          reload,
          feed: feed as never,
          futuresRolls: futuresRolls as never,
        }),
    );
    return { a, feed, selectSymbol, reload, futuresRolls };
  }

  it('a continuous future switches to its raw / adjusted counterpart', () => {
    const { a, selectSymbol } = adj('ES1!');
    a.switchContinuousSeries();
    expect(selectSymbol).toHaveBeenCalledWith('ES1!U');
  });

  it('a symbol that is no continuous future switches nothing', () => {
    const { a, selectSymbol } = adj('AAPL');
    a.switchContinuousSeries();
    expect(selectSymbol).not.toHaveBeenCalled();
  });

  it('a new equity adjustment is set on the feed and reloads; the same one does nothing', () => {
    const same = adj('AAPL', 'splits');
    same.a.setSeriesAdjustment('splits');
    expect(same.feed.setAdjustment).not.toHaveBeenCalled();
    const other = adj('AAPL', 'none');
    other.a.setSeriesAdjustment('all');
    expect(other.feed.setAdjustment).toHaveBeenCalledWith('AAPL', 'all');
    expect(other.reload).toHaveBeenCalled();
    expect(other.a.seriesOptions()?.equity?.asked).toBe('all');
  });

  it('a continuous future reads its rolls once per root', async () => {
    const { a, futuresRolls } = adj('ES1!');
    TestBed.tick();
    await Promise.resolve();
    expect(futuresRolls.rolls).toHaveBeenCalledWith('ES');
    expect(a.seriesOptions()?.continuous).toEqual({ adjusted: true, rollsNote: 'no rolls recorded yet' });
  });
});

describe('ChartSymbolSearch', () => {
  function search(query = '') {
    const selectSymbol = vi.fn();
    const s = TestBed.runInInjectionContext(
      () =>
        new ChartSymbolSearch({
          open: () => true,
          query: () => query,
          symbols: () => [
            { symbol: 'EURUSD', baseCurrency: 'EUR', quoteCurrency: 'USD', assetClass: 'Fx' } as never,
            { symbol: 'GBPUSD', baseCurrency: 'GBP', quoteCurrency: 'USD', assetClass: 'Fx' } as never,
          ],
          selectSymbol,
          instruments: {
            source: () => 'pairs',
            assetClasses: () => [],
            all: () => [],
            search: vi.fn(() => Promise.resolve({ rows: [], total: 0 })),
          } as never,
          destroyRef: TestBed.inject(DestroyRef),
        }),
    );
    return { s, selectSymbol };
  }

  it('lists the pairs while the engine has no instrument master, with an FX description', () => {
    const { s } = search();
    expect(s.filteredSymbols().map((r) => r.symbol)).toEqual(expect.arrayContaining(['EURUSD', 'GBPUSD']));
    expect(s.symbolClasses()).toEqual([]);
    expect(s.symbolDescription('AUDCAD', 'AUDCAD')).toBe('AUD/CAD');
    expect(s.symbolDescription('AAPL', 'Apple Inc.')).toBe('Apple Inc.');
  });

  it('Enter picks the best match', () => {
    const { s, selectSymbol } = search('GBP');
    s.pickFirstSymbol();
    expect(selectSymbol).toHaveBeenCalledWith('GBPUSD');
  });
});

describe('ChartTimeNavigator', () => {
  function nav(bars: Bar[] = [bar(1), bar(2), bar(3)]) {
    const host = {
      fitContent: vi.fn(),
      setVisibleRange: vi.fn(() => true),
      pickPoint: vi.fn(() => Promise.resolve({ time: 2 * H })),
      cancelPick: vi.fn(),
    };
    const active = signal(false);
    const replay = {
      active,
      selecting: signal(false),
      start: vi.fn(() => active.set(true)),
      startAt: vi.fn(),
      pause: vi.fn(),
      exit: vi.fn(() => active.set(false)),
      step: vi.fn(() => Promise.resolve()),
      cursor: () => ({ index: 5, sub: null }),
      moveTo: vi.fn(),
      togglePlay: vi.fn(),
      setSpeed: vi.fn(),
      setIndex: vi.fn(),
      reanchor: vi.fn(),
      headBar: () => bar(5),
    };
    const selectResolution = vi.fn();
    const stopReplayRuns = vi.fn();
    const n = new ChartTimeNavigator({
      bars: () => bars,
      historyComplete: () => true,
      resolution: () => '60',
      timezone: () => 'UTC',
      host: () => host,
      loadOlder: () => Promise.resolve(),
      selectResolution,
      replay: replay as unknown as ReplayController,
      stopReplayRuns,
      barTimeLabel: (b) => `bar@${b.time}`,
      formatTime: (ms) => `t@${ms}`,
      notify: { warning: vi.fn() } as never,
    });
    return { n, host, replay, selectResolution, stopReplayRuns };
  }

  it('a preset on another interval waits for that interval, then applies its window', () => {
    const { n, host, selectResolution } = nav();
    n.applyRangePreset('1D'); // 1 day in 1 minute intervals
    expect(selectResolution).toHaveBeenCalledWith('1');
    expect(host.setVisibleRange).not.toHaveBeenCalled();
    n.flushPendingRange();
    expect(host.setVisibleRange).toHaveBeenCalledTimes(1);
    n.flushPendingRange(); // applied once
    expect(host.setVisibleRange).toHaveBeenCalledTimes(1);
  });

  it('go-to-date centres the day on the chart', async () => {
    const { n, host } = nav();
    await n.goToDate('2026-11-02');
    const [from, to] = (host.setVisibleRange.mock.calls[0] as unknown as [number, number]);
    expect((from + to) / 2).toBe(Date.UTC(2026, 10, 2));
  });

  it('replay starts on the bar the operator clicks', async () => {
    const { n, replay } = nav();
    n.startReplay();
    expect(replay.start).toHaveBeenCalledWith(3);
    await Promise.resolve();
    await Promise.resolve();
    expect(replay.startAt).toHaveBeenCalledWith(2 * H);
    expect(replay.selecting()).toBe(false);
  });

  it('several steps at once move whole bars; exit stops the engine sessions', () => {
    const { n, replay, stopReplayRuns, host } = nav();
    n.stepReplay(1);
    expect(replay.step).toHaveBeenCalledWith(1);
    n.stepReplay(-3);
    expect(replay.moveTo).toHaveBeenCalledWith({ index: 2, sub: null });
    n.exitReplay();
    expect(host.cancelPick).toHaveBeenCalled();
    expect(stopReplayRuns).toHaveBeenCalled();
  });

  it('the head label is the head bar\'s', () => {
    expect(nav().n.replayTime()).toBe(`bar@${5 * H}`);
  });
});

describe('ChartTradeTimeline', () => {
  function timeline(strategyId: number | null, data: unknown) {
    const id = signal<number | null>(strategyId);
    const scriptStrategies = { getParityTimeline: vi.fn(() => of(data)) };
    const t = TestBed.runInInjectionContext(
      () =>
        new ChartTradeTimeline({
          strategyId: id,
          symbol: () => 'EURUSD',
          bars: () => [bar(1)],
          scriptStrategies: scriptStrategies as never,
        }),
    );
    return { t, id, scriptStrategies };
  }

  it('off draws nothing and says nothing; on without a strategy script says what is needed', () => {
    const { t, scriptStrategies } = timeline(null, null);
    TestBed.tick();
    expect(t.info()).toBeNull();
    t.show.set(true);
    TestBed.tick();
    expect(t.info()).toBe('Add an engine strategy script to the chart to draw its trades.');
    expect(scriptStrategies.getParityTimeline).not.toHaveBeenCalled();
  });

  it('a strategy trading another symbol is named, not drawn over this one', () => {
    const { t } = timeline(7, { status: true, data: { symbol: 'GBPUSD', notes: [], events: [], trades: [] } });
    t.show.set(true);
    TestBed.tick();
    expect(t.info()).toBe('The strategy trades GBPUSD, not EURUSD.');
  });

  it('an engine refusal is shown and clears the markers', () => {
    const { t } = timeline(7, { status: false, message: 'no backtest' });
    t.show.set(true);
    TestBed.tick();
    expect(t.info()).toBe('no backtest');
    expect(t.markers()).toEqual([]);
  });
});
