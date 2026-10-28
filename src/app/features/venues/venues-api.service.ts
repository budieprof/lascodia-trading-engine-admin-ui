import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';

import { ApiService } from '@core/api/api.service';
import { ApiError, type ResponseData } from '@core/api/api.types';
import type {
  CreateExecutionAccountBody,
  CryptoFundamentals,
  EquityFundamentals,
  ExecutionAccount,
  ExecutionAccountReconciliation,
  ExecutionAdapter,
  ExecutionCredentialStatus,
  ExecutionHealth,
  FeeSchedule,
  FeeScheduleFields,
  FuturesTermStructure,
  InstrumentCandleState,
  MarginImportResult,
  MarginRequirement,
  MarginRequirementFields,
  VenueTicketPreview,
  VenueTicketPreviewRequest,
  VenueTicketResult,
  VenueTicketSendRequest,
} from './venues.types';

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

function query(params: Record<string, string | number | boolean | null | undefined>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

/**
 * The venue side of the console (multi-asset WS7): execution accounts + write-only credentials (exec-gateway
 * `execution/*`), adapter health and the exchange-traded ticket preview (`execution-console/*`), reference data
 * editors (`reference/*`), the instrument candle builder's state and the fundamentals panels. Every call is silent:
 * the pages show their own errors (`errorText`).
 */
@Injectable({ providedIn: 'root' })
export class VenuesApiService {
  private readonly api = inject(ApiService);

  // ── Execution accounts (exec-gateway) ───────────────────────────────────

  adapters(): Observable<ExecutionAdapter[]> {
    return settled(
      this.api.get<ResponseData<ExecutionAdapter[]>>('/execution/adapters', SILENT),
    ).pipe(map((r) => r ?? []));
  }

  accounts(): Observable<ExecutionAccount[]> {
    return settled(
      this.api.get<ResponseData<ExecutionAccount[]>>('/execution/accounts', SILENT),
    ).pipe(map((r) => r ?? []));
  }

  createAccount(body: CreateExecutionAccountBody): Observable<ExecutionAccount> {
    return settled(
      this.api.post<ResponseData<ExecutionAccount>>('/execution/accounts', body, SILENT),
    );
  }

  setStatus(
    id: number,
    status: 'Active' | 'Disabled' | 'Suspended',
    reason: string | null,
  ): Observable<ExecutionAccount> {
    return settled(
      this.api.put<ResponseData<ExecutionAccount>>(
        `/execution/accounts/${id}/status`,
        { status, reason },
        SILENT,
      ),
    );
  }

  /** Write-only: the fields go to the engine once and are never read back (only the fingerprint is). */
  saveCredential(
    id: number,
    fields: Record<string, string>,
  ): Observable<ExecutionCredentialStatus> {
    return settled(
      this.api.put<ResponseData<ExecutionCredentialStatus>>(
        `/execution/accounts/${id}/credential`,
        { fields },
        SILENT,
      ),
    );
  }

  verify(id: number): Observable<ExecutionCredentialStatus> {
    return settled(
      this.api.post<ResponseData<ExecutionCredentialStatus>>(
        `/execution/accounts/${id}/verify`,
        {},
        SILENT,
      ),
    );
  }

  revokeCredential(id: number): Observable<boolean> {
    return settled(
      this.api.delete<ResponseData<boolean>>(`/execution/accounts/${id}/credential`, SILENT),
    );
  }

  reconciliation(): Observable<ExecutionAccountReconciliation[]> {
    return settled(
      this.api.get<ResponseData<ExecutionAccountReconciliation[]>>(
        '/execution/reconciliation',
        SILENT,
      ),
    ).pipe(map((r) => r ?? []));
  }

  // ── execution-console (console-api) ─────────────────────────────────────

  health(): Observable<ExecutionHealth> {
    return settled(
      this.api.get<ResponseData<ExecutionHealth>>('/execution-console/health', SILENT),
    );
  }

  /** Dry run of an exchange-traded ticket; writes nothing (a read through POST). */
  previewTicket(body: VenueTicketPreviewRequest): Observable<VenueTicketPreview> {
    return settled(
      this.api.post<ResponseData<VenueTicketPreview>>(
        '/execution-console/ticket/preview',
        body,
        SILENT,
      ),
    );
  }

  /**
   * SENDS an exchange-traded ticket (`trade-signal/venue-ticket`, `access.trader`): a manual signal with the venue terms,
   * then Tier 1 and the venue entry path. The raw envelope is returned (not `settled`) because a refusal carries the
   * engine's re-run preview and a four-eyes hold answers HTTP 202 `-202-approval` — neither is a transport error.
   */
  sendTicket(body: VenueTicketSendRequest): Observable<ResponseData<VenueTicketResult>> {
    return this.api.post<ResponseData<VenueTicketResult>>(
      '/trade-signal/venue-ticket',
      body,
      SILENT,
    );
  }

  // ── Reference data ──────────────────────────────────────────────────────

  feeSchedules(
    filter: { assetClass?: string; venue?: string; search?: string; includeDeleted?: boolean } = {},
  ): Observable<FeeSchedule[]> {
    return settled(
      this.api.get<ResponseData<FeeSchedule[]>>(`/reference/fee-schedules${query(filter)}`, SILENT),
    ).pipe(map((r) => r ?? []));
  }

  createFeeSchedule(body: FeeScheduleFields & { reason?: string | null }): Observable<FeeSchedule> {
    return settled(
      this.api.post<ResponseData<FeeSchedule>>('/reference/fee-schedules', body, SILENT),
    );
  }

  updateFeeSchedule(
    id: number,
    body: FeeScheduleFields & { reason?: string | null },
  ): Observable<FeeSchedule> {
    return settled(
      this.api.put<ResponseData<FeeSchedule>>(`/reference/fee-schedules/${id}`, body, SILENT),
    );
  }

  deleteFeeSchedule(id: number, reason: string | null): Observable<boolean> {
    return settled(
      this.api.delete<ResponseData<boolean>>(
        `/reference/fee-schedules/${id}${query({ reason })}`,
        SILENT,
      ),
    );
  }

  marginRequirements(
    filter: { kind?: string; symbol?: string; venue?: string; includeDeleted?: boolean } = {},
  ): Observable<MarginRequirement[]> {
    return settled(
      this.api.get<ResponseData<MarginRequirement[]>>(
        `/reference/margin-requirements${query(filter)}`,
        SILENT,
      ),
    ).pipe(map((r) => r ?? []));
  }

  createMarginRequirement(
    body: MarginRequirementFields & { reason?: string | null },
  ): Observable<MarginRequirement> {
    return settled(
      this.api.post<ResponseData<MarginRequirement>>(
        '/reference/margin-requirements',
        body,
        SILENT,
      ),
    );
  }

  updateMarginRequirement(
    id: number,
    body: MarginRequirementFields & { reason?: string | null },
  ): Observable<MarginRequirement> {
    return settled(
      this.api.put<ResponseData<MarginRequirement>>(
        `/reference/margin-requirements/${id}`,
        body,
        SILENT,
      ),
    );
  }

  /**
   * Loads margin rows from a CSV file (`platform.data.manage`). All or nothing: a file with errors answers `-11` and the
   * error carries the result (`marginImportFromError`), so the caller can list every bad line. `dryRun` writes nothing.
   */
  importMarginRequirements(body: {
    csv: string;
    dryRun: boolean;
    reason?: string | null;
  }): Observable<MarginImportResult> {
    return settled(
      this.api.post<ResponseData<MarginImportResult>>(
        '/reference/margin-requirements/import',
        body,
        SILENT,
      ),
    );
  }

  deleteMarginRequirement(id: number, reason: string | null): Observable<boolean> {
    return settled(
      this.api.delete<ResponseData<boolean>>(
        `/reference/margin-requirements/${id}${query({ reason })}`,
        SILENT,
      ),
    );
  }

  // ── Market data ─────────────────────────────────────────────────────────

  instrumentCandleState(
    filter: { symbol?: string; status?: string } = {},
  ): Observable<InstrumentCandleState> {
    return settled(
      this.api.get<ResponseData<InstrumentCandleState>>(
        `/instrument-candles/state${query(filter)}`,
        SILENT,
      ),
    );
  }

  equityFundamentals(symbol: string): Observable<EquityFundamentals> {
    return settled(
      this.api.get<ResponseData<EquityFundamentals>>(
        `/instrument-fundamentals/equity/${encodeURIComponent(symbol)}`,
        SILENT,
      ),
    );
  }

  futuresTermStructure(root: string): Observable<FuturesTermStructure> {
    return settled(
      this.api.get<ResponseData<FuturesTermStructure>>(
        `/instrument-fundamentals/futures/${encodeURIComponent(root)}`,
        SILENT,
      ),
    );
  }

  cryptoFundamentals(symbol: string, sourceId: string): Observable<CryptoFundamentals> {
    return settled(
      this.api.get<ResponseData<CryptoFundamentals>>(
        `/instrument-fundamentals/crypto/${encodeURIComponent(symbol)}${query({ sourceId })}`,
        SILENT,
      ),
    );
  }
}
