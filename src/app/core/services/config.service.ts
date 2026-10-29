import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiCallOptions, ApiService } from '@core/api/api.service';
import { ResponseData, EngineConfigDto, UpsertConfigRequest } from '@core/api/api.types';

/** `PUT /config` answer: the usual envelope (`data` = config row id, or the pending change's id)
 *  plus the engine's structured outcome. `outcome` is null when the request was refused. */
export type ConfigUpsertOutcome = 'Applied' | 'Unchanged' | 'QueuedForCoolingOff';
export type ConfigUpsertResponse = ResponseData<number> & {
  outcome?: ConfigUpsertOutcome | null;
  effectiveAt?: string | null;
  pendingChangeId?: number | null;
  breakGlass?: boolean;
};

/** True when the engine held the change for the cooling-off period instead of applying it. */
export function isQueuedForCoolingOff(res: ConfigUpsertResponse): boolean {
  return res.outcome === 'QueuedForCoolingOff' || /cooling-off/i.test(res.message ?? '');
}

/** Engine `ConfigChangeDto` (GET config/history). */
export interface ConfigChangeDto {
  key: string;
  oldValue: string | null;
  newValue: string | null;
  reason: string | null;
  changedByAccountId: number;
  changedAt: string;
}

@Injectable({ providedIn: 'root' })
export class ConfigService {
  private readonly api = inject(ApiService);

  /**
   * Upsert one EngineConfig row. The engine answers `ResponseData<long>` — an ID, not the row —
   * with three outcomes a caller must tell apart: applied (`status` true; id of the config row),
   * queued for the cooling-off period (`status` true, the message says "queued for cooling-off";
   * id of the PENDING change), and refused (`status` false with a message — e.g. a
   * risk-loosening change without a reason). HTTP 200 in all three. Since 2026-10-19 the envelope
   * also carries the outcome machine-readably (`outcome`, `effectiveAt`, `pendingChangeId`,
   * `breakGlass`) — prefer it; older engines only said it in `message`.
   */
  upsert(data: UpsertConfigRequest): Observable<ConfigUpsertResponse> {
    return this.api.put(`/config`, data);
  }

  /** One key's live row. `opts.silent` for callers that render their own (or no) failure — the
   *  approval-card preview asks for keys that may legitimately have no row yet. */
  getByKey(key: string, opts?: ApiCallOptions): Observable<ResponseData<EngineConfigDto>> {
    return this.api.get(`/config/${key}`, opts);
  }

  /** Recent changes of the settings whose key starts with `prefix` (≥ 3 chars; secrets masked), newest first. */
  getHistory(prefix: string, limit = 20): Observable<ResponseData<ConfigChangeDto[]>> {
    return this.api.get(`/config/history?prefix=${encodeURIComponent(prefix)}&limit=${limit}`, {
      silent: true,
    });
  }

  getAll(): Observable<ResponseData<EngineConfigDto[]>> {
    return this.api.get(`/config/all`);
  }
}
