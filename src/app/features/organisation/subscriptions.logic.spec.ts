import { describe, expect, it } from 'vitest';

import type { AccountRef, StrategyBinding, StrategySubscription } from './organisation.types';
import {
  changeSummary,
  draftErrors,
  draftFrom,
  draftToInputs,
  groupSubscriptions,
  reachWarning,
  subscriptionRule,
} from './subscriptions.logic';

const acct = (id: number, over: Partial<AccountRef> = {}): AccountRef => ({
  id,
  login: String(1000 + id),
  name: `Acct ${id}`,
  brokerServer: 'S',
  accountType: 'Demo',
  isPaper: false,
  ...over,
});

const sub = (
  strategyId: number,
  accountId: number,
  over: Partial<StrategySubscription> = {},
): StrategySubscription => ({
  strategyId,
  strategyName: `S${strategyId}`,
  symbol: 'EURUSD',
  timeframe: 'H1',
  strategyStatus: 'Active',
  isPlatform: true,
  isScript: false,
  tradingAccountId: accountId,
  accountName: `Acct ${accountId}`,
  accountLogin: String(1000 + accountId),
  lotMultiplier: 1,
  isEnabled: true,
  createdAt: '',
  ...over,
});

const binding = (accountId: number, over: Partial<StrategyBinding> = {}): StrategyBinding => ({
  tradingAccountId: accountId,
  accountName: `Acct ${accountId}`,
  lotMultiplier: 1,
  isEnabled: true,
  ...over,
});

describe('subscriptions overview', () => {
  it('groups by strategy, keeping the engine’s order', () => {
    const g = groupSubscriptions([sub(5, 1), sub(5, 2, { isEnabled: false }), sub(3, 1)]);
    expect(g.map((x) => [x.strategyId, x.accounts.length])).toEqual([
      [5, 2],
      [3, 1],
    ]);
  });

  it('states the rule the organisation’s accounts receive signals under', () => {
    expect(subscriptionRule(true)).toContain('only when it is subscribed');
    expect(subscriptionRule(false)).toContain('reaches every account');
  });
});

describe('subscription editor', () => {
  const accounts = [
    acct(1),
    acct(2, { accountType: 'Real' }),
    acct(3, { accountType: 'Real', isPaper: true }),
  ];

  it('lists every account with its current subscription, and keeps one it cannot list', () => {
    const d = draftFrom(accounts, [
      binding(2, { lotMultiplier: 0.5, isEnabled: false }),
      binding(9),
    ]);
    expect(d.map((r) => [r.account.id, r.subscribed, r.lotMultiplier, r.isEnabled])).toEqual([
      [1, false, '1', true],
      [2, true, '0.5', false],
      [3, false, '1', true],
      [9, true, '1', true],
    ]);
  });

  it('checks multipliers of subscribed rows only', () => {
    const d = draftFrom(accounts, []);
    d[0] = { ...d[0], subscribed: true, lotMultiplier: '0' };
    d[1] = { ...d[1], subscribed: false, lotMultiplier: 'x' };
    d[2] = { ...d[2], subscribed: true, lotMultiplier: '10' };
    expect(draftErrors(d)).toHaveLength(1);
    expect(draftErrors([{ ...d[0], lotMultiplier: '10.5' }])).toHaveLength(1);
    expect(draftErrors([{ ...d[0], lotMultiplier: '2.5' }])).toEqual([]);
  });

  it('sends the complete new set', () => {
    const d = draftFrom(accounts, [binding(1)]);
    d[1] = { ...d[1], subscribed: true, lotMultiplier: ' 0.25 ', isEnabled: false };
    expect(draftToInputs(d)).toEqual([
      { tradingAccountId: 1, lotMultiplier: 1, isEnabled: true },
      { tradingAccountId: 2, lotMultiplier: 0.25, isEnabled: false },
    ]);
  });

  it('summarises the change and flags real-money accounts (not paper ones)', () => {
    const current = [binding(1), binding(3)];
    const d = draftFrom(accounts, current);
    d[0] = { ...d[0], lotMultiplier: '2' }; // changed
    d[1] = { ...d[1], subscribed: true }; // added, Real
    d[2] = { ...d[2], subscribed: false }; // removed, paper
    const c = changeSummary(current, d);
    expect(c.added.map((a) => a.id)).toEqual([2]);
    expect(c.removed.map((a) => a.id)).toEqual([3]);
    expect(c.changed.map((a) => a.id)).toEqual([1]);
    expect(c.realAccounts.map((a) => a.id)).toEqual([2]);
    expect(c.none).toBe(false);
    expect(changeSummary(current, draftFrom(accounts, current)).none).toBe(true);
  });

  it('warns when House’s open fan-out appears or disappears, or nobody receives the strategy', () => {
    const s = { isScript: false, symbol: 'EURUSD' };
    expect(reachWarning(false, s, 0, 1)).toContain('only the subscribed accounts');
    expect(reachWarning(false, s, 2, 0)).toContain('every account of the organisation');
    expect(reachWarning(false, s, 1, 2)).toBeNull();
    expect(reachWarning(true, s, 1, 0)).toContain('No account');
    expect(reachWarning(true, s, 0, 1)).toBeNull();
    expect(reachWarning(false, { isScript: true, symbol: 'X' }, 1, 0)).toContain('script strategy');
  });
});
