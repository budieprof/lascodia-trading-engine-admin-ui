import { applyStoredTick, EPOCH_GRID, type BarGrid } from './aggregate';
import type { Bar } from './candle-feed.service';
import { isSessionResolution, type TvResolution } from './resolution';
import { applySessionTick } from './session-bars';
import { nextSessionPeriod, type TradingCalendar } from './session-calendar';

/**
 * A live price on a series that is not the chart's own — a compare study's other symbol (CC-13), a
 * split panel (CC-12): the newest bar moves, or the next one opens, by the same rules as the main
 * chart's (`applyStoredTick` on 1m … 1h, on the symbol's {@link BarGrid}, `applySessionTick` on the session grid, the symbol's
 * session laying out the next period when known). Null when the price changes nothing — or when only
 * the engine can say where the next period opens: these series have no resync of their own, and
 * catch up on their next load.
 */
export function liveTick(
  bars: readonly Bar[],
  price: number,
  nowMs: number,
  resolution: TvResolution,
  calendar: TradingCalendar | null,
  grid: BarGrid = EPOCH_GRID,
): Bar[] | null {
  if (bars.length === 0 || !Number.isFinite(price)) return null;
  if (isSessionResolution(resolution)) {
    const outcome = applySessionTick(
      bars,
      price,
      nowMs,
      calendar ? (last, now) => nextSessionPeriod(calendar, resolution, last, now) : undefined,
    );
    return outcome.kind === 'update' || outcome.kind === 'open' ? outcome.bars : null;
  }
  return applyStoredTick(bars, price, nowMs, resolution, grid) as Bar[] | null;
}

/**
 * A `priceUpdated` payload (SignalR `room:price:{SYMBOL}`). The EA (MT5) sends `bid` / `ask` (and `price` on old
 * builds); a venue (contract C3: crypto / exchange feeds through `md/ingest`) adds `last` and `sourceId`, and its
 * `bid` / `ask` / `mid` are null for a trades-only source. `timeUtc` is when the price happened.
 */
export interface PriceTick {
  symbol?: string | null;
  bid?: number | null;
  ask?: number | null;
  mid?: number | null;
  last?: number | null;
  price?: number | null;
  sourceId?: string | null;
  timeUtc?: string | number | null;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Whether the tick came from a venue feed (C3) rather than the MT5 EA. */
export function isVenueTick(tick: PriceTick | null | undefined): boolean {
  const id = (tick?.sourceId ?? '').trim().toLowerCase();
  return !!id && id !== 'mt5';
}

/**
 * The price a tick moves a chart to (UD04/UD05). MT5: the BID, exactly as before — MT5 bars are bid bars, so FX and
 * every broker CFD stay byte-identical. A venue: its LAST trade (what its bars are built from), else the mid, else the
 * middle of bid and ask, else whichever side it sent. Null when the tick has no usable price.
 */
export function tickPrice(tick: PriceTick | null | undefined): number | null {
  if (!tick) return null;
  if (!isVenueTick(tick)) return num(tick.bid) ?? num(tick.price) ?? num(tick.ask);
  const bid = num(tick.bid);
  const ask = num(tick.ask);
  return (
    num(tick.last) ??
    num(tick.mid) ??
    (bid !== null && ask !== null ? (bid + ask) / 2 : null) ??
    bid ??
    ask ??
    num(tick.price)
  );
}

/** How far a tick's own time may sit from the engine's clock and still place it (else the clock is used). */
const TICK_TIME_PAST_MS = 60_000;
const TICK_TIME_FUTURE_MS = 2_000;

/**
 * The instant a tick is bucketed at (UD04): its own `timeUtc` — a print at 10:59:59.8 that arrives at 11:00:00.3
 * belongs to the 10:00 bar — when it lies within a minute behind and two seconds ahead of `nowMs` (the engine's clock).
 * Anything else (a missing time, a broker clock that froze or runs ahead — EA server-UTC offset faults) uses `nowMs`,
 * as before.
 */
export function tickTimeMs(tick: PriceTick | null | undefined, nowMs: number): number {
  const raw = tick?.timeUtc;
  const t =
    typeof raw === 'number' ? raw : typeof raw === 'string' && raw ? Date.parse(raw) : Number.NaN;
  if (!Number.isFinite(t)) return nowMs;
  return t >= nowMs - TICK_TIME_PAST_MS && t <= nowMs + TICK_TIME_FUTURE_MS ? t : nowMs;
}
