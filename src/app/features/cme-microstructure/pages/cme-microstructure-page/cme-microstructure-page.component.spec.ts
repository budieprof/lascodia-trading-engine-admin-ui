import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';

import { CmeMicrostructurePageComponent } from './cme-microstructure-page.component';
import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import { declareSignalIo } from '@shared/testing/jit-signal-io';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { RefreshButtonComponent } from '@shared/components/refresh-button/refresh-button.component';
import { CmeExperimentTradesComponent } from '@features/cme-microstructure/components/cme-experiment-trades.component';

// JIT (no CLI transform) sees signal inputs/outputs only once declared — the back-adjust spec renders the page.
declareSignalIo(PageHeaderComponent, { inputs: ['title', 'subtitle'] });
declareSignalIo(MetricCardComponent, { inputs: ['label', 'value', 'format'] });
declareSignalIo(ConfirmDialogComponent, {
  inputs: ['open', 'title', 'message', 'confirmLabel', 'confirmVariant', 'loading'],
  outputs: ['confirm', 'cancelled'],
});
declareSignalIo(RefreshButtonComponent, { inputs: ['refreshing'], outputs: ['refresh'] });
declareSignalIo(CmeExperimentTradesComponent, { inputs: ['runId'] });

const STATUS = {
  contractCount: 4,
  frontMonthContract: '6EU5',
  tradeCount: 1_000,
  bookSnapshotCount: 500,
  barCount: 60,
  latestBarUtc: null,
  shadowSignalCount: 0,
  contracts: [],
  recentShadowSignals: [],
  feedHealth: {
    status: 'NoData' as const,
    latestBarAgeSeconds: null,
    maxFlowStalenessSeconds: 120,
    tradesLast24h: 0,
    booksLast24h: 0,
    barsLast24h: 0,
    ingestEnabled: true,
    shadowMonitorEnabled: true,
  },
  warmTier: {
    configured: false,
    contracts: [],
    sessionCount: 0,
    earliestSession: null,
    latestSession: null,
  },
  v11Models: [],
};

describe('CmeMicrostructurePageComponent', () => {
  let cmp: CmeMicrostructurePageComponent;
  let fixture: ComponentFixture<CmeMicrostructurePageComponent>;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [CmeMicrostructurePageComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: RUNTIME_CONFIG, useValue: { apiBaseUrl: 'http://test' } },
      ],
    });
    fixture = TestBed.createComponent(CmeMicrostructurePageComponent);
    cmp = fixture.componentInstance;
  });

  describe('form defaults', () => {
    it('defaults the seed form to the 6E → EURUSD mapping', () => {
      expect(cmp['seedRoot']).toBe('6E');
      expect(cmp['seedSpot']).toBe('EURUSD');
    });

    it('uses yyyy-MM-dd dates so they bind to native date inputs', () => {
      expect(cmp['seedFrom']).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(cmp['expTo']).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('defaults to a multi-fold out-of-sample experiment', () => {
      expect(cmp['expFolds']).toBeGreaterThan(1);
    });
  });

  describe('dirColor', () => {
    it('greens a would-have buy and reds a would-have sell', () => {
      expect(cmp['dirColor']('Buy')).toBe('#34C759');
      expect(cmp['dirColor']('Sell')).toBe('#FF3B30');
    });
  });

  describe('feedStatusExplanation', () => {
    // The CmeDeepBookOrderflow strategy type was retired on 2026-09-30: the freshness gate now
    // only feeds the shadow monitor, so the copy must not promise a strategy path.
    it('says the shadow monitor, not a strategy, accepts or refuses the flow', () => {
      const explain = (status: 'Live' | 'Stale') =>
        cmp['feedStatusExplanation']({ status, maxFlowStalenessSeconds: 120 } as never);
      expect(explain('Live')).toContain('shadow monitor will accept');
      expect(explain('Stale')).toContain('shadow monitor is refusing');
      for (const s of ['Live', 'Stale'] as const) expect(explain(s)).not.toContain('strategy');
    });
  });

  describe('hasData', () => {
    it('is false until real tape has been ingested', () => {
      expect(cmp['hasData']()).toBe(false);
    });

    it('flips once trades exist', () => {
      cmp['status'].set(STATUS);
      expect(cmp['hasData']()).toBe(true);
    });
  });

  describe('back-adjust', () => {
    // A Command that overwrites the chain's stored roll offsets: it fired straight from one click.
    it('asks first, and sends only on confirm', () => {
      const http = TestBed.inject(HttpTestingController);
      const isBackAdjust = (r: { url: string }) => r.url.endsWith('/cme-contracts/back-adjust');
      cmp['status'].set(STATUS);
      fixture.detectChanges();
      const el = fixture.nativeElement as HTMLElement;
      const button = (label: string) =>
        [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)!;

      button('Back-adjust rolls').click();
      fixture.detectChanges();
      expect(http.match(isBackAdjust)).toHaveLength(0);
      expect(el.querySelector('[role="dialog"]')?.textContent).toContain('overwrites the stored');

      button('Back-adjust').click();
      fixture.detectChanges();
      expect(http.match(isBackAdjust)).toHaveLength(1);
      expect(el.querySelector('[role="dialog"]')).toBeNull();
    });
  });
});
