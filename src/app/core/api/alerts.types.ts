import type { AlertChannel, AlertSeverity } from '@core/api/api.types';

/**
 * Alert delivery wire types that are not (yet) in the generated schema (2026-10-09, alerts vertical).
 */

/**
 * SignalR `alertFired` (contract C2): an alert delivered in-app — a chart alert (`price`/`drawing`), a script alert
 * binding (`script`) or a channel test (`test`). A broadcast with no operator identity: a chart alert is shown only after
 * `GET chart-alert/{alertId}` confirms it is this operator's.
 */
export interface AlertFiredPayload {
  source: 'price' | 'drawing' | 'script' | 'test';
  /** The chart alert, or (script) the alert binding. */
  alertId: number;
  /** Script alerts: the binding (its subscription). */
  subscriptionId: number | null;
  symbol: string;
  timeframe: string | null;
  title: string;
  message: string;
  price: number | null;
  firedAtUtc: string;
  severity: AlertSeverity;
  /** Chart alerts: the fire record. */
  fireId?: number | null;
  /** Script alerts: the strategy. */
  strategyId?: number | null;
}

/** What happened on one channel when an engine alert was sent (`GET alert/{id}/dispatch-log`). */
export interface AlertDispatchLogDto {
  id: number;
  alertId: number;
  channel: AlertChannel;
  /** Masked like the channel status. */
  destination: string | null;
  status: 'Sent' | 'Failed' | 'Retrying' | 'Skipped';
  message: string;
  dispatchedAt: string;
  /** Why it failed or was skipped. */
  errorMessage: string | null;
}

/** One script alert delivery (`GET alert/script-deliveries`). */
export interface ScriptAlertDeliveryDto {
  id: number;
  strategyId: number;
  bindingId: number;
  alertKey: string;
  channel: AlertChannel;
  status: 'Pending' | 'Delivered' | 'Skipped' | 'Failed' | 'Expired';
  attempts: number;
  symbol: string;
  message: string;
  lastError: string | null;
  createdAt: string;
  deliveredAt: string | null;
  nextAttemptAt: string;
}
