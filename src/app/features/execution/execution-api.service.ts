import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';

import { ApiService } from '@core/api/api.service';
import { ApiError, type ResponseData } from '@core/api/api.types';

import type {
  AlgoOrderDetail,
  AlgoOrderPage,
  AllocationGroup,
  AllocationPreview,
  AllocationPreviewRequest,
  BlockOrder,
  ExecutionAlgorithm,
  ExecutionSettings,
  RouterDecisionPage,
  SaveAllocationGroup,
} from './execution.types';

const SILENT = { silent: true } as const;

/** `?a=1&b=x` from the set values (exported for testing). */
export function executionQuery(params: Record<string, unknown>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === '' || v === false) continue;
    q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

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

/** Execution algorithms and allocation groups (engine `execution/*`). */
@Injectable({ providedIn: 'root' })
export class ExecutionApiService {
  private readonly api = inject(ApiService);

  algoOrders(filter: {
    status?: string | null;
    tradingAccountId?: number | null;
    tradeSignalId?: number | null;
    activeOnly?: boolean;
    page?: number;
    pageSize?: number;
  }): Observable<AlgoOrderPage> {
    return settled(
      this.api.get<ResponseData<AlgoOrderPage>>(
        `/execution/algo-orders${executionQuery({ ...filter })}`,
        SILENT,
      ),
    );
  }

  algoOrder(id: number): Observable<AlgoOrderDetail> {
    return settled(this.api.get<ResponseData<AlgoOrderDetail>>(`/execution/algo-orders/${id}`, SILENT));
  }

  cancel(id: number): Observable<boolean> {
    return settled(this.api.post<ResponseData<boolean>>(`/execution/algo-orders/${id}/cancel`, {}, SILENT));
  }

  settings(): Observable<ExecutionSettings> {
    return settled(this.api.get<ResponseData<ExecutionSettings>>('/execution/algo/settings', SILENT));
  }

  routerDecisions(nonDirectOnly: boolean, take = 100): Observable<RouterDecisionPage> {
    return settled(
      this.api.get<ResponseData<RouterDecisionPage>>(
        `/execution/algo/router-decisions${executionQuery({ nonDirectOnly, take })}`,
        SILENT,
      ),
    );
  }

  setStrategyAlgorithm(
    strategyId: number,
    body: {
      algorithm: ExecutionAlgorithm;
      durationSeconds?: number | null;
      slices?: number | null;
      displayQuantity?: number | null;
    },
  ): Observable<ResponseData<boolean>> {
    return this.api.put<ResponseData<boolean>>(`/execution/strategies/${strategyId}/algorithm`, body, SILENT);
  }

  groups(): Observable<AllocationGroup[]> {
    return settled(this.api.get<ResponseData<AllocationGroup[]>>('/execution/allocation-groups', SILENT));
  }

  createGroup(body: SaveAllocationGroup): Observable<AllocationGroup> {
    return settled(this.api.post<ResponseData<AllocationGroup>>('/execution/allocation-groups', body, SILENT));
  }

  updateGroup(id: number, body: SaveAllocationGroup): Observable<AllocationGroup> {
    return settled(this.api.put<ResponseData<AllocationGroup>>(`/execution/allocation-groups/${id}`, body, SILENT));
  }

  deleteGroup(id: number): Observable<boolean> {
    return settled(this.api.delete<ResponseData<boolean>>(`/execution/allocation-groups/${id}`, SILENT));
  }

  preview(groupId: number | null, body: AllocationPreviewRequest): Observable<AllocationPreview> {
    const url = groupId
      ? `/execution/allocation-groups/${groupId}/preview`
      : '/execution/allocation-groups/preview';
    return settled(this.api.post<ResponseData<AllocationPreview>>(url, body, SILENT));
  }

  blocks(allocationGroupId: number | null, take = 50): Observable<BlockOrder[]> {
    return settled(
      this.api.get<ResponseData<BlockOrder[]>>(
        `/execution/blocks${executionQuery({ allocationGroupId, take })}`,
        SILENT,
      ),
    );
  }

  block(id: number): Observable<BlockOrder> {
    return settled(this.api.get<ResponseData<BlockOrder>>(`/execution/blocks/${id}`, SILENT));
  }
}
