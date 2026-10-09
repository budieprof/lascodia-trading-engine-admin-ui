import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Subject } from 'rxjs';

import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import { RealtimeService, type RealtimeEventName } from '@core/realtime/realtime.service';
import { declareSignalIo } from '@shared/testing/jit-signal-io';

import { ChartScriptAlertsTabComponent } from './chart-script-alerts-tab.component';
import { ChartScriptAlertFormComponent } from './chart-script-alert-form.component';
import type { ChartScriptAlertDto } from './chart-script-alerts.types';

declareSignalIo(ChartScriptAlertsTabComponent, { inputs: ['symbol', 'allSymbols', 'focusId'] });
declareSignalIo(ChartScriptAlertFormComponent, { inputs: ['target', 'edit'], outputs: ['saved', 'cancelled'] });

const BASE = 'http://test/api/v1/lascodia-trading-engine';
const ok = <T>(data: T) => ({ data, status: true, message: 'Successful', responseCode: '00' });

class FakeRealtime {
  readonly fired = new Subject<unknown>();
  on(name: RealtimeEventName) {
    return name === 'alertFired' ? this.fired.asObservable() : new Subject<unknown>().asObservable();
  }
}

function dto(over: Partial<ChartScriptAlertDto> = {}): ChartScriptAlertDto {
  const now = new Date().toISOString();
  return {
    id: 1,
    name: null,
    displayName: 'EMA pair',
    chartScriptId: 45,
    scriptName: 'EMA pair',
    scriptRevision: 'a',
    currentScriptRevision: 'a',
    scriptChanged: false,
    scriptMissing: false,
    inputs: null,
    symbols: ['EURUSD'],
    watchlistId: null,
    watchlistName: null,
    timeframe: '60',
    alertKey: 'Cross up',
    frequency: 'once_per_bar',
    channels: ['InApp'],
    webhookUrl: null,
    messageTemplate: null,
    expiresAtUtc: null,
    isEnabled: true,
    status: 'Active',
    statusNote: 'Watching EURUSD on 60.',
    statusAt: now,
    disabledReason: null,
    disabledAt: null,
    armedAtUtc: now,
    lastFiredAt: null,
    fireCount: 0,
    lastDeliveryError: null,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

describe('ChartScriptAlertsTabComponent (SS-I1)', () => {
  let fixture: ComponentFixture<ChartScriptAlertsTabComponent>;
  let http: HttpTestingController;
  let realtime: FakeRealtime;
  let el: HTMLElement;

  const q = <T extends Element>(sel: string) => el.querySelector(sel) as T;
  const rows = () => [...el.querySelectorAll('[data-script-alert-id]')];
  const button = (row: Element, text: string) =>
    [...row.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) as HTMLButtonElement;

  function render(list: ChartScriptAlertDto[], inputs: Record<string, unknown> = {}): void {
    fixture = TestBed.createComponent(ChartScriptAlertsTabComponent);
    fixture.componentRef.setInput('symbol', 'EURUSD');
    for (const [k, v] of Object.entries(inputs)) fixture.componentRef.setInput(k, v);
    fixture.detectChanges();
    http.expectOne(`${BASE}/scripting/alerts`).flush(ok(list));
    fixture.detectChanges();
    el = fixture.nativeElement as HTMLElement;
  }

  beforeEach(() => {
    realtime = new FakeRealtime();
    TestBed.configureTestingModule({
      imports: [ChartScriptAlertsTabComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: RUNTIME_CONFIG, useValue: { apiBaseUrl: 'http://test' } },
        { provide: RealtimeService, useValue: realtime },
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    fixture?.destroy();
    http.verify();
  });

  it('lists this symbol’s script alerts with what the engine does with each', () => {
    render([dto(), dto({ id: 2, symbols: ['GBPUSD'], displayName: 'Other' })]);
    expect(rows().map((r) => r.getAttribute('data-script-alert-id'))).toEqual(['1']);
    expect(q('[data-testid="sat-status"]').textContent).toContain('Watching EURUSD on 60.');
  });

  it('says when the chart script changed and re-arms it with the current version', () => {
    render([dto({ scriptChanged: true })]);
    expect(q('[data-testid="sat-changed"]').textContent).toContain('changed since this alert was armed');
    (q('[data-testid="sat-changed"] button') as HTMLButtonElement).click();
    const put = http.expectOne(`${BASE}/scripting/alerts/1`);
    expect(put.request.method).toBe('PUT');
    expect(put.request.body).toMatchObject({ rearm: true, alertKey: 'Cross up', symbols: ['EURUSD'], timeframe: '60' });
    put.flush(ok(dto({ scriptChanged: false })));
    fixture.detectChanges();
    expect(q('[data-testid="sat-changed"]')).toBeNull();
  });

  it('pauses, resumes and shows a refusal in the engine’s words', () => {
    render([dto()]);
    button(rows()[0], 'Pause').click();
    http.expectOne(`${BASE}/scripting/alerts/1/pause`).flush(ok(dto({ isEnabled: false, status: 'Paused' })));
    fixture.detectChanges();
    button(rows()[0], 'Resume').click();
    http
      .expectOne(`${BASE}/scripting/alerts/1/resume`)
      .flush({ data: null, status: false, message: 'The alert has expired — edit it with a later expiry.', responseCode: '-11' });
    fixture.detectChanges();
    expect(el.textContent).toContain('The alert has expired');
  });

  it('a fire re-reads the list (counts move, a once alert pauses itself)', () => {
    render([dto()]);
    realtime.fired.next({ source: 'chart-script', alertId: 1 });
    http.expectOne(`${BASE}/scripting/alerts`).flush(ok([dto({ fireCount: 1, lastFiredAt: new Date().toISOString() })]));
    fixture.detectChanges();
    expect(el.textContent).toContain('fired');
  });
});
