import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { ApiService } from '@core/api/api.service';
import { ResponseData } from '@core/api/api.types';
import {
  DEFAULT_PATIENT_TRADER_CONFIG,
  PatientTraderBoard,
  PatientTraderBoardQuery,
  PatientTraderConfig,
  PatientTraderHealth,
  PatientTraderResults,
  PatientTraderViewHistory,
} from '@features/patient-trader/patient-trader.types';
import { boardQueryString } from '@features/patient-trader/patient-trader.logic';

/**
 * Outcome of a config save.
 *
 *  - `saved`: `config` is the PERSISTED state, not what was requested — a change the engine's
 *    governance queued for cooling-off reports its current, unchanged reading.
 *  - `conflict`: someone saved since this page loaded (engine code -409). Nothing was written;
 *    `config` is the CURRENT configuration so the page can offer to reload it.
 *  - `refused`: validation or any other non-success. Nothing was written.
 */
export type PatientTraderSaveResult =
  | { kind: 'saved'; config: PatientTraderConfig; message: string | null }
  | { kind: 'conflict'; config: PatientTraderConfig | null; message: string }
  | { kind: 'refused'; message: string };

const withDefaults = (c: Partial<PatientTraderConfig>): PatientTraderConfig => ({
  ...DEFAULT_PATIENT_TRADER_CONFIG,
  ...c,
});

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
      .pipe(map(withDefaults));
  }

  /**
   * Persists the whole configuration, `version` included (the engine refuses a save edited from an
   * older read).
   *
   * The raw envelope is kept rather than unwrapped, because a governance verdict arrives in
   * `message` on a successful response, and a conflict carries the current config in `data` on a
   * failed one — unwrapping would discard both.
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
      .pipe(map((res) => toSaveResult(res)));
  }

  /** Views, plans (filtered and paged) and the counters over the last `windowDays`. */
  getBoard(query: PatientTraderBoardQuery): Observable<PatientTraderBoard> {
    return this.api.getEnvelope<PatientTraderBoard>(
      `/market-data/patient-trader/board?${boardQueryString(query)}`,
    );
  }

  /** Is it working: per-market last look / next look / stuck runs, spend, kill switch, limits. */
  getHealth(): Observable<PatientTraderHealth> {
    return this.api.getEnvelope<PatientTraderHealth>('/market-data/patient-trader/health');
  }

  /** Measured results over the last `days`, optionally for one market. */
  getResults(days: number, symbol?: string | null): Observable<PatientTraderResults> {
    const p = new URLSearchParams({ days: String(days) });
    if (symbol) p.set('symbol', symbol);
    return this.api.getEnvelope<PatientTraderResults>(
      `/market-data/patient-trader/results?${p.toString()}`,
    );
  }

  /** Past views with how each was scored, newest first. */
  getViewHistory(opts: {
    symbol?: string | null;
    lean?: string | null;
    limit?: number;
    offset?: number;
  }): Observable<PatientTraderViewHistory> {
    const p = new URLSearchParams({
      limit: String(opts.limit ?? 50),
      offset: String(opts.offset ?? 0),
    });
    if (opts.symbol) p.set('symbol', opts.symbol);
    if (opts.lean) p.set('lean', opts.lean);
    return this.api.getEnvelope<PatientTraderViewHistory>(
      `/market-data/patient-trader/views?${p.toString()}`,
    );
  }
}

/** Maps the PUT envelope onto a save result. Exported for tests. */
export function toSaveResult(
  res: ResponseData<PatientTraderConfig> | null | undefined,
): PatientTraderSaveResult {
  if (res?.status && res.data) {
    return { kind: 'saved', config: withDefaults(res.data), message: res.message ?? null };
  }
  const code = String(res?.responseCode ?? '');
  if (code === '-409' || code === '409') {
    return {
      kind: 'conflict',
      config: res?.data ? withDefaults(res.data) : null,
      message:
        res?.message ??
        'Someone changed the configuration since this page loaded it. Nothing was saved.',
    };
  }
  return {
    kind: 'refused',
    message: res?.message ?? 'Save failed — the configuration was not changed.',
  };
}
