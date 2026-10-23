import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import { ApiService } from '@core/api/api.service';
import { ensureTestBed } from '@core/testing/zoneless-test-bed';
import {
  MarketDataEntitlementsService,
  entitledIn,
  type MyMarketDataEntitlements,
} from './md-entitlements.service';

ensureTestBed();

const customer: MyMarketDataEntitlements = {
  tenantId: 7001,
  allFeeds: false,
  planFeeds: null,
  degraded: false,
  feeds: [
    {
      feedId: 'broker-ticks',
      name: 'Broker quotes',
      display: true,
      nonDisplay: true,
      validTo: null,
      source: 'default',
    },
    {
      feedId: 'cme-l2',
      name: 'CME depth',
      display: false,
      nonDisplay: true,
      validTo: '2027-01-01T00:00:00Z',
      source: 'grant',
    },
  ],
};

describe('market-data entitlements (me)', () => {
  it('answers per feed and usage once loaded, unknown before', () => {
    expect(entitledIn(null, 'broker-ticks')).toBeNull();
    expect(entitledIn(customer, 'broker-ticks')).toBe(true);
    expect(entitledIn(customer, 'cme-l2')).toBe(false);
    expect(entitledIn(customer, 'cme-l2', 'nonDisplay')).toBe(true);
    expect(entitledIn(customer, 'cme-trades')).toBe(false);
    expect(entitledIn({ ...customer, allFeeds: true, feeds: [] }, 'venue:new')).toBe(true);
  });

  it('loads once, re-uses a fresh answer and keeps the last one when the engine fails', async () => {
    const getEnvelope = vi.fn().mockReturnValue(of(customer));
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: ApiService, useValue: { getEnvelope } }],
    });
    const service = TestBed.inject(MarketDataEntitlementsService);

    expect(service.isEntitled('broker-ticks')).toBeNull();
    await service.load();
    await service.load();
    expect(getEnvelope).toHaveBeenCalledTimes(1);
    expect(getEnvelope).toHaveBeenCalledWith('/md/entitlements/me', { silent: true });
    expect(service.isEntitled('broker-ticks')).toBe(true);
    expect([...service.displayFeeds()]).toEqual(['broker-ticks']);

    getEnvelope.mockReturnValue(throwError(() => new Error('down')));
    await service.refresh();
    expect(getEnvelope).toHaveBeenCalledTimes(2);
    expect(service.isEntitled('broker-ticks')).toBe(true);
  });
});
