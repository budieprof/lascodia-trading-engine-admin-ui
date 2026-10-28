/**
 * Pure helpers for the public landing page (`/`, `/welcome`). The hero shows an illustrated console fed by a
 * seeded random walk — decoration, never market data — so everything here is deterministic and testable.
 */

export interface Candle {
  o: number;
  h: number;
  l: number;
  c: number;
}

export interface LadderLevel {
  price: number;
  size: number;
  side: 'ask' | 'bid';
}

/** mulberry32: small, fast, seedable. Returns floats in [0, 1). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One new bar opening at `open`; a gentle upward drift keeps the illustration optimistic but not cartoonish. */
export function nextCandle(open: number, rnd: () => number, step = 0.0004): Candle {
  const drift = step * 0.12;
  const c = open + (rnd() - 0.47) * step * 2 + drift;
  const h = Math.max(open, c) + rnd() * step * 0.8;
  const l = Math.min(open, c) - rnd() * step * 0.8;
  return { o: open, h, l, c };
}

/** The forming bar moves: the close wanders and the range widens to contain it. */
export function tickCandle(bar: Candle, rnd: () => number, step = 0.0004): Candle {
  const c = bar.c + (rnd() - 0.5) * step * 0.5;
  return { o: bar.o, c, h: Math.max(bar.h, c), l: Math.min(bar.l, c) };
}

export function seedCandles(count: number, start: number, rnd: () => number): Candle[] {
  const out: Candle[] = [];
  let open = start;
  for (let i = 0; i < count; i++) {
    const bar = nextCandle(open, rnd);
    out.push(bar);
    open = bar.c;
  }
  return out;
}

export function ema(values: readonly number[], period: number): number[] {
  if (!values.length) return [];
  const k = 2 / (period + 1);
  const out = [values[0]];
  for (let i = 1; i < values.length; i++) out.push(values[i] * k + out[i - 1] * (1 - k));
  return out;
}

export interface ChartGeometry {
  bodies: { x: number; y: number; w: number; h: number; up: boolean }[];
  wicks: { x: number; y1: number; y2: number; up: boolean }[];
  emaPath: string;
  areaPath: string;
  /** Vertical position of the last close, 0..1 from the top — places the HTML price tag. */
  lastY: number;
}

/** Lays candles out in a `width` × `height` box with `pad` px of headroom above and below. */
export function chartGeometry(
  candles: readonly Candle[],
  width: number,
  height: number,
  pad = 16,
): ChartGeometry {
  if (!candles.length) return { bodies: [], wicks: [], emaPath: '', areaPath: '', lastY: 0.5 };
  let lo = Infinity;
  let hi = -Infinity;
  for (const c of candles) {
    lo = Math.min(lo, c.l);
    hi = Math.max(hi, c.h);
  }
  const span = hi - lo || 1;
  const y = (p: number) => pad + (1 - (p - lo) / span) * (height - pad * 2);
  const slot = width / candles.length;
  const bodyW = Math.max(1, slot * 0.62);

  const bodies: ChartGeometry['bodies'] = [];
  const wicks: ChartGeometry['wicks'] = [];
  candles.forEach((c, i) => {
    const cx = i * slot + slot / 2;
    const up = c.c >= c.o;
    const top = y(Math.max(c.o, c.c));
    const bottom = y(Math.min(c.o, c.c));
    bodies.push({ x: cx - bodyW / 2, y: top, w: bodyW, h: Math.max(1, bottom - top), up });
    wicks.push({ x: cx, y1: y(c.h), y2: y(c.l), up });
  });

  const line = ema(
    candles.map((c) => c.c),
    9,
  ).map((v, i) => `${(i * slot + slot / 2).toFixed(1)},${y(v).toFixed(1)}`);
  const emaPath = `M${line.join(' L')}`;
  const firstX = (slot / 2).toFixed(1);
  const lastX = ((candles.length - 1) * slot + slot / 2).toFixed(1);
  const areaPath = `${emaPath} L${lastX},${height} L${firstX},${height} Z`;

  return { bodies, wicks, emaPath, areaPath, lastY: y(candles[candles.length - 1].c) / height };
}

/** Ten-level book around `mid`: five asks above, five bids below, sizes from the walk. */
export function ladder(mid: number, rnd: () => number, levels = 5, tick = 0.00005): LadderLevel[] {
  const out: LadderLevel[] = [];
  for (let i = levels; i >= 1; i--)
    out.push({ price: mid + tick * i, size: Math.round(2 + rnd() * 38) / 2, side: 'ask' });
  for (let i = 1; i <= levels; i++)
    out.push({ price: mid - tick * (i - 1), size: Math.round(2 + rnd() * 38) / 2, side: 'bid' });
  return out;
}

/** The trip every order takes, in order. The hero's strip steps through these. */
export const ORDER_STAGES = [
  'Signal received',
  'Risk gates 7/7',
  'Sent to MT5',
  'Filled',
  'Reconciled',
] as const;

export function nextStage(stage: number): number {
  return (stage + 1) % (ORDER_STAGES.length + 1);
}

/** A short correlation id for the illustration, shaped like the engine's. */
export function illustrationCid(rnd: () => number): string {
  return Math.floor(rnd() * 0xffffff)
    .toString(16)
    .padStart(6, '0');
}

export type PrimaryCta = { label: string; route: string; kind: 'signup' | 'request' };

/**
 * What the main button offers. It always leads to `/signup`: while the engine answers `GET onboarding/signup` with
 * `available` that page creates an organisation ("Start free"); otherwise it is a request-access form, because
 * organisations are then created by invitation ("Get started"). Sign-in is always a separate link.
 */
export function primaryCta(signup: { available: boolean } | null | undefined): PrimaryCta {
  if (signup?.available) return { label: 'Start free', route: '/signup', kind: 'signup' };
  return { label: 'Get started', route: '/signup', kind: 'request' };
}

export function formatPrice(p: number): string {
  return p.toFixed(5);
}
