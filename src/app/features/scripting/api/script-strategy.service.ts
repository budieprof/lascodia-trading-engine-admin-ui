import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpContext, HttpErrorResponse, HttpResponse } from '@angular/common/http';
import { Observable, catchError, from, switchMap, throwError } from 'rxjs';

import { ApiService, SUPPRESS_ERROR_TOAST } from '@core/api/api.service';
import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import type { ResponseData } from '@core/api/api.types';

import type {
  ScreenerRequest,
  ScreenerRow,
  ScriptAlertBinding,
  ScriptBacktestRequest,
  ScriptLiveStatus,
} from './scripting-api.types';
import { describeFailure } from '../shared/api-error';
import { fileNameFromContentDisposition } from '../shared/download';

export type BacktestExportFormat = 'csv' | 'xlsx';

export interface DownloadedFile {
  fileName: string;
  blob: Blob;
}

/**
 * Script-strategy endpoints (ADR-0027 scripting API): screener, live status, alert bindings,
 * script backtests and the backtest report export. Compile, run and the libraries go through
 * `ScriptingService` (`@core/services/scripting.service`), the one client for those endpoints.
 *
 * Every call is `silent` — the pages render their own inline error for a refusal, so the global
 * interceptor does not stack a toast on top of it.
 */
@Injectable({ providedIn: 'root' })
export class ScriptStrategyService {
  private readonly api = inject(ApiService);
  private readonly http = inject(HttpClient);
  private readonly baseUrl = `${inject(RUNTIME_CONFIG).apiBaseUrl}/api/v1/lascodia-trading-engine`;

  /** §6 — one row per symbol with the script's screener plots and fired alerts. */
  runScreener(req: ScreenerRequest): Observable<ResponseData<ScreenerRow[]>> {
    return this.api.post('/scripting/screener', req, { silent: true });
  }

  /** §8 — the live session: status, emulator position/trades/orders, live report, divergences. */
  getLiveStatus(strategyId: number): Observable<ResponseData<ScriptLiveStatus>> {
    return this.api.get(`/strategy/${strategyId}/script/live`, { silent: true });
  }

  /** §10 — the strategy's alert bindings. */
  getAlerts(strategyId: number): Observable<ResponseData<ScriptAlertBinding[]>> {
    return this.api.get(`/strategy/${strategyId}/script/alerts`, { silent: true });
  }

  /** §10 — replaces the strategy's alert bindings. */
  saveAlerts(
    strategyId: number,
    bindings: ScriptAlertBinding[],
  ): Observable<ResponseData<unknown>> {
    return this.api.put(`/strategy/${strategyId}/script/alerts`, bindings, { silent: true });
  }

  /** §4 — queues a backtest of a script strategy; `data` is the new run id. */
  queueBacktest(req: ScriptBacktestRequest): Observable<ResponseData<number>> {
    return this.api.post('/backtest', req, { silent: true });
  }

  /**
   * §4 — `GET backtest/{id}/export?format=csv|xlsx`. The engine streams the file on success and
   * answers a missing / unfinished run with the usual JSON envelope instead, so the response is
   * read as bytes and a JSON body becomes an error carrying the engine's reason.
   */
  downloadBacktestExport(runId: number, format: BacktestExportFormat): Observable<DownloadedFile> {
    return this.http
      .get(`${this.baseUrl}/backtest/${runId}/export`, {
        params: { format },
        responseType: 'blob',
        observe: 'response',
        withCredentials: true,
        context: new HttpContext().set(SUPPRESS_ERROR_TOAST, true),
      })
      .pipe(
        catchError((err: unknown) =>
          from(failureFromBlobError(err)).pipe(switchMap((e) => throwError(() => e))),
        ),
        switchMap((res) => from(toDownloadedFile(res, runId, format))),
      );
  }
}

async function toDownloadedFile(
  res: HttpResponse<Blob>,
  runId: number,
  format: BacktestExportFormat,
): Promise<DownloadedFile> {
  const blob = res.body ?? new Blob([]);
  const type = (res.headers.get('content-type') ?? blob.type ?? '').toLowerCase();
  if (type.includes('application/json') || type.includes('text/json')) {
    const text = await readBlobText(blob);
    let reason = 'The engine did not return a file.';
    try {
      reason = describeFailure(JSON.parse(text), reason);
    } catch {
      /* not JSON after all — keep the generic reason */
    }
    throw new Error(reason);
  }
  const fileName =
    fileNameFromContentDisposition(res.headers.get('content-disposition')) ??
    `backtest-${runId}-report.${format}`;
  return { fileName, blob };
}

/** An HTTP error on a blob request carries its body as a Blob; read the engine's reason out of it. */
async function failureFromBlobError(err: unknown): Promise<Error> {
  if (err instanceof HttpErrorResponse && err.error instanceof Blob) {
    try {
      const body = JSON.parse(await readBlobText(err.error));
      return new Error(describeFailure(body, `Export failed (HTTP ${err.status}).`));
    } catch {
      return new Error(`Export failed (HTTP ${err.status}).`);
    }
  }
  return new Error(describeFailure(err, 'Export failed.'));
}

function readBlobText(blob: Blob): Promise<string> {
  if (typeof blob.text === 'function') return blob.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}
