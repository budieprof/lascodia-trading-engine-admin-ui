import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Injector, runInInjectionContext } from '@angular/core';
import { of, throwError } from 'rxjs';
import type { CandleDto } from '@core/api/api.types';
import type { ChartBarDto, ChartBarsRequest } from '@core/api/scripting.types';
import { MarketDataService } from '@core/services/market-data.service';
import { ScriptingApiError, ScriptingService } from '@core/services/scripting.service';
import { CandleFeedService, normaliseRows, toBar, toSessionBar } from './candle-feed.service';

function row(iso: string, o: number, h: number, l: number, c: number, v = 1): CandleDto {
  return {
    id: 0,
    symbol: 'EURUSD',
    timeframe: 'H1',
    open: o,
    high: h,
    low: l,
    close: c,
    volume: v,
    timestamp: iso,
    isClosed: true,
  };
}

describe('normaliseRows', () => {
  // The engine pages candles newest-first. Everything downstream assumes
  // ascending, and the failure mode is an inverted candle rather than an error.
  const descendingPage = [
    row('2026-09-18T12:00:00Z', 3, 3.5, 2.9, 3.2),
    row('2026-09-18T11:00:00Z', 2, 2.5, 1.9, 2.2),
    row('2026-09-18T10:00:00Z', 1, 1.5, 0.9, 1.2),
  ];

  it('flips a newest-first page into ascending bars', () => {
    const bars = normaliseRows(descendingPage, '60');
    expect(bars.map((b) => b.time)).toEqual([
      Date.parse('2026-09-18T10:00:00Z'),
      Date.parse('2026-09-18T11:00:00Z'),
      Date.parse('2026-09-18T12:00:00Z'),
    ]);
    expect(bars[0].open).toBe(1);
    expect(bars[2].close).toBe(3.2);
  });

  it('takes open from the OLDEST bar when aggregating a descending page', () => {
    // Guards the inversion directly: with a descending page fed straight to
    // aggregation, open and close swap and high/low still look plausible.
    const m15 = descendingPage.map((r) => ({ ...r, timeframe: 'M15' }));
    const [bar] = normaliseRows(
      [
        { ...m15[2], timestamp: '2026-09-18T10:15:00Z' },
        { ...m15[1], timestamp: '2026-09-18T10:00:00Z' },
      ],
      '30',
    );
    expect(bar.open).toBe(2); // the 10:00 bar's open
    expect(bar.close).toBe(1.2); // the 10:15 bar's close
  });

  it('returns nothing for an empty page', () => {
    expect(normaliseRows([], '60')).toEqual([]);
  });

  it('drops rows whose timestamp will not parse rather than emitting NaN times', () => {
    // A NaN bar time makes the library reject the whole batch silently.
    const bars = normaliseRows(
      [row('nonsense', 1, 1, 1, 1), row('2026-09-18T10:00:00Z', 2, 2, 2, 2)],
      '60',
    );
    expect(bars).toHaveLength(1);
    expect(Number.isFinite(bars[0].time)).toBe(true);
  });

  it('returns nothing for an unsupported resolution', () => {
    expect(normaliseRows(descendingPage, '3')).toEqual([]);
  });
});

describe('toBar', () => {
  it('maps the DTO onto TradingView bar fields with an epoch-ms time', () => {
    expect(toBar(row('2026-09-18T10:00:00Z', 1, 2, 0.5, 1.5, 42))).toEqual({
      time: Date.parse('2026-09-18T10:00:00Z'),
      open: 1,
      high: 2,
      low: 0.5,
      close: 1.5,
      volume: 42,
    });
  });
});

// ── The session grid: 2h, 4h, 1D, 1W and 1M from scripting/chart-bars ────────────────────────────

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Wednesday 7 Oct 2026, 14:20 UTC; New York on EDT, so sessions roll at 21:00 UTC. */
const NOW = Date.UTC(2026, 9, 7, 14, 20);
/** Wednesday's session opened on Tuesday at 21:00 UTC. */
const WED = Date.UTC(2026, 9, 6, 21);

/** Session days as the engine sends them, ascending: `n` closed ones before the forming one. */
function sessions(n: number, forming = true): ChartBarDto[] {
  const out: ChartBarDto[] = [];
  for (let i = n; i >= 0; i--) {
    const t = WED - i * DAY;
    out.push({ t, tc: t + DAY, o: 1.17, h: 1.172, l: 1.168, c: 1.171, v: 10, forming: false });
  }
  out[out.length - 1].forming = forming;
  return out;
}

function makeFeed(answer: (req: ChartBarsRequest) => ChartBarDto[] | Error) {
  const chartBars = vi.fn((req: ChartBarsRequest) => {
    const a = answer(req);
    return a instanceof Error
      ? throwError(() => a)
      : of({
          symbol: req.symbol,
          timeframe: req.timeframe,
          session: '1700-1700:23456',
          timeZone: 'America/New_York',
          bars: a,
        });
  });
  const listCandles = vi.fn(() =>
    of({
      status: true,
      message: null,
      responseCode: '00',
      data: { data: [row('2026-10-07T13:00:00Z', 1, 1, 1, 1)], totalItems: 1 },
    }),
  );
  const injector = Injector.create({
    providers: [
      { provide: ScriptingService, useValue: { chartBars } },
      { provide: MarketDataService, useValue: { listCandles } },
      { provide: CandleFeedService, useClass: CandleFeedService },
    ],
  });
  const feed = runInInjectionContext(injector, () => injector.get(CandleFeedService));
  return { feed, chartBars, listCandles };
}

describe('CandleFeedService — resolution routing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('serves 2h, 4h, 1D, 1W and 1M from the session grid, never the stored H4/D1', async () => {
    for (const r of ['120', '240', '1D', '1W', '1M']) {
      const { feed, chartBars, listCandles } = makeFeed(() => sessions(3));
      await feed.getBars('EURUSD', r, 0, Date.now(), 1500);
      expect(listCandles, r).not.toHaveBeenCalled();
      expect(chartBars.mock.calls[0][0], r).toEqual({
        symbol: 'EURUSD',
        timeframe: r, // Pine timeframe strings
        to: null,
        count: 1500,
        includeForming: true,
      });
    }
  });

  it('keeps 1m … 1h on the stored candles, with the nested filter', async () => {
    for (const r of ['1', '5', '15', '30', '60']) {
      const { feed, chartBars, listCandles } = makeFeed(() => sessions(3));
      await feed.getBars('EURUSD', r, 0, Date.now(), 100);
      expect(chartBars, r).not.toHaveBeenCalled();
      expect((listCandles.mock.calls[0] as unknown[])[0], r).toMatchObject({
        filter: { symbol: 'EURUSD' },
      });
    }
  });

  it('a window ending now comes with the forming period, and every bar with its close', async () => {
    const { feed } = makeFeed(() => sessions(3));
    const { bars, noData } = await feed.getBars('EURUSD', '1D', 0, Date.now(), 1500);
    expect(noData).toBe(false);
    expect(bars.map((b) => b.time)).toEqual([WED - 3 * DAY, WED - 2 * DAY, WED - DAY, WED]);
    expect(bars.every((b) => b.closeTime === b.time + DAY)).toBe(true);
    expect(bars.some((b) => 'forming' in b)).toBe(false);
  });

  it('keeps a period that opened after a browser clock running behind the engine’s', async () => {
    const { feed } = makeFeed(() => sessions(1));
    // The browser is 2 s behind: the engine's newest open is "after" its now.
    vi.setSystemTime(WED - 2_000);
    const { bars } = await feed.getBars('EURUSD', '1D', 0, Date.now(), 1500);
    expect(bars.at(-1)?.time).toBe(WED);
  });

  it('rejects when the engine refuses, rather than reporting an empty chart', async () => {
    const { feed } = makeFeed(() => new ScriptingApiError('Unknown symbol', '-14'));
    await expect(feed.getBars('XXXYYY', '240', 0, Date.now(), 1500)).rejects.toMatchObject({
      message: 'Unknown symbol',
    });
  });

  it('reads an empty answer as no data', async () => {
    const { feed } = makeFeed(() => []);
    expect(await feed.getBars('EURUSD', '1W', 0, Date.now(), 1500)).toEqual({
      bars: [],
      noData: true,
    });
  });
});

describe('CandleFeedService — session-grid paging and cache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('pages back with the endpoint’s exclusive `to`: the bars opening before the oldest held', async () => {
    const { feed, chartBars } = makeFeed((req) =>
      sessions(30, false)
        .filter((b) => req.to === null || b.t < (req.to as number))
        .slice(-10),
    );
    const oldest = WED - 5 * DAY;
    const { bars } = await feed.getBars('EURUSD', '1D', 0, oldest - 1, 10);
    expect(chartBars.mock.calls[0][0]).toEqual({
      symbol: 'EURUSD',
      timeframe: '1D',
      to: oldest,
      count: 10,
      includeForming: false,
    });
    expect(bars).toHaveLength(10);
    expect(bars.at(-1)?.time).toBe(oldest - DAY); // the bar right before — none skipped
  });

  it('serves a window the cache covers without asking again; a live window always asks', async () => {
    const { feed, chartBars } = makeFeed(() => sessions(30));
    await feed.getBars('EURUSD', '240', 0, Date.now(), 1500);
    expect(chartBars).toHaveBeenCalledTimes(1);
    // An older window the live load already holds.
    const older = await feed.getBars('EURUSD', '240', WED - 20 * DAY, WED - 10 * DAY, 5);
    expect(chartBars).toHaveBeenCalledTimes(1);
    expect(older.bars[0].time).toBe(WED - 20 * DAY);
    expect(older.bars.at(-1)?.time).toBe(WED - 10 * DAY);
    await feed.getBars('EURUSD', '240', 0, Date.now(), 1500);
    expect(chartBars).toHaveBeenCalledTimes(2);
    // Invalidation drops it.
    feed.invalidate('EURUSD', '240');
    await feed.getBars('EURUSD', '240', WED - 20 * DAY, WED - 10 * DAY, 5);
    expect(chartBars).toHaveBeenCalledTimes(3);
  });

  it('sessionTail asks for the newest bars — enough to reach the held one — with the forming flag', async () => {
    const { feed, chartBars } = makeFeed(() => sessions(2));
    const tail = await feed.sessionTail('EURUSD', '1D', WED);
    expect(chartBars.mock.calls[0][0]).toEqual({
      symbol: 'EURUSD',
      timeframe: '1D',
      to: null,
      count: 3,
      includeForming: true,
    });
    expect(tail?.map((b) => b.forming)).toEqual([false, false, true]);
    // Two days away (a weekend, a sleeping laptop): it reaches back over them.
    await feed.sessionTail('EURUSD', '1D', WED - 2 * DAY);
    expect(chartBars.mock.calls[1][0].count).toBe(5);
  });

  it('sessionTail is null on a failure, and for a stored-grid resolution', async () => {
    const { feed } = makeFeed(() => new Error('down'));
    expect(await feed.sessionTail('EURUSD', '240', WED)).toBeNull();
    expect(await feed.sessionTail('EURUSD', '60', WED)).toBeNull();
  });
});

describe('toSessionBar', () => {
  it('keeps the engine’s close, and invents none when it sent none', () => {
    const dto: ChartBarDto = {
      t: WED,
      tc: WED + DAY,
      o: 1,
      h: 2,
      l: 0.5,
      c: 1.5,
      v: 7,
      forming: true,
    };
    expect(toSessionBar(dto)).toEqual({
      time: WED,
      closeTime: WED + DAY,
      open: 1,
      high: 2,
      low: 0.5,
      close: 1.5,
      volume: 7,
      forming: true,
    });
    expect('closeTime' in toSessionBar({ ...dto, tc: Number.NaN })).toBe(false);
  });
});
