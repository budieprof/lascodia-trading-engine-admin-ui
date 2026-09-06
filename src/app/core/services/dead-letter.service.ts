import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import { DeadLetterDto, PagedData, PagerRequest, ResponseData } from '@core/api/api.types';

/**
 * What `/dead-letter/list` actually puts on the wire (DeadLetterEventDto.cs).
 * `DeadLetterDto` in api.types.ts was written against a different field set
 * (`attemptCount` / `createdAt` / `payloadJson`), so every consumer rendered
 * "×undefined" attempts and a blank first-seen column. The mapping below
 * bridges the two so the UI-side contract stays stable.
 */
interface DeadLetterWireRow {
  id: number;
  handlerName?: string | null;
  eventType?: string | null;
  eventPayload?: string | null;
  errorMessage?: string | null;
  stackTrace?: string | null;
  attempts?: number;
  deadLetteredAt?: string;
  isResolved?: boolean;
  // Tolerate the names api.types.ts expects in case the engine is ever aligned
  // to them — whichever one is present wins.
  attemptCount?: number;
  createdAt?: string;
  payloadJson?: string | null;
  resolvedAt?: string | null;
}

function toDeadLetterDto(row: DeadLetterWireRow): DeadLetterDto {
  return {
    id: row.id,
    eventType: row.eventType ?? null,
    payloadJson: row.payloadJson ?? row.eventPayload ?? null,
    errorMessage: row.errorMessage ?? null,
    attemptCount: row.attemptCount ?? row.attempts ?? 0,
    isResolved: row.isResolved ?? false,
    createdAt: row.createdAt ?? row.deadLetteredAt ?? '',
    resolvedAt: row.resolvedAt ?? null,
  };
}

@Injectable({ providedIn: 'root' })
export class DeadLetterService {
  private readonly api = inject(ApiService);

  list(params: PagerRequest): Observable<ResponseData<PagedData<DeadLetterDto>>> {
    return this.api
      .post<ResponseData<PagedData<DeadLetterWireRow>>>(`/dead-letter/list`, params)
      .pipe(
        map((res) => ({
          ...res,
          data: res.data ? { ...res.data, data: (res.data.data ?? []).map(toDeadLetterDto) } : null,
        })),
      );
  }

  resolve(id: number): Observable<ResponseData<void>> {
    return this.api.put(`/dead-letter/${id}/resolve`);
  }

  replay(id: number): Observable<ResponseData<void>> {
    return this.api.post(`/dead-letter/${id}/replay`);
  }
}
