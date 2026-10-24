import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';

import { ApiService } from '@core/api/api.service';
import type { PagedData, ResponseData, TradingAccountDto } from '@core/api/api.types';
import { queryString } from '@features/iam/iam-api.service';
import { settled } from '@features/organisation/organisation-api.service';
import type {
  AccountOption,
  EnrolBody,
  PreparePayoutBody,
  PropBreach,
  PropDashboard,
  PropEnrollment,
  PropEnrollmentState,
  PropLeaderboardRow,
  PropModuleStatus,
  PropPayout,
  PropPayoutStatus,
  PropProgram,
  PropTrader,
  SavePropProgramBody,
  SavePropTraderBody,
} from './prop.types';

/** The pages say what went wrong themselves; session handling (step-up, CSRF, sign-in) still applies. */
const SILENT = { silent: true } as const;

/**
 * The prop-firm module's engine calls (`api/v1/lascodia-trading-engine/prop`, engine
 * `docs/api/prop-module.md`). Every call acts in the session's active organisation. Without the plan
 * feature the engine answers `-403-quota` — the pages ask {@link status} first and show the upgrade
 * notice instead of calling the rest.
 */
@Injectable({ providedIn: 'root' })
export class PropApiService {
  private readonly api = inject(ApiService);

  private get<T>(path: string): Observable<T> {
    return settled(this.api.get<ResponseData<T>>(`/prop${path}`, SILENT));
  }
  private post<T>(path: string, body: unknown = {}): Observable<T> {
    return settled(this.api.post<ResponseData<T>>(`/prop${path}`, body, SILENT));
  }
  private put<T>(path: string, body: unknown): Observable<T> {
    return settled(this.api.put<ResponseData<T>>(`/prop${path}`, body, SILENT));
  }

  /** `prop.self` — whether the organisation's plan includes the module. */
  status(): Observable<PropModuleStatus> {
    return this.get('/status');
  }

  programs(includeArchived = false): Observable<PropProgram[]> {
    return this.get(`/programs${queryString({ includeArchived: includeArchived || null })}`);
  }
  createProgram(body: SavePropProgramBody): Observable<PropProgram> {
    return this.post('/programs', body);
  }
  updateProgram(id: number, body: SavePropProgramBody): Observable<PropProgram> {
    return this.put(`/programs/${id}`, body);
  }
  archiveProgram(id: number): Observable<PropProgram> {
    return this.post(`/programs/${id}/archive`);
  }

  traders(): Observable<PropTrader[]> {
    return this.get('/traders');
  }
  createTrader(body: SavePropTraderBody): Observable<PropTrader> {
    return this.post('/traders', body);
  }
  updateTrader(id: number, body: SavePropTraderBody): Observable<PropTrader> {
    return this.put(`/traders/${id}`, body);
  }

  enrollments(filter: {
    state?: PropEnrollmentState | null;
    programId?: number | null;
    traderId?: number | null;
  }): Observable<PropEnrollment[]> {
    return this.get(`/enrollments${queryString({ ...filter, take: 500 })}`);
  }
  enrol(body: EnrolBody): Observable<PropEnrollment> {
    return this.post('/enrollments', body);
  }
  withdraw(id: number, reason: string | null): Observable<PropEnrollment> {
    return this.post(`/enrollments/${id}/withdraw`, { reason });
  }
  advance(
    id: number,
    body: { tradingAccountId: number | null; initialBalance: number | null; note: string | null },
  ): Observable<PropEnrollment> {
    return this.post(`/enrollments/${id}/advance`, body);
  }
  dashboard(id: number): Observable<PropDashboard> {
    return this.get(`/enrollments/${id}/dashboard`);
  }
  myDashboards(): Observable<PropDashboard[]> {
    return this.get('/me');
  }

  breaches(afterId: number | null, take = 100): Observable<PropBreach[]> {
    return this.get(`/breaches${queryString({ afterId, take })}`);
  }
  leaderboard(programId: number | null, includeEnded = false): Observable<PropLeaderboardRow[]> {
    return this.get(
      `/leaderboard${queryString({ programId, includeEnded: includeEnded || null })}`,
    );
  }

  payouts(status: PropPayoutStatus | null): Observable<PropPayout[]> {
    return this.get(`/payouts${queryString({ status })}`);
  }
  preparePayout(body: PreparePayoutBody): Observable<PropPayout> {
    return this.post('/payouts', body);
  }
  approvePayout(id: number, note: string | null): Observable<PropPayout> {
    return this.post(`/payouts/${id}/approve`, { note });
  }
  rejectPayout(id: number, note: string): Observable<PropPayout> {
    return this.post(`/payouts/${id}/reject`, { note });
  }
  /** CSV of the statements overlapping the range (null when the download failed). */
  exportPayoutsCsv(fromUtc: string | null, toUtc: string | null): Promise<Blob | null> {
    return this.api.getBlob(`/prop/payouts/export${queryString({ fromUtc, toUtc })}`);
  }
  payoutPdf(id: number): Promise<Blob | null> {
    return this.api.getBlob(`/prop/payouts/${id}/pdf`);
  }

  /** The organisation's trading accounts for the enrol form (`accounts.read`). */
  accounts(): Observable<AccountOption[]> {
    return this.api
      .post<
        ResponseData<PagedData<TradingAccountDto>>
      >('/trading-account/list', { currentPage: 1, itemCountPerPage: 500 }, SILENT)
      .pipe(
        map((res) =>
          (res?.data?.data ?? []).map((a) => ({
            id: a.id,
            label: `${a.accountName || a.accountId || 'Account'} (${a.accountId ?? '?'} @ ${a.brokerServer ?? '?'})`,
            balance: typeof a.balance === 'number' ? a.balance : null,
          })),
        ),
      );
  }
}
