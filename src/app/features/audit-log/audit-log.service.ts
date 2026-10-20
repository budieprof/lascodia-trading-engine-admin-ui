import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpResponse } from '@angular/common/http';
import { Observable, map } from 'rxjs';

import { ApiService } from '@core/api/api.service';
import { RUNTIME_CONFIG } from '@core/config/runtime-config';

import { toQueryString } from './audit-log.filters';
import type { AuditChainVerification, AuditEventPage } from './audit-log.types';

/** Rows per page of the audit list. */
export const AUDIT_PAGE_SIZE = 50;

/** A downloaded export. */
export interface AuditExportFile {
  blob: Blob;
  fileName: string;
  /** Most rows one export request returns (header `X-Audit-Export-Limit`); null when not sent. */
  limit: number | null;
}

/**
 * The engine's audit log API (`/admin/audit-events`, permission `audit.read`): the newest-first list with a
 * keyset cursor, the JSON Lines export and the hash-chain verification.
 */
@Injectable({ providedIn: 'root' })
export class AuditLogService {
  private readonly api = inject(ApiService);
  private readonly http = inject(HttpClient);
  private readonly baseUrl = `${inject(RUNTIME_CONFIG).apiBaseUrl}/api/v1/lascodia-trading-engine`;

  /** One page, newest first. `beforeId` is the previous page's `nextBeforeId` (null for the first page). */
  list(
    params: Record<string, string>,
    beforeId: number | null = null,
    limit = AUDIT_PAGE_SIZE,
  ): Observable<AuditEventPage> {
    return this.api.getEnvelope<AuditEventPage>(
      `/admin/audit-events${toQueryString({ ...params, beforeId, limit })}`,
    );
  }

  /** Recomputes the chain over an id range (whole log when both are null). */
  verify(
    fromId: number | null = null,
    toId: number | null = null,
    maxRows: number | null = null,
  ): Observable<AuditChainVerification> {
    return this.api.getEnvelope<AuditChainVerification>(
      `/admin/audit-events/verify${toQueryString({ fromId, toId, maxRows })}`,
      { silent: true },
    );
  }

  /**
   * The filtered events as a JSON Lines file (oldest first). The request carries the session cookie like every
   * other call; the engine records the export in the audit log itself.
   */
  export(params: Record<string, string>, afterId: number | null = null): Observable<AuditExportFile> {
    return this.http
      .get(`${this.baseUrl}/admin/audit-events/export${toQueryString({ ...params, afterId })}`, {
        responseType: 'blob',
        observe: 'response',
        withCredentials: true,
      })
      .pipe(map((res) => toExportFile(res, new Date())));
  }
}

/** The file of an export response. Exported for testing. */
export function toExportFile(res: HttpResponse<Blob>, now: Date): AuditExportFile {
  const limitHeader = res.headers.get('X-Audit-Export-Limit');
  const limit = limitHeader !== null && /^\d+$/.test(limitHeader) ? Number(limitHeader) : null;
  return {
    blob: res.body ?? new Blob([], { type: 'application/x-ndjson' }),
    fileName: exportFileName(res.headers.get('Content-Disposition'), now),
    limit,
  };
}

/** The file name the engine suggested, else `audit-events-<UTC timestamp>.jsonl`. */
export function exportFileName(contentDisposition: string | null, now: Date): string {
  const match = contentDisposition?.match(/filename="?([^";]+)"?/i);
  if (match && /^[\w.-]+$/.test(match[1])) return match[1];
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
  return `audit-events-${stamp}.jsonl`;
}
