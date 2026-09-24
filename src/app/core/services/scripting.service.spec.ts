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
    const get = vi
      .fn()
      .mockReturnValue(
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
    const get = vi
      .fn()
      .mockReturnValue(
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
