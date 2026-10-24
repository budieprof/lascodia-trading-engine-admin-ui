import { HttpClient, HttpContext, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';

import { ApiService, SUPPRESS_ERROR_TOAST } from '@core/api/api.service';
import { ApiError, type ResponseData } from '@core/api/api.types';
import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import { fileNameFromContentDisposition } from '@features/scripting/shared/download';
import type {
  BillingFile,
  BillingUsageMonth,
  GenerateInvoicesResult,
  Invoice,
  PaymentProviderInfo,
  PriceBook,
  PriceBookBody,
} from './billing.types';

const SILENT = { silent: true } as const;

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

function query(params: Record<string, string | number | null | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params))
    if (v !== null && v !== undefined && v !== '') q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
}

/**
 * Billing and metering (engine billing-metering). The organisation's calls need `tenant.billing.read`
 * in the active organisation; platform reads `platform.usage.read`, changes `platform.billing.manage`.
 * Calls are silent: the pages say what went wrong.
 */
@Injectable({ providedIn: 'root' })
export class BillingApiService {
  private readonly api = inject(ApiService);
  private readonly http = inject(HttpClient);
  private readonly baseUrl = `${inject(RUNTIME_CONFIG).apiBaseUrl}/api/v1/lascodia-trading-engine`;

  // ── The organisation's own ──
  myUsage(month: string | null): Observable<BillingUsageMonth> {
    return settled(
      this.api.get<ResponseData<BillingUsageMonth>>(
        `/tenant/billing/usage${query({ month })}`,
        SILENT,
      ),
    );
  }
  myInvoices(): Observable<Invoice[]> {
    return settled(this.api.get<ResponseData<Invoice[]>>('/tenant/billing/invoices', SILENT)).pipe(
      map((r) => r ?? []),
    );
  }
  myInvoice(id: number): Observable<Invoice> {
    return settled(this.api.get<ResponseData<Invoice>>(`/tenant/billing/invoices/${id}`, SILENT));
  }
  downloadMyInvoice(id: number, format: 'pdf' | 'csv'): Observable<BillingFile> {
    return this.download(
      `/tenant/billing/invoices/${id}/export`,
      format,
      `invoice-${id}.${format}`,
    );
  }

  // ── Platform staff ──
  tenantUsage(tenantId: number, month: string | null): Observable<BillingUsageMonth> {
    return settled(
      this.api.get<ResponseData<BillingUsageMonth>>(
        `/platform/billing/usage${query({ tenantId, month })}`,
        SILENT,
      ),
    );
  }
  priceBooks(planId: number | null = null): Observable<PriceBook[]> {
    return settled(
      this.api.get<ResponseData<PriceBook[]>>(
        `/platform/billing/price-books${query({ planId })}`,
        SILENT,
      ),
    ).pipe(map((r) => r ?? []));
  }
  createPriceBook(body: PriceBookBody): Observable<PriceBook> {
    return settled(
      this.api.post<ResponseData<PriceBook>>('/platform/billing/price-books', body, SILENT),
    );
  }
  updatePriceBook(id: number, body: PriceBookBody): Observable<PriceBook> {
    return settled(
      this.api.put<ResponseData<PriceBook>>(`/platform/billing/price-books/${id}`, body, SILENT),
    );
  }
  publishPriceBook(id: number): Observable<PriceBook> {
    return settled(
      this.api.post<ResponseData<PriceBook>>(
        `/platform/billing/price-books/${id}/publish`,
        {},
        SILENT,
      ),
    );
  }
  deletePriceBook(id: number): Observable<boolean> {
    return settled(
      this.api.delete<ResponseData<boolean>>(`/platform/billing/price-books/${id}`, SILENT),
    );
  }
  generateInvoices(month: string, tenantId: number | null): Observable<GenerateInvoicesResult> {
    return settled(
      this.api.post<ResponseData<GenerateInvoicesResult>>(
        '/platform/billing/invoices/generate',
        { month, tenantId },
        SILENT,
      ),
    );
  }
  invoices(month: string | null, status: string | null): Observable<Invoice[]> {
    return settled(
      this.api.get<ResponseData<Invoice[]>>(
        `/platform/billing/invoices${query({ month, status })}`,
        SILENT,
      ),
    ).pipe(map((r) => r ?? []));
  }
  invoice(id: number): Observable<Invoice> {
    return settled(this.api.get<ResponseData<Invoice>>(`/platform/billing/invoices/${id}`, SILENT));
  }
  finalise(id: number, note: string | null): Observable<Invoice> {
    return settled(
      this.api.post<ResponseData<Invoice>>(
        `/platform/billing/invoices/${id}/finalise`,
        { note },
        SILENT,
      ),
    );
  }
  void(id: number, reason: string): Observable<Invoice> {
    return settled(
      this.api.post<ResponseData<Invoice>>(
        `/platform/billing/invoices/${id}/void`,
        { reason },
        SILENT,
      ),
    );
  }
  collect(id: number): Observable<Invoice> {
    return settled(
      this.api.post<ResponseData<Invoice>>(`/platform/billing/invoices/${id}/collect`, {}, SILENT),
    );
  }
  refreshPayment(id: number): Observable<Invoice> {
    return settled(
      this.api.post<ResponseData<Invoice>>(
        `/platform/billing/invoices/${id}/refresh-payment`,
        {},
        SILENT,
      ),
    );
  }
  paymentProvider(): Observable<PaymentProviderInfo> {
    return settled(
      this.api.get<ResponseData<PaymentProviderInfo>>('/platform/billing/payment-provider', SILENT),
    );
  }
  downloadInvoice(id: number, format: 'pdf' | 'csv'): Observable<BillingFile> {
    return this.download(
      `/platform/billing/invoices/${id}/export`,
      format,
      `invoice-${id}.${format}`,
    );
  }

  /** A file fetched with the session's credentials, then handed to the browser. */
  private download(path: string, format: string, fallbackName: string): Observable<BillingFile> {
    return this.http
      .get(`${this.baseUrl}${path}`, {
        params: new HttpParams().set('format', format),
        responseType: 'blob',
        observe: 'response',
        withCredentials: true,
        context: new HttpContext().set(SUPPRESS_ERROR_TOAST, true),
      })
      .pipe(
        map((res) => ({
          blob: res.body ?? new Blob([]),
          fileName:
            fileNameFromContentDisposition(res.headers.get('Content-Disposition')) ?? fallbackName,
        })),
      );
  }
}
