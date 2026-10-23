import { HttpClient, HttpContext } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, shareReplay } from 'rxjs';

import { SUPPRESS_ERROR_TOAST } from '@core/api/api.service';
import type { ApiReference } from './api-reference.types';

/** Where the guides live in a release (served by the console's static file server, not the engine). */
export const DOCS_CONTENT_PATH = 'docs-content';

/**
 * Loads the documentation portal's static content (the console's own files, same origin as the
 * console — never the engine). The API reference is cached for the session.
 */
@Injectable({ providedIn: 'root' })
export class DocsContentService {
  private readonly http = inject(HttpClient);
  private reference$: Observable<ApiReference> | null = null;

  private readonly context = new HttpContext().set(SUPPRESS_ERROR_TOAST, true);

  guide(slug: string): Observable<string> {
    return this.http.get(`${DOCS_CONTENT_PATH}/${encodeURIComponent(slug)}.md`, {
      responseType: 'text',
      context: this.context,
    });
  }

  apiReference(): Observable<ApiReference> {
    this.reference$ ??= this.http
      .get<ApiReference>(`${DOCS_CONTENT_PATH}/api-reference.json`, { context: this.context })
      .pipe(shareReplay({ bufferSize: 1, refCount: false }));
    return this.reference$;
  }
}
