import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import type { FutureRoll } from './futures-series';

/**
 * The rolls the engine recorded for a futures root (`GET instrument-candles/state?symbol=ROOT` → `rolls`, UD11). Cached
 * per root for the page's life (a roll is a rare, permanent event; a reload of the page reads new ones). Null when the
 * engine does not answer — the chart then says it could not read them, never "no rolls".
 */
@Injectable({ providedIn: 'root' })
export class FuturesRollsService {
  private readonly api = inject(ApiService);
  private readonly byRoot = new Map<string, Promise<FutureRoll[] | null>>();

  rolls(root: string): Promise<FutureRoll[] | null> {
    const key = root.trim().toUpperCase();
    let pending = this.byRoot.get(key);
    if (!pending) {
      pending = firstValueFrom(
        this.api.getEnvelope<{ rolls?: FutureRoll[] }>(
          `/instrument-candles/state?symbol=${encodeURIComponent(key)}`,
          { silent: true },
        ),
      )
        .then((state) => (Array.isArray(state?.rolls) ? state.rolls : []))
        .catch(() => {
          this.byRoot.delete(key);
          return null;
        });
      this.byRoot.set(key, pending);
    }
    return pending;
  }
}
