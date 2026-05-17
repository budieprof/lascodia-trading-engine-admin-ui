import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import {
  ResponseData,
  PagedData,
  PagerRequest,
  LlmInvocationDto,
  LlmInvocationDetailDto,
  LlmInvocationsSummaryDto,
  LifecycleRationaleDto,
  LlmConfigEntryDto,
  LlmConfigUpdateEntry,
  LlmInvocationQueryFilter,
  LifecycleRationaleQueryFilter,
  TestLlmProviderResult,
  RationaleCoverageDto,
} from '@core/api/api.types';

/**
 * Read/write client for the engine's `/llm/*` endpoints introduced by
 * PRD-0001 (narrative LLM layer). Surfaces the invocation ledger, the
 * lifecycle-event rationale feed, and the provider settings page.
 *
 * Companion to `strategies.service.ts` whose `listLlmProposals` /
 * `promoteLlmProposal` cover the older strategy-proposal flow.
 */
@Injectable({ providedIn: 'root' })
export class LlmService {
  private readonly api = inject(ApiService);

  /** Paged ledger of every LLM API call, newest-first. */
  listInvocations(
    params: PagerRequest & { filter?: LlmInvocationQueryFilter },
  ): Observable<ResponseData<PagedData<LlmInvocationDto>>> {
    return this.api.post(`/llm/invocations/list`, params);
  }

  /**
   * Detail view of a single invocation — list metadata + full request and
   * response bodies. Backs the row-click drilldown in the ledger.
   */
  invocationDetail(id: number): Observable<ResponseData<LlmInvocationDetailDto>> {
    return this.api.get(`/llm/invocations/${id}`);
  }

  /** Rolling-window rollup (totals, by-provider, by-model, by-purpose). */
  invocationsSummary(
    windowHours = 24,
    topN = 10,
  ): Observable<ResponseData<LlmInvocationsSummaryDto>> {
    return this.api.get(`/llm/invocations/summary?windowHours=${windowHours}&topN=${topN}`);
  }

  /** Paged feed of LLM-authored lifecycle rationales. */
  listRationales(
    params: PagerRequest & { filter?: LifecycleRationaleQueryFilter },
  ): Observable<ResponseData<PagedData<LifecycleRationaleDto>>> {
    return this.api.post(`/llm/rationales/list`, params);
  }

  /**
   * Coverage matrix + window-aggregate stats — feeds the rationales page
   * header so the surface stays useful even when no rationale has fired
   * yet (catalogued event types show with zero counts).
   */
  rationalesCoverage(windowHours = 168): Observable<ResponseData<RationaleCoverageDto>> {
    return this.api.get(`/llm/rationales/coverage?windowHours=${windowHours}`);
  }

  /**
   * Rationale(s) attached to a specific lifecycle event. Returns an array
   * since the (EventType, EventId) dedup index allows soft-deleted history
   * followed by a re-issued row.
   */
  rationalesByEvent(
    eventType: string,
    eventId: number,
  ): Observable<ResponseData<LifecycleRationaleDto[]>> {
    const qs = `?eventType=${encodeURIComponent(eventType)}&eventId=${eventId}`;
    return this.api.get(`/llm/rationales/by-event${qs}`);
  }

  /** Every EngineConfig row under `Llm:` / `LlmStrategyProposal:`. */
  getSettings(): Observable<ResponseData<LlmConfigEntryDto[]>> {
    return this.api.get(`/llm/settings`);
  }

  /** Bulk-upsert. Secret-shaped entries with value `"***SET"`/`"***UNSET"` are no-ops. */
  updateSettings(entries: LlmConfigUpdateEntry[]): Observable<ResponseData<number>> {
    return this.api.put(`/llm/settings`, { entries });
  }

  /**
   * Connectivity smoke test — fires a trivial prompt at the currently
   * configured Deep + Quick clients. Each tier reports independently so a
   * misconfigured Quick provider doesn't mask a healthy Deep tier.
   * Writes a real `LlmInvocation` audit row per tier just like a
   * production call would.
   */
  testProviders(): Observable<ResponseData<TestLlmProviderResult>> {
    return this.api.post(`/llm/test`, {});
  }
}
