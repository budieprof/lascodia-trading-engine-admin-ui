import { describe, expect, it, beforeEach } from 'vitest';
import { Injector, runInInjectionContext } from '@angular/core';
import {
  HttpErrorResponse,
  HttpRequest,
  HttpResponse,
  type HttpEvent,
  type HttpHandlerFn,
} from '@angular/common/http';
import { firstValueFrom, of, type Observable } from 'rxjs';
import {
  AssistantWriteGuard,
  assistantWriteGuardInterceptor,
  describeBlocked,
} from './assistant-write-guard';

const API = 'http://localhost:8080/api/v1/lascodia-trading-engine';
const FAST = { minSettleMs: 0, maxSettleMs: 50, quietMs: 0, tailMs: 60 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('AssistantWriteGuard', () => {
  let guard: AssistantWriteGuard;
  let injector: Injector;

  beforeEach(() => {
    injector = Injector.create({
      providers: [{ provide: AssistantWriteGuard, useClass: AssistantWriteGuard }],
    });
    guard = injector.get(AssistantWriteGuard);
  });

  it('does nothing while no command runs', () => {
    expect(guard.active()).toBe(false);
    expect(guard.admit('POST', `${API}/strategy/12/pause`)).toBeNull();
  });

  it('blocks writes during a command and reports them, letting reads through', async () => {
    const report = await guard.run(() => {
      expect(guard.admit('GET', `${API}/strategy?status=Active&search=eur`)).toBeNull();
      expect(guard.admit('POST', `${API}/position/list`)).toBeNull();
      expect(guard.admit('POST', `${API}/strategy/12/pause`)).toBe('POST /strategy/12/pause');
      expect(guard.admit('DELETE', `${API}/alert/4`)).toBe('DELETE /alert/4');
      expect(guard.admit('PUT', 'https://elsewhere.example.com/x?y=1')).toBe('PUT /x');
      return 7;
    }, FAST);
    expect(report.value).toBe(7);
    expect(report.blocked).toEqual(['POST /strategy/12/pause', 'DELETE /alert/4', 'PUT /x']);
    expect(report.requests).toEqual(['GET /strategy', 'POST /position/list']);
    expect(describeBlocked(report)).toContain('BLOCKED');
  });

  it('stays up for the tail and hands late refusals to the next command', async () => {
    await guard.run(() => undefined, FAST);
    expect(guard.active()).toBe(true);
    // A debounced save that fires after the command reported.
    expect(guard.admit('POST', `${API}/engine-config/upsert`)).toBe('POST /engine-config/upsert');
    const next = await guard.run(() => undefined, FAST);
    expect(next.blockedEarlier).toEqual(['POST /engine-config/upsert']);
    await sleep(80);
    expect(guard.active()).toBe(false);
    expect(guard.admit('POST', `${API}/strategy/12/pause`)).toBeNull();
  });

  it('never echoes credential paths as page requests', async () => {
    const report = await guard.run(() => guard.admit('GET', `${API}/auth/me`), FAST);
    expect(report.requests).toEqual([]);
  });

  it('the interceptor fails a refused request without calling the network', async () => {
    let sent = 0;
    const next: HttpHandlerFn = (): Observable<HttpEvent<unknown>> => {
      sent++;
      return of(new HttpResponse({ status: 200 }));
    };
    const call = (req: HttpRequest<unknown>) =>
      runInInjectionContext(injector, () =>
        firstValueFrom(assistantWriteGuardInterceptor(req, next)),
      );

    let error: unknown;
    await guard.run(async () => {
      await call(new HttpRequest('GET', `${API}/strategy`));
      try {
        await call(new HttpRequest('POST', `${API}/strategy/12/pause`, {}));
      } catch (e) {
        error = e;
      }
    }, FAST);
    expect(sent).toBe(1);
    expect(error).toBeInstanceOf(HttpErrorResponse);
    expect((error as HttpErrorResponse).status).toBe(403);
    expect((error as HttpErrorResponse).error.message).toContain('POST /strategy/12/pause');
  });

  it('also guards fetch (the chart saves with keep-alive fetch)', async () => {
    const w = window as Window & { fetch?: typeof fetch };
    if (typeof w.fetch !== 'function') return; // jsdom without fetch: nothing to patch
    let rejected: unknown;
    await guard.run(async () => {
      try {
        await w.fetch!(`${API}/chart-drawings/batch`, { method: 'POST', body: '{}' });
      } catch (e) {
        rejected = e;
      }
    }, FAST);
    expect(String(rejected)).toContain('POST /chart-drawings/batch');
  });
});
