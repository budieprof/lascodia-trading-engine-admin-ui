import { afterEach, describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';

import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import { declareSignalIo } from '@shared/testing/jit-signal-io';
import { ConfigHashBadgeComponent } from '../components/config-hash-badge/config-hash-badge.component';
import { WfStitchedCardComponent } from './wf-stitched-card.component';

declareSignalIo(WfStitchedCardComponent, { inputs: ['strategyId', 'currentHash'] });
declareSignalIo(ConfigHashBadgeComponent, { inputs: ['hash', 'currentHash'] });

const BASE = 'http://test/api/v1/lascodia-trading-engine';
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('WfStitchedCardComponent (U12 / C10)', () => {
  let http: HttpTestingController;
  afterEach(() => http.verify());

  async function render(runs: unknown[]) {
    TestBed.configureTestingModule({
      imports: [WfStitchedCardComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: RUNTIME_CONFIG, useValue: { apiBaseUrl: 'http://test' } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(WfStitchedCardComponent);
    fixture.componentRef.setInput('strategyId', 9);
    fixture.componentRef.setInput('currentHash', 'b'.repeat(64));
    fixture.detectChanges();
    http
      .expectOne(`${BASE}/walk-forward/list`)
      .flush({
        data: { pager: {}, data: runs },
        status: true,
        message: 'Successful',
        responseCode: '00',
      });
    await settle();
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  it('reads the newest COMPLETED run’s stitched metrics and its version', async () => {
    const el = await render([
      { id: 80, status: 'Running' },
      {
        id: 77,
        status: 'Completed',
        strategyConfigHash: 'a'.repeat(64),
        oosExpectancyR: 0.11,
        oosSharpeR: 0.1,
        oosRTrades: 64,
        oosTrades: 70,
        foldCount: 9,
        zeroTradeFolds: 0,
        walkForwardEfficiency: 0.5,
      },
    ]);
    expect(el.textContent).toContain('run #77');
    expect(el.textContent).toContain('+0.110 R');
    expect(el.querySelector('[data-testid="config-hash"]')!.textContent).toContain('older version');
  });

  it('says a pre-C10 run has no stitched metrics instead of deriving them', async () => {
    const el = await render([{ id: 70, status: 'Completed' }]);
    expect(el.textContent).toContain('predates the stitched metrics');
  });
});
