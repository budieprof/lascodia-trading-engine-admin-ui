import { Injectable, inject } from '@angular/core';
import {
  HttpClient,
  HttpContext,
  HttpErrorResponse,
  HttpHeaders,
  HttpResponse,
} from '@angular/common/http';
import { Observable, Subject, catchError, map, of, tap, throwError } from 'rxjs';

import { ApiService, SUPPRESS_ERROR_TOAST } from '@core/api/api.service';
import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import type { ResponseData } from '@core/api/api.types';
import type {
  ChartBarDto,
  ChartBarsRequest,
  ChartBarsResult,
  ChartIndicatorScriptDetailDto,
  ChartScriptVersionDetailDto,
  ChartScriptVersionDto,
  CreateChartScriptRequest,
  CreateScriptLibraryRequestV2,
  ImportStrategyRequest,
  PineCatalog,
  ScriptCompileRequest,
  ScriptCompileResult,
  ScriptDiagnosticSeverity,
  ScriptInputKind,
  ScriptKind,
  ScriptLibraryDetailDto,
  ScriptLibraryDto,
  ScriptLibraryFilter,
  ScriptLibraryUsageDto,
  StrategyTrialLedgerDto,
  ScriptLibraryVisibility,
  ScriptPublisherDto,
  ScriptRunRequest,
  ScriptRunResult,
  ScriptSessionFrame,
  StrategyExportDto,
  StrategyScriptSaveResult,
  TradingViewScriptImportDto,
  UpdateChartScriptRequest,
  UpdateStrategyScriptRequestV2,
} from '@core/api/scripting.types';

/**
 * A refused or failed scripting call.
 *
 * <p>`compile` carries the engine's full compile response when the refusal was a compile failure
 * — `-11` on create/update returns it as `data` (contract §Error codes) — so the editor can mark
 * every diagnostic, not just the first one the message names.</p>
 */
export class ScriptingApiError extends Error {
  constructor(
    message: string,
    /** Engine `responseCode` (`-11` validation, `-14` not found, `-409` conflict) when known. */
    readonly code: string | null = null,
    readonly compile: ScriptCompileResult | null = null,
    /** HTTP status; 0 when the engine could not be reached. */
    readonly httpStatus = 200,
    /**
     * A busy refusal's wait before a retry (contract C5: `data.retryAfterMs`, else the
     * `Retry-After` header); null when the engine gave none.
     */
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'ScriptingApiError';
  }

  get isConflict(): boolean {
    return this.code === '-409' || this.httpStatus === 409;
  }

  get isNotFound(): boolean {
    return this.code === '-14' || this.httpStatus === 404;
  }

  /**
   * The engine is busy and asks to retry later (contract C5: `-429` with `retryAfterMs`) — a slot,
   * the queue, a data load or the memory budget; never a fault of the script.
   */
  get isBusy(): boolean {
    return this.code === '-429' || this.httpStatus === 429;
  }
}

/** A busy refusal's `retryAfterMs` from an envelope's `data` (C5), or null. */
function retryAfterOf(data: unknown): number | null {
  const v =
    data && typeof data === 'object' ? (data as Record<string, unknown>)['retryAfterMs'] : null;
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

/** The `Retry-After` header (whole seconds) in ms, or null. */
function retryAfterHeader(err: HttpErrorResponse): number | null {
  const raw = err.headers?.get?.('Retry-After');
  const s = raw === null || raw === undefined ? NaN : Number(raw);
  return Number.isFinite(s) && s >= 0 ? s * 1000 : null;
}

/** The compile response inside an envelope's `data`, if that is what it holds. */
export function compileResultOf(data: unknown): ScriptCompileResult | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (Array.isArray(d['diagnostics'])) return d as unknown as ScriptCompileResult;
  const nested = d['compile'];
  if (nested && typeof nested === 'object' && Array.isArray((nested as any).diagnostics)) {
    return nested as ScriptCompileResult;
  }
  return null;
}

/**
 * The run a refused `scripting/run` envelope still describes: its compile response — alone as
 * `data`, or inside a partial run result, which is kept whole. Null when `data` holds neither.
 */
function refusedRun(data: unknown): ScriptRunResult | null {
  const compiled = compileResultOf(data);
  if (!compiled) return null;
  const partial = (data as Record<string, unknown>)['compile'] ? (data as object) : {};
  return { ...partial, compile: normaliseCompile(compiled) } as ScriptRunResult;
}

function envelopeData<T>(res: ResponseData<T> | null | undefined, fallback: string): T {
  if (res && res.status && res.data !== null && res.data !== undefined) return res.data;
  throw new ScriptingApiError(
    res?.message || fallback,
    res?.responseCode ?? null,
    compileResultOf(res?.data),
    200,
    retryAfterOf(res?.data),
  );
}

/** Normalises any failure of a scripting call into a {@link ScriptingApiError}. */
export function toScriptingError(err: unknown, fallback: string): ScriptingApiError {
  if (err instanceof ScriptingApiError) return err;
  if (err instanceof HttpErrorResponse) {
    const body = err.error as Partial<ResponseData<unknown>> | null;
    if (body && typeof body === 'object' && ('responseCode' in body || 'message' in body)) {
      return new ScriptingApiError(
        body.message || fallback,
        body.responseCode ?? null,
        compileResultOf(body.data),
        err.status,
        retryAfterOf(body.data) ?? retryAfterHeader(err),
      );
    }
    if (err.status === 0) {
      return new ScriptingApiError('The engine could not be reached.', null, null, 0);
    }
    return new ScriptingApiError(
      err.status === 404 ? `${fallback} (not found)` : `${fallback} (HTTP ${err.status})`,
      null,
      null,
      err.status,
      err.status === 429 ? retryAfterHeader(err) : null,
    );
  }
  if (err instanceof Error && err.message) return new ScriptingApiError(err.message);
  return new ScriptingApiError(fallback);
}

const SILENT = { silent: true } as const;

/**
 * The engine's Pine-script endpoints (ADR-0027, `docs/api/scripting-api.md`): language catalog,
 * compile, run/preview, libraries and the script-strategy endpoints.
 *
 * <p>Every call is silent — the editor and pages render their own error states, and a debounced
 * compile must never stack toasts while the operator types. Failures reject with
 * {@link ScriptingApiError}.</p>
 */
@Injectable({ providedIn: 'root' })
export class ScriptingService {
  private readonly api = inject(ApiService);
  private readonly http = inject(HttpClient);
  private readonly baseUrl = `${inject(RUNTIME_CONFIG).apiBaseUrl}/api/v1/lascodia-trading-engine`;
  private readonly scriptSaved = new Subject<number>();

  /** Ids of strategies whose script was just saved — views showing that script re-read it. */
  readonly strategyScriptSaved$ = this.scriptSaved.asObservable();

  // ── §1 Catalog ──────────────────────────────────────────────────────────

  /**
   * `GET scripting/catalog`. With the cached catalog's `version` it sends `If-None-Match`; the
   * engine answers 304 when nothing changed, which resolves to `null` ("keep the cached one").
   */
  getCatalog(knownVersion: string | null): Observable<PineCatalog | null> {
    let headers = new HttpHeaders();
    if (knownVersion) headers = headers.set('If-None-Match', knownVersion);
    return this.http
      .get<ResponseData<PineCatalog>>(`${this.baseUrl}/scripting/catalog`, {
        headers,
        observe: 'response',
        withCredentials: true,
        context: new HttpContext().set(SUPPRESS_ERROR_TOAST, true),
      })
      .pipe(
        map((res: HttpResponse<ResponseData<PineCatalog>>) =>
          res.status === 304
            ? null
            : envelopeData(res.body, 'The language catalog is unavailable.'),
        ),
        catchError((err) =>
          err instanceof HttpErrorResponse && err.status === 304
            ? of(null)
            : throwError(() => toScriptingError(err, 'The language catalog is unavailable.')),
        ),
      );
  }

  // ── §2 Compile ──────────────────────────────────────────────────────────

  /**
   * `POST scripting/compile`. A script with errors is a normal outcome, not a failure: it resolves
   * with `success: false` and the diagnostics — even when the engine wraps it in a refused
   * envelope. Only transport failures and refusals without a compile result reject.
   */
  compile(req: ScriptCompileRequest): Observable<ScriptCompileResult> {
    return this.api.post<ResponseData<ScriptCompileResult>>('/scripting/compile', req, SILENT).pipe(
      map((res) => {
        const compiled = compileResultOf(res?.data);
        if (compiled) return normaliseCompile(compiled);
        return normaliseCompile(envelopeData(res, 'The engine could not compile the script.'));
      }),
      catchError((err) => {
        const e = toScriptingError(err, 'The engine could not compile the script.');
        return e.compile ? of(normaliseCompile(e.compile)) : throwError(() => e);
      }),
    );
  }

  // ── §3 Run / preview ────────────────────────────────────────────────────

  /**
   * `POST scripting/run` — runs a script over history (preview, or a strategy's backtest report).
   * The console's one HTTP path for §3: the Pine chart's `ScriptingRunService` reshapes this
   * result instead of calling the endpoint itself.
   */
  run(req: ScriptRunRequest): Observable<ScriptRunResult> {
    return this.api.post<ResponseData<ScriptRunResult>>('/scripting/run', req, SILENT).pipe(
      map((res) => {
        if (res && !res.status) {
          // A script that does not compile comes back refused with the compile response.
          const refused = refusedRun(res.data);
          if (refused) return refused;
        }
        const run = envelopeData(res, 'The engine could not run the script.');
        return { ...run, compile: normaliseCompile(run.compile) };
      }),
      catchError((err) => {
        const e = toScriptingError(err, 'The engine could not run the script.');
        if (!e.compile) return throwError(() => e);
        const body = err instanceof HttpErrorResponse ? err.error : null;
        const refused = refusedRun(body && typeof body === 'object' ? body.data : null);
        return of(refused ?? ({ compile: normaliseCompile(e.compile) } as ScriptRunResult));
      }),
    );
  }

  /**
   * `POST scripting/chart-bars` — the bars a run computes on, for the chart to draw: the engine's
   * session grid (FX: 17:00 New York days), every bar with its own close, the period still forming
   * last when asked. Rejects with {@link ScriptingApiError} on a refusal or a transport failure.
   */
  chartBars(req: ChartBarsRequest): Observable<ChartBarsResult> {
    return this.api.post<ResponseData<ChartBarsResult>>('/scripting/chart-bars', req, SILENT).pipe(
      map((res) => normaliseChartBars(envelopeData(res, 'The engine did not return chart bars.'))),
      catchError((err) =>
        throwError(() => toScriptingError(err, 'The chart bars could not be loaded.')),
      ),
    );
  }

  // ── §7 Libraries ────────────────────────────────────────────────────────

  listLibraries(filter: ScriptLibraryFilter = {}): Observable<ScriptLibraryDto[]> {
    const params = new URLSearchParams();
    if (filter.publisher?.trim()) params.set('publisher', filter.publisher.trim());
    if (filter.name?.trim()) params.set('name', filter.name.trim());
    const qs = params.toString();
    return this.api
      .get<ResponseData<ScriptLibraryDto[]>>(`/scripting/libraries${qs ? '?' + qs : ''}`, SILENT)
      .pipe(
        map((res) => envelopeData(res, 'The libraries could not be loaded.') ?? []),
        catchError((err) =>
          throwError(() => toScriptingError(err, 'The libraries could not be loaded.')),
        ),
      );
  }

  getLibrary(id: number): Observable<ScriptLibraryDetailDto> {
    return this.api
      .get<ResponseData<ScriptLibraryDetailDto>>(`/scripting/libraries/${id}`, SILENT)
      .pipe(
        map((res) => envelopeData(res, 'The library could not be loaded.')),
        catchError((err) =>
          throwError(() => toScriptingError(err, 'The library could not be loaded.')),
        ),
      );
  }

  /**
   * `POST scripting/libraries` — compiles (the source must declare `library()`) and stores
   * version 1, or the next version of that name. With `basedOnVersion`, a newer version published
   * since rejects with `-409` (PE-I12).
   */
  createLibrary(req: CreateScriptLibraryRequestV2): Observable<ScriptLibraryDto> {
    return this.api.post<ResponseData<ScriptLibraryDto>>('/scripting/libraries', req, SILENT).pipe(
      map((res) => envelopeData(res, 'The engine did not publish the library.')),
      catchError((err) =>
        throwError(() => toScriptingError(err, 'Publishing the library failed.')),
      ),
    );
  }

  /**
   * `DELETE scripting/libraries/{id}` (soft). The engine refuses (`-409`) while a live strategy
   * imports that version; `force` deletes anyway.
   */
  deleteLibrary(id: number, force = false): Observable<void> {
    return this.api
      .delete<
        ResponseData<unknown>
      >(`/scripting/libraries/${id}${force ? '?force=true' : ''}`, SILENT)
      .pipe(
        map((res) => {
          if (res && !res.status) {
            throw new ScriptingApiError(
              res.message || 'The engine did not delete the library.',
              res.responseCode ?? null,
            );
          }
        }),
        catchError((err) =>
          throwError(() => toScriptingError(err, 'Deleting the library failed.')),
        ),
      );
  }

  /**
   * `GET scripting/libraries/{id}/usage` — what imports a version, directly or through other
   * libraries: script strategies (with whether they block a delete), chart scripts, libraries.
   */
  getLibraryUsage(id: number): Observable<ScriptLibraryUsageDto> {
    return this.api
      .get<ResponseData<ScriptLibraryUsageDto>>(`/scripting/libraries/${id}/usage`, SILENT)
      .pipe(
        map((res) => envelopeData(res, 'The library usage could not be loaded.')),
        catchError((err) =>
          throwError(() => toScriptingError(err, 'The library usage could not be loaded.')),
        ),
      );
  }

  /**
   * `GET strategy-feedback/{strategyId}/trials` — how many configurations the strategy's lineage
   * tried (PE-I1's test count; the promotion gates deflate the Sharpe by `effectiveTrials`).
   */
  getTrialLedger(strategyId: number): Observable<StrategyTrialLedgerDto> {
    return this.api
      .get<ResponseData<StrategyTrialLedgerDto>>(`/strategy-feedback/${strategyId}/trials`, SILENT)
      .pipe(
        map((res) => envelopeData(res, 'The trial count could not be loaded.')),
        catchError((err) =>
          throwError(() => toScriptingError(err, 'The trial count could not be loaded.')),
        ),
      );
  }

  /** `GET scripting/libraries/me` — the operator's own publisher name (their username). */
  getMyPublisher(): Observable<string | null> {
    return this.api.get<ResponseData<ScriptPublisherDto>>('/scripting/libraries/me', SILENT).pipe(
      map((res) => (res?.status && res.data?.publisher ? res.data.publisher : null)),
      catchError(() => of(null)),
    );
  }

  // ── §7b Chart scripts ───────────────────────────────────────────────────

  /** `GET scripting/indicators` — the operator's chart scripts and every shared one, with sources. */
  listChartScripts(): Observable<ChartIndicatorScriptDetailDto[]> {
    return this.api
      .get<ResponseData<ChartIndicatorScriptDetailDto[]>>('/scripting/indicators', SILENT)
      .pipe(
        map((res) => envelopeData(res, 'Your scripts could not be loaded.') ?? []),
        catchError((err) =>
          throwError(() => toScriptingError(err, 'Your scripts could not be loaded.')),
        ),
      );
  }

  /** `GET scripting/indicators/{id}` — one chart script as the engine has it now. */
  getChartScript(id: number): Observable<ChartIndicatorScriptDetailDto> {
    return this.api
      .get<ResponseData<ChartIndicatorScriptDetailDto>>(`/scripting/indicators/${id}`, SILENT)
      .pipe(
        map((res) => envelopeData(res, 'The script could not be loaded.')),
        catchError((err) =>
          throwError(() => toScriptingError(err, 'The script could not be loaded.')),
        ),
      );
  }

  /**
   * `POST scripting/indicators` — compiles and saves as version 1. A compile error (or a
   * `library()`) rejects with `-11` and the compile response attached; an import whose header
   * licence forbids reuse with `-11`.
   */
  createChartScript(req: CreateChartScriptRequest): Observable<ChartIndicatorScriptDetailDto> {
    return this.api
      .post<ResponseData<ChartIndicatorScriptDetailDto>>('/scripting/indicators', req, SILENT)
      .pipe(
        map((res) => envelopeData(res, 'The engine did not save the script.')),
        catchError((err) => throwError(() => toScriptingError(err, 'Saving the script failed.'))),
      );
  }

  /**
   * `PUT scripting/indicators/{id}` — replaces name, source and inputs (recompiled) and records
   * the next version. With `expectedRevision`, a script changed since rejects with `-409`
   * (`ScriptingApiError.isConflict`) — contract C4.
   */
  updateChartScript(
    id: number,
    req: UpdateChartScriptRequest,
  ): Observable<ChartIndicatorScriptDetailDto> {
    return this.api
      .put<ResponseData<ChartIndicatorScriptDetailDto>>(`/scripting/indicators/${id}`, req, SILENT)
      .pipe(
        map((res) => envelopeData(res, 'The engine did not save the script.')),
        catchError((err) => throwError(() => toScriptingError(err, 'Saving the script failed.'))),
      );
  }

  /** `PUT scripting/indicators/{id}/visibility` — share with every operator, or make private. */
  setChartScriptVisibility(
    id: number,
    visibility: ScriptLibraryVisibility,
  ): Observable<ChartIndicatorScriptDetailDto> {
    return this.api
      .put<
        ResponseData<ChartIndicatorScriptDetailDto>
      >(`/scripting/indicators/${id}/visibility`, { visibility }, SILENT)
      .pipe(
        map((res) => envelopeData(res, 'The engine did not change who can see the script.')),
        catchError((err) =>
          throwError(() => toScriptingError(err, 'Changing who can see the script failed.')),
        ),
      );
  }

  /** `GET scripting/indicators/{id}/versions` — newest first, without sources. */
  listChartScriptVersions(id: number, limit = 100): Observable<ChartScriptVersionDto[]> {
    return this.api
      .get<
        ResponseData<ChartScriptVersionDto[]>
      >(`/scripting/indicators/${id}/versions?limit=${limit}`, SILENT)
      .pipe(
        map((res) => envelopeData(res, 'The version history could not be loaded.') ?? []),
        catchError((err) =>
          throwError(() => toScriptingError(err, 'The version history could not be loaded.')),
        ),
      );
  }

  /** `GET scripting/indicators/{id}/versions/{versionId}` — one version with its source. */
  getChartScriptVersion(id: number, versionId: number): Observable<ChartScriptVersionDetailDto> {
    return this.api
      .get<
        ResponseData<ChartScriptVersionDetailDto>
      >(`/scripting/indicators/${id}/versions/${versionId}`, SILENT)
      .pipe(
        map((res) => envelopeData(res, 'The version could not be loaded.')),
        catchError((err) =>
          throwError(() => toScriptingError(err, 'The version could not be loaded.')),
        ),
      );
  }

  /**
   * `POST scripting/indicators/{id}/versions/{versionId}/restore` — the version becomes the
   * current state, saved as the next version. A stale `expectedRevision` rejects with `-409`; a
   * version that no longer compiles with `-11`.
   */
  restoreChartScriptVersion(
    id: number,
    versionId: number,
    expectedRevision: string | null,
  ): Observable<ChartIndicatorScriptDetailDto> {
    return this.api
      .post<
        ResponseData<ChartIndicatorScriptDetailDto>
      >(`/scripting/indicators/${id}/versions/${versionId}/restore`, { expectedRevision }, SILENT)
      .pipe(
        map((res) => envelopeData(res, 'The engine did not restore the version.')),
        catchError((err) =>
          throwError(() => toScriptingError(err, 'Restoring the version failed.')),
        ),
      );
  }

  /**
   * `POST scripting/indicators/import/tradingview` — fetches an open-source TradingView script
   * (page URL or `PUB;…` id) to open as an unsaved draft. Nothing is stored.
   */
  importTradingViewScript(url: string): Observable<TradingViewScriptImportDto> {
    return this.api
      .post<
        ResponseData<TradingViewScriptImportDto>
      >('/scripting/indicators/import/tradingview', { url }, SILENT)
      .pipe(
        map((res) => envelopeData(res, 'TradingView did not return the script.')),
        catchError((err) =>
          throwError(() => toScriptingError(err, 'Importing from TradingView failed.')),
        ),
      );
  }

  // ── §3c Warm chart sessions (SS-I2/SS-I3) ───────────────────────────────

  /**
   * `GET scripting/sessions/{id}/frame?sinceSeq=` — everything a warm chart session changed since frame `sinceSeq` (a
   * subscriber that missed frames, or reconnected). Rejects with {@link ScriptingApiError}: `-14` when the session ended
   * (run the script again), `-429` while it is busy.
   */
  sessionFrame(sessionId: string, sinceSeq: number): Observable<ScriptSessionFrame> {
    const path = `/scripting/sessions/${encodeURIComponent(sessionId)}/frame?sinceSeq=${Math.max(0, Math.trunc(sinceSeq))}`;
    return this.api.get<ResponseData<ScriptSessionFrame>>(path, SILENT).pipe(
      map((res) => envelopeData(res, 'The chart session could not be read.')),
      catchError((err) => throwError(() => toScriptingError(err, 'The chart session could not be read.'))),
    );
  }

  /** `DELETE scripting/sessions/{id}` — the chart let go of a warm session (best effort: it also expires on its own). */
  endSession(sessionId: string): Observable<void> {
    return this.api
      .delete<ResponseData<boolean>>(`/scripting/sessions/${encodeURIComponent(sessionId)}`, SILENT)
      .pipe(
        map(() => undefined),
        catchError(() => of(undefined)),
      );
  }

  /** `DELETE scripting/indicators/{id}` (soft). */
  deleteChartScript(id: number): Observable<void> {
    return this.api.delete<ResponseData<unknown>>(`/scripting/indicators/${id}`, SILENT).pipe(
      map((res) => {
        if (res && !res.status) {
          throw new ScriptingApiError(
            res.message || 'The engine did not delete the script.',
            res.responseCode ?? null,
          );
        }
      }),
      catchError((err) => throwError(() => toScriptingError(err, 'Deleting the script failed.'))),
    );
  }

  // ── §8 Script strategies ────────────────────────────────────────────────

  /**
   * `PUT strategy/{id}/script` — compiles, captures a strategy version and updates live sessions
   * at the next bar. A compile failure rejects with the compile response attached; a save made on
   * a stale `expectedScriptRevision` rejects with `-409` (`isConflict`). Resolves with the saved
   * script's revision (the next save's `expectedScriptRevision`).
   */
  updateStrategyScript(
    id: number,
    body: UpdateStrategyScriptRequestV2,
  ): Observable<StrategyScriptSaveResult> {
    return this.api
      .put<
        ResponseData<{ scriptRevision?: string | null } | null>
      >(`/strategy/${id}/script`, body, SILENT)
      .pipe(
        map((res) => {
          if (!res?.status) {
            throw new ScriptingApiError(
              res?.message || 'The engine did not save the script.',
              res?.responseCode ?? null,
              compileResultOf(res?.data),
            );
          }
          const message = res.message || 'Saved';
          return {
            scriptRevision: res.data?.scriptRevision ?? null,
            message,
            unchanged: message === 'Unchanged',
          };
        }),
        tap(() => this.scriptSaved.next(id)),
        catchError((err) => throwError(() => toScriptingError(err, 'Saving the script failed.'))),
      );
  }

  /** `GET strategy/{id}/export` — `.pine` for script strategies, a JSON bundle for legacy DSL rows. */
  exportStrategy(id: number): Observable<StrategyExportDto> {
    return this.api.get<ResponseData<StrategyExportDto>>(`/strategy/${id}/export`, SILENT).pipe(
      map((res) => envelopeData(res, 'The engine did not export the strategy.')),
      catchError((err) => throwError(() => toScriptingError(err, 'Exporting failed.'))),
    );
  }

  /** `POST strategy/import` — creates a strategy from a `.pine` file; resolves to its id. */
  importStrategy(body: ImportStrategyRequest): Observable<number> {
    return this.api.post<ResponseData<number>>('/strategy/import', body, SILENT).pipe(
      map((res) => envelopeData(res, 'The engine did not import the script.')),
      catchError((err) => throwError(() => toScriptingError(err, 'Importing failed.'))),
    );
  }
}

const INPUT_KINDS: Record<string, ScriptInputKind> = {
  int: 'int',
  integer: 'int',
  float: 'float',
  bool: 'bool',
  string: 'string',
  textarea: 'textArea',
  text_area: 'textArea',
  symbol: 'symbol',
  timeframe: 'timeframe',
  session: 'session',
  source: 'source',
  color: 'color',
  time: 'time',
  price: 'price',
  enum: 'enum',
};

/** `Int` / `TextArea` / `text_area` (enum-name or Pine spellings) → the contract's `int` / `textArea`. */
export function normaliseInputKind(kind: unknown): ScriptInputKind {
  return INPUT_KINDS[String(kind ?? '').toLowerCase()] ?? 'string';
}

function normaliseSeverity(s: unknown): ScriptDiagnosticSeverity {
  const v = String(s ?? '').toLowerCase();
  return v === 'warning' || v === 'info'
    ? v
    : v === 'information' || v === 'hint'
      ? 'info'
      : 'error';
}

const finiteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * A `scripting/chart-bars` result the chart can draw as it is: bars with a non-finite time or price
 * dropped (one NaN time makes the chart library reject the whole series), ascending by open, one
 * per open (the later copy wins), a missing volume read as 0. `tc` is kept only when it is a real
 * close after the open — the bars' consumers treat a bar without one as not current.
 */
export function normaliseChartBars(r: ChartBarsResult): ChartBarsResult {
  const byOpen = new Map<number, ChartBarDto>();
  for (const b of Array.isArray(r?.bars) ? r.bars : []) {
    if (!b || ![b.t, b.o, b.h, b.l, b.c].every(finiteNumber)) continue;
    byOpen.set(b.t, {
      t: b.t,
      tc: finiteNumber(b.tc) && b.tc > b.t ? b.tc : Number.NaN,
      o: b.o,
      h: b.h,
      l: b.l,
      c: b.c,
      v: finiteNumber(b.v) ? b.v : 0,
      forming: b.forming === true,
    });
  }
  const bars = [...byOpen.values()].sort((a, b) => a.t - b.t);
  // Only the newest bar can be the period still forming.
  for (let i = 0; i < bars.length - 1; i++) bars[i].forming = false;
  return { ...r, bars };
}

/**
 * Normalises a compile response: fills the arrays a partial response may leave out and lower-cases
 * the enum spellings (`Strategy`, `Warning`, `TextArea`) a PascalCase serialiser would send.
 */
export function normaliseCompile(r: ScriptCompileResult): ScriptCompileResult {
  const diagnostics = (Array.isArray(r?.diagnostics) ? r.diagnostics : []).map((d) => ({
    ...d,
    severity: normaliseSeverity(d.severity),
  }));
  const declaration = r?.declaration
    ? { ...r.declaration, kind: String(r.declaration.kind ?? '').toLowerCase() as ScriptKind }
    : null;
  const inputs = (Array.isArray(r?.inputs) ? r.inputs : []).map((i) => ({
    ...i,
    kind: normaliseInputKind(i.kind),
  }));
  return {
    ...r,
    diagnostics,
    declaration,
    inputs,
    success:
      typeof r?.success === 'boolean'
        ? r.success
        : !diagnostics.some((d) => d.severity === 'error'),
  };
}
