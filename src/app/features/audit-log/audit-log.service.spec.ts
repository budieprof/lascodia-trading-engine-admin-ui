import { describe, expect, it, vi } from 'vitest';
import { Injector, runInInjectionContext } from '@angular/core';
import { HttpClient, HttpHeaders, HttpResponse } from '@angular/common/http';
import { firstValueFrom, of } from 'rxjs';

import { ApiService } from '@core/api/api.service';
import { RUNTIME_CONFIG } from '@core/config/runtime-config';

import { AUDIT_PAGE_SIZE, AuditLogService, exportFileName, toExportFile } from './audit-log.service';

function make(api: Partial<Record<keyof ApiService, unknown>>, http: Partial<HttpClient> = {}): AuditLogService {
  const injector = Injector.create({
    providers: [
      { provide: RUNTIME_CONFIG, useValue: { apiBaseUrl: 'http://engine' } },
      { provide: ApiService, useValue: api },
      { provide: HttpClient, useValue: http },
      { provide: AuditLogService, useClass: AuditLogService },
    ],
  });
  return runInInjectionContext(injector, () => injector.get(AuditLogService));
}

describe('AuditLogService.list', () => {
  it('asks for the first page with the filters and the default page size', async () => {
    const getEnvelope = vi.fn().mockReturnValue(of({ items: [], nextBeforeId: null, hasMore: false }));
    const svc = make({ getEnvelope });

    await firstValueFrom(svc.list({ action: 'auth.', outcome: 'Denied' }));

    expect(getEnvelope).toHaveBeenCalledWith(
      `/admin/audit-events?action=auth.&outcome=Denied&limit=${AUDIT_PAGE_SIZE}`,
    );
  });

  it('pages older with the cursor of the previous page', async () => {
    const getEnvelope = vi.fn().mockReturnValue(of({ items: [], nextBeforeId: null, hasMore: false }));
    const svc = make({ getEnvelope });

    await firstValueFrom(svc.list({ category: 'Access' }, 120, 10));

    expect(getEnvelope).toHaveBeenCalledWith('/admin/audit-events?category=Access&beforeId=120&limit=10');
  });
});

describe('AuditLogService.verify', () => {
  it('verifies the whole log by default, silently (the badge shows failures)', async () => {
    const getEnvelope = vi.fn().mockReturnValue(of({ intact: true }));
    const svc = make({ getEnvelope });

    await firstValueFrom(svc.verify());

    expect(getEnvelope).toHaveBeenCalledWith('/admin/audit-events/verify', { silent: true });
  });

  it('passes a range and a row budget', async () => {
    const getEnvelope = vi.fn().mockReturnValue(of({ intact: true }));
    const svc = make({ getEnvelope });

    await firstValueFrom(svc.verify(5, 900, 5000));

    expect(getEnvelope).toHaveBeenCalledWith('/admin/audit-events/verify?fromId=5&toId=900&maxRows=5000', {
      silent: true,
    });
  });
});

describe('AuditLogService.export', () => {
  it('downloads the filtered JSON Lines with credentials and reads the limit header', async () => {
    const blob = new Blob(['{"id":1}\n'], { type: 'application/x-ndjson' });
    const get = vi.fn().mockReturnValue(
      of(
        new HttpResponse({
          body: blob,
          headers: new HttpHeaders({
            'X-Audit-Export-Limit': '100000',
            'Content-Disposition': 'attachment; filename="audit-events-20261020-120000.jsonl"',
          }),
        }),
      ),
    );
    const svc = make({}, { get } as unknown as HttpClient);

    const file = await firstValueFrom(svc.export({ action: 'iam.' }));

    const [url, options] = get.mock.calls[0];
    expect(url).toBe('http://engine/api/v1/lascodia-trading-engine/admin/audit-events/export?action=iam.');
    expect(options).toEqual({ responseType: 'blob', observe: 'response', withCredentials: true });
    expect(file.blob).toBe(blob);
    expect(file.limit).toBe(100000);
    expect(file.fileName).toBe('audit-events-20261020-120000.jsonl');
  });

  it('continues an export after an id', async () => {
    const get = vi.fn().mockReturnValue(of(new HttpResponse({ body: new Blob([]) })));
    const svc = make({}, { get } as unknown as HttpClient);

    await firstValueFrom(svc.export({}, 500));

    expect(get.mock.calls[0][0]).toBe('http://engine/api/v1/lascodia-trading-engine/admin/audit-events/export?afterId=500');
  });
});

describe('export file helpers', () => {
  const NOW = new Date('2026-10-20T12:34:56.789Z');

  it('falls back to a timestamped name when the header is missing or unsafe', () => {
    expect(exportFileName(null, NOW)).toBe('audit-events-20261020-123456.jsonl');
    expect(exportFileName('attachment; filename="../../etc/passwd"', NOW)).toBe('audit-events-20261020-123456.jsonl');
  });

  it('treats a missing or malformed limit header as unknown, and a missing body as empty', () => {
    const file = toExportFile(new HttpResponse<Blob>({ body: null, headers: new HttpHeaders({ 'X-Audit-Export-Limit': 'many' }) }), NOW);
    expect(file.limit).toBeNull();
    expect(file.blob.size).toBe(0);
  });
});
