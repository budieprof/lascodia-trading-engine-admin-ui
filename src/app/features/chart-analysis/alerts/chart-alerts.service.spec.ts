import { Injector } from '@angular/core';
import { Observable, Subject } from 'rxjs';
import { beforeEach, describe, expect, it } from 'vitest';

import { ApiService } from '@core/api/api.service';
import { RealtimeService, type RealtimeEventName } from '@core/realtime/realtime.service';

import { ChartAlertsService } from './chart-alerts.service';
import type { ChartAlertDto, ChartAlertInput } from './chart-alerts.types';

class FakeRealtime {
  private readonly subjects = new Map<string, Subject<unknown>>();
  on(name: RealtimeEventName) {
    let s = this.subjects.get(name);
    if (!s) {
      s = new Subject<unknown>();
      this.subjects.set(name, s);
    }
    return s.asObservable();
  }
  emit(name: RealtimeEventName, payload: unknown): void {
    this.subjects.get(name)?.next(payload);
  }
}

/** Stand-in API: records each call and lets the test answer it. */
class FakeApi {
  readonly calls: { method: string; path: string; body?: unknown; reply: Subject<unknown> }[] = [];
  private call(method: string, path: string, body?: unknown): Observable<unknown> {
    const reply = new Subject<unknown>();
    this.calls.push({ method, path, body, reply });
    return reply.asObservable();
  }
  get(path: string) {
    return this.call('GET', path);
  }
  post(path: string, body: unknown) {
    return this.call('POST', path, body);
  }
  put(path: string, body: unknown) {
    return this.call('PUT', path, body);
  }
  delete(path: string) {
    return this.call('DELETE', path);
  }
  answer(index: number, body: unknown): void {
    this.calls[index].reply.next(body);
    this.calls[index].reply.complete();
  }
}

const ok = <T>(data: T) => ({ data, status: true, message: 'Successful', responseCode: '00' });

function dto(id: number, over: Partial<ChartAlertDto> = {}): ChartAlertDto {
  return {
    id,
    name: null,
    symbol: 'EURUSD',
    timeframe: '60',
    kind: 'Price',
    side: 'Bid',
    condition: 'CrossingUp',
    price: 1.085,
    upperPrice: null,
    geometry: null,
    drawingId: null,
    drawingKind: null,
    frequency: 'once',
    expiresAtUtc: null,
    channels: ['InApp'],
    messageTemplate: null,
    severity: 'Medium',
    status: 'Active',
    statusReason: null,
    createdAt: '2026-10-09T08:00:00Z',
    updatedAt: '2026-10-09T08:00:00Z',
    lastFiredAt: null,
    fireCount: 0,
    ...over,
  };
}

describe('ChartAlertsService', () => {
  let service: ChartAlertsService;
  let realtime: FakeRealtime;
  let api: FakeApi;

  beforeEach(() => {
    realtime = new FakeRealtime();
    api = new FakeApi();
    service = Injector.create({
      providers: [
        { provide: ChartAlertsService },
        { provide: RealtimeService, useValue: realtime },
        { provide: ApiService, useValue: api },
      ],
    }).get(ChartAlertsService);
  });

  it('keeps the live bid and ask of every symbol on the price stream', () => {
    realtime.emit('priceUpdated', { symbol: 'eurusd', bid: 1.0854, ask: 1.0856 });
    realtime.emit('priceUpdated', { symbol: 'USDJPY', price: 151.2 }); // a bid-only push
    realtime.emit('priceUpdated', { symbol: 'GBPUSD', bid: Number.NaN, ask: 1.3 }); // ignored
    realtime.emit('priceUpdated', { bid: 1, ask: 1 }); // ignored
    expect(service.quote('EURUSD')).toMatchObject({ bid: 1.0854, ask: 1.0856 });
    expect(service.quote('usdjpy')).toMatchObject({ bid: 151.2, ask: 151.2 });
    expect(service.quote('GBPUSD')).toBeNull();
  });

  it('loads the list once and keeps it in step with every change', () => {
    service.ensureLoaded();
    service.ensureLoaded(); // already loading: no second read
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /chart-alert']);
    api.answer(0, ok([dto(1), dto(2, { symbol: 'GBPUSD' })]));
    expect(service.loaded()).toBe(true);
    expect(service.forSymbol('eurusd').map((a) => a.id)).toEqual([1]);
    expect(service.activeCount()).toBe(2);

    const input = { symbol: 'EURUSD' } as ChartAlertInput;
    service.create(input).subscribe();
    api.answer(1, ok(dto(3)));
    expect(service.alerts().map((a) => a.id)).toEqual([3, 1, 2]);

    service.pause(1).subscribe();
    api.answer(2, ok(dto(1, { status: 'Paused' })));
    expect(service.alerts().find((a) => a.id === 1)!.status).toBe('Paused');
    expect(service.activeCount()).toBe(2);

    service.update(2, input).subscribe();
    api.answer(3, { data: null, status: false, message: 'refused', responseCode: '-11' });
    expect(service.alerts().find((a) => a.id === 2)!.symbol).toBe('GBPUSD'); // a refusal changes nothing

    service.delete(3).subscribe();
    api.answer(4, ok(true));
    expect(service.alerts().map((a) => a.id)).toEqual([1, 2]);
    expect(api.calls.slice(1).map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /chart-alert',
      'POST /chart-alert/1/pause',
      'PUT /chart-alert/2',
      'DELETE /chart-alert/3',
    ]);
  });

  it('re-reads the list when one of the chart alerts fires, not for script alerts', () => {
    realtime.emit('alertFired', { source: 'script', alertId: 4 });
    expect(api.calls).toEqual([]);
    realtime.emit('alertFired', { source: 'price', alertId: 4 });
    realtime.emit('alertFired', { source: 'drawing', alertId: 5 });
    expect(api.calls.map((c) => c.path)).toEqual(['/chart-alert', '/chart-alert']);
  });

  it('reads the fire logs', () => {
    service.fires(7, 20).subscribe();
    service.allFires('GBP/USD', 50).subscribe();
    service.allFires(null).subscribe();
    expect(api.calls.map((c) => c.path)).toEqual([
      '/chart-alert/7/fires?limit=20',
      '/chart-alert/fires?symbol=GBP%2FUSD&limit=50',
      '/chart-alert/fires?limit=50',
    ]);
  });
});
