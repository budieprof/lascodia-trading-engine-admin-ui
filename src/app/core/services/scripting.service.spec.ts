import { describe, expect, it, vi } from 'vitest';
import { Injector, runInInjectionContext } from '@angular/core';
import { HttpClient, HttpErrorResponse, HttpHeaders, HttpResponse } from '@angular/common/http';
import { firstValueFrom, of, throwError } from 'rxjs';

import { ApiService } from '@core/api/api.service';
import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import type { PineCatalog, ScriptCompileResult } from '@core/api/scripting.types';
import {
  ScriptingApiError,
  ScriptingService,
  compileResultOf,
  normaliseChartBars,
  normaliseCompile,
  normaliseInputKind,
  toScriptingError,
} from './scripting.service';

const CATALOG: PineCatalog = {
  version: 'v2',
  languageVersion: 6,
  keywords: [],
  types: [],
  annotations: [],
  namespaces: ['ta'],
  functions: [],
  variables: [],
  constants: [],
};

const COMPILE: ScriptCompileResult = {
  success: false,
  diagnostics: [
    {
      code: 'PS2003',
      severity: 'Error' as any,
      message: 'm',
      line: 1,
      column: 1,
      endLine: 1,
      endColumn: 2,
    },
  ],
  declaration: { kind: 'Strategy' as any, title: 'S' },
  inputs: [{ id: 'a', kind: 'TextArea' as any, title: 'A', defaultValue: '' }],
};

function make(
  api: Partial<Record<keyof ApiService, unknown>>,
  http: Partial<HttpClient> = {},
): ScriptingService {
  const injector = Injector.create({
    providers: [
      { provide: RUNTIME_CONFIG, useValue: { apiBaseUrl: 'http://engine' } },
      { provide: ApiService, useValue: api },
      { provide: HttpClient, useValue: http },
      { provide: ScriptingService, useClass: ScriptingService },
    ],
  });
  return runInInjectionContext(injector, () => injector.get(ScriptingService));
}

describe('ScriptingService — catalog', () => {
  it('sends If-None-Match with the cached version and reads a 304 as "keep the cache"', async () => {
    const get = vi
      .fn()
      .mockReturnValue(
        throwError(() => new HttpErrorResponse({ status: 304, statusText: 'Not Modified' })),
      );
    const svc = make({}, { get } as any);
    expect(await firstValueFrom(svc.getCatalog('v1'))).toBeNull();
    const [url, options] = get.mock.calls[0];
    expect(url).toBe('http://engine/api/v1/lascodia-trading-engine/scripting/catalog');
    expect((options.headers as HttpHeaders).get('If-None-Match')).toBe('v1');
    expect(options.withCredentials).toBe(true);
  });

  it('returns a changed catalog out of its envelope and sends no header without a cache', async () => {
    const get = vi.fn().mockReturnValue(
      of(
        new HttpResponse({
          status: 200,
          body: { status: true, data: CATALOG, message: null, responseCode: '00' },
        }),
      ),
    );
    const svc = make({}, { get } as any);
    expect(await firstValueFrom(svc.getCatalog(null))).toEqual(CATALOG);
    expect((get.mock.calls[0][1].headers as HttpHeaders).has('If-None-Match')).toBe(false);
  });
});

describe('ScriptingService — compile', () => {
  it('treats a compile with errors as a result, even in a refused envelope, and normalises casing', async () => {
    const post = vi
      .fn()
      .mockReturnValue(
        of({ status: false, data: COMPILE, message: 'PS2003: m', responseCode: '-11' }),
      );
    const svc = make({ post } as any);
    const r = await firstValueFrom(svc.compile({ source: 'x' }));
    expect(post).toHaveBeenCalledWith('/scripting/compile', { source: 'x' }, { silent: true });
    expect(r.diagnostics[0].severity).toBe('error');
    expect(r.declaration?.kind).toBe('strategy');
    expect(r.inputs[0].kind).toBe('textArea');
  });

  it('also reads the compile result out of an HTTP 400', async () => {
    const post = vi.fn().mockReturnValue(
      throwError(
        () =>
          new HttpErrorResponse({
            status: 400,
            error: { status: false, data: COMPILE, message: 'bad', responseCode: '-11' },
          }),
      ),
    );
    const r = await firstValueFrom(make({ post } as any).compile({ source: 'x' }));
    expect(r.success).toBe(false);
  });

  it('rejects a transport failure with a readable error', async () => {
    const post = vi.fn().mockReturnValue(throwError(() => new HttpErrorResponse({ status: 0 })));
    await expect(
      firstValueFrom(make({ post } as any).compile({ source: 'x' })),
    ).rejects.toMatchObject({
      message: 'The engine could not be reached.',
      httpStatus: 0,
    });
  });
});

describe('ScriptingService — run (the one scripting/run path)', () => {
  it('returns the run with its compile normalised', async () => {
    const run = { compile: COMPILE, bars: [{ t: 1, o: 1, h: 1, l: 1, c: 1, v: 1 }], elapsedMs: 9 };
    const post = vi
      .fn()
      .mockReturnValue(of({ status: true, data: run, message: null, responseCode: '00' }));
    const req = { source: 'x', symbol: 'EURUSD', timeframe: 'H1', lastBars: 500 };
    const r = await firstValueFrom(make({ post } as any).run(req));
    expect(post).toHaveBeenCalledWith('/scripting/run', req, { silent: true });
    expect(r.bars).toHaveLength(1);
    expect(r.compile.declaration?.kind).toBe('strategy');
  });

  it('resolves a refused run to its compile result, keeping a partial run it carries', async () => {
    const onlyCompile = vi
      .fn()
      .mockReturnValue(of({ status: false, data: COMPILE, message: 'm', responseCode: '-11' }));
    const r1 = await firstValueFrom(make({ post: onlyCompile } as any).run({} as any));
    expect(r1.compile.success).toBe(false);
    expect(r1.bars).toBeUndefined();

    const partial = { compile: COMPILE, bars: [{ t: 1, o: 1, h: 1, l: 1, c: 1, v: 1 }] };
    const inError = vi.fn().mockReturnValue(
      throwError(
        () =>
          new HttpErrorResponse({
            status: 400,
            error: { status: false, data: partial, message: 'm', responseCode: '-11' },
          }),
      ),
    );
    const r2 = await firstValueFrom(make({ post: inError } as any).run({} as any));
    expect(r2.bars).toHaveLength(1);
    expect(r2.compile.inputs[0].kind).toBe('textArea');
  });

  it('rejects a refusal without a compile result', async () => {
    const post = vi
      .fn()
      .mockReturnValue(of({ status: false, data: null, message: 'No bars', responseCode: '-14' }));
    await expect(firstValueFrom(make({ post } as any).run({} as any))).rejects.toMatchObject({
      name: 'ScriptingApiError',
      message: 'No bars',
      code: '-14',
    });
  });
});

describe('ScriptingService — chart bars (scripting/chart-bars)', () => {
  // EURUSD 4h on the session grid, summer: blocks open 21/01/05… UTC.
  const H = 3_600_000;
  const T0 = Date.UTC(2026, 9, 6, 13); // Tue 6 Oct 13:00 UTC = 09:00 New York
  const bar = (t: number, forming = false) => ({
    t,
    tc: t + 4 * H,
    o: 1.17,
    h: 1.172,
    l: 1.168,
    c: 1.171,
    v: 900,
    forming,
  });
  const ok = (bars: unknown[]) => ({
    status: true,
    message: null,
    responseCode: '00',
    data: {
      symbol: 'EURUSD',
      timeframe: '240',
      session: '1700-1700:23456',
      timeZone: 'America/New_York',
      bars,
    },
  });

  it('posts the request as given and returns the bars, ascending, with their closes', async () => {
    const post = vi.fn().mockReturnValue(of(ok([bar(T0 - 4 * H), bar(T0, true)])));
    const req = { symbol: 'EURUSD', timeframe: '240', to: null, count: 1500, includeForming: true };
    const r = await firstValueFrom(make({ post } as any).chartBars(req));
    expect(post).toHaveBeenCalledWith('/scripting/chart-bars', req, { silent: true });
    expect(r.session).toBe('1700-1700:23456');
    expect(r.timeZone).toBe('America/New_York');
    expect(r.bars.map((b) => [b.t, b.tc, b.forming])).toEqual([
      [T0 - 4 * H, T0, false],
      [T0, T0 + 4 * H, true],
    ]);
  });

  it('rejects a refusal with the engine code and message (no "empty chart" in its place)', async () => {
    const post = vi
      .fn()
      .mockReturnValue(
        of({ status: false, data: null, message: 'Unknown symbol XXXYYY', responseCode: '-14' }),
      );
    const err = await firstValueFrom(
      make({ post } as any).chartBars({ symbol: 'XXXYYY', timeframe: '1D' }),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ScriptingApiError);
    expect(err).toMatchObject({ code: '-14', message: 'Unknown symbol XXXYYY', isNotFound: true });
  });

  it('rejects a transport failure readably — e.g. an engine without the endpoint yet (404)', async () => {
    const post = vi.fn().mockReturnValue(throwError(() => new HttpErrorResponse({ status: 404 })));
    await expect(
      firstValueFrom(make({ post } as any).chartBars({ symbol: 'EURUSD', timeframe: '240' })),
    ).rejects.toMatchObject({
      httpStatus: 404,
      message: 'The chart bars could not be loaded. (not found)',
    });
  });

  it('normalises: sorted, one bar per open, unusable rows dropped, forming only on the last', () => {
    const r = normaliseChartBars({
      symbol: 'EURUSD',
      timeframe: '240',
      session: '1700-1700:23456',
      timeZone: 'America/New_York',
      bars: [
        bar(T0, true),
        { ...bar(T0 - 8 * H), forming: true }, // only the newest bar can be forming
        { ...bar(T0 - 4 * H), c: Number.NaN }, // a NaN price: dropped
        { ...bar(T0 - 4 * H), c: 1.2 }, // …its good copy stays
        { ...bar(T0 - 12 * H), v: null as unknown as number, tc: undefined as unknown as number },
        null as unknown as ReturnType<typeof bar>,
      ],
    });
    expect(r.bars.map((b) => b.t)).toEqual([T0 - 12 * H, T0 - 8 * H, T0 - 4 * H, T0]);
    expect(r.bars.map((b) => b.forming)).toEqual([false, false, false, true]);
    expect(r.bars[2].c).toBe(1.2);
    expect(r.bars[0].v).toBe(0);
    expect(r.bars[0].tc).toBeNaN(); // no close sent: none invented
  });

  it('reads a missing bar list as no bars', () => {
    expect(normaliseChartBars({ bars: null } as any).bars).toEqual([]);
  });
});

describe('ScriptingService — libraries and strategy scripts', () => {
  it('builds the library URLs', async () => {
    const get = vi
      .fn()
      .mockReturnValue(of({ status: true, data: [], message: null, responseCode: '00' }));
    const del = vi
      .fn()
      .mockReturnValue(of({ status: true, data: true, message: null, responseCode: '00' }));
    const svc = make({ get, delete: del } as any);
    await firstValueFrom(svc.listLibraries({ publisher: ' ola ', name: '' }));
    expect(get).toHaveBeenCalledWith('/scripting/libraries?publisher=ola', { silent: true });
    await firstValueFrom(svc.deleteLibrary(5, true));
    expect(del).toHaveBeenCalledWith('/scripting/libraries/5?force=true', { silent: true });
  });

  it('surfaces a delete conflict as isConflict', async () => {
    const del = vi
      .fn()
      .mockReturnValue(of({ status: false, data: null, message: 'in use', responseCode: '-409' }));
    await expect(
      firstValueFrom(make({ delete: del } as any).deleteLibrary(5)),
    ).rejects.toMatchObject({
      isConflict: true,
      message: 'in use',
    });
  });

  it('attaches the compile result to a refused script save', async () => {
    const put = vi
      .fn()
      .mockReturnValue(
        of({ status: false, data: COMPILE, message: 'PS2003: m', responseCode: '-11' }),
      );
    const svc = make({ put } as any);
    const err = await firstValueFrom(
      svc.updateStrategyScript(3, { source: 's', inputs: {} }),
    ).catch((e) => e);
    expect(put).toHaveBeenCalledWith(
      '/strategy/3/script',
      { source: 's', inputs: {} },
      { silent: true },
    );
    expect(err).toBeInstanceOf(ScriptingApiError);
    expect(err.code).toBe('-11');
    expect(err.compile).toBe(COMPILE);
  });

  it('imports and exports strategies', async () => {
    const post = vi
      .fn()
      .mockReturnValue(of({ status: true, data: 99, message: null, responseCode: '00' }));
    const get = vi.fn().mockReturnValue(
      of({
        status: true,
        data: { fileName: 'a.pine', content: 'x' },
        message: null,
        responseCode: '00',
      }),
    );
    const svc = make({ post, get } as any);
    const body = { content: 'x', symbol: 'EURUSD', timeframe: 'H1', name: null };
    expect(await firstValueFrom(svc.importStrategy(body))).toBe(99);
    expect(post).toHaveBeenCalledWith('/strategy/import', body, { silent: true });
    expect(await firstValueFrom(svc.exportStrategy(4))).toEqual({
      fileName: 'a.pine',
      content: 'x',
    });
    expect(get).toHaveBeenCalledWith('/strategy/4/export', { silent: true });
  });
});

describe('ScriptingService — chart scripts (scripting/indicators)', () => {
  const saved = {
    id: 20,
    name: 'Smart Algo v2',
    kind: 'indicator',
    pineSource: 'src',
    inputs: { 'Display::Colour candles': false },
    createdAt: '2026-10-07T00:00:00Z',
    updatedAt: '2026-10-07T00:00:00Z',
  };

  it('reads one saved script, inputs included', async () => {
    const get = vi
      .fn()
      .mockReturnValue(of({ status: true, data: saved, message: null, responseCode: '00' }));
    expect(await firstValueFrom(make({ get } as any).getChartScript(20))).toEqual(saved);
    expect(get).toHaveBeenCalledWith('/scripting/indicators/20', { silent: true });
  });

  it('rejects a script that is not found with its code', async () => {
    const get = vi
      .fn()
      .mockReturnValue(
        of({ status: false, data: null, message: 'Script 9 not found.', responseCode: '-14' }),
      );
    await expect(firstValueFrom(make({ get } as any).getChartScript(9))).rejects.toMatchObject({
      isNotFound: true,
      message: 'Script 9 not found.',
    });
  });

  it('sends the inputs with an update', async () => {
    const put = vi
      .fn()
      .mockReturnValue(of({ status: true, data: saved, message: null, responseCode: '00' }));
    const body = { name: 'Smart Algo v2', pineSource: 'src', inputs: saved.inputs };
    await firstValueFrom(make({ put } as any).updateChartScript(20, body));
    expect(put).toHaveBeenCalledWith('/scripting/indicators/20', body, { silent: true });
  });
});

describe('helpers', () => {
  it('finds a compile result directly or inside a run result', () => {
    expect(compileResultOf(COMPILE)).toBe(COMPILE);
    expect(compileResultOf({ compile: COMPILE, bars: [] })).toBe(COMPILE);
    expect(compileResultOf({ id: 1 })).toBeNull();
    expect(compileResultOf(null)).toBeNull();
  });

  it('normalises kinds and fills missing arrays', () => {
    expect(normaliseInputKind('Int')).toBe('int');
    expect(normaliseInputKind('text_area')).toBe('textArea');
    expect(normaliseInputKind('???')).toBe('string');
    const n = normaliseCompile({ diagnostics: [{ severity: 'Warning' }] } as any);
    expect(n.inputs).toEqual([]);
    expect(n.declaration).toBeNull();
    expect(n.success).toBe(true);
  });

  it('maps any failure to a ScriptingApiError', () => {
    expect(toScriptingError(new HttpErrorResponse({ status: 404 }), 'Load failed').message).toBe(
      'Load failed (not found)',
    );
    expect(toScriptingError(new Error('boom'), 'x').message).toBe('boom');
    expect(toScriptingError('?', 'fallback').message).toBe('fallback');
  });
});
