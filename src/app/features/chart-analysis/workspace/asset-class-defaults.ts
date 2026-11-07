import { Injectable, inject, signal } from '@angular/core';
import type { InstrumentAssetClass } from '@core/instruments/instrument.types';
import { isSupportedResolution, type TvResolution } from '../datafeed/resolution';
import { ChartPrefsService } from './chart-prefs.service';

/**
 * US07: per asset class, what a symbol of that class opens with — a timeframe and a study template (crypto on 4h with
 * funding and volume studies, FX on 1h with the session VWAP). Opt-in: nothing applies until the operator sets one, so
 * the chart behaves as before. Applied when the chart moves to a symbol of ANOTHER class that the per-symbol memory
 * has nothing for (switching between two FX pairs never replaces the studies on screen). A synced chart preference.
 */
export const ASSET_CLASS_DEFAULTS_KEY = 'lascodia.chart.assetClassDefaults.v1';

export interface AssetClassDefault {
  resolution?: TvResolution;
  /** A study template's id (`ChartLayoutStore`); a template deleted since is ignored. */
  templateId?: string;
}

export type AssetClassDefaults = Partial<Record<InstrumentAssetClass, AssetClassDefault>>;

const CLASSES: readonly InstrumentAssetClass[] = ['Fx', 'Future', 'Crypto', 'Equity', 'Index', 'Commodity', 'Etf'];

/** Stored defaults with anything malformed dropped. */
export function parseAssetClassDefaults(raw: string | null): AssetClassDefaults {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object') return {};
  const out: AssetClassDefaults = {};
  for (const cls of CLASSES) {
    const v = (parsed as Record<string, unknown>)[cls];
    if (!v || typeof v !== 'object') continue;
    const e = v as Record<string, unknown>;
    const entry: AssetClassDefault = {};
    if (typeof e['resolution'] === 'string' && isSupportedResolution(e['resolution']))
      entry.resolution = e['resolution'] as TvResolution;
    if (typeof e['templateId'] === 'string' && e['templateId']) entry.templateId = e['templateId'];
    if (Object.keys(entry).length) out[cls] = entry;
  }
  return out;
}

/**
 * What a switch from a symbol of class `from` to one of class `to` applies: the class's default when the class changes
 * and the symbol memory recalls nothing for the symbol; null otherwise (or when there is no default).
 */
export function defaultOnSwitch(
  defaults: AssetClassDefaults,
  from: InstrumentAssetClass | null,
  to: InstrumentAssetClass | null,
  remembered: boolean,
): AssetClassDefault | null {
  if (!to || remembered || from === to) return null;
  return defaults[to] ?? null;
}

/** "Forex", "Crypto", … for the menu. */
export const ASSET_CLASS_NAME: Record<InstrumentAssetClass, string> = {
  Fx: 'Forex',
  Future: 'Futures',
  Crypto: 'Crypto',
  Equity: 'Equities',
  Index: 'Indices',
  Commodity: 'Commodities',
  Etf: 'ETFs',
};

@Injectable({ providedIn: 'root' })
export class AssetClassDefaultsService {
  private readonly prefs = inject(ChartPrefsService);
  readonly defaults = signal<AssetClassDefaults>(parseAssetClassDefaults(this.prefs.getItem(ASSET_CLASS_DEFAULTS_KEY)));

  /** Re-read after the engine's preferences were hydrated into the cache. */
  reload(): void {
    this.defaults.set(parseAssetClassDefaults(this.prefs.getItem(ASSET_CLASS_DEFAULTS_KEY)));
  }

  /** Set (or with `undefined`, clear) one field of a class's default. */
  set<K extends keyof AssetClassDefault>(cls: InstrumentAssetClass, key: K, value: AssetClassDefault[K] | undefined): void {
    const next: AssetClassDefaults = { ...this.defaults() };
    const entry: AssetClassDefault = { ...(next[cls] ?? {}) };
    if (value === undefined) delete entry[key];
    else entry[key] = value;
    if (Object.keys(entry).length) next[cls] = entry;
    else delete next[cls];
    this.defaults.set(next);
    if (Object.keys(next).length) this.prefs.setItem(ASSET_CLASS_DEFAULTS_KEY, JSON.stringify(next));
    else this.prefs.removeItem(ASSET_CLASS_DEFAULTS_KEY);
  }
}
