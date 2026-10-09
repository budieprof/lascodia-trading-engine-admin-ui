import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { Subject } from 'rxjs';

import type { MarketAnalysisResultDto } from '@core/api/api.types';
import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import { RealtimeService } from '@core/realtime/realtime.service';
import { declareSignalIo } from '@shared/testing/jit-signal-io';

import type { ChartMarker } from '../chart/chart-host.component';
import type { TicketPrefill } from '../trading/ticket-model';
import { ChartAnalysisComponent } from './chart-analysis.component';
import type { ChartAnalysisMonitors } from './chart-analysis.types';

declareSignalIo(ChartAnalysisComponent, {
  inputs: ['host', 'symbol', 'resolution', 'precision', 'lastPrice', 'windowFrom', 'open'],
  outputs: ['markersChange', 'ticket', 'openChange'],
});

const BASE = 'http://test/api/v1/lascodia-trading-engine';
const ok = <T>(data: T) => ({ data, status: true, message: 'Successful', responseCode: '00' });
const refused = (message: string, code: string) => ({
  data: null,
  status: false,
  message,
  responseCode: code,
});

const ANALYSIS: MarketAnalysisResultDto = {
  symbol: 'EURUSD',
  timeframe: 'H1',
  provider: 'p',
  model: 'm',
  llmInvocationId: 37445,
  latencyMs: 1,
  analysis: 'Price sits under a floor that held three times.',
  completedAt: new Date().toISOString(),
  recommendation: null,
  recommendations: [
    {
      action: 'Buy',
      entryPrice: 1.1495,
      stopLoss: 1.144,
      takeProfit: 1.158,
      confidence: 0.62,
      rationale: 'Floor held.',
    },
  ],
};

const MONITORS: ChartAnalysisMonitors = {
  symbol: 'EURUSD',
  monitorsTruncated: false,
  eventsTruncated: false,
  monitors: [
    {
      id: 1188,
      status: 'Active',
      origin: 'spot-watch',
      timeframe: 'H1',
      intentText: 'Wait for the dip and reclaim of 1.1440',
      createdAtUtc: '2026-10-09T08:00:00Z',
      expiresAtUtc: '2026-10-10T08:00:00Z',
      isStructureWatch: true,
      scriptStep: 1,
      levels: [{ price: 1.144, kind: 'trigger', label: 'wakes when price goes above' }],
    },
  ],
  events: [{ monitorId: 1188, kind: 'Fired', occurredAtUtc: '2026-10-09T10:00:00Z', fired: true }],
};

describe('ChartAnalysisComponent', () => {
  let fixture: ComponentFixture<ChartAnalysisComponent>;
  let http: HttpTestingController;
  let el: HTMLElement;
  let markers: ChartMarker[];
  let tickets: TicketPrefill[];
  const byId = <T extends Element>(id: string) => el.querySelector(`[data-testid="${id}"]`) as T;

  const flushStart = (latest: unknown = ok(ANALYSIS)) => {
    http
      .expectOne((r) => r.url.startsWith(`${BASE}/market-data/analysis-monitors/chart?`))
      .flush(ok(MONITORS));
    http.expectOne((r) => r.url.startsWith(`${BASE}/market-data/analyze/latest?`)).flush(latest);
    fixture.detectChanges();
  };

  beforeEach(() => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({
      imports: [ChartAnalysisComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: RUNTIME_CONFIG, useValue: { apiBaseUrl: 'http://test' } },
        { provide: RealtimeService, useValue: { on: () => new Subject() } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(ChartAnalysisComponent);
    fixture.componentRef.setInput('symbol', 'EURUSD');
    fixture.componentRef.setInput('resolution', '60');
    fixture.componentRef.setInput('precision', 5);
    fixture.componentRef.setInput('lastPrice', 1.14612);
    fixture.componentRef.setInput('open', true);
    markers = [];
    tickets = [];
    fixture.componentInstance.markersChange.subscribe((m) => (markers = m));
    fixture.componentInstance.ticket.subscribe((t) => tickets.push(t));
    fixture.detectChanges();
    el = fixture.nativeElement as HTMLElement;
  });

  afterEach(() => {
    fixture.destroy();
    http.verify();
    vi.useRealTimers();
  });

  it('shows the newest analysis (no AI call), its trade, the live watches and their fire markers', () => {
    flushStart();
    expect(byId('analysis-result').textContent).toContain('TRADE NOW');
    expect(byId('analysis-result').textContent).toContain('#37445');
    expect(byId('chart-watch').textContent).toContain('Structure Watch on step 1');
    expect(markers.map((m) => m.text)).toEqual(['W1188 fired']);

    (
      Array.from(el.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Open in ticket'),
      ) as HTMLButtonElement
    ).click();
    expect(tickets).toEqual([{ direction: 'Buy', entry: 1.1495, stop: 1.144, target: 1.158 }]);
  });

  it('analyses on demand through the existing endpoint and never files a signal from the chart', () => {
    flushStart(refused('Never analysed', '-14'));
    expect(el.textContent).toContain('No analysis of EURUSD H1 yet.');

    byId<HTMLButtonElement>('analyse-spot').click();
    fixture.detectChanges();
    expect(byId('analyse-running')).toBeTruthy();
    const req = http.expectOne(`${BASE}/market-data/analyze`);
    expect(req.request.body).toMatchObject({
      symbol: 'EURUSD',
      timeframe: 'H1',
      generateSignals: false,
    });
    req.flush(
      ok({
        ...ANALYSIS,
        recommendations: [{ ...ANALYSIS.recommendations![0], action: 'Hold' }],
        armedMonitorIds: [1190],
      }),
    );
    http
      .expectOne((r) => r.url.startsWith(`${BASE}/market-data/analysis-monitors/chart?`))
      .flush(ok(MONITORS));
    fixture.detectChanges();
    expect(byId('analysis-result').textContent).toContain('WATCH');
    expect(byId('analysis-result').textContent).toContain('W1190');
  });

  it('"Watch this" arms a Structure Watch with a contract script through the monitor path', async () => {
    flushStart();
    const cmp = fixture.componentInstance;
    cmp.watchOpen.set(true);
    fixture.detectChanges();
    expect(cmp.form().level).toBe(1.14612);
    cmp.patchForm({ template: 'breakRetestUp', level: 1.15, calledOff: 1.145, side: 'Buy' });

    const done = cmp.armWatch();
    const req = http.expectOne(`${BASE}/market-data/analysis-monitors`);
    const body = req.request.body as Record<string, unknown>;
    expect(body).toMatchObject({
      symbol: 'EURUSD',
      timeframe: 'H1',
      triggerSpecJson: '{"v":2,"metric":"scriptready","op":"above","value":0}',
      invalidationSpecJson: '{"v":2,"metric":"scriptbroken","op":"above","value":0}',
      actionSpecJson: '{"steps":[{"type":"notify"}]}',
      maxActionTier: 0,
      expectStepNow: 0,
      plannedDirection: 'Buy',
      deliverTo: ['bell', 'push'],
    });
    expect(String(body['scriptSource'])).toContain('armedAt = input.time(0, "armedAt")');
    req.flush(ok({ id: 1201 }));
    http
      .expectOne((r) => r.url.startsWith(`${BASE}/market-data/analysis-monitors/chart?`))
      .flush(ok(MONITORS));
    expect(await done).toEqual({
      ok: true,
      message: 'Armed W1201: break above, then a retest that holds (buy setup) on EURUSD H1.',
    });
  });

  it('says why the engine refused a watch', async () => {
    flushStart();
    const cmp = fixture.componentInstance;
    cmp.patchForm({ level: 1.15 });
    const done = cmp.armWatch();
    http
      .expectOne(`${BASE}/market-data/analysis-monitors`)
      .flush(refused('The script already says ready — it would fire at once.', '-20'));
    expect(await done).toEqual({
      ok: false,
      message: 'The script already says ready — it would fire at once.',
    });
    fixture.detectChanges();
    cmp.watchOpen.set(true);
    fixture.detectChanges();
    expect(byId('watch-result').textContent).toContain('already says ready');
  });
});
