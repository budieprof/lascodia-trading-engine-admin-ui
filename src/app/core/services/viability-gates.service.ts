import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import {
  UpdateViabilityGateRequest,
  ViabilityGatesList,
} from '@features/viability-gates/viability-gates.types';

/**
 * Data access for the Viability Gates cockpit.  Lists every gate with its
 * current mode + thresholds + trailing-24h firing/ghost stats, and updates
 * a single gate's mode and/or threshold knobs.  All endpoints sit under
 * `/viability-gates` and require the `Operator` permission server-side.
 */
@Injectable({ providedIn: 'root' })
export class ViabilityGatesService {
  private readonly api = inject(ApiService);

  /** Snapshot of every gate (mode + thresholds + 24h stats). */
  list(): Observable<ViabilityGatesList> {
    return this.api.getEnvelope<ViabilityGatesList>('/viability-gates');
  }

  /**
   * Update a single gate.  `body.mode` and `body.thresholds` are both
   * optional — supply only what you want to change.  Returns the number of
   * EngineConfig rows the backend wrote.
   */
  update(gateName: string, body: UpdateViabilityGateRequest): Observable<number> {
    return this.api.putEnvelope<number>(`/viability-gates/${encodeURIComponent(gateName)}`, body);
  }

  /**
   * Trigger an on-demand ghost-outcome resolution cycle on the engine.
   * Returns the number of signals the cycle resolved.  Useful after a
   * gate-config tweak — refreshes the per-gate ghost stats immediately
   * instead of waiting for the worker's 5-minute poll.
   */
  runGhostOutcomeCycle(): Observable<number> {
    return this.api.postEnvelope<number>('/viability-gates/ghost-outcome/run');
  }
}
