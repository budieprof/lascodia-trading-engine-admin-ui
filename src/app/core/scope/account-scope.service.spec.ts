import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Injector, runInInjectionContext } from '@angular/core';
import { of } from 'rxjs';
import { AccountScopeService } from './account-scope.service';
import { TradingAccountsService } from '@core/services/trading-accounts.service';
import { EAInstancesService } from '@core/services/ea-instances.service';
import type { EAInstanceDto, TradingAccountDto } from '@core/api/api.types';

/**
 * These cover the resolution layer that decides which accounts every
 * account-tagged metric in the console rolls up.  The bug they exist to
 * prevent: the header pill advertised "All real (6 · aggregated)" while
 * the dashboard was scoped to a single account, so the operator read
 * one account's equity and P&L as if it were the whole fleet's.
 */

const AGG_REAL = AccountScopeService.SCOPE_AGGREGATE_REAL;
const AGG_ALL = AccountScopeService.SCOPE_AGGREGATE_ALL;

function account(id: number, isPaper = false): TradingAccountDto {
  return { id, isPaper, equity: id * 100 } as TradingAccountDto;
}

function eaInstance(tradingAccountId: number, status = 'Active'): EAInstanceDto {
  return { tradingAccountId, status } as unknown as EAInstanceDto;
}

/** Build the service with stubbed transports and no live polling. */
function makeService(): AccountScopeService {
  const injector = Injector.create({
    providers: [
      { provide: TradingAccountsService, useValue: { list: () => of({ data: { data: [] } }) } },
      { provide: EAInstancesService, useValue: { list: () => of({ data: [] }) } },
    ],
  });
  return runInInjectionContext(injector, () => new AccountScopeService());
}

describe('AccountScopeService', () => {
  let svc: AccountScopeService;

  beforeEach(() => {
    // The constructor opens a 30s refresh timer; fake timers keep it from
    // firing (and from holding the runner open) without touching the code.
    vi.useFakeTimers();
    localStorage.clear();
    svc = makeService();
    vi.useRealTimers();

    // Six live real accounts, one dormant (no EA), one live paper account.
    svc.accounts.set([
      account(17),
      account(22),
      account(23),
      account(5), // dormant: IsActive is sticky but no EA is attached
      account(99, true), // paper
    ]);
    svc.eaInstances.set([
      eaInstance(17),
      eaInstance(22),
      eaInstance(23),
      eaInstance(99),
      eaInstance(5, 'Stopped'),
    ]);
  });

  it('treats an account as live only when an Active EA is attached', () => {
    expect(svc.liveAccounts().map((a) => a.id)).toEqual([17, 22, 23, 99]);
    expect(svc.liveRealAccounts().map((a) => a.id)).toEqual([17, 22, 23]);
  });

  it('expands the real-aggregate scope to every live real account', () => {
    svc.select(AGG_REAL);
    expect(Array.from(svc.accountIds()).sort()).toEqual([17, 22, 23]);
    expect(svc.isAggregateReal()).toBe(true);
  });

  it('includes paper accounts under the all-live aggregate', () => {
    svc.select(AGG_ALL);
    expect(Array.from(svc.accountIds()).sort()).toEqual([17, 22, 23, 99]);
    expect(svc.isAggregateReal()).toBe(false);
  });

  it('narrows to a singleton when a specific account is selected', () => {
    svc.select(22);
    expect(Array.from(svc.accountIds())).toEqual([22]);
    expect(svc.effectiveSelected()).toBe('22');
  });

  it('reports the aggregate fallback when the persisted id is no longer live', () => {
    // Account 5 is dormant — accountIds() already fell back to the
    // real-aggregate here. effectiveSelected has to agree, or the header
    // pill advertises a scope the data is not using.
    svc.select(5);
    expect(Array.from(svc.accountIds()).sort()).toEqual([17, 22, 23]);
    expect(svc.effectiveSelected()).toBe(AGG_REAL);
  });

  it('keeps effectiveSelected in lockstep with accountIds for every scope', () => {
    for (const [selection, expected] of [
      [AGG_REAL, AGG_REAL],
      [AGG_ALL, AGG_ALL],
      [23, '23'],
      [4242, AGG_REAL], // never existed
    ] as const) {
      svc.select(selection);
      expect(svc.effectiveSelected()).toBe(expected);
    }
  });

  it('holds accountIdsKey stable when a refresh returns the same set', () => {
    // The dashboard refetches on accountIdsKey changing. accountIds() is a
    // fresh array on every refresh, so an effect depending on it would
    // refetch on each 30s tick — and each refetch rewrites `accounts`,
    // closing the loop. The key must only move when the set does.
    svc.select(AGG_REAL);
    const before = svc.accountIdsKey();

    svc.accounts.set([account(17), account(22), account(23), account(5), account(99, true)]);
    expect(svc.accountIdsKey()).toBe(before);

    // Order of the incoming list must not perturb it either.
    svc.accounts.set([account(23), account(99, true), account(17), account(5), account(22)]);
    expect(svc.accountIdsKey()).toBe(before);

    // A genuine membership change does move it.
    svc.eaInstances.set([eaInstance(17), eaInstance(22)]);
    expect(svc.accountIdsKey()).not.toBe(before);
  });

  it('decorates a filter with the full scoped id set, not just one account', () => {
    svc.select(AGG_REAL);
    const decorated = svc.decorateFilter({ status: 'Open' });
    expect(decorated.status).toBe('Open');
    expect(decorated.tradingAccountIds?.slice().sort()).toEqual([17, 22, 23]);
  });

  it('persists the selection and restores it on the next instance', () => {
    svc.select(22);
    const revived = makeService();
    expect(revived.selected()).toBe(22);
  });
});
