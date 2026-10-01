/*
 * Chart-type icon set: original line art on the 28×28 grid rendered by
 * `ChartIconComponent` (stroke = currentColor, 1px, no fill), following the
 * conventions of `tool-icons.ts` — axis-aligned strokes on .5 coordinates so
 * they stay crisp. Keyed by `ChartStyle` id, plus the two profile views.
 */

const l = (x1: number, y1: number, x2: number, y2: number): string =>
  `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
const rect = (x: number, y: number, w: number, h: number, filled = false): string =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}"${filled ? ' fill="currentColor"' : ''}/>`;
const poly = (pts: string): string => `<polyline points="${pts}"/>`;

/** Candle: wick from top to bottom, body between bodyTop/bodyBottom (centre x on .5). */
const candle = (
  x: number,
  top: number,
  bt: number,
  bb: number,
  bottom: number,
  w = 5,
  filled = false,
): string => l(x, top, x, bt) + rect(x - w / 2, bt, w, bb - bt, filled) + l(x, bb, x, bottom);

/** OHLC bar: vertical high-low with left open tick and right close tick. */
const ohlc = (x: number, hi: number, lo: number, o: number | null, c: number): string =>
  l(x, hi, x, lo) + (o === null ? '' : l(x - 3, o, x, o)) + l(x, c, x + 3, c);

export const CHART_TYPE_ICONS: Record<string, string> = {
  candles: candle(9.5, 6, 9.5, 18.5, 22, 5, true) + candle(18.5, 4, 7.5, 15.5, 20),
  hollow: candle(9.5, 7, 10.5, 19.5, 23) + candle(18.5, 4, 7.5, 15.5, 20),
  'heikin-ashi':
    candle(7.5, 14, 16.5, 22.5, 24, 4) +
    candle(13.5, 9, 11.5, 18.5, 21, 4) +
    candle(19.5, 4, 6.5, 13.5, 16, 4),
  bars: ohlc(9.5, 7, 22, 18.5, 10.5) + ohlc(18.5, 4, 19, 15.5, 7.5),
  'hlc-bars': ohlc(9.5, 7, 22, null, 10.5) + ohlc(18.5, 4, 19, null, 7.5),
  hilo: rect(6.5, 9.5, 4, 12) + rect(16.5, 5.5, 4, 11) + l(4, 24.5, 24, 24.5),
  'vol-candle': candle(8.5, 7, 10.5, 19.5, 23, 7) + candle(19.5, 4, 8.5, 14.5, 18, 3),
  line: poly('4,20 10,13 15,17 24,7'),
  'line-markers':
    poly('5.5,20 11,13 16,17 22.5,8') +
    '<circle cx="5.5" cy="20" r="1.5"/><circle cx="11" cy="13" r="1.5"/>' +
    '<circle cx="16" cy="17" r="1.5"/><circle cx="22.5" cy="8" r="1.5"/>',
  stepline: poly('4,20.5 9.5,20.5 9.5,13.5 15.5,13.5 15.5,17.5 19.5,17.5 19.5,7.5 24,7.5'),
  area: '<path d="M4 18L10 11L15 15L24 6V23.5H4Z"/>' + l(4, 20.5, 24, 20.5),
  'hlc-area':
    poly('4,14 10,8 15,11 24,4') +
    poly('4,23 10,18 15,21 24,13') +
    poly('4,18.5 10,13 15,16 24,8.5'),
  baseline: l(3, 14.5, 25, 14.5) + poly('4,17 8,20 12,15 15,10 19,7 24,12'),
  column: rect(5.5, 15.5, 4, 8) + rect(12.5, 10.5, 4, 13) + rect(19.5, 5.5, 4, 18),
  renko:
    rect(4.5, 17.5, 5, 5) +
    rect(9.5, 12.5, 5, 5) +
    rect(14.5, 7.5, 5, 5, true) +
    rect(19.5, 12.5, 5, 5),
  'line-break':
    rect(4.5, 15.5, 4, 7) +
    rect(9.5, 10.5, 4, 5) +
    rect(14.5, 5.5, 4, 5) +
    rect(19.5, 5.5, 4, 12, true),
  kagi: poly(
    '4.5,22 4.5,14.5 9.5,14.5 9.5,18.5 14.5,18.5 14.5,6.5 19.5,6.5 19.5,12.5 23.5,12.5 23.5,9',
  ),
  pnf:
    l(5, 17, 9, 21) +
    l(9, 17, 5, 21) +
    l(5, 11, 9, 15) +
    l(9, 11, 5, 15) +
    '<circle cx="14" cy="11" r="2"/><circle cx="14" cy="17" r="2"/>' +
    l(19, 5, 23, 9) +
    l(23, 5, 19, 9) +
    l(19, 11, 23, 15) +
    l(23, 11, 19, 15),
  range:
    candle(6.5, 14, 14, 22, 22, 4) +
    candle(12.5, 10, 10, 18, 18, 4) +
    candle(18.5, 6, 6, 14, 14, 4, true) +
    candle(23.5, 10, 10, 18, 18, 3),
  tpo:
    l(5.5, 4, 5.5, 24) +
    rect(8.5, 6.5, 3, 3) +
    rect(8.5, 10.5, 3, 3) +
    rect(12.5, 10.5, 3, 3) +
    rect(8.5, 14.5, 3, 3) +
    rect(12.5, 14.5, 3, 3) +
    rect(16.5, 14.5, 3, 3, true) +
    rect(20.5, 14.5, 3, 3) +
    rect(8.5, 18.5, 3, 3) +
    rect(12.5, 18.5, 3, 3),
  'session-vp':
    l(4.5, 4, 4.5, 24) +
    l(23.5, 4, 23.5, 24) +
    rect(4.5, 6.5, 5, 2) +
    rect(4.5, 10.5, 10, 2) +
    rect(4.5, 14.5, 15, 2, true) +
    rect(4.5, 18.5, 8, 2) +
    rect(4.5, 21.5, 4, 1),
};
