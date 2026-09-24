import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type { PineCatalog, ScriptLibraryDto } from '@core/api/scripting.types';
import { ScriptingService } from '@core/services/scripting.service';
import { readCachedCatalog, writeCachedCatalog } from './catalog-cache';

export type CatalogStatus = 'idle' | 'loading' | 'ready' | 'offline';

/**
 * The language catalog and the importable libraries, shared by every editor on the page.
 *
 * The catalog loads once per session: the cached copy (IndexedDB) first, so completion works
 * immediately, then a revalidation against the engine with the cached `version` — a 304 keeps
 * the cache. When the engine is unreachable the editors run on the bundled name list.
 */
@Injectable({ providedIn: 'root' })
export class PineCatalogService {
  private readonly scripting = inject(ScriptingService);

  readonly catalog = signal<PineCatalog | null>(null);
  readonly status = signal<CatalogStatus>('idle');
  readonly libraries = signal<readonly ScriptLibraryDto[]>([]);

  private catalogLoad: Promise<void> | null = null;
  private lastCatalogAttempt = 0;
  private librariesLoaded = false;
  private librariesLoad: Promise<void> | null = null;

  /** Starts loading the catalog if nothing has been loaded (retries at most once a minute). */
  ensureLoaded(): void {
    if (this.status() === 'ready' || this.catalogLoad) return;
    if (this.status() === 'offline' && Date.now() - this.lastCatalogAttempt < 60_000) return;
    this.lastCatalogAttempt = Date.now();
    this.status.set('loading');
    this.catalogLoad = this.loadCatalog().finally(() => (this.catalogLoad = null));
  }

  private async loadCatalog(): Promise<void> {
    let cached = this.catalog();
    if (!cached) {
      cached = await readCachedCatalog();
      if (cached && !this.catalog()) this.catalog.set(cached);
    }
    try {
      const fresh = await firstValueFrom(this.scripting.getCatalog(cached?.version ?? null));
      if (fresh) {
        this.catalog.set(fresh);
        void writeCachedCatalog(fresh);
      }
      this.status.set('ready');
    } catch {
      this.status.set(this.catalog() ? 'ready' : 'offline');
    }
  }

  /** Loads the library list once (for `import` completion and export docs). */
  ensureLibraries(): void {
    if (this.librariesLoaded || this.librariesLoad) return;
    this.librariesLoad = this.refreshLibraries().finally(() => (this.librariesLoad = null));
  }

  /** Re-reads the library list — after a library is published or deleted. */
  async refreshLibraries(): Promise<void> {
    try {
      const list = await firstValueFrom(this.scripting.listLibraries());
      this.libraries.set(list);
      this.librariesLoaded = true;
    } catch {
      /* completion simply has no library names */
    }
  }
}
