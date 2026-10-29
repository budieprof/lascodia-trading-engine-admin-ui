import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthService } from '@core/auth/auth.service';
import { NotificationService } from '@core/notifications/notification.service';
import { ensureTestBed } from '@core/testing/zoneless-test-bed';
import { DealingAbReportTabComponent } from './components/ab-report-tab.component';
import { DealingClientsTabComponent } from './components/clients-tab.component';
import { DealingFeedsTabComponent } from './components/feeds-tab.component';
import { DealingApiService } from './dealing-api.service';
import { DealingFiltersStore } from './dealing-filters.store';
import type { DealingFeed } from './dealing.types';

ensureTestBed();

const notInPlan = () =>
  new HttpErrorResponse({
    status: 403,
    error: {
      responseCode: '-403-quota',
      message: 'm',
      data: { quota: 'feature', feature: 'brokerModule', limit: 0, used: 0, plan: 'Trial' },
    },
  });

const feed = (over: Partial<DealingFeed> = {}): DealingFeed => ({
  feedId: 'live-1',
  displayName: 'Live 1',
  serverName: 'Broker-Live01',
  writerInstanceIds: ['gw-1'],
  priceSourceId: null,
  enabled: true,
  createdAtUtc: '2026-10-24T00:00:00Z',
  updatedAtUtc: null,
  lastIngestAtUtc: null,
  trades: 3,
  openTrades: 1,
  ...over,
});

let api: Record<string, ReturnType<typeof vi.fn>>;
let notify: { error: ReturnType<typeof vi.fn>; success: ReturnType<typeof vi.fn> };
let store: DealingFiltersStore;

beforeEach(() => {
  api = {
    clients: vi.fn(() =>
      of({
        rows: [],
        totalClients: 0,
        fillsRead: 0,
        truncated: false,
        parameters: { minFills: 30, aBookThreshold: 60, shortHoldSeconds: 60 },
        methodology: '',
        disclaimer: 'Advisory only',
      }),
    ),
    abBookReport: vi.fn(() => throwError(() => notInPlan())),
    feeds: vi.fn(() => of([feed()])),
    setting: vi.fn(() => of(null)),
    createFeed: vi.fn(() => of(feed({ feedId: 'live-2' }))),
    updateFeed: vi.fn(() => of(feed({ enabled: false }))),
  };
  notify = { error: vi.fn(), success: vi.fn() };
  TestBed.configureTestingModule({
    providers: [
      DealingFiltersStore,
      { provide: DealingApiService, useValue: api },
      { provide: NotificationService, useValue: notify },
      {
        provide: AuthService,
        useValue: {
          hasPermission: () => true,
          permissions: () => new Set(['dealing.read', 'dealing.manage']),
        },
      },
    ],
  });
  store = TestBed.inject(DealingFiltersStore);
});

afterEach(() => TestBed.resetTestingModule());

describe('dealing desk', () => {
  it('reads clients for the shared window and filters', () => {
    store.feedId.set('own');
    store.minFills.set(5);
    const tab = TestBed.runInInjectionContext(() => new DealingClientsTabComponent());
    tab.load();
    const [w, extra] = api['clients'].mock.calls.at(-1)!;
    expect(w).toMatchObject({ feedId: 'own', minFills: 5 });
    expect(extra).toMatchObject({ sortBy: 'toxicity', limit: 500 });
    expect(tab.data()?.disclaimer).toBe('Advisory only');
  });

  it('turns the plan refusal into the upgrade notice, not an error', () => {
    const tab = TestBed.runInInjectionContext(() => new DealingAbReportTabComponent());
    tab.load();
    expect(store.moduleMissing()).toBe(true);
    expect(tab.error()).toBeNull();
  });

  it('registers a feed with clean writer ids and refuses a bad form', () => {
    const tab = TestBed.runInInjectionContext(() => new DealingFeedsTabComponent());
    expect(tab.feeds()).toHaveLength(1);
    tab.startCreate();
    tab.save();
    expect(api['createFeed']).not.toHaveBeenCalled();
    tab.patch({ feedId: 'live-2', displayName: 'Live 2', writersText: 'gw-9\ngw-9, gw-10' });
    tab.save();
    expect(api['createFeed']).toHaveBeenCalledWith({
      feedId: 'live-2',
      displayName: 'Live 2',
      serverName: '',
      writerInstanceIds: ['gw-9', 'gw-10'],
      priceSourceId: '',
      enabled: true,
    });
    expect(notify.success).toHaveBeenCalled();
    expect(tab.form()).toBeNull();
  });

  it('edits an existing feed through PUT', () => {
    const tab = TestBed.runInInjectionContext(() => new DealingFeedsTabComponent());
    tab.startEdit(feed());
    tab.patch({ enabled: false });
    tab.save();
    expect(api['updateFeed']).toHaveBeenCalledWith(
      expect.objectContaining({ feedId: 'live-1', enabled: false, writerInstanceIds: ['gw-1'] }),
    );
  });
});
