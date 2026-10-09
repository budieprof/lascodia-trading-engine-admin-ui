import type { AlertChannel, AlertSeverity } from '@core/api/api.types';

/**
 * Chart alerts v2 — wire types of `api/v1/lascodia-trading-engine/chart-alert` (engine
 * `docs/api/chart-alerts-api.md`). Enums travel as their names.
 */

export type ChartAlertKind = 'Price' | 'Drawing';

/** Which price is compared with the level: bid (the chart's candles), ask or mid. */
export type ChartAlertSide = 'Bid' | 'Ask' | 'Mid';

export type ChartAlertCondition =
  | 'CrossingUp'
  | 'CrossingDown'
  | 'Crossing'
  | 'EnteringChannel'
  | 'ExitingChannel';

export type ChartAlertStatus = 'Active' | 'Paused' | 'Triggered' | 'Expired';

/** The script-alert frequency values, shared by chart alerts. */
export type ChartAlertFrequency = 'once' | 'once_per_bar' | 'once_per_bar_close' | 'all';

export type ChartAlertDeliveryStatus = 'Pending' | 'Delivered' | 'Skipped' | 'Failed' | 'Expired';

/** One drawing anchor. */
export interface ChartAlertAnchor {
  timeMs: number;
  price: number;
}

/** A drawing alert's shape (see the engine's ChartAlertGeometry). */
export interface ChartAlertGeometry {
  shape: 'horizontal' | 'line' | 'channel' | 'fib';
  points: ChartAlertAnchor[];
  extendLeft?: boolean;
  extendRight?: boolean;
  level?: number | null;
  reverse?: boolean;
  logScale?: boolean;
}

/** What the chart sends to create or edit an alert. */
export interface ChartAlertInput {
  name?: string | null;
  symbol: string;
  timeframe: string;
  kind: ChartAlertKind;
  side: ChartAlertSide;
  condition: ChartAlertCondition;
  price?: number | null;
  upperPrice?: number | null;
  geometry?: ChartAlertGeometry | null;
  drawingId?: string | null;
  drawingKind?: string | null;
  frequency: ChartAlertFrequency;
  expiresAtUtc?: string | null;
  channels: AlertChannel[];
  messageTemplate?: string | null;
  severity: AlertSeverity;
}

export interface ChartAlertDto extends ChartAlertInput {
  id: number;
  status: ChartAlertStatus;
  statusReason: string | null;
  createdAt: string;
  updatedAt: string;
  lastFiredAt: string | null;
  fireCount: number;
}

export interface ChartAlertDeliveryDto {
  channel: AlertChannel;
  status: ChartAlertDeliveryStatus;
  attempts: number;
  lastError: string | null;
  deliveredAt: string | null;
}

export interface ChartAlertFireDto {
  id: number;
  chartAlertId: number;
  symbol: string;
  timeframe: string;
  kind: ChartAlertKind;
  condition: ChartAlertCondition;
  side: ChartAlertSide;
  level: number;
  price: number;
  previousPrice: number | null;
  bid: number;
  ask: number;
  priceTimeUtc: string;
  barTimeMs: number;
  firedAtUtc: string;
  title: string;
  message: string;
  severity: AlertSeverity;
  deliveries: ChartAlertDeliveryDto[];
}
