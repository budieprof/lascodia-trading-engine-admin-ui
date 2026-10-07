import { describe, expect, it } from 'vitest';
import {
  TickMarkType,
  defaultHorzScaleBehavior,
  type ChartOptionsImpl,
  type IHorzScaleBehavior,
  type Mutable,
  type Time,
  type TickMarkWeightValue,
  type TimeScalePoint,
  type UTCTimestamp,
} from 'lightweight-charts';
import {
  TradingDateTimeScale,
  formatTradingDate,
  labelsByTradingDate,
  tradingDateLabel,
  tradingDateOf,
  tradingDateTick,
  tradingDatesByPlottedTime,
} from './trading-date';

const H = 3_600_000;
const at = (iso: string) => Date.parse(iso);
/** A bar of the engine's session grid: its open and its exclusive close. */
const bar = (open: string, close: string) => ({ time: at(open), closeTime: at(close) });

describe('labelsByTradingDate', () => {
  it('is 1D, 1W and 1M; 2h, 4h and the stored grid keep clock times', () => {
    for (const r of ['1D', '1W', '1M']) expect(labelsByTradingDate(r), r).toBe(true);
    for (const r of ['1', '5', '15', '30', '60', '120', '240'])
      expect(labelsByTradingDate(r), r).toBe(false);
  });
});

describe('tradingDateOf / tradingDateLabel — 1D', () => {
  it('is the date the session closes on: Tuesday’s session opens Monday 21:00 UTC', () => {
    const tue = bar('2026-10-05T21:00:00Z', '2026-10-06T21:00:00Z');
    expect(tradingDateOf(tue, '1D')).toBe(at('2026-10-06T00:00:00Z'));
    expect(tradingDateLabel(tue, '1D')).toBe('Tue 6 Oct 2026');
  });

  it('holds across a DST week — New York leaves EDT on Sunday 1 Nov 2026', () => {
    // Friday's session runs 21:00–21:00 UTC (EDT); Monday's opens Sunday 22:00 UTC (EST).
    const fri = bar('2026-10-29T21:00:00Z', '2026-10-30T21:00:00Z');
    const mon = bar('2026-11-01T22:00:00Z', '2026-11-02T22:00:00Z');
    const tue = bar('2026-11-02T22:00:00Z', '2026-11-03T22:00:00Z');
    expect([fri, mon, tue].map((b) => tradingDateLabel(b, '1D'))).toEqual([
      'Fri 30 Oct 2026',
      'Mon 2 Nov 2026',
      'Tue 3 Nov 2026',
    ]);
    // …and into EDT on Sunday 8 Mar 2026: Friday 22:00 UTC sessions, Monday's from 21:00 UTC.
    expect(tradingDateLabel(bar('2026-03-05T22:00:00Z', '2026-03-06T22:00:00Z'), '1D')).toBe(
      'Fri 6 Mar 2026',
    );
    expect(tradingDateLabel(bar('2026-03-08T21:00:00Z', '2026-03-09T21:00:00Z'), '1D')).toBe(
      'Mon 9 Mar 2026',
    );
  });

  it('without a close, takes the date of its open + 12 h', () => {
    expect(tradingDateLabel({ time: at('2026-10-05T21:00:00Z') }, '1D')).toBe('Tue 6 Oct 2026');
    expect(tradingDateLabel({ time: at('2026-12-01T22:00:00Z') }, '1D')).toBe('Wed 2 Dec 2026');
  });
});

describe('tradingDateOf / tradingDateLabel — 1W', () => {
  it('names a week by its first trading day: the bar opening Sunday 21:00 UTC is Monday’s week', () => {
    const week = bar('2026-10-04T21:00:00Z', '2026-10-09T21:00:00Z'); // closes with Friday
    expect(tradingDateOf(week, '1W')).toBe(at('2026-10-05T00:00:00Z'));
    expect(tradingDateLabel(week, '1W')).toBe('5 Oct 2026');
  });

  it('over the DST change, still Monday — the week opens Sunday 22:00 UTC in EST', () => {
    expect(tradingDateLabel(bar('2026-11-01T22:00:00Z', '2026-11-06T22:00:00Z'), '1W')).toBe(
      '2 Nov 2026',
    );
    expect(tradingDateLabel(bar('2026-10-25T21:00:00Z', '2026-10-30T21:00:00Z'), '1W')).toBe(
      '26 Oct 2026',
    );
  });
});

describe('tradingDateOf / tradingDateLabel — 1M', () => {
  it('names a month by its last trading day, though it opens on the previous month’s last day', () => {
    // October's bar opens with Thursday 1 Oct's session, on Wednesday 30 Sep at 21:00 UTC.
    const october = bar('2026-09-30T21:00:00Z', '2026-10-30T21:00:00Z');
    expect(tradingDateLabel(october, '1M')).toBe('Oct 2026');
    // January's opens on 31 December, in the year before.
    const january = bar('2026-12-31T22:00:00Z', '2027-01-29T22:00:00Z');
    expect(tradingDateLabel(january, '1M')).toBe('Jan 2027');
    // Without a close: the month of its open + 12 h.
    expect(tradingDateLabel({ time: january.time }, '1M')).toBe('Jan 2027');
  });
});

describe('tradingDatesByPlottedTime — a calendar date, never shifted by the display zone', () => {
  const tue = bar('2026-10-05T21:00:00Z', '2026-10-06T21:00:00Z');

  it('keys each bar by its plotted time; the date stays the trading date in any zone', () => {
    for (const shiftH of [0, 9, -4, 5.5]) {
      const map = tradingDatesByPlottedTime([tue], '1D', () => shiftH * H);
      expect([...map.entries()]).toEqual([
        [Math.floor((tue.time + shiftH * H) / 1000), at('2026-10-06T00:00:00Z')],
      ]);
    }
  });

  it('is empty on a resolution labelled by clock time', () => {
    expect(tradingDatesByPlottedTime([tue], '240', () => 0).size).toBe(0);
  });
});

describe('formatTradingDate / tradingDateTick', () => {
  const oct6 = at('2026-10-06T00:00:00Z');

  it('prints no clock time: a day with its weekday, a week by its date, a month by name', () => {
    expect(formatTradingDate(oct6, '1D')).toBe('Tue 6 Oct 2026');
    expect(formatTradingDate(oct6, '1W')).toBe('6 Oct 2026');
    expect(formatTradingDate(oct6, '1M')).toBe('Oct 2026');
  });

  it('labels a tick by its type: year, month, else the day of the month', () => {
    expect(tradingDateTick(oct6, TickMarkType.Year)).toBe('2026');
    expect(tradingDateTick(oct6, TickMarkType.Month)).toBe('Oct');
    expect(tradingDateTick(oct6, TickMarkType.DayOfMonth)).toBe('6');
    expect(tradingDateTick(oct6, TickMarkType.Time)).toBe('6');
  });
});

describe('TradingDateTimeScale', () => {
  const options = {
    timeScale: { timeVisible: true, secondsVisible: false },
    localization: { dateFormat: "dd MMM 'yy", locale: 'en-US' },
  } as unknown as ChartOptionsImpl<Time>;

  /** The library's time-scale points for bars opening at `opens`, weighed by `scale`. */
  function weights(scale: IHorzScaleBehavior<Time>, opens: string[]): number[] {
    const points = opens.map(
      (iso) =>
        ({
          time: scale.convertHorzItemToInternal((at(iso) / 1000) as UTCTimestamp),
          timeWeight: 0 as TickMarkWeightValue,
          originalTime: at(iso) / 1000,
        }) as Mutable<TimeScalePoint>,
    );
    scale.fillWeightsForPoints(points, 0);
    return points.map((p) => p.timeWeight as number);
  }

  /** A trading-date time scale over the bars `closes` (open → close) of a `resolution` chart. */
  function scaleFor(resolution: string, closes: Record<string, string>): TradingDateTimeScale {
    const scale = new TradingDateTimeScale();
    const byPlotted = tradingDatesByPlottedTime(
      Object.entries(closes).map(([open, close]) => bar(open, close)),
      resolution,
      () => 0,
    );
    scale.source = {
      dateAt: (s) => byPlotted.get(s) ?? null,
      resolution: () => resolution,
    };
    return scale;
  }

  const daily = {
    '2026-09-28T21:00:00Z': '2026-09-29T21:00:00Z', // Tue 29 Sep
    '2026-09-29T21:00:00Z': '2026-09-30T21:00:00Z', // Wed 30 Sep
    '2026-09-30T21:00:00Z': '2026-10-01T21:00:00Z', // Thu 1 Oct
    '2026-10-01T21:00:00Z': '2026-10-02T21:00:00Z', // Fri 2 Oct
  };

  it('starts October on 1 Oct’s session, where the library alone put it on 2 Oct’s', () => {
    const ours = weights(scaleFor('1D', daily), Object.keys(daily));
    expect(ours[2]).toBeGreaterThan(ours[3]); // Thu 1 Oct: the month's tick
    expect(ours[2]).toBeGreaterThan(ours[1]);
    const library = weights(new (defaultHorzScaleBehavior())(), Object.keys(daily));
    expect(library[3]).toBeGreaterThan(library[2]); // it opens on 1 Oct, so it looked like the month's first
  });

  it('starts the year on January’s month bar, which opens on 31 December', () => {
    const monthly = {
      '2026-11-30T22:00:00Z': '2026-12-31T22:00:00Z', // December
      '2026-12-31T22:00:00Z': '2027-01-29T22:00:00Z', // January
      '2027-01-31T22:00:00Z': '2027-02-26T22:00:00Z', // February
    };
    const ours = weights(scaleFor('1M', monthly), Object.keys(monthly));
    expect(ours[1]).toBeGreaterThan(ours[2]);
    const library = weights(new (defaultHorzScaleBehavior())(), Object.keys(monthly));
    expect(library[2]).toBeGreaterThan(library[1]);
  });

  it('leaves 2h and 4h to the library', () => {
    const fourHour = ['2026-10-05T17:00:00Z', '2026-10-05T21:00:00Z', '2026-10-06T01:00:00Z'];
    const ours = weights(scaleFor('240', {}), fourHour);
    const library = weights(new (defaultHorzScaleBehavior())(), fourHour);
    expect(ours).toEqual(library);
  });

  it('prints the crosshair time as the trading date on 1D/1W/1M, the library’s label otherwise', () => {
    const scale = scaleFor('1D', daily);
    scale.setOptions(options);
    const thu = scale.convertHorzItemToInternal(
      (at('2026-09-30T21:00:00Z') / 1000) as UTCTimestamp,
    );
    expect(scale.formatHorzItem(thu)).toBe('Thu 1 Oct 2026');

    const fourHour = scaleFor('240', {});
    fourHour.setOptions(options);
    const library = new (defaultHorzScaleBehavior())();
    library.setOptions(options);
    const block = library.convertHorzItemToInternal(
      (at('2026-10-05T21:00:00Z') / 1000) as UTCTimestamp,
    );
    expect(fourHour.formatHorzItem(block)).toBe(library.formatHorzItem(block));
    expect(fourHour.formatHorzItem(block)).toContain('21:00');
  });
});
