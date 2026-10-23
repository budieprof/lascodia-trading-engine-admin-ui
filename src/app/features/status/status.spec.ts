import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom, of, throwError } from 'rxjs';
import { afterEach, describe, expect, it } from 'vitest';

import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import { ensureTestBed } from '@core/testing/zoneless-test-bed';
import { ThemeService } from '@core/theme/theme.service';
import { StatusApiService } from './status-api.service';
import { StatusPageComponent } from './status-page.component';
import {
  headline,
  levelLabel,
  levelTone,
  normaliseLevel,
  orderComponents,
  parseDocument,
  updatedText,
} from './status.logic';
import type { PublicStatusDocument } from './status.types';

ensureTestBed();
afterEach(() => TestBed.resetTestingModule());

const doc: PublicStatusDocument = {
  status: 'degraded',
  message: 'Some services are degraded.',
  generatedAtUtc: '2026-10-21T12:00:00Z',
  components: [
    { id: 'api', name: 'Trading API', status: 'operational', message: 'Responding.' },
    {
      id: 'marketData',
      name: 'Market data',
      status: 'degraded',
      message: 'Live prices are delayed.',
    },
    { id: 'database', name: 'Database', status: 'operational', message: 'Reachable.' },
    {
      id: 'brokerConnectivity',
      name: 'Broker connectivity',
      status: 'idle',
      message: 'Markets closed.',
    },
  ],
};

describe('status logic', () => {
  it('reads an unknown level as degraded, never as fine', () => {
    expect(normaliseLevel('operational')).toBe('operational');
    expect(normaliseLevel('maintenance')).toBe('degraded');
    expect(normaliseLevel(undefined)).toBe('degraded');
  });

  it('labels and colours each level', () => {
    expect(levelLabel('idle')).toBe('Markets closed');
    expect(levelTone('outage')).toBe('danger');
    expect(levelTone('idle')).toBe('neutral');
  });

  it('puts problems first and keeps the engine order otherwise', () => {
    expect(orderComponents(doc.components).map((c) => c.id)).toEqual([
      'marketData',
      'api',
      'database',
      'brokerConnectivity',
    ]);
  });

  it('says when the status service cannot be reached', () => {
    expect(headline({ kind: 'unreachable', lastGood: null })).toEqual({
      text: 'The status service cannot be reached.',
      tone: 'danger',
    });
    expect(headline({ kind: 'ready', doc }).tone).toBe('warning');
  });

  it('writes the age of the answer', () => {
    const at = Date.parse('2026-10-21T12:00:00Z');
    expect(updatedText('2026-10-21T12:00:00Z', at + 12_000)).toBe('Updated 12 s ago');
    expect(updatedText('2026-10-21T12:00:00Z', at + 3 * 60_000)).toBe('Updated 3 min ago');
    expect(updatedText('', at)).toBe('');
  });

  it('refuses a malformed document instead of rendering half of it', () => {
    expect(parseDocument(null)).toBeNull();
    expect(parseDocument({ status: 'operational' })).toBeNull();
    const parsed = parseDocument({ ...doc, components: [...doc.components, { id: 7 }, null] });
    expect(parsed?.components).toHaveLength(4);
  });
});

describe('StatusApiService', () => {
  it('reads /health/status at the server root, without the console interceptors', async () => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: RUNTIME_CONFIG, useValue: { apiBaseUrl: 'http://engine.test' } },
      ],
    });
    const svc = TestBed.inject(StatusApiService);
    const ctl = TestBed.inject(HttpTestingController);

    const answer = firstValueFrom(svc.status());
    const req = ctl.expectOne('http://engine.test/health/status');
    expect(req.request.headers.has('Authorization')).toBe(false);
    req.flush(doc);
    expect((await answer).components).toHaveLength(4);
    ctl.verify();
  });
});

describe('StatusPageComponent', () => {
  function page(status: () => unknown) {
    TestBed.configureTestingModule({
      providers: [
        { provide: StatusApiService, useValue: { status } },
        { provide: ThemeService, useValue: {} },
      ],
    });
    const p = TestBed.runInInjectionContext(() => new StatusPageComponent());
    p.ngOnInit();
    return p;
  }

  it('shows the engine document, problems first', () => {
    const p = page(() => of(doc));
    expect(p.view().kind).toBe('ready');
    expect(p.banner().text).toBe('Some services are degraded.');
    expect(p.components()[0].id).toBe('marketData');
  });

  it('says the service cannot be reached when the engine does not answer', () => {
    const p = page(() => throwError(() => new Error('down')));
    expect(p.view().kind).toBe('unreachable');
    expect(p.banner().tone).toBe('danger');
    expect(p.doc()).toBeNull();
  });
});
