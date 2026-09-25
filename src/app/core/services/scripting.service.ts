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
  CreateScriptLibraryRequest,
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
  ScriptPublisherDto,
  ScriptRunRequest,
  ScriptRunResult,
  StrategyExportDto,
  UpdateStrategyScriptRequest,
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
   * version 1, or the next version of that name.
   */
  createLibrary(req: CreateScriptLibraryRequest): Observable<ScriptLibraryDto> {
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

  /** `GET scripting/libraries/me` — the operator's own publisher name (their username). */
  getMyPublisher(): Observable<string | null> {
    return this.api.get<ResponseData<ScriptPublisherDto>>('/scripting/libraries/me', SILENT).pipe(
      map((res) => (res?.status && res.data?.publisher ? res.data.publisher : null)),
      catchError(() => of(null)),
    );
  }

  // ── §8 Script strategies ────────────────────────────────────────────────

  /**
   * `PUT strategy/{id}/script` — compiles, captures a strategy version and updates live sessions
   * at the next bar. A compile failure rejects with the compile response attached.
   */
  updateStrategyScript(id: number, body: UpdateStrategyScriptRequest): Observable<void> {
    return this.api.put<ResponseData<unknown>>(`/strategy/${id}/script`, body, SILENT).pipe(
      map((res) => {
        if (!res?.status) {
          throw new ScriptingApiError(
            res?.message || 'The engine did not save the script.',
            res?.responseCode ?? null,
            compileResultOf(res?.data),
          );
        }
      }),
      tap(() => this.scriptSaved.next(id)),
      catchError((err) => throwError(() => toScriptingError(err, 'Saving the script failed.'))),
    );
  }

  /** `GET strategy/{id}/export` — `.pine` for script strategies, a JSON bundle for DSL ones. */
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
