import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import type { ActivePolicyDto, CompositeMLLayerHealthDto, ResponseData } from '@core/api/api.types';

/**
 * Read endpoints for the CompositeML operator console (PRD §5.1). The
 * controller surfaces 15 endpoints total; this service wires the two that
 * Phase 1 ships (Active Policies + Layer Health) with the same envelope
 * pattern every other feature service uses. Diff / lineage / skill /
 * drift / cold-start / gate-cutover methods will land alongside their
 * pages in subsequent commits.
 */
@Injectable({ providedIn: 'root' })
export class CompositeMLService {
  private readonly api = inject(ApiService);

  /** GET /composite-ml/active-policies — ordered most-recent activation first. */
  listActivePolicies(): Observable<ResponseData<ActivePolicyDto[]>> {
    return this.api.get<ResponseData<ActivePolicyDto[]>>('/composite-ml/active-policies');
  }

  /**
   * GET /composite-ml/layer-health — per-layer rolling health over the
   * lookback window. Engine clamps `lookbackDays` to [1, 90].
   */
  getLayerHealth(lookbackDays = 7): Observable<ResponseData<CompositeMLLayerHealthDto[]>> {
    return this.api.get<ResponseData<CompositeMLLayerHealthDto[]>>(
      `/composite-ml/layer-health?lookbackDays=${lookbackDays}`,
    );
  }
}
