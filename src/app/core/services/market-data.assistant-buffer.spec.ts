import { describe, it, expect, vi } from 'vitest';
import { Injector } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom, of, throwError, type Observable } from 'rxjs';

import { ApiService } from '@core/api/api.service';
import { MarketDataService } from './market-data.service';

function service(get: (path: string, opts?: unknown) => Observable<unknown>) {
  const api = { get: vi.fn(get) };
  const injector = Injector.create({
    providers: [{ provide: ApiService, useValue: api }, { provide: MarketDataService }],
  });
  return { svc: injector.get(MarketDataService), api };
}

describe('MarketDataService.getAssistantBuffer', () => {
  it('GETs the session buffer and unwraps data.text', async () => {
    const { svc, api } = service(() => of({ status: true, data: { text: 'abc' } }));
    expect(await firstValueFrom(svc.getAssistantBuffer(7, 'main'))).toBe('abc');
    expect(api.get).toHaveBeenCalledWith('/market-data/assistant/session/7/buffer/main', {
      silent: true,
    });
  });

  it('returns null on 404', async () => {
    const { svc } = service(() => throwError(() => new HttpErrorResponse({ status: 404 })));
    expect(await firstValueFrom(svc.getAssistantBuffer(7, 'main'))).toBeNull();
  });

  it('rethrows other failures', async () => {
    const { svc } = service(() => throwError(() => new HttpErrorResponse({ status: 500 })));
    await expect(firstValueFrom(svc.getAssistantBuffer(7, 'main'))).rejects.toBeInstanceOf(
      HttpErrorResponse,
    );
  });
});
