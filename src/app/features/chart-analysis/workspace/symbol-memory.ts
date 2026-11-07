import type { ChartViewState } from '../chart/chart-host.component';
import { isSupportedResolution, type TvResolution } from '../datafeed/resolution';
import { instrumentKey, KEY_PATTERN } from './instrument-key';

/**
 * Layout memory per symbol (CC-I11): with it on, a symbol the chart switches to opens on the timeframe and zoom it
 * was left on in this layout. Saved with the layout (`ChartWorkspaceState.symbolMemory`), most recent first, at most
 * {@link SYMBOL_MEMORY_LIMIT} symbols.
 *
 * US07: kept by INSTRUMENT ({@link instrumentKey}): ESZ6 and ESH7 are the S&P future, remembered as ES1!. A layout
 * saved with older keys is migrated on restore (the most recent entry of an instrument wins).
 */
export interface SymbolMemoryEntry {
  resolution: TvResolution;
  view?: ChartViewState;
}

export type SymbolMemory = Record<string, SymbolMemoryEntry>;

export const SYMBOL_MEMORY_LIMIT = 50;

/** `memory` with `symbol` as it is left now, first; the oldest past the limit dropped. */
export function rememberSymbol(memory: SymbolMemory, symbol: string, entry: SymbolMemoryEntry): SymbolMemory {
  const key = instrumentKey(symbol);
  const out: SymbolMemory = { [key]: entry };
  for (const [k, v] of Object.entries(memory)) {
    if (k === key) continue;
    if (Object.keys(out).length >= SYMBOL_MEMORY_LIMIT) break;
    out[k] = v;
  }
  return out;
}

/** What `symbol` was left on, if remembered. */
export function recalled(memory: SymbolMemory, symbol: string): SymbolMemoryEntry | null {
  return memory[instrumentKey(symbol)] ?? null;
}

/** A layout's symbol memory with anything malformed dropped (an unknown timeframe, a broken view). */
export function restoredSymbolMemory(raw: unknown): SymbolMemory {
  if (!raw || typeof raw !== 'object') return {};
  const out: SymbolMemory = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (Object.keys(out).length >= SYMBOL_MEMORY_LIMIT) break;
    if (!KEY_PATTERN.test(k) || !v || typeof v !== 'object') continue;
    // US07: an older key (a bare contract) is its instrument's now; the first (most recent) entry keeps the place.
    const key = instrumentKey(k);
    if (key in out) continue;
    const e = v as { resolution?: unknown; view?: unknown };
    if (typeof e.resolution !== 'string' || !isSupportedResolution(e.resolution)) continue;
    const entry: SymbolMemoryEntry = { resolution: e.resolution };
    const view = e.view as Partial<ChartViewState> | undefined;
    if (
      view &&
      Number.isFinite(view.barSpacing) &&
      Number.isFinite(view.rightOffset) &&
      Array.isArray(view.paneHeights)
    )
      entry.view = {
        barSpacing: view.barSpacing!,
        rightOffset: view.rightOffset!,
        paneHeights: view.paneHeights.filter((h) => Number.isFinite(h)),
      };
    out[key] = entry;
  }
  return out;
}
