import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { ApiService } from '@core/api/api.service';
import type { ResponseData, WireBriefingResultDto } from '@core/api/api.types';

/** Reads Wire's surface — the market-intelligence agent over the news-intelligence store (ADR-0024). */
@Injectable({ providedIn: 'root' })
export class WireService {
  private readonly api = inject(ApiService);

  /** Ask Wire something — the engine proxies to the host Wire service, which mints the Wire
   *  conversation and works the question in the background. Returns the anchor conversation id to
   *  open; Wire's reasoning then streams onto it live. */
  askWire(instruction: string): Observable<ResponseData<WireBriefingResultDto>> {
    return this.api.post<ResponseData<WireBriefingResultDto>>('/wire/briefing', {
      instruction,
    });
  }
}
