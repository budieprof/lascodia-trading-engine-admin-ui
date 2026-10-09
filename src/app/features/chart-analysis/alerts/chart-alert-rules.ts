import type { AlertChannel, AlertSeverity } from '@core/api/api.types';
import type {
  ChartAlertCondition,
  ChartAlertDto,
  ChartAlertFrequency,
  ChartAlertInput,
  ChartAlertSide,
  ChartAlertStatus,
} from './chart-alerts.types';

/** The latest quote of a symbol (bid and ask), as the price stream reports it. */
export interface LiveQuote {
  bid: number;
  ask: number;
  /** When it was received (ms). */
  at: number;
}

/** What the form calls the condition. */
export type AlertDirection = 'above' | 'below' | 'either' | 'enter' | 'exit';

/** How far from the live price a new alert's level starts: 10 points (1 pip on a 5-digit pair). */
export const DEFAULT_OFFSET_POINTS = 10;

/** A quote older than this is not used to judge a level (the engine's ChartAlerts:MaxQuoteAgeSeconds default). */
export const MAX_QUOTE_AGE_MS = 60_000;

export const DIRECTIONS: readonly { id: AlertDirection; label: string }[] = [
  { id: 'above', label: 'Crosses above' },
  { id: 'below', label: 'Crosses below' },
  { id: 'either', label: 'Crosses (either way)' },
  { id: 'enter', label: 'Enters channel' },
  { id: 'exit', label: 'Exits channel' },
];

export const SIDES: readonly { id: ChartAlertSide; label: string; hint: string }[] = [
  { id: 'Bid', label: 'Bid', hint: 'The price the chart shows' },
  { id: 'Ask', label: 'Ask', hint: 'Where a buy fills (bid + spread)' },
  { id: 'Mid', label: 'Mid', hint: 'Halfway between bid and ask' },
];

export const FREQUENCIES: readonly { id: ChartAlertFrequency; label: string; hint: string }[] = [
  { id: 'once', label: 'Only once', hint: 'Fires the first time, then stops' },
  { id: 'once_per_bar', label: 'Once per bar', hint: 'At most once in each bar of this timeframe' },
  {
    id: 'once_per_bar_close',
    label: 'Once per bar close',
    hint: 'When a bar closes on the other side',
  },
  {
    id: 'all',
    label: 'Every time',
    hint: 'Every crossing (paused if it fires more than 15 times in 3 minutes)',
  },
];

export const CHANNEL_OPTIONS: readonly { id: AlertChannel; label: string }[] = [
  { id: 'InApp', label: 'In app' },
  { id: 'Telegram', label: 'Telegram' },
  { id: 'Email', label: 'Email' },
  { id: 'Webhook', label: 'Webhook' },
];

export const SEVERITIES: readonly AlertSeverity[] = ['Info', 'Medium', 'High', 'Critical'];

export function conditionFor(direction: AlertDirection): ChartAlertCondition {
  switch (direction) {
    case 'above':
      return 'CrossingUp';
    case 'below':
      return 'CrossingDown';
    case 'enter':
      return 'EnteringChannel';
    case 'exit':
      return 'ExitingChannel';
    default:
      return 'Crossing';
  }
}

export function directionOf(condition: ChartAlertCondition): AlertDirection {
  switch (condition) {
    case 'CrossingUp':
      return 'above';
    case 'CrossingDown':
      return 'below';
    case 'EnteringChannel':
      return 'enter';
    case 'ExitingChannel':
      return 'exit';
    default:
      return 'either';
  }
}

export function isChannelDirection(direction: AlertDirection): boolean {
  return direction === 'enter' || direction === 'exit';
}

/** The price compared on `side`. */
export function sidePrice(quote: LiveQuote, side: ChartAlertSide): number {
  if (side === 'Ask') return quote.ask;
  if (side === 'Mid') return (quote.bid + quote.ask) / 2;
  return quote.bid;
}

/** One point at `precision` decimals (0.00001 on a 5-digit pair). */
export function pointSize(precision: number): number {
  return 10 ** -Math.max(0, Math.min(10, Math.trunc(precision)));
}

export function roundTo(price: number, precision: number): number {
  const p = Math.max(0, Math.min(10, Math.trunc(precision)));
  return Number(price.toFixed(p));
}

/** True when the quote is recent enough to judge a level by. */
export function isFresh(quote: LiveQuote | null | undefined, now = Date.now()): quote is LiveQuote {
  return !!quote && quote.bid > 0 && quote.ask >= quote.bid && now - quote.at <= MAX_QUOTE_AGE_MS;
}

/**
 * Where a new alert's level starts: 10 points beyond the live price on its side, in the direction it watches — never at
 * the price itself (SP-02: the old form pre-filled the last close and the alert fired at once). Without a fresh quote
 * the last close stands in.
 */
export function defaultLevel(
  quote: LiveQuote | null | undefined,
  lastClose: number,
  side: ChartAlertSide,
  direction: AlertDirection,
  precision: number,
): number {
  const base = isFresh(quote) ? sidePrice(quote, side) : lastClose;
  if (!(base > 0)) return 0;
  const offset = DEFAULT_OFFSET_POINTS * pointSize(precision);
  return roundTo(direction === 'below' ? base - offset : base + offset, precision);
}

/** A channel's default bounds: 10 points either side of the live price. */
export function defaultChannel(
  quote: LiveQuote | null | undefined,
  lastClose: number,
  side: ChartAlertSide,
  precision: number,
): { lower: number; upper: number } {
  const base = isFresh(quote) ? sidePrice(quote, side) : lastClose;
  const offset = DEFAULT_OFFSET_POINTS * pointSize(precision);
  return { lower: roundTo(base - offset, precision), upper: roundTo(base + offset, precision) };
}

/**
 * Why a level cannot be armed right now, or null — the engine's own check, so the form says it before the round trip:
 * a "crosses above" level at or below the live price on the alert's side, or "crosses below" at or above it, could only
 * fire after price first went back past it. Judged on a fresh quote only.
 */
export function alreadyMetReason(
  symbol: string,
  direction: AlertDirection,
  level: number | null | undefined,
  side: ChartAlertSide,
  quote: LiveQuote | null | undefined,
  precision: number,
  now = Date.now(),
): string | null {
  if (!isFresh(quote, now) || !(typeof level === 'number' && level > 0)) return null;
  const live = sidePrice(quote, side);
  const fmt = (v: number) => v.toFixed(Math.max(0, Math.trunc(precision)));
  const s = side.toLowerCase();
  if (direction === 'above' && live >= level)
    return `${symbol} ${s} is ${fmt(live)}, already at or above ${fmt(level)}. Pick a higher level, or choose "Crosses below".`;
  if (direction === 'below' && live <= level)
    return `${symbol} ${s} is ${fmt(live)}, already at or below ${fmt(level)}. Pick a lower level, or choose "Crosses above".`;
  return null;
}

/** "Bid crosses above 1.08500 · only once" — one line for lists and lines. */
export function describeAlert(alert: ChartAlertDto, precision: number): string {
  const fmt = (v: number | null | undefined) =>
    typeof v === 'number' ? v.toFixed(Math.max(0, precision)) : '—';
  const freq =
    FREQUENCIES.find((f) => f.id === alert.frequency)?.label.toLowerCase() ?? alert.frequency;
  const what =
    alert.kind === 'Drawing'
      ? `the ${(alert.drawingKind ?? 'drawing').replace(/-/g, ' ')}`
      : alert.condition === 'EnteringChannel' || alert.condition === 'ExitingChannel'
        ? `${fmt(alert.price)}–${fmt(alert.upperPrice)}`
        : fmt(alert.price);
  const verb =
    DIRECTIONS.find((d) => d.id === directionOf(alert.condition))?.label.toLowerCase() ?? '';
  return `${alert.side} ${verb} ${what} · ${freq}`;
}

export function statusLabel(status: ChartAlertStatus): string {
  switch (status) {
    case 'Active':
      return 'Active';
    case 'Paused':
      return 'Paused';
    case 'Triggered':
      return 'Fired';
    default:
      return 'Expired';
  }
}

/** The input of an existing alert — for editing it, or (with `copy`) for creating a copy of it. */
export function inputOf(alert: ChartAlertDto, copy = false): ChartAlertInput {
  return {
    name: copy && alert.name ? `${alert.name} (copy)` : (alert.name ?? null),
    symbol: alert.symbol,
    timeframe: alert.timeframe,
    kind: alert.kind,
    side: alert.side,
    condition: alert.condition,
    price: alert.price ?? null,
    upperPrice: alert.upperPrice ?? null,
    geometry: alert.geometry ?? null,
    drawingId: alert.drawingId ?? null,
    drawingKind: alert.drawingKind ?? null,
    frequency: alert.frequency,
    expiresAtUtc: alert.expiresAtUtc ?? null,
    channels: [...alert.channels],
    messageTemplate: alert.messageTemplate ?? null,
    severity: alert.severity,
  };
}
