import { Injectable, inject } from '@angular/core';

import { MarketDataApiService } from './marketdata-api.service';
import { futuresSymbolOf, mapFrame, type SpotMapping } from './cme-spot';
import type { CmeBasis, MdFrame, MdSource, MdSourceSymbol } from './marketdata.types';

/** How often the live basis of a (symbol, futures source) pair is re-read while its frames arrive. */
export const BASIS_REFRESH_MS = 60_000;
/** A pair whose frames stopped this long ago stops being polled. */
const BASIS_IDLE_MS = 5 * 60_000;

/** What the chart knows about one futures source on one spot symbol. */
export interface FuturesSpotState {
  spec: MdSourceSymbol;
  basis: CmeBasis | null;
  /** The mapping the live frames get now. */
  mapping: SpotMapping;
}

/**
 * Live CME hub frames onto the spot chart (cme-tier2): every `md` frame of a CME source is mapped (inversion + side
 * swap for 6J/6C/6S, minus the live basis) BEFORE the stream core applies it, so books, rings, heatmaps and the depth
 * panel all hold spot-terms data — the same terms `md/history` answers in (`spot: true`). Broker / venue frames pass
 * through untouched.
 * - Until `md/sources` has answered, a CME frame is dropped (its book repairs from history / the next keyframe); a frame
 *   of an unknown or non-futures source passes.
 * - The basis comes from `GET md/basis` (re-read every {@link BASIS_REFRESH_MS} while frames arrive). Before the first
 *   answer, or while the engine has no estimate, frames are transformed but not basis-adjusted and
 *   {@link stateOf} says so (legends show it).
 * Runs outside Angular (called from the hub callbacks); no signals change per frame.
 */
@Injectable({ providedIn: 'root' })
export class CmeSpotService {
  private readonly api = inject(MarketDataApiService);
  private sources: MdSource[] | null = null;
  private sourcesAsked = false;
  private readonly pairs = new Map<string, FuturesSpotState & { lastFrame: number; lastRead: number; reading: boolean }>();

  /** The stream core's `mapFrame`: mapped frame, the frame itself, or null (drop: futures source not resolved yet). */
  mapFrame(f: MdFrame): MdFrame | null {
    if (!f.sourceId.startsWith('cme-')) {
      // Registry convention (engine ConfigMarketDataSourceRegistry / seeds): futures sources are cme-*; everything else
      // passes without a lookup on the hot path.
      return f;
    }
    if (this.sources === null) {
      this.loadSources();
      return null;
    }
    const key = `${f.symbol.toUpperCase()}|${f.sourceId}`;
    let pair = this.pairs.get(key);
    if (!pair) {
      const spec = futuresSymbolOf(this.sources.find((s) => s.sourceId === f.sourceId), f.symbol);
      if (!spec) return f;
      pair = {
        spec,
        basis: null,
        mapping: { inverted: spec.priceTransform === 'Invert', basis: null },
        lastFrame: 0,
        lastRead: 0,
        reading: false,
      };
      this.pairs.set(key, pair);
    }
    const now = Date.now();
    pair.lastFrame = now;
    if (!pair.reading && now - pair.lastRead >= BASIS_REFRESH_MS) this.readBasis(f.symbol.toUpperCase(), f.sourceId, pair);
    return mapFrame(f, pair.mapping);
  }

  /** What the chart should say about a futures source on a symbol (null: not a futures source / not seen yet). */
  stateOf(symbol: string, sourceId: string): FuturesSpotState | null {
    const p = this.pairs.get(`${symbol.toUpperCase()}|${sourceId}`);
    return p ? { spec: p.spec, basis: p.basis, mapping: p.mapping } : null;
  }

  /** Feed the registry answer (the order-flow page already reads it). */
  setSources(list: MdSource[]): void {
    this.sources = list;
  }

  private loadSources(): void {
    if (this.sourcesAsked) return;
    this.sourcesAsked = true;
    this.api.sources().then(
      (list) => (this.sources = list),
      () => {
        this.sourcesAsked = false;
      },
    );
  }

  private readBasis(symbol: string, sourceId: string, pair: { basis: CmeBasis | null; mapping: SpotMapping; lastRead: number; reading: boolean; lastFrame: number }): void {
    pair.reading = true;
    pair.lastRead = Date.now();
    this.api.basis(symbol, sourceId).then(
      (b) => {
        pair.basis = b;
        const v = b.latest?.rolling ?? null;
        // A stale estimate is still the best offset there is; the legend says it is stale.
        pair.mapping = { inverted: pair.mapping.inverted, basis: v };
      },
      () => undefined,
    ).finally(() => {
      pair.reading = false;
      if (Date.now() - pair.lastFrame > BASIS_IDLE_MS) pair.lastRead = 0;
    });
  }
}
