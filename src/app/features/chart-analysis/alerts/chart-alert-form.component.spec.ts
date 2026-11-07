import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Subject } from 'rxjs';

import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import { RealtimeService, type RealtimeEventName } from '@core/realtime/realtime.service';
import { declareSignalIo } from '@shared/testing/jit-signal-io';

import { ChartAlertFormComponent } from './chart-alert-form.component';
import { ChartAlertsService } from './chart-alerts.service';
import type { ChartAlertDto } from './chart-alerts.types';
import type { MetricAvailability } from './metric-alerts';
import { MetricAvailabilityService } from './metric-availability.service';

/** What the fake availability service answers per symbol (UF04). */
const AVAILABLE: Record<string, MetricAvailability[]> = {
  'BTC-USDT-PERP': [
    { kind: 'Funding', sources: [{ sourceId: 'crypto-okx', label: 'OKX' }], current: 0.0074, currentSource: 'crypto-okx' },
    { kind: 'Liquidations', sources: [{ sourceId: 'crypto-okx', label: 'OKX' }], current: null, currentSource: 'crypto-okx' },
  ],
};

declareSignalIo(ChartAlertFormComponent, {
  inputs: ['symbol', 'timeframe', 'precision', 'lastClose', 'presetPrice', 'edit', 'copy', 'draft'],
  outputs: ['saved', 'cancelled'],
});

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
  emit(name: RealtimeEventName, payload: unknown): void {
    this.subjects.get(name)?.next(payload);
  }
}

function dto(over: Partial<ChartAlertDto> = {}): ChartAlertDto {
  return {
    id: 31,
    name: 'Breakdown',
    symbol: 'EURUSD',
    timeframe: '60',
    kind: 'Price',
    side: 'Ask',
    condition: 'CrossingDown',
    price: 1.08,
    upperPrice: null,
    geometry: null,
    drawingId: null,
    drawingKind: null,
    frequency: 'once_per_bar',
    expiresAtUtc: null,
    channels: ['InApp', 'Telegram'],
    messageTemplate: null,
    severity: 'High',
    status: 'Active',
    statusReason: null,
    createdAt: '2026-10-09T08:00:00Z',
    updatedAt: '2026-10-09T08:00:00Z',
    lastFiredAt: null,
    fireCount: 0,
    ...over,
  };
}

describe('ChartAlertFormComponent', () => {
  let fixture: ComponentFixture<ChartAlertFormComponent>;
  let http: HttpTestingController;
  let realtime: FakeRealtime;
  let el: HTMLElement;

  const q = <T extends Element>(sel: string) => el.querySelector(sel) as T;
  const selected = (testId: string) => q<HTMLSelectElement>(`[data-testid="${testId}"]`).value;

  function render(inputs: Record<string, unknown> = {}): void {
    fixture = TestBed.createComponent(ChartAlertFormComponent);
    fixture.componentRef.setInput('symbol', 'EURUSD');
    fixture.componentRef.setInput('timeframe', '60');
    fixture.componentRef.setInput('precision', 5);
    fixture.componentRef.setInput('lastClose', 1.08);
    for (const [k, v] of Object.entries(inputs)) fixture.componentRef.setInput(k, v);
    fixture.detectChanges();
    el = fixture.nativeElement as HTMLElement;
  }

  function type(testId: string, value: string): void {
    const input = q<HTMLInputElement>(`[data-testid="${testId}"]`);
    input.value = value;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  }

  beforeEach(() => {
    realtime = new FakeRealtime();
    TestBed.configureTestingModule({
      imports: [ChartAlertFormComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: RUNTIME_CONFIG, useValue: { apiBaseUrl: 'http://test' } },
        { provide: RealtimeService, useValue: realtime },
        {
          provide: MetricAvailabilityService,
          useValue: { forSymbol: (sym: string) => Promise.resolve(AVAILABLE[sym.toUpperCase()] ?? []) },
        },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    // The service listens to the price stream: the live EURUSD quote is bid 1.08542 / ask 1.08551.
    TestBed.inject(ChartAlertsService);
    realtime.emit('priceUpdated', { symbol: 'EURUSD', bid: 1.08542, ask: 1.08551 });
  });

  afterEach(() => http.verify());

  it('starts 10 points beyond the live bid, crossing above, in app, once (SP-02)', () => {
    render();
    expect(q<HTMLInputElement>('[data-testid="caf-level"]').valueAsNumber).toBe(1.08552);
    expect(selected('caf-direction')).toBe('above');
    expect(selected('caf-side')).toBe('Bid');
    expect(selected('caf-frequency')).toBe('once');
    expect(el.textContent).toContain('Now: bid 1.08542');
    expect(q('[data-testid="caf-problem"]')).toBeNull();
  });

  it('moves the default with the side and the direction until a level is typed', () => {
    render();
    const side = q<HTMLSelectElement>('[data-testid="caf-side"]');
    side.value = 'Ask';
    side.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(q<HTMLInputElement>('[data-testid="caf-level"]').valueAsNumber).toBe(1.08561);
    const direction = q<HTMLSelectElement>('[data-testid="caf-direction"]');
    direction.value = 'below';
    direction.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(q<HTMLInputElement>('[data-testid="caf-level"]').valueAsNumber).toBe(1.08541);
  });

  it('refuses a level the price has already reached, in the engine’s words (SP-02)', () => {
    render();
    type('caf-level', '1.0854');
    expect(q('[data-testid="caf-problem"]').textContent).toContain(
      'EURUSD bid is 1.08542, already at or above 1.08540',
    );
    expect(q<HTMLButtonElement>('[data-testid="caf-save"]').disabled).toBe(true);
  });

  it('watches the way price must travel to a level picked on the chart', () => {
    render({ presetPrice: 1.085 });
    expect(selected('caf-direction')).toBe('below');
    expect(q<HTMLInputElement>('[data-testid="caf-level"]').valueAsNumber).toBe(1.085);
  });

  it('shows an edited alert as it is', () => {
    render({ edit: dto() });
    expect(selected('caf-direction')).toBe('below');
    expect(selected('caf-side')).toBe('Ask');
    expect(selected('caf-frequency')).toBe('once_per_bar');
    expect(q<HTMLInputElement>('[data-testid="caf-level"]').valueAsNumber).toBe(1.08);
    expect(el.textContent).toContain('Edit alert · EURUSD');
  });

  it('creates the alert and hands it back', () => {
    render();
    let saved: ChartAlertDto | null = null;
    fixture.componentInstance.saved.subscribe((a) => (saved = a));
    q<HTMLFormElement>('form').dispatchEvent(new Event('submit'));
    const post = http.expectOne(`${BASE}/chart-alert`);
    expect(post.request.method).toBe('POST');
    expect(post.request.body).toEqual({
      name: null,
      symbol: 'EURUSD',
      timeframe: '60',
      kind: 'Price',
      side: 'Bid',
      condition: 'CrossingUp',
      price: 1.08552,
      upperPrice: null,
      geometry: null,
      drawingId: null,
      drawingKind: null,
      frequency: 'once',
      expiresAtUtc: null,
      channels: ['InApp'],
      messageTemplate: null,
      severity: 'Medium',
    });
    post.flush(ok(dto({ id: 32, condition: 'CrossingUp', price: 1.08552 })));
    expect(saved).not.toBeNull();
    expect(saved!.id).toBe(32);
  });

  it('shows the engine’s refusal', () => {
    render();
    q<HTMLFormElement>('form').dispatchEvent(new Event('submit'));
    http
      .expectOne(`${BASE}/chart-alert`)
      .flush({
        data: null,
        status: false,
        message: 'Too many active alerts (500).',
        responseCode: '-11',
      });
    fixture.detectChanges();
    expect(q('[data-testid="caf-server-error"]').textContent).toContain(
      'Too many active alerts (500).',
    );
  });

  it('needs a channel and a channel the right way up', () => {
    render();
    const inApp = [...el.querySelectorAll<HTMLInputElement>('.caf-channels input')][0];
    inApp.checked = false;
    inApp.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(q('[data-testid="caf-problem"]').textContent).toContain(
      'Choose at least one way to be notified.',
    );
    inApp.checked = true;
    inApp.dispatchEvent(new Event('change'));
    const direction = q<HTMLSelectElement>('[data-testid="caf-direction"]');
    direction.value = 'enter';
    direction.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(q<HTMLInputElement>('[data-testid="caf-lower"]').valueAsNumber).toBe(1.08532);
    expect(q<HTMLInputElement>('[data-testid="caf-upper"]').valueAsNumber).toBe(1.08552);
    type('caf-upper', '1.08');
    expect(q('[data-testid="caf-problem"]').textContent).toContain(
      'The upper level must be above the lower level.',
    );
  });

  it('creates a drawing alert drafted from the drawing toolbar as a NEW alert with its geometry (DR-I6)', () => {
    const geometry = {
      shape: 'line' as const,
      points: [
        { timeMs: 1_760_000_000_000, price: 1.08 },
        { timeMs: 1_760_018_000_000, price: 1.09 },
      ],
      extendLeft: false,
      extendRight: true,
    };
    render({
      draft: dto({
        id: 0,
        name: 'Ray',
        kind: 'Drawing',
        side: 'Bid',
        condition: 'Crossing',
        price: null,
        geometry,
        drawingId: 'd1',
        drawingKind: 'ray',
        frequency: 'once',
        channels: ['InApp'],
        severity: 'Medium',
      }),
    });
    expect(el.textContent).toContain('Drawing alert · EURUSD');
    expect(el.textContent).toContain('On the ray');
    expect(q('[data-testid="caf-level"]')).toBeNull();
    q<HTMLFormElement>('form').dispatchEvent(new Event('submit'));
    const post = http.expectOne(`${BASE}/chart-alert`);
    expect(post.request.method).toBe('POST');
    expect(post.request.body).toMatchObject({
      kind: 'Drawing',
      condition: 'Crossing',
      price: null,
      upperPrice: null,
      geometry,
      drawingId: 'd1',
      drawingKind: 'ray',
      name: 'Ray',
    });
    post.flush(ok(dto({ id: 40, kind: 'Drawing', geometry })));
  });

  describe('UF04 derivatives alerts', () => {
    const settle = async () => {
      for (let i = 0; i < 3; i++) {
        await Promise.resolve();
        fixture.detectChanges();
      }
    };

    it('an FX symbol without derivatives data offers price alerts only', async () => {
      render();
      await settle();
      expect(q('[data-testid="caf-kind"]')).toBeNull();
    });

    it('offers only the kinds the symbol has data for, and sends the metric condition', async () => {
      render({ symbol: 'BTC-USDT-PERP', lastClose: 75_000, precision: 1 });
      await settle();
      const kind = q<HTMLSelectElement>('[data-testid="caf-kind"]');
      expect([...kind.options].map((o) => o.value)).toEqual(['Price', 'Funding', 'Liquidations']);
      kind.value = 'Liquidations';
      kind.dispatchEvent(new Event('change'));
      fixture.detectChanges();
      expect(q('[data-testid="caf-level"]')).toBeNull();
      expect(q<HTMLInputElement>('[data-testid="caf-metric-window"]').valueAsNumber).toBe(60);
      const freqs = [...q<HTMLSelectElement>('[data-testid="caf-frequency"]').options].map((o) => o.value);
      expect(freqs).not.toContain('once_per_bar_close');
      expect(q('[data-testid="caf-problem"]')?.textContent).toContain('Enter the liquidations value');
      type('caf-metric-value', '-5');
      expect(q('[data-testid="caf-problem"]')?.textContent).toContain('cannot be negative');
      type('caf-metric-value', '1000000');
      expect(q('[data-testid="caf-problem"]')).toBeNull();
      q<HTMLButtonElement>('[data-testid="caf-save"]').click();
      const post = http.expectOne(`${BASE}/chart-alert`);
      expect(post.request.body).toMatchObject({
        symbol: 'BTC-USDT-PERP',
        kind: 'Liquidations',
        price: null,
        condition: 'CrossingUp',
        metric: { comparator: 'crossesAbove', value: 1_000_000, windowMinutes: 60, sourceId: null },
      });
      post.flush(ok(dto({ id: 40, symbol: 'BTC-USDT-PERP', kind: 'Liquidations', price: null })));
    });

    it('funding shows the current value and takes no window', async () => {
      render({ symbol: 'BTC-USDT-PERP', lastClose: 75_000, precision: 1 });
      await settle();
      const kind = q<HTMLSelectElement>('[data-testid="caf-kind"]');
      kind.value = 'Funding';
      kind.dispatchEvent(new Event('change'));
      fixture.detectChanges();
      expect(q('[data-testid="caf-metric-window"]')).toBeNull();
      expect(q('[data-testid="caf-metric-now"]')?.textContent).toContain('0.0074 % per interval (OKX)');
      type('caf-metric-value', '0.01');
      q<HTMLButtonElement>('[data-testid="caf-save"]').click();
      const post = http.expectOne(`${BASE}/chart-alert`);
      expect(post.request.body.metric).toEqual({ comparator: 'crossesAbove', value: 0.01, windowMinutes: null, sourceId: null });
      post.flush(ok(dto({ id: 41, symbol: 'BTC-USDT-PERP', kind: 'Funding', price: null })));
    });
  });
});
