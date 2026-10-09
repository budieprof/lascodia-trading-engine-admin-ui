import type { Bar } from '../datafeed/candle-feed.service';

/**
 * Price-based chart types: Renko, Kagi, Point & Figure and Line Break.
 *
 * These are NOT styles. A candle is a slice of time; a Renko brick is a slice
 * of *price movement*, and a quiet hour may produce no brick at all while a
 * violent one produces nine. So the bar array has to be rebuilt, not
 * re-skinned, and the output no longer maps one-to-one onto timestamps.
 *
 * ── The time axis problem ───────────────────────────────────────────────────
 * Lightweight Charts requires strictly increasing bar times. Several synthetic
 * bars can come from a single source bar, so their natural times collide and
 * the library would reject the series outright. `sequence()` pushes each
 * colliding bar one second past the previous one: the shapes and their order
 * stay faithful, and the time axis stays legal. Times on these chart types are
 * therefore indicative — which is true of Renko and P&F everywhere, since the
 * x-axis on those charts is not really time.
 */

/** Force strictly increasing times without disturbing order. */
function sequence(bars: Bar[]): Bar[] {
  let last = -Infinity;
  return bars.map((b) => {
    const time = b.time > last ? b.time : last + 1000;
    last = time;
    return { ...b, time };
  });
}

/** Average true range over the whole series, for auto-sized bricks. */
export function averageTrueRange(bars: Bar[], period = 14): number {
  if (bars.length < 2) return 0;
  const ranges: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const pc = bars[i - 1].close;
    ranges.push(
      Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - pc), Math.abs(bars[i].low - pc)),
    );
  }
  const window = ranges.slice(-period);
  return window.reduce((a, b) => a + b, 0) / Math.max(1, window.length);
}

/**
 * The price a box size in ATR multiples is a multiple OF, fixed when the chart loads (CC-16): ATR(14)
 * over the bars that have closed — the forming one left out (`excludeLast`), so it is the same
 * number tick after tick, as TradingView sizes ATR boxes once at load. A flat series falls back to a
 * tenth of a percent of price so the box is never zero.
 */
export function boxBase(bars: readonly Bar[], excludeLast: boolean): number {
  const closed = excludeLast && bars.length > 2 ? bars.slice(0, -1) : [...bars];
  if (closed.length === 0) return 0;
  const atr = averageTrueRange(closed, 14);
  return atr > 0 ? atr : Math.abs(closed[closed.length - 1].close) * 0.001;
}

/**
 * A price-based style's box in price (CC-I10): `atr` — `atrMultiple` × {@link boxBase} of the bars
 * (measured on the closed ones, so the caller can keep it for the series' life); `pips` — `pips` ×
 * `pipSize`, TradingView's "Traditional" box, the same on every timeframe. 0 when there is none.
 */
export function boxUnit(opts: {
  method: 'atr' | 'pips';
  bars: readonly Bar[];
  atrMultiple: number;
  pips: number;
  pipSize: number;
}): number {
  if (opts.method === 'pips') return Math.max(0, opts.pips) * Math.max(0, opts.pipSize);
  return boxBase(opts.bars, true) * Math.max(0.1, opts.atrMultiple);
}

/** How a Renko brick is drawn. */
export interface RenkoOptions {
  /**
   * TradingView's "Show wicks": each brick's wick reaches the furthest price traded against it
   * before it formed — below an up brick, above a down brick. Off, a brick is its body only.
   */
  wicks?: boolean;
}

/**
 * Renko bricks, built on closes.
 *
 * A brick is only emitted once price has travelled a full `brickSize` from the last brick's close,
 * and a REVERSAL needs two bricks' worth of movement — that asymmetry is what filters the noise
 * Renko exists to filter. A reversal brick starts where the last brick STARTED (one brick back from
 * its close) — the two bricks never overlap. Until 2026-10 it started at the last close, so every
 * reversal drew one brick over the last one's range and a second beside it (CC-16).
 *
 * With `wicks`, the furthest high or low traded since the last brick closed hangs off the next brick
 * against its direction. Bars carry no intrabar order, so a bar that forms a brick lends it its own
 * extreme too.
 */
export function toRenko(bars: Bar[], brickSize: number, options: RenkoOptions = {}): Bar[] {
  if (bars.length === 0 || brickSize <= 0) return [];
  const out: Bar[] = [];
  let anchor = bars[0].close;
  let direction: 1 | -1 | 0 = 0;
  // Extremes traded since the last brick closed: the next brick's wick.
  let extHigh = anchor;
  let extLow = anchor;

  for (const bar of bars) {
    extHigh = Math.max(extHigh, bar.high);
    extLow = Math.min(extLow, bar.low);
    // Guard the loop: a tiny brick size against a large move would otherwise
    // try to emit hundreds of thousands of bricks and hang the tab.
    let guard = 0;
    for (;;) {
      if (guard++ > 1000) break;
      const move = bar.close - anchor;

      if (move >= brickSize * (direction === -1 ? 2 : 1)) {
        const open = direction === -1 ? anchor + brickSize : anchor;
        const close = open + brickSize;
        out.push({
          time: bar.time,
          open,
          close,
          high: close,
          low: options.wicks ? Math.min(open, extLow) : open,
          volume: bar.volume,
        });
        anchor = close;
        direction = 1;
        extHigh = extLow = close;
        continue;
      }
      if (-move >= brickSize * (direction === 1 ? 2 : 1)) {
        const open = direction === 1 ? anchor - brickSize : anchor;
        const close = open - brickSize;
        out.push({
          time: bar.time,
          open,
          close,
          high: options.wicks ? Math.max(open, extHigh) : open,
          low: close,
          volume: bar.volume,
        });
        anchor = close;
        direction = -1;
        extHigh = extLow = close;
        continue;
      }
      break;
    }
  }
  return sequence(out);
}

/**
 * Line Break.
 *
 * A new block is drawn only when the close breaks beyond the extreme of the
 * last `lines` blocks — so `lines = 3` means a reversal must exceed three
 * blocks' range, not one bar's.
 */
export function toLineBreak(bars: Bar[], lines = 3): Bar[] {
  if (bars.length === 0) return [];
  const out: Bar[] = [];
  for (const bar of bars) {
    if (out.length === 0) {
      out.push({
        ...bar,
        open: bar.open,
        close: bar.close,
        high: Math.max(bar.open, bar.close),
        low: Math.min(bar.open, bar.close),
      });
      continue;
    }
    const recent = out.slice(-lines);
    const highest = Math.max(...recent.map((b) => Math.max(b.open, b.close)));
    const lowest = Math.min(...recent.map((b) => Math.min(b.open, b.close)));
    const previous = out[out.length - 1];

    if (bar.close > highest) {
      const open = Math.max(previous.open, previous.close);
      out.push({
        time: bar.time,
        open,
        close: bar.close,
        high: bar.close,
        low: open,
        volume: bar.volume,
      });
    } else if (bar.close < lowest) {
      const open = Math.min(previous.open, previous.close);
      out.push({
        time: bar.time,
        open,
        close: bar.close,
        high: open,
        low: bar.close,
        volume: bar.volume,
      });
    }
  }
  return sequence(out);
}

/** A Point & Figure column: its boxes on the box grid, rising (X) or falling (O). */
export interface PnfColumn extends Bar {
  pnf: {
    /** The box size, in price. */
    box: number;
    /** X column (rising) or O column (falling). */
    up: boolean;
    /** Boxes in the column (its levels, inclusive). */
    boxes: number;
  };
}

/** Float headroom for a close that sits on a box level (103 / 1 → 102.99999…). */
const EPS = 1e-9;

/**
 * Point & Figure (CC-I10), TradingView's "Close" source: prices quantised to a grid of `boxSize` levels
 * (k × boxSize). An X column rises one level each time a close reaches the next level up; it turns into an
 * O column only when a close falls `reversal` levels below its top — the O column then starts one level below
 * the X top — and the other way round. The first column starts on the first close's level and goes the way the
 * first one-box move goes. Each column is one bar, at the time of its first source bar: `low` / `high` are its
 * lowest and highest levels, `open` → `close` its direction, `pnf` how to draw it. The last column is still
 * forming.
 */
export function toPointAndFigure(bars: Bar[], boxSize: number, reversal = 3): PnfColumn[] {
  if (bars.length === 0 || !(boxSize > 0)) return [];
  const rev = Math.max(1, Math.round(reversal));
  const up = (price: number) => Math.floor(price / boxSize + EPS);
  const down = (price: number) => Math.ceil(price / boxSize - EPS);
  const out: PnfColumn[] = [];
  const start = Math.round(bars[0].close / boxSize);
  let direction: 1 | -1 | 0 = 0;
  let hi = start;
  let lo = start;
  let columnTime = bars[0].time;
  let volume = 0;

  const flush = () => {
    if (direction === 0) return;
    const rising = direction === 1;
    out.push({
      time: columnTime,
      open: (rising ? lo : hi) * boxSize,
      close: (rising ? hi : lo) * boxSize,
      high: hi * boxSize,
      low: lo * boxSize,
      volume,
      pnf: { box: boxSize, up: rising, boxes: hi - lo + 1 },
    });
    volume = 0;
  };

  for (const bar of bars) {
    volume += bar.volume;
    const u = up(bar.close);
    const d = down(bar.close);
    if (direction === 0) {
      if (u >= start + 1) {
        direction = 1;
        lo = start;
        hi = u;
        columnTime = bar.time;
      } else if (d <= start - 1) {
        direction = -1;
        hi = start;
        lo = d;
        columnTime = bar.time;
      }
      continue;
    }
    if (direction === 1) {
      if (u > hi) hi = u;
      else if (d <= hi - rev) {
        volume -= bar.volume;
        flush();
        volume = bar.volume;
        direction = -1;
        hi = hi - 1;
        lo = d;
        columnTime = bar.time;
      }
    } else {
      if (d < lo) lo = d;
      else if (u >= lo + rev) {
        volume -= bar.volume;
        flush();
        volume = bar.volume;
        direction = 1;
        lo = lo + 1;
        hi = u;
        columnTime = bar.time;
      }
    }
  }
  flush();
  return sequence(out) as PnfColumn[];
}

/** A Kagi line segment: thick (yang) or thin (yin) where it starts, and the price it changes thickness at. */
export interface KagiSegment extends Bar {
  kagi: {
    /** Thick (yang) at its start. */
    thickStart: boolean;
    /** Where it crosses the last shoulder (going up, thin → thick) or waist (going down, thick → thin); null: no change. */
    switchAt: number | null;
  };
}

/**
 * Kagi (CC-I10) on closes: the line keeps its direction while closes extend it and turns only on a move of
 * `reversal` against it. Each segment is one bar from where it turned (`open`) to its extreme (`close`), at the time
 * the next turn was confirmed; the last segment is still forming. Thickness is TradingView's: the line turns thick
 * (yang) when it rises above the last shoulder (the top of the previous rising segment) and thin (yin) when it falls
 * below the last waist (the bottom of the previous falling one) — mid-segment, at that price. The first segment is
 * thick when it rises, thin when it falls.
 */
export function toKagi(bars: Bar[], reversal: number): KagiSegment[] {
  if (bars.length === 0 || reversal <= 0) return [];
  const out: KagiSegment[] = [];
  let direction: 1 | -1 | 0 = 0;
  let extreme = bars[0].close;
  let start = bars[0].close;
  let thick: boolean | null = null;
  let shoulder: number | null = null;
  let waist: number | null = null;

  /** The segment start → end with its thickness, and the thickness / shoulder / waist after it. */
  const push = (time: number, open: number, close: number, volume: number): void => {
    const rising = close > open;
    thick ??= rising;
    const thickStart: boolean = thick;
    let switchAt: number | null = null;
    if (rising && !thick && shoulder !== null && close > shoulder) {
      switchAt = shoulder;
      thick = true;
    } else if (!rising && thick && waist !== null && close < waist) {
      switchAt = waist;
      thick = false;
    }
    if (rising) shoulder = close;
    else waist = close;
    out.push({ ...segment(time, open, close, volume), kagi: { thickStart, switchAt } });
  };

  for (const bar of bars) {
    if (direction === 0) {
      if (Math.abs(bar.close - extreme) >= reversal) {
        direction = bar.close > extreme ? 1 : -1;
        start = extreme;
        extreme = bar.close;
      }
      continue;
    }
    if (direction === 1) {
      if (bar.close > extreme) {
        extreme = bar.close;
      } else if (extreme - bar.close >= reversal) {
        push(bar.time, start, extreme, bar.volume);
        start = extreme;
        extreme = bar.close;
        direction = -1;
      }
    } else {
      if (bar.close < extreme) {
        extreme = bar.close;
      } else if (bar.close - extreme >= reversal) {
        push(bar.time, start, extreme, bar.volume);
        start = extreme;
        extreme = bar.close;
        direction = 1;
      }
    }
  }
  if (direction !== 0) push(bars[bars.length - 1].time, start, extreme, 0);
  return sequence(out) as KagiSegment[];
}

function segment(time: number, open: number, close: number, volume: number): Bar {
  return {
    time,
    open,
    close,
    high: Math.max(open, close),
    low: Math.min(open, close),
    volume,
  };
}

/**
 * Range bars: every bar spans exactly `rangeSize` from high to low.
 *
 * The intrabar path is approximated from OHLC the way TradingView's own
 * history-based range bars do: an up candle is assumed to travel
 * open → low → high → close, a down candle open → high → low → close (the wick
 * against the close is printed first). Walking that path, a bar closes the
 * moment its high-low would exceed `rangeSize`, at the exact boundary price,
 * and the next bar opens at that close. The final, still-forming bar is
 * included (its range may be smaller), as on TradingView.
 */
export function toRangeBars(bars: Bar[], rangeSize: number): Bar[] {
  if (bars.length === 0 || !(rangeSize > 0)) return [];
  const out: Bar[] = [];
  let open = bars[0].open;
  let hi = open;
  let lo = open;
  let volume = 0;
  let time = bars[0].time;
  let guard = 0;

  const emit = (close: number, t: number) => {
    out.push({ time, open, high: Math.max(hi, close), low: Math.min(lo, close), close, volume });
    open = hi = lo = close;
    volume = 0;
    time = t;
  };

  for (const bar of bars) {
    const path =
      bar.close >= bar.open
        ? [bar.open, bar.low, bar.high, bar.close]
        : [bar.open, bar.high, bar.low, bar.close];
    volume += bar.volume;
    for (const p of path) {
      for (;;) {
        if (guard++ > 200_000) return sequence(out);
        if (p >= lo + rangeSize) {
          hi = lo + rangeSize;
          emit(hi, bar.time);
        } else if (p <= hi - rangeSize) {
          lo = hi - rangeSize;
          emit(lo, bar.time);
        } else {
          hi = Math.max(hi, p);
          lo = Math.min(lo, p);
          break;
        }
      }
    }
  }
  if (hi !== lo || out.length === 0) {
    out.push({ time, open, high: hi, low: lo, close: bars[bars.length - 1].close, volume });
  }
  return sequence(out);
}
