import { afterEach, describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';

import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import { declareSignalIo } from '@shared/testing/jit-signal-io';
import { ConfigHashBadgeComponent } from '../components/config-hash-badge/config-hash-badge.component';
import { ExecutionEvidenceCardComponent } from './execution-evidence-card.component';

declareSignalIo(ExecutionEvidenceCardComponent, {
  inputs: ['strategyId', 'symbol', 'currentHash'],
});
declareSignalIo(ConfigHashBadgeComponent, { inputs: ['hash', 'currentHash'] });

const BASE = 'http://test/api/v1/lascodia-trading-engine';
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('ExecutionEvidenceCardComponent (U12 — S09, C4, C7, C6)', () => {
  let http: HttpTestingController;

  afterEach(() => http.verify());

  it('shows fills by session and says which views the engine does not offer yet — nothing invented', async () => {
    TestBed.configureTestingModule({
      imports: [ExecutionEvidenceCardComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: RUNTIME_CONFIG, useValue: { apiBaseUrl: 'http://test' } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(ExecutionEvidenceCardComponent);
    fixture.componentRef.setInput('strategyId', 9);
    fixture.componentRef.setInput('symbol', 'EURUSD');
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;

    http
      .expectOne(`${BASE}/strategy/9/sequential-test`)
      .flush('not found', { status: 404, statusText: 'Not Found' });
    http
      .expectOne(`${BASE}/execution-quality/calibration?symbol=EURUSD`)
      .flush('', { status: 404, statusText: 'Not Found' });
    http.expectOne(`${BASE}/broker-symbol-spec/history?symbol=EURUSD`).flush({
      data: [{ brokerKey: 'account:1', validFromUtc: '2026-11-01T00:00:00', stopsLevel: 10 }],
      status: true,
      message: 'Successful',
      responseCode: '00',
    });
    http.expectOne(`${BASE}/execution-quality/list`).flush({
      data: {
        pager: {},
        data: [
          {
            session: 'London',
            slippagePips: 0.2,
            submitToFillMs: 120,
            recordedAt: '2026-11-01T10:00:00',
          },
          {
            session: 'London',
            slippagePips: 0.6,
            submitToFillMs: 180,
            recordedAt: '2026-11-01T11:00:00',
          },
        ],
      },
      status: true,
      message: 'Successful',
      responseCode: '00',
    });
    await settle();
    fixture.detectChanges();
    const text = el.textContent!;
    expect(text.match(/does not offer this view yet/g)).toHaveLength(2);
    expect(text).toContain('as the EA reported it');
    expect(text).toContain('stopsLevel');
    const rows = [
      ...el.querySelectorAll('table[aria-label="Execution quality by session"] tbody tr'),
    ];
    expect(rows.map((r) => r.querySelector('th')!.textContent!.trim())).toEqual(['All', 'London']);
    expect(rows[0].textContent).toContain('0.40');
  });
});
