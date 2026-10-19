import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { ApiService } from '@core/api/api.service';
import type { LlmConfigUpdateEntry, ResponseData } from '@core/api/api.types';

/**
 * Body of `PUT /llm/settings` (engine `UpdateLlmSettingsCommand`, 2026-10-19).
 *
 * Until then the endpoint wrote every entry straight to EngineConfig, so the settings page was a
 * way around the cooling-off rule. Now an entry the engine's RiskSensitiveConfigCatalog classes as
 * risk-LOOSENING goes through the governed `PUT config` path: without a `reason` the whole save is
 * refused (-11, nothing written); with one it is held for the cooling-off period unless
 * `immediate` (break-glass) is set.
 */
export interface LlmSettingsSaveRequest {
  entries: LlmConfigUpdateEntry[];
  /** Recorded on every audit row of the save. REQUIRED when any entry is loosening, and for `immediate`. */
  reason?: string;
  /** Break-glass: apply this save's loosening entries now instead of holding them. Needs `reason`. */
  immediate?: boolean;
}

/**
 * Sends the governed save. Lives in the feature until `LlmService.updateSettings` takes the
 * reason/immediate fields (G4 shared-component need) — that method still sends `{ entries }` only.
 */
@Injectable({ providedIn: 'root' })
export class LlmSettingsSaveService {
  private readonly api = inject(ApiService);

  save(body: LlmSettingsSaveRequest): Observable<ResponseData<number>> {
    return this.api.put<ResponseData<number>>('/llm/settings', body);
  }
}

/** What a save actually did, read from the envelope (`data` = rows written now). */
export interface LlmSaveOutcome {
  /** Envelope status. False = refused outright, or a loosening entry failed on the governed path. */
  ok: boolean;
  /** Settings written now (direct writes + loosening entries applied by break-glass). */
  applied: number;
  /** Loosening entries held for the cooling-off period. */
  held: number;
  /** Loosening entries the governed path refused. */
  failed: number;
  /** Refused because a loosening change carried no reason — nothing was saved. */
  needsReason: boolean;
  message: string;
}

/**
 * The engine reports held / failed loosening entries only in prose
 * ("Updated 2 setting(s). 1 risk-loosening change(s) held for cooling-off — …"), so the counts are
 * read from it; `data` is the applied count on every path.
 */
export function readLlmSaveOutcome(res: ResponseData<number> | null | undefined): LlmSaveOutcome {
  const message = res?.message?.trim() || (res?.status ? 'Saved.' : 'The engine refused the save.');
  const count = (re: RegExp): number => {
    const m = re.exec(message);
    return m ? Number(m[1]) : 0;
  };
  return {
    ok: !!res?.status,
    applied: res?.data ?? 0,
    held: count(/(\d+) risk-loosening change\(s\) held/i),
    failed: count(/(\d+) risk-loosening change\(s\) failed/i),
    needsReason: !res?.status && /need a reason|reason is required/i.test(message),
    message,
  };
}

/**
 * Mirrors the engine's RiskSensitiveConfigCatalog for the keys this page edits (`Llm:*`,
 * `LlmStrategyProposal:*`): a lower high-confidence bypass threshold (or 0) lets more signals skip
 * the full analysis path, and a shorter `*Cooldown*` shortens a pause. The engine re-classifies
 * on save and is the authority — a refusal naming a key this misses still asks for a reason.
 */
export function isLlmRiskLoosening(key: string, from: string, to: string): boolean {
  const k = key.toLowerCase();
  if (from.trim().toLowerCase() === to.trim().toLowerCase()) return false;
  const a = Number(from);
  const b = Number(to);
  if (from.trim() === '' || to.trim() === '' || !Number.isFinite(a) || !Number.isFinite(b)) {
    return false;
  }
  if (k === 'llm:spotanalysishighconfidencebypassthreshold') return b < a || (b === 0 && a !== 0);
  if (k.includes('cooldown')) return b < a;
  return false;
}
