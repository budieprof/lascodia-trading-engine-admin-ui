import type { CurrencyPairDto } from '@core/api/api.types';
import type { InstrumentAssetClass, InstrumentDto } from '@core/instruments/instrument.types';
import type { ChartStyle, ScaleMode } from '../chart/chart-host.component';
import { CHART_STYLES } from '../pages/chart-analysis-page/chart-page.config';

/**
 * US03: the split view's other charts, pure — what each draws of its own (style, scale, volume), what
 * it says while it loads or when it has nothing, and which symbols it can show.
 */

/**
 * A panel's own look. Absent fields follow the main chart (style, scale) or stay off (volume), as
 * every panel did before it had settings of its own.
 */
export interface PanelView {
  style?: ChartStyle;
  scaleMode?: ScaleMode;
  showVolume?: boolean;
}

/** Where a panel's bars are: asked for, on screen, none to show (and why), or the request failed. */
export type PanelLoad =
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'empty'; message: string }
  | { kind: 'error'; message: string };

/** What a panel draws, its own settings over the main chart's. */
export function panelLook(
  view: PanelView | undefined,
  main: { style: ChartStyle; scaleMode: ScaleMode },
): { style: ChartStyle; scaleMode: ScaleMode; showVolume: boolean } {
  return {
    style: view?.style ?? main.style,
    scaleMode: view?.scaleMode ?? main.scaleMode,
    showVolume: view?.showVolume ?? false,
  };
}

/** A panel's settings with one changed; `undefined` goes back to following the main chart. */
export function withView<K extends keyof PanelView>(
  view: PanelView | undefined,
  key: K,
  value: PanelView[K] | undefined,
): PanelView | undefined {
  const next: PanelView = { ...(view ?? {}) };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return Object.keys(next).length ? next : undefined;
}

const SCALE_MODES: readonly ScaleMode[] = ['normal', 'log', 'percent', 'indexed'];

/** A saved panel's settings, keeping only what this console can draw (a layout may come from another build). */
export function restoredPanelView(raw: unknown): PanelView | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const view: PanelView = {};
  if (CHART_STYLES.some((s) => s.id === r['style'])) view.style = r['style'] as ChartStyle;
  if (SCALE_MODES.includes(r['scaleMode'] as ScaleMode)) view.scaleMode = r['scaleMode'] as ScaleMode;
  if (typeof r['showVolume'] === 'boolean') view.showVolume = r['showVolume'];
  return Object.keys(view).length ? view : undefined;
}

/** The scale modes a panel offers, as the main chart's scale menu names them. */
export const PANEL_SCALES: ReadonlyArray<{ id: ScaleMode; label: string }> = [
  { id: 'normal', label: 'Regular' },
  { id: 'log', label: 'Log' },
  { id: 'percent', label: 'Percent' },
  { id: 'indexed', label: 'Indexed to 100' },
];

/** A failed load, in words: the engine's message when there is one. */
export function panelLoadError(e: unknown): string {
  return e instanceof Error && e.message
    ? `Could not load candles: ${e.message}`
    : 'Could not load candles.';
}

/** One choice of a panel's symbol select. */
export interface PanelSymbolOption {
  symbol: string;
  /** What the option reads: the symbol, and where it is not obvious, what it is. */
  label: string;
}

export interface PanelSymbolGroup {
  label: string;
  options: PanelSymbolOption[];
}

const CLASS_LABEL: Record<InstrumentAssetClass, string> = {
  Fx: 'Forex',
  Future: 'Futures',
  Crypto: 'Crypto',
  Equity: 'Equities',
  Index: 'Indices',
  Commodity: 'Commodities',
  Etf: 'ETFs',
};

const upper = (s: string | null | undefined): string => (s ?? '').trim().toUpperCase();

/**
 * The symbols a panel can show: the MT5 broker's symbols first (in their order — the list every panel
 * had), then the catalogue's chartable instruments (those with candles) by asset class, and the panel's
 * own symbol wherever it is from, so a panel on BTC-USD never shows a blank select.
 */
export function panelSymbolGroups(
  pairs: readonly CurrencyPairDto[],
  catalogue: readonly InstrumentDto[],
  current?: string,
): PanelSymbolGroup[] {
  const seen = new Set<string>();
  const broker: PanelSymbolOption[] = [];
  for (const p of pairs) {
    const symbol = upper(p.symbol);
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    broker.push({ symbol, label: symbol });
  }
  const byClass = new Map<string, PanelSymbolOption[]>();
  for (const i of catalogue) {
    const symbol = upper(i.symbol);
    if (!symbol || seen.has(symbol) || i.status === 'Inactive' || i.hasCandles === false) continue;
    seen.add(symbol);
    const group = CLASS_LABEL[i.assetClass] ?? i.assetClass;
    const source = i.candleSource?.label;
    const list = byClass.get(group) ?? [];
    list.push({ symbol, label: source ? `${symbol} · ${source}` : symbol });
    byClass.set(group, list);
  }
  const groups: PanelSymbolGroup[] = [];
  if (broker.length) groups.push({ label: 'MT5 broker', options: broker });
  for (const [label, options] of [...byClass].sort(([a], [b]) => a.localeCompare(b)))
    groups.push({ label, options: options.sort((a, b) => a.symbol.localeCompare(b.symbol)) });
  const cur = upper(current);
  if (cur && !seen.has(cur)) groups.unshift({ label: 'This chart', options: [{ symbol: cur, label: cur }] });
  return groups;
}

/**
 * The symbols new panels open on, in order: different from the main chart and the panels already
 * open (two identical charts side by side is never what the operator wanted) — the broker's first, as
 * before, then the catalogue's.
 */
export function panelCandidates(
  pairs: readonly CurrencyPairDto[],
  catalogue: readonly InstrumentDto[],
  taken: Iterable<string>,
): string[] {
  const used = new Set([...taken].map(upper));
  return panelSymbolGroups(pairs, catalogue)
    .flatMap((g) => g.options.map((o) => o.symbol))
    .filter((s) => !used.has(s));
}
