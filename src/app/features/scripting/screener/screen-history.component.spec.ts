import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';

import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import { declareSignalIo } from '@shared/testing/jit-signal-io';

import { ScreenHistoryComponent } from './screen-history.component';
import type { ScreenRunDto } from './screens.types';

declareSignalIo(ScreenHistoryComponent, {
  inputs: ['screenId', 'refreshKey'],
  outputs: ['runOpened'],
});

const BASE = 'http://test/api/v1/lascodia-trading-engine';
const ok = <T>(data: T) => ({ data, status: true, message: 'Successful', responseCode: '00' });
const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
const H = Date.UTC(2026, 9, 9, 12);

function run(id: number, over: Record<string, unknown> = {}) {
  return {
    id,
    screenId: 5,
    trigger: 'Scheduled',
    barTimeMs: H,
    startedAt: '2026-10-09T13:00:02Z',
    completedAt: '2026-10-09T13:00:04Z',
    durationMs: 1800,
    symbols: 10,
    matched: 3,
    errors: 1,
    entered: 2,
    left: 1,
    matchedSymbols: ['EURUSD', 'GBPUSD', 'AUDUSD'],
    enteredSymbols: ['EURUSD', 'AUDUSD'],
    leftSymbols: ['USDJPY'],
    hasRows: true,
    notes: [],
    error: null,
    alertsQueued: 3,
    ...over,
  };
}

describe('ScreenHistoryComponent (SS-I6)', () => {
  let fixture: ComponentFixture<ScreenHistoryComponent>;
  let http: HttpTestingController;
  let el: HTMLElement;

  beforeEach(async () => {
    TestBed.configureTestingModule({
      imports: [ScreenHistoryComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: RUNTIME_CONFIG, useValue: { apiBaseUrl: 'http://test' } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(ScreenHistoryComponent);
    fixture.componentRef.setInput('screenId', 5);
    fixture.detectChanges();
    el = fixture.nativeElement as HTMLElement;
    http.expectOne(`${BASE}/scripting/screens/5/runs?limit=30`).flush(
      ok([
        run(41),
        run(40, {
          trigger: 'Manual',
          hasRows: false,
          error: 'Busy: another run of this screen is going.',
        }),
      ]),
    );
    await settle();
    fixture.detectChanges();
  });

  afterEach(() => http.verify());

  it('lists the runs with who entered and left', () => {
    const first = el.querySelector('tr[data-run="41"]')!.textContent!;
    expect(first).toContain('Scheduled');
    expect(first).toContain('3 of 10 matched · 2 entered · 1 left · 1 error');
    expect(first).toContain('EURUSD, AUDUSD');
    expect(first).toContain('USDJPY');
    const second = el.querySelector('tr[data-run="40"]')!;
    expect(second.textContent).toContain('Busy: another run');
    expect(second.querySelector('button')).toBeNull(); // its rows are gone
  });

  it('opens a run’s rows', async () => {
    let opened: ScreenRunDto | null = null;
    fixture.componentInstance.runOpened.subscribe((r) => (opened = r));
    (el.querySelector('tr[data-run="41"] button') as HTMLButtonElement).click();
    http.expectOne(`${BASE}/scripting/screens/5/runs/41`).flush(ok({ ...run(41), rows: [] }));
    await settle();
    expect(opened!.id).toBe(41);
  });

  it('reads the alert log when its tab opens, once', async () => {
    (el.querySelector('[data-testid="tab-alerts"]') as HTMLButtonElement).click();
    http.expectOne(`${BASE}/scripting/screens/5/alerts?limit=100`).flush(
      ok([
        {
          id: 901,
          screenId: 5,
          runId: 41,
          symbol: 'EURUSD',
          timeframe: '60',
          kind: 'Entered',
          barTimeMs: H,
          channel: 'Telegram',
          title: 'EURUSD entered RSI hot',
          message: 'EURUSD now matches RSI hot',
          status: 'Failed',
          attempts: 3,
          lastError: 'Telegram is not configured',
          createdAt: '2026-10-09T13:00:04Z',
          deliveredAt: null,
        },
      ]),
    );
    await settle();
    fixture.detectChanges();
    const row = el.querySelector('tr[data-alert="901"]')!.textContent!;
    expect(row).toContain('EURUSD H1');
    expect(row).toContain('Started matching');
    expect(row).toContain('Failed');
    expect(row).toContain('Telegram is not configured');

    (el.querySelector('[data-testid="tab-runs"]') as HTMLButtonElement).click();
    (el.querySelector('[data-testid="tab-alerts"]') as HTMLButtonElement).click();
    http.expectNone(`${BASE}/scripting/screens/5/alerts?limit=100`);
  });
});
