import type { AlertChannel, AlertSeverity } from '@core/api/api.types';

/**
 * Chart alerts v2 — wire types of `api/v1/lascodia-trading-engine/chart-alert` (engine
 * `docs/api/chart-alerts-api.md`). Enums travel as their names.
 */

export type ChartAlertKind = 'Price' | 'Drawing' | MetricAlertKind;

/**
 * Derivatives alerts (multi-asset chart program C7 / UF04): evaluated engine-side every 15 s from the stored derivatives
 * data, not per tick. Funding in percent per funding interval, open-interest change in percent over `windowMinutes`,
 * basis in percent, liquidations in quote notional over `windowMinutes`.
 */
export type MetricAlertKind = 'Funding' | 'OpenInterestChange' | 'Basis' | 'Liquidations';

export type MetricComparator = 'above' | 'below' | 'crossesAbove' | 'crossesBelow';

/** The unit of a metric alert's value (engine `ChartAlertMetricKinds.Unit`). */
export type MetricUnit = 'percentPerInterval' | 'percent' | 'quoteNotional';

/** A derivatives alert's condition as the API takes it. */
export interface ChartAlertMetricInput {
  comparator: MetricComparator;
  /** In the kind's unit. */
  value: number;
  /** OpenInterestChange / Liquidations only (1-1440); must be empty for the others. */
  windowMinutes?: number | null;
  /** The market-data source read (`crypto-okx`); empty = the first with data. */
  sourceId?: string | null;
}

/** …and as the API answers it. */
export interface ChartAlertMetricDto extends ChartAlertMetricInput {
  unit: MetricUnit;
}

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
  /** C7: required for the metric kinds, absent otherwise. */
  metric?: ChartAlertMetricInput | null;
}

export interface ChartAlertDto extends ChartAlertInput {
  metric?: ChartAlertMetricDto | null;
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
