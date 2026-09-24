import { describe, expect, it, vi } from 'vitest';
import { Injector } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom, of, throwError } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import { ApiError } from '@core/api/api.types';
import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import { ScriptingApiError, ScriptingService } from '@core/services/scripting.service';
import { ReplaySession } from '../replay/replay-session';
import { ScriptingRunService } from './scripting-run.service';

const BASE = 'http://engine/api/v1/lascodia-trading-engine';

function setup(
  responses: {
    post?: (url: string, body: unknown) => unknown;
    delete?: (url: string) => unknown;
  } = {},
) {
  const http = {
    post: vi.fn((url: string, body: unknown) => {
      const r = responses.post?.(url, body);
      return r instanceof Error || r instanceof HttpErrorResponse ? throwError(() => r) : of(r);
    }),
    delete: vi.fn((url: string) =>
      of(
        responses.delete?.(url) ?? { status: true, data: null, message: null, responseCode: '00' },
      ),
    ),
    get: vi.fn(),
    put: vi.fn(),
  };
  const injector = Injector.create({
    providers: [
      { provide: HttpClient, useValue: http },
      { provide: RUNTIME_CONFIG, useValue: { apiBaseUrl: 'http://engine' } },
      { provide: ApiService, useClass: ApiService },
      { provide: ScriptingService, useClass: ScriptingService },
      { provide: ScriptingRunService, useClass: ScriptingRunService },
    ],
  });
  return { http, api: injector.get(ScriptingRunService) };
}

const ok = (data: unknown) => ({ status: true, data, message: null, responseCode: '00' });

describe('ScriptingRunService', () => {
  it('posts the §3 request to scripting/run and normalises the result', async () => {
    const { http, api } = setup({
      post: () =>
        ok({
          compile: {
            success: true,
            diagnostics: [],
            declaration: { kind: 'indicator', title: 'T', overlay: false },
          },
          bars: [{ t: 1, o: 1, h: 2, l: 0, c: 1.5, v: 10 }],
          outputs: {
            bars: { firstIndex: 0, times: [1], timeframe: '60' },
            plots: [{ id: 0, values: [1] }],
          },
          elapsedMs: 12,
        }),
    });
    const req = {
      source: 'plot(close)',
      symbol: 'EURUSD',
      timeframe: '60',
      lastBars: 500,
      trace: { fromBar: 400, toBar: 499 },
      profile: true,
    };
    const res = await firstValueFrom(api.run(req));
    expect(http.post).toHaveBeenCalledWith(
      `${BASE}/scripting/run`,
      req,
      expect.objectContaining({ withCredentials: true }),
    );
    expect(res.compile?.declaration?.overlay).toBe(false);
    expect(res.outputs?.plots[0].style).toBe('line');
    expect(res.trace).toEqual([]);
    expect(res.elapsedMs).toBe(12);
  });

  it('resolves a compile failure (-11 with the compile result) instead of throwing', async () => {
    const { api } = setup({
      post: () => ({
        status: false,
        responseCode: '-11',
        message: 'Undeclared identifier',
        data: {
          success: false,
          diagnostics: [
            {
              code: 'PS2003',
              severity: 'error',
              message: 'Undeclared identifier',
              line: 3,
              column: 7,
            },
          ],
          declaration: null,
        },
      }),
    });
    const res = await firstValueFrom(api.run({ source: 'x', symbol: 'EURUSD', timeframe: '60' }));
    expect(res.compile?.success).toBe(false);
    expect(res.compile?.diagnostics[0].line).toBe(3);
    expect(res.bars).toEqual([]);
  });

  it('keeps a partial run that a refused envelope carries with its compile result', async () => {
    const { api } = setup({
      post: () => ({
        status: false,
        responseCode: '-11',
        message: 'Runtime error',
        data: {
          compile: { success: true, diagnostics: [], declaration: null },
          bars: [{ t: 1, o: 1, h: 2, l: 0, c: 1.5, v: 10 }],
          runtimeError: { code: 'PS5001', message: 'boom', barIndex: 0 },
        },
      }),
    });
    const res = await firstValueFrom(api.run({ source: 'x', symbol: 'EURUSD', timeframe: '60' }));
    expect(res.bars).toHaveLength(1);
    expect(res.runtimeError?.code).toBe('PS5001');
  });

  it('rejects other engine failures and transport errors with a ScriptingApiError', async () => {
    const failing = setup({
      post: () => ({ status: false, data: null, message: 'Symbol not found', responseCode: '-14' }),
    });
    await expect(
      firstValueFrom(failing.api.run({ source: 'x', symbol: 'NOPE', timeframe: '60' })),
    ).rejects.toMatchObject({
      name: 'ScriptingApiError',
      code: '-14',
      message: 'Symbol not found',
    });
    const down = setup({ post: () => new HttpErrorResponse({ status: 502 }) });
    const err = await firstValueFrom(
      down.api.run({ source: 'x', symbol: 'EURUSD', timeframe: '60' }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScriptingApiError);
    expect((err as ScriptingApiError).httpStatus).toBe(502);
  });

  it('drives a replay session over §5: start, step (clamped), stop', async () => {
    const { http, api } = setup({
      post: (url, body) => {
        if (url.endsWith('/scripting/replay'))
          return ok({
            sessionId: 'abc 1',
            frame: { barIndex: 99, bars: [{ t: 1, o: 1, h: 1, l: 1, c: 1, v: 1 }] },
          });
        const n = (body as { bars: number }).bars;
        return ok({
          barIndex: 99 + n,
          bars: Array.from({ length: n }, (_, i) => ({ t: 2 + i, o: 1, h: 1, l: 1, c: 1, v: 1 })),
          outputsDelta: null,
        });
      },
    });
    const session = new ReplaySession(api);
    await session.start({ source: 's', symbol: 'EURUSD', timeframe: '60' }, 99, null);
    expect(http.post).toHaveBeenCalledWith(
      `${BASE}/scripting/replay`,
      { source: 's', symbol: 'EURUSD', timeframe: '60', startBar: 99 },
      expect.anything(),
    );
    await session.step(5);
    expect(http.post).toHaveBeenLastCalledWith(
      `${BASE}/scripting/replay/abc%201/step`,
      { bars: 5 },
      expect.anything(),
    );
    expect(session.barIndex()).toBe(104);
    expect(session.data()!.bars).toHaveLength(6);
    await firstValueFrom(api.stepReplay('abc 1', { bars: 9999 }));
    expect(http.post).toHaveBeenLastCalledWith(
      `${BASE}/scripting/replay/abc%201/step`,
      { bars: 500 },
      expect.anything(),
    );
    session.stop();
    expect(http.delete).toHaveBeenCalledWith(`${BASE}/scripting/replay/abc%201`, expect.anything());
  });

  it('rejects a start response without a session', async () => {
    const { api } = setup({ post: () => ok({ frame: {} }) });
    await expect(
      firstValueFrom(api.startReplay({ source: 's', symbol: 'X', timeframe: '60', startBar: 1 })),
    ).rejects.toBeInstanceOf(ApiError);
  });
});
