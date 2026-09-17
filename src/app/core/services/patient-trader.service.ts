import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { ApiService, unwrapResponse } from '@core/api/api.service';
import { ResponseData } from '@core/api/api.types';
import {
  DEFAULT_PATIENT_TRADER_CONFIG,
  PatientTraderBoard,
  PatientTraderConfig,
} from '@features/patient-trader/patient-trader.types';

/**
 * Outcome of a config save. `config` is always the PERSISTED state, not what was requested — a
 * change the engine's governance queued for cooling-off reports its current, unchanged reading.
 */
export interface PatientTraderSaveResult {
  config: PatientTraderConfig;
  message: string | null;
}

/**
 * Data access for the Patient Trader cockpit.
 *
 * Talks to the live engine endpoints (`/market-data/patient-trader/*`) — there is no mock branch,
 * deliberately: a cockpit showing invented plans for a module whose whole purpose is an auditable
 * record of what it decided would be worse than one showing nothing.
 */
@Injectable({ providedIn: 'root' })
export class PatientTraderService {
  private readonly api = inject(ApiService);

  /**
   * Current configuration.
   *
   * Backfilled from the compiled defaults so a field the engine has not yet persisted renders with
   * a sensible value rather than blank — a blank numeric control here reads as "no limit", which
   * for the survivability floor would be actively misleading.
   */
  getConfig(): Observable<PatientTraderConfig> {
    return this.api
      .getEnvelope<PatientTraderConfig>('/market-data/patient-trader/config')
      .pipe(map((c) => ({ ...DEFAULT_PATIENT_TRADER_CONFIG, ...c })));
  }

  /**
   * Persists the whole configuration.
   *
   * The raw envelope is kept rather than unwrapped, because a governance verdict arrives in
   * `message` on a successful response and unwrapping would discard it.
   */
  saveConfig(
    config: PatientTraderConfig,
    opts?: { reason?: string },
  ): Observable<PatientTraderSaveResult> {
    const params = new URLSearchParams();
    if (opts?.reason?.trim()) params.set('reason', opts.reason.trim());
    const qs = params.toString();

    return this.api
      .put<
        ResponseData<PatientTraderConfig>
      >(`/market-data/patient-trader/config${qs ? `?${qs}` : ''}`, config)
      .pipe(
        map((res) => {
          const saved = unwrapResponse(res);
          return {
            config: { ...DEFAULT_PATIENT_TRADER_CONFIG, ...saved },
            message: res?.message ?? null,
          };
        }),
      );
  }

  /** Standing views, recent plans, and how the agent's work has been judged. */
  getBoard(limit = 25): Observable<PatientTraderBoard> {
    return this.api.getEnvelope<PatientTraderBoard>(
      `/market-data/patient-trader/board?limit=${limit}`,
    );
  }
}
