import {
  HttpClient,
  HttpContext,
  HttpErrorResponse,
  HttpParams,
  type HttpResponse,
} from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, catchError, from, map, switchMap, throwError } from 'rxjs';

import { SUPPRESS_ERROR_TOAST, ApiService } from '@core/api/api.service';
import { ApiError, type ResponseData } from '@core/api/api.types';
import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import { fileNameFromContentDisposition } from '@features/scripting/shared/download';

import type {
  BestExecutionReport,
  CashFlow,
  ComplianceExportRecord,
  ComplianceFormat,
  ComplianceSection,
  ComplianceVerification,
  DownloadedFile,
  FundScope,
  PerformanceStatement,
  RecordCashFlowBody,
} from './fund.types';

/** The pages show their own errors (and the plan's upgrade notice); session handling still applies. */
const SILENT = { silent: true } as const;

type Query = Record<string, string | number | null | undefined>;

/** `?a=1&b=x` from the set values (exported for testing). */
export function fundQuery(params: Query): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === '') continue;
    q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

/** The envelope's data, or an {@link ApiError} carrying the envelope (so plan refusals read as such). */
function settled<T>(source: Observable<ResponseData<T>>): Observable<T> {
  return source.pipe(
    map((res) => {
      if (!res || res.status !== true) {
        throw new ApiError(res?.responseCode ?? 'UNKNOWN', res?.message ?? 'Request failed', res);
      }
      return res.data as T;
    }),
  );
}

/**
 * A failed download's body is a Blob: read it back into the engine's envelope so the page can say
 * why (plan refusal, not found, validation) instead of "Http failure" (exported for testing).
 */
export function blobError(err: unknown): Observable<never> {
  if (err instanceof HttpErrorResponse && err.error instanceof Blob) {
    return from(err.error.text()).pipe(
      switchMap((text) => {
        try {
          const env = JSON.parse(text) as ResponseData<unknown>;
          return throwError(
            () =>
              new ApiError(env.responseCode ?? 'UNKNOWN', env.message ?? 'Download failed', env),
          );
        } catch {
          return throwError(() => err);
        }
      }),
    );
  }
  return throwError(() => err);
}

/** The file of a download response (exported for testing). */
export function toDownloadedFile(res: HttpResponse<Blob>, fallbackName: string): DownloadedFile {
  return {
    blob: res.body ?? new Blob([]),
    fileName:
      fileNameFromContentDisposition(res.headers.get('Content-Disposition')) ?? fallbackName,
    sha256: res.headers.get('X-Content-SHA256'),
    signature: res.headers.get('X-Lascodia-Signature'),
    signingKeyId: res.headers.get('X-Lascodia-Signing-Key-Id'),
  };
}

@Injectable({ providedIn: 'root' })
export class FundApiService {
  private readonly api = inject(ApiService);
  private readonly http = inject(HttpClient);
  private readonly baseUrl = `${inject(RUNTIME_CONFIG).apiBaseUrl}/api/v1/lascodia-trading-engine`;

  scope(): Observable<FundScope> {
    return settled(this.api.get<ResponseData<FundScope>>('/fund/scope', SILENT));
  }

  // ── Performance ──
  performance(params: {
    tradingAccountId?: number | null;
    accountGroupId?: number | null;
    from: string;
    to: string;
    riskFreeRatePct?: number;
  }): Observable<PerformanceStatement> {
    return settled(
      this.api.get<ResponseData<PerformanceStatement>>(
        `/fund/performance${fundQuery(params)}`,
        SILENT,
      ),
    );
  }

  performanceExport(
    params: {
      tradingAccountId?: number | null;
      accountGroupId?: number | null;
      from: string;
      to: string;
      riskFreeRatePct?: number;
    },
    format: 'pdf' | 'csv',
  ): Observable<DownloadedFile> {
    return this.download(
      `/fund/performance/export${fundQuery({ ...params, format })}`,
      `performance.${format}`,
    );
  }

  cashFlows(tradingAccountId: number): Observable<CashFlow[]> {
    return settled(
      this.api.get<ResponseData<CashFlow[]>>(
        `/fund/accounts/${tradingAccountId}/cash-flows`,
        SILENT,
      ),
    );
  }

  recordCashFlow(tradingAccountId: number, body: RecordCashFlowBody): Observable<CashFlow> {
    return settled(
      this.api.post<ResponseData<CashFlow>>(
        `/fund/accounts/${tradingAccountId}/cash-flows`,
        body,
        SILENT,
      ),
    );
  }

  removeCashFlow(tradingAccountId: number, id: number, reason: string | null): Observable<unknown> {
    return settled(
      this.api.delete<ResponseData<string>>(
        `/fund/accounts/${tradingAccountId}/cash-flows/${id}${fundQuery({ reason })}`,
        SILENT,
      ),
    );
  }

  // ── Best execution ──
  bestExecution(params: {
    from: string;
    to: string;
    tradingAccountId?: number | null;
    symbol?: string | null;
  }): Observable<BestExecutionReport> {
    return settled(
      this.api.get<ResponseData<BestExecutionReport>>(
        `/fund/best-execution${fundQuery(params)}`,
        SILENT,
      ),
    );
  }

  bestExecutionExport(
    params: { from: string; to: string; tradingAccountId?: number | null; symbol?: string | null },
    format: 'pdf' | 'csv',
  ): Observable<DownloadedFile> {
    return this.download(
      `/fund/best-execution/export${fundQuery({ ...params, format })}`,
      `best-execution.${format}`,
    );
  }

  // ── Compliance ──
  complianceExports(): Observable<ComplianceExportRecord[]> {
    return settled(
      this.api.get<ResponseData<ComplianceExportRecord[]>>('/fund/compliance-exports', SILENT),
    );
  }

  downloadCompliance(
    from: string,
    to: string,
    sections: ComplianceSection[],
    format: ComplianceFormat,
  ): Observable<DownloadedFile> {
    return this.download(
      `/fund/compliance-exports/download${fundQuery({ from, to, sections: sections.join(','), format })}`,
      `compliance.${format === 'csv' ? 'zip' : 'json'}`,
    );
  }

  verifyCompliance(sha256: string): Observable<ComplianceVerification> {
    return settled(
      this.api.get<ResponseData<ComplianceVerification>>(
        `/fund/compliance-exports/verify${fundQuery({ sha256 })}`,
        SILENT,
      ),
    );
  }

  /** Bytes fetched with the session's credentials, then handed to the browser by the page. */
  private download(path: string, fallbackName: string): Observable<DownloadedFile> {
    return this.http
      .get(`${this.baseUrl}${path}`, {
        responseType: 'blob',
        observe: 'response',
        withCredentials: true,
        params: new HttpParams(),
        context: new HttpContext().set(SUPPRESS_ERROR_TOAST, true),
      })
      .pipe(
        map((res) => toDownloadedFile(res, fallbackName)),
        catchError(blobError),
      );
  }
}
