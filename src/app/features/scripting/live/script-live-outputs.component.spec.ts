import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChangeDetectionStrategy, Component, Input } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';

import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import { PineChartComponent } from '@shared/pine-chart/components/pine-chart.component';
import type { PineChartData } from '@shared/pine-chart/model/chart-data';
import { declareSignalIo } from '@shared/testing/jit-signal-io';
import { ScriptLiveOutputsComponent } from './script-live-outputs.component';

@Component({
  selector: 'app-pine-chart',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.Eager,
  template: '',
})
class PineChartStubComponent {
  @Input() result: PineChartData | null = null;
  @Input() symbol = '';
  @Input() timeframe = '';
  @Input() showTrades = true;
  @Input() emptyText = '';
}

declareSignalIo(ScriptLiveOutputsComponent, { inputs: ['strategyId'] });

const URL = 'http://test/api/v1/lascodia-trading-engine/strategy/41/script/live/outputs';
const ok = <T>(data: T) => ({ data, status: true, message: 'Successful', responseCode: '00' });
const settle = () => new Promise((r) => setTimeout(r, 0));
const answer = (over: Record<string, unknown> = {}) => ({
  source: 'session',
  symbol: 'EURUSD',
  timeframe: '60',
  barIndex: 1,
  fromBar: 0,
  firstAvailableBar: 0,
  lastBarForming: false,
  bars: [
    { t: Date.UTC(2026, 10, 1, 0), o: 1, h: 2, l: 0.5, c: 1.5, v: 10 },
    { t: Date.UTC(2026, 10, 1, 1), o: 1.5, h: 2, l: 1, c: 1.8, v: 12 },
  ],
  outputs: null,
  ...over,
});

describe('ScriptLiveOutputsComponent (§8a live outputs, K2 members)', () => {
  let fixture: ComponentFixture<ScriptLiveOutputsComponent>;
  let http: HttpTestingController;
  let el: HTMLElement;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [ScriptLiveOutputsComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: RUNTIME_CONFIG, useValue: { apiBaseUrl: 'http://test' } },
      ],
    });
    TestBed.overrideComponent(ScriptLiveOutputsComponent, {
      remove: { imports: [PineChartComponent] },
      add: { imports: [PineChartStubComponent] },
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(ScriptLiveOutputsComponent);
    fixture.componentRef.setInput('strategyId', 41);
    fixture.detectChanges();
    el = fixture.nativeElement as HTMLElement;
  });
  afterEach(() => http.verify());

  const click = async () => {
    (el.querySelector('button') as HTMLButtonElement).click();
    fixture.detectChanges();
  };
  const chart = () =>
    fixture.debugElement.query((d) => d.componentInstance instanceof PineChartStubComponent)
      ?.componentInstance as PineChartStubComponent | undefined;

  it('fetches nothing until asked, then draws a single-symbol session with no member selector', async () => {
    expect(el.textContent).toContain('Show live outputs');
    await click();
    http.expectOne(URL).flush(ok(answer()));
    await settle();
    fixture.detectChanges();
    expect(chart()!.result!.bars).toHaveLength(2);
    expect(el.querySelector('[data-testid="live-outputs-member"]')).toBeNull();
    expect(el.querySelector('[data-testid="live-outputs-caption"]')!.textContent).toContain(
      'running session',
    );
  });

  it('a portfolio answer shows the members and asks for the first, then the picked one', async () => {
    await click();
    http
      .expectOne(URL)
      .flush(ok(answer({ bars: [], outputs: null, portfolioMembers: ['EURUSD', 'GBPUSD'] })));
    await settle();
    http
      .expectOne(`${URL}?member=EURUSD`)
      .flush(ok(answer({ portfolioMembers: ['EURUSD', 'GBPUSD'] })));
    await settle();
    fixture.detectChanges();
    const select = el.querySelector('[data-testid="live-outputs-member"]') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['EURUSD', 'GBPUSD']);
    expect(el.querySelector('[data-testid="live-outputs-caption"]')!.textContent).toContain(
      'EURUSD ·',
    );

    select.value = 'GBPUSD';
    select.dispatchEvent(new Event('change'));
    http
      .expectOne(`${URL}?member=GBPUSD`)
      .flush(ok(answer({ symbol: 'GBPUSD', portfolioMembers: ['EURUSD', 'GBPUSD'] })));
    await settle();
    fixture.detectChanges();
    expect(fixture.componentInstance.member()).toBe('GBPUSD');
    expect(chart()!.symbol).toBe('GBPUSD');
  });

  it('shows the engine note when there is nothing, and the refusal message', async () => {
    await click();
    http
      .expectOne(URL)
      .flush(ok(answer({ source: 'none', bars: [], barIndex: -1, note: 'No live session' })));
    await settle();
    fixture.detectChanges();
    expect(el.textContent).toContain('No live session');
    expect(chart()).toBeUndefined();

    await click();
    http
      .expectOne(URL)
      .flush({ data: null, status: false, message: 'Busy, retry', responseCode: '-429' });
    await settle();
    fixture.detectChanges();
    expect(el.textContent).toContain('Busy, retry');
  });
});
