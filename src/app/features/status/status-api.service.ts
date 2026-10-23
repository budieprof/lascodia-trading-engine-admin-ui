import { HttpBackend, HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';

import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import { parseDocument } from './status.logic';
import type { PublicStatusDocument } from './status.types';

/**
 * Reads the engine's public status document (`GET /health/status`, at the server root like the other health
 * endpoints — Caddy forwards `/health*` to the engine). Uses a client WITHOUT the console's interceptors: the page is
 * public, so it must not attach a session, trigger a sign-in redirect or raise the console's error toasts.
 */
@Injectable({ providedIn: 'root' })
export class StatusApiService {
  private readonly http = new HttpClient(inject(HttpBackend));
  private readonly url = `${inject(RUNTIME_CONFIG).apiBaseUrl}/health/status`;

  /** The document, or an error when the engine cannot be reached or answers something that is not one. */
  status(): Observable<PublicStatusDocument> {
    return this.http.get<unknown>(this.url).pipe(
      map((body) => {
        const doc = parseDocument(body);
        if (!doc) throw new Error('The status document is malformed.');
        return doc;
      }),
    );
  }
}
