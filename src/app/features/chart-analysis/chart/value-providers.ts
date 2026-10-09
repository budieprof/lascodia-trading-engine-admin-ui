import type { Bar } from '../datafeed/candle-feed.service';

/**
 * The data window's sources (CC-I6). Everything the data window lists comes from a provider
 * registered here — the chart's own bar and studies as much as the scripts' plots — so nothing is
 * special-cased. Pure.
 */

/** One line of the data window: a name and a printed value. */
export interface DataWindowRow {
  label: string;
  value: string;
  color?: string;
}

/** A block of the data window: the bar, a study, a script… */
export interface DataWindowSection {
  id: string;
  title: string;
  rows: DataWindowRow[];
}

/** Where the data window reads: the bar under the crosshair (or the newest). */
export interface DataWindowContext {
  /** The bar's index on the plotted bars — its logical index on the time scale. */
  index: number;
  /** The plotted bar (time on the display clock, ms). */
  bar: Bar;
  /** Its UTC open, ms. */
  utcTime: number;
  /** The symbol's decimals. */
  precision: number;
}

/** Sections for the bar at `ctx`, or null for none there. */
export type ValueProvider = (ctx: DataWindowContext) => DataWindowSection[] | null;

export class ValueProviders {
  private readonly providers = new Map<string, ValueProvider>();

  /**
   * List `provider`'s sections under `id`, after those registered before it; registering an id again
   * replaces its provider in place. Returns the function that takes it out again (a no-op once
   * another provider took the id).
   */
  register(id: string, provider: ValueProvider): () => void {
    this.providers.set(id, provider);
    return () => {
      if (this.providers.get(id) === provider) this.providers.delete(id);
    };
  }

  /** Every provider's sections at `ctx`, in registration order; one that throws is left out. */
  collect(ctx: DataWindowContext): DataWindowSection[] {
    const out: DataWindowSection[] = [];
    for (const provider of this.providers.values()) {
      try {
        out.push(...(provider(ctx) ?? []));
      } catch {
        // One provider's failure leaves the others' values.
      }
    }
    return out;
  }
}
