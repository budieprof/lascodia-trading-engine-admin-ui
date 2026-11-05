import { HttpClient, HttpContext, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';

import { ApiService, SUPPRESS_ERROR_TOAST } from '@core/api/api.service';
import { ApiError, type ResponseData } from '@core/api/api.types';
import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import { fileNameFromContentDisposition } from '@features/scripting/shared/download';
import type {
  BillingFile,
  BillingRedirect,
  BillingSubscription,
  BillingUsageMonth,
  GenerateInvoicesResult,
  Invoice,
  PaymentProviderInfo,
  PaystackConfirmation,
  PriceBook,
  PriceBookBody,
} from './billing.types';
import { normaliseSubscription } from './plan-offers.logic';
import type {
  AddOn,
  AddOnBody,
  PlanAllowances,
  TenantAddOn,
  UnitCostReport,
  UsageUnit,
} from './add-ons.types';

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

  // ── The organisation's plan (self-serve: Stripe Checkout + billing portal, or Paystack) ──
  subscription(): Observable<BillingSubscription> {
    return settled(
      this.api.get<ResponseData<BillingSubscription>>('/tenant/billing/subscription', SILENT),
    ).pipe(map(normaliseSubscription));
  }
  /**
   * `tenant.billing.manage`: a payment page for `planSlug` (Stripe Checkout or Paystack, the engine's choice);
   * the caller sends the browser to `url`.
   */
  checkout(planSlug: string): Observable<BillingRedirect> {
    return settled(
      this.api.post<ResponseData<BillingRedirect>>(
        '/tenant/billing/checkout',
        { planSlug },
        SILENT,
      ),
    );
  }
  /** `tenant.billing.manage`: the billing portal (Stripe: switch plan, card, cancel; Paystack: card, cancel). */
  portal(): Observable<BillingRedirect> {
    return settled(
      this.api.post<ResponseData<BillingRedirect>>('/tenant/billing/portal', {}, SILENT),
    );
  }
  /** `tenant.billing.manage`: after Paystack's payment page sends the browser back, what became of `reference`. */
  confirmPaystack(reference: string): Observable<PaystackConfirmation> {
    return settled(
      this.api.post<ResponseData<PaystackConfirmation>>(
        '/tenant/billing/paystack/confirm',
        { reference },
        SILENT,
      ),
    );
  }

  // ── Priced units and add-ons (freemium program) ──
  /** `tenant.usage.read`: the organisation's priced units (used / allowance / resets on). */
  myUnits(): Observable<UsageUnit[]> {
    return settled(this.api.get<ResponseData<{ units?: UsageUnit[] }>>('/tenant/usage', SILENT)).pipe(
      map((r) => r?.units ?? []),
    );
  }
  /** `tenant.billing.read`: the add-ons offered and what the organisation holds. */
  myAddOns(): Observable<AddOn[]> {
    return settled(this.api.get<ResponseData<AddOn[]>>('/tenant/billing/add-ons', SILENT)).pipe(
      map((r) => r ?? []),
    );
  }
  /** `tenant.billing.manage`: start an add-on's free trial (once per organisation). */
  startAddOnTrial(slug: string): Observable<TenantAddOn> {
    return settled(
      this.api.post<ResponseData<TenantAddOn>>(
        `/tenant/billing/add-ons/${encodeURIComponent(slug)}/trial`,
        {},
        SILENT,
      ),
    );
  }
  /** `tenant.billing.manage`: a payment page for an add-on; the caller sends the browser to `url`. */
  addOnCheckout(slug: string): Observable<BillingRedirect> {
    return settled(
      this.api.post<ResponseData<BillingRedirect>>(
        `/tenant/billing/add-ons/${encodeURIComponent(slug)}/checkout`,
        {},
        SILENT,
      ),
    );
  }
  /** `tenant.billing.manage`: where to update the card or cancel a paid add-on. */
  manageAddOn(slug: string): Observable<BillingRedirect> {
    return settled(
      this.api.post<ResponseData<BillingRedirect>>(
        `/tenant/billing/add-ons/${encodeURIComponent(slug)}/manage`,
        {},
        SILENT,
      ),
    );
  }
  /** `tenant.billing.manage`: after Paystack's page, what became of an add-on payment. */
  confirmAddOnPaystack(reference: string): Observable<PaystackConfirmation> {
    return settled(
      this.api.post<ResponseData<PaystackConfirmation>>(
        '/tenant/billing/add-ons/paystack/confirm',
        { reference },
        SILENT,
      ),
    );
  }

  // ── Platform staff: add-ons, allowances, unit costs ──
  addOns(): Observable<AddOn[]> {
    return settled(this.api.get<ResponseData<AddOn[]>>('/platform/billing/add-ons', SILENT)).pipe(
      map((r) => r ?? []),
    );
  }
  saveAddOn(slug: string, body: AddOnBody): Observable<AddOn> {
    return settled(
      this.api.put<ResponseData<AddOn>>(
        `/platform/billing/add-ons/${encodeURIComponent(slug)}`,
        body,
        SILENT,
      ),
    );
  }
  planAllowances(planId: number): Observable<PlanAllowances> {
    return settled(
      this.api.get<ResponseData<PlanAllowances>>(`/platform/billing/plans/${planId}/allowances`, SILENT),
    );
  }
  setPlanAllowances(planId: number, allowances: PlanAllowances): Observable<PlanAllowances> {
    return settled(
      this.api.put<ResponseData<PlanAllowances>>(
        `/platform/billing/plans/${planId}/allowances`,
        { allowances },
        SILENT,
      ),
    );
  }
  tenantAddOns(tenantId: number): Observable<TenantAddOn[]> {
    return settled(
      this.api.get<ResponseData<TenantAddOn[]>>(`/platform/billing/tenants/${tenantId}/add-ons`, SILENT),
    ).pipe(map((r) => r ?? []));
  }
  grantAddOn(tenantId: number, slug: string, endsAtUtc: string | null, note: string | null): Observable<TenantAddOn> {
    return settled(
      this.api.post<ResponseData<TenantAddOn>>(
        `/platform/billing/tenants/${tenantId}/add-ons`,
        { slug, endsAtUtc, note },
        SILENT,
      ),
    );
  }
  endAddOn(tenantId: number, tenantAddOnId: number, reason: string | null): Observable<TenantAddOn> {
    return settled(
      this.api.post<ResponseData<TenantAddOn>>(
        `/platform/billing/tenants/${tenantId}/add-ons/${tenantAddOnId}/end`,
        { reason },
        SILENT,
      ),
    );
  }
  unitCosts(month: string | null): Observable<UnitCostReport> {
    return settled(
      this.api.get<ResponseData<UnitCostReport>>(`/platform/billing/unit-costs${query({ month })}`, SILENT),
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
