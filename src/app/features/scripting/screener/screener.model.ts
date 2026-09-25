import type { ScreenerAlert, ScreenerRow } from '../api/scripting-api.types';
import { toCamelCase } from '../report/strategy-report.model';
import { NA, formatDateTime } from '../report/report-format';
import { toCsv } from '../shared/download';

/**
 * The Pine screener (§6 `POST scripting/screener`): request limits, result normalisation, the
 * dynamic plot columns and the CSV export.
 */

export const MAX_SCREENER_SYMBOLS = 200;
export const MAX_SCREENER_BARS = 500;

export type ScreenerSourceMode = 'saved' | 'library' | 'source';

export interface ScreenerForm {
  mode: ScreenerSourceMode;
  source: string | null;
  libraryId: number | null;
  symbols: readonly string[];
  timeframe: string;
  lastBars: number | string;
}

/** The first problem with a screener request, or null when it can be sent. */
export function validateScreenerForm(f: ScreenerForm): string | null {
  if (f.mode === 'library') {
    if (f.libraryId === null) return 'Choose a library.';
  } else if (!f.source || !f.source.trim()) {
    return f.mode === 'saved' ? 'Choose a saved script.' : 'Paste a script to run.';
  }
  if (f.symbols.length === 0) return 'Choose at least one symbol.';
  if (f.symbols.length > MAX_SCREENER_SYMBOLS) {
    return `Choose at most ${MAX_SCREENER_SYMBOLS} symbols (${f.symbols.length} selected).`;
  }
  if (!f.timeframe) return 'Choose a timeframe.';
  const bars = Number(f.lastBars);
  if (!Number.isInteger(bars) || bars < 1 || bars > MAX_SCREENER_BARS) {
    return `Bars must be a whole number from 1 to ${MAX_SCREENER_BARS}.`;
  }
  return null;
}

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function camelShallow(o: Json): Json {
  const out: Json = {};
  for (const [k, v] of Object.entries(o)) out[toCamelCase(k)] = v;
  return out;
}

function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '' && !['NaN', 'Infinity', '-Infinity'].includes(v)) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Normalises the screener's rows. Top-level keys may arrive in either casing; the `values` keys
 * are plot titles and are kept exactly as the script wrote them.
 */
export function normalizeScreenerRows(raw: unknown): ScreenerRow[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isObject).map((r) => {
    const o = camelShallow(r);
    const values: Record<string, number | null> = {};
    if (isObject(o['values'])) {
      for (const [k, v] of Object.entries(o['values'])) values[k] = num(v);
    }
    const alerts: ScreenerAlert[] = Array.isArray(o['alerts'])
      ? o['alerts'].filter(isObject).map((a) => {
          const x = camelShallow(a);
          return {
            title: typeof x['title'] === 'string' ? (x['title'] as string) : '',
            message: typeof x['message'] === 'string' ? (x['message'] as string) : '',
            barIndex: num(x['barIndex']) ?? -1,
          };
        })
      : [];
    const error =
      typeof o['error'] === 'string' && (o['error'] as string).trim()
        ? (o['error'] as string)
        : null;
    return {
      symbol: typeof o['symbol'] === 'string' ? (o['symbol'] as string) : String(o['symbol'] ?? ''),
      lastBarTimeMs: num(o['lastBarTimeMs']),
      values,
      alerts,
      error,
    };
  });
}

/** Every plot title any row carries, in first-seen order — the grid's dynamic columns. */
export function plotColumns(rows: readonly ScreenerRow[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rows) {
    for (const k of Object.keys(r.values)) {
      if (!seen.has(k)) {
        seen.add(k);
        out.push(k);
      }
    }
  }
  return out;
}

/** A plot value with sensible precision: prices keep their decimals, big numbers get separators. */
export function formatPlotValue(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return NA;
  const abs = Math.abs(v);
  const decimals = abs >= 1000 ? 2 : abs >= 1 ? 4 : 6;
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: decimals }).format(v);
}

/** "2 — Overbought, Crossed up" for the alerts column. */
export function alertsSummary(alerts: readonly ScreenerAlert[]): string {
  if (alerts.length === 0) return '';
  const titles = [...new Set(alerts.map((a) => a.title || 'alert()'))];
  return `${alerts.length} — ${titles.join(', ')}`;
}

export interface ScreenerSummary {
  symbols: number;
  withAlerts: number;
  errors: number;
}

export function summarize(rows: readonly ScreenerRow[]): ScreenerSummary {
  return {
    symbols: rows.length,
    withAlerts: rows.filter((r) => r.alerts.length > 0).length,
    errors: rows.filter((r) => !!r.error).length,
  };
}

/** The CSV the export button downloads: symbol, last bar, one column per plot, alerts, error. */
export function screenerCsv(rows: readonly ScreenerRow[], plots: readonly string[]): string {
  const headers = ['Symbol', 'Last bar (UTC)', ...plots, 'Alerts', 'Alert messages', 'Error'];
  const body = rows.map((r) => [
    r.symbol,
    r.lastBarTimeMs === null ? '' : new Date(r.lastBarTimeMs).toISOString(),
    ...plots.map((p) => r.values[p] ?? null),
    r.alerts.map((a) => a.title || 'alert()').join('; '),
    r.alerts
      .map((a) => a.message)
      .filter(Boolean)
      .join(' | '),
    r.error ?? '',
  ]);
  return toCsv(headers, body);
}

export function lastBarText(ms: number | null): string {
  return ms === null ? NA : formatDateTime(ms);
}
