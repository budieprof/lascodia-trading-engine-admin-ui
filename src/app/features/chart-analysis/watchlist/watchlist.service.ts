import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import type { ChartWatchlist, WatchQuote, WatchlistSettings } from './watchlist.model';

/** The quote read's extras (contract C7). */
export interface QuoteOptions {
  /** The last 24 hourly closes per symbol. */
  sparkline?: boolean;
  /** ADR / ATR over the last 14 completed trading days. */
  ranges?: boolean;
}

/** A server-side hotlist kind (`market-data/watchlist-hotlist`). */
export type HotlistKind = 'gainers' | 'losers' | 'movers' | 'atr' | 'range' | 'spread';

export const HOTLISTS: ReadonlyArray<{ kind: HotlistKind; label: string }> = [
  { kind: 'gainers', label: 'Top gainers' },
  { kind: 'losers', label: 'Top losers' },
  { kind: 'movers', label: 'Biggest moves' },
  { kind: 'atr', label: 'Most volatile (ATR %)' },
  { kind: 'range', label: 'Most stretched (range % of ADR)' },
  { kind: 'spread', label: 'Widest spread' },
];

export interface HotlistItem {
  symbol: string;
  /** The ranked value, in the list's unit. */
  value: number;
  quote: WatchQuote;
}

export interface Hotlist {
  kind: HotlistKind;
  title: string;
  unit: '%' | 'pips';
  considered: number;
  asOfUtc: string;
  items: HotlistItem[];
}

/** The engine's cap on symbols per quote read (a watchlist holds at most this many). */
export const MAX_QUOTE_SYMBOLS = 400;

const SILENT = { silent: true };
const SAVE_DEBOUNCE_MS = 600;

/**
 * Engine-backed chart watchlists (`/chart-watchlist`) plus the daily-change
 * quote snapshot (`/market-data/watchlist-quotes`).
 *
 * Lists live in the engine, not the browser, so a watchlist built on one
 * machine is there on the next — the same contract as chart drawings. Edits
 * are applied locally at once and written back debounced, so dragging a row
 * or cycling a flag never waits on the network.
 */
@Injectable({ providedIn: 'root' })
export class WatchlistService {
  private readonly api = inject(ApiService);

  readonly lists = signal<ChartWatchlist[]>([]);
  readonly loaded = signal(false);
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);
  readonly active = computed(() => {
    const all = this.lists();
    return all.find((l) => l.isActive) ?? all[0] ?? null;
  });

  private saveTimers = new Map<number, ReturnType<typeof setTimeout>>();
  /** A seeded list (id 0) being created; later edits wait for its real id. */
  private creating: Promise<ChartWatchlist> | null = null;

  async load(): Promise<void> {
    try {
      const lists = await firstValueFrom(
        this.api.getEnvelope<ChartWatchlist[]>('/chart-watchlist', SILENT),
      );
      this.lists.set(lists ?? []);
      this.error.set(null);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Watchlists are unavailable.');
    } finally {
      this.loaded.set(true);
    }
  }

  /**
   * The day snapshot for up to {@link MAX_QUOTE_SYMBOLS} symbols in one request (the engine batches internally).
   * Rejects with the engine's message on failure — the panel shows it rather than an empty list (SP-10).
   */
  quotes(symbols: string[], opts: QuoteOptions = {}): Promise<WatchQuote[]> {
    if (!symbols.length) return Promise.resolve([]);
    const qs = new URLSearchParams({ symbols: symbols.slice(0, MAX_QUOTE_SYMBOLS).join(',') });
    if (opts.sparkline) qs.set('sparkline', 'true');
    if (opts.ranges) qs.set('ranges', 'true');
    return firstValueFrom(
      this.api.getEnvelope<WatchQuote[]>(`/market-data/watchlist-quotes?${qs}`, SILENT),
    ).then((q) => q ?? []);
  }

  /** A server-side hotlist over the engine's active pairs. */
  hotlist(kind: HotlistKind, take = 20): Promise<Hotlist> {
    return firstValueFrom(
      this.api.getEnvelope<Hotlist>(`/market-data/watchlist-hotlist?kind=${kind}&take=${take}`, SILENT),
    );
  }

  /** Save a list's columns / sort (SP-I6). */
  setSettings(id: number, settings: WatchlistSettings): void {
    const list = this.lists().find((l) => l.id === id);
    if (list) this.update({ ...list, settings });
  }

  /** Replace a list locally and schedule its write. */
  update(next: ChartWatchlist): void {
    this.lists.update((all) => all.map((l) => (l.id === next.id ? next : l)));
    const prev = this.saveTimers.get(next.id);
    if (prev) clearTimeout(prev);
    this.saveTimers.set(
      next.id,
      setTimeout(() => {
        this.saveTimers.delete(next.id);
        void this.persist(next.id);
      }, SAVE_DEBOUNCE_MS),
    );
  }

  /** Create a list (optionally from another's sections and settings); it becomes the chart's active list unless told not to. */
  async create(name: string, from?: ChartWatchlist, opts: { activate?: boolean } = {}): Promise<ChartWatchlist | null> {
    const body = { name, sections: from?.sections ?? [], settings: from?.settings ?? null };
    const created = await this.write(() =>
      this.api.postEnvelope<ChartWatchlist>('/chart-watchlist', body, SILENT),
    );
    if (!created) return null;
    this.lists.update((all) => [...all, created]);
    if (opts.activate !== false) await this.activate(created.id);
    return created;
  }

  async rename(id: number, name: string): Promise<void> {
    const list = this.lists().find((l) => l.id === id);
    if (list && name.trim()) this.update({ ...list, name: name.trim() });
  }

  async activate(id: number): Promise<void> {
    this.lists.update((all) => all.map((l) => ({ ...l, isActive: l.id === id })));
    if (id !== 0) this.update(this.lists().find((l) => l.id === id)!);
  }

  async remove(id: number): Promise<void> {
    if (id !== 0)
      await this.write(() => this.api.deleteEnvelope<unknown>(`/chart-watchlist/${id}`, SILENT));
    // The engine reseeds a default when the last list goes, so re-read rather than guess.
    await this.load();
  }

  /** Flush pending writes now (page leaving). */
  flush(): void {
    for (const [id, t] of this.saveTimers) {
      clearTimeout(t);
      void this.persist(id);
    }
    this.saveTimers.clear();
  }

  private async persist(id: number): Promise<void> {
    if (id === 0) {
      // The seeded default is not stored yet: the first edit creates it.
      if (!this.creating) {
        const draft = this.lists().find((l) => l.id === 0);
        if (!draft) return;
        this.creating = firstValueFrom(
          this.api.postEnvelope<ChartWatchlist>(
            '/chart-watchlist',
            { name: draft.name, sections: draft.sections, settings: draft.settings ?? null },
            SILENT,
          ),
        );
        try {
          const created = await this.creating;
          // Keep whatever the operator did meanwhile; only adopt the id.
          const latest = this.lists().find((l) => l.id === 0) ?? draft;
          this.lists.update((all) =>
            all.map((l) => (l.id === 0 ? { ...latest, id: created.id, isActive: true } : l)),
          );
          if (latest !== draft) this.update({ ...latest, id: created.id, isActive: true });
          this.error.set(null);
        } catch (err) {
          this.error.set(err instanceof Error ? err.message : 'The watchlist could not be saved.');
        } finally {
          this.creating = null;
        }
      }
      return;
    }
    const list = this.lists().find((l) => l.id === id);
    if (!list) return;
    await this.write(() =>
      this.api.putEnvelope<ChartWatchlist>(
        `/chart-watchlist/${id}`,
        {
          name: list.name,
          sections: list.sections,
          isActive: list.isActive,
          sortOrder: list.sortOrder,
          // Null leaves the stored settings alone (a list never customised).
          settings: list.settings ?? null,
        },
        SILENT,
      ),
    );
  }

  private async write<T>(call: () => import('rxjs').Observable<T>): Promise<T | null> {
    this.saving.set(true);
    try {
      const r = await firstValueFrom(call());
      this.error.set(null);
      return r;
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'The watchlist could not be saved.');
      return null;
    } finally {
      this.saving.set(false);
    }
  }
}

/** Ties a flush to a component's lifetime. */
export function flushOnDestroy(service: WatchlistService): void {
  inject(DestroyRef).onDestroy(() => service.flush());
}
