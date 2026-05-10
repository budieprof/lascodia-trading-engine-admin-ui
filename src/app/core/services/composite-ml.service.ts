import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import type {
  ActivePolicyDto,
  CompositeMLLayerHealthDto,
  PolicyLineageDto,
  PolicySnapshotDiffDto,
  ResponseData,
} from '@core/api/api.types';

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

  /**
   * GET /composite-ml/policy-lineage/{id} — ancestry walk via priorSnapshotId.
   * Engine clamps `maxDepth` to [1, 100]; default 10 is enough for ops work.
   */
  getPolicyLineage(id: number, maxDepth = 10): Observable<ResponseData<PolicyLineageDto>> {
    return this.api.get<ResponseData<PolicyLineageDto>>(
      `/composite-ml/policy-lineage/${id}?maxDepth=${maxDepth}`,
    );
  }

  /**
   * GET /composite-ml/policy-snapshots/diff — per-knob diff between two
   * snapshots. `from` is typically the prior Active that got rolled back to,
   * `to` is the current Active (or vice versa for "what would I be undoing").
   */
  diffPolicySnapshots(
    fromId: number,
    toId: number,
  ): Observable<ResponseData<PolicySnapshotDiffDto>> {
    return this.api.get<ResponseData<PolicySnapshotDiffDto>>(
      `/composite-ml/policy-snapshots/diff?fromId=${fromId}&toId=${toId}`,
    );
  }
}
