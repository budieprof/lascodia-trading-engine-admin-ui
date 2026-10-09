import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Subject } from 'rxjs';

import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import { RealtimeService, type RealtimeEventName } from '@core/realtime/realtime.service';
import { declareSignalIo } from '@shared/testing/jit-signal-io';

import { ChartScriptAlertFormComponent, type ScriptAlertTarget } from './chart-script-alert-form.component';
import type { ChartScriptAlertDto } from './chart-script-alerts.types';

declareSignalIo(ChartScriptAlertFormComponent, { inputs: ['target', 'edit'], outputs: ['saved', 'cancelled'] });

const BASE = 'http://test/api/v1/lascodia-trading-engine';
const ok = <T>(data: T) => ({ data, status: true, message: 'Successful', responseCode: '00' });

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
}

const TARGET: ScriptAlertTarget = {
  chartScriptId: 45,
  scriptName: 'EMA pair',
  alertConditions: ['Cross up', 'Cross down'],
  callsAlert: true,
  isStrategy: false,
  symbol: 'eurusd',
  timeframe: '60',
  inputs: { Fast: 12 },
};

function dto(over: Partial<ChartScriptAlertDto> = {}): ChartScriptAlertDto {
  return {
    id: 9,
    name: null,
    displayName: 'EMA pair',
    chartScriptId: 45,
    scriptName: 'EMA pair',
    scriptRevision: 'a',
    currentScriptRevision: 'b',
    scriptChanged: true,
    scriptMissing: false,
    inputs: null,
    symbols: ['EURUSD'],
    watchlistId: null,
    watchlistName: null,
    timeframe: '240',
    alertKey: 'Cross up',
    frequency: 'once_per_bar_close',
    channels: ['InApp', 'Telegram'],
    webhookUrl: null,
    messageTemplate: null,
    expiresAtUtc: null,
    isEnabled: true,
    status: 'Active',
    statusNote: null,
    statusAt: null,
    disabledReason: null,
    disabledAt: null,
    armedAtUtc: '2026-10-09T08:00:00Z',
    lastFiredAt: null,
    fireCount: 0,
    lastDeliveryError: null,
    createdAt: '2026-10-09T08:00:00Z',
    updatedAt: '2026-10-09T08:00:00Z',
    ...over,
  };
}

describe('ChartScriptAlertFormComponent (PC-I14, SS-I1)', () => {
  let fixture: ComponentFixture<ChartScriptAlertFormComponent>;
  let http: HttpTestingController;
  let el: HTMLElement;

  const q = <T extends Element>(sel: string) => el.querySelector(sel) as T;

  function render(inputs: Record<string, unknown>): void {
    fixture = TestBed.createComponent(ChartScriptAlertFormComponent);
    for (const [k, v] of Object.entries(inputs)) fixture.componentRef.setInput(k, v);
    fixture.detectChanges();
    el = fixture.nativeElement as HTMLElement;
    // The operator's watchlists, for "Watch: a watchlist".
    http.expectOne(`${BASE}/chart-watchlist`).flush(ok([{ id: 3, name: 'Majors', isActive: true, sortOrder: 0, sections: [] }]));
    fixture.detectChanges();
  }

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [ChartScriptAlertFormComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: RUNTIME_CONFIG, useValue: { apiBaseUrl: 'http://test' } },
        { provide: RealtimeService, useValue: new FakeRealtime() },
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('offers the script’s own alerts and arms the first on the chart’s symbol and timeframe', () => {
    render({ target: TARGET });
    const options = [...q<HTMLSelectElement>('[data-testid="saf-key"]').options].map((o) => o.textContent?.trim());
    expect(options).toEqual(['“Cross up”', '“Cross down”', 'Any alert() call']);
    expect(q<HTMLInputElement>('[data-testid="saf-symbols"]').value).toBe('EURUSD');

    let saved: ChartScriptAlertDto | null = null;
    fixture.componentInstance.saved.subscribe((a) => (saved = a));
    q<HTMLFormElement>('form').dispatchEvent(new Event('submit'));
    const post = http.expectOne(`${BASE}/scripting/alerts`);
    expect(post.request.method).toBe('POST');
    expect(post.request.body).toEqual({
      name: null,
      alertKey: 'Cross up',
      timeframe: '60',
      frequency: 'once_per_bar',
      channels: ['InApp'],
      webhookUrl: null,
      messageTemplate: null,
      expiresAtUtc: null,
      symbols: ['EURUSD'],
      chartScriptId: 45,
      inputs: { Fast: 12 },
    });
    post.flush(ok(dto({ id: 77 })));
    expect(saved!.id).toBe(77);
  });

  it('says in the engine’s words why an alert is refused', () => {
    render({ target: TARGET });
    q<HTMLFormElement>('form').dispatchEvent(new Event('submit'));
    http
      .expectOne(`${BASE}/scripting/alerts`)
      .flush({ data: null, status: false, message: 'The engine has no market data for XAUXAG.', responseCode: '-11' });
    fixture.detectChanges();
    expect(q('[data-testid="saf-server-error"]').textContent).toContain('no market data for XAUXAG');
  });

  it('a script with nothing to alert on cannot be armed', () => {
    render({ target: { ...TARGET, alertConditions: [], callsAlert: false } });
    expect(q('[data-testid="saf-problem"]').textContent).toContain('nothing to alert on');
    expect(q<HTMLButtonElement>('[data-testid="saf-save"]').disabled).toBe(true);
  });

  it('a strategy alerts on its order fills', () => {
    render({ target: { ...TARGET, isStrategy: true, callsAlert: false } });
    const options = [...q<HTMLSelectElement>('[data-testid="saf-key"]').options].map((o) => o.value);
    expect(options).toEqual(['order-fills']);
  });

  it('edits an alert and can re-arm it with the script’s current version', () => {
    render({ edit: dto() });
    expect(el.textContent).toContain('changed since this alert was armed');
    const rearm = q<HTMLInputElement>('[data-testid="saf-rearm"] input');
    rearm.checked = true;
    rearm.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    q<HTMLFormElement>('form').dispatchEvent(new Event('submit'));
    const put = http.expectOne(`${BASE}/scripting/alerts/9`);
    expect(put.request.method).toBe('PUT');
    expect(put.request.body).toMatchObject({
      alertKey: 'Cross up',
      timeframe: '240',
      frequency: 'once_per_bar_close',
      channels: ['InApp', 'Telegram'],
      symbols: ['EURUSD'],
      rearm: true,
    });
    put.flush(ok(dto({ scriptChanged: false })));
  });
});
