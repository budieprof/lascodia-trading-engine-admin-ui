import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { ApiService } from '@core/api/api.service';
import { PendingConfigChange } from './viability-gates.types';

/**
 * Read side of the engine's cooling-off queue, for the Viability Gates page.
 *
 * Loosening a gate (Enforce → Advisory / Off) with a reason but without
 * "apply immediately" is queued for 24h rather than written, so after a reload
 * the card still shows the old mode and nothing said a change was pending. The
 * page reads the queue to put each queued change on its gate's card.
 */
@Injectable({ providedIn: 'root' })
export class ViabilityGatePendingChangesService {
  private readonly api = inject(ApiService);

  /** Changes still waiting for their effective time (the endpoint's default status). */
  listPending(): Observable<PendingConfigChange[]> {
    return this.api.getEnvelope<PendingConfigChange[]>('/config/pending');
  }
}
