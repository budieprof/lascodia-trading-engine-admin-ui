import { HttpClient, HttpContext } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, catchError, forkJoin, map, of, shareReplay } from 'rxjs';

import { SUPPRESS_ERROR_TOAST } from '@core/api/api.service';
import type { ApiReference } from './api-reference.types';
import { DOC_GUIDES } from './docs-catalog';

/** Where the guides live in a release (served by the console's static file server, not the engine). */
export const DOCS_CONTENT_PATH = 'docs-content';

/**
 * Loads the documentation portal's static content (the console's own files, same origin as the
 * console — never the engine). Guides and the API reference are cached for the session.
 */
@Injectable({ providedIn: 'root' })
export class DocsContentService {
  private readonly http = inject(HttpClient);
  private reference$: Observable<ApiReference> | null = null;
  private all$: Observable<ReadonlyMap<string, string>> | null = null;
  private readonly guides = new Map<string, Observable<string>>();

  private readonly context = new HttpContext().set(SUPPRESS_ERROR_TOAST, true);

  guide(slug: string): Observable<string> {
    let g = this.guides.get(slug);
    if (!g) {
      g = this.http
        .get(`${DOCS_CONTENT_PATH}/${encodeURIComponent(slug)}.md`, {
          responseType: 'text',
          context: this.context,
        })
        .pipe(shareReplay({ bufferSize: 1, refCount: false }));
      this.guides.set(slug, g);
    }
    return g;
  }

  /** Every guide's Markdown by slug (for search and reading times); a guide that fails is left out. */
  allGuides(): Observable<ReadonlyMap<string, string>> {
    this.all$ ??= forkJoin(
      DOC_GUIDES.map((g) =>
        this.guide(g.slug).pipe(
          map((md) => [g.slug, md] as const),
          catchError(() => of(null)),
        ),
      ),
    ).pipe(
      map((pairs) => new Map(pairs.filter((p) => p !== null))),
      shareReplay({ bufferSize: 1, refCount: false }),
    );
    return this.all$;
  }

  apiReference(): Observable<ApiReference> {
    this.reference$ ??= this.http
      .get<ApiReference>(`${DOCS_CONTENT_PATH}/api-reference.json`, { context: this.context })
      .pipe(shareReplay({ bufferSize: 1, refCount: false }));
    return this.reference$;
  }
}
