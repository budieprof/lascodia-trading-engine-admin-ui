import { HttpErrorResponse } from '@angular/common/http';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NotificationService } from '@core/notifications/notification.service';
import { AccountScopeService } from '@core/scope/account-scope.service';
import { ensureTestBed } from '@core/testing/zoneless-test-bed';
import { OrganisationApiService } from './organisation-api.service';
import type { StrategySubscriptions } from './organisation.types';
import { SubscriptionsPageComponent } from './pages/subscriptions-page.component';

ensureTestBed();

const subs: StrategySubscriptions = {
  requireSubscription: false,
  subscriptions: [
    {
      strategyId: 501,
      strategyName: 'Mean reversion',
      symbol: 'EURUSD',
      timeframe: 'H1',
      strategyStatus: 'Active',
      isPlatform: true,
      isScript: false,
      tradingAccountId: 7,
      accountName: 'Seven',
      accountLogin: '1007',
      lotMultiplier: 1,
      isEnabled: true,
      createdAt: '',
    },
  ],
};

function apiStub() {
  return {
    strategySubscriptions: vi.fn(() => of(subs)),
    strategies: vi.fn(() =>
      of({
        pager: { totalItemCount: 60, currentPage: 1, itemCountPerPage: 25 } as never,
        data: [
          {
            id: 501,
            tenantId: null,
            name: 'Mean reversion',
            symbol: 'EURUSD',
            timeframe: 'H1',
            status: 'Active',
          },
        ],
      }),
    ),
    strategyBindings: vi.fn(() =>
      of([{ tradingAccountId: 7, accountName: 'Seven', lotMultiplier: 1, isEnabled: true }]),
    ),
    replaceStrategyBindings: vi.fn(() => of(true)),
  };
}

let api: ReturnType<typeof apiStub>;
let notify: { error: ReturnType<typeof vi.fn>; success: ReturnType<typeof vi.fn> };

beforeEach(() => {
  api = apiStub();
  notify = { error: vi.fn(), success: vi.fn() };
  TestBed.configureTestingModule({
    providers: [
      { provide: OrganisationApiService, useValue: api },
      { provide: NotificationService, useValue: notify },
      {
        provide: AccountScopeService,
        useValue: {
          accounts: signal([
            {
              id: 7,
              accountId: '1007',
              accountName: 'Seven',
              brokerServer: 'S',
              accountType: 'Demo',
              isPaper: false,
            },
            {
              id: 8,
              accountId: '1008',
              accountName: 'Eight',
              brokerServer: 'S',
              accountType: 'Real',
              isPaper: false,
            },
          ]),
        },
      },
    ],
  });
});

afterEach(() => TestBed.resetTestingModule());

const page = () => TestBed.runInInjectionContext(() => new SubscriptionsPageComponent());

describe('SubscriptionsPageComponent', () => {
  it('loads the subscriptions and both strategy lists (active first, nested filter by ownership)', () => {
    const p = page();
    expect(api.strategySubscriptions).toHaveBeenCalledTimes(1);
    expect(api.strategies).toHaveBeenCalledWith({
      ownership: 'Platform',
      search: '',
      status: 'Active',
      page: 1,
      pageSize: 25,
    });
    expect(api.strategies).toHaveBeenCalledWith(expect.objectContaining({ ownership: 'Private' }));
    expect(p.grouped().map((g) => g.name)).toEqual(['Mean reversion']);
    expect(p.subscribedCount(501)).toBe(1);
    expect(p.platformList.pages()).toBe(3);
  });

  it('pages and searches a list', () => {
    const p = page();
    p.platformList.go(2);
    expect(api.strategies).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 }));
    p.platformList.search.set('euro');
    p.platformList.query();
    expect(api.strategies).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 1, search: 'euro', ownership: 'Platform' }),
    );
  });

  it('says plainly when the engine has no subscriptions yet', () => {
    api.strategySubscriptions.mockReturnValueOnce(
      throwError(() => new HttpErrorResponse({ status: 404, error: null })),
    );
    const p = page();
    expect(p.unavailable()).toBe(true);
  });

  it('subscribes a real-money account only after that is confirmed', () => {
    const p = page();
    p.openEditor({
      id: 501,
      name: 'Mean reversion',
      symbol: 'EURUSD',
      isScript: false,
      isPlatform: true,
    });
    expect(api.strategyBindings).toHaveBeenCalledWith(501);
    expect(p.drafts().map((d) => [d.account.id, d.subscribed])).toEqual([
      [7, true],
      [8, false],
    ]);
    p.patchDraft(1, { subscribed: true, lotMultiplier: '0.5' });
    p.save();
    expect(api.replaceStrategyBindings).not.toHaveBeenCalled();
    expect(p.problems()).toContain('Confirm the change to the real-money account(s) first.');

    p.confirmReal.set(true);
    p.save();
    expect(api.replaceStrategyBindings).toHaveBeenCalledWith(501, [
      { tradingAccountId: 7, lotMultiplier: 1, isEnabled: true },
      { tradingAccountId: 8, lotMultiplier: 0.5, isEnabled: true },
    ]);
    expect(p.editing()).toBeNull();
    expect(api.strategySubscriptions).toHaveBeenCalledTimes(2);
  });

  it('warns that House’s fan-out goes back to every account when the last subscription goes', () => {
    const p = page();
    p.openEditor({
      id: 501,
      name: 'Mean reversion',
      symbol: 'EURUSD',
      isScript: false,
      isPlatform: true,
    });
    p.patchDraft(0, { subscribed: false });
    expect(p.warning()).toContain('every account of the organisation');
  });

  it('keeps the editor open with the engine’s words when a save is refused', () => {
    api.replaceStrategyBindings.mockReturnValueOnce(
      throwError(
        () =>
          new HttpErrorResponse({
            status: 400,
            error: {
              status: false,
              message: 'Trading account(s) not found: 8',
              responseCode: '-11',
            },
          }),
      ),
    );
    const p = page();
    p.openEditor({
      id: 501,
      name: 'Mean reversion',
      symbol: 'EURUSD',
      isScript: false,
      isPlatform: true,
    });
    p.patchDraft(0, { lotMultiplier: '2' });
    p.save();
    expect(p.saveError()).toBe('Trading account(s) not found: 8');
    expect(p.editing()).not.toBeNull();
  });
});
