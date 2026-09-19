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
 * Renko bricks.
 *
 * A brick is only emitted once price has travelled a full `brickSize` from the
 * last brick's close, and a REVERSAL needs two bricks' worth of movement —
 * that asymmetry is what filters the noise Renko exists to filter. Dropping it
 * produces a chart that oscillates on every tick and looks nothing like Renko.
 */
export function toRenko(bars: Bar[], brickSize: number): Bar[] {
  if (bars.length === 0 || brickSize <= 0) return [];
  const out: Bar[] = [];
  let anchor = bars[0].close;
  let direction: 1 | -1 | 0 = 0;

  for (const bar of bars) {
    // Guard the loop: a tiny brick size against a large move would otherwise
    // try to emit hundreds of thousands of bricks and hang the tab.
    let guard = 0;
    for (;;) {
      if (guard++ > 1000) break;
      const up = bar.close - anchor;
      const reversalBricks = direction === 0 ? 1 : 2;

      if (up >= brickSize * (direction === -1 ? reversalBricks : 1)) {
        const open = direction === -1 ? anchor + brickSize * 0 : anchor;
        const close = open + brickSize;
        out.push({
          time: bar.time,
          open,
          close,
          high: close,
          low: open,
          volume: bar.volume,
        });
        anchor = close;
        direction = 1;
        continue;
      }
      if (-up >= brickSize * (direction === 1 ? reversalBricks : 1)) {
        const open = anchor;
        const close = open - brickSize;
        out.push({
          time: bar.time,
          open,
          close,
          high: open,
          low: close,
          volume: bar.volume,
        });
        anchor = close;
        direction = -1;
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

/**
 * Point & Figure columns, rendered as one bar per column.
 *
 * X columns rise, O columns fall, and a column only ends when price reverses
 * by `reversal` boxes. Each column is emitted as a single bar spanning the
 * boxes it filled — P&F has no time axis at all, so this is the closest
 * faithful rendering on a time-based canvas.
 */
export function toPointAndFigure(bars: Bar[], boxSize: number, reversal = 3): Bar[] {
  if (bars.length === 0 || boxSize <= 0) return [];
  const out: Bar[] = [];
  let direction: 1 | -1 | 0 = 0;
  let top = bars[0].close;
  let bottom = bars[0].close;
  let columnTime = bars[0].time;
  let volume = 0;

  const flush = () => {
    if (direction === 0) return;
    out.push({
      time: columnTime,
      open: direction === 1 ? bottom : top,
      close: direction === 1 ? top : bottom,
      high: top,
      low: bottom,
      volume,
    });
    volume = 0;
  };

  for (const bar of bars) {
    volume += bar.volume;
    if (direction === 0) {
      if (bar.close - bottom >= boxSize) {
        direction = 1;
        top = bar.close;
        columnTime = bar.time;
      } else if (top - bar.close >= boxSize) {
        direction = -1;
        bottom = bar.close;
        columnTime = bar.time;
      } else {
        top = Math.max(top, bar.close);
        bottom = Math.min(bottom, bar.close);
      }
      continue;
    }

    if (direction === 1) {
      if (bar.high > top) {
        top = bar.high;
      } else if (top - bar.low >= boxSize * reversal) {
        flush();
        direction = -1;
        bottom = bar.low;
        columnTime = bar.time;
        top = top - boxSize;
      }
    } else {
      if (bar.low < bottom) {
        bottom = bar.low;
      } else if (bar.high - bottom >= boxSize * reversal) {
        flush();
        direction = 1;
        top = bar.high;
        columnTime = bar.time;
        bottom = bottom + boxSize;
      }
    }
  }
  flush();
  return sequence(out);
}

/**
 * Kagi.
 *
 * Returned as bars whose open/close trace the line's turning points: the line
 * continues in its direction while price extends, and turns only on a move of
 * `reversal` against it. Thickness (yang/yin) is conveyed by direction here,
 * since a line series cannot vary its own width mid-stream.
 */
export function toKagi(bars: Bar[], reversal: number): Bar[] {
  if (bars.length === 0 || reversal <= 0) return [];
  const out: Bar[] = [];
  let direction: 1 | -1 | 0 = 0;
  let extreme = bars[0].close;
  let start = bars[0].close;

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
        out.push(segment(bar.time, start, extreme, bar.volume));
        start = extreme;
        extreme = bar.close;
        direction = -1;
      }
    } else {
      if (bar.close < extreme) {
        extreme = bar.close;
      } else if (bar.close - extreme >= reversal) {
        out.push(segment(bar.time, start, extreme, bar.volume));
        start = extreme;
        extreme = bar.close;
        direction = 1;
      }
    }
  }
  if (direction !== 0) out.push(segment(bars[bars.length - 1].time, start, extreme, 0));
  return sequence(out);
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
