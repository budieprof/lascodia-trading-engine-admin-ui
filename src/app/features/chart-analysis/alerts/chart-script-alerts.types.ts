import type { AlertChannel } from '@core/api/api.types';

/**
 * Alerts on chart scripts (SS-I1, scripting API §10a — `scripting/alerts`): TradingView's "create alert" on an
 * indicator, watched by the engine whether or not a chart is open.
 */

/** `alert()` — every alert() call of the script. */
export const ALERT_CALLS_KEY = 'alert()';
/** `order-fills` — a strategy's order fills. */
export const ORDER_FILLS_KEY = 'order-fills';

export type ScriptAlertFrequency = 'once_per_bar' | 'once_per_bar_close' | 'all' | 'once';

export type ScriptAlertStatus = 'Active' | 'Paused' | 'Disabled' | 'Expired';

export interface ChartScriptAlertDto {
  id: number;
  name: string | null;
  /** The name shown: its own, else the script's. */
  displayName: string;
  chartScriptId: number | null;
  scriptName: string;
  /** The chart script's revision it was armed with, and its current one (null when the script was deleted). */
  scriptRevision: string | null;
  currentScriptRevision: string | null;
  /** The chart script changed since it was armed: it still runs its snapshot until re-armed. */
  scriptChanged: boolean;
  scriptMissing: boolean;
  inputs: Record<string, unknown> | null;
  symbols: string[];
  watchlistId: number | null;
  watchlistName: string | null;
  timeframe: string;
  alertKey: string;
  frequency: ScriptAlertFrequency | string;
  channels: AlertChannel[] | string[];
  /** Masked (scheme and host): send it back unchanged to keep it. */
  webhookUrl: string | null;
  messageTemplate: string | null;
  expiresAtUtc: string | null;
  isEnabled: boolean;
  status: ScriptAlertStatus | string;
  /** What the engine does with it, in plain words (watching, waiting, does not compile …). */
  statusNote: string | null;
  /** When the engine last reported on it: null = not picked up yet; stale = no engine process is watching it. */
  statusAt: string | null;
  disabledReason: string | null;
  disabledAt: string | null;
  armedAtUtc: string;
  lastFiredAt: string | null;
  fireCount: number;
  lastDeliveryError: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Body of `POST scripting/alerts` (and `PUT …/{id}` without `chartScriptId`, plus `rearm`). */
export interface ChartScriptAlertInput {
  chartScriptId?: number;
  name?: string | null;
  symbols?: string[] | null;
  watchlistId?: number | null;
  timeframe: string;
  alertKey: string;
  frequency?: ScriptAlertFrequency | string | null;
  channels: string[];
  webhookUrl?: string | null;
  messageTemplate?: string | null;
  expiresAtUtc?: string | null;
  inputs?: Record<string, unknown> | null;
  /** PUT only: take the chart script's current source and saved inputs. */
  rearm?: boolean;
}

export interface ChartScriptAlertDeliveryDto {
  channel: AlertChannel | string;
  status: 'Pending' | 'Delivered' | 'Skipped' | 'Failed' | 'Expired' | string;
  attempts: number;
  lastError: string | null;
  deliveredAt: string | null;
}

export interface ChartScriptAlertFireDto {
  id: number;
  subscriptionId: number;
  symbol: string;
  timeframe: string;
  alertKey: string;
  barTimeMs: number;
  message: string;
  firedAtUtc: string;
  deliveries: ChartScriptAlertDeliveryDto[];
}

/** How long the engine may stay silent about an enabled alert before the tab says nobody is watching it (it reports every 5 min). */
export const STATUS_STALE_MS = 12 * 60_000;

/** The status line of an alert, with the engine's own note and how fresh it is. Pure. */
export function scriptAlertStatusText(a: ChartScriptAlertDto, nowMs: number): { text: string; stale: boolean } {
  if (!a.isEnabled || a.status !== 'Active') {
    const why = a.disabledReason ? ` — ${a.disabledReason}` : '';
    return { text: `${a.status}${why}`, stale: false };
  }
  const at = a.statusAt ? Date.parse(a.statusAt) : NaN;
  if (!Number.isFinite(at))
    return { text: 'Armed — waiting for the engine to pick it up.', stale: false };
  const stale = nowMs - at > STATUS_STALE_MS;
  const note = a.statusNote?.trim() || 'Watching.';
  return stale
    ? { text: `${note} (last report ${Math.round((nowMs - at) / 60_000)} min ago — the engine may not be watching it)`, stale }
    : { text: note, stale };
}

/** "Cross up · EURUSD, GBPUSD · 1h" — what an alert watches, in a line. */
export function describeScriptAlert(a: Pick<ChartScriptAlertDto, 'alertKey' | 'symbols' | 'watchlistName' | 'timeframe'>): string {
  const what =
    a.alertKey === ALERT_CALLS_KEY ? 'alert() calls' : a.alertKey === ORDER_FILLS_KEY ? 'order fills' : `“${a.alertKey}”`;
  const where = a.watchlistName ? `watchlist ${a.watchlistName}` : a.symbols.join(', ');
  return `${what} · ${where} · ${timeframeLabel(a.timeframe)}`;
}

/** Pine timeframe as people say it: "60" → "1h", "240" → "4h", "15" → "15m", "1D" → "1D". */
export function timeframeLabel(tf: string): string {
  const m = /^(\d+)$/.exec(tf);
  if (!m) return tf;
  const minutes = Number(m[1]);
  if (minutes % 1440 === 0) return `${minutes / 1440}D`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}
