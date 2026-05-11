import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import type {
  AutoApplyConfigDto,
  AutoTuneProposalDto,
  AutoTuneProposalStatus,
  ResponseData,
  UpsertAutoApplyConfigRequest,
} from '@core/api/api.types';

/**
 * Operator surface for the auto-tune workflow (PRD §5.4). The
 * CompositeMLAutoTuningWorker emits proposals from soak data; this
 * service exposes the operator review-and-apply/reject endpoints + the
 * per-knob auto-apply config CRUD that gates which proposals can flow
 * autonomously vs require review.
 */
@Injectable({ providedIn: 'root' })
export class AutoTuneService {
  private readonly api = inject(ApiService);

  /** GET /auto-tune/proposals — defaults to Pending so the bare endpoint = "what's awaiting me". */
  listProposals(
    opts: {
      status?: AutoTuneProposalStatus | null;
      proposalKey?: string | null;
      limit?: number;
    } = {},
  ): Observable<ResponseData<AutoTuneProposalDto[]>> {
    const params = new URLSearchParams();
    if (opts.status) params.set('status', opts.status);
    if (opts.proposalKey) params.set('proposalKey', opts.proposalKey);
    if (opts.limit !== undefined) params.set('limit', String(opts.limit));
    const qs = params.toString();
    return this.api.get(`/auto-tune/proposals${qs ? '?' + qs : ''}`);
  }

  /** POST /auto-tune/proposals/{id}/apply — atomic EngineConfig upsert + status flip. */
  applyProposal(id: number): Observable<ResponseData<number>> {
    return this.api.post(`/auto-tune/proposals/${id}/apply`, {});
  }

  /** POST /auto-tune/proposals/{id}/reject — flip to Rejected with optional rationale (≤200 chars). */
  rejectProposal(id: number, reason?: string | null): Observable<ResponseData<number>> {
    return this.api.post(`/auto-tune/proposals/${id}/reject`, { reason: reason ?? null });
  }

  /** GET /auto-tune/auto-apply-configs — per-knob safety-gate configs (handful of rows). */
  listAutoApplyConfigs(enabledOnly?: boolean): Observable<ResponseData<AutoApplyConfigDto[]>> {
    const qs = enabledOnly !== undefined ? `?enabledOnly=${enabledOnly}` : '';
    return this.api.get(`/auto-tune/auto-apply-configs${qs}`);
  }

  /** PUT /auto-tune/auto-apply-configs/{key} — upsert with safety gates. */
  upsertAutoApplyConfig(
    key: string,
    payload: UpsertAutoApplyConfigRequest,
  ): Observable<ResponseData<AutoApplyConfigDto>> {
    return this.api.put(`/auto-tune/auto-apply-configs/${encodeURIComponent(key)}`, payload);
  }

  /** DELETE /auto-tune/auto-apply-configs/{key} — soft delete; worker reverts to operator-review-only. */
  deleteAutoApplyConfig(key: string): Observable<ResponseData<number>> {
    return this.api.delete(`/auto-tune/auto-apply-configs/${encodeURIComponent(key)}`);
  }
}
