import { describe, expect, it } from 'vitest';
import type { Bar, SessionBar } from './candle-feed.service';
import {
  MAX_CHART_BARS,
  ROLLOVER_RETRY_MS,
  ROLLOVER_SLOW_RETRY_MS,
  SessionRollover,
  applySessionTick,
  currentDayBars,
  isCurrentPeriod,
  mergeSessionTail,
  tailCount,
  tradingDayMs,
} from './session-bars';

/**
 * EURUSD 4h on the engine's session grid, October 2026 (New York on EDT, UTC−4): the blocks of a
 * 17:00-New-York session open at 21, 01, 05, 09, 13 and 17 UTC; Friday's session closes at
 * 21:00 UTC and Monday's opens at Sunday 21:00 UTC — the weekend gap. Every bar carries the engine's
 * open and close; nothing below computes one.
 */
const H = 3_600_000;
const at = (iso: string) => Date.parse(iso);

function bar(openIso: string, closeIso: string, c = 1.17, extra: Partial<Bar> = {}): Bar {
  return {
    time: at(openIso),
    closeTime: at(closeIso),
    open: 1.17,
    high: 1.172,
    low: 1.168,
    close: c,
    volume: 100,
    ...extra,
  };
}
const engine = (b: Bar, forming = false): SessionBar => ({ ...b, forming });

const FRI_13 = bar('2026-10-09T13:00:00Z', '2026-10-09T17:00:00Z', 1.171);
const FRI_17 = bar('2026-10-09T17:00:00Z', '2026-10-09T21:00:00Z', 1.1705); // the week's last
const SUN_21 = bar('2026-10-11T21:00:00Z', '2026-10-12T01:00:00Z', 1.169); // Monday's session

describe('isCurrentPeriod', () => {
  it('is [open, close) of the engine’s own period', () => {
    expect(isCurrentPeriod(FRI_17, at('2026-10-09T17:00:00Z'))).toBe(true);
    expect(isCurrentPeriod(FRI_17, at('2026-10-09T20:59:59Z'))).toBe(true);
    expect(isCurrentPeriod(FRI_17, at('2026-10-09T21:00:00Z'))).toBe(false);
    expect(isCurrentPeriod(FRI_17, at('2026-10-09T16:59:59Z'))).toBe(false);
  });

  it('is false for a bar without a close, or no bar', () => {
    expect(isCurrentPeriod({ ...FRI_17, closeTime: undefined }, at('2026-10-09T18:00:00Z'))).toBe(
      false,
    );
    expect(isCurrentPeriod(undefined, 0)).toBe(false);
  });
});

describe('applySessionTick', () => {
  const held = [FRI_13, FRI_17];

  it('moves the newest bar while its period lasts', () => {
    const r = applySessionTick(held, 1.1731, at('2026-10-09T18:30:00Z'));
    expect(r.kind).toBe('update');
    const last = r.kind === 'update' ? r.bars[r.bars.length - 1] : null;
    expect(last).toEqual({ ...FRI_17, high: 1.1731, close: 1.1731 });
    // Below the low widens the low.
    const down = applySessionTick(held, 1.1601, at('2026-10-09T18:30:00Z'));
    expect(down.kind === 'update' && down.bars[1].low).toBe(1.1601);
    // Earlier bars are untouched.
    expect(r.kind === 'update' && r.bars[0]).toBe(FRI_13);
  });

  it('asks for a rollover from the close on — at it, and past it — and moves nothing', () => {
    expect(applySessionTick(held, 1.18, at('2026-10-09T21:00:00Z'))).toEqual({ kind: 'rollover' });
    expect(applySessionTick(held, 1.18, at('2026-10-09T21:30:00Z'))).toEqual({ kind: 'rollover' });
  });

  it('ignores a tick it cannot place: no bars, no close, or a clock behind the newest open', () => {
    expect(applySessionTick([], 1.17, at('2026-10-09T18:00:00Z')).kind).toBe('ignore');
    expect(
      applySessionTick([{ ...FRI_17, closeTime: undefined }], 1.17, at('2026-10-09T18:00:00Z'))
        .kind,
    ).toBe('ignore');
    expect(applySessionTick(held, 1.17, at('2026-10-09T16:00:00Z')).kind).toBe('ignore');
  });
});

describe('SessionRollover — one request per bar change', () => {
  function gate() {
    let now = at('2026-10-09T21:00:05Z');
    const g = new SessionRollover(() => now);
    return { g, advance: (ms: number) => (now += ms) };
  }

  it('asks on the first tick past the close, not again while that request is in flight', () => {
    const { g } = gate();
    expect(g.request('EURUSD|240|a')).toBe(true);
    expect(g.request('EURUSD|240|a')).toBe(false);
    expect(g.request('EURUSD|240|a')).toBe(false);
  });

  it('when the engine had no next period yet, waits before the next tick may ask', () => {
    const { g, advance } = gate();
    expect(g.request('k')).toBe(true);
    g.done('k'); // the engine's forming bar needs a closed M1: nothing in a period's first minute
    advance(ROLLOVER_RETRY_MS - 1);
    expect(g.request('k')).toBe(false);
    advance(1);
    expect(g.request('k')).toBe(true);
  });

  it('slows to one ask a minute once the fast retries are used up (a weekend of stray ticks)', () => {
    const { g, advance } = gate();
    for (let i = 0; i < 8; i++) {
      expect(g.request('k'), `attempt ${i + 1}`).toBe(true);
      g.done('k');
      advance(ROLLOVER_RETRY_MS);
    }
    expect(g.request('k')).toBe(false);
    advance(ROLLOVER_SLOW_RETRY_MS - ROLLOVER_RETRY_MS);
    expect(g.request('k')).toBe(true);
  });

  it('starts afresh for a new newest bar, and forgets everything on reset', () => {
    const { g } = gate();
    expect(g.request('old')).toBe(true);
    g.done('old');
    expect(g.request('new')).toBe(true); // the bar changed: ask at once
    g.done('stale-key'); // a late settle for another bar changes nothing
    expect(g.request('new')).toBe(false);
    g.reset();
    expect(g.request('new')).toBe(true);
  });
});

describe('mergeSessionTail', () => {
  it("replaces the held bars with the engine's, adds a period that opened, keeps older history", () => {
    const older = bar('2026-10-09T09:00:00Z', '2026-10-09T13:00:00Z');
    const tickBuilt = { ...FRI_17, close: 1.1799 }; // ticks moved it before it closed
    const tail = [engine(FRI_13), engine(FRI_17)]; // the engine's closed Friday 17:00
    const out = mergeSessionTail([older, FRI_13, tickBuilt], tail, true);
    expect(out).toEqual([older, FRI_13, FRI_17]); // a closed period is the engine's, close included
  });

  it('the forming period: the engine’s open, both extremes, the tick close when ticks moved it', () => {
    const held = [FRI_13, { ...FRI_17, high: 1.1751, low: 1.169, close: 1.1744 }];
    const formingFromM1 = engine(
      { ...FRI_17, open: 1.1702, high: 1.174, low: 1.1662, close: 1.1738, volume: 140 },
      true,
    );
    const [, live] = mergeSessionTail(held, [engine(FRI_13), formingFromM1], true);
    expect(live).toEqual({
      time: FRI_17.time,
      closeTime: FRI_17.closeTime,
      open: 1.1702,
      high: 1.1751,
      low: 1.1662,
      close: 1.1744, // the tick is newer than M1
      volume: 140,
    });
    // No ticks since the last merge: the engine's close is the newer one.
    const [, quiet] = mergeSessionTail(held, [engine(FRI_13), formingFromM1], false);
    expect(quiet.close).toBe(1.1738);
  });

  it('drops a held bar the engine no longer has inside the tail, keeps one after it', () => {
    const phantom = bar('2026-10-09T15:00:00Z', '2026-10-09T19:00:00Z');
    const after = bar('2026-10-12T01:00:00Z', '2026-10-12T05:00:00Z');
    const out = mergeSessionTail(
      [FRI_13, phantom, FRI_17, after],
      [engine(FRI_13), engine(FRI_17)],
      false,
    );
    expect(out.map((b) => b.time)).toEqual([FRI_13.time, FRI_17.time, after.time]);
  });

  it('an empty tail changes nothing', () => {
    const held = [FRI_13, FRI_17];
    expect(mergeSessionTail(held, [], true)).toEqual(held);
  });

  it('holds no request-time flag on the merged bars', () => {
    const [b] = mergeSessionTail([], [engine(SUN_21, true)], false);
    expect('forming' in b).toBe(false);
    expect(b.closeTime).toBe(SUN_21.closeTime);
  });
});

describe('a weekend gap, end to end: no bar the engine did not open', () => {
  it('waits out the weekend, then picks up Monday’s session at Sunday 21:00 UTC', () => {
    let now = at('2026-10-09T21:30:00Z'); // a stray tick half an hour after Friday's close
    const gate = new SessionRollover(() => now);
    let bars: Bar[] = [FRI_13, FRI_17];
    const key = () => `EURUSD|240|${bars[bars.length - 1].time}`;

    expect(applySessionTick(bars, 1.1702, now)).toEqual({ kind: 'rollover' });
    expect(gate.request(key())).toBe(true);
    // The engine has nothing after Friday 17:00: the chart holds Friday's close, invents nothing.
    bars = mergeSessionTail(bars, [engine(FRI_13), engine(FRI_17)], false);
    gate.done(key());
    expect(bars.map((b) => b.time)).toEqual([FRI_13.time, FRI_17.time]);
    now += 5 * 60_000;
    expect(applySessionTick(bars, 1.1703, now).kind).toBe('rollover');
    expect(gate.request(key())).toBe(true); // spaced, not one per tick
    gate.done(key());
    now += 1_000;
    expect(gate.request(key())).toBe(false);

    // Sunday 17:00 New York: the first tick of the week.
    now = at('2026-10-11T21:01:30Z');
    expect(applySessionTick(bars, 1.1688, now).kind).toBe('rollover');
    expect(gate.request(key())).toBe(true);
    bars = mergeSessionTail(bars, [engine(FRI_13), engine(FRI_17), engine(SUN_21, true)], false);
    gate.done(`EURUSD|240|${FRI_17.time}`);
    // Friday 17:00 is followed directly by Sunday 21:00 — the gap is the engine's, not a bar.
    expect(bars.map((b) => b.time)).toEqual([FRI_13.time, FRI_17.time, SUN_21.time]);
    expect(bars[2].closeTime).toBe(at('2026-10-12T01:00:00Z'));

    // From here the ticks move Monday's first block.
    now += 30_000;
    const t = applySessionTick(bars, 1.1655, now);
    expect(t.kind === 'update' && t.bars[2]).toMatchObject({
      time: SUN_21.time,
      low: 1.1655,
      close: 1.1655,
    });
    // …and a new bar asks at once when it, in turn, closes.
    expect(gate.request(`EURUSD|240|${SUN_21.time}`)).toBe(true);
  });
});

describe('tailCount', () => {
  const forming = at('2026-10-09T17:00:00Z');

  it('asks for the forming bar and the couple before it', () => {
    expect(tailCount('240', forming, forming + H)).toBe(3);
  });

  it('reaches back over a gap — nominal widths over-count the weekend, never under-count', () => {
    const monday = at('2026-10-12T10:00:00Z');
    expect(tailCount('240', forming, monday)).toBe(Math.ceil((monday - forming) / (4 * H)) + 2);
    expect(tailCount('1D', at('2026-10-08T21:00:00Z'), monday)).toBe(6);
  });

  it('is at least three and at most what one request may ask for', () => {
    expect(tailCount('1M', forming, forming - H)).toBe(3);
    expect(tailCount('120', 0, Date.UTC(2026, 9, 9))).toBe(MAX_CHART_BARS);
  });
});

describe('tradingDayMs', () => {
  it('is the date a session closes on: Tuesday’s session opens Monday 21:00 UTC', () => {
    const tue = { time: at('2026-10-05T21:00:00Z'), closeTime: at('2026-10-06T21:00:00Z') };
    expect(tradingDayMs(tue)).toBe(at('2026-10-06T00:00:00Z'));
  });

  it('holds in winter (22:00 UTC sessions) too', () => {
    const wed = { time: at('2026-12-01T22:00:00Z'), closeTime: at('2026-12-02T22:00:00Z') };
    expect(tradingDayMs(wed)).toBe(at('2026-12-02T00:00:00Z'));
  });

  it("puts January's month bar in its own year though it opens on 31 December", () => {
    const jan = { time: at('2025-12-31T22:00:00Z'), closeTime: at('2026-01-30T22:00:00Z') };
    expect(new Date(tradingDayMs(jan)).getUTCFullYear()).toBe(2026);
  });

  it('without a close, takes the date of its open + 12 h — the evening open’s next day', () => {
    expect(tradingDayMs({ time: at('2026-10-05T21:00:00Z') })).toBe(at('2026-10-06T00:00:00Z'));
    expect(tradingDayMs({ time: at('2026-12-01T22:00:00Z') })).toBe(at('2026-12-02T00:00:00Z'));
  });
});

describe('currentDayBars', () => {
  // Tuesday 6 Oct's session on 4h: six blocks from Monday 21:00 UTC; the block before is Monday's.
  const block = (openIso: string, hours = 4) =>
    bar(openIso, new Date(at(openIso) + hours * H).toISOString());
  const monday17 = block('2026-10-05T17:00:00Z');
  const tuesday = [
    '2026-10-05T21:00:00Z',
    '2026-10-06T01:00:00Z',
    '2026-10-06T05:00:00Z',
    '2026-10-06T09:00:00Z',
  ].map((t) => block(t));

  it("on the session grid, is the newest bar's session — from the evening before", () => {
    const today = currentDayBars([monday17, ...tuesday]);
    expect(today.map((b) => b.time)).toEqual(tuesday.map((b) => b.time));
    // The UTC day would have started at 01:00 and dropped the session's first block.
    expect(today[0].time).toBe(at('2026-10-05T21:00:00Z'));
  });

  it('on 1D, is the session bar itself', () => {
    const mon = bar('2026-10-04T21:00:00Z', '2026-10-05T21:00:00Z');
    const tue = bar('2026-10-05T21:00:00Z', '2026-10-06T21:00:00Z');
    expect(currentDayBars([mon, tue])).toEqual([tue]);
  });

  it('on the stored grid (no closes), is the UTC day as before', () => {
    const h1 = (iso: string) => ({ ...bar(iso, iso), closeTime: undefined });
    const bars = [
      h1('2026-10-05T23:00:00Z'),
      h1('2026-10-06T00:00:00Z'),
      h1('2026-10-06T01:00:00Z'),
    ];
    expect(currentDayBars(bars)).toEqual(bars.slice(1));
    expect(currentDayBars([])).toEqual([]);
  });
});
