import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';

import { CmeMicrostructurePageComponent } from './cme-microstructure-page.component';
import { RUNTIME_CONFIG } from '@core/config/runtime-config';

describe('CmeMicrostructurePageComponent', () => {
  let cmp: CmeMicrostructurePageComponent;

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
    const fixture = TestBed.createComponent(CmeMicrostructurePageComponent);
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

  describe('hasData', () => {
    it('is false until real tape has been ingested', () => {
      expect(cmp['hasData']()).toBe(false);
    });

    it('flips once trades exist', () => {
      cmp['status'].set({
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
          status: 'NoData',
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
      });
      expect(cmp['hasData']()).toBe(true);
    });
  });
});
